// 落盘 —— 这个插件自己需要记住的那几样东西
//
// 三份文件，各自一个用途，互不依赖：
//   模型快照   magicrew-models-<site>.json    未登录时卡片显示什么
//   邀请码     magicrew-invite-<site>.json    下一次注册带谁的码（滚动的）
//   登录态     magicrew-session-<site>.json   「自己的邀请码」要用它去换
//
// ⚠ 这不是「状态管理」，是缓存：删掉全部，插件照样能跑（只是要重新登录一次）。

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fetchOwnInviteCode, SITES } from "./api.mjs"

function cacheDir() {
  return join(homedir(), ".cache", "magpie")
}

// ═══ 模型：不写死，按账号实时拉 ═══════════════════════════════════════
//
// 权威来源只有一条：
//
//   GET <host>/api/v1/flows/models        （要网页 JWT + organization-code）
//     → { data: { models: [{ value, label, vision, tags, icon, configs }] } }
//
// 实测（2026-10-27）：国内 27 个、国际 49 个。两站列表**不一样**，而且会
// 随订阅档位和平台方开关变 —— 所以这个包里没有一张模型清单要维护。
//
// ⚠ 别改成读 /v1/models：那个国内 44、国际 65，混着 VIP 锁定、生图、
//   embedding，塞进 magpie 用户会选到根本调不动的模型。
//
// ⚠ 上下文窗口：flows/models 和 /v1/models **都不返回** context_length
//   （/v1/models 只有 id / object / created_at / owner_by）。所以一律按
//   256K 保守填 —— 填大了 agent 要等上游报错才知道越界，填小了自己压得早。
//
// 未登录时 config() 用**上次登录成功时落盘的快照**，没有快照就是空表。
// 空表让卡片显示 0 models，但那是诚实的：这会儿确实不知道账号能选什么。

/** 快照落在 magpie 自己的缓存目录，按站点分开 */
function snapshotPath(siteId) {
  return join(cacheDir(), `magicrew-models-${siteId}.json`)
}

function readSnapshot(siteId) {
  try {
    const v = JSON.parse(readFileSync(snapshotPath(siteId), "utf8"))
    return v && typeof v === "object" && Object.keys(v).length ? v : null
  } catch {
    return null
  }
}

function writeSnapshot(siteId, models) {
  try {
    const f = snapshotPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(models))
  } catch {}
}

// ═══ 邀请码：滚动的，就一条规则 ═══════════════════════════════════════
//
//   ① 固定位置有记录 → 用记录里那个
//   ② 没有记录     → 用作者码
//   ③ 登录成功后   → 查这个账号自己的邀请码 → 覆盖写回
//
// 固定位置：~/.cache/magpie/magicrew-invite-<siteId>.json    { code, at }
//
// 效果：第一次用作者的，之后每次都用「上一个登录成功的账号」的码，一路滚下去。
//
// ⚠ ③ 不是每次都能成。/api/v1/invitations/info 只认带 device_id 的 JWT ——
//   同一个账号、同一时刻签的两把，实测差别就在这一个字段：
//     桌面客户端  438 字符  cus.device_id = 64 位 hex  → 200 拿到 invite_code
//     网页版      350 字符  cus.device_id = ""         → 2155 用户不存在
//   密码登录走 API、会带 device 指纹，签出来的是前者，滚得动；
//   浏览器登录（剪贴板）拿到的就是网页那把，滚不动 —— 那就保留旧值，
//   不报错、不挡登录。
//
// 奖励口径（上游前端 constants，2026-10-27）：
//            每次注册   每次订阅   邀请注册封顶   总额封顶
//   国内      1,000      3,000       60,000      300,000
//   国际        200        500       10,000       30,000
//
// ⚠ 这个码只在「这台机器第一次注册」时用，也是「谁都没登录过」时的兜底。
//   它指向哪个号，决定了新用户第一笔邀请记在谁头上。
//
// 2026-10-30 换过一轮（两站各推一个新的、0 邀请的全新号）：
//
//     国内  IVC8BAWYXRY1（189****051）          →  IV18D8KHVZ7T（181****632）
//     国际  IV75F0ZKVKXG（1451895195@qq.com）   →  IV486F5O59SC（mycf711@foxmail.com）
//
//   新码当场用上游 `/api/v1/invitations/info` 核对过（invite_code + invite_count 都是 0）。
//
// ⚠ 别再说「那个号满了」—— 这是 0.3.64 之前的一个错误说法，实测已推翻：
//   上游**没有人数上限**（接口无 limit 字段，54 人仍在正常结算奖励），唯一的硬上限是
//   邀请积分封顶（国际 10,000 / 国内 60,000）。国际那个旧号只结算了 2,000 / 10,000 分。
//   ⇒ 「别人用了没送分」通常不是号满了，而是**被邀请人没完成首个任务/对话**（不发分）。
//   详见 src/invite-quota.mjs 的 quotaOf 头。
const AUTHOR_INVITE = {
  magicrew: "IV18D8KHVZ7T",
  "magicrew-intl": "IV486F5O59SC",
}

function invitePath(siteId) {
  return join(cacheDir(), `magicrew-invite-${siteId}.json`)
}

/** 固定位置里存的邀请码；没有就是空串 */
function readInvite(siteId) {
  try {
    const v = JSON.parse(readFileSync(invitePath(siteId), "utf8"))
    return typeof v?.code === "string" ? v.code.trim() : ""
  } catch {
    return ""
  }
}

/** 覆盖写 —— 拿到新的就盖掉旧的 */
function writeInvite(siteId, code) {
  const c = String(code || "").trim()
  if (!c) return ""
  try {
    const f = invitePath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ code: c, at: new Date().toISOString() }))
  } catch {}
  return c
}

/**
 * 「最近一个注册成功的号」自己的邀请码 —— 自动模式唯一认的那个。
 *
 * 和滚动码（`magicrew-invite-<site>.json`，登录 / 签到都会刷）**分开存**：
 * 滚动码只做兜底，永远不许覆盖这个文件。为什么（主人 2026-10-30 的要求）：
 * 原来自动模式跟「最后一个登录 / 签到的号」，于是重登一个旧号、或者签到轮到一个
 * 旧号，下一次注册就挂到旧号名下了 —— 那个号可能早就满额，新号白送。
 * 要的是「每新注册一个号，下一个号就挂它」，所以只有注册成功那一刻才写这里。
 */
function registeredInvitePath(siteId) {
  return join(cacheDir(), `magicrew-invite-registered-${siteId}.json`)
}

/** @returns {null | {code:string, org:string, at:string}} */
export function readRegisteredInvite(siteId) {
  try {
    const v = JSON.parse(readFileSync(registeredInvitePath(siteId), "utf8"))
    const code = typeof v?.code === "string" ? v.code.trim() : ""
    if (!code) return null
    return { code, org: String(v?.org || "").trim(), at: String(v?.at || "") }
  } catch {
    return null
  }
}

/**
 * 只在「注册成功」那一刻调用（`src/hooks/methods.mjs` 的 `afterSignIn`）。
 * 普通登录 / 签到只更新滚动码，**不许调这个**。
 */
export function noteRegisteredInvite(siteId, { code, org } = {}) {
  const c = String(code || "").trim()
  if (!c) return null
  const entry = { code: c, org: String(org || "").trim(), at: new Date().toISOString() }
  try {
    mkdirSync(dirname(registeredInvitePath(siteId)), { recursive: true })
    writeFileSync(registeredInvitePath(siteId), JSON.stringify(entry))
  } catch {}
  return entry
}

/**
 * 这次登录该带的邀请码 **以及它挂在谁名下**。
 *
 * 登录页那句「本次邀请上级：…」必须和实际用的码同源 —— 两边各写一份判断，
 * 早晚会出现「文案说 A、实际用 B」。所以只有这一个函数做决定，
 * `inviteToUse()` 就是它的 `.code`，`inviteNote()` 拿 `source` / `org` 去拼文案。
 *
 * `source` 取值：
 *   preferred  开关开，挂 magpie 账号页「首选」那个号
 *   switched   开关开，首选满额后自动换过来的落点
 *   registered 自动，跟「最后一个注册成功的新号」
 *   rolling    自动，回落滚动码（最后一次登录 / 签到刷到的）
 *   author     都没有 → 作者自己的码
 *
 * @returns {{code:string, source:"preferred"|"switched"|"registered"|"rolling"|"author", org:string}}
 */
export function resolveInvite(siteId) {
  const none = { code: AUTHOR_INVITE[siteId] || "", source: "author", org: "" }
  const live = liveOrgs(siteId)
  // 账号文件读不到 / 一个号都没有时按「不校验」处理，行为与以前一致
  const known = live !== null && live.size > 0

  if (inviteFirstOn(siteId)) {
    const pol = readInvitePolicy(siteId)
    // ① 满额自动换过来的落点（enforceInviteSwitch 写的 auto:true）—— 它优先，
    //    否则每次都会退回「首选账号」那个已经满了的号。
    if (pol.mode === "fixed" && pol.auto === true && pol.code) {
      if (!(known && pol.org && !live.has(pol.org))) return { code: pol.code, source: "switched", org: pol.org || "" }
    }
    // ② 首选账号自己的码（每次现算：用户可能在 magpie 账号页换过首选）
    const pick = preferredInviteOf(siteId)
    if (pick && !(known && pick.org && !live.has(pick.org))) return { code: pick.code, source: "preferred", org: pick.org }
  }

  // 自动模式：先认「最后一个注册成功的新号」。它比滚动码优先 —— 滚动码每次登录 /
  // 签到都会刷新，拿它当第一个判据就退回「跟随最后一个登录 / 签到」的老行为了。
  const registered = readRegisteredInvite(siteId)
  if (registered?.code) {
    // 那个号被删了（不在 plugin-auth）→ 这个记录作废，往下回落
    if (!known || !registered.org || live.has(registered.org)) {
      return { code: registered.code, source: "registered", org: registered.org || "" }
    }
  }

  const rolling = readInvite(siteId)
  if (rolling) {
    if (!known) return { code: rolling, source: "rolling", org: "" }
    // 滚动码也可能属于已删除的账号：按码反查归属，归属没了就换作者码兜底
    const codes = readAccountCodes(siteId)
    const owner = Object.keys(codes).find((o) => codes[o]?.code === rolling) || ""
    if (!owner || live.has(owner)) return { code: rolling, source: "rolling", org: owner }
  }
  return none
}

/** 这次登录该带的邀请码：开关 → 策略 → 最后注册的新号 → 滚动码 → 作者码 */
function inviteToUse(siteId) {
  return resolveInvite(siteId).code
}

/**
 * org → 卡片上那个账号名（plugin-auth.json 的 `accountId`）。
 *
 * 拿不到就退回 codes 缓存里的 `accountId`，再不行用 org 自己（调用方负责打码）。
 * 只读，不写任何东西。
 */
export function accountNameOf(siteId, org) {
  const o = String(org || "").trim()
  if (!o) return ""
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
    for (const [k, v] of Object.entries(raw || {})) {
      if (k !== siteId && !String(k).startsWith(siteId + "#")) continue
      if (String(v?.org || "").trim() !== o) continue
      const id = String(v?.accountId || "").trim()
      if (id) return id
    }
  } catch {}
  return String(readAccountCodes(siteId)[o]?.accountId || "").trim() || o
}

/**
 * magpie 账号文件里这个站点还登录着的 org（只读 plugin-auth.json）。
 * 返回 null 表示读不到 —— 调用方应按「不校验」处理，而不是当空集。
 */
export function liveOrgs(siteId) {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
    const out = new Set()
    for (const [k, v] of Object.entries(raw || {})) {
      if (k === siteId || k.startsWith(siteId + "#")) {
        const org = String(v?.org || "").trim()
        if (org) out.add(org)
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * magpie 账号页上「首选」那个账号的 org（只读 logins.json）。
 *
 * magpie 把首选存在 logins.json 的 first 字段（Make first / 拖到第一行会写），
 * 账号行里的 home 是 plugin-auth.json 的 key，借它换回 org。
 */
export function preferredOrg(siteId) {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "logins.json"), "utf8"))
    const agent = "plugin:" + siteId
    const rows = (Array.isArray(raw) ? raw : []).filter((l) => l && l.agent === agent && l.home)
    if (!rows.length) return ""
    const first =
      rows.find((l) => l.first === true) ||
      rows.filter((l) => Number(l.order) > 0).sort((a, b) => Number(a.order) - Number(b.order))[0] ||
      rows[0]
    const home = String(first?.home || "").trim()
    if (!home) return ""
    const auth = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
    return String(auth?.[home]?.org || "").trim()
  } catch {
    return ""
  }
}

/** 作者自己的码（「我的」那一项） */
export function authorInvite(siteId) {
  return AUTHOR_INVITE[siteId] || ""
}

// ═══ 邀请上级：双模式，由一个 magpie 开关决定 ═════════════════════════
//
// 只有两种模式（**没有第三种**）：
//
//   开关关（默认）  自动 —— 跟随「最后一个注册成功的新号」自己的码
//                            （2026-10-30 起；之前是「最后一个登录 / 签到的号」——
//                             重登旧号 / 签到旧号会把码换回去，不对）
//   开关开          首选 —— 挂到 magpie 账号页「首选」那个账号
//
// ⚠ 「列一个账号下拉框让人选」在当前 magpie 上**做不到**：
//   magpie 的插件选项值只存布尔（`settings.PluginOptions map[string]map[string]bool`，
//   internal_settings_settings.go:276-279；设置接口 POST /api/settings/plugin-option
//   的入参也只有 `{Provider, Key, On bool}`，internal_gui_api.go:1945-1962）。
//   想按账号选，要么给每个账号生成一个开关（账号一变就得重载插件，且一排开关比下拉框更难用），
//   要么等 magpie 本体给 options 加枚举类型。详见 README「邀请码」一节。
//
// 开关本身不是这个文件画的：它是 magpie 的 `auth.options`（供应商编辑器里的
// 那个 Off/On 开关，和 workbuddy 的「Free models only」同一套机制）。插件通过
// `input.magpie.option(provider, key)` 读 —— **每次读都是当前值**，用户拨一下
// 立刻生效，不用重启插件 host。
//
// ⇒ 所以这里不缓存布尔值，只存「怎么读」：`setInviteOptionReader(siteId, fn)`。
//
// 为什么不做三模式（自动 / 首选 / 指定）：
//   开关是布尔，magpie 只认 `=== true`（providers.go:170-187、契约 optionValue）。
//   「指定」要带一个字符串，开关装不下 —— 想做它就得回到登录页那个 0/1 文本框，
//   那正是这次要拆掉的东西。
//
// 策略文件 `magicrew-invite-policy-<site>.json` 的定位跟着变了：
//   · 原来是「用户选的模式」（auto / fixed / custom）
//   · 现在只记**首选模式下满额自动换过来的落点**（`{mode:"fixed", auto:true}`）
//     模式本身由开关决定，文件不再表达「模式」。

const optionReaders = new Map()

/**
 * 把「怎么读这个站点的开关」交给 store。
 *
 * @param {string} siteId provider id（`magicrew` / `magicrew-intl`）
 * @param {(key:string)=>boolean} read 读一个 key 的当前值
 */
export function setInviteOptionReader(siteId, read) {
  if (typeof read === "function") optionReaders.set(siteId, read)
}

/** 开关 key —— 与 index.mjs 声明 auth.options 时用的那个必须是同一个 */
export const INVITE_FIRST_OPTION = "invite-first"

/**
 * 「邀请码挂到首选账号」这个开关现在是开的吗。
 *
 * 读不到（没注册 reader / magpie 老版本没有 option / 抛错）一律当**关** ——
 * 关 = 自动，也就是升级上来的老用户保持原来的行为，不会被静默改道。
 */
export function inviteFirstOn(siteId) {
  const read = optionReaders.get(siteId)
  if (!read) return false
  try {
    return read(INVITE_FIRST_OPTION) === true
  } catch {
    return false
  }
}

/**
 * magpie 账号页「首选」那个账号自己的邀请码。
 *
 * 码来自 `magicrew-invite-codes-<site>.json`（每次登录 / 签到顺手记下的），
 * 所以这里不发网络请求 —— prompts 是同步生成的，等不了 API。
 */
export function preferredInviteOf(siteId) {
  const org = preferredOrg(siteId)
  if (!org) return null
  const v = readAccountCodes(siteId)[org]
  if (!v?.code) return null
  return {
    code: String(v.code),
    org,
    accountId: String(v.accountId || org),
  }
}

function invitePolicyPath(siteId) {
  return join(cacheDir(), `magicrew-invite-policy-${siteId}.json`)
}

export function readInvitePolicy(siteId) {
  try {
    const v = JSON.parse(readFileSync(invitePolicyPath(siteId), "utf8"))
    const mode = v?.mode === "fixed" ? "fixed" : "auto"
    const org = String(v?.org || "").trim()
    return {
      mode,
      code: String(v?.code || "").trim(),
      // 旧版把作者码存成 org:"author"；作者不是账号，按「无 org」处理
      org: org === "author" ? "" : org,
      accountId: String(v?.accountId || "").trim(),
      // true = 这条 fixed 是满额自动换过来的，不是用户选的
      auto: v?.auto === true,
      at: String(v?.at || ""),
    }
  } catch {
    return { mode: "auto", code: "", org: "", accountId: "", auto: false, at: "" }
  }
}

export function writeInvitePolicy(siteId, policy) {
  try {
    const f = invitePolicyPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    const mode = policy?.mode === "fixed" ? "fixed" : "auto"
    writeFileSync(
      f,
      JSON.stringify({
        mode,
        code: String(policy?.code || "").trim(),
        org: String(policy?.org || "").trim() === "author" ? "" : String(policy?.org || "").trim(),
        accountId: String(policy?.accountId || "").trim(),
        auto: policy?.auto === true,
        at: new Date().toISOString(),
      }),
    )
  } catch {}
}

/** 清掉策略 —— 下次就退回「读开关 + 现算首选」 */
export function clearInvitePolicy(siteId) {
  try {
    unlinkSync(invitePolicyPath(siteId))
  } catch {}
}

// ═══ 见过哪些账号的码 ═══════════════════════════════════════════════
//
// `rollInvite` 每天签到会给**每个**账号跑一次，顺手把它的码记下来 ——
// 于是登录时那个「挂在谁名下」的下拉框不用发网络请求就能填满。
// （prompts 的 options 是同步生成的，等不了 API。）

function inviteCodesPath(siteId) {
  return join(cacheDir(), `magicrew-invite-codes-${siteId}.json`)
}

export function readAccountCodes(siteId) {
  try {
    const v = JSON.parse(readFileSync(inviteCodesPath(siteId), "utf8"))
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

export function noteAccountCode(siteId, org, code, accountId) {
  const o = String(org || "").trim()
  const cd = String(code || "").trim()
  if (!o || !cd) return
  try {
    const all = readAccountCodes(siteId)
    all[o] = { code: cd, accountId: String(accountId || ""), at: new Date().toISOString() }
    const f = inviteCodesPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(all))
  } catch {}
}


/**
 * 给页面补账号码：plugin-auth 里的每个账号（有 JWT 的）问一次自己的邀请码。
 *
 * 为什么需要：页面清单只缓存 `rollInvite` 走过的账号；老用户升级上来时
 * `magicrew-invite-codes-<site>.json` 可能一条都没有，页面就是空的。
 * 这里在 config 之后延迟跑一次，只补缺口；失败静默，下次签到仍会补。
 */
let backfillPromise = null
export function backfillInviteCodes() {
  if (backfillPromise) return backfillPromise
  backfillPromise = (async () => {
    try {
      const raw = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
      for (const siteId of ["magicrew", "magicrew-intl"]) {
        const host = siteId === "magicrew-intl" ? SITES.intl.host : SITES.cn.host
        const have = readAccountCodes(siteId)
        for (const [k, v] of Object.entries(raw || {})) {
          if (k !== siteId && !String(k).startsWith(siteId + "#")) continue
          const org = String(v?.org || "").trim()
          if (!org || have[org]?.code) continue
          const jwt = String(v?.jwt || "")
          if (!jwt) continue
          try {
            const own = await fetchOwnInviteCode(jwt, org, host)
            if (own?.code) noteAccountCode(siteId, org, own.code, v.accountId)
          } catch {}
        }
      }
    } catch {}
    finally {
      backfillPromise = null
    }
  })()
  return backfillPromise
}

/** 滚动请求最多等这么久 —— 登录流程不能被它拖死 */
const INVITE_TIMEOUT_MS = 6000

/**
 * 登录成功后把账号自己的邀请码滚上去；失败不挡登录。
 *
 * ⚠ 这个函数曾经**完全没有 import `fetchOwnInviteCode`**（0.3.7 及更早版本）。
 *   于是每次调用都在调它的那一行抛 ReferenceError，又被下面的空 catch 静默吞掉 ——
 *   「滚动邀请码」这个功能从上线起一次都没成功过：
 *   magicrew-invite-<site>.json 永远不存在，每次注册都退回作者码，
 *   等于每个新号都在给作者送 200 分（国内站 1,000 分）。
 *   留痕留在 MAGICREW_DEBUG 下，就是为了不再重演这种「静默停摆」。
 */
async function rollInvite(siteId, jwt, org, host) {
  try {
    const own = await Promise.race([
      fetchOwnInviteCode(jwt, org, host),
      new Promise((_, reject) => setTimeout(() => reject(new Error("超时")), INVITE_TIMEOUT_MS)),
    ])
    const code = writeInvite(siteId, own.code)
    // 顺手记下「哪个账号的码是多少」—— 登录时的下拉框靠它填，不用发请求
    noteAccountCode(siteId, org, code)
    return code
  } catch (e) {
    if (process.env.MAGICREW_DEBUG) {
      console.error(`[magicrew] 滚动邀请码失败（${siteId}）：${e?.message ?? e}`)
    }
    return ""
  }
}

/** 上次登录成功时落盘的 { jwt, org }，只给「自己的邀请码」用 */
function sessionPath(siteId) {
  return join(cacheDir(), `magicrew-session-${siteId}.json`)
}

function readSession(siteId) {
  try {
    const v = JSON.parse(readFileSync(sessionPath(siteId), "utf8"))
    return v?.jwt ? v : null
  } catch {
    return null
  }
}

/** 登录链路的失败原因落盘，排障用；不影响任何正常流程 */
function loginLogPath(siteId) {
  return join(cacheDir(), `magicrew-login-${siteId}.log`)
}

function noteLoginFailure(siteId, msg) {
  try {
    const f = loginLogPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, `[${new Date().toISOString()}] ${msg}
`, { flag: "a" })
  } catch {}
}

function writeSession(siteId, jwt, org) {
  try {
    const f = sessionPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ jwt, org }))
  } catch {}
}

// ═══ 加过哪些账号（只记 org）═══════════════════════════════════════════
//
// 唯一的用途：决定「本机浏览器里读到的登录态要不要自动接上」。
//
// 用户点「登录」多数是想加**新**账号；如果本机浏览器里那把属于已经加过的账号，
// 自动接上只会得到「同一个账号」（magpie 侧同 accountId+uid → 替换，不新增），
// 看起来又像「登录了却没加账号」。所以已经在名单里的 org，一律改走窗口登录。
//
// 记不上也无所谓：最坏是自动接上一个重复账号，magpie 会替换它。

function orgsPath(siteId) {
  return join(cacheDir(), `magicrew-orgs-${siteId}.json`)
}

function readKnownOrgs(siteId) {
  try {
    const v = JSON.parse(readFileSync(orgsPath(siteId), "utf8"))
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []
  } catch {
    return []
  }
}

function noteOrg(siteId, org) {
  if (!org || typeof org !== "string") return
  try {
    const list = readKnownOrgs(siteId)
    if (list.includes(org)) return
    list.push(org)
    const f = orgsPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(list.slice(-50)))
  } catch {}
}

// ═══ 「首次 AI 工作 / 首个对话」的一次性标记 ═════════════════════════
//
// 这件事对每个账号**只该做一次**。目的只有一个：满足服务端
// 「被邀请人完成首个任务或对话后，邀请人才能拿到积分」那条判定。
// 邀请奖励只发一次，所以补一次就够，再发纯属白烧积分。
//
// 早前的闸门写错了 —— 按「今天发过没有」记日期，于是：
//
//   ① 服务端结算慢（几十秒到几分钟）、或者任务状态压根不翻 COMPLETED 时，
//      第二天签到又看到 PENDING，再发一条。一个号天天烧钱。
//   ② 只按「有没有项目」判：项目建了但消息没发出去，会被当成「已用过」
//      而永远不补；反过来项目没建成，每次进来都重试。
//
// 现在的规则：
//   · 发送成功 → 写 `status: "sent"`，**此后再也不发**（换天、重登、重启都一样）
//   · 真去发了但失败 → 记 attempts，最多 MAX_AUTOCHAT_ATTEMPTS 次，到顶写
//     `gave-up` 也不再发（别让一个永远失败的号每次签到都撞一遍）
//   · 「还没有工作台/项目」不算失败 —— 那是账号没就绪，不计数，下次再来
//   · 老文件里的 `"YYYY-MM-DD"` 字符串按「已发过」读，升级后不会重发
//
// 文件：~/.cache/magpie/magicrew-autochat-<siteId>.json
//   { [org]: { at: "ISO", status: "sent" | "failed" | "gave-up", attempts: n, reason?: "…" } }

const MAX_AUTOCHAT_ATTEMPTS = 3

function autochatPath(siteId) {
  return join(cacheDir(), `magicrew-autochat-${siteId}.json`)
}

/**
 * 读整张表。老格式（值为 `"YYYY-MM-DD"` 字符串）归一成 `{ at, status: "sent" }`,
 * 这样升级后的第一次读就把历史账号认成「已经补过」。
 */
export function readAutoChat(siteId) {
  try {
    const v = JSON.parse(readFileSync(autochatPath(siteId), "utf8"))
    if (!v || typeof v !== "object") return {}
    const out = {}
    for (const [org, e] of Object.entries(v)) {
      if (typeof e === "string") out[org] = { at: e, status: "sent", attempts: 1, legacy: true }
      else if (e && typeof e === "object") out[org] = e
    }
    return out
  } catch {
    return {}
  }
}

/** 这个账号的那一笔，没有就 null */
export function readAutoChatEntry(siteId, org) {
  return readAutoChat(siteId)[org] ?? null
}

/** 已经补过（或已放弃）→ 一次都不再发。换天也不会。 */
export function isAutoChatSettled(siteId, org) {
  const e = readAutoChatEntry(siteId, org)
  return !!e && (e.status === "sent" || e.status === "gave-up")
}

function writeAutoChat(siteId, org, entry) {
  try {
    const m = readAutoChat(siteId)
    m[org] = entry
    // 只留最近 200 个账号，文件别无限涨
    const keys = Object.keys(m)
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete m[k]
    const f = autochatPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(m))
  } catch {}
}

/** 消息确实发出去了 —— 从此这个账号不再补。只在**发送成功**后调用。 */
export function noteAutoChat(siteId, org, extra = {}) {
  const prev = readAutoChatEntry(siteId, org)
  writeAutoChat(siteId, org, {
    at: new Date().toISOString(),
    status: "sent",
    attempts: (Number(prev?.attempts) || 0) + 1,
    ...extra,
  })
}

/**
 * 真去发了但没成 —— 记一次尝试，留给下一次。
 *
 * @returns {{attempts:number, givenUp:boolean}}
 */
export function noteAutoChatFailure(siteId, org, reason) {
  const prev = readAutoChatEntry(siteId, org)
  const attempts = (Number(prev?.attempts) || 0) + 1
  const givenUp = attempts >= MAX_AUTOCHAT_ATTEMPTS
  writeAutoChat(siteId, org, {
    at: new Date().toISOString(),
    status: givenUp ? "gave-up" : "failed",
    attempts,
    reason: String(reason ?? "").slice(0, 200),
  })
  return { attempts, givenUp }
}

export { MAX_AUTOCHAT_ATTEMPTS }

export {
  AUTHOR_INVITE,
  cacheDir,
  rollInvite,
  invitePath,
  inviteToUse,
  loginLogPath,
  noteLoginFailure,
  noteOrg,
  orgsPath,
  readInvite,
  readKnownOrgs,
  readSession,
  readSnapshot,
  sessionPath,
  snapshotPath,
  writeInvite,
  writeSession,
  writeSnapshot,
}
