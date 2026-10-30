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
//
// ═══ 上游会给负数（欠费）—— 余额位钳到 0，只把「欠费 N」写进文案 ═══════════
//
// 实测（2026-10-30，国内站四个号原样返回，见 CHANGELOG 0.3.65）：
//
//   {"code":1000,"message":"ok","data":{
//      "organization_total_points":-31, "total_points":-31,
//      "expiring_quota_details":[], "next_cycle_grant":null, …}}
//
// ⇒ 负数**不是插件算错的**：上游钱包真的透支。模型网关是先扣钱、后判余额，
// 一次请求就能把 0 打到负（CHANGELOG 0.3.26 也记过一次：余额 82 的号一轮对话
// 被烧成负数）。补款后同一接口会回正，所以别把欠费缓存成「永不可用」。
//
// 显示纪律：
//   · 窗口 `balance`（宿主拿去算占比的数值位）**永远 ≥ 0** —— 负数进路由只会
//     折出一个没有意义的百分比；
//   · 欠多少只进 `display` / 顶层 `balance` 文案：「已欠费 31 积分」；
//   · 0 与欠费必须分开说：前者是「已耗尽」（等明天 00:00 的每日积分），
//     后者是「已欠费 N」（该去充值），用户得能分清；
//   · 读不到（字段缺失 / null）**不是 0**：返回 error，宁可卡片空着也不报假额度。

import { fetchPoints, SITES } from "../api.mjs"
import { ensureCheckinDefault } from "../auto-maintenance.mjs"
import { statusOf } from "../invite-quota.mjs"

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
      // 读不到 ≠ 0：0 是「已用完」，读不到是「不知道」。上游少给一个字段就报
      // 「已耗尽」，那是拿假额度骗人（也骗路由）。
      if (!p.totalKnown) return { error: "积分接口没有返回可用余额", windows: [] }

      const total = p.total
      // 上游会给负数（欠费，实测见 CHANGELOG 0.3.65）。余额位一律钳到 0：
      // 宿主与用户看到的「剩余」永远不该是负的；欠了多少只进文案。
      const debt = total < 0 ? -total : 0
      const left = Math.max(0, total)
      const batches = Array.isArray(p?.expiring) ? p.expiring : []
      const windows = [{
        name: "积分余额",
        balance: left,
        unit: "积分",
        display: balanceText(left, debt),
        ...(left > 0 ? runsOutOf(batches) : { resetsAt: nextGrantAt() }),
      }]

      // 邀请次数：X / 上限。上游不给上限，按站点奖励口径换算（见 src/invite-quota.mjs）。
      //
      // 放在余额之后、批次行之前 —— 邀请额度是「这个号还能拉几个人」，和积分余额
      // 是两件事，但都要一眼看到。
      //
      // ⚠ 只给 display + unit，**不给 used / amount / limit**：
      //   邀请名额不是模型用量，标成额度会让宿主的 allowanceOf 把它算进路由占比
      //   （HOOKS 三·①：aside 带 amount/limit 会被当「真额度」算占比）。
      //   现有余额窗口没标 aside，所以这个号在路由里照样 Known=true。
      //
      // 查询失败（没登录态 / 接口抖）就整行不出现 —— 宁可少一行，不显示假数字。
      // 口径是「已邀几个人 + 还能发多少分」：上游唯一的硬上限是**邀请积分封顶**，
      // 人数不是上限（实测 2026-10-30：54 人仍在结算奖励，见 invite-quota.mjs 的 quotaOf 头）。
      const invite = await statusOf(c, auth.org).catch(() => null)
      if (invite && invite.limit > 0) {
        windows.push({
          name: "邀请额度",
          display: invite.full ? `${invite.display} · 已封顶` : invite.display,
          unit: "分",
          aside: true,
        })
      }

      if (left > 0) {
        const today = beijingDay(Date.now())
        const todayBatches = batches.filter((b) => b.points > 0 && beijingDay(parseServerTime(b.expiresAt)) === today)
        const todayLeft = sum(todayBatches)
        const timedLeft = sum(batches)
        const timedRest = Math.max(0, timedLeft - todayLeft)
        const permanent = Math.max(0, left - timedLeft)
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
        // plan 也说清楚是哪一种：欠费不是「用完了」，余额补不上之前一样用不了，
        // 但用户看到「已欠费」才知道该去充的是钱，不是等明天的免费额度。
        plan: total > 0 ? "积分制" : debt > 0 ? "已欠费" : "已耗尽",
        // 顶层 balance 是「余额值」那一格：正常时就是个数字，欠费才写成话。
        // 它也是用户真正看到「-153 积分」的地方（窗口 display 早就写着「已耗尽」，
        // 用户还是来问负数 —— 说明负数是从这一格漏出去的）。
        balance: debt > 0 ? `已欠费 ${fmt(debt)} 积分` : `${fmt(left)} 积分`,
        windows,
      }
    } catch (e) {
      return { error: String(e?.message ?? e), windows: [] }
    }
  }
}

/**
 * 「积分余额」窗口的 `display` 文案（正常 / 用完 / 欠费三种说法）。
 *
 *   还有余额 → `6,291 积分`
 *   刚好用完 → `已耗尽`              （上游给 0，等明天 00:00 的每日积分）
 *   欠费     → `已欠费 31 积分`       （上游给负数，补款前用不了）
 *
 * 为什么不能直接写 `-31 积分`：负数摆在「剩余」位上没人看得懂 —— 是欠 31？
 * 是花了 31？还是插件算错了？「欠费」两个字就是事实本身。
 *
 * ⚠ 顶层 `balance` 不走的 0 分支：那一格是「余额值」，正常时该是纯数字
 * （`0 积分` / `107 积分`），只有欠费才写成话（「已欠费 N 积分」）。
 */
function balanceText(left, debt) {
  if (debt > 0) return `已欠费 ${fmt(debt)} 积分`
  if (left > 0) return `${fmt(left)} 积分`
  return "已耗尽"
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

/**
 * 积分耗尽时，账户下一次有积分的时刻 → magpie 的 `resetsAt`。
 *
 * 为什么必须有它（2026-10-29 实测）：
 *
 * 宿主把「余额 ≤ 0」读成「用掉 100%」（provider/routing.go 里 balance→used
 * 的换算），于是这个账号进 smart 的最后一档（spent）。但 spent 只是**排在
 * 后面**，不是被排除 —— 一池账号全耗尽时，宿主仍然会一个一个去试，每个都
 * 回一次 402。
 *
 * 而上游的 402 文案里写着「充值」，宿主读成 failCredit；failCredit 的休息
 * 是「猜的」：一分钟后就再问一次（routing.go 里 guessed → askAt）。于是
 * 账号被反复叫醒、反复撞：一天 1,332 次 402（每个国内号 30 分钟内 134 次）。
 *
 * 报上 `resetsAt`，宿主就知道这个账户的额度是「满的，直到那一刻」：
 *   · Allowance.Full() 有值了（它要 used ≥ 98 **且** Resets 在未来）；
 *   · 休息睡到那一刻，而不是一分钟后；
 *   · 积分补上后（宿主重读到余额变了）自动醒。
 *
 * 每日积分的周期是**北京时间每天 00:00**（服务端给的每日批次 23:59 到期，
 * 次日新的一批到账），所以下一次补充就在下一个 00:00。
 */
function nextGrantAt() {
  const now = Date.now()
  // 北京时间的当下（UTC+8）
  const bj = new Date(now + 8 * 3600e3)
  const nextMidnight = Date.UTC(
    bj.getUTCFullYear(),
    bj.getUTCMonth(),
    bj.getUTCDate() + 1,
    0, 0, 0, 0,
  ) - 8 * 3600e3
  return new Date(nextMidnight).toISOString()
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
