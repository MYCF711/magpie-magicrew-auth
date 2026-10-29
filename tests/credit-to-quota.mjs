// 上游「积分不足」的 402 → 「额度已用尽」 —— 纯函数测试，不联网。
//
//   node tests/credit-to-quota.mjs
//
// 为什么这条要单独钉（2026-10-29 实测，本机一天 1,332 次 402）：
//
//   magicrew@178****697                30 分钟内被撞 134 次
//   magicrew-intl@1hsj2j5l08sr         30 分钟内被撞 140 次
//   一次请求 tries=13 —— 13 个国内账号挨个试过去，各回一次 402
//
// 一直撞的机制（对着 magpie 的源码读出来的）：
//
//   1. 宿主把「余额 ≤ 0」读成「用掉 100%」（provider/routing.go 的
//      balance→used 换算），账号进 smart 的最后一档 spent。spent 只是
//      **排在后面**，不是被排除 —— 一池全耗尽时照样挨个试。
//   2. 上游文案里有「充值」，宿主读成 failCredit；failCredit 的休息是
//      **猜的** —— 一分钟后再问一次（routing.go：guessed → askAt），
//      不管那 30 分钟的 rest 有多长。撞 402 → 睡 1 分钟 → 又醒 → 又撞。
//
// 修法只改插件这一层：把「充值 / 积分不足」换成「额度 / 用量」，宿主读成
// failQuota（out-of-quota），休息睡到它说的那一刻 —— 配合 auth.usage 报的
// resetsAt（余额 ≤ 0 时报下一次补充积分的时刻），就是睡到次日积分补上。
//
// 改写必须**只**命中「账户没钱」这一类：schema 错误、参数错误、别的 402
// 一律不动，否则真正的请求错误会被当成额度问题到处换账号。
// 原始文案也不能丢 —— 但**不能留在 body 里**：宿主判词是通读整个 body 的，
// body 里只要还留一个「充值」，它就仍然读成 out-of-credit，老毛病照旧。
// 所以原文放进响应头 X-Magpie-Origin-Reason。

import assert from "node:assert/strict"
import { rewriteCreditToQuota, isCreditExhausted } from "../src/hooks/loader.mjs"

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

// 宿主 magpie 的 failure()：402 + 命中 usedUpWords（额度|用量|上限…）且
// 不命中 creditWords（余额|充值|欠费…）⇒ failQuota；否则 failCredit。
// 这几个断言把那套词表抄在这儿，改文案时就不会悄悄失效。
const USED_UP = /(?:quota|usage.?limit|out of budget|budget (?:exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(?:plan|limit)|额度|用量|套餐|上限)/i
const CREDIT = /(?:insufficient.?(?:balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(?:不足|停))/i

const UPSTREAM_MSG =
  "超级麦吉: 非常抱歉，当前对话需要调用大模型 / 付费工具，您的可用积分已不足。" +
  "您可以点击右上角「用户头像」，通过「充值」通道补充积分，完成后即可继续对话。"

function jsonResponse(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

console.log("rewriteCreditToQuota —— 402 的积分不足改写为「额度已用尽」")

await checkAsync("402 + 超级麦吉文案 → 正文换成额度语义，原文放响应头", async () => {
  const res = jsonResponse(402, { error: { message: UPSTREAM_MSG, type: "invalid_request_error" } })
  const out = await rewriteCreditToQuota(res)
  assert.equal(out.status, 402)
  assert.equal(out.statusText, "Payment Required")
  const body = await out.json()
  assert.match(body.error.message, /额度/)
  assert.match(body.error.message, /用量/)
  // 原文一字不落地放在响应头里（body 里不能留 —— 宿主判词通读整个 body）
  assert.equal(decodeURIComponent(out.headers.get("x-magpie-origin-reason") || ""), UPSTREAM_MSG)
  // body 里不含「充值」「积分不足」—— 宿主正是靠这两个词读成 out-of-credit
  assert.doesNotMatch(JSON.stringify(body), /充值/)
  assert.doesNotMatch(JSON.stringify(body), /积分不足/)
})

await checkAsync("body 整个都不含 credit 词（宿主 wordsOf 读的是全文）", async () => {
  const res = jsonResponse(402, { error: { message: UPSTREAM_MSG } })
  const out = await rewriteCreditToQuota(res)
  const text = await out.text()
  assert.equal(CREDIT.test(text), false, `body 里不能有 credit 词: ${text}`)
  assert.equal(USED_UP.test(text), true, `body 里要有 quota 词: ${text}`)
})

await checkAsync("改写不消费原响应：原 body 仍可读", async () => {
  const res = jsonResponse(402, { error: { message: UPSTREAM_MSG } })
  await rewriteCreditToQuota(res)
  const body = await res.json()
  assert.equal(body.error.message, UPSTREAM_MSG)
})

await checkAsync("402 + 英文 insufficient credits → 同样改写", async () => {
  const res = jsonResponse(402, { error: { message: "Insufficient credits. Please top up." } })
  const out = await rewriteCreditToQuota(res)
  assert.equal(out.status, 402)
  const body = await out.json()
  assert.match(body.error.message, /额度/)
  assert.equal(
    decodeURIComponent(out.headers.get("x-magpie-origin-reason") || ""),
    "Insufficient credits. Please top up.",
  )
})

await checkAsync("400 → 原对象原样返回（那是 rewriteCreditRefusal 的活）", async () => {
  const res = jsonResponse(400, { error: { message: UPSTREAM_MSG } })
  assert.equal(await rewriteCreditToQuota(res), res)
})

await checkAsync("200 → 原对象原样返回（不读流）", async () => {
  const res = jsonResponse(200, { ok: true })
  assert.equal(await rewriteCreditToQuota(res), res)
})

await checkAsync("402 + 别的错误（不是没钱）→ 原对象原样返回", async () => {
  const res = jsonResponse(402, { error: { message: "invalid JSON Schema in tools.40" } })
  assert.equal(await rewriteCreditToQuota(res), res)
})

await checkAsync("402 + 非 JSON 正文 → 原对象原样返回", async () => {
  const res = new Response("<html>402 Payment Required</html>", {
    status: 402,
    headers: { "content-type": "text/html" },
  })
  assert.equal(await rewriteCreditToQuota(res), res)
})

await checkAsync("402 + JSON 但没有 error.message → 原对象原样返回", async () => {
  const res = jsonResponse(402, { code: 12000 })
  assert.equal(await rewriteCreditToQuota(res), res)
})

await checkAsync("content-length / content-encoding 被丢掉，避免解压后长度不符", async () => {
  const raw = JSON.stringify({ error: { message: UPSTREAM_MSG } })
  const res = new Response(raw, {
    status: 402,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
      "content-encoding": "gzip",
    },
  })
  const out = await rewriteCreditToQuota(res)
  assert.equal(out.status, 402)
  assert.equal(out.headers.get("content-length"), null)
  assert.equal(out.headers.get("content-encoding"), null)
  assert.match(out.headers.get("content-type") || "", /application\/json/)
})

console.log("\n判定口径 —— 改写后的正文必须被宿主读成 out-of-quota")

await checkAsync("改写后的正文：命中 quota 词、不命中 credit 词", async () => {
  const res = jsonResponse(402, { error: { message: UPSTREAM_MSG } })
  const out = await rewriteCreditToQuota(res)
  const msg = (await out.json()).error.message
  assert.equal(USED_UP.test(msg), true, `应命中 quota 词表: ${msg}`)
  assert.equal(CREDIT.test(msg), false, `不该命中 credit 词表: ${msg}`)
})

await checkAsync("原文（未改写）：命中 credit 词 —— 这正是要修的那条", async () => {
  assert.equal(CREDIT.test(UPSTREAM_MSG), true)
  assert.equal(USED_UP.test(UPSTREAM_MSG), false)
})

await checkAsync("其它 402 的文案不被误判成「没钱」", async () => {
  assert.equal(isCreditExhausted("invalid JSON Schema in tools.40"), false)
  assert.equal(isCreditExhausted("model not found"), false)
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
