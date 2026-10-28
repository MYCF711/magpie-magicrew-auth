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
 * 把 JSON Schema 里的 additionalProperties: {} 换成 true（原地改）。
 *
 * 上游只认 true / false，收到空对象就回 400「模型响应失败」。
 * 按规范 {} 与 true 语义等价（都允许任意额外属性），所以这是等价改写，不改语义。
 * 非空的 schema（如 {type:"string"}）保持原样 —— 那是有约束的，换掉就变了。
 *
 * @returns {boolean} 有没有改到
 */
function loosenAdditionalProperties(node) {
  if (!node || typeof node !== "object") return false
  if (Array.isArray(node)) {
    let any = false
    for (const n of node) if (loosenAdditionalProperties(n)) any = true
    return any
  }
  let changed = false
  for (const [k, v] of Object.entries(node)) {
    if (k === "additionalProperties") {
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
        node[k] = true
        changed = true
      }
      continue
    }
    if (v && typeof v === "object" && loosenAdditionalProperties(v)) changed = true
  }
  return changed
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

        // 改写两处请求体，都为实测出来的：
        //
        // ① max_tokens 抬到 512
        //    实测 glm-5.3-flash：64 → finish_reason:"length" 且 content:""
        //                        512 → 正常出话（reasoning 208 / total 233）
        //
        // ② 流式请求补 stream_options.include_usage
        //    magicrew 在 stream:true 下**默认不返回 usage**；补上之后，[DONE]
        //    之前会多一条 {"choices":[],"usage":{...}} 的收尾 chunk。
        //    magpie 新版靠这条收尾 chunk 判定「流正常结束了」——缺了它就报
        //    「Stream ended without finish_reason」然后重试（实测 2026-10-27）。
        //    控制台里看到的就是：模型请求重试 (3/5) · Stream ended without finish_reason
        if (typeof body === "string" && body.includes('"stream"')) {
          try {
            const j = JSON.parse(body)
            if (Number(j.max_tokens) > 0 && Number(j.max_tokens) < 512) j.max_tokens = 512
            if (j.stream === true && !j.stream_options) {
              j.stream_options = { include_usage: true }
            }
            body = JSON.stringify(j)
          } catch {}
        } else if (typeof body === "string" && body.includes('"max_tokens"')) {
          try {
            const j = JSON.parse(body)
            if (Number(j.max_tokens) > 0 && Number(j.max_tokens) < 512) j.max_tokens = 512
            body = JSON.stringify(j)
          } catch {}
        }

        // ③ tools 里的 additionalProperties: {} → true
        //
        //    上游只认 true / false，遇到**空对象** {} 直接回 HTTP 400
        //    「模型响应失败」（code 4017），整个请求被拒。
        //
        //    按 JSON Schema，additionalProperties 的值是 schema 时：
        //      · {}  → 等价于 true（允许任意额外属性，但不给约束）
        //      · {type:"string"} → 额外属性必须是 string（有约束，不能换）
        //    所以只把**空对象**换成 true，非空的 schema 原样保留 —— 语义不变。
        //
        //    命中来源（2026-10-28 实测）：ZCode 的 54 个工具里，
        //    ExitPlanMode 与 CreateWorkflow 的顶层 parameters 用了 {}。
        //    客户端（ZCode / Claude Code 系）生成 schema 时常这么写，
        //    上游该兼容 —— 这是上游的兼容性问题，插件这边做等价改写兜住。
        if (typeof body === "string" && body.includes('"tools"')) {
          try {
            const j = JSON.parse(body)
            if (Array.isArray(j.tools)) {
              let changed = 0
              for (const t of j.tools) {
                const p = t?.function?.parameters
                if (p && typeof p === "object" && loosenAdditionalProperties(p)) changed++
              }
              if (changed) body = JSON.stringify(j)
            }
          } catch {}
        }

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
