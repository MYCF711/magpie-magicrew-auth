// 「谁有权说这个账号登录失效」—— WAF 拦下来的 403 **不算**。
//
//   node tests/auth-rejection.mjs
//
// ═══ 为什么这条要单独钉 ═══════════════════════════════════════════════════
//
// 2026-11-03 真机：magpie 的账号页上，国内站五个号齐刷刷
// 「已欠费 · 已退出登录 —— 请在「供应商」中此账号上选择「重新登录」」。
// 每个号右边还挂着「需要重新登录」按钮。
//
// 但它们的 JWT 全都还有二十多天，余额只是 -5 这种负数（真欠费）。实测：
//
//   curl -A "curl/8.0" -H "authorization: Bearer <那个号的 JWT>" \
//        -H "organization-code: <org>" \
//        https://i-magic-service.letsmagic.cn/api/v1/quota/points/total
//   → 200 {"code":1000,"data":{"total_points":-5,…}}
//
// 也就是说：账号既没掉登录、也不该被要求重新登录。真正发生的是
//
//   火山 WAF 把插件整段拦下 → 回**空 body 的 403**
//   → api.mjs 的 read() 抛出 message = "HTTP 403"
//   → refresh.mjs 旧判据 `/invalid|expired|401|403|token/.test(message)` 命中
//   → 抛 `signIn:"expired"`
//   → magpie 往 logins.json 该账号写 `lapsed`
//   → 界面显示「需要重新登录」
//
// 一条请求被边缘层挡掉，最后变成「你的账号密码没了」。这条测试锁住：
//
//   ① 空 body / HTML 页（边缘层拦的）→ **绝不**判登录失效；
//   ② 只有上游**自己**拿 JSON 说凭证不行，才算失效；
//   ③ 消息里出现 "403" 这三个字符本身，再也不能当判据；
//   ④ refresh 钩子对 WAF 错误抛的是普通错误 —— 不带 signIn 字段，
//      magpie 会保留登录态，下一轮继续试。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAuthRejection, fetchPoints, SITES } from "../src/api.mjs"
import { makeRefresh } from "../src/hooks/refresh.mjs"
import { neutralLapse } from "../src/hooks/usage.mjs"
import { siteCtx } from "../src/context.mjs"

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${String(e?.message ?? e).split("\n")[0]}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${String(e?.message ?? e).split("\n")[0]}`)
  }
}

// ── 假环境：refresh 会碰 key-store，给它一个空 HOME ─────────────────────
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-authrej-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
mkdirSync(join(FAKE, ".cache", "magpie"), { recursive: true })

const ORIG_FETCH = globalThis.fetch

/** 把上游下一次响应钉成给定的那一份。 */
function stub(response) {
  globalThis.fetch = async () => response
  return () => { globalThis.fetch = ORIG_FETCH }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })

// 四种「看起来都是失败」的响应，性质完全不同。
const WAF_EMPTY_403 = () => new Response("", { status: 403 }) // 火山 WAF：空 body
const WAF_HTML_405 = () =>
  new Response("<!doctype html><html lang=\"zh-cn\"><head><title>405</title></head><body>…</body></html>", {
    status: 405,
  }) // 阿里云 ESA：整页 HTML
const REAL_BAD_TOKEN = () => json({ code: 403, message: "token无效" }) // 上游 Go 服务自己说的
const REAL_NOT_LOGGED_IN = () => json({ code: 2179, message: "auth_token 不存在" })

const auth = (tag) => ({ org: `acc-${tag}`, jwt: "x".repeat(350), refresh: `rt_${tag}` })

// ══ 一、read()：先分清「谁答的」 ═══════════════════════════════════════

console.log("错误来源分层：edge（边缘层拦的）vs 上游业务错误")

/** 捞 read() 抛出来的那个错误对象 */
async function catchFrom(response) {
  const restore = stub(response)
  try {
    await fetchPoints(auth("x").jwt, "org", SITES.cn.host)
    return null
  } catch (e) {
    return e
  } finally {
    restore()
  }
}

await checkAsync("空 body 的 403 → edge=true（WAF 拦的，不是上游答的）", async () => {
  const e = await catchFrom(WAF_EMPTY_403())
  assert.ok(e, "本该抛错")
  assert.equal(e.edge, true, `edge 应为 true，实际 ${e.edge}`)
  assert.equal(e.status, 403)
  assert.equal(isAuthRejection(e), false, "WAF 的 403 不许判成登录失效")
})

await checkAsync("整页 HTML 的 405 → edge=true", async () => {
  const e = await catchFrom(WAF_HTML_405())
  assert.ok(e, "本该抛错")
  assert.equal(e.edge, true)
  assert.equal(isAuthRejection(e), false)
  assert.match(String(e.message), /HTML 错误页/, "也不该把整页 HTML 塞进文案")
})

await checkAsync('上游 JSON {"code":403,"message":"token无效"} → edge=false，判失效', async () => {
  const e = await catchFrom(REAL_BAD_TOKEN())
  assert.ok(e, "本该抛错")
  assert.equal(e.edge, false)
  assert.equal(e.code, 403)
  assert.equal(isAuthRejection(e), true)
})

await checkAsync('上游 JSON {"code":2179,"message":"auth_token 不存在"} → 判失效', async () => {
  const e = await catchFrom(REAL_NOT_LOGGED_IN())
  assert.ok(e, "本该抛错")
  assert.equal(isAuthRejection(e), true)
})

// ══ 二、isAuthRejection 的判据边界 ═════════════════════════════════════

console.log("判据边界：只有上游自己说的凭证问题才算")

check("裸 Error(\"HTTP 403\") → false（『403』三个字符不再是证据）", () => {
  assert.equal(isAuthRejection(new Error("HTTP 403")), false)
})
check('裸 Error("fetch failed") → false', () => {
  assert.equal(isAuthRejection(new Error("fetch failed")), false)
})
check("超时 / 网络错误 → false", () => {
  assert.equal(isAuthRejection(new Error("The operation was aborted due to timeout")), false)
  assert.equal(isAuthRejection(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })), false)
})
check("HTTP 500 / 502 / 503 → false", () => {
  for (const s of [500, 502, 503]) {
    const e = Object.assign(new Error(`HTTP ${s}`), { status: s, edge: false })
    assert.equal(isAuthRejection(e), false, `HTTP ${s} 不该判失效`)
  }
})
check("HTTP 401 但空 body（边缘层）→ false", () => {
  assert.equal(isAuthRejection(Object.assign(new Error("HTTP 401"), { status: 401, edge: true })), false)
})
check("上游业务码 401/403 → true", () => {
  assert.equal(isAuthRejection(Object.assign(new Error("nope"), { code: 403 })), true)
  assert.equal(isAuthRejection(Object.assign(new Error("nope"), { code: 401 })), true)
})
check("文案命中 token / 未登录 / 登录已失效 → true", () => {
  for (const m of ["token无效", "token 无效", "invalid token", "auth_token 不存在", "未登录", "请先登录", "登录已失效", "凭证已过期"]) {
    assert.equal(isAuthRejection(new Error(m)), true, `应判失效：${m}`)
  }
})
check("null / undefined → false", () => {
  assert.equal(isAuthRejection(null), false)
  assert.equal(isAuthRejection(undefined), false)
})

// ══ 三、refresh 钩子：WAF 错误不许带 signIn ════════════════════════════

console.log("refresh 钩子：只有真失效才还 signIn:\"expired\" 给 magpie")

/** 跑一次 refresh，返回它抛出的错误（成功则 null） */
async function refreshError(response, tag) {
  const restore = stub(response)
  const hook = makeRefresh(siteCtx(SITES.cn))
  try {
    await hook(auth(tag))
    return null
  } catch (e) {
    return e
  } finally {
    restore()
  }
}

await checkAsync("WAF 空 403 → 抛普通错误，**不带** signIn", async () => {
  const e = await refreshError(WAF_EMPTY_403(), "waf1")
  assert.ok(e, "本该抛错（这次确实没续上）")
  assert.equal(e.signIn, undefined, `不该带 signIn，实际 ${e.signIn}`)
})

await checkAsync("WAF HTML 405 → 抛普通错误，**不带** signIn", async () => {
  const e = await refreshError(WAF_HTML_405(), "waf2")
  assert.ok(e, "本该抛错")
  assert.equal(e.signIn, undefined)
})

await checkAsync("真 token 无效 → signIn:\"expired\"（这条必须留着）", async () => {
  const e = await refreshError(REAL_BAD_TOKEN(), "real1")
  assert.ok(e, "本该抛错")
  assert.equal(e.signIn, "expired", "上游说 token 无效时必须让用户重新登录")
  assert.match(String(e.message), /登录已失效/)
})

// ══ 四、usage 的 error 文案：不许成为「登录失效」的旁门 ═══════════════
//
// magpie 读 usage 结果时还有一条**只看文案**的口子（plugin_usage.go 的
// signInGone 正则 `(?i)sign-in has (expired|lapsed)|sign in again`）：
// error 里出现这几个词就照样写 lapsed。而这句 error 的来源是上游响应，
// 边缘层渲染页里带这种英文完全可能 —— 网络层的一句话不该变成账号状态。

console.log('usage 的 error 文案：把「登录失效」的中英文说法中性化')

check("上游文案里的 sign-in has expired / sign in again 被抹掉", () => {
  const src = "Your Super Magic sign-in has expired — sign in again"
  const out = neutralLapse(src)
  assert.ok(!/sign[\s-]*in/i.test(out), `不该留下 sign-in：${out}`)
  assert.ok(!/again/i.test(out), `不该留下 again：${out}`)
})

check("正常文案原样透传（不误伤）", () => {
  const src = "上游返回 HTML 错误页（HTTP 405），不是接口响应"
  assert.equal(neutralLapse(src), src)
  assert.equal(neutralLapse("HTTP 403"), "HTTP 403")
})

await checkAsync("refresh_token 被吊销（code 2179）→ signIn:\"expired\"", async () => {
  const e = await refreshError(REAL_NOT_LOGGED_IN(), "real2")
  assert.ok(e)
  assert.equal(e.signIn, "expired")
})

// ══ 收尾 ═══════════════════════════════════════════════════════════════

globalThis.fetch = ORIG_FETCH
for (const [k, v] of Object.entries(ORIG)) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
