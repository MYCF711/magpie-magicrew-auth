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
//
// ═══ 第三层：真浏览器（2026-11-04 加） ═══════════════════════════════════
//
// curl 这条路 2026-11-04 凌晨**也被拦了**（连打 3 次全 403，而 11-03 晚还是 200 x8）。
// 同一时刻只有真 Chromium 能过 —— 而且卡点查清了，不是 TLS 指纹本身：
//
//   页面停在 **API 域**  → 浏览器自动带 `Origin: https://i-magic-service.letsmagic.cn`
//                        → WAF 403 空 body（6/6）
//   页面停在 **官网**    → 浏览器带 `Origin: https://www.letsmagic.cn`
//                        → 200（3/3）
//
// 这正是 `api.mjs` 的 `originFor()` 早就写着的那条规则（国内要官网 Origin）。
// 所以第三层把请求交给 `src/browser-channel.mjs`：它开一个无头 Chromium、
// 页面停在官网、再跨域 fetch 目标 URL。
//
// ⚠ 这一层**不碰 magpie 的 proxy、不开任何监听端口**。它是插件 fetch 的下游，
//   天然按 provider 隔离：浏览器起不来，坏的只有 magicrew 这一个渠道。
//   （2026-11-03 23:47 / 11-04 00:44 两次「网关整体断网」都是把 proxy 指到临时端口
//     造成的，见 $DSH_HOME/AGENTS.md 铁律 2b。）

import { spawn } from "node:child_process"
import { UA } from "./ua.mjs"
import os from "node:os"
import { existsSync } from "node:fs"
// ⚠ 惰性加载，不做静态 import：browser-channel 里若哪天出语法/依赖问题，
//   静态 import 会让**整个插件加载失败**；惰性加载最坏只是这一层用不了。
let _chan   // undefined = 没加载过；null = 加载失败
async function browserChannel() {
  if (_chan !== undefined) return _chan
  try {
    _chan = await import("./browser-channel.mjs")
  } catch {
    _chan = null
  }
  return _chan
}

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
function toCurlArgs(url, opts = {}, limits = {}) {
  // ⚠ `--connect-timeout` **包含 DNS 解析时间**（2026-11-04 实测）。
  // 这个域名的 DNS 冷解析要 7–10 秒（A + AAAA + CNAME 到 volcwaf.com），
  // 不设上限的话一次请求就能吃掉 13 秒 —— magpie 给模型目录的预算只有 0–2 秒。
  const connect = Number(limits.connectTimeoutSec ?? 90)
  const maxTime = Number(limits.maxTimeSec ?? 90)
  const args = ["-sS", "--max-time", String(maxTime), "--connect-timeout", String(connect), "--location"]
  const method = String(opts.method || "GET").toUpperCase()
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (v == null) continue
    args.push("-H", `${k}: ${v}`)
  }
  if (opts.body != null) {
    // 显式给 GET 时 --data-binary 会把方法改成 POST，所以非 GET 才补 -X
    if (method !== "GET") args.push("-X", method)
    // ⚠ body **必须走 stdin**，不能塞进 argv —— Windows 单条命令行上限 32767
    //   字符，实测 40KB 的请求体直接 `ENAMETOOLONG: name too long, uv_spawn`。
    //   异常被 catch 吞掉后表现为「退回原来那条 403 空 body」，看着像 WAF、
    //   其实是请求根本没发出去：额度/模型目录全好，长上下文的对话全挂。
    args.push("--data-binary", "@-")
  } else if (method !== "GET") {
    args.push("-X", method)
  }
  // 状态码追加到尾，避免再去解析响应头
  args.push("-w", "\n__MAGICREW_STATUS__%{http_code}")
  args.push(url)
  return args
}

/** body → 能喂给子进程 stdin 的字节。 */
function bodyBytes(body) {
  if (body == null) return undefined
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  return String(body)
}

const STATUS_MARK = "__MAGICREW_STATUS__"

/**
 * 用系统 curl 发一次，包成 fetch 能看懂的 Response。
 * 拿不到可用结果时返回 `null`（调用方退回原响应）。
 *
 * ⚠⚠ **必须是异步的**（2026-11-04「一开就卡住」事故的第二个根因）。
 *
 * 0.3.73 这一版用的是 `spawnSync` —— 那是**同步阻塞**：curl 跑的这段时间，
 * 整个插件宿主的事件循环停摆，别的钩子一个都排不上。
 *
 * 真机实测同一个 endpoint 连打 6 次：`209ms / 7937ms / 210ms / 219ms / 189ms / 187ms`
 * —— 会偶发 8 秒。开 provider 时 magpie 会并发问 4 个号的模型目录，
 * 串行阻塞就是 4×8=32 秒，用户看到的就是「卡住」。
 *
 * 换成 `spawn`（异步）+ Promise 包一层之后，慢请求只占自己的时间，
 * 宿主照常响应其它钩子，再配合外层的超时兜底就不会僵。
 */
export async function curlFetch(url, opts = {}, limits = {}) {
  const curl = findCurl()
  if (!curl) return null
  const maxTimeSec = Number(limits.maxTimeSec ?? 90)
  const r = await runCurl(curl, toCurlArgs(url, opts, limits), maxTimeSec * 1000 + 5_000, bodyBytes(opts.body))
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

/**
 * 异步执行 curl，把 stdout 收齐。
 *
 * 与 `spawnSync` 的区别只有一个但很关键：**期间不阻塞事件循环**。
 *
 * @returns {Promise<{status:number, stdout:string}|null>}
 */
function runCurl(curl, args, timeoutMs, input) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(curl, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
    } catch {
      resolve(null)
      return
    }

    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { clearTimeout(timer) } catch {}
      resolve(value)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish(null)
    }, timeoutMs)

    child.stdout.on("data", (b) => {
      size += b.length
      if (size > 32 * 1024 * 1024) {
        try { child.kill() } catch {}
        finish(null)
        return
      }
      chunks.push(b)
    })
    child.on("error", () => finish(null))
    child.on("close", (code) => finish({ status: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }))

    if (input != null) {
      try { child.stdin.end(input) } catch { try { child.stdin.end() } catch {} }
    } else {
      try { child.stdin.end() } catch {}
    }
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
/**
 * 给浏览器通道套一层**整体硬 deadline**。
 *
 * 为什么必须有：magpie 调插件钩子时**持着 Go 侧的锁**。插件里任何一个
 * await 不回来，那把锁就永远拿着，整个网关僵死、只能 taskkill。
 *
 * 2026-11-04 真机（用户原话「一签到就直接把GO侧锁堵死了」「又卡住，我又要去杀进程」）
 * 就是栽在这里：浏览器通道内部有一处 CDP 调用没有超时，页面半死时永不返回。
 *
 * 内部已经逐个补了超时，但**外面这层才是最后防线** —— 不依赖内部实现对不对。
 * 到点直接当「这条通道用不了」，调用方保留原响应。
 */
const BROWSER_DEADLINE_MS = 20_000

function withDeadline(promise, ms, label) {
  let timer
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([promise.catch(() => null), guard]).finally(() => {
    try { clearTimeout(timer) } catch {}
  })
}

/**
 * 预热 DNS —— 冷解析这个域名要 **7–10 秒**（2026-11-04 实测）。
 *
 * `i-magic-service.letsmagic.cn` 同时有 A 与 AAAA 记录（CNAME 到 volcwaf.com），
 * Windows 解析器冷缓存下要 7.766s，热缓存 0.023s。
 *
 * 插件宿主是长驻进程，平时会命中系统 DNS 缓存；但**刚启动/缓存过期**那一次
 * 会特别慢，正好撞上 magpie 第一次问模型目录（预算 0–2 秒）。
 *
 * 所以加载时先悄悄解一次，把缓存焐热。失败无所谓，纯尽力而为，绝不阻塞任何钩子。
 */
let _dnsWarmed = false
export function warmUpDns(hosts = []) {
  if (_dnsWarmed) return
  _dnsWarmed = true

  // ⚠ 必须**推迟到下一轮事件循环**。
  // 实测（2026-11-04）：在这个函数里直接动作会让调用方同步阻塞 3 秒 ——
  // 那是 Bun 进程**第一次 spawn 子进程**的一次性开销。而 config 是 magpie
  // 启动路径上的一环，拖 3 秒就是「启动变慢」。
  setTimeout(async () => {
    for (const h of hosts) {
      // ① 让 Bun 自己的解析器先解一遍。
      //    这是关键的一步：Bun 的 fetch 用的是**自己的** DNS 缓存，
      //    和系统 curl 的缓存**不共享** —— 只预热 curl 对 fetch 毫无帮助。
      try { Bun?.dns?.prefetch?.(h) } catch {}

      // ② 真发一次最轻的请求，把 Bun 的 DNS 缓存焐热。
      //    实测冷解析 7.4 秒、热解析 0.06 秒。这一次花掉，后面全是热的。
      try {
        await globalThis.fetch(`https://${h}/`, {
          method: "HEAD",
          // 预热也要带 UA：不带就是运行时默认（Bun/…），边缘 WAF 会记一笔。
          headers: { "user-agent": UA },
          signal: AbortSignal.timeout(20_000),
        }).catch(() => {})
      } catch {}

      // ③ curl 那条路也预热一次（它走系统解析器，和 Bun 的不是一个缓存；
      //    而且顺便把「首次 spawn 3 秒」这笔钱提前付掉）。
      const curl = findCurl()
      if (curl) {
        try {
          const child = spawn(curl, ["-sS", "-o", os.devNull, "--max-time", "20", "-I", `https://${h}/`], {
            windowsHide: true,
            stdio: "ignore",
          })
          child.on("error", () => {})
        } catch {}
      }
    }
  }, 0)?.unref?.()
}

export async function fetchWithFallback(url, opts = {}, fb = {}) {
  // ⚠ 第一跳（运行时 fetch）**必须自带超时**，否则它自己就能吃满十几秒。
  //
  // 2026-11-04 实测：`await globalThis.fetch("…/api/v1/flows/models")` 在
  // DNS 冷缓存时要 **7.7 秒** —— 那 7.7 秒里 curl 的超时参数**一点用都没有**，
  // 因为根本还没轮到 curl。这就是「开了 provider 就卡」的最后一块拼图。
  //
  // 调用方可以用 `fb.connectTimeoutSec / fb.maxTimeSec` 声明预算；
  // 不声明就给一个宽的（30s），别把模型对话这类长请求误杀。
  //
  // ⚠⚠ **这是整个函数的总预算，不是「第一跳」的预算。**
  // 2026-11-04 教训：最初只给第一跳加了 AbortSignal.timeout，结果链条是
  //   fetch(超时) → curl(再超时) → 浏览器(再 20s)
  // 三段串起来能到 40 秒，magpie 那边就是「卡住」。
  //
  // 所以现在用 deadline：所有兜底都挂在同一个计时器下面，
  // **到点整体放弃**，返回手上最好的那个响应。调用方只需要看一个数。
  const budgetMs = Number(fb.maxTimeSec ?? 0) > 0 ? Number(fb.maxTimeSec) * 1000 : 30_000
  const deadline = Date.now() + budgetMs
  const left = () => Math.max(0, deadline - Date.now())

  const res = await globalThis
    .fetch(url, opts.signal ? opts : { ...opts, signal: AbortSignal.timeout(budgetMs) })
    .catch((e) => {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        return new Response("", { status: 504 })
      }
      throw e
    })
  // 测试 / 宿主把 fetch 换掉了 → 那是桩，不许绕过去打真网络。
  // （`node tests/*.mjs` 里全是 `globalThis.fetch = async () => …` 这种桩，
  //   若在这里真 spawn curl，桩就白设了，还会把真实凭据打出去。）
  if (globalThis.fetch !== NATIVE_FETCH) return res
  if (process.env.MAGICREW_NO_SCHANNEL === "1") return res
  if (!(await looksEdgeBlocked(res))) return res
  // ⚠ `skipCurl`：调用方连 curl 都不要试。
  //
  // 为什么需要（2026-11-04）：curl 这条路的 DNS 走 Windows 系统解析器，
  // **冷缓存实测 6–10 秒，而且 `--connect-timeout` 盖不住 DNS 那一段**。
  // 模型目录 / 额度这些「magpie 只等 0–2 秒」的钩子，试 curl 等于白等；
  // 它们本来就有 snapshot 兜底，直接快失败更划算。
  //
  // 聊天那条路（loader）**不许**加这个 —— 那条真的需要 curl 才能拿到 200。
  const alt = fb.skipCurl || left() <= 500 ? null : await curlFetch(url, opts, { ...fb, maxTimeSec: Math.ceil(left() / 1000) })
  if (alt && !(await looksEdgeBlocked(alt))) return alt
  // ⚠ 模型目录这类「调用方有硬超时」的请求必须跳过浏览器层：
  //   冷启动 10 秒，而 magpie 给 provider.models 的预算是 0–2 秒，
  //   等下去只会变成 `model list didn't finish in 0s`。
  //   这些调用方本来就有 snapshot 兜底（见 src/hooks/models.mjs），
  //   返回被拦的原响应比拖死它更好。
  if (fb.skipBrowser) return alt ?? res
  // curl 也被拦（2026-11-04 起）：最后一层交给真浏览器
  if (left() <= 500) return alt ?? res
  const chan = await browserChannel()
  const viaBrowser = chan
    ? await withDeadline(chan.browserFetch(url, opts), Math.min(BROWSER_DEADLINE_MS, left()), "browserFetch")
    : null
  if (viaBrowser && !(await looksEdgeBlocked(viaBrowser))) return viaBrowser
  return alt ?? res
}

// ══════════════════════════════════════════════════════════════════════════
// 流式通道 —— 模型请求（/v1/chat/completions）走这条
// ══════════════════════════════════════════════════════════════════════════
//
// 上面那个 `curlFetch` 会把整个 body 等完才返回 ——
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
    // 同上：body 走 stdin。对话请求的 body 动辄几十上百 KB，塞 argv 必挂。
    args.push("--data-binary", "@-")
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

  const bytes = bodyBytes(opts.body)
  let proc
  try {
    proc = Bun.spawn([curl, ...toCurlStreamArgs(url, opts)], {
      stdout: "pipe",
      stderr: "ignore",
      // 有 body 就用管道喂 `--data-binary @-`；没有 body 必须显式 ignore，
      // 否则 curl 会等在 stdin 上，请求永远发不出去。
      stdin: bytes == null ? "ignore" : new Response(bytes).body,
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
  if (alt && !(await looksEdgeBlocked(alt))) return alt
  // curl 也被拦 → 真浏览器的流式那条（SSE 不缓冲）
  const chan = await browserChannel()
  const viaBrowser = chan
    ? await withDeadline(chan.browserStreamFetch(url, opts), BROWSER_DEADLINE_MS, "browserStreamFetch")
    : null
  if (viaBrowser && !(await looksEdgeBlocked(viaBrowser))) return viaBrowser
  return alt ?? res
}
