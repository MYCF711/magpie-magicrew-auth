// 自动维护 —— 「默认开启签到」与「插件自身自动更新」
//
// 这两个能力本质上都踩在 magpie 的边界上，先把边界说清楚：
//
// ① 签到：magpie 的 `pluginCheckins`（设置 → 插件签到）**默认是关的**
//    （`PluginCheckinOn()`：没有显式值时跟随厂商内置开关，magicrew 没有内置
//    开关，于是 false）。插件没有官方 API 能声明的默认值，只能在插件加载时
//    读 `~/.config/magpie/settings.json`：**只有这个 provider 从未被用户设置过**
//    才补一个 true。用户显式关掉的，绝不覆盖。
//
// ② 自动更新：magpie 只对 `@magpie-community/*` 的包自动更新
//    （`plugin.Official()` 硬编码这个前缀），git 源的第三方插件永远只提示、
//    等用户点「更新」。我们不在那个 scope 里，所以只能由插件自己复刻这套
//    机制：读 magpie 写好的 `plugin-updates.json`，确认「有我自己」之后调用
//    magpie 的 CLI（`magpie plugin update`）——它会把插件目录更新到最新；
//    成功后在 `plugin-updates.json` 的 `updated[]` 里补一条，magpie 的
//    「已自动更新」徽章读的就是这个记录（`plugin.LastUpdated()`）。
//
// ⚠ 边界（都是实测/源码结论，别想当然）：
//   · 插件进程拿不到 GUI 的 HTTP 端口 —— `MAGPIE_ADDR` 指向 3425，那是
//     **gateway**（`/api/plugins/updates` 在那里会回 `/v1` 的 404 文案），
//     GUI API 走的是桌面窗口自己的 WebView，不是 TCP 端口。
//   · `magpie plugin update` 是 CLI 进程内的 `plugin.Update()`，会更新
//     **所有** 非路径插件并重装；它不会重启正在运行的 magpie，所以更新后
//     要等 magpie 下次启动才加载新代码。这是这个兜底能做到的极限。
//   · 找不到 magpie 可执行文件时只记录 `no-magpie-exe`，不伪造徽章、不硬编码
//     本机路径。可以设环境变量 `MAGPIE_EXE` 明示。
//
// 两个动作都是**尽力而为**：失败不抛、不拖慢签到/额度/登录。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, basename } from "node:path"
import { execFileSync, spawn } from "node:child_process"

const PKG_NAME = "Magicrew"
const AUTO_DIR = () => join(homedir(), ".config", "magpie")
const CACHE_DIR = () => join(homedir(), ".cache", "magpie")
const THROTTLE_MS = 6 * 3600_000 // 同一次更新失败后，6 小时内不再试

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

/** 原子写：先写同目录临时文件再 rename，避免把 magpie 的 JSON 写半截 */
function writeJsonAtomic(path, value, { backup = false } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  if (backup && existsSync(path)) {
    try {
      writeFileSync(path + ".bak-magicrew-auto", readFileSync(path))
    } catch {}
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  renameSync(tmp, path)
}

/** 这个 provider 的签到是否从未被用户设置过；是就补 true（并返回 changed） */
export function ensureCheckinDefault(provider, { dir = AUTO_DIR() } = {}) {
  const file = join(dir, "settings.json")
  let s
  if (existsSync(file)) {
    s = readJson(file, null)
    // 文件在但读不出来：绝不覆盖用户的设置
    if (!s || typeof s !== "object" || Array.isArray(s)) return { changed: false, reason: "settings-unreadable" }
  } else {
    s = {}
  }
  const table = s.pluginCheckins && typeof s.pluginCheckins === "object" && !Array.isArray(s.pluginCheckins)
    ? s.pluginCheckins
    : {}
  if (Object.hasOwn(table, provider)) return { changed: false, reason: "explicit", on: table[provider] === true }
  s.pluginCheckins = { ...table, [provider]: true }
  writeJsonAtomic(file, s, { backup: true })
  return { changed: true, on: true }
}

/** magpie 的 waiting 里有没有「我自己」的新版本（git 源只有 commit，没有 npm version） */
export function pickSelfUpdate(waiting, { pkg = PKG_NAME } = {}) {
  if (!Array.isArray(waiting)) return null
  return waiting.find((w) => w && w.package === pkg && w.git === true) || null
}

/** 补一条「自动更新记录」—— magpie 的「已自动更新」徽章读 plugin-updates.json 的 updated[] */
export function noteUpdated(pkg, from, to, { dir = AUTO_DIR(), now = new Date() } = {}) {
  const file = join(dir, "plugin-updates.json")
  const u = readJson(file, null)
  if (!u || typeof u !== "object" || Array.isArray(u)) return false
  u.updated = Array.isArray(u.updated) ? u.updated : []
  const last = u.updated[u.updated.length - 1]
  // 同一次更新重复写会让徽章的计时一直刷新；24 小时内同 from/to 只记一次
  if (last && last.package === pkg && last.from === from && last.to === to) {
    const at = Date.parse(last.at)
    if (Number.isFinite(at) && now.getTime() - at < 24 * 3600_000) return true
  }
  u.updated.push({ package: pkg, from, to, at: now.toISOString() })
  if (u.updated.length > 20) u.updated = u.updated.slice(-20)
  writeJsonAtomic(file, u, { backup: true })
  return true
}

/** 自动更新的节流状态（每个站点一份） */
export function readAutoState(site, { cacheDir = CACHE_DIR() } = {}) {
  return readJson(join(cacheDir, `magicrew-auto-${site}.json`), {}) || {}
}

function writeAutoState(site, state, { cacheDir = CACHE_DIR() } = {}) {
  try {
    writeJsonAtomic(join(cacheDir, `magicrew-auto-${site}.json`), state)
  } catch {}
}

/**
 * 找本机 magpie 可执行文件。顺序：
 *   1. 环境变量 MAGPIE_EXE（最可靠，给测试和自定义安装用）
 *   2. 祖父进程：插件跑在 magpie-bun.exe 里，它的父进程就是 magpie 主程序
 *   3. PATH 里的 magpie / magpie.exe / magpie-windows-amd64.exe
 * 找不到返回 ""
 */
export function findMagpieExe({ env = process.env, ppid = process.ppid, platform = process.platform } = {}) {
  const resolve = (p) => {
    if (!p || !existsSync(p)) return ""
    // magpie 的 `magpie.cmd` 只是同目录 exe 的包装（Settings 的 Command line
    // 会生成它）；spawn 一个 .cmd 在 Windows 上还要 shell，直接解析到 exe。
    if (/\.(cmd|bat)$/i.test(p)) {
      for (const n of ["magpie-windows-amd64.exe", "magpie.exe"]) {
        const q = join(dirname(p), n)
        if (existsSync(q)) return q
      }
    }
    return p
  }
  if (env.MAGPIE_EXE) {
    const p = resolve(env.MAGPIE_EXE)
    if (p) return p
  }
  const exists = (p) => !!resolve(p)
  const tryExec = (cmd, args, timeout = 2500) => {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      return ""
    }
  }
  if (platform === "win32") {
    const ps = [
      "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=" + Number(ppid) + "\"",
      "if ($p) { $q = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\"; if ($q) { $q.ExecutablePath } }",
    ].join("; ")
    const out = tryExec("powershell.exe", ["-NoProfile", "-Command", ps])
    // 只认名字里带 magpie 的进程 —— 测试/宿主不在 magpie 下时，
    // 父进程可能是 bash / node，不能把它们的路径当 magpie
    if (exists(out) && /magpie/i.test(basename(out))) return resolve(out)
  } else {
    const out = tryExec("ps", ["-p", String(ppid), "-o", "ppid="])
    const grand = out.split(/\s+/)[0]
    if (grand) {
      const path = tryExec("ps", ["-p", grand, "-o", "comm="])
      if (exists(path) && /magpie/i.test(basename(path))) return resolve(path)
    }
  }
  for (const name of ["magpie-windows-amd64.exe", "magpie.exe", "magpie"]) {
    const lines = tryExec(platform === "win32" ? "where.exe" : "which", [name], 1500).split(/\r?\n/)
    for (const line of lines) {
      const p = line.trim()
      if (exists(p) && /magpie/i.test(basename(p))) return resolve(p)
    }
  }
  return ""
}

/**
 * 检查并（尽力）自动更新。
 * @param {{id:string}} c 站点上下文（用 c.id 存节流状态）
 * @param {{dir?:string, cacheDir?:string, pkg?:string, exe?:string, dryRun?:boolean, spawnFn?:Function}} opts
 * @returns {Promise<object>} 结果只用于日志/测试，不抛
 */
export async function kick(c, opts = {}) {
  const dir = opts.dir || AUTO_DIR()
  const cacheDir = opts.cacheDir || CACHE_DIR()
  const pkg = opts.pkg || PKG_NAME
  try {
    const updates = readJson(join(dir, "plugin-updates.json"), null)
    const waiting = pickSelfUpdate(updates?.waiting, { pkg })
    if (!waiting) return { skipped: "no-update" }

    const state = readAutoState(c.id, { cacheDir })
    const now = Date.now()
    if (state.done && state.done.to === waiting.latest) return { skipped: "done" }
    if (state.lastAttempt && state.latest === waiting.latest && now - state.lastAttempt < THROTTLE_MS) {
      return { skipped: "throttled" }
    }

    const exe = opts.exe !== undefined ? opts.exe : findMagpieExe(opts)
    if (!exe) {
      writeAutoState(c.id, { ...state, lastAttempt: now, latest: waiting.latest, reason: "no-magpie-exe" }, { cacheDir })
      return { skipped: "no-magpie-exe", waiting }
    }
    if (opts.dryRun) return { wouldRun: exe, waiting }

    let child
    try {
      child = (opts.spawnFn || spawn)(exe, ["plugin", "update"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      })
    } catch (e) {
      writeAutoState(c.id, { ...state, lastAttempt: now, latest: waiting.latest, reason: String(e?.message ?? e) }, { cacheDir })
      return { skipped: "spawn-failed", error: String(e?.message ?? e) }
    }
    child.on?.("exit", (code) => {
      if (code === 0) {
        noteUpdated(pkg, waiting.version, waiting.latest, { dir })
        writeAutoState(c.id, {
          ...state,
          lastAttempt: now,
          latest: waiting.latest,
          done: { from: waiting.version, to: waiting.latest, at: new Date().toISOString() },
        }, { cacheDir })
      } else {
        writeAutoState(c.id, { ...state, lastAttempt: now, latest: waiting.latest, reason: `exit-${code}` }, { cacheDir })
      }
    })
    child.unref?.()
    return { started: true, waiting }
  } catch (e) {
    return { skipped: "error", error: String(e?.message ?? e) }
  }
}

/** 插件加载时的初始化：补默认签到 + 延迟检查更新（不阻塞 config） */
export function initAutoMaintenance(c) {
  try {
    ensureCheckinDefault(c.PROVIDER)
  } catch {}
  try {
    const t = setTimeout(() => {
      kick(c).catch(() => {})
    }, 15_000)
    t.unref?.()
  } catch {}
}
