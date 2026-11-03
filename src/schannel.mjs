// Schannel 通道 —— 当运行时自己的 TLS 栈被上游 WAF 拦掉时，改用系统 curl 重发一次。
//
// ═══ 为什么需要这一层（2026-11-03 真机） ═══════════════════════════════════
//
// 火山 WAF 保护 `i-magic-service.letsmagic.cn`。同一时刻、同一份 headers，
// 只有 **TLS 实现**不同的两条请求拿到了完全相反的答案：
//
//   C:\Windows\System32\curl.exe（libcurl 8.18，**Schannel**，Windows 原生栈）
//     → 200 {"code":1000,"data":{"total_points":-5,…}}   连打 8 次全 200
//   Bun 1.4.4 的 fetch（BoringSSL）  → 403，body 空串       连打 6 次全 403
//   Node 24 的 fetch（OpenSSL）      → 403，body 空串
//
// 换过 UA（curl/8.0 / Bun 默认 / 浏览器 / 插件名）、换过 Origin（带/不带/换域名）、
// 换过方法（GET/POST/PUT）、换过路径（连 `GET /` 根路径）—— 全是 403。
// 也就是说 UA、Origin、方法、路径、频率**都不是变量**，只有 ClientHello 的
// 指纹是。WAF 现在只放行 Windows 原生 TLS 栈。
//
// 0.3.72 的做法是「改 UA 成 curl/8.0」——那在当时有效（WAF 只看 UA），
// 现在失效了。UA 保留（无害，且真 curl 也发这个），真正的通道换成真 curl。
//
// ═══ 怎么用 ═════════════════════════════════════════════════════════════
//
// **只在被拦时兜底**，不替代正常路径：
//
//   1. 先照常用运行时 fetch 发（快，~20ms，且测试里的桩能直接命中）；
//   2. 响应用 `looksEdgeBlocked()` 判断是不是「边缘层拦的」——
//      4xx 且 body 为空或以 `<` 开头（WAF 的两种形态）；
//   3. 是的话，用系统 curl 重发一次（~300ms）；拿到正常响应就用它。
//
// 好处是零风险：curl 不可用、超时、返回的还不是 200 —— 一律退回原来的响应，
// 调用方看到的行为与没有这一层完全一致。

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

/** 模块加载那一刻的 fetch —— 之后被换掉就说明是桩，见 fetchWithFallback。 */
const NATIVE_FETCH = globalThis.fetch

/** 系统 curl 的候选路径（第一个存在的就用）。 */
const CURL_CANDIDATES = [
  "C:/Windows/System32/curl.exe",
  "C:/Windows/Sysnative/curl.exe",
]

let curlPath   // undefined = 还没找过；false = 找过没有

function findCurl() {
  if (curlPath !== undefined) return curlPath || null
  curlPath = false
  if (process.platform !== "win32") return null
  for (const p of CURL_CANDIDATES) {
    try {
      if (existsSync(p)) {
        curlPath = p
        return p
      }
    } catch {}
  }
  return null
}

/**
 * 这个响应「像不像被边缘层拦的」。
 *
 * 上游那个 Go 服务回错误**永远**是 `{"code":…,"message":…}` JSON。
 * 所以 4xx 里出现「空 body」或「HTML 页」，一定不是业务服务答的 ——
 * 是 WAF / CDN / 负载均衡的默认页。
 *
 * ⚠ 只在这些状态码上看：401/403/405 都是这类默认页的常见口径。
 *   200 一律不看（省掉 clone + 读 body 的开销）。
 */
export async function looksEdgeBlocked(res) {
  if (!res) return false
  const s = res.status
  if (s !== 401 && s !== 403 && s !== 405 && s !== 406 && s !== 444) return false
  try {
    const t = String(await res.clone().text()).trim()
    return t === "" || t.startsWith("<")
  } catch {
    return false
  }
}

/** 把 fetch 的 opts 摊成 curl 参数（**不含可执行文件本身**）。 */
function toCurlArgs(url, opts = {}) {
  const args = ["-sS", "--max-time", "90", "--location"]
  const method = String(opts.method || "GET").toUpperCase()
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (v == null) continue
    args.push("-H", `${k}: ${v}`)
  }
  if (opts.body != null) {
    // 显式给 GET 时 --data-binary 会把方法改成 POST，所以非 GET 才补 -X
    if (method !== "GET") args.push("-X", method)
    args.push("--data-binary", typeof opts.body === "string" ? opts.body : String(opts.body))
  } else if (method !== "GET") {
    args.push("-X", method)
  }
  // 状态码追加到尾，避免再去解析响应头
  args.push("-w", "\n__MAGICREW_STATUS__%{http_code}")
  args.push(url)
  return args
}

const STATUS_MARK = "__MAGICREW_STATUS__"

/**
 * 用系统 curl 发一次，包成 fetch 能看懂的 Response。
 * 拿不到可用结果时返回 `null`（调用方退回原响应）。
 */
export function curlFetch(url, opts = {}) {
  const curl = findCurl()
  if (!curl) return null
  let r
  try {
    r = spawnSync(curl, toCurlArgs(url, opts), {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
  } catch {
    return null
  }
  if (!r || r.status !== 0) return null
  const out = String(r.stdout ?? "")
  const at = out.lastIndexOf(STATUS_MARK)
  if (at < 0) return null
  const code = Number(out.slice(at + STATUS_MARK.length).trim())
  if (!Number.isFinite(code) || code < 200) return null
  const body = out.slice(0, at).replace(/\n$/, "")
  return new Response(body, {
    status: code,
    headers: { "content-type": guessType(body) },
  })
}

function guessType(body) {
  const t = String(body ?? "").trimStart()
  if (t.startsWith("{")) return "application/json"
  if (t.startsWith("[")) return "application/json"
  if (t.startsWith("<")) return "text/html"
  return "text/plain"
}

/**
 * 发一次请求：先运行时 fetch，被边缘层拦了才换 Schannel 重发。
 *
 * 这是 `src/api.mjs` 里**唯一**的发请求出口 —— 别在别处直接 fetch，
 * 否则那一路会悄悄绕开这层兜底（0.3.72 的 UA 就是在 loader 里漏过一次）。
 */
export async function fetchWithFallback(url, opts = {}) {
  const res = await globalThis.fetch(url, opts)
  // 测试 / 宿主把 fetch 换掉了 → 那是桩，不许绕过去打真网络。
  // （`node tests/*.mjs` 里全是 `globalThis.fetch = async () => …` 这种桩，
  //   若在这里真 spawn curl，桩就白设了，还会把真实凭据打出去。）
  if (globalThis.fetch !== NATIVE_FETCH) return res
  if (process.env.MAGICREW_NO_SCHANNEL === "1") return res
  if (!(await looksEdgeBlocked(res))) return res
  const alt = curlFetch(url, opts)
  return alt ?? res
}

// ══════════════════════════════════════════════════════════════════════════
// 流式通道 —— 模型请求（/v1/chat/completions）走这条
// ══════════════════════════════════════════════════════════════════════════
//
// 上面那个 `curlFetch` 用 spawnSync，会把整个 body 等完才返回 ——
// 对付积分 / 模型目录这种小 JSON 没问题，但**模型请求是流式的**：
// 等 curl 把整轮回答收完再交给 magpie，用户端就变成一个字都不往外吐、
// 然后一次性蹦出全文，SSE 的心跳和 `stream_options.include_usage` 全废。
//
// 所以这里另开一条：`spawn`（不是 spawnSync）+ 把 curl 的 stdout 直接
// 接成 ReadableStream。响应头用 `-D -` 混在 stdout 最前面（curl 的惯例），
// 读到空行为止，剩下的原样流给调用方。
//
// 2026-11-03 实测：模型端点同样按 TLS 指纹拦 —— Bun 打
// `/v1/chat/completions` 回 403 空 body，curl 打同一个地址回真实业务响应
// （400「可用积分已不足」）。所以这条兜底不是多余的。

function findHeaderEnd(buf, from) {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i + 4
  }
  return -1
}

function concatChunks(chunks, total) {
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function parseHead(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== "")
  const m = /^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(lines[0] || "")
  if (!m) return null
  const headers = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":")
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { status: Number(m[1]), statusText: m[2] || "", headers }
}

/** curl 参数（流式版）：比 toCurlArgs 多了 `-N` 和 `-D -`。 */
function toCurlStreamArgs(url, opts = {}) {
  const args = ["-sS", "-N", "--max-time", "300", "-D", "-"]
  const method = String(opts.method || "GET").toUpperCase()
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (v == null) continue
    args.push("-H", `${k}: ${v}`)
  }
  if (opts.body != null) {
    if (method !== "GET") args.push("-X", method)
    args.push("--data-binary", typeof opts.body === "string" ? opts.body : String(opts.body))
  } else if (method !== "GET") {
    args.push("-X", method)
  }
  args.push(url)
  return args
}

/**
 * 用系统 curl 发一次**流式**请求，返回 fetch 形状的 Response。
 *
 * 不可用时返回 `null` —— 调用方必须退回原生 fetch 的结果。
 */
export function curlStreamFetch(url, opts = {}) {
  const curl = findCurl()
  if (!curl) return null
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") return null

  let proc
  try {
    proc = Bun.spawn([curl, ...toCurlStreamArgs(url, opts)], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    })
  } catch {
    return null
  }

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()

  return (async () => {
    const chunks = []
    let total = 0
    let head = null
    let bodyStart = 0

    // 一直读到「拿到一个 ≥200 的状态行」为止。1xx（100-continue）会被跳过。
    while (!head) {
      const { value, done } = await reader.read()
      if (done) {
        try {
          proc.kill()
        } catch {}
        return null
      }
      chunks.push(value)
      total += value.length
      const buf = concatChunks(chunks, total)
      let from = 0
      while (true) {
        const end = findHeaderEnd(buf, from)
        if (end < 0) break
        const p = parseHead(decoder.decode(buf.slice(from, end)))
        if (p && p.status >= 200) {
          head = p
          bodyStart = end
          break
        }
        from = end
      }
    }

    const buf = concatChunks(chunks, total)
    const leftover = buf.slice(bodyStart)
    const headers = new Headers()
    for (const [k, v] of Object.entries(head.headers || {})) {
      // 长度 / 编码由上层重新决定，照抄会让流式响应被误判为定长
      if (k === "content-length" || k === "transfer-encoding" || k === "connection") continue
      try {
        headers.set(k, v)
      } catch {}
    }

    const body = new ReadableStream({
      start(controller) {
        if (leftover.length) controller.enqueue(leftover)
      },
      async pull(controller) {
        const { value, done } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
      },
      cancel() {
        try {
          proc.kill()
        } catch {}
      },
    })

    try {
      return new Response(body, {
        status: head.status,
        statusText: /^[\x20-\x7e]*$/.test(head.statusText) ? head.statusText : "",
        headers,
      })
    } catch {
      return new Response(body, { status: head.status, headers })
    }
  })()
}

/**
 * 模型请求的出口：先运行时 fetch，被边缘层拦了就换 curl 流式重发。
 *
 * 与 `fetchWithFallback` 的区别只有一个 —— 换通道之后仍然是**流式**。
 * 其余判据完全一致（同样的 `looksEdgeBlocked`，同样的测试桩保护）。
 */
export async function fetchStreamWithFallback(url, opts = {}) {
  const res = await globalThis.fetch(url, opts)
  if (globalThis.fetch !== NATIVE_FETCH) return res
  if (process.env.MAGICREW_NO_SCHANNEL === "1") return res
  if (!(await looksEdgeBlocked(res))) return res
  try {
    await res.body?.cancel()
  } catch {}
  const alt = await curlStreamFetch(url, opts)
  return alt ?? res
}
