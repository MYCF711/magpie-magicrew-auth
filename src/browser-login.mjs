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
//   **每次登录一个一次性 profile，用完删** —— 为什么不能复用，见下面 newProfileDir()。

import { spawn } from "node:child_process"
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const BASE = () => join(homedir(), ".cache", "magpie")

/**
 * 每次登录一个**一次性** profile 目录，登录结束就删。
 *
 * ⚠ 这里曾经刻意复用同一个目录（旧注释：`复用同一个 profile：第二次登录时里面已经有 cookie 了`），
 *   那是个 bug —— 现象是「添加第二个账号时，网页正确弹出、然后瞬间关闭，
 *   magpie 里也没多出账号」：
 *
 *     ① 复用目录里的 localStorage 还躺着**上一个账号**的 jwt + org；
 *     ② 浏览器一打开，`waitForCreds` 第一轮（1.5 秒内）就读到它 → 判定「登录完成」→ 关窗；
 *     ③ magpie 拿到的 accountId / uid 与已有账号一模一样，按契约
 *        （同一 accountId + 同一 uid → 替换旧账号）不会新增账号。
 *
 *   一次性目录把这条路彻底堵死：读到的凭据只可能是本次登录写进去的。
 *   代价是每次都要在这个窗口里重新登一次 —— 独立 profile 本来也没有他日常浏览器的 cookie。
 */
export function newProfileDir() {
  const d = join(
    BASE(),
    `magicrew-login-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(d, { recursive: true })
  return d
}

/**
 * 清残留：超过 maxAgeMs 的一次性 profile，以及历史上那个**复用**目录
 * （`magicrew-login-profile`，里面装着别的账号的 cookie —— 正是上面那个 bug 的来源）。
 * 只删本插件自己造的名字，别的一概不碰。
 */
export function sweepProfiles({ maxAgeMs = 2 * 3600_000 } = {}) {
  let names = []
  try {
    names = readdirSync(BASE())
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const legacy = name === "magicrew-login-profile"
    if (!legacy && !/^magicrew-login-/.test(name)) continue
    const p = join(BASE(), name)
    try {
      // ⚠ 只动目录：同前缀的日志文件（magicrew-login-*.log）不是 profile
      const st = statSync(p)
      if (!st.isDirectory()) continue
      // 遗留的复用目录不管多新都删；一次性目录只在过期后删（可能正有别的账号在登）
      if (!legacy && Date.now() - st.mtimeMs < maxAgeMs) continue
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      removed++
    } catch {}
  }
  return removed
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

  // 先扫掉上一次登录留下的临时 profile（含历史复用目录），再开一个全新的
  sweepProfiles()
  const dir = newProfileDir()
  // ⚠ 残留会让这次「看起来起来了、其实什么都没做」—— 一次性目录里通常没有，
  //   但 sweep 失败、或目录被复用时它们就是根因，清一遍几乎不花钱：
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
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
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
  // 卡片上要显示一个能认的名字：**手机号 → 邮箱 → 昵称 → 真名**
  // （昵称是用户自己填的，可以不填也可以乱填；手机号是登录凭据本身。
  //   服务端存的是打码版 138****8000，但仍是唯一稳定的账号标识）
  const ui = obj("MAGIC:user:userInfo") || {}
  const name = String(ui.phone || ui.email || ui.nickname || ui.real_name || "").trim()
  return JSON.stringify({ jwt, org, name })
})()`

/**
 * 盯着那个浏览器，直到页面里的 localStorage 出现完整凭据。
 *
 * `baseline` = 「窗口打开时就已经在 localStorage 里的那份」。传进来的话，
 * 只有**跟它不一样**的凭据才算登录成功。一次性 profile 下它恒为空，
 * 留着是第二道防线：万一哪天又改回复用目录，这条判据能挡住「读到上一个账号」。
 *
 * @param {{jwt:string, org:string}|null} [opts.baseline]
 * @param {(port:number, host:string, expr:string)=>Promise<string>} [opts.probe] 测试注入用
 * @returns {Promise<{jwt:string, org:string, name?:string} | null>}
 */
export async function waitForCreds(
  session,
  hostFragment,
  { timeout = 300_000, interval = 1500, baseline = null, probe = evaluate } = {},
) {
  const base = baseline ?? session?.baseline ?? null
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const raw = await probe(session.port, hostFragment, READ_CREDS)
      if (raw) {
        const o = JSON.parse(raw)
        if (o?.jwt?.startsWith("eyJ") && o?.org) {
          const same = base && o.jwt === base.jwt && o.org === base.org
          if (!same) return o
        }
      }
    } catch {
      // 页面还在加载 / target 换了 —— 下一轮再试
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return null
}

/**
 * 关掉这个浏览器窗口，然后把这一次的临时 profile 删掉。
 *
 * 两条路都要走：
 *   ① CDP 的 `Browser.close` —— 走浏览器自己的退出流程，进程干净退出
 *   ② 兜底 kill —— ①在 2 秒内没关掉就强杀整棵进程树
 *      （Windows 上 kill() 只杀主进程，渲染/GPU 子进程会留着占住 profile，
 *        后面的 rmSync 也会因为文件锁失败）
 *
 * ⚠ profile 是**一次性**的，删掉是对的：里面只有这次登录的 cookie，
 *   留着只会让下一次登录读到上一个账号（见 newProfileDir 的注释）。
 *   删不掉不影响正确性 —— 下次 launch 会先 sweepProfiles()。
 */
export async function closeSession(session) {
  if (!session) return

  // ① 优雅关：Browser.close 走浏览器自己的退出流程
  try {
    const r = await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(3000) })
    const v = await r.json()
    if (v?.webSocketDebuggerUrl) {
      await new Promise((resolve) => {
        const ws = new WebSocket(v.webSocketDebuggerUrl)
        const done = () => {
          try {
            ws.close()
          } catch {}
          resolve()
        }
        const t = setTimeout(done, 2000)
        ws.addEventListener(
          "open",
          () => {
            try {
              ws.send(JSON.stringify({ id: 1, method: "Browser.close" }))
            } catch {}
            // 给它 600ms 自己退，退不掉就走 ②
            setTimeout(() => {
              clearTimeout(t)
              done()
            }, 600)
          },
          { once: true },
        )
        ws.addEventListener(
          "error",
          () => {
            clearTimeout(t)
            done()
          },
          { once: true },
        )
      })
    }
  } catch {}

  // ② 兜底：还活着就强杀整棵进程树
  const pid = session.child?.pid
  if (pid) {
    try {
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
          k.on("exit", resolve)
          k.on("error", resolve)
          setTimeout(resolve, 3000)
        })
      } else {
        try {
          session.child.kill("SIGKILL")
        } catch {}
      }
    } catch {}
  }

  // ③ 删掉这一次的临时 profile。文件锁通常要等子进程死透才放，
  //    所以给它几次机会；删不掉就算了，下次 launch 会 sweep。
  const dir = session.dir
  if (!dir) return
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

export const _internal = { READ_CREDS, newProfileDir, sweepProfiles, waitPort, evaluate }
