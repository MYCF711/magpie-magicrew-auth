// 上游「积分/余额不足」的 400/422 → 402 —— 纯函数测试，不联网。
//
//   node tests/credit-refusal.mjs
//
// 为什么这条要单独钉：
//   magpie 的 retryable() 对 400 只认 quotaWords，不认 creditWords；上游却用
//   400 报「可用积分已不足」。插件不转换 ⇒ 整轮失败、账号不 rest、下一个账号
//   一次都不问。转换必须**只**命中「账户没钱」这一类，绝不能碰 schema/参数 400，
//   否则真正的请求错误会被当成额度问题到处换账号。
//
// 实测出处见 src/hooks/loader.mjs 的 `CREDIT_EXHAUSTED` 段（2026-10-28 23:38
// trace：magicrew@181****710 400 fail=credit，第三个账号余额 6,467 未被询问）。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isCreditExhausted, rewriteCreditRefusal, makeLoader } from "../src/hooks/loader.mjs"
import { siteCtx, SITES } from "../src/context.mjs"

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
    console.log(`      ${e.message.split("\n")[0]}`)
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
    console.log(`      ${e.message.split("\n")[0]}`)
  }
}

const SUPERMAGIC =
  "超级麦吉: 非常抱歉，当前对话需要调用大模型 / 付费工具，您的可用积分已不足。" +
  "您可以点击右上角「用户头像」，通过「充值」通道补充积分，完成后即可继续对话。"

function response(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

console.log("isCreditExhausted —— 只认「账户没钱」，不认请求错误")

check("超级麦吉的真实文案命中", () => {
  assert.equal(isCreditExhausted(SUPERMAGIC), true)
})
check("英文 insufficient credits 命中", () => {
  assert.equal(isCreditExhausted("Insufficient credits. Please top up your account."), true)
})
check("英文 insufficient balance 命中", () => {
  assert.equal(isCreditExhausted('{"error":{"message":"insufficient balance"}}'), true)
})
check("中文「余额不足，请充值」命中", () => {
  assert.equal(isCreditExhausted("余额不足，请充值"), true)
})
check("中文「积分不足」命中", () => {
  assert.equal(isCreditExhausted("您的积分不足"), true)
})
check("schema 校验 400 不命中", () => {
  assert.equal(
    isCreditExhausted(
      "tools.40.function.parameters/properties/functions/items: invalid JSON Schema",
    ),
    false,
  )
})
check("普通参数错误不命中", () => {
  assert.equal(isCreditExhausted("Invalid request parameters: temperature"), false)
})
check("空值安全", () => {
  assert.equal(isCreditExhausted(null), false)
  assert.equal(isCreditExhausted(undefined), false)
})

console.log("\nrewriteCreditRefusal —— 400/422 的额度拒绝改写为 402")

await checkAsync("400 + 超级麦吉文案 → 402，body 原样", async () => {
  const res = response(400, SUPERMAGIC)
  const out = await rewriteCreditRefusal(res)
  assert.equal(out.status, 402)
  assert.equal(out.statusText, "Payment Required")
  assert.equal(await out.text(), SUPERMAGIC)
  assert.equal(out.headers.get("content-type"), "application/json")
})

await checkAsync("改写不消费原响应：原 body 仍可读", async () => {
  const res = response(400, SUPERMAGIC)
  await rewriteCreditRefusal(res)
  assert.equal(await res.text(), SUPERMAGIC)
})

await checkAsync("422 + insufficient credits → 402", async () => {
  const out = await rewriteCreditRefusal(response(422, "insufficient credits"))
  assert.equal(out.status, 402)
  assert.equal(await out.text(), "insufficient credits")
})

await checkAsync("400 + schema 错误 → 原对象原样返回（400 不变）", async () => {
  const res = response(400, "invalid JSON Schema")
  const out = await rewriteCreditRefusal(res)
  assert.equal(out, res)
  assert.equal(out.status, 400)
})

await checkAsync("400 + 普通参数错误 → 原对象原样返回", async () => {
  const res = response(400, "Invalid request parameters")
  assert.equal(await rewriteCreditRefusal(res), res)
})

await checkAsync("402 已是目标状态 → 原对象原样返回", async () => {
  const res = response(402, SUPERMAGIC)
  assert.equal(await rewriteCreditRefusal(res), res)
})

await checkAsync("200 成功响应 → 原对象原样返回（不读流）", async () => {
  const res = response(200, '{"ok":true}')
  assert.equal(await rewriteCreditRefusal(res), res)
})

await checkAsync("content-length / content-encoding 被丢掉，避免解压后长度不符", async () => {
  const res = response(400, SUPERMAGIC, {
    "content-length": String(Buffer.byteLength(SUPERMAGIC)),
    "content-encoding": "gzip",
  })
  const out = await rewriteCreditRefusal(res)
  assert.equal(out.status, 402)
  assert.equal(out.headers.get("content-length"), null)
  assert.equal(out.headers.get("content-encoding"), null)
})

console.log("\nmakeLoader.fetch —— 端到端（拦全局 fetch，不联网）")

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, fetch: globalThis.fetch }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-credit-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
mkdirSync(join(FAKE, ".cache", "magpie"), { recursive: true })

const KEY = "mgw_" + "a".repeat(30)
writeFileSync(
  join(FAKE, ".cache", "magpie", "magicrew-key-magicrew__acc1.json"),
  JSON.stringify({
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: KEY, expiresAt: 4102444800000 }, b: null },
    at: "2026-10-28T00:00:00.000Z",
  }),
)

await checkAsync("上游 400「积分已不足」→ loader 交给 magpie 的是 402", async () => {
  globalThis.fetch = async () =>
    new Response(SUPERMAGIC, { status: 400, headers: { "content-type": "application/json" } })
  const loader = await makeLoader(siteCtx(SITES.cn))(() => ({
    org: "acc1",
    access: KEY,
    refresh: "",
    expires: Date.now() + 3_600_000,
    jwt: "x".repeat(350),
  }))
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash" }),
  })
  assert.equal(res.status, 402)
  assert.equal(await res.text(), SUPERMAGIC)
})

await checkAsync("上游 400 schema 错误 → loader 原样交给 magpie 400", async () => {
  const body = '{"error":{"message":"invalid JSON Schema in tools.40"}}'
  globalThis.fetch = async () =>
    new Response(body, { status: 400, headers: { "content-type": "application/json" } })
  const loader = await makeLoader(siteCtx(SITES.cn))(() => ({
    org: "acc1",
    access: KEY,
    refresh: "",
    expires: Date.now() + 3_600_000,
    jwt: "x".repeat(350),
  }))
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash" }),
  })
  assert.equal(res.status, 400)
  assert.equal(await res.text(), body)
})

await checkAsync("上游 413 HTML → loader 翻译成 JSON 人话", async () => {
  globalThis.fetch = async () =>
    new Response("<html><body>413 Request Entity Too Large</body></html>", {
      status: 413,
      headers: { "content-type": "text/html" },
    })
  const loader = await makeLoader(siteCtx(SITES.cn))(() => ({
    org: "acc1",
    access: KEY,
    refresh: "",
    expires: Date.now() + 3_600_000,
    jwt: "x".repeat(350),
  }))
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash" }),
  })
  assert.equal(res.status, 413)
  assert.match(res.headers.get("content-type") || "", /application\/json/)
  const body = await res.json()
  assert.equal(body.error.type, "payload_too_large")
  assert.match(body.error.message, /8 MB/)
  assert.match(body.error.message, /换账号无效/)
})

// 收尾
globalThis.fetch = ORIG.fetch
for (const [k, v] of Object.entries(ORIG)) {
  if (k === "fetch") continue
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
