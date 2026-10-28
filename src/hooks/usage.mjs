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
// 钱包只有一个总数，但过期批次有先后：今日 23:59 到期的每日积分、其他限时
// 批次、永久积分要看得见。它们在余额窗口之后作为 `aside` 文本行显示（只展示，
// 不进 Allowance.Left —— 否则最小的那一条会把总余额压低）。
//
// 不要再把「今日 / 限时 / 永久」做成带 used/limit 的假百分比窗口；旧写法是
// 宿主支持余额之前的临时协议，见 CHANGELOG 0.3.20。

import { fetchPoints, SITES } from "../api.mjs"
import { ensureCheckinDefault } from "../auto-maintenance.mjs"

// 每日登录积分：国内 +200/天、国际 +50/天（实测，见 docs/internals.md）。
// 今日批次的分母，只用于展示「今日还剩 / 今日额度」。
const DAILY_LOGIN_GIFT = { cn: 200, intl: 50 }

export function makeUsage(c) {
  let ensuredCheckin = false
  return async (getAuth) => {
    // config 已经补过默认签到；这里再兜一次 —— magpie 启动时可能先
    // Save 了内存里的旧 settings，把 config 那次覆盖掉。只补「从未设置过」的。
    if (!ensuredCheckin) {
      ensuredCheckin = true
      try {
        ensureCheckinDefault(c.PROVIDER)
      } catch {}
    }
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

      if (total > 0) {
        const today = beijingDay(Date.now())
        const todayBatches = batches.filter((b) => b.points > 0 && beijingDay(parseServerTime(b.expiresAt)) === today)
        const todayLeft = sum(todayBatches)
        const timedLeft = sum(batches)
        const timedRest = Math.max(0, timedLeft - todayLeft)
        const permanent = Math.max(0, total - timedLeft)
        const dailyCap = DAILY_LOGIN_GIFT[c.host === SITES.cn.host ? "cn" : "intl"]

        // 只展示的批次行：没有 used/limit/balance，宿主把它们当 aside 文本，
        // 不参与 Allowance.Left；路由仍只看上面的总余额。
        if (todayLeft > 0) {
          windows.push({
            name: "今日积分",
            display: `${fmt(todayLeft)} / ${fmt(dailyCap)} 积分 · 今日 23:59 到期`,
            unit: "积分",
            aside: true,
          })
        }
        if (timedRest > 0) {
          const next = pickEarliest(batches.filter((b) => !todayBatches.includes(b)))
          const when = next ? ` · 最早 ${beijingDate(next.ms)} 到期` : ""
          windows.push({
            name: "限时积分",
            display: `${fmt(timedRest)} 积分${when}`,
            unit: "积分",
            aside: true,
          })
        }
        if (permanent > 0) {
          windows.push({
            name: "永久积分",
            display: `${fmt(permanent)} 积分`,
            unit: "积分",
            aside: true,
          })
        }
      }

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

/** 北京时间的日期键 `YYYY-MM-DD`（服务端的时间都是 UTC+8） */
function beijingDay(ms) {
  if (ms === null) return ""
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10)
}

function beijingDate(ms) {
  return beijingDay(ms)
}

const sum = (list) => list.reduce((n, b) => n + Number(b?.points ?? 0), 0)
const fmt = (n) => Number(n).toLocaleString("zh-CN")
