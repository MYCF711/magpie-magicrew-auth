// 无头登录的底层：旋转验证码 + 手机验证码换取登录态
//
// 全部是**纯 HTTP**，不开浏览器、不读 localStorage。协议是从网页版
// `SMSVerificationCodeForm` chunk 里逆出来的，每一步都实测过
// （见 docs/internals.md「无头登录」一节）：
//
//   ① POST /captcha/generate   { account_type, mobile, state_code }
//        → { token, image(data:image/webp;base64,…), expire_time }
//   ② 算角度 → angle = enc(deg, n)
//   ③ POST /captcha/verify     { token, angle, account_type, mobile, state_code }
//        → { verified: true, business_token: "biz_…" }
//   ④ POST /v4/user/send-sms   { type, phone, state_code }
//        + header `X-Captcha-Token: <business_token>`
//   ⑤ POST /v4/user/login      { type: "phone_captcha", phone, state_code, code, device }
//
// ⚠ 三个域名各管一段，别混：
//     www.<站点>            → 前端页面（只用来取 Origin，别的没用）
//     i-keewood-service…    → captcha / v4 用户中心（①②③④⑤ 全在这）
//     模型网关              → 与登录无关
//
// ⚠ 风控是真的（实测）：
//      · 「验证次数已超限」  同一 token 试错有上限
//      · 「验证不存在或已过期」 expire_time 给 10 分钟
//      · 「验证提交过于频繁」  连续批量提交会被拦
//   ⇒ 不能枚举角度，一次要算准；失败就换图重来。

/** 服务端只认这一套 Unicode；错误码直接用数字，日志里好 grep */
export const CAPTCHA_CODE = {
  OK: 1000,
  BAD: 2000,
}

/**
 * 用户中心的域名按站点分，**两站的命名规则还不一样**（别照抄前缀）：
 *
 *   国内 www.letsmagic.cn → https://i-keewood-service.teamshare.cn   ← 有 `i-`，根域是 teamshare.cn
 *   国际 www.magicrew.ai  → https://keewood-service.magicrew.ai      ← 没有 `i-`
 *
 * 出处：桌面客户端内嵌配置里的 `MAGIC_SERVICE_KEEWOOD_BASE_URL`
 *       （`GET https://www.magicrew.ai/workspace` 的 HTML 里能直接读到）。
 * 两个都实测过 `POST /captcha/generate` 回 200。
 */
export function keewoodOf(site) {
  return site.id === "magicrew" ? "https://i-keewood-service.teamshare.cn" : "https://keewood-service.magicrew.ai"
}

/**
 * 拖动角度 → 服务端要的 angle 字符串。
 *
 * 前端是这么算的（`SMSVerificationCodeForm` chunk，混淆过但结构清楚）：
 *
 *   Se(deg, n) = ((52249517 * (deg + n) + 5976906165) & 0xFFFFFFFF)
 *   angle      = String(Se(deg, n)) + String(n)     // n = Date.now() % 90000 + 10000
 *
 * 验证方式：抓浏览器真实提交的 4 组 angle，对每组正向穷举 deg 0…359，
 * **每组都唯一命中**，且命中值与拖动像素严格成 1.6°/px（225px = 360°）。
 * 所以这里照抄，别改系数。
 *
 * ⚠ deg 是「图片顺时针旋转的角度」，0…359。不是「还差多少度」。
 */
export function encodeAngle(deg, n) {
  const d = ((BigInt(deg) % 360n) + 360n) % 360n
  const nn = BigInt(n)
  const v = (52249517n * (d + nn) + 5976906165n) & 0xffffffffn
  return String(v) + String(n)
}

/** 服务端给的 n 是 5 位（10000…99999）；我们自己造一个同样形状的 */
export function randomN() {
  return Math.floor(Math.random() * 90000) + 10000
}

/**
 * 钟点 → deg。
 *
 * 判官回答的是「主体自己的上方向指向钟面的几点」（12=正上、3=正右）。
 * 图要**顺时针**转多少度才立起来 = (12 - clock) * 30。
 */
export function clockToDeg(clock) {
  const x = Number(clock)
  if (!Number.isFinite(x)) return null
  return Math.round((((12 - x) * 30) % 360 + 360) % 360)
}

/** 两个判官分歧多大（按钟点，取最短环距 0…6） */
export function clockSpread(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 6
  const d = Math.abs(((a - b) % 12 + 12) % 12)
  return Math.min(d, 12 - d)
}

/** 分歧超过这个值就认为「有人把方向看反了」，宁可重来也不要瞎提交 */
export const CLOCK_MAX_SPREAD = 1.5

async function postJSON(url, body, { headers = {}, timeoutMs = 20_000 } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 就当文本报出去 */
  }
  return { status: res.status, text, json }
}

/** ① 取图。返回 null 表示服务端认为这个号**已经注册**，直接给了 business_token（跳过验证） */
export async function generateCaptcha(site, { mobile, stateCode = "+86" } = {}) {
  const host = keewoodOf(site)
  const { json } = await postJSON(`${host}/captcha/generate`, {
    account_type: "mobile",
    mobile,
    state_code: stateCode,
  }, { headers: { origin: site.web } })

  const data = json?.data ?? {}
  if (data.business_token) return { registered: true, businessToken: data.business_token }
  if (!data.token || !data.image) {
    throw new Error(`取验证码失败：${json?.message ?? "没有 token/image"}`)
  }
  return {
    registered: false,
    token: data.token,
    image: String(data.image),
    expireAt: data.expire_time ? Number(data.expire_time) * 1000 : null,
  }
}

/** ③ 提交角度 */
export async function verifyCaptcha(site, { token, deg, mobile, stateCode = "+86" }) {
  const host = keewoodOf(site)
  const n = randomN()
  const { json } = await postJSON(`${host}/captcha/verify`, {
    account_type: "mobile",
    token,
    angle: encodeAngle(deg, n),
    mobile,
    state_code: stateCode,
  }, { headers: { origin: site.web } })

  const data = json?.data ?? {}
  if (data.verified && data.business_token) return { ok: true, businessToken: data.business_token }
  return { ok: false, message: json?.message ?? "验证失败" }
}

/**
 * ④ 发短信。businessToken 缺了/假的都会被打回来，所以它必须是真的。
 *
 * ⚠ `type` 是 **`"account_login"`**，不是 `"login"`、也不是登录枚举里的 `phone_captcha`。
 *   填错的表现是「服务异常，请联系管理员」(9999) —— 后端内部炸了，不是参数校验失败，
 *   所以从错误信息上完全看不出是 type 的问题。这个值是从浏览器真实请求里抓到的：
 *     {"type":"account_login","phone":"199…","state_code":"+86"}
 *   ⇒ 别再按直觉改它。
 */
export async function sendSms(site, { phone, stateCode = "+86", businessToken, type = "account_login" }) {
  const host = keewoodOf(site)
  const { json } = await postJSON(`${host}/v4/user/send-sms`, {
    type,
    phone,
    state_code: stateCode,
  }, { headers: { origin: site.web, "X-Captcha-Token": businessToken || "" } })

  if (json?.code === CAPTCHA_CODE.OK) return { ok: true }
  return { ok: false, message: json?.message ?? "发送短信失败" }
}

/**
 * ⑤ 验证码换登录态。
 *
 * ⚠ `device` 是必须的，而且结构是一层层试出来的：
 *     缺 device        → 「系统异常」(9999)
 *     device 不是对象   → 「系统异常」
 *     { device_id }    → 「id 字段是必须的」
 *     { id, name }     → 放行，返回 2168「验证码错误」
 *   ⇒ { id: 64 位 hex, name: "web" } 就够。
 */
export async function loginBySmsCode(site, { phone, stateCode = "+86", code, device }) {
  const host = keewoodOf(site)
  const { json, status, text } = await postJSON(`${host}/v4/user/login`, {
    type: "phone_captcha",
    phone,
    state_code: stateCode,
    code,
    device: device ?? { id: makeDeviceId(), name: "web" },
  }, { headers: { origin: site.web } })

  return { json, status, text }
}

/** 64 位 hex，形状与网页版 cus.device_id 一致 */
export function makeDeviceId() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * 从登录响应里把 jwt / 组织码抠出来。
 *
 * ⚠ 这两个字段的真实形状**没实测过**（手上没有能收短信的号，只能验到 2168）。
 *   所以这里做成「穷举常见键名 + 顺着对象往下找」的两层兜底，
 *   并且把原始响应留在返回值里，出问题时日志能直接看到该怎么改。
 */
export function extractCreds(payload) {
  const seen = new Set()
  let jwt = null
  let org = null

  const looksJwt = (v) => typeof v === "string" && v.startsWith("eyJ") && v.split(".").length === 3
  const looksOrg = (v) => typeof v === "string" && /^[a-z0-9]{6,32}$/i.test(v) && !looksJwt(v)

  const walk = (node, depth) => {
    if (!node || depth > 5 || seen.has(node)) return
    if (typeof node !== "object") return
    seen.add(node)

    for (const [k, v] of Object.entries(node)) {
      if (!jwt && looksJwt(v)) jwt = v
      if (!org && looksOrg(v) && /org/i.test(k)) org = v
    }
    // 常见嵌套：data / organization / organizations[0]
    if (!org && typeof node.organization_code === "string") org = node.organization_code
    if (!org && typeof node.organizationCode === "string") org = node.organizationCode
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") {
        if (Array.isArray(v)) {
          for (const item of v.slice(0, 5)) walk(item, depth + 1)
        } else walk(v, depth + 1)
      }
    }
  }
  walk(payload, 0)

  return { jwt, org }
}
