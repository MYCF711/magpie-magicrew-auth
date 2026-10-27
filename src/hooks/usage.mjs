// ⑤ auth.usage(getAuth) —— 额度
//
// 画进度条，**同时是路由排序输入**：`used` 缺了会被当成 0% = 满额，
// 空号反而排到队首。
//
// ════════════════════════════════════════════════════════════════════
// 这个窗口该长什么样（结论来自 magpie 二进制取证 + Loomy 的实测笔记）
// ════════════════════════════════════════════════════════════════════
//
//   quotaCount(w){ if (!(w.limit > 0)) return w.display || ""; … }
//   const counted = q.windows.filter((w) => !w.unlimited);
//   … else if (w.aside) s = t("{api} only after the others")   // aside 排后面
//
// 两条硬规矩：
//
//   ① **预充值积分制放 `aside: true`** —— 它没有周期、没有上限，不该参与路由
//      排序。`used: 0` 的窗口如果参与排序，会让「余额充足」和「空号」看起来
//      一样，路由就会把请求派到已经蹬空的号上。
//
//   ② **aside 窗口不给 `amount` / `limit`** —— 给了，magpie 会把它当成一条真
//      额度去算占比，而「总量 = 剩余」这种假总量算出来的百分比没有意义。
//      只给 `display`，magpie 就直接显示这个字符串。
//
// ⚠ 真机踩过（0.3.18）：原来给了 `amount: 0, limit: total`，还把 `resetsAt`
//   写成服务端那种 `"2026-11-26 16:01:02"`（**不是 ISO**，Loomy 用的是
//   `toISOString()`）。结果卡片上三条账号全显示「剩余额度未知」——
//   usage 本身返回正常（plan/balance/windows 都在、没有 error），
//   是 magpie 读不懂这个窗口才不画。
//   ⇒ 现在的写法：aside + display + unit，别的都不给。

import { fetchPoints } from "../api.mjs"

export function makeUsage(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { error: "未登录", windows: [] }
    try {
      const p = await fetchPoints(auth.jwt, auth.org, c.host)
      const total = Number(p?.total ?? 0)

      // 余额为 0 时**必须**给一条参与路由的 used:100 窗口，让这个号排到最后；
      // 只靠 aside 是压不住的（aside 不参与排序）。
      if (!(total > 0)) {
        return {
          plan: "已耗尽",
          balance: "0 积分",
          windows: [{ name: "积分余额", used: 100, display: "已耗尽", unit: "积分" }],
        }
      }

      return {
        plan: "积分制",
        balance: `${total.toLocaleString("zh-CN")} 积分`,
        windows: [
          {
            name: "积分余额",
            used: 0,
            aside: true,
            display: balanceLine(total, p.expiring),
            unit: "积分",
          },
        ],
      }
    } catch (e) {
      return { error: String(e?.message ?? e), windows: [] }
    }
  }
}

/**
 * 余额那一行：`6,291 积分 · 185 分今天到期`
 *
 * 为什么要带过期提示：积分是**分批发放、各批各自到期**的（不是整体周期重置）。
 * 实测 189\*\*\*\*051：total 6291 里有 5291 分有明确期限，8 批 —— 最早那批
 * 185 分当天 23:59:59 就没了。卡片上只写「6,291 积分」的话，用户根本看不出
 * 有一批今晚作废。
 *
 * ⚠ 服务端给的是 `"2026-10-28 23:59:59"`（空格分隔、无时区），不是 ISO。
 *   直接 `new Date()` 解析在不同引擎上不一致，所以这里手工拆字段。
 */
function balanceLine(total, expiring) {
  const base = `${total.toLocaleString("zh-CN")} 积分`
  const next = pickEarliest(expiring)
  if (!next) return base
  const left = formatLeft(next.expiresAt)
  if (!left) return base
  return `${base} · ${next.points.toLocaleString("zh-CN")} 分 ${left}到期`
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

/** 剩余时间的说法：今天 / 明天 / N 天后 / 已过期 */
function formatLeft(expiresAt, now = Date.now()) {
  const ms = parseServerTime(expiresAt)
  if (ms === null) return ""
  const left = ms - now
  if (left <= 0) return "已过期"
  const day = 86_400_000
  if (left < day) return "今天"
  const days = Math.floor(left / day)
  if (days === 1) return "明天"
  if (days <= 30) return `${days} 天后`
  return "" // 还早，不占地方
}
