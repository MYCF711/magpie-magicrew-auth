// ⑤ auth.usage(getAuth) —— 额度
//
// 超级麦吉的积分是「预付钱包」：`/api/v1/quota/points/total` 只回当前余额
// `total_points` 和一批会过期的明细（`expiring_quota_details`），没有总量、
// 没有已消耗；积分流水接口恒 500。钱包没有分母，不能编造 used/limit 百分比。
//
// magpie 0.1.1790（issue #3950）起，窗口可以直接报余额：
//
//   windows: [{
//     name: "积分余额",
//     balance: 6291,   // 还剩多少，单位见 unit
//     unit: "积分",
//     // 可选：runsOutAt / runsOut / display / model / models / notModels
//   }]
//
// 不写 used / limit / aside —— 宿主把余额当读数额度，不画百分比；同 provider、
// 同单位的账号按余额从多到少排，余额 0 视为用完。`runsOutAt` 取最早过期的
// 一批，让 smart 路由知道谁的积分先失效。
//
// 不要再拆成「今日 / 限时 / 永久」三块，也不要用 limit = 余额 的假百分比；
// 旧写法是宿主支持余额之前的临时协议，见 CHANGELOG 0.3.20。

import { fetchPoints } from "../api.mjs"

export function makeUsage(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { error: "未登录", windows: [] }
    try {
      const p = await fetchPoints(auth.jwt, auth.org, c.host)
      const total = Number(p?.total ?? 0)
      if (!Number.isFinite(total)) return { error: "积分接口没有返回可用余额", windows: [] }
      const batches = Array.isArray(p?.expiring) ? p.expiring : []
      const windows = [{
        name: "积分余额",
        balance: total,
        unit: "积分",
        display: total > 0 ? `${fmt(total)} 积分` : "已耗尽",
        ...(total > 0 ? runsOutOf(batches) : {}),
      }]
      return {
        plan: total > 0 ? "积分制" : "已耗尽",
        balance: `${fmt(total)} 积分`,
        windows,
      }
    } catch (e) {
      return { error: String(e?.message ?? e), windows: [] }
    }
  }
}

/** 最早失效的那批 → magpie 的 `runsOutAt` / `runsOut`。 */
function runsOutOf(expiring) {
  const next = pickEarliest(expiring)
  if (!next) return {}
  return {
    runsOutAt: new Date(next.ms).toISOString(),
    runsOut: next.points,
  }
}

function pickEarliest(expiring) {
  const list = Array.isArray(expiring) ? expiring : []
  let best = null
  for (const e of list) {
    const pts = Number(e?.points ?? 0)
    const ms = parseServerTime(e?.expiresAt)
    if (!(pts > 0) || ms === null) continue
    if (!best || ms < best.ms) best = { points: pts, ms }
  }
  return best
}

/** `"2026-10-28 23:59:59"` → 毫秒；解析不了返回 null */
function parseServerTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? ""))
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)).getTime()
  return Number.isFinite(ms) ? ms : null
}

const fmt = (n) => Number(n).toLocaleString("zh-CN")
