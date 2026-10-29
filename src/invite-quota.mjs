// 邀请额度 —— 「这个账号还能邀请几个人」以及「满了就换人吃邀请」
//
// ═══ 上游只给「已经邀了几个」，不给「还能邀几个」══════════════════════
//
// 实测（2026-10-29，两站逐字段核对）：
//
//   GET /api/v1/invitations/info                 → { invite_code, invite_count, invited_users[] }
//   GET /api/v1/invitations/rewards/total-points → { total_earned_points }
//
// **没有任何 limit 字段。** 探过 17 条候选路径（/limit、/config、/activity/2、
// /statistics …）全是 404；`/api/v1/invitations/activity` 只回 `{current_activity:2}`，
// 活动配置并不下发。所以「上限」只能按官方奖励口径算：
//
//            每次注册   邀请注册封顶     ⇒ 名额
//   国内      1,000       60,000          60 次
//   国际        200       10,000          50 次
//
// 口径来自上游前端 constants（docs/internals.md 四；2026-10-29 由用户界面复核：
// 国际站「邀请一个人 +200，被邀请 +200，邀请获得积分上限 +10,000」）。
// ⇒ 它可能随活动调整（current_activity 已经从 1 变过 2），所以：
//   ① 常量集中在 api.mjs 的 INVITE_QUOTA，改一处即可；
//   ② 运行时可被 `magicrew-invite-quota-config-<site>.json` 覆盖（见 quotaOf）。
//
// ═══ 两条判满的路，取或 ═══════════════════════════════════════════════
//
//   count >= limit      名额用完（注册即计数，不等到账）
//   earned >= capPoints 积分封顶（订阅奖励也算在内，可能先于名额到顶）
//
// 只看 count 会漏掉「被邀请人开了套餐、订阅奖励把封顶吃满」的账号；
// 只看 earned 会漏掉「注册了但没完成任务、积分还没结算」的账号 —— 那种账号
// 名额其实已经占了，再拉人上来也不会多给分。所以两条都要看。
//
// ═══ 「真实邮箱」怎么认 ═══════════════════════════════════════════════
//
// 这个插件会拿临时邮箱批量注册（magpie-tempmail 交接的那条链路）。把临时邮箱
// 注册的号选成邀请上级，等于「用一次性身份去吃长期奖励」，随时会废。
//
// 判定只认**白名单后缀**，不认黑名单：
//   临时邮箱域名是动态的（temp-mail.io 换一个域名就是一个新后缀，实测
//   `jbsze.net`、`yzcalo.com` 都不是长期域名），黑名单永远追不上；
//   而「正常邮箱服务商后缀」变化极慢，认得出来就一定是真的。
//
// 所以：`isRealMailbox()` 命中白名单 → 真；其余（含无 @ 的随机串 accountId）
// → 假。宁可少切一次，不把邀请送给一个随时会消失的地址。
// 白名单可以通过 `magicrew-invite-quota-config-<site>.json` 的 `realMailDomains`
// 追加（自建域名邮箱走这里）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fetchInviteStatus, INVITE_QUOTA } from "./api.mjs"
import { cacheDir, readInvitePolicy, writeInvitePolicy } from "./store.mjs"

// ═══ 站点口径 ═════════════════════════════════════════════════════════

/** 这个站一次邀请值多少分、封顶多少分 */
export function quotaConfig(siteId) {
  const base = INVITE_QUOTA[siteId] ?? INVITE_QUOTA.magicrew
  const override = readQuotaConfigFile(siteId)
  const perInvite = Number(override?.perInvite) > 0 ? Number(override.perInvite) : base.perInvite
  const capPoints = Number(override?.capPoints) > 0 ? Number(override.capPoints) : base.capPoints
  return { perInvite, capPoints }
}

/** 名额上限（次数）—— 封顶积分 ÷ 每次积分，向上取整 */
export function limitOf(siteId) {
  const { perInvite, capPoints } = quotaConfig(siteId)
  if (!(perInvite > 0) || !(capPoints > 0)) return 0
  return Math.ceil(capPoints / perInvite)
}

/**
 * 把人头数和已赚积分算成一条可显示的额度。
 *
 * @returns {{limit:number, count:number, earned:number, left:number, full:boolean, display:string}}
 */
export function quotaOf(siteId, { count = 0, earned = 0 } = {}) {
  const { capPoints } = quotaConfig(siteId)
  const limit = limitOf(siteId)
  const c = Math.max(0, Number(count) || 0)
  const e = Math.max(0, Number(earned) || 0)
  const full = (limit > 0 && c >= limit) || (capPoints > 0 && e >= capPoints)
  const left = limit > 0 ? Math.max(0, limit - c) : 0
  const display = limit > 0 ? `${c} / ${limit} 次` : `${c} 次`
  return { limit, count: c, earned: e, left, full, display }
}

// ═══ 真实邮箱判定 ═════════════════════════════════════════════════════

/**
 * 常见「正常邮箱服务商」后缀。
 *
 * 只收长期稳定、不会被当成一次性地址回收的域名。加新域名请走配置文件，
 * 不要在这里堆 —— 这份表是「默认可信」，越短越不容易错。
 */
const REAL_MAIL_DOMAINS = new Set([
  // 国内
  "qq.com", "foxmail.com", "vip.qq.com",
  "163.com", "126.com", "yeah.net", "188.com", "vip.163.com", "vip.126.com",
  "sina.com", "sina.cn", "sohu.com", "139.com", "189.cn", "21cn.com",
  "aliyun.com", "wo.cn", "chinaunicom.com", "189xy.com",
  // 国际
  "gmail.com", "googlemail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "windowslive.com",
  "icloud.com", "me.com", "mac.com",
  "yahoo.com", "yahoo.co.jp", "ymail.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "mail.com", "zoho.com",
  "yandex.com", "yandex.ru",
  "fastmail.com", "hey.com", "tutanota.com", "tuta.io",
])

/**
 * 这个 accountId 是不是一个「正常邮箱」。
 *
 * magpie 的 accountId 有两种形态（实测 plugin-auth.json）：
 *   真实邮箱账号   `1451895195@qq.com` / `1470292681@qq.com`
 *   临时邮箱/抓不到 `dkroe85ii62n` / `7fli52t2tc2b` / `189****051`
 * ⇒ 先要求有 `@`，再看后缀。
 */
export function isRealMailbox(siteId, accountId) {
  const s = String(accountId ?? "").trim().toLowerCase()
  const at = s.lastIndexOf("@")
  if (at <= 0 || at === s.length - 1) return false
  const domain = s.slice(at + 1)
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false
  const extra = readQuotaConfigFile(siteId)?.realMailDomains
  if (Array.isArray(extra) && extra.some((d) => String(d).trim().toLowerCase() === domain)) return true
  return REAL_MAIL_DOMAINS.has(domain)
}

/**
 * 这个账号够不够格当邀请上级。
 *
 * 默认就是 `isRealMailbox` —— 用户要的「真实邮箱」。多这一层是因为：
 *
 * **国内站根本没有邮箱登录**（实测：www.letsmagic.cn/login 只有微信 / 苹果 /
 * 密码 / 手机 / 私有部署；同一个发信请求 `/v4/user/send-email` 国内站回
 * `2000 服务异常`，国际站回 `1000 请求成功`）。国内站的 accountId 全是打码
 * 手机号（`189****051`），按邮箱白名单永远判假 ⇒ 国内站满了之后永远切不了。
 *
 * 所以给国内站留一个**显式开关**（默认关，不改变用户要的行为）：
 *
 *   ~/.cache/magpie/magicrew-invite-quota-config-magicrew.json
 *   { "allowPhoneAccounts": true }
 *
 * 打开后「打码手机号」也算合格 —— 只认 `189****051` 这种形态；随机串
 * （`dkroe85ii62n`）仍然不算，那是临时邮箱号或组织码兜底，不是稳定身份。
 */
export function isEligibleParent(siteId, accountId) {
  if (isRealMailbox(siteId, accountId)) return true
  if (!readQuotaConfigFile(siteId)?.allowPhoneAccounts) return false
  return /^\d{3}\*{4}\d{3,4}$/.test(String(accountId ?? "").trim())
}

// ═══ 落盘：配额配置 + 每账号缓存 + 切换日志 ═════════════════════════

function quotaConfigPath(siteId) {
  return join(cacheDir(), `magicrew-invite-quota-config-${siteId}.json`)
}

/** 用户可写的口径覆盖；没有就是 {}（读坏也当 {}，不能因为这个坏掉整条链路） */
export function readQuotaConfigFile(siteId) {
  try {
    const v = JSON.parse(readFileSync(quotaConfigPath(siteId), "utf8"))
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

/** 缓存多久算新鲜：额度变化慢，5 分钟够用，也不会把上游打疼 */
const CACHE_TTL_MS = 5 * 60_000

function quotaPath(siteId) {
  return join(cacheDir(), `magicrew-invite-quota-${siteId}.json`)
}

/** { [org]: { count, earned, code, at } } */
export function readQuotaCache(siteId) {
  try {
    const v = JSON.parse(readFileSync(quotaPath(siteId), "utf8"))
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

export function writeQuotaCache(siteId, org, entry) {
  const o = String(org || "").trim()
  if (!o) return
  try {
    const all = readQuotaCache(siteId)
    all[o] = { ...entry, at: new Date().toISOString() }
    // 别让它无限长：只留最近 200 个账号
    const keys = Object.keys(all)
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k]
    const f = quotaPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(all))
  } catch {}
}

/** 缓存里这条还新鲜吗 */
function fresh(entry, ttl = CACHE_TTL_MS) {
  if (!entry) return false
  const t = Date.parse(String(entry.at || ""))
  return Number.isFinite(t) && Date.now() - t < ttl
}

// ═══ 账号表：本站点所有登录着的号 ═════════════════════════════════════

/**
 * magpie 的 plugin-auth.json → 本站点的账号表。
 *
 * 同一个 org 可能出现多条（例如 `magicrew-intl` 与 `magicrew-intl#wx4jsu`
 * 都是 `dkroe85ii62n`）—— 按 org 去重，优先留**有 jwt** 的那条。
 *
 * @returns {Array<{org:string, accountId:string, jwt:string, home:string}>}
 */
export function accountsOf(siteId) {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
  } catch {
    return []
  }
  const byOrg = new Map()
  for (const [home, v] of Object.entries(raw || {})) {
    if (home !== siteId && !String(home).startsWith(siteId + "#")) continue
    const org = String(v?.org || "").trim()
    if (!org) continue
    const row = {
      org,
      accountId: String(v?.accountId || "").trim(),
      jwt: String(v?.jwt || ""),
      home: String(home),
    }
    const prev = byOrg.get(org)
    if (!prev || (!prev.jwt && row.jwt)) byOrg.set(org, row)
    else if (prev && !prev.accountId && row.accountId) byOrg.set(org, { ...prev, accountId: row.accountId })
  }
  return [...byOrg.values()]
}

// ═══ 查某个账号的邀请额度（带缓存）═══════════════════════════════════

/**
 * @param {{force?:boolean, ttl?:number}} opts
 * @returns {Promise<null | {org, accountId, code, count, earned, limit, left, full, display}>}
 */
export async function statusOf(c, org, { force = false, ttl = CACHE_TTL_MS } = {}) {
  const o = String(org || "").trim()
  if (!o) return null
  const cache = readQuotaCache(c.id)
  const cached = cache[o]
  if (!force && fresh(cached, ttl)) return shape(c, o, cached)

  const acct = accountsOf(c.id).find((a) => a.org === o)
  if (!acct?.jwt) {
    // 没有 jwt 就查不动；有旧缓存就用旧的（总比没有强）
    return cached ? shape(c, o, cached) : null
  }
  try {
    const st = await fetchInviteStatus(acct.jwt, o, c.host)
    writeQuotaCache(c.id, o, { count: st.count, earned: st.earned, code: st.code })
    return shape(c, o, { count: st.count, earned: st.earned, code: st.code, at: new Date().toISOString() })
  } catch (e) {
    if (process.env.MAGICREW_DEBUG) {
      console.error(`[magicrew] 邀请额度读取失败（${c.id}/${o}）：${e?.message ?? e}`)
    }
    return cached ? shape(c, o, cached) : null
  }
}

function shape(c, org, entry) {
  const acct = accountsOf(c.id).find((a) => a.org === org)
  const q = quotaOf(c.id, { count: entry?.count, earned: entry?.earned })
  return {
    org,
    accountId: acct?.accountId || "",
    code: String(entry?.code || ""),
    ...q,
  }
}

// ═══ 挑替补：真实邮箱 + 没满 + 剩余名额最多 ═══════════════════════════

/** 一次最多问几个候选的额度 —— 每个候选两个请求，账号很多时不能全打一遍 */
const MAX_CANDIDATES = 15

/**
 * 挑替补的**总预算**。
 *
 * 这个函数会被「登录成功后」await —— 而登录是用户站在那儿等的动作。
 * 15 个候选 × 2 个请求，网络一差就是好几分钟。所以给死线：到点就用手上
 * 已经查到的那些选，一个都没查到就返回 null（这一轮不切，下一轮再来）。
 * 缓存命中的候选不花预算（statusOf 直接返回）。
 */
const SUCCESSOR_BUDGET_MS = 20_000

/**
 * @returns {Promise<null | {org, accountId, code, count, earned, limit, left, full, display}>}
 */
export async function findInviteSuccessor(c, { excludeOrg = "", ttl = CACHE_TTL_MS, budgetMs = SUCCESSOR_BUDGET_MS } = {}) {
  const candidates = accountsOf(c.id)
    .filter((a) => a.org !== excludeOrg && isEligibleParent(c.id, a.accountId))
    .slice(0, MAX_CANDIDATES)
  if (!candidates.length) return null

  const deadline = Date.now() + budgetMs
  const rows = []
  for (const a of candidates) {
    if (Date.now() > deadline) break
    const st = await statusOf(c, a.org, { ttl })
    if (!st || st.full) continue
    rows.push(st)
  }
  if (!rows.length) return null
  // 剩余名额多的优先；一样多时用已邀请少的（也就是同一个数字，只是稳定排序）
  rows.sort((x, y) => y.left - x.left || x.count - y.count)
  return rows[0]
}

// ═══ 满了就换人 ═══════════════════════════════════════════════════════

/** 自动切换的频率上限：同一站点 10 分钟内最多查一次，别把签到 / 登录打爆 */
const SWITCH_THROTTLE_MS = 10 * 60_000

function switchLogPath(siteId) {
  return join(cacheDir(), `magicrew-invite-switch-${siteId}.log`)
}

function noteSwitch(siteId, msg) {
  try {
    const f = switchLogPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" })
  } catch {}
}

function throttlePath(siteId) {
  return join(cacheDir(), `magicrew-invite-switch-${siteId}.json`)
}

function readThrottle(siteId) {
  try {
    return JSON.parse(readFileSync(throttlePath(siteId), "utf8")) || {}
  } catch {
    return {}
  }
}

function writeThrottle(siteId, at) {
  try {
    const f = throttlePath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ at }))
  } catch {}
}

/**
 * 首选模式下，当前邀请上级满了 → 自动把上级换成「真实邮箱且没满」的账号。
 *
 * 为什么只动插件的邀请策略、不碰 magpie 账号页的 first：
 *   ① `first` 是 magpie 自己的内存 + logins.json，插件写文件也未必被重新读进内存
 *      （坑 13：插件对 magpie 目录只有读的份），改它等于踢一个不可控的缓存；
 *   ② 「首选模式」在这个包里本来就是指 `magicrew-invite-policy-<site>.json`
 *      的 `fixed`（登录页「邀请码」输入 1 的那个），换它的指向就是用户要的行为；
 *   ③ 不动 `first` 就不会顺手改变模型调用的路由账号 —— 那是另一件事。
 *
 * 触发点：签到（每天一次）与登录成功后。带 10 分钟节流，重复调用无副作用。
 *
 * @returns {Promise<{switched:boolean, reason:string, from?:object, to?:object}>}
 */
export async function enforceInviteSwitch(c, { force = false, now = Date.now() } = {}) {
  const pol = readInvitePolicy(c.id)
  if (pol.mode !== "fixed" || !pol.code) {
    return { switched: false, reason: "非首选模式，不动" }
  }

  const last = Number(readThrottle(c.id).at) || 0
  if (!force && now - last < SWITCH_THROTTLE_MS) {
    return { switched: false, reason: "10 分钟内查过，等下轮" }
  }
  writeThrottle(c.id, now)

  const current = await statusOf(c, pol.org, { force })
  if (!current) {
    return { switched: false, reason: "查不到当前邀请上级的额度（账号可能已删）" }
  }
  if (!current.full) {
    return { switched: false, reason: "当前上级还没满", quota: current }
  }

  const next = await findInviteSuccessor(c, { excludeOrg: pol.org })
  if (!next || !next.code) {
    noteSwitch(c.id, `上级 ${pol.accountId || pol.org} 已满（${current.display}），但没有「真实邮箱 + 未满」的替补`)
    return { switched: false, reason: "满额，但没有可用的真实邮箱替补", quota: current }
  }

  writeInvitePolicy(c.id, {
    mode: "fixed",
    code: next.code,
    org: next.org,
    accountId: next.accountId || next.org,
  })
  noteSwitch(
    c.id,
    `上级 ${pol.accountId || pol.org} 已满（${current.display}）→ 切到 ${next.accountId || next.org}（${next.display}）`,
  )
  return {
    switched: true,
    reason: `已满（${current.display}），切到 ${next.accountId || next.org}（${next.display}）`,
    from: current,
    to: next,
  }
}
