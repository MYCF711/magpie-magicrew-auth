// 用真 Chromium 发请求 —— 绕开边缘 WAF 的「非浏览器客户端」拦截
//
// ═══ 为什么需要这一层（2026-11-03/04 真机实测） ═══════════════════════════
//
// 上游 `i-magic-service.letsmagic.cn` 挂在火山引擎 WAF 后面，它按**客户端指纹**
// 分流，同一台机器、同一时刻、同一个出口 IP：
//
//   Edge 打开 https://i-magic-service.letsmagic.cn/   → 200 `hello, magic-service!`
//   curl 打同一个地址                                  → 403 空 body（X-TT-System-Error: 3）
//   node / Bun fetch                                   → 403 空 body
//   PowerShell(.NET Schannel) / WinHTTP / Go net/http  → 403（0.3.72～0.3.73 试过）
//
// 连**不存在的路径** `/nope-xyz` 都是 403 空 body —— 说明请求根本没到业务层，
// 所以在 403 空 body 上判「token 无效 / 需要重新登录」全是误判。
//
// 结论：能过去的只有 Chromium 自己的 TLS/HTTP2 指纹。于是把「发请求」这一步
// 交给一个真 Chromium，用 CDP 在页面里 fetch。
//
// ═══ 为什么不开代理 ═══════════════════════════════════════════════════════
//
// magpie 的 `settings.proxy` 是**全局**的：一设就接管 magpie 全部出站流量。
// 临时端口上的进程一死，整个网关断网（2026-11-03 23:47 与 11-04 00:44 两次真机事故）。
// 所以本模块**不碰 proxy、不开监听端口**，只作为插件 fetch 的一路兜底 ——
// 它是 `auth.loader` 返回的那个 fetch 的下游，天然按 provider 隔离：
// 浏览器起不来，坏掉的只有 magicrew 这一个渠道。
//
// ═══ 用法 ═══════════════════════════════════════════════════════════════
//
//   import { browserFetch, browserStreamFetch } from "./browser-channel.mjs"
//   const res = await browserFetch(url, opts)          // 非流式，返回 Response
//   const res = await browserStreamFetch(url, opts)    // 流式，body 是真流
//
// ⚠ 失败一律返回 null —— 调用方保留原来那次被拦的响应，不许把 null 当结果。

import { spawn } from "node:child_process"
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/** 浏览器可执行文件：先找 Edge（Windows 自带），再找 Chrome */
const BROWSER_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
]

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (existsSync(p)) return p
    } catch {}
  }
  return null
}

/**
 * 浏览器启动参数。
 *
 * ⚠ 不要加 `--disable-web-security`。根因查清了（2026-11-04，cn 站，各跑 6 次）：
 *
 *   页面停在 API 域 + 由它自己 fetch   → 浏览器自动带 `Origin: https://i-magic-service…`
 *                                        → WAF 稳定 403 空 body（6/6）
 *   页面停在**官网** www.letsmagic.cn   → 浏览器带 `Origin: https://www.letsmagic.cn`
 *                                        → 稳定 200 + `{"code":1000}`（3/3）
 *
 *   也就是说被拒的不是 TLS 指纹本身，而是 **Origin 头等于 API 域名**这一种组合；
 *   WAF 只认「官网 Origin + 浏览器客户端」。`src/api.mjs` 的 `originFor()`
 *   早就写着这条（国内要官网 Origin、国际一个都不许带），这里只是照做。
 *   所以浏览器**导航到官网**、跨域 fetch API —— 不用关任何安全开关。
 */
const BROWSER_ARGS = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-translate",
  "--mute-audio",
  "--remote-debugging-port=0",
]

/** 单个浏览器实例：一个进程，按 origin 开标签页 */
let _inst = null

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function getJSON(url, timeoutMs = 10_000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

/** 起一个浏览器；起的整个过程有超时，起不来就返回 null（绝不死等） */
async function launch() {
  const exe = findBrowser()
  if (!exe) return null

  let profile
  try {
    profile = mkdtempSync(join(tmpdir(), "magpie-cdp-"))
  } catch {
    return null
  }

  let child
  try {
    child = spawn(exe, [...BROWSER_ARGS, `--user-data-dir=${profile}`, "about:blank"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      detached: false,
    })
  } catch {
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
    return null
  }
  child.on("error", () => {})

  // Edge 把实际端口写进 <profile>/DevToolsActivePort 第一行
  let port = null
  const deadline = Date.now() + 25_000
  while (!port && Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const raw = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")
      const n = Number((raw[0] || "").trim())
      if (Number.isFinite(n) && n > 0) port = n
    } catch {}
    if (!port) await sleep(150)
  }

  if (!port) {
    try { child.kill() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
    return null
  }

  const inst = { child, profile, port, tabs: new Map(), seq: 0, chains: new Map() }

  // 进程退出 → 标记失效，下次重建
  child.on("exit", () => {
    inst.dead = true
    if (_inst === inst) _inst = null
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  })

  return inst
}

/** 取（或建）一个指向指定 origin 的标签页，返回它的 CDP 句柄 */
async function tabFor(inst, origin) {
  const have = inst.tabs.get(origin)
  if (have && !have.dead) return have

  const targets = await getJSON(`http://127.0.0.1:${inst.port}/json/list`)
  const page = (targets || []).find((t) => t.type === "page" && !String(t.url).startsWith("chrome-extension"))
  if (!page) return null

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pend = new Map()
  const bindings = new Map()
  let seq = 0

  // ⚠ send() **必须**带超时。
  //
  // 2026-11-04 真机事故：这一版最初没有超时。CDP 只要不回应（页面崩了、
  // 浏览器半死、渲染进程挂了），这个 Promise 就**永久不 resolve** ——
  // 插件宿主那个钩子永不返回，而 magpie 是**持着 Go 侧的锁**在等它，
  // 于是整个网关当场僵死，用户只能 taskkill magpie。
  //
  // 用户原话：「一签到就直接把GO侧锁堵死了」「它又卡住，我又要去杀进程」。
  //
  // 所以每个 CDP 调用都给自己一个天花板：到点就 reject，让调用方走兜底。
  const SEND_TIMEOUT_MS = 15_000

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        pend.delete(id)
        reject(new Error(`CDP ${method} 超时 ${SEND_TIMEOUT_MS}ms`))
      }, SEND_TIMEOUT_MS)

      pend.set(id, (v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v)
      })

      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        if (!done) {
          done = true
          clearTimeout(timer)
          pend.delete(id)
          reject(e)
        }
      }
    })

  ws.onmessage = (e) => {
    let m
    try { m = JSON.parse(e.data) } catch { return }
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m)
      pend.delete(m.id)
      return
    }
    if (m.method === "Runtime.bindingCalled") {
      const fn = bindings.get(m.params.name)
      if (fn) fn(m.params.payload)
    }
  }

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("CDP 连接超时")), 10_000)
    ws.onopen = () => { clearTimeout(to); resolve() }
    ws.onerror = () => { clearTimeout(to); reject(new Error("CDP 连接失败")) }
  })

  await send("Runtime.enable")
  await send("Page.enable")

  // 导航到**页面 origin**（官网），不是 API origin。
  // 浏览器会据此自动带 `Origin: <官网>`，而那正是 WAF 放行的那种组合；
  // 停在 API 域反而会被拒（见文件头 BROWSER_ARGS 上方那组实测）。
  await send("Page.navigate", { url: origin + "/" })
  // 等到文档就绪（最多 8 秒；拿不到也继续，fetch 本身未必需要）
  for (let i = 0; i < 40; i++) {
    await sleep(200)
    const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true })
    const st = r?.result?.result?.value
    if (st === "complete" || st === "interactive") break
  }

  const tab = { ws, send, bindings, origin, dead: false }
  tab.ws.onclose = () => { tab.dead = true }
  inst.tabs.set(origin, tab)
  return tab
}

async function ensureTab(origin) {
  if (_inst && !_inst.dead) {
    const t = await tabFor(_inst, origin).catch(() => null)
    if (t) return { inst: _inst, tab: t }
    try { _inst.child.kill() } catch {}
    _inst = null
  }
  _inst = await launch()
  if (!_inst) return null
  const t = await tabFor(_inst, origin).catch(() => null)
  return t ? { inst: _inst, tab: t } : null
}

function headersToObject(headers) {
  const out = {}
  if (!headers) return out
  if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
    headers.forEach((v, k) => { out[k] = v })
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k] = v
  } else {
    for (const [k, v] of Object.entries(headers)) out[k] = v
  }
  return out
}

/** 这些头交给浏览器自己算，不许从外部覆盖 */
const SKIP_HEADERS = new Set([
  "host", "connection", "content-length", "accept-encoding", "transfer-encoding", "origin", "referer",
])

// ═══ 频次闸门（2026-11-04 血的教训）═══════════════════════════════════════
//
// 火山 WAF 除了指纹层，还有**频次层**：同一出口 IP 短时间内打太多，
// 它就不再区分客户端 —— 连真 Chromium 也返回拦截页，持续几十分钟。
//
// 2026-11-04 02:13 真机事故：会话里为了验证通道跑了 100+ 次请求，
// 之后 `i-magic-service.letsmagic.cn` 对整台机器回 403，
// 事件编号 2026110402134548CE5122E88DDE3F48D8，连 `www.letsmagic.cn` 都一度被打掉。
//
// 所以这一层**必须自己限速**，不能指望调用方克制：
//
//   · 同一个 origin 两次请求至少隔 1.2 秒
//   · 一分钟窗口内最多 40 次
//   · 一旦认出「拦截页」（403 + text/html / 火山 WAF 文案）→ 静默 30 分钟
//
// 静默期内直接返回 null（调用方保留原响应），一个字节都不打到上游。
const GATE = {
  minIntervalMs: 1200,
  windowMs: 60_000,
  maxPerWindow: 40,
  banCooldownMs: 30 * 60_000,
}

const _gate = new Map()   // origin → { last, hits: number[], bannedUntil, bans }

function gateOf(origin) {
  let g = _gate.get(origin)
  if (!g) {
    g = { last: 0, hits: [], bannedUntil: 0, bans: 0, misses: 0 }
    _gate.set(origin, g)
  }
  return g
}

/** 放行返回 true；限流 / 静默返回 false（调用方必须当成"这条通道用不了"） */
async function passGate(origin) {
  const g = gateOf(origin)
  const now = Date.now()

  if (g.bannedUntil > now) return false

  g.hits = g.hits.filter((t) => now - t < GATE.windowMs)
  if (g.hits.length >= GATE.maxPerWindow) return false

  const wait = g.last + GATE.minIntervalMs - now
  if (wait > 0) await sleep(wait)

  g.last = Date.now()
  g.hits.push(g.last)
  return true
}

/**
 * 认「这是不是火山 WAF 的拦截页」。
 *
 * 两种形态都要认：
 *   ① 403 + text/html + 正文含「请求已被阻断 / Web应用防火墙 / 事件编号」
 *      —— 频次层，说明已经把它打急了
 *   ② 403 + 空 body + `x-tt-system-error`（浏览器侧看不到头，但 body 为空 + 非 JSON）
 *      —— 指纹层；这条**不该**在浏览器通道里出现，出现就一起静默
 */
function looksLikeWafPage(status, ct, body) {
  if (status !== 403 && status !== 405 && status !== 429) return false
  const type = String(ct || "").toLowerCase()
  const text = String(body || "")
  if (text && /请求已被阻断|Web应用防火墙|事件编号|volcengine|访问被拒绝/i.test(text)) return true
  if (type.includes("text/html") && !/^\s*[[{]/.test(text.slice(0, 8))) return true
  return false
}

/**
 * 页面里 fetch 抛异常 = 拿不到 CORS 头 = 上游没回正常的 200。
 *
 * 实测（2026-11-04）：`/api/v1/settings/all` 在上游 403 时**不带**
 * `access-control-allow-origin`，浏览器直接抛 `Failed to fetch`，
 * 我们连 status 都读不到 —— 所以 catch 分支也必须计入闸门，
 * 否则「上游已经把我们拉黑」这件事对闸门完全不可见。
 *
 * 保守起见：连续 3 次拿不到 → 当作撞了拦截页，静默一轮。
 */
function noteMiss(origin) {
  const g = gateOf(origin)
  g.misses++
  if (g.misses >= 3) {
    g.misses = 0
    noteWafBlock(origin)
  }
}

/** 拿到正常响应 → 清掉连续失败计数 */
function noteHit(origin) {
  const g = gateOf(origin)
  g.misses = 0
}

/** 撞到拦截页 → 整个 origin 静默 */
function noteWafBlock(origin) {
  const g = gateOf(origin)
  g.bannedUntil = Date.now() + GATE.banCooldownMs
  g.bans++
  g.hits = []
}

/** 给测试 / 诊断用：看一眼闸门状态（不产生请求） */
export function gateStatus(origin) {
  const g = _gate.get(origin)
  if (!g) return null
  const now = Date.now()
  return {
    banned: g.bannedUntil > now,
    bannedForMs: Math.max(0, g.bannedUntil - now),
    windowHits: g.hits.filter((t) => now - t < GATE.windowMs).length,
    maxPerWindow: GATE.maxPerWindow,
    minIntervalMs: GATE.minIntervalMs,
    bans: g.bans,
    misses: g.misses,
  }
}

/**
 * 页面该停在哪 —— **不是 API 自己的 origin**，是它对应的官网。
 *
 * WAF 拒的是「Origin = API 域名」这一种组合；停在官网，浏览器带的
 * `Origin: https://www.letsmagic.cn` 才是放行的那种（实测 3/3 200）。
 * 国际站一个 Origin 都不许带，所以页面停在官网后由 browserFetch 显式去掉 origin 头
 * （见 SKIP_HEADERS 已经包含 origin / referer）。
 */
const PAGE_ORIGIN = new Map([
  ["https://i-magic-service.letsmagic.cn", "https://www.letsmagic.cn"],
  ["https://magic-service.magicrew.ai", "https://www.magicrew.ai"],
])

function resolveOrigin(url) {
  try {
    const u = new URL(url)
    const apiOrigin = `${u.protocol}//${u.host}`
    return PAGE_ORIGIN.get(apiOrigin) ?? apiOrigin
  } catch {
    return null
  }
}

/**
 * 非流式：在页面里 fetch，把整个 body 带回来。
 *
 * @returns {Promise<Response|null>} 失败返回 null（调用方保留原响应）
 */
export async function browserFetch(url, opts = {}) {
  const origin = resolveOrigin(url)
  if (!origin) return null

  // 频次闸门：静默期内一个字节都不打上游
  if (!(await passGate(origin))) return null

  const ctx = await ensureTab(origin).catch(() => null)
  if (!ctx) return null
  const { tab } = ctx

  const headers = headersToObject(opts.headers)
  for (const k of Object.keys(headers)) {
    if (SKIP_HEADERS.has(k.toLowerCase())) delete headers[k]
  }

  // 用绝对 URL（tab 已在该 origin 上，绝对 URL 也是同源）
  const payload = {
    method: String(opts.method || "GET").toUpperCase(),
    headers,
  }
  if (opts.body != null) {
    payload.body = typeof opts.body === "string" ? opts.body : String(opts.body)
  }

  const expr = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(payload)});
      const b = await r.text();
      return JSON.stringify({ status: r.status, ct: r.headers.get("content-type") || "", body: b });
    } catch (e) {
      return JSON.stringify({ error: String(e && e.message) });
    }
  })()`

  let r
  try {
    r = await tab.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })
  } catch {
    tab.dead = true
    return null
  }

  if (r?.error) return null
  const raw = r?.result?.result?.value
  if (!raw) return null

  let parsed
  try { parsed = JSON.parse(raw) } catch { return null }
  if (parsed.error || !parsed.status) {
    noteMiss(origin)
    return null
  }
  noteHit(origin)

  // 认出拦截页 → 整个 origin 静默 30 分钟，别再打
  if (looksLikeWafPage(parsed.status, parsed.ct, parsed.body)) {
    noteWafBlock(origin)
    return null
  }

  return new Response(parsed.body, {
    status: parsed.status,
    headers: parsed.ct ? { "content-type": parsed.ct } : {},
  })
}

/**
 * 流式：页面里读 ReadableStream，逐块通过 CDP binding 推到这边。
 *
 * 非要单独一条的原因：非流式那条会把整轮回答憋到最后一次性吐出，
 * 模型请求（/v1/chat/completions）用它会变成「假死」。
 *
 * @returns {Promise<Response|null>}
 */
export async function browserStreamFetch(url, opts = {}) {
  const origin = resolveOrigin(url)
  if (!origin) return null

  if (!(await passGate(origin))) return null

  const ctx = await ensureTab(origin).catch(() => null)
  if (!ctx) return null
  const { tab } = ctx

  const headers = headersToObject(opts.headers)
  for (const k of Object.keys(headers)) {
    if (SKIP_HEADERS.has(k.toLowerCase())) delete headers[k]
  }

  const payload = { method: String(opts.method || "GET").toUpperCase(), headers }
  if (opts.body != null) {
    payload.body = typeof opts.body === "string" ? opts.body : String(opts.body)
  }

  const name = "mgcb" + (++tab.seq)
  let controller = null
  const stream = new ReadableStream({
    start(c) { controller = c },
    cancel() {
      try { tab.bindings.delete(name) } catch {}
    },
  })

  let headResolve
  const headPromise = new Promise((r) => { headResolve = r })
  let head = null

  tab.bindings.set(name, (rawJson) => {
    let m
    try { m = JSON.parse(rawJson) } catch { return }
    if (m.type === "head") {
      head = { status: m.status, ct: m.ct }
      headResolve(head)
    } else if (m.type === "chunk") {
      try {
        const bytes = Uint8Array.from(atob(m.data), (ch) => ch.charCodeAt(0))
        controller?.enqueue(bytes)
      } catch {}
    } else if (m.type === "end") {
      try { controller?.close() } catch {}
      tab.bindings.delete(name)
    } else if (m.type === "err") {
      try { controller?.error(new Error(m.message || "browser fetch failed")) } catch {}
      tab.bindings.delete(name)
      if (!head) headResolve(null)
    }
  })

  try {
    await tab.send("Runtime.addBinding", { name })
  } catch {
    tab.bindings.delete(name)
    tab.dead = true
    return null
  }

  const expr = `(async () => {
    const CB = window[${JSON.stringify(name)}];
    try {
      const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(payload)});
      CB(JSON.stringify({ type: "head", status: r.status, ct: r.headers.get("content-type") || "" }));
      if (!r.body) { CB(JSON.stringify({ type: "end" })); return; }
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        let bin = "";
        const u8 = value;
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        CB(JSON.stringify({ type: "chunk", data: btoa(bin) }));
      }
      CB(JSON.stringify({ type: "end" }));
    } catch (e) {
      CB(JSON.stringify({ type: "err", message: String(e && e.message) }));
    }
  })()`

  tab.send("Runtime.evaluate", { expression: expr, awaitPromise: false }).catch(() => {})

  // 等响应头（最多 120 秒 —— 模型首字可能很慢）
  const to = setTimeout(() => { if (!head) headResolve(null) }, 120_000)
  const got = await headPromise
  clearTimeout(to)

  if (!got) {
    tab.bindings.delete(name)
    noteMiss(origin)
    return null
  }
  noteHit(origin)

  // 流式这条拿不到 body（还没读），只能按 status + content-type 判
  if (looksLikeWafPage(got.status, got.ct, "")) {
    tab.bindings.delete(name)
    noteWafBlock(origin)
    return null
  }

  return new Response(stream, {
    status: got.status,
    headers: got.ct ? { "content-type": got.ct } : {},
  })
}

/** 关掉浏览器（插件宿主退出时调用；不调也能靠进程退出带走） */
export function shutdownBrowser() {
  if (!_inst) return
  try { _inst.child.kill() } catch {}
  _inst = null
}

// 宿主退出时收尾，别留孤儿 Edge
try {
  process.once("exit", shutdownBrowser)
  process.once("SIGINT", shutdownBrowser)
  process.once("SIGTERM", shutdownBrowser)
} catch {}
