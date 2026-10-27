// 体检 —— 「首任务做了没」「邀请奖励到没到账」
//
// ═══════════════════════════════════════════════════════════════════════
// 为什么需要它
// ═══════════════════════════════════════════════════════════════════════
//
// 邀请奖励不是「注册即得」。官方前端 locale 的原文是：
//
//   被邀请人完成首个任务或对话后，即可获得 {{points}} 积分奖励。
//
// 于是每次拉新都卡在同一个问题上：**小号到底算不算「完成」了？钱到没到？**
// 手工去网页翻「免费积分计划」里那张表很麻烦，尤其号一多。
//
// 所以给 magpie 的登录方式列表里挂一条「体检」：点一下，把所有账号的
// 首任务状态、邀请人数、奖励明细一次列出来。不输入、不改任何状态。
//
// ⚠ 判据不是猜的：`first_ai_work` 与邀请奖励用的是同一套「产品内完成过」
//   判定。实测同一个号通过 magpie 调模型、真扣了积分，`first_ai_work`
//   仍然是 PENDING，邀请奖励也一分不发 —— 见 CHANGELOG 0.3.9。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  SITES,
  fetchWho,
  fetchPoints,
  fetchOnboardingTasks,
  fetchOwnInviteCode,
  fetchInviteRewards,
} from "./api.mjs"

/** magpie 的凭据库；zcode 插件也是直接读它来枚举多账号的 */
function authStorePath(home = homedir()) {
  return join(home, ".config", "magpie", "plugin-auth.json")
}

/**
 * 枚举本机已登录的全部 magicrew 账号。
 *
 * 键名形如 `magicrew`、`magicrew-intl`、`magicrew#4rm3fp`、`magicrew-intl#z983c8`，
 * 所以按 `magicrew-intl` 前缀判站点，剩下的都算国内站。
 *
 * @returns {Array<{id,siteId,site,jwt,org,accountId}>}
 */
export function listAccounts({ home = homedir() } = {}) {
  let raw
  try {
    raw = JSON.parse(readFileSync(authStorePath(home), "utf8"))
  } catch {
    return []
  }
  const out = []
  for (const [id, e] of Object.entries(raw)) {
    // 宿主里的键名是 `magicrew` / `magicrew#4rm3fp` / `magicrew-intl` / `magicrew-intl#z983c8`
    // ⚠ 别写成 /^magicrew(#|$)/ —— 那样 `magicrew-intl*` 全部匹配不上，
    //   国际站会显示「还没有登录任何账号」（踩过）
    if (!/^magicrew(-intl)?(#|$)/.test(id)) continue
    if (typeof e?.jwt !== "string" || !e.jwt) continue
    const siteId = id.startsWith("magicrew-intl") ? "intl" : "cn"
    out.push({
      id,
      siteId,
      site: SITES[siteId],
      jwt: e.jwt,
      org: String(e.org ?? ""),
      accountId: String(e.accountId ?? id),
    })
  }
  return out
}

/**
 * 查一个账号的四件事。任一接口挂了不影响其它项 —— 体检要尽量给出全貌，
 * 不能因为「积分读不到」就整份报告作废。
 */
export async function inspectOne(a) {
  const host = a.site.host
  const r = { ...a, errors: [], points: null, who: null, firstTask: null, invite: null, rewards: null }

  const guard = async (name, p) => {
    try {
      return await p
    } catch (e) {
      r.errors.push(`${name}：${e?.message ?? e}`)
      return null
    }
  }

  // 五个请求并发：串行要等五轮，太慢；guard 已保证单个失败不拖垮整份报告
  const [points, who, tasks, invite, rewards] = await Promise.all([
    guard("积分", fetchPoints(a.jwt, a.org, host)),
    guard("账号名", fetchWho(a.jwt, a.org, host)),
    guard("首任务", fetchOnboardingTasks(a.jwt, a.org, host)),
    guard("邀请码", fetchOwnInviteCode(a.jwt, a.org, host)),
    guard("邀请奖励", fetchInviteRewards(a.jwt, a.org, host)),
  ])

  r.points = points
  r.who = who
  r.invite = invite
  r.rewards = rewards

  if (tasks) {
    const t = tasks.find((x) => x.code === "first_ai_work")
    r.firstTask = t
      ? {
          done: t.status === "COMPLETED" || t.rewardStatus === "GRANTED",
          points: t.points,
          at: t.completedAt,
        }
      : { done: null, points: 0, at: null } // null = 本站没有这项任务（国际站恒如此）
  }

  return r
}

/** 一个账号一段，纯文本 —— magpie 那边是当错误信息弹出来的，不做富文本 */
export function formatOne(r) {
  const tag = r.siteId === "intl" ? "国际站" : "国内站"
  // 昵称/手机号好认；取不到才退回组织码（那是一串随机字母数字，认不出是谁）
  const who = r.who?.name || r.org || r.accountId
  const L = []
  L.push(`【${tag}】${who}  (${r.org})`)

  if (r.points) L.push(`  积分 ${r.points.total}`)
  else L.push("  积分 读取失败")

  if (r.firstTask === null) {
    L.push("  首任务 读取失败")
  } else if (r.firstTask.done === null) {
    L.push(`  首任务 —（本站没有新手福利，无需完成）`)
  } else if (r.firstTask.done) {
    // completed_at 是 UTC 带时区的 ISO；本地化再显示，否则会差 8 小时
    let at = ""
    if (r.firstTask.at) {
      try {
        at = " " + new Date(r.firstTask.at).toLocaleString("zh-CN", { hour12: false })
      } catch {}
    }
    L.push(`  首任务 ✅ 已完成${at}`)
  } else {
    L.push(`  首任务 ⏳ 未完成${r.firstTask.points ? `（完成可得 ${r.firstTask.points} 分）` : ""}`)
    L.push("         ↳ 需在网页/客户端里真跑完一次对话或任务，通过 magpie 调模型不算")
  }

  if (r.invite) {
    const n = r.invite.count
    const earned = r.rewards ? r.rewards.earned : 0
    L.push(`  邀请码 ${r.invite.code} · 已邀 ${n} 人 · 已到账 ${earned} 分`)
  } else {
    L.push("  邀请码 读取失败")
  }

  if (r.rewards) {
    if (!r.rewards.list.length) {
      L.push(`  奖励记录 0 条${r.invite?.count ? "  ← 有人用了你的码，但还没「完成首任务」，所以没发" : ""}`)
    } else {
      for (const x of r.rewards.list) {
        const who = x.invitedUserId ? ` 邀请 ${x.invitedUserId.slice(0, 14)}…` : ""
        L.push(`    · ${x.description} +${x.points} · ${x.statusText}${who}`)
      }
    }
  }

  if (r.errors.length) L.push(`  ⚠ ${r.errors.join("；")}`)
  return L.join("\n")
}

/**
 * 全量体检，返回可直接展示的整份报告。
 *
 * @param {{siteId?: "cn"|"intl"}} opts 传了就只查该站点（两个 provider 各挂一条，
 *   点哪个就只看哪个站，跟「一个包两个供应商、互不聚合」保持一致）
 */
export async function buildReport({ siteId } = {}) {
  const all = listAccounts()
  const accounts = siteId ? all.filter((a) => a.siteId === siteId) : all
  if (!accounts.length) {
    const where = siteId === "intl" ? "国际站 MagiCrew " : siteId === "cn" ? "国内站 超级麦吉 " : ""
    return where
      ? `${where}还没有登录任何账号，先添加一个再来体检。`
      : "还没有登录任何超级麦吉 / MagiCrew 账号，先添加一个再来体检。"
  }
  const rows = []
  // 串行：一批号同时打四五个请求容易撞限流，慢一点但结果可信
  for (const a of accounts) rows.push(await inspectOne(a))
  return [`体检（${accounts.length} 个账号）`, ...rows.map(formatOne)].join("\n\n")
}

export { authStorePath }
