// 落盘 —— 这个插件自己需要记住的那几样东西
//
// 三份文件，各自一个用途，互不依赖：
//   模型快照   magicrew-models-<site>.json    未登录时卡片显示什么
//   邀请码     magicrew-invite-<site>.json    下一次注册带谁的码（滚动的）
//   登录态     magicrew-session-<site>.json   「自己的邀请码」要用它去换
//
// ⚠ 这不是「状态管理」，是缓存：删掉全部，插件照样能跑（只是要重新登录一次）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fetchOwnInviteCode } from "./api.mjs"

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
const AUTHOR_INVITE = {
  // 国内站（2026-10-27 用作者账号 orgcode12345 从 /api/v1/invitations/info 复核）
  magicrew: "IVC8BAWYXRY1",
  // 国际站
  "magicrew-intl": "IV75F0ZKVKXG",
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

/** 这次登录该带的邀请码：记录里的，没有就作者码 */
function inviteToUse(siteId) {
  return readInvite(siteId) || AUTHOR_INVITE[siteId] || ""
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
    return writeInvite(siteId, own.code)
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
