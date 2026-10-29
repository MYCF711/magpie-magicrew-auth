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

import { spawn, execFileSync } from "node:child_process"
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, basename } from "node:path"

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

/**
 * 候选浏览器表 —— 按平台给，**按优先级排**。
 *
 * ⚠ 顺序有意义：靠前的先试。选序的道理不是「谁更有名」，而是
 *   **谁更干净、更不会被系统策略拦住调试端口**：
 *
 *     ① Chrome / Chromium   自己装的，没有企业策略、没有强制登录、没有侧边栏
 *     ② 国产 Chromium 系    用户日常在用的那个，CDP 实测一样能用
 *     ③ Edge                Windows 自带，**放最后**：
 *                          · 企业/组策略常禁用远程调试，起不来的概率最高
 *                          · 会被系统账号强制接管、带侧边栏与首次运行引导
 *                          · 用户明确反馈「讨厌 Edge」，没有理由优先选它
 *
 *   实测（2026-10-28，本机）：
 *     Chromium 154.0.8037.93 (scoop)  起 CDP 650ms，页面就绪 ~2s，读凭据正常
 *     Edge     122.0.2365.106         同上可用，但按上面的理由排在后面
 *     360ChromeX (Chrome 132 内核)    同上可用
 *
 * ⚠⚠ Edge 这里曾经还有一个真 bug：写死的文件名是 `msedge.exe`，
 *   而**有些**机器上微软落盘的是 **`Microsoft Edge.exe`**（带空格、带大写），
 *   另一些机器的同一版本只有 `msedge.exe`。落盘名随安装方式/版本变，
 *   写死任何一个都必有一类机器命中不到。
 *   于是 existsSync 一路 miss → findBrowser() 返回 null → 永远走「降级」：
 *   系统浏览器打开 + 让用户去 Console 粘一行。用户看到的现象就是
 *   **「网页已经登好、跳到 agent 界面了，magpie 里还在转圈等」**。
 *   判据在 ~/.cache/magpie/magicrew-login-<site>.log：
 *       launch: 本机没找到 Chrome / Edge / Bravo / Chromium
 *
 *   ⇒ 两个名字都留着（不同安装方式/版本落盘的名字不一样），谁在就用谁。
 *
 * @param {string} [platform] 默认 process.platform（测试注入用）
 * @param {Record<string,string>} [env] 默认 process.env（测试注入用）
 * @returns {{name:string, path:string}[]}
 */
export function browserCandidates(platform = process.platform, env = process.env) {
  const e = env || {}
  if (platform === "win32") {
    const local = e.LOCALAPPDATA || ""
    const roaming = e.APPDATA || ""
    const home = e.USERPROFILE || e.HOME || ""
    const pf = e.PROGRAMFILES || "C:\\Program Files"
    const pf86 = e["PROGRAMFILES(X86)"] || e["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    /** 一个浏览器常有 64/32 位两个安装根，按序都给 */
    const under = (root, rest) => `${root}\\${rest}`

    return [
      // ═══ ① Chrome / Chromium —— 首选：纯净、没策略、没强制登录 ═══════
      { name: "Chrome", path: under(pf, "Google\\Chrome\\Application\\chrome.exe") },
      { name: "Chrome", path: under(pf86, "Google\\Chrome\\Application\\chrome.exe") },
      { name: "Chrome", path: under(local, "Google\\Chrome\\Application\\chrome.exe") },

      // Chromium：scoop 安装的（本机就是这个，154 版，实测最顺）
      { name: "Chromium", path: under(home, "scoop\\apps\\chromium\\current\\chrome.exe") },
      { name: "Chromium", path: under(local, "Chromium\\Application\\chrome.exe") },
      { name: "Chromium", path: under(pf, "Chromium\\Application\\chrome.exe") },
      { name: "Chromium", path: under(pf86, "Chromium\\Application\\chrome.exe") },
      // 便携版常见的解压目录
      { name: "Chromium", path: under(home, "Chromium\\chrome.exe") },

      { name: "Brave", path: under(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") },
      { name: "Brave", path: under(pf86, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") },
      { name: "Brave", path: under(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") },

      { name: "Vivaldi", path: under(local, "Vivaldi\\Application\\vivaldi.exe") },
      { name: "Vivaldi", path: under(pf, "Vivaldi\\Application\\vivaldi.exe") },
      { name: "Opera", path: under(local, "Programs\\Opera\\opera.exe") },
      { name: "Opera", path: under(roaming, "Opera Software\\Opera Stable\\opera.exe") },

      // ═══ ② 国产 Chromium 系（都是 Chromium 内核，CDP 一样能用）═════
      // 360 极速浏览器 X —— 实测 Chrome 132 内核，CDP 完全可用
      { name: "360极速浏览器X", path: under(local, "360ChromeX\\Chrome\\Application\\360ChromeX.exe") },
      { name: "360浏览器", path: under(local, "360Chrome\\Chrome\\Application\\360chrome.exe") },
      { name: "360浏览器", path: under(local, "360Chrome\\Chrome\\Application\\360Chrome.exe") },
      { name: "360安全浏览器", path: under(roaming, "secoresdk\\360se6\\Application\\360se.exe") },
      { name: "360安全浏览器", path: under(local, "360se\\Application\\360se.exe") },
      { name: "QQ浏览器", path: under(local, "Tencent\\QQBrowser\\Application\\QQBrowser.exe") },
      { name: "QQ浏览器", path: under(pf, "Tencent\\QQBrowser\\QQBrowser.exe") },
      { name: "搜狗浏览器", path: under(local, "SogouExplorer\\SogouExplorer.exe") },
      { name: "搜狗浏览器", path: under(pf, "SogouExplorer\\SogouExplorer.exe") },
      { name: "2345浏览器", path: under(local, "2345Explorer\\2345Explorer.exe") },
      { name: "猎豹浏览器", path: under(local, "liebao\\liebao.exe") },
      { name: "傲游浏览器", path: under(roaming, "Maxthon3\\Bin\\Maxthon.exe") },
      { name: "UC浏览器", path: under(local, "UCBrowser\\Application\\UCBrowser.exe") },
      { name: "夸克浏览器", path: under(local, "Quark\\Quark.exe") },

      // ═══ ③ Edge —— 最后：策略最多、最容易被拦住、用户也最不想用它 ═══
      // ⚠ 真实文件名是 "Microsoft Edge.exe"；msedge.exe 也留着以防别的装法
      { name: "Edge", path: under(pf86, "Microsoft\\Edge\\Application\\Microsoft Edge.exe") },
      { name: "Edge", path: under(pf, "Microsoft\\Edge\\Application\\Microsoft Edge.exe") },
      { name: "Edge", path: under(pf86, "Microsoft\\Edge\\Application\\msedge.exe") },
      { name: "Edge", path: under(pf, "Microsoft\\Edge\\Application\\msedge.exe") },
    ]
  }

  if (platform === "darwin") {
    const h = e.HOME || ""
    return [
      { name: "Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
      { name: "Vivaldi", path: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" },
      { name: "Chrome", path: `${h}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` },
      { name: "Chromium", path: `${h}/Applications/Chromium.app/Contents/MacOS/Chromium` },
      { name: "Brave", path: `${h}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser` },
      // Edge 同样放最后
      { name: "Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { name: "Edge", path: `${h}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` },
    ]
  }

  return [
    { name: "Chrome", path: "/usr/bin/google-chrome" },
    { name: "Chrome", path: "/usr/bin/google-chrome-stable" },
    { name: "Chromium", path: "/usr/bin/chromium" },
    { name: "Chromium", path: "/usr/bin/chromium-browser" },
    { name: "Chromium", path: "/snap/bin/chromium" },
    { name: "Brave", path: "/usr/bin/brave-browser" },
    { name: "Vivaldi", path: "/usr/bin/vivaldi" },
    // Edge 同样放最后
    { name: "Edge", path: "/usr/bin/microsoft-edge" },
    { name: "Edge", path: "/usr/bin/microsoft-edge-stable" },
  ]
}

/**
 * 挑一个**真实存在**的浏览器；一个都没有返回 null（调用方降级）。
 *
 * `candidates` 只在测试里注入；生产走 browserCandidates()。
 * @returns {{name:string, path:string} | null}
 */
export function findBrowser({ candidates } = {}) {
  const list = candidates ?? browserCandidates()
  for (const c of list) {
    try {
      if (c?.path && existsSync(c.path)) return c
    } catch {}
  }
  return null
}

/**
 * 等 Chromium 把 DevToolsActivePort 写出来。
 * 文件两行：第一行端口，第二行 ws 路径。`--remote-debugging-port=0` 让系统挑端口，
 * 避免和已有的调试端口撞车。
 *
 * @param {() => boolean} [aborted] 返回 true 就立刻放弃（比如进程已经退出了），
 *        免得为一个死掉的进程白等满 8 秒
 */
async function waitPort(dir, timeoutMs = 20_000, aborted = null) {
  const f = join(dir, "DevToolsActivePort")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const line = readFileSync(f, "utf8").split("\n")[0].trim()
      const port = Number(line)
      if (port > 0) return port
    } catch {}
    // 文件还没出现时先看进程是不是已经死了 —— 死了就没必要再等
    if (aborted?.()) {
      // 再给一次机会：进程退出瞬间可能刚好写完
      try {
        const line = readFileSync(f, "utf8").split("\n")[0].trim()
        const port = Number(line)
        if (port > 0) return port
      } catch {}
      return 0
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return 0
}

/**
 * 拉起浏览器并打开登录页。
 *
 * ⚠ **逐个候选试，不是找到第一个存在的就认定它能用。**
 *
 *   候选表里装了 ≠ 能起 CDP：可能是别的内核、可能被策略禁用调试端口、
 *   可能启动就崩。老实现只挑「第一个 existsSync 为 true 的」，
 *   一旦它起不来就是彻底失败（用户看到的还是「一直等」）。
 *
 *   现在：存在的一个个试，**第一个真写出 DevToolsActivePort 的**才算数。
 *   全都不行才抛错 —— 抛的错里带上每个候选失败的原因，排障不用猜。
 *
 * @param {string} url
 * @param {{candidates?: {name:string,path:string}[]}} [opts] 测试注入用
 * @returns {Promise<{port:number, dir:string, child:import("node:child_process").ChildProcess, name:string, exe:string}>}
 */
/** 一次失败后就别再拉：冷却期内直接走手动登录，免得每次点都弹一堆窗口 */
let cdpDownUntil = 0
const CDP_COOLDOWN_MS = 30 * 60_000

/**
 * 拉起一次登录窗口。
 *
 * ⚠ 2026-10-29 实测（用户机器，Chrome 155 + 已有一个日常 Chrome 在跑）：
 *   按原来那套参数 spawn 出去，浏览器把页面**转交给已运行实例**后自己 exit 0，
 *   既不写 DevToolsActivePort，也不关它开出来的窗口 —— 而原代码会
 *   「把所有候选浏览器都试一遍」，于是点一次「邮箱验证码登录」就弹好几个窗口。
 *
 *   参数集参照 GoogleChrome/chrome-launcher 的 DEFAULT_FLAGS（官方给自动化工具用的那套），
 *   把扩展 / 组件更新 / 同步 / 首次运行向导 / 后台网络全关掉，
 *   再补 `--remote-allow-origins=*`（新版 Chrome 连 CDP 的 WebSocket 要它）。
 */
export async function launchLoginBrowser(url, { candidates } = {}) {
  // 冷却期内不再 spawn —— 本机接管不了就是接管不了，反复试只会反复弹窗
  if (Date.now() < cdpDownUntil) {
    throw new Error("本机浏览器不接受自动接管（刚才失败过，30 分钟内不再尝试），直接用手动登录")
  }
  const list = (candidates ?? browserCandidates()).filter((c) => {
    try {
      return c?.path && existsSync(c.path)
    } catch {
      return false
    }
  })
  if (!list.length) {
    throw new Error("本机没找到 Chrome / Edge / 360 / QQ 等 Chromium 内核浏览器")
  }

  // 先扫掉上一次登录留下的临时 profile（含历史复用目录）—— 只做一次
  sweepProfiles()

  // ⚠ 只试**第一个**能用的浏览器。
  //   每个候选失败都会留下一个收不回来的窗口（浏览器把自己 exit 掉、窗口归已运行实例），
  //   试 N 个就弹 N 个 —— 这正是「一下子弹出很多个浏览器」的来源。
  //   第一个不行就交给调用方走手动登录，别再用窗口堆失败。
  const cand = list[0]
  try {
    return await launchOne(cand, url)
  } catch (e) {
    // 记下这次失败：30 分钟内不再自动拉浏览器（想提前恢复就重启 magpie）
    cdpDownUntil = Date.now() + CDP_COOLDOWN_MS
    throw new Error(
      `没能自己接管浏览器（${cand.name}：${String(e?.message ?? e).slice(0, 200)}）`,
    )
  }
}

/**
 * 用**指定**的一个浏览器起一次登录窗口。
 * 失败时保证：进程已杀、目录已删（不会给后面留垃圾）。
 */
async function launchOne(cand, url) {
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
      cand.path,
      [
        `--user-data-dir=${dir}`,
        "--remote-debugging-port=0",
        // 新版 Chrome 连 CDP 的 WebSocket 要放行来源，否则 /json/* 能取到、WebSocket 连不上
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        // ═══ 以下照抄 GoogleChrome/chrome-launcher 的 DEFAULT_FLAGS（只留跨平台、有意义的）═══
        "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4",
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-client-side-phishing-detection",
        "--disable-sync",
        "--metrics-recording-only",
        "--disable-default-apps",
        "--mute-audio",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-hang-monitor",
        "--disable-prompt-on-repost",
        "--disable-domain-reliability",
        "--password-store=basic",
        url,
      ],
      // 某些国产浏览器不接受部分参数会直接退出，stdio 必须 ignore，
      // 否则它往 stdout 写的吐槽会污染 magpie 的日志
      { stdio: "ignore", detached: false, windowsHide: false },
    )
  } catch (e) {
    await cleanupFailed({ dir, exe: cand.path })
    throw new Error(`进程起不来：${e?.message ?? e}`)
  }

  // 进程若直接退出（参数不认 / 已被别的实例接管），waitPort 会白等 8 秒。
  // 监听 exit 提前退出等待，把真实原因带回去。
  let exited = null
  child?.on?.("exit", (code) => {
    exited = code
  })

  const port = await waitPort(dir, 20_000, () => exited !== null)
  if (!port) {
    await cleanupFailed({ dir, child, exe: cand.path })
    throw new Error(
      exited !== null
        ? `进程启动后退出了（code ${exited}），没写出调试端口`
        : "8 秒内没写出调试端口 DevToolsActivePort",
    )
  }
  return { port, dir, child, name: cand.name, exe: cand.path }
}

/** 失败收尾：杀进程 + 删目录，都不抛错 */
/**
 * Windows：按 `--user-data-dir` 精确杀进程。
 *
 * ⚠ 为什么不能只 kill(child)：实测浏览器会「父进程 exit 0、真正的窗口挂在另一批
 *   子进程上」，child 早就没了，kill 落空 —— 于是每失败一次就多一个关不掉的窗口
 *   （用户看到的就是「一下子弹出很多个浏览器」）。
 *   profile 目录是一次性的、带随机后缀，按它匹配进程命令行既精确又不会误伤日常浏览器。
 */
function killByProfileDir(dir, exePath) {
  if (process.platform !== "win32" || !dir) return 0
  const name = basename(String(exePath || "chrome.exe")).replace(/'/g, "''")
  const pattern = String(dir).replace(/'/g, "''")
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -like '*${pattern}*' }; ` +
          `$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count`,
      ],
      { stdio: "ignore", timeout: 30_000 },
    )
    return 1
  } catch {
    return 0
  }
}

async function cleanupFailed({ dir, child, exe }) {
  // 先按 profile 目录收（这一批才是真正开着窗口的进程），再补一刀 child 树
  killByProfileDir(dir, exe)
  try {
    if (child?.pid && process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      child?.kill()
    }
  } catch {
    try {
      child?.kill()
    } catch {}
  }
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
  } catch {}
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
