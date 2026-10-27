// 极简 CDP 客户端 —— 零依赖，只用 Node 内置 WebSocket（Node ≥ 22）
//
// 为什么不用 puppeteer/playwright：这台机器上没有装，而它们对这个活（点几十次按钮）
// 是杀鸡用牛刀。CDP 的 Runtime.evaluate 就够：所有操作都在页面上下文里跑一段 JS。
//
// 用法：
//   const cdp = await connect("http://127.0.0.1:9222")
//   await cdp.eval(`document.title`)
//   await cdp.close()

export async function listTargets(endpoint) {
  const base = endpoint.replace(/\/$/, "")
  const res = await fetch(`${base}/json/list`)
  if (!res.ok) throw new Error(`拿不到 target 列表：HTTP ${res.status}`)
  return res.json()
}

/** 挑一个 page 类型的 target；可以用 urlIncludes 过滤 */
export async function pickPage(endpoint, urlIncludes = "") {
  const targets = await listTargets(endpoint)
  const pages = targets.filter((t) => t.type === "page")
  if (!pages.length) throw new Error("没有 page target")
  if (!urlIncludes) return pages[0]
  const hit = pages.find((p) => (p.url || "").includes(urlIncludes))
  if (!hit) throw new Error(`没有 URL 含 ${urlIncludes} 的页面，现有：${pages.map((p) => p.url).join(" | ")}`)
  return hit
}

export async function connect(endpoint, { urlIncludes = "", target } = {}) {
  const t = target ?? (await pickPage(endpoint, urlIncludes))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", (e) => reject(new Error(`WS 连接失败：${e?.message ?? e}`)), { once: true })
  })

  let id = 0
  const pending = new Map()

  ws.addEventListener("message", (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      pending.set(myId, { resolve, reject })
      ws.send(JSON.stringify({ id: myId, method, params }))
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 30_000)
    })

  await send("Runtime.enable").catch(() => {})

  return {
    target: t,
    send,
    /** 在页面里跑一段表达式，返回它的值（会 await promise，失败抛错） */
    async eval(expression) {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "页面里抛错")
      }
      return r.result?.value
    },
    async goto(url) {
      await send("Page.navigate", { url })
    },
    async screenshot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png" })
      const fs = await import("node:fs")
      fs.writeFileSync(path, Buffer.from(data, "base64"))
      return path
    },
    close() {
      try {
        ws.close()
      } catch {}
    },
  }
}

/** 等一个条件在页面里成立（轮询 eval），成立返回真值，超时抛错 */
export async function waitFor(cdp, expression, { timeout = 15_000, interval = 300, label = expression } = {}) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeout) {
    try {
      const v = await cdp.eval(expression)
      if (v !== null && v !== undefined && v !== false) return v
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`等待超时（${timeout}ms）：${label}${lastErr ? ` / ${lastErr.message}` : ""}`)
}
