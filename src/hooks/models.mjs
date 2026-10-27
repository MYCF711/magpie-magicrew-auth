// ⑦ provider.models(provider, { auth }) —— 每账号的模型目录
//
// ⚠ 返回的是**这个账号真正能选**的模型，不是厂商标称的全部：
//   混进 VIP 锁定 / 生图 / embedding，用户选中就报错。
//
// 失败回退三种选一种：原样返回 provider.models / 抛异常 /
// 返回自己的列表并标 Symbol.for("magpie.fellBack")。
// ⚠ 局部成功时别标 fellBack —— magpie 会整份丢弃。
//
// 登录态失效 → 抛带 signIn: "expired" 的错误。

import { fetchModels, fetchModelPoints } from "../api.mjs"
import { modelEntry } from "../context.mjs"
import { readSnapshot, writeSnapshot } from "../store.mjs"

// 倍率系数：input_points / 2000 与网站实测值吻合
//   Qwen3.5 Flash  20   → 0.01  (网站 0.01) ✓
//   Qwen3.8 Flash  100  → 0.05  (网站 0.05) ✓
//   Qwen3.7 Plus   200  → 0.10  (网站 0.10) ✓
//   Qwen3.8 Max   1200  → 0.60  (网站 0.56)
const MULT_BASE = 2000

export function makeModels(c) {
  return async (provider, { auth } = {}) => {
    const snapshot = readSnapshot(c.id)
    if (!auth) return snapshot ?? {}

    try {
      const live = await fetchModels(auth.jwt, auth.org, c.host)
      if (!live.length) return snapshot ?? {}

      // 计费信息拿不到就退回原名，不挡列表
      const points = await fetchModelPoints(auth.jwt, auth.org, live.map((m) => m.id), c.host).catch(() => ({}))
      const pointsOk = Object.keys(points).length > 0

      const out = {}
      for (const m of live) {
        // VIP / 锁定的模型不列 —— 选中会报错，插件注释里那条铁律
        // （语言模型这批实测 tags 全是 `Magic`，没有 VIP；VIP 只出现在
        //  网站的「生图模型 / 视频模型」里，那两个接口不在本插件范围内）
        const locked = (m.tags || []).some((t) => /vip|lock|pay|premium/i.test(String(t?.value ?? "")))
        if (locked) continue

        const p = points[m.id] || {}
        // 三分支 —— 按 HOOKS.md 十一之二：`free` 的判据是「花不花这份订阅的
        // 额度」，**不能从 rate 反推**（实测 rate===0 的 51 条里，38 条是
        // 「套餐内不按次计费」，照样吃配额；标成免费会让 Free first 一直派到它们身上）。
        //
        //   input_points > 0   → 有倍率，free 不设
        //   input_points === 0 → 厂商声明免费 → free: true，且不给 rate
        //   input_points 缺失  → 价格未知 → 不列（不猜，也不谎标免费）
        //
        // 「已知」要挡住空串与非数字：`Number("") === 0` 会把没填的价格当成免费。
        const raw = p.inputPoints
        const known = raw != null && String(raw).trim() !== "" && Number.isFinite(Number(raw))
        const isFree = known && Number(raw) === 0
        // 计费接口整体成功、但这条没价格 → 不列。
        // 不填 rate 就不会画倍率胶囊（正确），但也别让它出现在列表里 ——
        // 用户选了不知道花多少。接口整体失败时不过滤，免得列表空掉。
        if (pointsOk && !known) continue

        // name 保持干净，倍率走 magpie 自己的 `rate` 字段 → 渲染成灰色胶囊，
        // 免费走 `free` → 进 Free first 那一档（codearts 的 modelOf 认的就是这两个）。
        out[m.id] = modelEntry(c, m.id, m.name, m.vision, {
          rate: known ? Number(raw) / MULT_BASE : 0,
          free: isFree,
        })
      }
      writeSnapshot(c.id, out)
      return out
    } catch (e) {
      if (/401|403|unauthorized|expired|用户不存在|登录失败/i.test(String(e?.message ?? e))) {
        throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
      }
      // 网络抖动：退回上次的快照，别让整个供应商从列表里消失
      return snapshot ?? {}
    }
  }
}

