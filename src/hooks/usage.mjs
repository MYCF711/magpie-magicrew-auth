// ⑤ auth.usage(getAuth) —— 额度
//
// 画进度条，**同时是路由排序输入**：`used` 缺了会被当成 0% = 满额，
// 空号反而排到队首。
//
// ════════════════════════════════════════════════════════════════════
// 真机踩过两次，两次都不是「显示」的问题，是「magpie 认不认得」的问题
// ════════════════════════════════════════════════════════════════════
//
//   第一次（0.3.18）：`amount: 0, limit: total` + 服务端格式的 `resetsAt`
//     ⇒ 卡片全部「剩余额度未知」。根因是时间不是 ISO。
//
//   第二次（0.3.18）：改成 `aside: true` + 只给 `display`
//     ⇒ **卡片好了，路由页还是「剩余额度未知」**。
//
// 第二次的根因在 magpie 宿主侧，读源码可证：
//
//   provider/routing.go  allowanceOf()   if (w.Aside || w.Text) { continue }   ← aside 被整条跳过
//   provider/routing.go  routedAllowance() if len(a) == 0 { return nil, false } ← 一条不剩 ⇒ 不 ok
//   gateway/trace.go     weighed()       if l, ok := wg.lefts[key]; ok { w.Known = true }
//   routing/client.js    w.known 为假且 kind=="account" ⇒ 「剩余额度未知」
//
// 官方文档逐字写着这件事（docs/subsystems/provider-plugins.md，issue #3650）：
//   "An account whose windows all tell no share has no allowance, so routing
//    counts it not known ... as one never read, rather than as the one with
//    all of it left. A window that says `used: 0` is a reading at 0, as before."
//
// ⇒ **aside 的代价是「这个号在路由里不存在」**，不是「只是不参与打分」。
//   多账号路由下这很实：unknown 的号一律排在已知的之后，
//   一个余额充足的号会被当成「不知道有没有额度」而压到最后。
//
// ════════════════════════════════════════════════════════════════════
// 所以超级麦吉这条窗口怎么给
// ════════════════════════════════════════════════════════════════════
//
// 积分是**预充值钱包**：没有周期、没有总量，服务端只回一个「还剩多少」
// （`/api/v1/quota/points/total` → `total_points`；`organization_*_limit_points`
// 和 `user_*_limit_points` 在个人号上全是 null，积分流水端点实测 500）。
//
// 而 magpie 的额度契约是为「周期配额」设计的：`used` 是 0-100 的百分比，
// 路由的 `quota()` 又只在 `limit > 0` 时才显示数字。两条加起来 ——
// **要让它显示一个数，就必须给 `limit`**。
//
// 于是把钱包写成它的恒等式：
//
//     limit = 余额      amount = 0      used = 0
//     ⇒ 总量 = 已用 + 剩余 = 0 + 余额
//
// 余下的都对：剩余 100% 是真的（这点余额一分没动），路由行为也对：
//
//     余额 > 0 → used 0   → fine 档，正常参与
//     余额 = 0 → used 100 → spent 档，沉底
//
// ⚠ 代价说清楚：**百分比没有信息量**（分母就是分子）。这是 magpie 契约能
//   表达钱包的唯一形态，不是我们算错了。真正的「余额型额度」表达
//   （已知、但不参与百分比）magpie 目前没有 —— 那是宿主侧的事。
//   判据：卡片与路由页都显示 `<余额> 积分`，不再是「剩余额度未知」。

import { fetchPoints } from "../api.mjs"

export function makeUsage(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { error: "未登录", windows: [] }
    try {
      const p = await fetchPoints(auth.jwt, auth.org, c.host)
      const total = Number(p?.total ?? 0)

      // 余额为 0 时**必须**给一条参与路由的 used:100 窗口，让这个号排到最后。
      // 只靠 aside 是压不住的（aside 根本不进路由）。
      if (!(total > 0)) {
        return {
          plan: "已耗尽",
          balance: "0 积分",
          windows: [{ name: "积分余额", used: 100, display: "已耗尽", unit: "积分" }],
        }
      }

      const text = `${total.toLocaleString("zh-CN")} 积分`
      return {
        plan: "积分制",
        balance: text,
        windows: [
          {
            name: "积分余额",
            // 「钱包」的恒等式：总量 = 已用 + 剩余 = 0 + 余额。
            // 不能标 aside —— 那样整条窗口会被 allowanceOf 跳过，
            // 这个号在路由页就变成「剩余额度未知」（见文件头）。
            used: 0,
            amount: 0,
            limit: total,
            display: text,
            unit: "积分",
            // 官方字段：剩余额度**什么时候失效**、失效时损失多少（最早作废的那批）。
            ...runsOutOf(p.expiring),
          },
        ],
      }
    } catch (e) {
      return { error: String(e?.message ?? e), windows: [] }
    }
  }
}

/**
 * 最早失效的那批积分 → magpie 的 `runsOutAt` / `runsOut`。
 *
 * 为什么用官方字段而不是往 `display` 里拼一句话：`display` 是给「已用 / 总量」
 * 那种数字用的，拼进去 magpie 就不认它是「失效提示」了；而这两个字段是 magpie
 * 专门为「剩余额度里最早作废的一笔」准备的（见脚手架 HOOKS.md 第三节）。
 *
 * ⚠ `runsOutAt` 必须是 **ISO 字符串或数字**。服务端给的是
 *   `"2026-10-28 23:59:59"`（空格分隔、无时区）—— 直接塞进去 magpie 解析不了，
 *   整条窗口都会被跳过，卡片就变成「剩余额度未知」。所以要自己转成 ISO。
 */
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
    if (!best || ms < best.ms) best = { points: pts, ms, expiresAt: e.expiresAt }
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
