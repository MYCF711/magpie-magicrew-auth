// 无头登录的编排：一条纯 HTTP 的链路，不开浏览器
//
//   取图 → 识图判角度 → 过验证 → 发验证码 → （用户填码）→ 换登录态 → 拿组织码
//
// **手机号和邮箱走同一条编排** —— 协议、风控、识图全一样，只有「标识字段」
// 和「发码 / 登录两个端点」不同，那些差异全在 captcha.mjs 里按 identFields 分派。
//
// 每一步都实测过（协议逐字段记在 src/captcha.mjs 头部；两站实测记录见
// CHANGELOG 0.3.17「手机号验证码」与 0.3.28「邮箱验证码 + 已有账号免图」）：
//   · 取图/过验证在 keewood 用户中心，纯 JSON，不需要 cookie 或指纹
//   · 角度必须「一次算准」：同一 token 试错次数有限，且高频会被拦
//   · 识图模型是用户在 magpie 里选的那个（settings.json 的 vision）
//
// ⚠ 没有识图模型时**不在这里瞎猜** —— 猜中的概率只有 ~5.6%（容差 ±10°），
//   平均要试十几次，先撞上的会是「验证提交过于频繁」。那种情况走浏览器回退
//   （见 hooks/methods.mjs 的 another method），让用户自己转那一下。

import {
  extractCreds,
  generateCaptcha,
  identKind,
  keewoodOf,
  loginByCode,
  sendCode,
  verifyCaptcha,
} from "./captcha.mjs"
import { decideDegFromImage, readVisionModel } from "./vision.mjs"

/** 一次登录最多换几张图；每张图只提交一次（风控不允许反复试同一个 token） */
const MAX_CAPTCHA_ROUNDS = 4
/** 两次提交之间歇一下，避开「验证提交过于频繁」 */
const ROUND_GAP_MS = 2500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 过掉旋转验证，拿到 business_token。
 *
 * 手机和邮箱共用：只有传给服务端的「标识字段」不同（`{mobile, stateCode}` / `{email}`）。
 *
 * @param {object} site  站点对象（要有 id / web）
 * @param {{mobile?:string, stateCode?:string, email?:string}} ident
 * @param {object|null} firstCap 已经取到的那张图（调用方为了让「已注册免图」
 *   这条短路先跑，会自己先调一次 generateCaptcha）—— 传进来就省一次取图
 * @returns {Promise<{businessToken:string, rounds:number, log:string[]}>}
 */
export async function passCaptcha(site, ident = {}, firstCap = null) {
  const log = []
  let lastReason = ""

  for (let round = 1; round <= MAX_CAPTCHA_ROUNDS; round++) {
    const cap = round === 1 && firstCap ? firstCap : await generateCaptcha(site, ident)
    // 已注册的号，服务端直接给 business_token，连图都不用看
    if (cap.registered) {
      log.push(`第 ${round} 轮：服务端直接放行（该号已注册）`)
      return { businessToken: cap.businessToken, rounds: round, log }
    }

    const decided = await decideDegFromImage(cap.image)
    if (!decided.ok) {
      // 判不出来 / 两个判官对着干 → 换一张图，不要浪费一次提交
      lastReason = `${decided.reason}${decided.detail ? `：${decided.detail}` : ""}`
      log.push(`第 ${round} 轮：判角度不可信（${lastReason}），换图`)
      if (round < MAX_CAPTCHA_ROUNDS) await sleep(500)
      continue
    }

    const res = await verifyCaptcha(site, { token: cap.token, deg: decided.deg, ...ident })
    if (res.ok) {
      log.push(`第 ${round} 轮：deg=${decided.deg}（钟点 ${decided.clock?.toFixed?.(2) ?? "?"}，分歧 ${decided.spread?.toFixed?.(1) ?? 0}）→ 通过`)
      return { businessToken: res.businessToken, rounds: round, log }
    }

    lastReason = res.message
    log.push(`第 ${round} 轮：deg=${decided.deg} 没通过（${res.message}）`)
    if (round < MAX_CAPTCHA_ROUNDS) await sleep(ROUND_GAP_MS)
  }

  throw Object.assign(
    new Error(`旋转验证连试 ${MAX_CAPTCHA_ROUNDS} 张图都没过（最后一次：${lastReason}）`),
    { captchaLog: log },
  )
}

/**
 * 第 1 步：发验证码（短信 / 邮件）。成功即代表「验证已经过了」——服务端把 business_token 当门票。
 *
 * ⚠ **顺序很重要：先取图，再决定要不要识图模型。**
 *
 *   服务端对**已注册**的号根本不要求过旋转验证 —— `POST /captcha/generate` 直接回
 *   `business_token`，连图都不给（实测：2026-10-29，已注册邮箱 `…@qq.com` → 免图；
 *   同一个接口换一个没注册过的邮箱 → 给了 token+image）。
 *
 *   所以「加一个我自己已有的账号」这条最常见的路，**根本不需要识图模型**。
 *   早先把 `readVisionModel()` 的判断放在取图**之前**，等于让没配识图模型的人
 *   连自己已有的账号都加不进来 —— 那是白拦。现在只有确实要给新号过图时才要求它。
 *
 * @throws 需要过图但没配识图模型时，抛带 `code: "no-vision-model"` 的错误，
 *         让调用方去回退浏览器（而不是在这里瞎猜角度）
 */
export async function startCodeLogin(site, ident = {}) {
  const kind = identKind(ident)
  const what = kind === "email" ? "邮件" : "短信"

  // ① 先探一次。这一步是纯 JSON、不需要模型，也**不会真的发码**。
  const first = await generateCaptcha(site, ident)

  let businessToken
  let rounds
  let log

  if (first.registered) {
    // ⚡ 已注册 → 免图直接发码。识图模型在这条路上完全用不到。
    businessToken = first.businessToken
    rounds = 0
    log = ["服务端认为该号已注册 → 免旋转验证"]
  } else {
    // ② 新号必须过图：这时才需要识图模型
    if (!readVisionModel()) {
      throw Object.assign(new Error("这个号还没注册，注册要过旋转验证，而你没配识图模型"), {
        code: "no-vision-model",
      })
    }
    const r = await passCaptcha(site, ident, first)
    businessToken = r.businessToken
    rounds = r.rounds
    log = r.log
  }

  const sent = await sendCode(site, ident, { businessToken })
  if (!sent.ok) {
    throw Object.assign(new Error(`发${what}失败：${sent.message}`), { captchaLog: log })
  }
  return { businessToken, rounds, log, skippedCaptcha: Boolean(first.registered) }
}

/** 旧签名兼容：手机号发短信 */
export async function startSmsLogin(site, { mobile, stateCode = "+86" } = {}) {
  return startCodeLogin(site, { mobile, stateCode })
}

/**
 * 第 2 步：验证码换登录态，并补齐组织码。
 *
 * ⚠ 登录响应里 jwt / 组织码的**确切形状没实测过**（手上没有能收短信/收信的号，
 *   只能验到 2168「验证码错误」——手机和邮箱都一样）。所以：
 *     · jwt 用 extractCreds 从响应里按特征找（以 eyJ 开头的三段式）
 *     · 组织码找不着就调 `/api/v1/aggregation/login-data`（带 authorization 头，
 *       服务端会回这个账号所在的组织列表）—— 这条路径是文档里查得到的
 */
export async function finishCodeLogin(site, { code, device, redirect, inviteCode = "", ...ident } = {}) {
  const { json, status, text } = await loginByCode(site, { code, device, redirect, ...ident })
  if (!json) {
    throw new Error(`登录接口回了非 JSON（HTTP ${status}）：${String(text).slice(0, 200)}`)
  }
  if (json.code !== 1000) {
    // 2168（手机 / 邮箱都是它）= 验证码错；2167 = 短信验证码无效或已过期；
    // 其余原样透出，别把它吞成「登录失败」
    throw Object.assign(new Error(`登录失败：${json.message ?? json.code}`), {
      code: json.code,
      raw: json,
    })
  }

  const { jwt, org } = extractLoginCreds(json)
  if (!jwt) {
    throw Object.assign(
      new Error(`登录成功但响应里没找到可用令牌。响应结构：${describeShape(json)}`),
      { raw: json },
    )
  }
  // 响应里给了组织码就用它；没给就把该账号的组织**全列出来**，
  // 由调用方逐个拿 fetchPoints 验（见 methods.mjs 的 completeSignIn）。
  let orgs = org ? [org] : await fetchOrgs(site, jwt)
  let createdOrg = ""

  // 一个组织都没有 = 这个号在用户中心已经登录，但 Magic 里还没建用户。
  // 上游前端的正解不是报错，是**建第一个组织**（邀请码就在这一步消费）——
  // 见下面 createFirstOrganization 头上的注释。少了这一步，新号永远
  // 停在「登录成功但拿不到组织码」。
  //
  // ⚠ 只认 `auth/status` 回的 **3102**（用户尚未创建账号）才建：
  //   别的失败（3103 token 过期、网络抖动、账号有组织但探测失败）绝不能
  //   顺手建一个新组织 —— 那会给已有账号多建一个组织。
  const notCreated = orgProbeCodes().some((x) => x.code === 3102)
  if (!orgs.length && notCreated) {
    const made = await createFirstOrganization(site, jwt, inviteCode)
    createdOrg = made.org
    if (made.org) {
      // 建完还要用 auth/status + Organization-Code 绑一次，拿到 magic 侧真正的组织码。
      // 建组织返回的那个也留在候选里：万一绑定接口抽风，completeSignIn 还能拿它试一次。
      const bound = await bindOrganization(site, jwt, made.org)
      orgs = bound.length ? [...new Set([...bound, made.org])] : [made.org]
      lastOrgProbeErrors.push(`建首个组织：${made.via} → ${made.org}`)
    } else {
      // 实测（2026-10-29 用户重试）：建组织接口可能回 `{code:1000, message:"请求成功", data:[]}`
      // —— 1000 但没有组织码。组织这时**可能已经建好了**，只是响应里不带码。
      // 上游前端也容得下这种形状：它拿到 undefined 也照样去 auth/status 拉一遍。
      // 所以这里像前端一样，直接重新探测组织列表（给一点最终一致性时间）。
      for (const wait of [0, 1200, 3000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait))
        const found = await fetchOrgs(site, jwt)
        if (found.length) {
          orgs = found
          break
        }
      }
      lastOrgProbeErrors.push(`建首个组织：${made.via} 回了 1000，但响应没带组织码（data:[]）`)
    }
  }

  if (!orgs.length) {
    throw Object.assign(
      new Error(
        `登录成功但拿不到组织码。\n` +
          `  · 登录响应结构：${describeShape(json)}\n` +
          `  · 用该令牌调 login-data 的探测结果：${orgProbeErrors().join(" / ") || "（没探）"}\n` +
          `  （前端拿 access_token 直接 setAuthorization 后就用它调这个接口）`,
      ),
      { raw: json },
    )
  }
  return { jwt, org: orgs[0], orgs, raw: json, createdOrg }
}

// ═══ 无组织的新号：在用户中心建第一个组织（邀请码在这一步才消费）════════
//
// 这不是猜的：上游前端 magic-web 的登录页 chunk（`assets/login-KOsbWlyY.js`）
// 在 `auth/status` 回 3102 USER_NOT_CREATE_ACCOUNT 时走的就是这几条：
//
//   有邀请码 → POST {keewood}/v4/user/organizations
//              { name:"个人组织", industry_type:"其他", register_code:<邀请码>, logo:{} }
//              → 响应里的 code 是新组织码
//              → 再 GET /api/v1/auth/status（authorization + Organization-Code:<新码>）绑定
//   码已被用（2152）→ 前端弹窗问「继续登录吗」→ 继续就走下面无邀请码那条
//   没有邀请码 → POST {keewood}/v4/users/organizations/create { invite_code:"" }
//
// 配置文字来自官方 locale：`invite.inviteForm.defaultValue.name` = 个人组织、
// `industryType` = 其他。
//
// ⚠ 少了这一步，新号在插件里永远停在「登录成功但拿不到组织码」——
//   用户中心已经登录成功，但 Magic 侧还没有用户/组织。
// ⚠ 这个接口在 **keewood 用户中心**（`keewoodOf(site)`），不是 magic-service；
//   `valid /v4/user/organizations`（单数 user）和 `/v4/users/organizations/create`
//   （复数 users）也是两个不同端点，别合并。

async function postKeewoodJSON(site, path, body, jwt) {
  const res = await fetch(`${keewoodOf(site)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: jwt,
      origin: site.web,
      "user-agent": "magpie-magicrew-auth",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })
  const text = await res.text().catch(() => "")
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}：${text.slice(0, 140)}`)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  if (!json) throw new Error(`${path} 回了非 JSON：${text.slice(0, 140)}`)
  return json
}

/** 建组织接口把新组织码放在哪 —— 客户端会先 unwrap data，所以两种形状都认 */
function orgCodeOf(json) {
  const d = json?.data ?? {}
  for (const v of [
    d.code,
    d.organization_code,
    d.magic_organization_code,
    d.third_platform_organization_code,
    json?.code,
  ]) {
    if (typeof v === "string" && /^[a-z0-9]{6,32}$/i.test(v)) return v
  }
  return ""
}

/**
 * 用刚建好的组织码把 token 绑上（前端 `magicOrganizationSync` 那一步）。
 * 返回 magic 侧真正的组织码；绑不上就返回空，让上层用建组织返回的那个码兜底。
 */
export async function bindOrganization(site, jwt, orgCode) {
  const url = `${site.host}/api/v1/auth/status?login_code=`
  const variants = [
    { authorization: jwt, "Organization-Code": orgCode },
    { authorization: `Bearer ${jwt}`, "Organization-Code": orgCode },
  ]
  for (const headers of variants) {
    try {
      const res = await fetch(url, {
        headers: { ...headers, "user-agent": "magpie-magicrew-auth" },
        signal: AbortSignal.timeout(90_000),
      })
      const text = await res.text().catch(() => "")
      if (!res.ok) continue
      let j = null
      try {
        j = JSON.parse(text)
      } catch {
        continue
      }
      if (j?.code !== 1000) continue
      const list = j?.data ?? j
      const orgs = Array.isArray(list) ? parseOrgs(list) : []
      if (orgs.length) return orgs
    } catch {}
  }
  return []
}

/**
 * 给「登录成功但 Magic 里没用户」的号建第一个组织。
 *
 * ⚠ `org` 可能是空串：接口回 1000 但 `data:[]`（实测 2026-10-29）时组织可能已经建好，
 *   只是响应里不带码。调用方要像上游前端一样，拿不到码就重新探测组织列表，别直接报错。
 * @returns {Promise<{org:string, via:"邀请码"|"无邀请码"}>}
 */
export async function createFirstOrganization(site, jwt, inviteCode = "") {
  const code = String(inviteCode || "").trim()
  const problems = []

  if (code) {
    try {
      const json = await postKeewoodJSON(
        site,
        "/v4/user/organizations",
        { name: "个人组织", industry_type: "其他", register_code: code, logo: {} },
        jwt,
      )
      if (json.code !== 1000) {
        throw Object.assign(new Error(`建组织失败：${json.message ?? json.code}`), {
          code: json.code,
          raw: json,
        })
      }
      const org = orgCodeOf(json)
      if (org) return { org, via: "邀请码" }
      problems.push(`POST /v4/user/organizations 回了 1000 但没有组织码：${describeShape(json)}`)
      return { org: "", via: "邀请码" }
    } catch (e) {
      if (e?.code !== 2152) throw e
      problems.push("邀请码已被使用（2152）")
    }
  }

  // 没码 / 码已被用：前端「继续登录」那条路
  const json = await postKeewoodJSON(site, "/v4/users/organizations/create", { invite_code: "" }, jwt)
  if (json.code !== 1000) {
    throw Object.assign(
      new Error(
        `建首个组织失败：${json.message ?? json.code}` + (problems.length ? `（${problems.join("；")}）` : ""),
      ),
      { code: json.code, raw: json },
    )
  }
  const org = orgCodeOf(json)
  return { org, via: "无邀请码" }
}

/** 旧签名兼容：手机号验证码换登录态 */
export async function finishSmsLogin(site, { mobile, stateCode = "+86", ...rest } = {}) {
  return finishCodeLogin(site, { mobile, stateCode, ...rest })
}

/**
 * 把一段 JSON 的形状描述出来：**只有键名和类型，没有任何值**。
 *
 * 用来让真机上的报错自带诊断信息 —— 用户截一张图，就能看出服务端到底回了什么结构，
 * 不用反复试。token 之类的东西一律不会出现在这里。
 */
export function describeShape(o, depth = 0) {
  if (o === null) return "null"
  if (o === undefined) return "undefined"
  const t = typeof o
  if (t !== "object") return t === "string" ? `str(${String(o).length})` : t
  if (depth >= 3) return "…"
  if (Array.isArray(o)) {
    return `[${o.length}]` + (o.length ? describeShape(o[0], depth + 1) : "")
  }
  const keys = Object.keys(o).slice(0, 24)
  return "{" + keys.map((k) => `${k}:${describeShape(o[k], depth + 1)}`).join(", ") + "}"
}

/**
 * 从登录响应里取「授权令牌」和「组织码」。
 *
 * ⚠ 登录返回的**不是 JWT，是 `access_token`** —— 前端拿到之后立刻
 *   `setAuthorization(access_token)` 并用它调 `getUserProfile`。
 *   早先这里只按 `eyJ` 前缀找 JWT，结果在响应里挑到了别的字段，
 *   拿去调 `login-data` 自然拿不到组织（真机表现就是
 *   「登录成功但拿不到组织码」）。
 */
function extractLoginCreds(json) {
  const d = json?.data ?? json ?? {}
  const pick = (...keys) => {
    for (const k of keys) {
      const v = d?.[k]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
    return null
  }
  // 优先认登录接口自己给的字段名
  const token =
    pick("access_token", "accessToken", "token", "authorization", "teamshare_token") ??
    extractCreds(json).jwt
  const org =
    pick("organization_code", "organizationCode", "magic_organization_code") ??
    extractCreds(json).org
  return { jwt: token, org }
}

/**
 * 这个账号属于哪些组织（按服务端返回的顺序）。
 *
 * ⚠ 浏览器登录能直接读到用户**当前选中**的组织（localStorage 里的
 *   `MAGIC:user:organizationCode`），无头这条路没有那个信息 —— 所以只能把候选
 *   全拿回来，让调用方逐个验，验不过再换下一个。
 *
 * ⚠ `authorization` 头**两种写法都要试**：前端这个接口是
 *   `h.set("authorization", authorization)` —— 直接放 token，**没有 `Bearer ` 前缀**；
 *   但平台其它接口（`/api/v1/flows/models` 等）走的是 `Bearer <jwt>` 并且能通。
 *   登录拿到的是 438 字符的 `access_token`，和网页 localStorage 里那把 354 字符的不是
 *   同一个东西，所以不能想当然 —— 两种都打，先成的算。
 *   全失败时把每一步的真实原因记在模块变量里，供上层错误信息引用。
 */
let lastOrgProbeErrors = []
let lastOrgProbeCodes = []
export function orgProbeErrors() {
  return lastOrgProbeErrors.slice()
}
/** 每个探测接口回的业务码 —— 建首个组织只认 `auth/status` 的 3102（用户尚未创建账号） */
export function orgProbeCodes() {
  return lastOrgProbeCodes.slice()
}

export async function fetchOrgs(site, jwt) {
  lastOrgProbeErrors = []
  lastOrgProbeCodes = []

  // 三个端点 × 两种 authorization 写法，全试一遍 —— 它们对令牌形态的宽容度不一样：
  //   · login-data       前端是 h.set("authorization", token)（无 Bearer），但它同时
  //                      接受 `Bearer <网页版 JWT>`（用本机 354 字符 JWT 实测通过）
  //   · me/organizations 实测连 organization-code 头都不要，只认令牌
  //   · auth/status      前端 bindMagicAuthorization 用它，返回 Array<MagicOrganization>
  // 登录拿到的是 438 字符的 access_token，和网页 localStorage 那把 354 的不同，
  // 所以不能想当然只打一个。
  const probes = [
    { tag: "login-data/Bearer", url: `${site.host}/api/v1/aggregation/login-data?teamshare_login_code=`, auth: `Bearer ${jwt}`, pick: (j) => j?.data?.auth_status ?? j?.auth_status },
    { tag: "login-data/裸", url: `${site.host}/api/v1/aggregation/login-data?teamshare_login_code=`, auth: jwt, pick: (j) => j?.data?.auth_status ?? j?.auth_status },
    { tag: "auth-status/Bearer", url: `${site.host}/api/v1/auth/status?login_code=`, auth: `Bearer ${jwt}`, pick: (j) => j?.data ?? j },
    { tag: "auth-status/裸", url: `${site.host}/api/v1/auth/status?login_code=`, auth: jwt, pick: (j) => j?.data ?? j },
    { tag: "me-organizations/Bearer", url: `${site.host}/api/v1/contact/accounts/me/organizations`, auth: `Bearer ${jwt}`, pick: (j) => j?.data?.items ?? j?.items },
    { tag: "me-organizations/裸", url: `${site.host}/api/v1/contact/accounts/me/organizations`, auth: jwt, pick: (j) => j?.data?.items ?? j?.items },
  ]

  for (const p of probes) {
    let res = null
    try {
      res = await fetch(p.url, {
        headers: { authorization: p.auth, "user-agent": "magpie-magicrew-auth" },
        signal: AbortSignal.timeout(90_000),
      })
    } catch (e) {
      lastOrgProbeErrors.push(`${p.tag}：网络失败 ${String(e?.message ?? e).slice(0, 60)}`)
      continue
    }

    const text = await res.text().catch(() => "")
    if (!res.ok) {
      lastOrgProbeErrors.push(`${p.tag}：HTTP ${res.status} ${text.slice(0, 70)}`)
      continue
    }
    let j = null
    try {
      j = JSON.parse(text)
    } catch {
      lastOrgProbeErrors.push(`${p.tag}：非 JSON ${text.slice(0, 70)}`)
      continue
    }
    if (j?.code !== 1000) {
      lastOrgProbeErrors.push(`${p.tag}：code ${j?.code} ${j?.message ?? ""}`.trim())
      lastOrgProbeCodes.push({ tag: p.tag, code: j?.code })
      continue
    }
    const list = p.pick(j)
    if (!Array.isArray(list) || !list.length) {
      lastOrgProbeErrors.push(`${p.tag}：200 但列表为空`)
      continue
    }
    const orgs = parseOrgs(list)
    if (orgs.length) return orgs
    lastOrgProbeErrors.push(`${p.tag}：有 ${list.length} 项但取不到组织码`)
  }
  return []
}

function parseOrgs(list) {
  // ⚠ 字段名是 `magic_organization_code`（实测）。`organization_code` 只在**外层**存在，
  //   而且是空串 —— 认它就会拿到 ""。每项里另有 third_platform_ / teamshare_ 两份同值码。
  const KEYS = [
    "magic_organization_code",
    "third_platform_organization_code",
    "teamshare_organization_code",
  ]
  const out = []
  for (const item of list) {
    for (const key of KEYS) {
      const v = item?.[key]
      if (typeof v === "string" && /^[a-z0-9]{6,32}$/i.test(v) && !out.includes(v)) {
        out.push(v)
        break
      }
    }
  }
  return out
}
