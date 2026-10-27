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
            display: `${total.toLocaleString("zh-CN")} 积分`,
            unit: "积分",
            // 官方字段：剩余额度**什么时候失效**、失效时损失多少。
            // 有它就不用自己往 display 里拼「185 分今天到期」——
            // magpie 自己会在额度行后面加这句（见脚手架 HOOKS.md 第十一节）。
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
