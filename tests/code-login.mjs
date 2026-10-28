// 「验证码登录」两条链的协议锁定：手机号 / 邮箱走的端点和字段名
//
//   node tests/code-login.mjs
//
// 这一份不联网：拦全局 fetch，把上游换成可编程的假服务端，然后逐个断言
// **请求本身**长什么样。协议是从上游前端 chunk 里逆出来的 + 两站实测过的，
// 这里把它钉死 —— 哪天有人「顺手统一一下」把邮箱也发去 send-sms、或者把
// `captcha` 改回 `code`，这里立刻红。
//
// 实测来源（2026-10-28，两站 keewood 用户中心）：
//   · 邮箱取图：POST /captcha/generate   {account_type:"email", email}       ← 无 state_code
//   · 邮箱过验证：POST /captcha/verify   {token, angle, account_type, email}
//   · 发信：POST /v4/user/send-email     {email, type:"account_login"} + X-Captcha-Token
//           type 填 "login" → 2000「服务异常，请联系管理员」
//   · 换登录态：POST /v4/user/login-email {email, captcha, device, …}
//           字段填 `code` → 2000「captcha 字段是必须的」；
//           发去 /v4/user/login → 2000「phone 字段是必须的」

import assert from "node:assert/strict"

import { identFields, identKind, generateCaptcha, verifyCaptcha, sendCode, loginByCode } from "../src/captcha.mjs"
import { finishCodeLogin, startSmsLogin, startCodeLogin } from "../src/headless.mjs"
import { SITES } from "../src/api.mjs"

// ── 假服务端 ─────────────────────────────────────────────────────────
let calls = []
let queue = []

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  let body = null
  try {
    body = init.body ? JSON.parse(String(init.body)) : null
  } catch {
    body = String(init.body ?? "")
  }
  calls.push({
    url: String(url),
    method: init.method ?? "GET",
    body,
    headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  })
  const next = queue.shift() ?? { code: 1000, data: {} }
  return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } })
}

const reset = (...responses) => {
  calls = []
  queue = responses
}

const site = SITES.intl
const KE = "https://keewood-service.magicrew.ai"

let pass = 0
let fail = 0
const check = (label, fn) => {
  try {
    fn()
    pass++
    console.log("  ✓ " + label)
  } catch (e) {
    fail++
    console.log("  ✗ " + label)
    console.log("      " + String(e?.message ?? e).split("\n").join("\n      "))
  }
}

// ── ① 标识字段 ───────────────────────────────────────────────────────
console.log("\n① 标识字段：邮箱不带 state_code")

check("email → account_type=email，且**没有** mobile / state_code", () => {
  const f = identFields({ email: "  a@b.com " })
  assert.deepEqual(f, { account_type: "email", email: "a@b.com" })
  assert.ok(!("state_code" in f) && !("mobile" in f))
})

check("mobile → account_type=mobile，带 state_code（默认 +86）", () => {
  assert.deepEqual(identFields({ mobile: "138 0013 8000" }), {
    account_type: "mobile",
    mobile: "13800138000",
    state_code: "+86",
  })
  assert.equal(identFields({ mobile: "13800138000", stateCode: "+1" }).state_code, "+1")
})

check("identKind 认得两种，且邮箱优先", () => {
  assert.equal(identKind({ email: "a@b.com" }), "email")
  assert.equal(identKind({ mobile: "13800138000" }), "mobile")
  assert.equal(identKind({ email: "a@b.com", mobile: "13800138000" }), "email")
})

// ── ② 取图 / 过验证 ──────────────────────────────────────────────────
console.log("\n② 取图与过验证：同一个端点，body 换成邮箱字段")

const gen = async () => {
  reset({ code: 1000, data: { token: "tok_1", image: "data:image/webp;base64,AAAA", expire_time: 1793200000 } })
  return generateCaptcha(site, { email: "a@b.com" })
}

await (async () => {
  const cap = await gen()
  check("取图打到 keewood 的 /captcha/generate", () => {
    assert.equal(calls[0].url, `${KE}/captcha/generate`)
    assert.equal(calls[0].method, "POST")
  })
  check("取图 body = {account_type:email, email}（没有 state_code）", () => {
    assert.deepEqual(calls[0].body, { account_type: "email", email: "a@b.com" })
  })
  check("取图带 origin（网关按它判来源）", () => {
    assert.equal(calls[0].headers.origin, site.web)
  })
  check("返回 token / image / expireAt", () => {
    assert.equal(cap.registered, false)
    assert.equal(cap.token, "tok_1")
    assert.equal(cap.expireAt, 1793200000000)
  })
})()

await (async () => {
  reset({ code: 1000, data: { verified: true, business_token: "biz_x" } })
  const r = await verifyCaptcha(site, { token: "tok_1", deg: 120, email: "a@b.com" })
  check("过验证打到 /captcha/verify，带 token + angle + 邮箱字段", () => {
    assert.equal(calls[0].url, `${KE}/captcha/verify`)
    assert.equal(calls[0].body.token, "tok_1")
    assert.match(String(calls[0].body.angle), /^\d+$/, "angle 必须是加密后的整数串")
    assert.equal(calls[0].body.account_type, "email")
    assert.equal(calls[0].body.email, "a@b.com")
    assert.ok(!("mobile" in calls[0].body), "邮箱那条绝不能带 mobile")
  })
  check("verified=true 时回 businessToken", () => assert.equal(r.businessToken, "biz_x"))
})()

await (async () => {
  // 手机号那条要保证没被顺手改坏
  reset({ code: 1000, data: { verified: true, business_token: "biz_m" } })
  await verifyCaptcha(site, { token: "tok_2", deg: 30, mobile: "13800138000", stateCode: "+86" })
  check("手机号那条仍是 {account_type:mobile, mobile, state_code}", () => {
    assert.deepEqual(calls[0].body, {
      token: "tok_2",
      angle: calls[0].body.angle,
      account_type: "mobile",
      mobile: "13800138000",
      state_code: "+86",
    })
  })
})()

// ── ③ 发码：两个端点 ─────────────────────────────────────────────────
console.log("\n③ 发码：邮箱走 send-email，手机走 send-sms，都用同一个 X-Captcha-Token")

await (async () => {
  reset({ code: 1000, message: "请求成功" })
  const r = await sendCode(site, { email: "a@b.com" }, { businessToken: "biz_x" })
  check("邮箱 → /v4/user/send-email", () => assert.equal(calls[0].url, `${KE}/v4/user/send-email`))
  check("邮箱 body = {email, type:account_login}", () =>
    assert.deepEqual(calls[0].body, { email: "a@b.com", type: "account_login" }))
  check("带上 X-Captcha-Token", () => assert.equal(calls[0].headers["x-captcha-token"], "biz_x"))
  check("code 1000 → ok:true", () => assert.equal(r.ok, true))
})()

await (async () => {
  reset({ code: 2000, message: "服务异常，请联系管理员" })
  const r = await sendCode(site, { email: "a@b.com" }, { businessToken: "biz_x" })
  check("非 1000 → ok:false 且带原始 message", () => {
    assert.equal(r.ok, false)
    assert.equal(r.message, "服务异常，请联系管理员")
  })
})()

await (async () => {
  reset({ code: 1000 })
  await sendCode(site, { mobile: "13800138000" }, { businessToken: "biz_m" })
  check("手机号 → /v4/user/send-sms，body {type, phone, state_code}", () => {
    assert.equal(calls[0].url, `${KE}/v4/user/send-sms`)
    assert.deepEqual(calls[0].body, { type: "account_login", phone: "13800138000", state_code: "+86" })
  })
})()

await (async () => {
  // 关键回归：邮箱**绝不能**落到 send-sms 上
  reset({ code: 1000 })
  await sendCode(site, { email: "a@b.com" }, { businessToken: "b" })
  check("邮箱不会发到 send-sms（端点判据）", () => assert.ok(!/send-sms/.test(calls[0].url)))
})()

// ── ④ 换登录态：两个端点 + 两种字段名 ────────────────────────────────
console.log("\n④ 换登录态：login-email 用 `captcha`，login 用 `code` + type")

await (async () => {
  reset({ code: 2168, message: "验证码错误" })
  await loginByCode(site, { email: "a@b.com", code: "123456", redirect: `${site.web}/login` })
  check("邮箱 → /v4/user/login-email", () => assert.equal(calls[0].url, `${KE}/v4/user/login-email`))
  check("验证码字段是 `captcha`（**不是** code）", () => {
    assert.equal(calls[0].body.captcha, "123456")
    assert.ok(!("code" in calls[0].body), "邮箱那条不能出现 code 字段")
  })
  check("邮箱那条不带 type（服务端按端点分派）", () => assert.ok(!("type" in calls[0].body)))
  check("带上 device {id: 64hex, name:web}", () => {
    assert.match(calls[0].body.device.id, /^[0-9a-f]{64}$/)
    assert.equal(calls[0].body.device.name, "web")
  })
  check("auto_register / redirect 都传（新号注册 + 邀请码靠它们）", () => {
    assert.equal(calls[0].body.auto_register, true)
    assert.equal(calls[0].body.redirect, `${site.web}/login`)
  })
})()

await (async () => {
  reset({ code: 2167, message: "短信验证码无效或已过期" })
  await loginByCode(site, { mobile: "13800138000", code: "123456" })
  check("手机号 → /v4/user/login，type=phone_captcha，字段叫 code", () => {
    assert.equal(calls[0].url, `${KE}/v4/user/login`)
    assert.equal(calls[0].body.type, "phone_captcha")
    assert.equal(calls[0].body.code, "123456")
    assert.equal(calls[0].body.phone, "13800138000")
    assert.equal(calls[0].body.state_code, "+86")
    assert.ok(!("captcha" in calls[0].body), "手机号那条不能出现 captcha 字段")
  })
})()

// ── ⑤ 编排层：错误原样透出 ───────────────────────────────────────────
console.log("\n⑤ 编排层：2168 不该被吞成「登录失败」之外的东西")

await (async () => {
  reset({ code: 2168, message: "验证码错误" })
  let err = null
  try {
    await finishCodeLogin(site, { email: "a@b.com", code: "000000" })
  } catch (e) {
    err = e
  }
  check("邮箱验证码错 → 抛出且带原始 code 2168", () => {
    assert.ok(err, "应该抛")
    assert.equal(err.code, 2168)
    assert.match(err.message, /验证码错误/)
  })
})()

await (async () => {
  // 旧签名必须还能用（tools / 外部脚本会按老签名调）
  reset({ code: 2167, message: "短信验证码无效或已过期" })
  let err = null
  try {
    await startSmsLogin(site, { mobile: "13800138000" })
  } catch (e) {
    err = e
  }
  check("startSmsLogin 旧签名仍可用（转发到 startCodeLogin）", () => {
    assert.ok(err, "本机没识图模型 / 假服务端下应该抛")
    assert.ok(/识图模型|captcha|验证/.test(String(err.message)))
  })
})()

await (async () => {
  check("startCodeLogin 导出可用", () => assert.equal(typeof startCodeLogin, "function"))
})()

// ── ⑥ 免图通道：已注册的号不走旋转验证 ──────────────────────────────
console.log("\n⑥ 免图通道：服务端说已注册，就直接发码（不碰 verify、不要模型）")

await (async () => {
  reset(
    { code: 1000, data: { business_token: "biz_registered" } }, // generate：服务端直接放行
    { code: 1000, message: "请求成功" }, // send-email
  )
  const r = await startCodeLogin(site, { email: "known@example.com" })
  check("只调了 generate + send-email，**没有** /captcha/verify", () => {
    const paths = calls.map((c) => c.url.replace(KE, ""))
    assert.deepEqual(paths, ["/captcha/generate", "/v4/user/send-email"])
  })
  check("business_token 原样带进 X-Captcha-Token", () =>
    assert.equal(calls[1].headers["x-captcha-token"], "biz_registered"))
  check("返回 skippedCaptcha=true（调用方据此换个提示语）", () => {
    assert.equal(r.skippedCaptcha, true)
    assert.equal(r.rounds, 0)
  })
})()

await (async () => {
  // 反例：新号（服务端给了图）**不能**直接发码 —— 它得先过图。
  reset(
    { code: 1000, data: { token: "tok_new", image: "data:image/webp;base64,AAAA", expire_time: 1793200000 } },
  )
  let threw = false
  try {
    await startCodeLogin(site, { email: "brandnew@example.com" })
  } catch {
    threw = true
  }
  check("新号 → 取了图、**没**发码、也没当成免图", () => {
    assert.ok(
      calls.some((c) => c.url.endsWith("/captcha/generate")),
      "没取图",
    )
    assert.ok(
      !calls.some((c) => c.url.endsWith("/v4/user/send-email")),
      "新号竟然直接发码了 —— 免图判断把「没注册」也放行了",
    )
    assert.ok(threw, "假服务端下过不了图，应该抛错")
  })
})()

// ── ⑦ 方法表：国际站四条（邮箱优先），国内站三条（没有邮箱）──────────
console.log("\n⑦ auth.methods：国际站 邮箱优先；国内站没有邮箱那条")

const { MagicrewAuthPlugin, MagicrewIntlAuthPlugin } = await import("../index.mjs")
const cn = await MagicrewAuthPlugin({ client: null, directory: "." })
const intl = await MagicrewIntlAuthPlugin({ client: null, directory: "." })

check("国内站：手机号 → 浏览器 → 登录态，且**没有**邮箱方法", () => {
  const l = cn.auth.methods.map((m) => m.label)
  assert.equal(l.length, 3, `应该 3 条，实际 ${l.length}：${l.join(" / ")}`)
  assert.match(l[0], /手机号验证码/)
  assert.match(l[1], /浏览器登录/)
  assert.match(l[2], /登录态/)
  assert.ok(!l.some((x) => /邮箱/.test(x)), "国内站登录页没有邮箱入口，别摆出来")
})

check("国际站：邮箱 → 手机号 → 浏览器 → 登录态", () => {
  const l = intl.auth.methods.map((m) => m.label)
  assert.equal(l.length, 4, `应该 4 条，实际 ${l.length}：${l.join(" / ")}`)
  assert.match(l[0], /邮箱验证码/)
  assert.match(l[1], /手机号验证码/)
  assert.match(l[2], /浏览器登录/)
  assert.match(l[3], /登录态/)
})

check("两条验证码方法各问一个字段，键名分别是 email / phone", () => {
  const email = intl.auth.methods[0]
  const phone = intl.auth.methods[1]
  assert.equal(email.prompts.length, 1)
  assert.equal(email.prompts[0].key, "email")
  assert.equal(phone.prompts[0].key, "phone")
  assert.equal(email.prompts[0].validate("a@b.com"), undefined)
  assert.ok(email.prompts[0].validate("a@b"), "坏邮箱要拦下")
  assert.equal(phone.prompts[0].validate("13800138000"), undefined)
  assert.ok(phone.prompts[0].validate("1380013800"), "10 位要拦下")
})

check("两类验证码方法都声明 type=oauth（magpie 按它认登录方式）", () => {
  for (const m of [intl.auth.methods[0], intl.auth.methods[1]]) assert.equal(m.type, "oauth")
})

// ── 收尾 ─────────────────────────────────────────────────────────────
globalThis.fetch = realFetch
console.log(`\n${pass} 通过 · ${fail} 失败`)
if (fail) process.exitCode = 1
