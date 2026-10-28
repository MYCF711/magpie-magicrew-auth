// ④ auth.loader(getAuth) —— 请求接管
//
// 返回 baseURL / apiKey / headers / fetch(a,b)，magpie 拿它发真实请求。
// 这是唯一能改请求体的地方。本项目用它干两件事：
//
//   · 国际站网关强制要 organization-code（国内站不要），不带就是
//     HTTP 500 "Internal Server Error."（22 字节纯文本，不是 JSON）
//   · 推理模型低于 512 的 max_tokens 会被 reasoning 吃光，content 返回空串
//
// ⚠ 不要在这里读流、不要重试换号、不要手拼 x-api-key ——
//   前两件 magpie 做了，第三件看 SDK 包自动加。见 README「最小交付面」。

import { ensureKey, accountOf } from "../keys.mjs"

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
 * schema 比对根节点**更严**，这些形态一律回
 * `items: invalid JSON Schema`：
 *
 *   anyOf / oneOf / allOf / not / const   → 400
 *   {}（空 schema）                       → 400
 *
 * ⚠ 同样形态放在**顶层 parameters** 里上游**收**（200）—— 只有 `items` 子树
 * 里才炸。所以限制必须精确落在 `items` 之下，不能全局摊平 union。
 *
 * 实测（2026-10-28，DSH 经 magpie 网关打 deepseek-v4.1-flash，同一把 key、
 * 同一份请求，只改这一个字段；国内站 `magicrew` 与国际站 `magicrew-intl` 同构）：
 *
 *   items 内部 {x:{anyOf:[{type:"string"}]}}           → 400
 *   items 内部 {x:{type:"string"}}                        → 200
 *   items 内部 {x:{const:"a"}}                           → 400
 *   items 内部 {x:{not:{type:"string"}}}                 → 400
 *   items 内部 {x:{}}                                    → 400
 *   items 内部 {x:{type:"string",pattern:"^a$",enum:[…]}} → 200
 *   顶层   {x:{anyOf:[{type:"string"}]}}                 → 200
 *
 * 命中来源：**MCP 服务器**的工具 schema。REA MCP（mcp__rea__build_call_path 等
 * 7 个工具）的 `functions` 数组参数，元素 schema 用了
 * `anyOf: [{...}, {type:"null"}]`（可选参数的标准写法）、`oneOf`，还有
 * `{}` 空 schema —— 一份 65 工具的请求里就有 7 个工具中招，整轮 400。
 *
 * 修法（三处都是**降级放宽**，方向安全：宁可约束松一点，也不要整轮失败）：
 *
 *   anyOf / oneOf / allOf  → 取**第一个分支**内联（union 的第一个分支通常
 *                             就是「非空」的那个；`anyOf:[{...},{type:"null"}]`
 *                             取第一个正好）
 *   not                    → 删除（无对应可放宽的等价物）
 *   const                  → 删除（`const` 表达的是「只能是这一个值」，
 *                             删掉变「任意值」—— 放宽）
 *   {}                     → `{type:"object",additionalProperties:true}`
 *                             （空 schema 本来就是「任意」，这个改写严格等价）
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
    if (!v || typeof v !== "object" || Array.isArray(v)) return false
    if (fixItemsSubtree(v)) changed = true
    return false
  })
  return changed
}

/**
 * 在 `items` 子树里就地修：union 摊平、const/not 删除、空 schema 换形状。
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

  // 空 schema {} → {type:"object",additionalProperties:true}
  if (Object.keys(n).length === 0) {
    n.type = "object"
    n.additionalProperties = true
    return true
  }

  for (const [k, v] of Object.entries(n)) {
    if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      if (!Array.isArray(v) || v.length === 0) {
        delete n[k]
        dirty = true
        continue
      }
      const branch = v[0]
      delete n[k]
      dirty = true
      if (branch && typeof branch === "object" && !Array.isArray(branch)) {
        // 分支本身也可能带 union / 空 schema ⇒ 先递归修，再内联
        if (fixItemsSubtree(branch)) dirty = true
        Object.assign(n, branch)
      }
      continue
    }
    if (k === "not" || k === "const") {
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

export function makeLoader(c) {
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

        return fetch(url, {
          method: init?.method ?? "POST",
          headers,
          body,
          signal: init?.signal ?? req?.signal ?? AbortSignal.timeout(300_000),
        })
      },
    }
  }
}
