// ⑤ auth.usage(getAuth) —— 额度
//
// 画进度条，**同时是路由排序输入**：`used` 缺了会被当成 0% = 满额，
// 空号反而排到队首。
//
// ════════════════════════════════════════════════════════════════════
// 超级麦吉的积分是「钱包」：三种时限混在一起
// ════════════════════════════════════════════════════════════════════
//
// `/api/v1/quota/points/total` 只回一个 `total_points`（当前余额）和
// `expiring_quota_details`（会过期的批次：剩余 + 到期日）。**没有总量、
// 没有已消耗**；`organization_limit_points` / `user_limit_points` 在个人号
// 上全是 null；积分流水 `POST /api/v1/quota/points/records/queries` 实测恒 500。
//
// 于是按「什么时候失效」拆成三块：
//
//   ① 今日积分   —— 今天 23:59:59 到期的批次（每日登录赠送，国内 200/国际 50）。
//                    **这一块有真实分母**，所以百分比和进度条都是真的。
//   ② 限时积分   —— 其余会过期批次（30 天后、一年后……）的剩余之和。
//                    服务端不给原始额度 ⇒ 分母不可知，只能显示数字 + 最早到期。
//   ③ 永久积分   —— `total - Σ限时`，不过期，只显示。
//
// ════════════════════════════════════════════════════════════════════
// magpie 契约的三条硬约束（读宿主源码 + 官方文档确认）
// ════════════════════════════════════════════════════════════════════
//
//   ① `aside: true` 或 `used` 缺省 的窗口，会被 `allowanceOf()` **整条跳过**；
//      一条不剩 ⇒ `routedAllowance()` 不 ok ⇒ `weighed()` 不设 `Known`
//      ⇒ 路由页「剩余额度未知」，且该号一律排在已知的之后。
//      （官方文档 docs/subsystems/provider-plugins.md，issue #3650）
//
//   ② 路由的 `quota()` 只在 `limit > 0` 时才显示数字，否则只剩一个光秃秃的百分比。
//
//   ③ 「有进度条」和「参与路由」焊在同一个窗口上：要进度条就必须给
//      `used` + `limit`；而钱包没有分母，给了就是「总量 = 剩余」的假占比。
//
// ⇒ 所以这里：今日池给真占比；限时池给数字（分母只能是当前余量，百分比无意义）；
//   永久池标 aside 只展示。**真正的解在宿主侧** —— 需要「余额型窗口」：
//   有读数、能参与路由（带 runsOutAt），但不参与百分比。已向 magpie 提 issue。
//
// 判据（2026-10-28 实测，两站四个号）：
//   `/v1/magpie/trace` 里 `known` = true（修复前字段缺失）
//   路由页：`限时积分 5,291 / 5,291 积分 · 剩余 100% · 6 小时后到期`

import { fetchPoints, SITES } from "../api.mjs"

// 每日登录积分：国内 +200/天、国际 +50/天（实测，见 docs/internals.md）。
// 它是「今天 23:59:59 到期」的唯一固定额度来源，所以能当今日池的分母。
const DAILY_LOGIN_GIFT = { cn: 200, intl: 50 }

export function makeUsage(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { error: "未登录", windows: [] }
    try {
      const p = await fetchPoints(auth.jwt, auth.org, c.host)
      const total = Number(p?.total ?? 0)
      const batches = Array.isArray(p?.expiring) ? p.expiring : []

      // 余额为 0：合成一条 used:100 的参与路由窗口，让这个号沉底。
      // 光靠 aside 压不住（aside 根本不进路由）。
      if (!(total > 0)) {
        return {
          plan: "已耗尽",
          balance: "0 积分",
          windows: [{ name: "积分余额", used: 100, display: "已耗尽", unit: "积分" }],
        }
      }

      const today = beijingDay(Date.now())
      const todayBatches = batches.filter((b) => b.points > 0 && beijingDay(parseServerTime(b.expiresAt)) === today)
      const todayLeft = sum(todayBatches)
      const timedLeft = sum(batches)
      const timedRest = Math.max(0, timedLeft - todayLeft)
      const permanent = Math.max(0, total - timedLeft)
      const dailyCap = DAILY_LOGIN_GIFT[c.host === SITES.cn.host ? "cn" : "intl"]

      const windows = []
      let routed = 0 // 不是 aside 的窗口条数：为 0 的话这个号在路由里就是「未知」

      // ① 今日积分：真百分比 + 真重置时间
      if (todayLeft > 0) {
        const used = clamp(100 * (1 - todayLeft / dailyCap))
        windows.push({
          name: "今日积分",
          used,
          amount: Math.max(0, dailyCap - todayLeft), // 已用
          limit: dailyCap,
          display: `${fmt(todayLeft)} / ${fmt(dailyCap)} 积分`,
          unit: "积分",
          resetsAt: nextBeijingMidnight(),
        })
        routed++
      }

      // ② 限时积分（今日之外的批次）：分母不可知，给数字 + 最早到期
      if (timedRest > 0) {
        windows.push({
          name: "限时积分",
          used: 0, // 钱包没有「已用%」；排序靠下面的 runsOutAt
          amount: 0,
          limit: timedRest, // 让 UI 有一个数可显示（总量=当前余量，见文件头 ③）
          display: `${fmt(timedRest)} 积分`,
          unit: "积分",
          ...runsOutOf(batches.filter((b) => !todayBatches.includes(b))),
        })
        routed++
      }

      // ③ 永久积分：不过期，只展示
      if (permanent > 0) {
        windows.push({
          name: "永久积分",
          used: 0,
          aside: true,
          display: `${fmt(permanent)} 积分`,
          unit: "积分",
        })
      }

      // 兜底：全是永久积分（没有任何限时批次）时，仍要给一条参与路由的窗口。
      // 否则整个号在路由里就是「未知」，会被压在所有已知账号之后。
      if (!routed) {
        windows.push({
          name: "积分余额",
          used: 0,
          amount: 0,
          limit: total,
          display: `${fmt(total)} 积分`,
          unit: "积分",
        })
      }

      return { plan: "积分制", balance: `${fmt(total)} 积分`, windows }
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

/** 北京时间「明天 00:00:00」的 ISO（今日积分每天这时重置） */
function nextBeijingMidnight(now = Date.now()) {
  const bj = new Date(now + 8 * 3600e3)
  const t = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() + 1) - 8 * 3600e3
  return new Date(t).toISOString()
}

const sum = (list) => list.reduce((n, b) => n + Number(b?.points ?? 0), 0)
const clamp = (n) => Math.max(0, Math.min(100, n))
const fmt = (n) => Number(n).toLocaleString("zh-CN")
