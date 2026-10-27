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

// ⚠ 实测（2026-10-27）：宿主**不渲染 cost 字段**。
//   填 cost.input=0.01 之后，模型列表里连数字都不显示了 —— 说明它既不用它做
//   徽章，也不会退化成文本。所以倍率只能拼进 name，至少能看见。
//   （宿主那个胶囊（0.09× / 免费）是它自己从别处来的，插件侧喂不进去。）
function withMultiplier(name, inputPoints) {
  const n = Number(inputPoints)
  if (!n || n <= 0) return name
  // 统一两位小数 —— 网站也是这个口径（0.01 / 0.04 / 0.13 / 0.56），
  // 用一位会把 0.15 截成 0.1，看起来和 0.10 一样，比价就失真了
  return `${name} · ${(n / MULT_BASE).toFixed(2)}×`
}

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
        const hasPoints = p.inputPoints != null && Number(p.inputPoints) > 0
        // 计费接口整体成功、但这条没价格 → 不列。
        // 填 0 会被宿主当成「免费」显示绿色徽章，那是谎报；
        // 网页上那些 VIP/无倍率模型也是这样 —— 没有价格就不标价格。
        // 接口整体失败时（pointsOk=false）不过滤，免得列表直接空掉。
        if (pointsOk && !hasPoints) continue

        const cost = hasPoints
          ? {
              input: Number(p.inputPoints) / MULT_BASE,
              output: Number(p.outputPoints) / MULT_BASE,
              cache: { read: 0, write: 0 },
            }
          : undefined

        // 倍率同时拼进名字 —— cost 宿主不认（实测），这是唯一能看见的通道
        out[m.id] = modelEntry(c, m.id, withMultiplier(m.name, p.inputPoints), m.vision, cost)
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

