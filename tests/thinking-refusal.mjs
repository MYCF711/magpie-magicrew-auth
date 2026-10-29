// 上游拒绝 thinking 参数 → 换形状 / 剥掉，而不是把整轮打死
//
//   node tests/thinking-refusal.mjs
//
// 纯函数 + 假 send，不联网、不读凭据、不依赖 magpie。
//
// 为什么单独立一个文件：这条降级链在热路径上，而且它**会重发请求**（可能计费）。
// 一旦哪天真把它改成"任何 400 都重发"，就会悄悄地：
//   · 把 schema 错误、积分不足也重发一遍（白烧两次积分）
//   · 把真实故障伪装成"参数问题已修复"
// 所以边界要钉死：只认那两条实测文案，只动那三个字段。

import assert from "node:assert/strict"
import {
  isThinkingBudgetText,
  isThinkingBudgetRefusal,
  sendSkippingThinking,
  stripReasoning,
  toAdaptiveThinking,
} from "../src/hooks/loader.mjs"

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

// ── 实测原文（2026-10-29，magicrew-intl/claude-haiku-5.5 经 magpie 网关）
const REFUSAL_BUDGET =
  '{"code":null,"message":"MagiCrew: Thinking budget must be below the output token limit.","param":null,"type":"invalid_request_error"}'
const REFUSAL_ADAPTIVE =
  '{"code":null,"message":"MagiCrew: HTTP 400 请求错误: {\\"error\\":{\\"message\\":\\"thinking.budget_tokens: Manual thinking budgets are not supported; use ***.type=adaptive and output_config.effort (request id: 202610290910152067515928268d9d6Gl0FaYwJ)\\",\\"type\\":\\"<nil>\\",\\"requestid\\":\\"x\\"}}","param":null,"type":"invalid_request_error"}'

function jsonRes(status, body) {
  return new Response(body, { status, headers: { "content-type": "application/json" } })
}

console.log("isThinkingBudgetText —— 只认那两条实测文案")

check("MagiCrew 的 Thinking budget must be below…", () => {
  assert.equal(isThinkingBudgetText(REFUSAL_BUDGET), true)
})

check("Anthropic 的 Manual thinking budgets are not supported…", () => {
  assert.equal(isThinkingBudgetText(REFUSAL_ADAPTIVE), true)
})

check("Bedrock 转发的那条（字段名被 MagiCrew 打成 ***）也认", () => {
  assert.equal(
    isThinkingBudgetText(
      '"***.***.enabled" is not supported for this model. Use "***.***.adaptive" and "output_config.effort"',
    ),
    true,
  )
})

check("同一句不打码时也认", () => {
  assert.equal(
    isThinkingBudgetText('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"'),
    true,
  )
})

check("别的 not supported for this model 不吃（没有 adaptive 字样）", () => {
  assert.equal(isThinkingBudgetText("max_tokens is not supported for this model"), false)
})

check("裸 thinking.budget_tokens 字段报错也认", () => {
  assert.equal(isThinkingBudgetText('{"error":{"message":"thinking.budget_tokens: 32000"}}'), true)
})

check("schema 错误不算（会白重发一次）", () => {
  assert.equal(
    isThinkingBudgetText('{"error":{"message":"tools.40.function.parameters/properties/functions/items: invalid JSON Schema"}}'),
    false,
  )
})

check("积分不足不算（有自己的 402 通路）", () => {
  assert.equal(isThinkingBudgetText('{"message":"超级麦吉: 您的可用积分已不足"}'), false)
})

check("空文本不算", () => {
  assert.equal(isThinkingBudgetText(""), false)
  assert.equal(isThinkingBudgetText(undefined), false)
})

console.log("\nisThinkingBudgetRefusal —— 只读 400/422 的 JSON，不碰流")

await checkAsync("400 + 实测文案 → true", async () => {
  assert.equal(await isThinkingBudgetRefusal(jsonRes(400, REFUSAL_BUDGET)), true)
})

await checkAsync("422 + 实测文案 → true", async () => {
  assert.equal(await isThinkingBudgetRefusal(jsonRes(422, REFUSAL_BUDGET)), true)
})

await checkAsync("200 → false（哪怕正文里有这几个字）", async () => {
  assert.equal(await isThinkingBudgetRefusal(jsonRes(200, REFUSAL_BUDGET)), false)
})

await checkAsync("400 但 content-type 不是 JSON（SSE/纯文本）→ false，不读流", async () => {
  const res = new Response("Thinking budget must be below", {
    status: 400,
    headers: { "content-type": "text/event-stream" },
  })
  assert.equal(await isThinkingBudgetRefusal(res), false)
})

await checkAsync("undefined → false", async () => {
  assert.equal(await isThinkingBudgetRefusal(undefined), false)
})

await checkAsync("读一次 clone 不影响原响应再读", async () => {
  const res = jsonRes(400, REFUSAL_BUDGET)
  await isThinkingBudgetRefusal(res)
  const text = await res.text()
  assert.ok(text.includes("Thinking budget"))
})

console.log("\ntoAdaptiveThinking —— reasoning_effort → adaptive + output_config.effort")

check("max → thinking.adaptive + output_config.effort=max", () => {
  const out = JSON.parse(
    toAdaptiveThinking(JSON.stringify({ model: "claude-haiku-5.5", max_tokens: 64000, reasoning_effort: "max" })),
  )
  assert.deepEqual(out.thinking, { type: "adaptive" })
  assert.equal(out.output_config.effort, "max")
  assert.equal(Object.hasOwn(out, "reasoning_effort"), false)
  assert.equal(out.max_tokens, 64000, "别的字段一个都不许动")
})

check("xhigh → max（Anthropic 没有 xhigh）", () => {
  const out = JSON.parse(toAdaptiveThinking(JSON.stringify({ reasoning_effort: "xhigh" })))
  assert.equal(out.output_config.effort, "max")
})

check("minimal → low（Anthropic 最低是 low）", () => {
  const out = JSON.parse(toAdaptiveThinking(JSON.stringify({ reasoning_effort: "minimal" })))
  assert.equal(out.output_config.effort, "low")
})

check("reasoning:{effort} 形状也认", () => {
  const out = JSON.parse(toAdaptiveThinking(JSON.stringify({ reasoning: { effort: "high", summary: "auto" } })))
  assert.equal(out.output_config.effort, "high")
  assert.equal(Object.hasOwn(out, "reasoning"), false)
})

check("已有的 output_config.format 保留", () => {
  const out = JSON.parse(
    toAdaptiveThinking(JSON.stringify({ reasoning_effort: "high", output_config: { format: { type: "json_schema" } } })),
  )
  assert.equal(out.output_config.effort, "high")
  assert.deepEqual(out.output_config.format, { type: "json_schema" })
})

check("magpie 转出的 thinking.enabled+budget 也能换成 adaptive", () => {
  const out = JSON.parse(toAdaptiveThinking(JSON.stringify({ model: "claude-haiku-5.5", thinking: { type: "enabled", budget_tokens: 32000 } })))
  assert.deepEqual(out.thinking, { type: "adaptive" })
  assert.equal(out.output_config.effort, "max", "32000 落在 xhigh 档，再折成 max")
})

check("budget 分档：4096→low、10000→medium、24000→high", () => {
  for (const [budget, want] of [[4096, "low"], [10000, "medium"], [24000, "high"]]) {
    const out = JSON.parse(toAdaptiveThinking(JSON.stringify({ thinking: { type: "enabled", budget_tokens: budget } })))
    assert.equal(out.output_config.effort, want, `${budget} → ${want}`)
  }
})

check("budget 是 0/缺失 → null（没要思考）", () => {
  assert.equal(toAdaptiveThinking(JSON.stringify({ thinking: { type: "enabled" } })), null)
  assert.equal(toAdaptiveThinking(JSON.stringify({ thinking: { type: "enabled", budget_tokens: 0 } })), null)
})

check("没有 effort → null（不该碰这种请求）", () => {
  assert.equal(toAdaptiveThinking(JSON.stringify({ model: "x", max_tokens: 64 })), null)
})

check("非字符串 / 坏 JSON → null", () => {
  assert.equal(toAdaptiveThinking(undefined), null)
  assert.equal(toAdaptiveThinking("{oops"), null)
})

console.log("\nstripReasoning —— 保底：能跑永远比能思考重要")

check("三个字段 + output_config.effort 全删", () => {
  const out = JSON.parse(
    stripReasoning(
      JSON.stringify({
        reasoning_effort: "max",
        reasoning: { effort: "max" },
        thinking: { type: "enabled", budget_tokens: 32000 },
        output_config: { effort: "max" },
        messages: [],
      }),
    ),
  )
  assert.equal(Object.hasOwn(out, "reasoning_effort"), false)
  assert.equal(Object.hasOwn(out, "reasoning"), false)
  assert.equal(Object.hasOwn(out, "thinking"), false)
  assert.equal(Object.hasOwn(out, "output_config"), false, "空的 output_config 一起删")
  assert.deepEqual(out.messages, [])
})

check("output_config 里还有 format 就保留它，只删 effort", () => {
  const out = JSON.parse(
    stripReasoning(JSON.stringify({ thinking: { type: "enabled" }, output_config: { effort: "high", format: { type: "x" } } })),
  )
  assert.deepEqual(out.output_config, { format: { type: "x" } })
  assert.equal(Object.hasOwn(out, "thinking"), false)
})

check("一个都没有 → null（没必要重发）", () => {
  assert.equal(stripReasoning(JSON.stringify({ model: "x", messages: [] })), null)
})

console.log("\nsendSkippingThinking —— 降级链（假 send，不联网）")

/** 一个记下每次 payload 的假 send */
function fakeSend(statuses) {
  const seen = []
  let i = 0
  const send = async (payload) => {
    seen.push(payload)
    const st = statuses[Math.min(i, statuses.length - 1)]
    i++
    return st === 200
      ? jsonRes(200, '{"choices":[{"message":{"role":"assistant","content":"ok"}}]}')
      : jsonRes(st, REFUSAL_BUDGET)
  }
  return { send, seen }
}

await checkAsync("第一次 400 → 换形状重发 → 200，一共两次", async () => {
  const { send, seen } = fakeSend([400, 200])
  const req = JSON.stringify({ model: "claude-haiku-5.5", max_tokens: 64000, reasoning_effort: "max", messages: [] })
  const res = await sendSkippingThinking(send, req)
  assert.equal(res.status, 200)
  assert.equal(seen.length, 2)
  const second = JSON.parse(seen[1])
  assert.deepEqual(second.thinking, { type: "adaptive" })
  assert.equal(second.output_config.effort, "max")
  assert.equal(second.max_tokens, 64000)
})

await checkAsync("换形状也被拒 → 剥光重发 → 200，一共三次", async () => {
  const { send, seen } = fakeSend([400, 400, 200])
  const req = JSON.stringify({ model: "claude-haiku-5.5", reasoning_effort: "max", messages: [] })
  const res = await sendSkippingThinking(send, req)
  assert.equal(res.status, 200)
  assert.equal(seen.length, 3)
  const third = JSON.parse(seen[2])
  assert.equal(Object.hasOwn(third, "reasoning_effort"), false)
  assert.equal(Object.hasOwn(third, "thinking"), false)
  assert.equal(Object.hasOwn(third, "output_config"), false)
})

await checkAsync("三次都被拒 → 交回带 code 的错误（不再是无码裸 400）", async () => {
  const { send, seen } = fakeSend([400, 400, 400])
  const req = JSON.stringify({ model: "claude-haiku-5.5", reasoning_effort: "max", messages: [] })
  const res = await sendSkippingThinking(send, req)
  assert.equal(res.status, 400)
  assert.equal(seen.length, 3)
  const body = JSON.parse(await res.text())
  assert.equal(body.error.code, "thinking_unsupported")
  assert.ok(body.error.message.includes("Thinking budget must be below"), "上游原文要带出来")
})

await checkAsync("magpie 已转出手动 budget 时，也要走换形状（不能直接剥光）", async () => {
  const { send, seen } = fakeSend([400, 200])
  const req = JSON.stringify({ model: "claude-haiku-5.5", max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 32000 }, messages: [] })
  const res = await sendSkippingThinking(send, req)
  assert.equal(res.status, 200)
  assert.equal(seen.length, 2, "换形状一次就该成，不该走到剥光")
  const second = JSON.parse(seen[1])
  assert.deepEqual(second.thinking, { type: "adaptive" })
  assert.equal(second.output_config.effort, "max")
})

await checkAsync("第一次就 200 → 只发一次，body 原样", async () => {
  const { send, seen } = fakeSend([200])
  const req = JSON.stringify({ model: "x", reasoning_effort: "max", messages: [] })
  const res = await sendSkippingThinking(send, req)
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], req)
})

await checkAsync("400 是**别的**错误（schema）→ 一次都不重发", async () => {
  const seen = []
  const send = async (payload) => {
    seen.push(payload)
    return jsonRes(400, '{"error":{"message":"tools.40.function.parameters: invalid JSON Schema"}}')
  }
  const req = JSON.stringify({ model: "x", reasoning_effort: "max", tools: [] })
  const res = await sendSkippingThinking(send, req)
  assert.equal(res.status, 400)
  assert.equal(seen.length, 1)
  assert.ok((await res.text()).includes("invalid JSON Schema"))
})

await checkAsync("400 但没有思考参数可动 → 原样交回，不重发", async () => {
  const { send, seen } = fakeSend([400])
  const req = JSON.stringify({ model: "x", messages: [] })
  const res = await sendSkippingThinking(send, req)
  assert.equal(res.status, 400)
  assert.equal(seen.length, 1)
  const body = JSON.parse(await res.text())
  assert.equal(Object.hasOwn(body, "error") && body.error.code !== undefined, false, "不是我们造的错误就别加码")
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
