// 无头登录的底层：旋转验证码 + 手机/邮箱验证码换取登录态
//
// 全部是**纯 HTTP**，不开浏览器、不读 localStorage。协议是从网页版
// `SMSVerificationCodeForm` / `LoginCoreForm` chunk 里逆出来的，每一步都实测过
// （见 docs/internals.md「无头登录」一节）：
//
//   ① POST /captcha/generate   { account_type, mobile, state_code }      手机
//                              { account_type, email }                   邮箱
//        → { token, image(data:image/webp;base64,…), expire_time }
//   ② 算角度 → angle = enc(deg, n)
//   ③ POST /captcha/verify     { token, angle, account_type, mobile, state_code }
//                              { token, angle, account_type, email }
//        → { verified: true, business_token: "biz_…" }
//   ④ 发验证码（两条路**是两个端点**，别混）：
//        手机 POST /v4/user/send-sms     { type, phone, state_code }
//        邮箱 POST /v4/user/send-email   { email, type }
//        + header `X-Captcha-Token: <business_token>`，type 都是 "account_login"
//   ⑤ 换登录态（同样是两个端点）：
//        手机 POST /v4/user/login        { type:"phone_captcha", phone, state_code, code, device }
//        邮箱 POST /v4/user/login-email  { email, captcha, device }
//
// ⚠ 邮箱那条为什么走 `/v4/user/login-email` 而不是 `/v4/user/login`：
//   实测（2026-10-28，两站）——往 `/v4/user/login` 发任何 type（email / email_captcha
//   / email_code）都回 2000「phone 字段是必须的」，服务端根本不认邮箱。
//   前端 `UserApi` 里也是两条独立方法：`loginByEmail()` → `/v4/user/login-email`，
//   并且它显式 `delete("organization-code")`。
//
// ⚠ 邮箱那条的**验证码字段名是 `captcha`，不是 `code`** —— 实测发 `code` 回
//   2000「captcha 字段是必须的」；发 `captcha` 回 2168「验证码错误」。
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
//
// ═══════════════════════════════════════════════════════════════════════
// 那张旋转图到底能不能绕开（2026-10-29 逐条实测，别再来一遍）
// ═══════════════════════════════════════════════════════════════════════
//
// 结论：**只有「这个号已注册」这一条免费通道**，其余一律必须看懂图。
//
// ① 已注册的号 —— 服务端**不出图**：`/captcha/generate` 直接回 `business_token`。
//      实测：已注册邮箱 → business_token；没注册过的邮箱 → token + image。
//      ⇒ 「把我已有的账号加进 magpie」根本不需要识图模型（见 headless.mjs 里
//        startCodeLogin 的「先取图、再判模型」顺序）。
//
// ② 新号的答案**不在前端**，也不在图里：
//      · 前端提交的 `angle` 就是**用户拖动的角度**（`verify(r)` → 这个文件里的
//        encodeAngle），前端不知道正确答案 —— 知道的话就不会让你拖了；
//      · 图里没有任何元数据：解剖 webp 只有 `VP8X` / `ALPH` / `VP8` 三个 chunk，
//        没有 EXIF / XMP / ICC / 自定义块，字符串扫描也是空的；
//      · 服务端强制：`verify` 不传 angle → 「angle 字段是必须的」；乱填 →
//        「验证失败，请重试」；发码不带 `X-Captcha-Token`（哪怕带上账号自己的 JWT
//        和 organization-code）→ 「需要验证码验证」。
//      ⇒ 答案 = 服务端生成图时随机定的角度，存在它自己的会话里（10 分钟过期）。
//        要过它只有两条路：识图模型，或人眼看。
//
// ③ 不经过验证码的登录入口只有两条，都不是邮箱验证码的替代品：
//      · 手机号 + 密码 → `POST /api/v1/sessions {type:"phone_password"}`
//      · 本机浏览器里已登录 → 读它的 localStorage（见 local-browser.mjs）
//      邮箱 + 密码（`type:"email_password"`）端点认这个 type，但要账号**事先设过
//      密码** —— 实测对一个已注册邮箱回 `33002 账号不存在`，不能当通用路。

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
 * 「这条链路在给谁发验证码」→ 服务端要的那几个字段。
 *
 * 手机和邮箱走的是**同一套 captcha 协议**，只有三处不同，全收敛在这里：
 *   ① 标识字段：`mobile` + `state_code` vs `email`
 *   ② `account_type`：`"mobile"` vs `"email"`
 *   ③ 端点：`/v4/user/send-sms` + `/v4/user/login` vs
 *      `/v4/user/send-email` + `/v4/user/login-email`
 *
 * ⚠ 邮箱**不带 `state_code`** —— 前端邮箱表单的初始值里就没有这个字段
 *   （实测抓到的请求体逐字符是 `{"account_type":"email","email":"…"}`）。
 *
 * @param {{mobile?:string, stateCode?:string, email?:string}} ident
 * @returns {{account_type:"mobile"|"email", mobile?:string, state_code?:string, email?:string}}
 */
export function identFields(ident = {}) {
  const email = String(ident?.email ?? "").trim()
  if (email) return { account_type: "email", email }
  const mobile = String(ident?.mobile ?? "").replace(/[\s-]/g, "")
  return { account_type: "mobile", mobile, state_code: ident?.stateCode || "+86" }
}

/** 这条链路是手机还是邮箱 —— 决定走哪两个端点 */
export function identKind(ident = {}) {
  return String(ident?.email ?? "").trim() ? "email" : "mobile"
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

/** ① 取图。服务端认为这个号**已经注册**时直接给 business_token（跳过验证） */
export async function generateCaptcha(site, ident = {}) {
  const host = keewoodOf(site)
  const { json } = await postJSON(`${host}/captcha/generate`, identFields(ident), {
    headers: { origin: site.web },
  })

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

/** ③ 提交角度（手机 / 邮箱同一套，标识字段由 identFields 决定） */
export async function verifyCaptcha(site, { token, deg, ...ident }) {
  const host = keewoodOf(site)
  const n = randomN()
  const { json } = await postJSON(`${host}/captcha/verify`, {
    token,
    angle: encodeAngle(deg, n),
    ...identFields(ident),
  }, { headers: { origin: site.web } })

  const data = json?.data ?? {}
  if (data.verified && data.business_token) return { ok: true, businessToken: data.business_token }
  return { ok: false, message: json?.message ?? "验证失败" }
}

/**
 * ④ 发验证码。businessToken 缺了/假的都会被打回来，所以它必须是真的。
 *
 * ⚠ `type` 是 **`"account_login"`**，不是 `"login"`、也不是登录枚举里的 `phone_captcha`。
 *   填错的表现是「服务异常，请联系管理员」(9999) —— 后端内部炸了，不是参数校验失败，
 *   所以从错误信息上完全看不出是 type 的问题。这个值是从浏览器真实请求里抓到的：
 *     手机 {"type":"account_login","phone":"199…","state_code":"+86"}
 *     邮箱 {"email":"…","type":"account_login"}
 *   ⇒ 别再按直觉改它。两站实测：邮箱发 `type:"login"` 同样回 2000「服务异常」。
 *
 * ⚠ 邮箱和手机是**两个端点**：`/v4/user/send-email` vs `/v4/user/send-sms`。
 *   把邮箱发去 send-sms 会 404（`/v4/user/send-sms` 只认 phone）。
 */
export async function sendCode(site, ident = {}, { businessToken, type = "account_login" } = {}) {
  const host = keewoodOf(site)
  const f = identFields(ident)
  const isEmail = f.account_type === "email"
  const path = isEmail ? "/v4/user/send-email" : "/v4/user/send-sms"
  const body = isEmail
    ? { email: f.email, type }
    : { type, phone: f.mobile, state_code: f.state_code }

  const { json } = await postJSON(`${host}${path}`, body, {
    headers: { origin: site.web, "X-Captcha-Token": businessToken || "" },
  })

  if (json?.code === CAPTCHA_CODE.OK) return { ok: true }
  return { ok: false, message: json?.message ?? "发送验证码失败" }
}

/** 旧签名兼容：手机号发短信 */
export async function sendSms(site, { phone, stateCode = "+86", businessToken, type = "account_login" }) {
  return sendCode(site, { mobile: phone, stateCode }, { businessToken, type })
}

/**
 * ⑤ 验证码换登录态（手机 / 邮箱两个端点）。
 *
 * ⚠ `device` 是必须的，而且结构是一层层试出来的：
 *     缺 device        → 「系统异常」(9999)
 *     device 不是对象   → 「系统异常」
 *     { device_id }    → 「id 字段是必须的」
 *     { id, name }     → 放行，返回 2168「验证码错误」
 *   ⇒ { id: 64 位 hex, name: "web" } 就够。
 *
 * ⚠ 手机那条的 `auto_register` / `redirect` 一个都不能省（这是网页表单的初始值，抠出来的）：
 *
 *     { phone, state_code, code, auto_register: true,
 *       type: "phone_captcha", redirect: window.location.href }
 *
 *   · `auto_register: true` —— 否则新号登不进来（只会报账号不存在）
 *   · `redirect` 是**当前页面的 URL**，服务端从它上面取 `?invitation=<码>`。
 *     ⇒ **邀请码是靠 redirect 传的，不是独立字段**。这就是为什么浏览器登录的
 *       URL 必须带 `?invitation=`：不带，新注册的号就没有邀请关系。
 *
 * ⚠ 邮箱那条**验证码字段叫 `captcha`，不叫 `code`**（实测：发 code 回
 *   2000「captcha 字段是必须的」；发 captcha 回 2168「验证码错误」）。
 *   端点也不同：`/v4/user/login-email`，前端调它时会先 `delete("organization-code")`。
 *   `auto_register` / `redirect` 前端没传，但我们**照传** —— 实测多这两个字段
 *   服务端不报错（仍回 2168），而新号注册和邀请码都指着它们。
 */
export async function loginByCode(
  site,
  { code, device, autoRegister = true, redirect, ...ident },
) {
  const host = keewoodOf(site)
  const f = identFields(ident)
  const isEmail = f.account_type === "email"

  const body = isEmail
    ? {
        email: f.email,
        captcha: code,
        auto_register: autoRegister,
        device: device ?? { id: makeDeviceId(), name: "web" },
      }
    : {
        type: "phone_captcha",
        phone: f.mobile,
        state_code: f.state_code,
        code,
        auto_register: autoRegister,
        device: device ?? { id: makeDeviceId(), name: "web" },
      }
  if (redirect) body.redirect = redirect

  const { json, status, text } = await postJSON(
    `${host}${isEmail ? "/v4/user/login-email" : "/v4/user/login"}`,
    body,
    { headers: { origin: site.web } },
  )

  return { json, status, text }
}

/** 旧签名兼容：手机号验证码换登录态 */
export async function loginBySmsCode(site, { phone, stateCode = "+86", ...rest }) {
  return loginByCode(site, { mobile: phone, stateCode, ...rest })
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

  // 这些键名是服务端真实用的（实测 `login-data` 的形状），优先级高于「键名里带 org」的泛匹配 ——
  // 后者会撞上 `organization_name: ""`、`organization_logo: null` 这类同名前缀的字段。
  const STRONG_ORG_KEYS = [
    "magic_organization_code",
    "third_platform_organization_code",
    "teamshare_organization_code",
    "organization_code",
    "organizationCode",
  ]

  const walk = (node, depth) => {
    if (!node || depth > 5 || seen.has(node)) return
    if (typeof node !== "object") return
    seen.add(node)

    for (const [k, v] of Object.entries(node)) {
      if (!jwt && looksJwt(v)) jwt = v
      if (!org && STRONG_ORG_KEYS.includes(k) && looksOrg(v)) org = v
    }
    // 弱匹配兜底：键名带 org 且值形似组织码
    if (!org) {
      for (const [k, v] of Object.entries(node)) {
        if (looksOrg(v) && /org/i.test(k)) {
          org = v
          break
        }
      }
    }
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
