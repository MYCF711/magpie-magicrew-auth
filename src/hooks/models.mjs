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
        // `free` 的判据（HOOKS.md 十一之二）：**花不花这份订阅的额度**，
        // 不能从 rate 反推。
        //   input_points > 0  → 有倍率 rate，free=false
        //   input_points === 0 → 厂商声明免费，free=true，且不给 rate
        //   input_points 缺失  → 价格未知，不列（别让人选到算不清的东西）
        const known = p.inputPoints != null
        const isFree = known && Number(p.inputPoints) === 0
        if (pointsOk && !known) continue

        out[m.id] = modelEntry(c, m.id, m.name, m.vision, {
          rate: known && !isFree ? Number(p.inputPoints) / MULT_BASE : 0,
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

