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

// 倍率显示
//
// 网站（模型选择器）在名字后面带一个「0.01×」这样的倍率。它来自运营后台的
// 「模型参考倍率」，算法是「模型平均金额 ÷ 当前基准金额」（前端 locale 原文：
// `division: 模型平均金额 ÷ 当前基准金额`）—— 那套配置走 admin 接口，
// 普通账号的 token 调不到（/api/v1/flows/model-multipliers 回 31001）。
//
// magpie 的模型条目里也没有倍率字段（zcode 那套 cost 同样填 0，却显示倍率，
// 说明那是宿主自己接的）。所以这里把倍率直接拼进 name —— 一定能显示出来。
//
// 数值用 input_points / 2000 估：与网站实测值高度吻合
//   Qwen3.5 Flash  20   → 0.01  (网站 0.01) ✓
//   Qwen3.8 Flash  100  → 0.05  (网站 0.05) ✓
//   Qwen3.7 Plus   200  → 0.10  (网站 0.10) ✓
//   MiMo V2.6 Pro  300  → 0.15  (网站 0.13)
//   Qwen3.8 Max   1200  → 0.60  (网站 0.56)
// 高位有轻微偏差（真实公式里 output 也参与），但足够横向比价 —— 目的就是
// 让人一眼看出哪个便宜。
const MULT_BASE = 2000

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

      const out = {}
      for (const m of live) {
        const p = points[m.id] || {}
        // cost 填「倍率」，让宿主把它渲染成名字后面的胶囊（0.01× 那种）
        const cost =
          p.inputPoints != null
            ? {
                input: Number(p.inputPoints) / MULT_BASE,
                output: Number(p.outputPoints) / MULT_BASE,
                cache: { read: 0, write: 0 },
              }
            : undefined
        out[m.id] = modelEntry(c, m.id, m.name, m.vision, cost)
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

