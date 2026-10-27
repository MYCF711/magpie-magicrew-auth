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

        const req = input instanceof Request ? input : null
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (req?.url ?? "")

        const incoming = new Headers(init?.headers ?? req?.headers ?? {})
        const headers = {
          authorization: `Bearer ${fresh.access}`,
          "content-type": "application/json",
        }
        if (c.needsOrgOnGateway && fresh.org) headers["organization-code"] = fresh.org

        for (const [k, v] of incoming) {
          if (["authorization", "host", "content-length", "user-agent"].includes(k.toLowerCase())) continue
          headers[k] = v
        }

        let body = init?.body
        if (body === undefined && req) body = await req.text()

        // 实测 glm-5.3-flash：64 → finish_reason:"length" 且 content:""
        //                    512 → 正常出话（reasoning 208 / total 233）
        if (typeof body === "string" && body.includes('"max_tokens"')) {
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
