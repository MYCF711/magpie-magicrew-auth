// 自己拉起浏览器登录，再从 CDP 里把凭据读回来。
//
// ═══ 为什么必须自己拉浏览器 ══════════════════════════════════════════
//
// magicrew 没有 OAuth 回调通道（见 docs/internals.md 第九节），所以「官方页面登录
// 完，插件自动拿到 token」这件事，只有一条路：**浏览器得是插件能看进去的那一个**。
//
// magpie 打开的浏览器是系统默认实例 —— 插件没有它的调试端口，读不到它的 localStorage。
// 所以这里自己拉一个：独立 profile + `--remote-debugging-port=0`，登录完用 CDP
// 在页面上下文里执行一次 localStorage 读取，拿到 jwt + organizationCode，关掉窗口。
//
// 这正是 authorize 返回 `opened: true` 的正当场景（HOOKS.md 陷阱 3）：
// 页面是我们自己开的，告诉 magpie 「别再开一次」。
//
// ⚠ 独立 profile 意味着用户要在这个窗口里登一次（没有他日常浏览器的 cookie）。
//   所以 profile 目录**不删**，下次还能复用登录态：~/.cache/magpie/magicrew-login-profile

import { spawn } from "node:child_process"
import { existsSync, readFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 复用同一个 profile：第二次登录时里面已经有 cookie 了 */
function profileDir() {
  const d = join(homedir(), ".cache", "magpie", "magicrew-login-profile")
  try {
    mkdirSync(d, { recursive: true })
  } catch {}
  return d
}

/** 按平台找浏览器；找不到返回 null，调用方降级 */
export function findBrowser() {
  const plat = process.platform
  const candidates =
    plat === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
          "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        ]
      : plat === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/snap/bin/chromium",
          ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p
    } catch {}
  }
  return null
}

/**
 * 等 Chromium 把 DevToolsActivePort 写出来。
 * 文件两行：第一行端口，第二行 ws 路径。`--remote-debugging-port=0` 让系统挑端口，
 * 避免和已有的调试端口撞车。
 */
async function waitPort(dir, timeoutMs = 8_000) {
  const f = join(dir, "DevToolsActivePort")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const line = readFileSync(f, "utf8").split("\n")[0].trim()
      const port = Number(line)
      if (port > 0) return port
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  return 0
}

/**
 * 拉起浏览器并打开登录页。
 * @returns {Promise<{port:number, dir:string, child:import("node:child_process").ChildProcess} | null>}
 */
export async function launchLoginBrowser(url) {
  const exe = findBrowser()
  if (!exe) throw new Error("本机没找到 Chrome / Edge / Bravo / Chromium")

  const dir = profileDir()
  // ⚠ 上一次的残留会让这次「看起来起来了、其实什么都没做」：
  //   DevToolsActivePort  —— 不清掉，waitPort 会立刻返回一个已失效的旧端口
  //   SingletonLock / SingletonCookie / SingletonSocket / lockfile
  //                       —— 不清掉，新进程判定 profile 被占用，把 URL 转交给
  //                          那个已经死掉的实例，然后自己退出
  const { unlinkSync } = await import("node:fs")
  for (const f of ["DevToolsActivePort", "SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    try {
      unlinkSync(join(dir, f))
    } catch {}
  }

  let child
  try {
    child = spawn(
      exe,
      [
        `--user-data-dir=${dir}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,MediaRouter",
        "--disable-background-networking",
        url,
      ],
      { stdio: "ignore", detached: false, windowsHide: false },
    )
  } catch (e) {
    throw new Error(`浏览器启动失败：${e?.message ?? e}`)
  }

  const port = await waitPort(dir)
  if (!port) {
    try {
      child.kill()
    } catch {}
    throw new Error("浏览器进程起来了，但 8 秒内没写出调试端口 DevToolsActivePort（多半是 profile 被一个已退出的实例占着）")
  }
  return { port, dir, child }
}

// ── 最小 CDP 客户端 ───────────────────────────────────────────────────

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
  return res.json()
}

/** 找到登录页那个 target；**必须**URL 匹配，否则返回 null 让调用方继续等 */
async function pickLoginPage(port, hostFragment) {
  const pages = (await listPages(port)).filter((t) => t.type === "page" && t.webSocketDebuggerUrl)
  if (!pages.length) return null
  // ⚠ 不能退回 pages[0]：浏览器刚起来时那个 target 还是 about:blank，
  //   在它上面访问 localStorage 会抛 SecurityError，被当成「读不到」而空转。
  return pages.find((p) => String(p.url || "").includes(hostFragment)) ?? null
}

/** 在页面上下文里求值一次 */
async function evaluate(port, hostFragment, expression, timeoutMs = 8000) {
  const page = await pickLoginPage(port, hostFragment)
  if (!page) throw new Error("没有可用的页面 target")

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP 连接超时")), timeoutMs)
    ws.addEventListener("open", () => {
      clearTimeout(t)
      resolve()
    })
    ws.addEventListener("error", (e) => {
      clearTimeout(t)
      reject(new Error(`CDP 连接失败：${e?.message ?? e}`))
    })
  })

  try {
    const reply = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP 求值超时")), timeoutMs)
      ws.addEventListener("message", (ev) => {
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg.id !== 1) return
        clearTimeout(t)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      })
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      )
    })
    if (reply?.exceptionDetails) return ""
    return reply?.result?.value ?? ""
  } finally {
    try {
      ws.close()
    } catch {}
  }
}

/** 在页面的 localStorage 里取 jwt + 组织码 —— 一次求值，两个都拿 */
const READ_CREDS = `(() => {
  const raw = (k) => { try { return localStorage.getItem(k) || "" } catch { return "" } }
  const pick = (k) => {
    const s = raw(k)
    if (!s) return ""
    try {
      const o = JSON.parse(s)
      return typeof o === "object" && o ? String(o.value ?? "") : String(s)
    } catch { return s }
  }
  const obj = (k) => {
    try {
      const o = JSON.parse(raw(k))
      return (o && typeof o === "object" ? (o.value ?? o) : null) || null
    } catch { return null }
  }
  const jwt = pick("MAGIC:user:authorization")
  const org = pick("MAGIC:user:organizationCode")
  if (!jwt || !jwt.startsWith("eyJ") || !org) return ""
  // 卡片上要显示一个能认的名字：昵称 → 真名 → 手机号 → 邮箱
  // （服务端存的是打码手机号，昵称才是对人友好的那个）
  const ui = obj("MAGIC:user:userInfo") || {}
  const name = String(ui.nickname || ui.real_name || ui.phone || ui.email || "").trim()
  return JSON.stringify({ jwt, org, name })
})()`

/**
 * 盯着那个浏览器，直到页面里的 localStorage 出现完整凭据。
 * @returns {Promise<{jwt:string, org:string} | null>}
 */
export async function waitForCreds(session, hostFragment, { timeout = 300_000, interval = 1500 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const raw = await evaluate(session.port, hostFragment, READ_CREDS)
      if (raw) {
        const o = JSON.parse(raw)
        if (o?.jwt?.startsWith("eyJ") && o?.org) return o
      }
    } catch {
      // 页面还在加载 / target 换了 —— 下一轮再试
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return null
}

/** 关掉这个浏览器窗口（profile 留着，下次复用登录态） */
export function closeSession(session) {
  const pid = session?.child?.pid
  if (!pid) return
  try {
    if (process.platform === "win32") {
      // kill() 只杀主进程，渲染/GPU 子进程会留着占住 profile
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    } else {
      session.child.kill("SIGKILL")
    }
  } catch {}
}

export const _internal = { READ_CREDS, profileDir, waitPort, evaluate }
