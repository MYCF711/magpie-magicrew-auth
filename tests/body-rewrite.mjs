// 请求体改写：additionalProperties:{} → true + items:{} 删除
//             + max_tokens / stream_options
//
//   node tests/body-rewrite.mjs
//
// 纯函数测试，不联网、不读凭据、不依赖 magpie。
//
// 为什么单独立一个文件：这些改写都在热路径上（每个请求都过），
// 而 schema 那两条的依据是上游对**空对象**回 400 ——
// 一旦改写把有约束的 schema 也换掉，就会静默改变模型看到的工具定义，
// 这种错不会报错，只会让工具调用行为变得莫名其妙。所以边界要钉死。

import assert from "node:assert/strict"
import {
  loosenAdditionalProperties,
  loosenEmptyItems,
  rewriteRequestBody,
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

console.log("loosenAdditionalProperties —— 非布尔值一律换 true，布尔值一律不动")

check("{} → true，并报告改到了", () => {
  const p = { type: "object", additionalProperties: {} }
  assert.equal(loosenAdditionalProperties(p), true)
  assert.equal(p.additionalProperties, true)
})

// ⚠ 这条与上游实测绑定：上游不是"只认布尔"，是**根本不支持 schema 形态** ——
// 有约束的 {type:"string"} 一样 400。所以也只能换成 true（降级放宽，注释里有取舍说明）。
check('有约束的 {type:"string"} 也换成 true', () => {
  const p = { additionalProperties: { type: "string" } }
  assert.equal(loosenAdditionalProperties(p), true)
  assert.equal(p.additionalProperties, true)
})

check("已经是 true 的不算改动", () => {
  const p = { additionalProperties: true }
  assert.equal(loosenAdditionalProperties(p), false)
  assert.equal(p.additionalProperties, true)
})

check("false 绝对不动（「不许额外属性」，换掉就是放开——语义相反）", () => {
  const p = { additionalProperties: false }
  assert.equal(loosenAdditionalProperties(p), false)
  assert.equal(p.additionalProperties, false)
  // 混在 tools 里也一样
  const raw = JSON.stringify({ tools: [{ function: { parameters: { type: "object", additionalProperties: false } } }] })
  assert.equal(rewriteRequestBody(raw), raw)
})

check("嵌套在 properties 里也改写", () => {
  const p = { type: "object", properties: { inner: { type: "object", additionalProperties: {} } } }
  assert.equal(loosenAdditionalProperties(p), true)
  assert.equal(p.properties.inner.additionalProperties, true)
})

check("数组分支（anyOf / oneOf）也扫，非布尔的都换", () => {
  const p = { anyOf: [{ additionalProperties: {} }, { additionalProperties: { type: "number" } }] }
  assert.equal(loosenAdditionalProperties(p), true)
  assert.equal(p.anyOf[0].additionalProperties, true)
  assert.equal(p.anyOf[1].additionalProperties, true)
})

check("键名只是包含 additionalProperties 子串的不误伤", () => {
  const p = { properties: { myAdditionalProperties: { type: "object" } } }
  assert.equal(loosenAdditionalProperties(p), false)
})

check("数组当值（非法 schema）也换 —— 上游反正不认", () => {
  const p = { additionalProperties: [] }
  assert.equal(loosenAdditionalProperties(p), true)
  assert.equal(p.additionalProperties, true)
})

check("空对象 / null / 原始值返回 false", () => {
  assert.equal(loosenAdditionalProperties({}), false)
  assert.equal(loosenAdditionalProperties(null), false)
  assert.equal(loosenAdditionalProperties(undefined), false)
  assert.equal(loosenAdditionalProperties("x"), false)
  assert.equal(loosenAdditionalProperties(42), false)
})

console.log("\nloosenEmptyItems —— items: {} / true 删除，其余一律不动")

check("{} 删除，并报告改到了", () => {
  const p = { type: "object", properties: { functions: { type: "array", items: {} } } }
  assert.equal(loosenEmptyItems(p), true)
  assert.equal(p.properties.functions.items, undefined)
})

check("true 也删除（与 {} 一样表示「任意元素」）", () => {
  const p = { type: "array", items: true }
  assert.equal(loosenEmptyItems(p), true)
  assert.equal(p.items, undefined)
})

// ⚠ 上游只对**空对象**回 invalid JSON Schema；带一个键就收。
// 如果把 {description} 也删了，就白白丢掉客户端给的说明。
check('{description:"x"} 保留 —— 上游收，不是"缺 type 就炸"', () => {
  const p = { type: "array", items: { description: "x" } }
  assert.equal(loosenEmptyItems(p), false)
  assert.deepEqual(p.items, { description: "x" })
})

check('{type:"string"} 保留', () => {
  const p = { type: "array", items: { type: "string" } }
  assert.equal(loosenEmptyItems(p), false)
  assert.deepEqual(p.items, { type: "string" })
})

check("false 绝对不动（「数组必须为空」，删掉就是放开）", () => {
  const p = { type: "array", items: false }
  assert.equal(loosenEmptyItems(p), false)
  assert.equal(p.items, false)
})

check("嵌套在 properties / items / anyOf 里也删", () => {
  const p = {
    type: "object",
    properties: {
      a: { type: "array", items: { type: "array", items: {} } },
      b: { anyOf: [{ type: "array", items: {} }, { type: "string" }] },
    },
  }
  assert.equal(loosenEmptyItems(p), true)
  assert.equal(p.properties.a.items.items, undefined)
  assert.equal(p.properties.b.anyOf[0].items, undefined)
})

check("属性名恰好叫 items 的，删的是它自己的 items 键，不是这个属性", () => {
  const p = { type: "object", properties: { items: { type: "array", items: {} } } }
  assert.equal(loosenEmptyItems(p), true)
  assert.ok(p.properties.items)
  assert.equal(p.properties.items.items, undefined)
})

check("空对象 / null / 原始值返回 false", () => {
  assert.equal(loosenEmptyItems({}), false)
  assert.equal(loosenEmptyItems(null), false)
  assert.equal(loosenEmptyItems(undefined), false)
  assert.equal(loosenEmptyItems("x"), false)
  assert.equal(loosenEmptyItems(42), false)
})

console.log("\nrewriteRequestBody —— 一次 parse 搞定四处，没改就不重新序列化")

check("tools 里的 {} 改成 true", () => {
  const raw = JSON.stringify({
    model: "glm-5.3-flash",
    tools: [{ type: "function", function: { name: "t", parameters: { type: "object", additionalProperties: {} } } }],
  })
  const out = rewriteRequestBody(raw)
  const j = JSON.parse(out)
  assert.equal(j.tools[0].function.parameters.additionalProperties, true)
})

check("tools[40] 的 functions.items:{} 被删（真实报错的那一处）", () => {
  const tools = []
  for (let i = 0; i < 40; i++) {
    tools.push({ type: "function", function: { name: `tool_${i}`, parameters: { type: "object" } } })
  }
  tools.push({
    type: "function",
    function: {
      name: "functions_probe",
      parameters: {
        type: "object",
        properties: { functions: { type: "array", items: {} } },
        required: ["functions"],
      },
    },
  })
  const raw = JSON.stringify({ tools })
  const out = JSON.parse(rewriteRequestBody(raw))
  assert.equal(out.tools[40].function.parameters.properties.functions.items, undefined)
  assert.deepEqual(out.tools[40].function.parameters.properties.functions, { type: "array" })
  assert.deepEqual(out.tools[40].function.parameters.required, ["functions"])
  // 其余 40 个工具一字不动
  assert.deepEqual(out.tools[0], tools[0])
  assert.deepEqual(out.tools[39], tools[39])
})

check("additionalProperties 与 items 两处同时改，一次 parse 都生效", () => {
  const raw = JSON.stringify({
    tools: [
      {
        type: "function",
        function: {
          name: "t",
          parameters: {
            type: "object",
            properties: { functions: { type: "array", items: {} } },
            additionalProperties: {},
          },
        },
      },
    ],
  })
  const out = JSON.parse(rewriteRequestBody(raw))
  assert.equal(out.tools[0].function.parameters.additionalProperties, true)
  assert.equal(out.tools[0].function.parameters.properties.functions.items, undefined)
})

check("items:{description} 不被改动 → 返回同一个字符串", () => {
  const raw = JSON.stringify({
    tools: [{ type: "function", function: { name: "t", parameters: { type: "array", items: { description: "x" } } } }],
  })
  assert.equal(rewriteRequestBody(raw), raw)
})

check("其余字段一字不动（等价改写，不是重排）", () => {
  const body = {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    tools: [
      {
        type: "function",
        function: {
          name: "ExitPlanMode",
          description: "d",
          parameters: {
            type: "object",
            properties: { plan: { type: "string" } },
            required: ["plan"],
            additionalProperties: {},
          },
        },
      },
    ],
  }
  const out = JSON.parse(rewriteRequestBody(JSON.stringify(body)))
  assert.equal(out.tools[0].function.parameters.additionalProperties, true)
  assert.deepEqual(out.tools[0].function.parameters.properties, { plan: { type: "string" } })
  assert.deepEqual(out.tools[0].function.parameters.required, ["plan"])
  assert.equal(out.temperature, 0.7)
  assert.deepEqual(out.messages, body.messages)
})

check("带 tools 但没有需要改的 → 返回同一个字符串（不白序列化）", () => {
  const raw = JSON.stringify({ tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }] })
  assert.equal(rewriteRequestBody(raw), raw)
})

check("max_tokens 64 + stream:true → 512 且补 include_usage", () => {
  const raw = JSON.stringify({ stream: true, max_tokens: 64 })
  const j = JSON.parse(rewriteRequestBody(raw))
  assert.equal(j.max_tokens, 512)
  assert.deepEqual(j.stream_options, { include_usage: true })
})

check("max_tokens 64 不流式 → 也抬到 512", () => {
  const j = JSON.parse(rewriteRequestBody(JSON.stringify({ max_tokens: 64 })))
  assert.equal(j.max_tokens, 512)
})

check("max_tokens ≥ 512 不动", () => {
  const raw = JSON.stringify({ max_tokens: 4096 })
  assert.equal(rewriteRequestBody(raw), raw)
})

check("已有的 stream_options 不覆盖", () => {
  const raw = JSON.stringify({ stream: true, stream_options: { include_usage: false } })
  assert.equal(rewriteRequestBody(raw), raw)
})

check("三个关键字都没有 → 原样返回", () => {
  const raw = JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  assert.equal(rewriteRequestBody(raw), raw)
})

check("非法 JSON 原样返回，不抛", () => {
  const raw = '{"tools": [broken'
  assert.equal(rewriteRequestBody(raw), raw)
})

check("非字符串原样返回（undefined / Buffer / 对象）", () => {
  assert.equal(rewriteRequestBody(undefined), undefined)
  const buf = Buffer.from("{}")
  assert.equal(rewriteRequestBody(buf), buf)
  const obj = { tools: [] }
  assert.equal(rewriteRequestBody(obj), obj)
})

check("JSON null / 数组字面量不炸", () => {
  assert.equal(rewriteRequestBody("null"), "null")
  const arr = '["tools"]'
  assert.equal(rewriteRequestBody(arr), arr)
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
