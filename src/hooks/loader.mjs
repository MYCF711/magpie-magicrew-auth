// ④ auth.loader(getAuth) —— 请求接管
//
// 返回 baseURL / apiKey / headers / fetch(a,b)，magpie 拿它发真实请求。
// 这是唯一能改请求体和上游错误状态的地方。本项目用它干三件事：
//
//   · 国际站网关强制要 organization-code（国内站不要），不带就是
//     HTTP 500 "Internal Server Error."（22 字节纯文本，不是 JSON）
//   · 推理模型低于 512 的 max_tokens 会被 reasoning 吃光，content 返回空串
//   · 上游用 HTTP 400 报「可用积分已不足」：这个 400 在 magpie 的
//     retryable() 里不被识别为可重试（400 分支只查 quotaWords，而这条文案
//     命中的是 creditWords 的「充值」），于是整轮直接失败、账号也不 rest。
//     插件把它改写为语义正确的 402 Payment Required，让 magpie 换下一个账号。
//
// ⚠ 不要在这里读流、不要手拼 x-api-key ——
//   流由 magpie 处理，头由 SDK 包自动加。见 README「最小交付面」。

import { ensureKey, accountOf, keyCandidates, adoptKey, renewViaStore } from "../keys.mjs"

/**
 * 上游「这个账号不行」的两种形态（2026-10-29 实测）：
 *
 *   · HTTP 403
 *   · **HTTP 200 + `{"code":403,"message":"token无效"}`**  ← 绝大多数是这种
 *
 * 所以光看状态码会漏。只解析 JSON（SSE 一律不碰，读流会破坏它）。
 */
async function isKeyRejected(res) {
  if (!res) return false
  if (res.status === 401 || res.status === 403) return true
  const ct = res.headers.get("content-type") || ""
  if (res.status !== 200 || !ct.includes("application/json")) return false
  let text = ""
  try {
    text = await res.clone().text()
  } catch {
    return false
  }
  if (text.length > 8192) return false
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return false
  }
  // 只认**业务错误码**。正常 chat 完成的 JSON 是 {choices:[…]}，没有顶层 code；
  // 用文本正则会把模型回复里恰好出现的 "unauthorized" 当成 key 拒绝 ——
  // 那会白白重发请求（可能重复计费），甚至最后把正常响应丢掉换成 402。
  const code = Number(body?.code ?? body?.error?.code)
  if (code === 401 || code === 403) return true
  const msg = String(body?.message ?? body?.error?.message ?? "")
  if (!msg) return false
  if (/token无效|token 无效|invalid token/i.test(msg)) return true
  // 兜底：只有 message、没有 code 的少量形态；有 choices 的正常响应绝不判
  return !Array.isArray(body?.choices) && /unauthorized/i.test(msg)
}

/**
 * 把 JSON Schema 里的 `additionalProperties` **非布尔值**原地换成 `true`。
 *
 * 上游只认布尔值，收到任何对象都回 HTTP 400
 * `{"error":{"message":"模型响应失败","code":4017}}`，整个请求被拒。
 * 实测（2026-10-28，glm-5.3-flash 与 deepseek-v4.1-flash **两个模型完全一致**，
 * 同一把 key、同一份请求、只改这一个字段）：
 *
 *   additionalProperties: 缺省              → 200
 *   additionalProperties: false             → 200
 *   additionalProperties: true              → 200
 *   additionalProperties: {}                → 400 code 4017
 *   additionalProperties: {type:"string"}   → 400 code 4017
 *   additionalProperties: {type:"string",description:"x"} → 400 code 4017
 *
 * ⚠ 注意**不只是空对象**。有约束的 schema 形态（`{type:"string"}`）一样被拒 ——
 * 这一点比"上游只认 true/false"更进一步：它根本不支持 schema 形态。
 * 所以这里一律换成 `true`，属于**降级放宽**：
 *
 *   · `{}`            → `true`  语义等价（都是"任意，不加约束"）
 *   · `{type:"string"}` → `true`  **不等价** —— 丢掉了"额外属性必须是 string"的约束
 *
 * 为什么接受这个不等价：上游无法表达它，保留原值就是整个请求失败。两害相权，
 * 让工具调用能跑（可能多出未声明的字段）比让 agent 完全不可用要好。方向也安全 ——
 * 是放宽不是收紧，不会让原本合法的调用被拒。
 *
 * 命中来源：ZCode / Claude Code 系客户端生成 schema 时爱写 `{}`；
 * 一次真实请求里 54 个工具中的 `ExitPlanMode` 与 `CreateWorkflow` 就这么写。
 * 客户端没写错（按规范 `{}` 与 `true` 等价），是上游兼容性不足，插件这边兜住。
 *
 * 只走 schema 位置（见 `walkSchema`）：一个恰好叫 `additionalProperties` 的工具参数
 * 不会被误改。
 *
 * @returns {boolean} 有没有改到
 */
// JSON Schema 里"值是 schema"的关键字。只走这些位置，**不扫 properties 的键名**，
// 也不扫 enum / default / const / examples —— 那些不是 schema。
// 旧写法递归所有对象，会把一个叫 `additionalProperties` 的工具参数（在
// properties 的键上）当成关键字改掉，也会把 enum 值里的 `items` 键删掉。
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
])
const SCHEMA_ONE = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
  "items",
  "additionalItems",
  "unevaluatedItems",
])
const SCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

/**
 * 在 schema 对象上原地跑 `visit`，并只递归进真正的 schema 位置。
 * @returns {boolean} `visit` 或任一子 schema 改到过
 */
function walkSchema(node, visit) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false
  let changed = visit(node)
  for (const [k, v] of Object.entries(node)) {
    if (!v || typeof v !== "object") continue
    if (SCHEMA_MAPS.has(k) && !Array.isArray(v)) {
      for (const child of Object.values(v)) if (walkSchema(child, visit)) changed = true
      continue
    }
    if (SCHEMA_LIST.has(k) && Array.isArray(v)) {
      for (const child of v) if (walkSchema(child, visit)) changed = true
      continue
    }
    if (SCHEMA_ONE.has(k)) {
      if (Array.isArray(v)) {
        for (const child of v) if (walkSchema(child, visit)) changed = true
      } else if (walkSchema(v, visit)) changed = true
      continue
    }
    if (k === "dependencies" && !Array.isArray(v)) {
      for (const child of Object.values(v)) {
        if (child && typeof child === "object" && !Array.isArray(child) && walkSchema(child, visit)) {
          changed = true
        }
      }
    }
  }
  return changed
}

export function loosenAdditionalProperties(node) {
  return walkSchema(node, (n) => {
    // 布尔值上游认，原样留着（false 是"不许额外属性"，语义相反，绝对不能动）
    if (!Object.hasOwn(n, "additionalProperties")) return false
    if (typeof n.additionalProperties === "boolean") return false
    n.additionalProperties = true
    return true
  })
}

/**
 * 上游的 JSON Schema 校验器不接受 `items: {}`，整轮请求回 HTTP 400：
 *
 *   {"error":{"code":null,"message":"超级麦吉: HTTP 400 请求错误: {\"error\":
 *    {\"code\":\"InvalidParameter\",\"message\":\"tools.40.function.parameters/
 *    properties/functions/items: invalid JSON Schema; check the schema
 *    keywords and references Request id: ...\",\"param\":\"\",\"type\":
 *    \"BadRequest\"}}","param":null,"type":"invalid_request_error"}}
 *
 * 报错只给路径，不说是哪个客户端。实测（2026-10-28，同一把 key、同一份请求、
 * 只改 tools[0] 的这一处；国内站 `magicrew` 与国际站 `magicrew-intl` 逐行一致）：
 *
 *   items: 缺省                → 200
 *   items: {}                  → 400 invalid JSON Schema
 *   items: {description:"x"}   → 200   // 空对象才炸，不是"缺 type"
 *   items: {type:"string"}     → 200
 *   items: true                → 400 模型响应失败（另一种 400）
 *   items: false               → 400 模型响应失败
 *
 * 为什么可以删：JSON Schema 里 `items` 的缺省值就是 `{}` —— "任意元素"。
 * 所以 `items: {}` 删掉是**严格等价**（`true` 同理），不是降级放宽。
 * `items: false` 表示"数组必须为空"，语义不同，不能删，原样留着。
 *
 * 命中来源：客户端用 `z.array(z.unknown())` / 动态函数列表生成工具 schema 时，
 * 数组元素会序列化成 `{}`。一个真实请求里第 41 个工具的参数是
 * `properties.functions.items: {}`，于是整轮失败。
 *
 * 只走 schema 位置：`properties` 里一个恰好叫 `items` 的工具参数（哪怕 schema 就是
 * `{}`）不会被误删；`enum` / `default` 值里的 `items` 键同样不碰。
 *
 * @returns {boolean} 有没有改到
 */
export function loosenEmptyItems(node) {
  return walkSchema(node, (n) => {
    if (!Object.hasOwn(n, "items")) return false
    const v = n.items
    const emptyObject =
      v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0
    if (!emptyObject && v !== true) return false
    delete n.items
    return true
  })
}

/**
 * 修 **`items` 子树内部**的 schema：上游的 JSON Schema 校验器对数组元素的
 * schema 比对根节点**更严**，下面这些形态在 `items` 子树里一律 400：
 *
 *   anyOf / oneOf / allOf / not / const   → 400
 *   if / then / else                      → 400
 *   {}（空 schema）                       → 400
 *
 * ⚠ 同样形态放在**顶层 parameters** 里上游**收**（200）—— 只有 `items` 子树
 * 里才炸。所以限制必须精确落在 `items` 之下，不能全局摊平 union。
 *
 * 实测（2026-10-28~29，直打国内站 `i-magic-service.letsmagic.cn`，
 * deepseek-v4.1-flash，同一把 key、同一份请求，只改这一个字段；
 * `_probe/items-subtree-upstream.mjs` 可复跑）：
 *
 *   items 内部 {x:{anyOf:[{type:"string"},{type:"null"}]}} → 400
 *   items 内部 {x:{oneOf:[…]}}                            → 400
 *   items 内部 {x:{allOf:[…]}}                            → 400
 *   items 内部 {x:{not:{type:"string"}}}                  → 400
 *   items 内部 {x:{const:"a"}}                            → 400
 *   items 内部 {x:{if:…,then:…}}                          → 400
 *   items 内部 {x:{}}                                     → 400
 *   items 内部 {x:{type:["object","string",…,"null"]}}    → 200   ← 「任意值」的合法写法
 *   items 内部 {x:{type:"object"}}                        → 200
 *   items 内部 {x:{type:"string",pattern:"^a$",enum:[…]}} → 200
 *   items 内部 {x:{$ref:"#/$defs/s"}}, $defs 同层        → 200
 *   items 是数组（tuple 形式）    国内站 → 200，**国际站 → 400**（两站不一致）
 *   顶层   {x:{anyOf:…}} / {x:{const:…}} / {x:{not:…}} / {x:{}} → 200
 *   （国内站 `i-magic-service.letsmagic.cn` 与国际站 `magic-service.magicrew.ai`
 *     逐条对比过：除 tuple 形式外结论一致）
 *
 * 命中来源：**MCP 服务器**的工具 schema。REA MCP（mcp__rea__build_call_path 等
 * 7 个工具）的 `functions` 数组参数，元素 schema 用了
 * `anyOf: [{...}, {type:"null"}]`（可选参数的标准写法）、`oneOf`，还有
 * `{}` 空 schema —— 一份 65 工具的请求里就有 7 个工具中招，整轮 400。
 *
 * 修法（全部是**降级放宽**，方向安全：宁可约束松一点，也不要整轮失败）：
 *
 *   anyOf / oneOf / allOf  → 取一个分支内联（**优先非纯 null 的分支**：
 *                              `anyOf:[{…},{type:"null"}]` 取前者；反过来写时
 *                              照抄第一个会把「可选」压成「只能 null」，那是收紧）
 *   not / const / if+then+else → 删除（无等价物；删掉就是放宽）
 *   {}                     → `{type:["object","string","number","boolean","array","null"]}`
 *                             （六种 JSON 类型全覆盖 = 任意值，与 `{}` 严格等价；
 *                              **不能**用 `{type:"object"}` —— 那会把「任意」收紧成「只能是对象」）
 *
 * ⚠ 两个容易漏的坑（都踩过）：
 *   1. 删除 `not` / `const` 后节点可能变成 `{}` —— 必须在删除后再查一次空对象，
 *      否则改完仍是 400（PR #10 初版就漏在这里，`not`/`const` 两例改写后仍 400）。
 *   2. `items` 子树里 `{}` 和 `true` 都被拒，所以「任意值」只能落成显式 type 数组。
 *
 * ⚠ 只走 `items` 子树：顶层 parameters 的 union 是上游**收**的，动了它
 * 会白白丢掉约束。
 *
 * @returns {boolean} 有没有改到
 */
export function loosenItemsSchema(node) {
  let changed = false
  // 用 walkSchema 找**每一个** schema 位置上的 items（它只进入真正的 schema
  // 位置：properties 的值、union 的分支、items 的值……不碰 enum/default 的字面值）。
  walkSchema(node, (n) => {
    if (!Object.hasOwn(n, "items")) return false
    const v = n.items
    // tuple 形式（draft-04）：`items` 是 schema **数组**。
    // 两站行为不一致 —— 国内站收、**国际站拒**（`[{"type":"string"}] is not of
    // type 'object'`），实测见 `_probe/items-subtree-upstream.mjs`。
    // 数组里的逐位约束在改写里表达不了（`anyOf` 在这层就是 400），
    // 只能整体落成「任意值」—— 纯放宽，不会让原本合法的调用被拒。
    if (Array.isArray(v)) {
      n.items = { type: [...ANY_SCHEMA_TYPE] }
      changed = true
      return false
    }
    if (!v || typeof v !== "object") return false
    if (fixItemsSubtree(v)) changed = true
    return false
  })
  return changed
}

// 空 schema 在 JSON Schema 里等价于 `true` = 接受任意 JSON 值。但上游对
// `items` 子树里的 `{}` 和 `true` 都拒，只能落成显式的「任意类型」schema。
const ANY_SCHEMA_TYPE = ["object", "string", "number", "boolean", "array", "null"]

/** 把一个空 schema 节点原地改成「任意值」。返回是否真的改到（只对空对象生效）。 */
function toAnySchema(n) {
  if (Object.keys(n).length > 0) return false
  n.type = [...ANY_SCHEMA_TYPE]
  return true
}

/** 分支是不是只声明了 null —— 取它内联会把「可选」压成「只能 null」（收紧） */
function isNullOnly(branch) {
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) return false
  if (branch.type === "null") return true
  return Array.isArray(branch.type) && branch.type.length === 1 && branch.type[0] === "null"
}

/**
 * 在 `items` 子树里就地修：union 摊平、const/not/if 删除、空 schema 换形状。
 *
 * 递归同样遵守 schema 位置纪律（见 {@link SCHEMA_MAPS} / {@link SCHEMA_LIST} /
 * {@link SCHEMA_ONE}）：`enum` / `default` / `examples` 里的字面值不是 schema，
 * 不能动。
 *
 * @returns {boolean} 有没有改到
 */
function fixItemsSubtree(n) {
  if (!n || typeof n !== "object" || Array.isArray(n)) return false
  let dirty = false

  // 空 schema {} → 显式「任意类型」（与 {} 严格等价）
  if (toAnySchema(n)) return true

  for (const [k, v] of Object.entries(n)) {
    if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      if (!Array.isArray(v) || v.length === 0) {
        delete n[k]
        dirty = true
        continue
      }
      // 优先第一个非纯 null 的分支（顺序反过来时不至于把可选压成「只能 null」）
      const branch =
        v.find((b) => b && typeof b === "object" && !Array.isArray(b) && !isNullOnly(b)) ??
        v.find((b) => b && typeof b === "object" && !Array.isArray(b))
      delete n[k]
      dirty = true
      if (branch) {
        // 分支本身也可能带 union / 空 schema ⇒ 先递归修，再内联
        if (fixItemsSubtree(branch)) dirty = true
        Object.assign(n, branch)
      }
      continue
    }
    if (k === "not" || k === "const" || k === "if" || k === "then" || k === "else") {
      delete n[k]
      dirty = true
      continue
    }
    // 其余按 schema 位置递归
    if (SCHEMA_MAPS.has(k) && !Array.isArray(v)) {
      for (const child of Object.values(v)) if (fixItemsSubtree(child)) dirty = true
      continue
    }
    if (SCHEMA_LIST.has(k) && Array.isArray(v)) {
      for (const child of v) if (fixItemsSubtree(child)) dirty = true
      continue
    }
    if (SCHEMA_ONE.has(k)) {
      if (Array.isArray(v)) {
        for (const child of v) if (fixItemsSubtree(child)) dirty = true
      } else if (fixItemsSubtree(v)) {
        dirty = true
      }
    }
  }
  // 删除 not/const/if… 之后节点可能变空 —— 空 schema 在 items 子树里仍然 400，
  // 必须补成「任意值」。
  if (toAnySchema(n)) dirty = true
  return dirty
}

/**
 * 改写发往上游的请求体。**一次 parse，四处改写都在这**。
 *
 * 四处都是实测出来的，不是猜的：
 *
 * ① max_tokens 抬到 512
 *    实测 glm-5.3-flash：64 → finish_reason:"length" 且 content:""
 *                        512 → 正常出话（reasoning 208 / total 233）
 *
 * ② 流式请求补 stream_options.include_usage
 *    magicrew 在 stream:true 下**默认不返回 usage**；补上之后，[DONE]
 *    之前会多一条 {"choices":[],"usage":{...}} 的收尾 chunk。
 *    magpie 新版靠这条收尾 chunk 判定「流正常结束了」——缺了它就报
 *    「Stream ended without finish_reason」然后重试（实测 2026-10-27）。
 *
 * ③ tools 里的 additionalProperties: {} → true（见 looser 的注释）
 *
 * ④ tools 里的 items: {} → 删除（见 loosenEmptyItems 的注释）
 *
 * 没改到时返回原始字符串（省一次序列化 —— 54 个工具的请求体不小）。
 *
 * @param {unknown} raw
 * @returns {unknown} 改了就是新字符串，没改就原样返回
 */
export function rewriteRequestBody(raw) {
  if (typeof raw !== "string") return raw
  // 粗筛：三个关键字一个都没有，就不必 parse
  if (!/"stream"|"max_tokens"|"tools"/.test(raw)) return raw

  let j
  try {
    j = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!j || typeof j !== "object") return raw

  let changed = false

  if (Number(j.max_tokens) > 0 && Number(j.max_tokens) < 512) {
    j.max_tokens = 512
    changed = true
  }

  if (j.stream === true && !j.stream_options) {
    j.stream_options = { include_usage: true }
    changed = true
  }

  if (Array.isArray(j.tools)) {
    for (const t of j.tools) {
      const p = t?.function?.parameters
      if (!p || typeof p !== "object") continue
      if (loosenAdditionalProperties(p)) changed = true
      if (loosenEmptyItems(p)) changed = true
      if (loosenItemsSchema(p)) changed = true
    }
  }

  return changed ? JSON.stringify(j) : raw
}

// ═══ 上游「积分/余额不足」的 400 → 402 ═══════════════════════════════════
//
// 实测（2026-10-28 23:38，magpie 0.1.1899，DSH 走 group）：
//
//   try #1  magicrew@181****710  200  fail=loop   （模型自己绕圈，不是账号）
//   try #2  magicrew@181****710  400  fail=credit
//           body: 超级麦吉: 非常抱歉，当前对话需要调用大模型 / 付费工具，
//                 您的可用积分已不足。…通过「充值」通道补充积分…
//   route   done=true status=400   ← 第三个账号（余额 6,467）一次都没被问
//
// magpie 的 failure() 已经把这条归成 failCredit（creditWords 命中「充值」），
// 但 retryable() 的 400/422 分支只查 quotaWords（quota|余额|额度|欠费|…），
// 不含「积分」「充值」⇒ hw.failed() 为 false ⇒ 走不到 `!last && hw.failed()`
// 的换账号分支，连 rest 都不记。账号于是永远留在轮换里，下一轮继续撞。
//
// 修法只改插件这一层：400/422 + 这条文案 → 402 Payment Required。
// 402 在 magpie 的 retryable() 里无条件 true，failure(402) 也是 failCredit，
// 会 rest 该账号 30 分钟并继续问同 provider 的下一个账号（或组的下一个成员）。
// body 原样保留，最终错误文案不变。
//
// 注意：只转换「上游拒绝」这一个语义；400 的 schema 错误、参数错误绝不碰。
const CREDIT_EXHAUSTED = /(?:积分|余额)(?:已|额度)?不足|可用积分不足|insufficient\s+(?:credit|credits|balance|fund|funds|point|points)|(?:credit|credits|point|points|balance)\s+(?:is\s+|are\s+)?(?:insufficient|exhausted)|out\s+of\s+(?:credit|credits|points?|balance)/i

/** 这条错误文案是不是「账户没钱了」（而不是请求本身有问题） */
export function isCreditExhausted(text) {
  return CREDIT_EXHAUSTED.test(String(text ?? ""))
}

/**
 * 把上游的「积分/余额不足」400/422 改写成 402，让 magpie 的 `retryable()`
 * 愿意换下一个账号；其余响应原样返回（同一个 Response 对象）。
 *
 * @param {Response} res
 * @returns {Promise<Response>}
 */
export async function rewriteCreditRefusal(res) {
  if (!res || (res.status !== 400 && res.status !== 422)) return res
  let text
  try {
    // 只克隆错误响应：成功响应（尤其是 SSE）不能在这里读，否则会破坏流
    text = await res.clone().text()
  } catch {
    return res
  }
  if (!isCreditExhausted(text)) return res
  const headers = new Headers(res.headers)
  // body 已由 undici 解压，原 content-encoding/length 不再成立
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(text, {
    status: 402,
    statusText: "Payment Required",
    headers,
  })
}

/**
 * 上游（Swow/PHP）对请求体有 ~8MB 的硬上限（实测 6MB 过、8MB 拒），
 * 超了直接回 413 的 HTML 页 —— magpie 只能显示成难懂的
 * 「a web page, not an API reply」。翻译成人话，并说明换账号没用。
 */
async function rewriteTooLarge(res, SHORT) {
  if (!res || res.status !== 413) return res
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("content-type", "application/json")
  const body = JSON.stringify({
    error: {
      message:
        `${SHORT}: 请求体超过上游上限（约 8 MB）—— 会话上下文过大或含大截图。` +
        `压缩上下文（如 /compact）或新开会话后重试；换账号无效。`,
      type: "payload_too_large",
    },
  })
  return new Response(body, { status: 413, statusText: "Payload Too Large", headers })
}

export function makeLoader(c) {
  /** 已经写回 store 的 key —— 避免每个请求都去读一次 store */
  const adopted = new Set()
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return {}
    return {
      baseURL: c.BASE,
      apiKey: auth.access,
      headers: { "user-agent": "MagicrewClient/1.0" },
      async fetch(input, init) {
        const fresh = await getAuth()
        if (!fresh) throw new Error(`${c.SHORT} 未登录`)

        // key 只有一个来源（src/keys.mjs）—— 服务端签一把顶一把，多入口必互相吊销
        const key = await ensureKey(c, getAuth)
        if (!key) throw new Error(`${c.SHORT} 未登录（拿不到可用的 key）`)
        const account = accountOf(fresh)

        const req = input instanceof Request ? input : null
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (req?.url ?? "")

        const incoming = new Headers(init?.headers ?? req?.headers ?? {})
        const headers = {
          authorization: `Bearer ${key.apiKey}`,
          "content-type": "application/json",
        }
        if (c.needsOrgOnGateway && fresh.org) headers["organization-code"] = fresh.org

        for (const [k, v] of incoming) {
          if (["authorization", "host", "content-length", "user-agent"].includes(k.toLowerCase())) continue
          headers[k] = v
        }

        let body = init?.body
        if (body === undefined && req) body = await req.text()

        // 四处请求体改写，全在 rewriteRequestBody 里（那里有实测出处）
        body = rewriteRequestBody(body)

        const signal = init?.signal ?? req?.signal ?? AbortSignal.timeout(300_000)
        const sendWith = (apiKey) =>
          fetch(url, {
            method: init?.method ?? "POST",
            headers: { ...headers, authorization: `Bearer ${apiKey}` },
            body,
            signal,
          })

        // 同一账号可能握着两把 key（magpie 的 refresh 一条、插件 store 一条），
        // 哪把还有效本地无法预判 —— 静态挑必然有一半踩空，只能逐把试。
        // 详见 src/keys.mjs 的 keyCandidates 注释（2026-10-29 五个账号的实测表）。
        // 传 fresh 而不是 getAuth：候选与下面 adoptKey 必须落在同一个账号上，
        // 不能让两次 getAuth() 返回不同结果。
        const cands = await keyCandidates(c, fresh)
        if (!cands.length) throw new Error(`${c.SHORT} 未登录（拿不到可用的 key）`)

        for (const cand of cands) {
          const res = await sendWith(cand.apiKey)
          if (!(await isKeyRejected(res))) {
            // 这把能用 —— 写回 store，让 ensureKey / 额度那几路也用同一把
            if (!adopted.has(cand.apiKey)) {
              adopted.add(cand.apiKey)
              adoptKey(c, fresh, cand.apiKey, cand.expiresAt)
            }
            return rewriteTooLarge(await rewriteCreditRefusal(res), c.SHORT)
          }
          // 这把被拒：响应不再使用，显式取消 body —— 否则逐把试时
          // 每条死连接的响应体都挂着，等 GC 才释放。
          try {
            await res.body?.cancel()
          } catch {}
        }

        // 全被拒 —— 很可能是 key 被别处顶掉（同一账号在别处又登了一次，服务端换发）。
        // 手里有 refresh_token 就续一把、再给一次机会：这是唯一能从 403 自愈的路，
        // 否则这把 key 会一直「没过期但已失效」，直到 30 分钟 rest 结束还是它。
        try {
          if (accountOf(fresh) !== "default") {
            const renewed = await renewViaStore(c, fresh)
            if (renewed?.apiKey) {
              const res = await sendWith(renewed.apiKey)
              if (!(await isKeyRejected(res))) {
                adoptKey(c, fresh, renewed.apiKey, renewed.expiresAt)
                return rewriteTooLarge(await rewriteCreditRefusal(res), c.SHORT)
              }
            }
          }
        } catch {}

        // 这个账号的 key 全被拒。上游给的是 403「token无效」，magpie 会判成
        // 「不可重试」直接抛给客户端（ZCode 显示 auth_failed / token无效）。
        // 改写成 402：magpie 的 failure(402) 是 failCredit → 把这个账号 rest 掉、
        // 去问下一个账号 / 组的下一个成员。与 0.3.26 的「积分不足」同一条通路。
        return new Response(
          JSON.stringify({
            error: {
              message:
                `${c.SHORT}：本账号的 ${cands.length} 把密钥均已被上游拒绝，已交给 magpie 换下一个账号。` +
                `（常见于登录 / 续期分叉；请重新登录这个账号）`,
              type: "account_unavailable",
              code: 402,
            },
          }),
          {
            status: 402,
            statusText: "Payment Required",
            headers: { "content-type": "application/json" },
          },
        )
      },
    }
  }
}
