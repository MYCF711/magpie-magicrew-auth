// 无头登录的编排：一条纯 HTTP 的链路，不开浏览器
//
//   取图 → 识图判角度 → 过验证 → 发短信 → （用户填码）→ 换登录态 → 拿组织码
//
// 每一步都实测过（见 docs/internals.md「无头登录」）：
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
  loginBySmsCode,
  sendSms,
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
 * @returns {Promise<{businessToken:string, rounds:number, log:string[]}>}
 */
export async function passCaptcha(site, { mobile, stateCode = "+86" } = {}) {
  const log = []
  let lastReason = ""

  for (let round = 1; round <= MAX_CAPTCHA_ROUNDS; round++) {
    const cap = await generateCaptcha(site, { mobile, stateCode })
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

    const res = await verifyCaptcha(site, { token: cap.token, deg: decided.deg, mobile, stateCode })
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
 * 第 1 步：发短信。成功即代表「验证已经过了」——服务端把 business_token 当门票。
 */
export async function startSmsLogin(site, { mobile, stateCode = "+86" } = {}) {
  if (!readVisionModel()) {
    // 调用方应该先判断这个；走到这里说明判断被绕过了 —— 明确报出来，别静默瞎猜
    throw Object.assign(new Error("没有配置识图模型，不能无头过旋转验证"), { code: "no-vision-model" })
  }

  const { businessToken, rounds, log } = await passCaptcha(site, { mobile, stateCode })
  const sms = await sendSms(site, { phone: mobile, stateCode, businessToken })
  if (!sms.ok) {
    throw Object.assign(new Error(`发短信失败：${sms.message}`), { captchaLog: log })
  }
  return { businessToken, rounds, log }
}

/**
 * 第 2 步：验证码换登录态，并补齐组织码。
 *
 * ⚠ 登录响应里 jwt / 组织码的**确切形状没实测过**（手上没有能收短信的号，
 *   只能验到 2168「验证码错误」）。所以：
 *     · jwt 用 extractCreds 从响应里按特征找（以 eyJ 开头的三段式）
 *     · 组织码找不着就调 `/api/v1/aggregation/login-data`（带 authorization 头，
 *       服务端会回这个账号所在的组织列表）—— 这条路径是文档里查得到的
 */
export async function finishSmsLogin(site, { mobile, stateCode = "+86", code, device, redirect }) {
  const { json, status, text } = await loginBySmsCode(site, {
    phone: mobile,
    stateCode,
    code,
    device,
    autoRegister: true,
    redirect,
  })
  if (!json) {
    throw new Error(`登录接口回了非 JSON（HTTP ${status}）：${String(text).slice(0, 200)}`)
  }
  if (json.code !== 1000) {
    // 2168 是验证码错；其余原样透出，别把它吞成「登录失败」
    throw Object.assign(new Error(`登录失败：${json.message ?? json.code}`), {
      code: json.code,
      raw: json,
    })
  }

  const { jwt, org } = extractLoginCreds(json)
  if (!jwt) {
    throw Object.assign(new Error("登录成功但响应里没找到 JWT —— 请把这条原始响应反馈给插件作者"), {
      raw: json,
    })
  }
  // 响应里给了组织码就用它；没给就把该账号的组织**全列出来**，
  // 由调用方逐个拿 fetchPoints 验（见 methods.mjs 的 completeSignIn）——
  // 只取第一个是不够的：多组织账号会落到「列表第一个」而不是用户平时用的那个。
  const orgs = org ? [org] : await fetchOrgs(site, jwt)
  if (!orgs.length) {
    throw Object.assign(new Error("登录成功但拿不到组织码（该账号没有任何组织？）"), { raw: json })
  }
  return { jwt, org: orgs[0], orgs, raw: json }
}

function extractLoginCreds(json) {
  // 只认 eyJ 三段式当 JWT；组织码优先取键名带 org 的那个
  const { jwt, org } = extractCreds(json)
  return { jwt, org }
}

/**
 * 这个账号属于哪些组织（按服务端返回的顺序）。
 *
 * ⚠ 浏览器登录能直接读到用户**当前选中**的组织（localStorage 里的
 *   `MAGIC:user:organizationCode`），无头这条路没有那个信息 —— 所以只能把候选
 *   全拿回来，让调用方逐个验，验不过再换下一个。单组织账号没有区别；
 *   多组织账号靠这一步才不会落错地方。
 */
export async function fetchOrgs(site, jwt) {
  const res = await fetch(`${site.host}/api/v1/aggregation/login-data?teamshare_login_code=`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      "user-agent": "magpie-magicrew-auth",
    },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  if (!res?.ok) return []
  const j = await res.json().catch(() => null)
  const list = j?.data?.auth_status ?? j?.auth_status ?? []
  if (!Array.isArray(list)) return []

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
