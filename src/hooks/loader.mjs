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

import { ensureKey } from "../keys.mjs"

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
