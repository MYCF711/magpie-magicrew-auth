// 「弹窗用哪个浏览器」的判据。
//
//   node tests/browser-detect.mjs
//
// 这个文件的由来（2026-10-28，真机取证）：
//
//   用户点了「浏览器登录」，magpie 里一直转圈等，浏览器那边其实已经登好、跳到
//   agent 界面了。查 ~/.cache/magpie/magicrew-login-magicrew.log，每次都写着
//
//       launch: 本机没找到 Chrome / Edge / Bravo / Chromium
//
//   可是这台机器上 **Edge 是装着的**（122.0.2365.106，微软官方包）。
//   根因是 findBrowser() 里写死的文件名是 `msedge.exe`，而微软在 Windows 上
//   实际落盘的是 **`Microsoft Edge.exe`**（带空格、带大写）。existsSync 一路 miss，
//   于是永远走「降级到系统浏览器 + 用户粘 Console」那条路 —— 用户看到的就是
//   「网页登完了、插件还在等」。
//
//   同一台机器上用户天天用的还是 360 极速浏览器 X（360ChromeX，Chrome 132 内核），
//   它不在候选表里。实测它 **完全支持** `--remote-debugging-port=0` + CDP
//   Runtime.evaluate，读 localStorage 没问题，所以没有理由不支持它。
//
// 所以这里的判据是三条：
//   ① Edge 的真实文件名必须在候选表里（并且旧名字 msedge.exe 也留着）
//   ② 国产 Chromium 系（360 / QQ / 搜狗 …）也在候选表里
//   ③ 选中逻辑：跳过不存在的，返回第一个存在的；一个都没有就 null，不是抛错

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

let failed = 0
const ok = (cond, label, extra = "") => {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failed++
}

const { browserCandidates, findBrowser } = await import("../src/browser-login.mjs")

console.log("═══ ① Edge 的真实文件名（本次根因）═══")
{
  const win = browserCandidates("win32", {
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    APPDATA: "C:\\Users\\u\\AppData\\Roaming",
  })
  const paths = win.map((c) => c.path)
  const lower = paths.map((p) => p.toLowerCase())

  ok(
    lower.some((p) => p.endsWith("\\microsoft\\edge\\application\\microsoft edge.exe")),
    "包含微软实际落盘的名字 `Microsoft Edge.exe`",
    paths.find((p) => /edge/i.test(p)) || "(一个 Edge 候选都没有)",
  )
  // 老版本 / 某些安装方式是 msedge.exe —— 留着不亏
  ok(
    lower.some((p) => p.endsWith("\\microsoft\\edge\\application\\msedge.exe")),
    "同时保留旧名字 `msedge.exe`（有些安装是这个名字）",
  )
  // 两个安装根都要覆盖
  ok(lower.some((p) => p.startsWith("c:\\program files (x86)\\")), "覆盖 Program Files (x86)")
  ok(lower.some((p) => p.startsWith("c:\\program files\\")), "覆盖 Program Files")
}

console.log("\n═══ ② 国产 Chromium 系也要能起弹窗 ═══")
{
  const win = browserCandidates("win32", {
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    APPDATA: "C:\\Users\\u\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\u",
  })
  const joined = win.map((c) => c.path).join("\n").toLowerCase()

  // 360 极速浏览器 X（用户这台机器上的日常浏览器，实测 CDP 可用）
  ok(joined.includes("360chromex"), "包含 360 极速浏览器 X（360ChromeX）")
  // 别的常见国产壳，装了就能用，没装就跳过
  ok(joined.includes("360chrome"), "包含 360 安全浏览器（360Chrome）")
  ok(joined.includes("secoresdk") || joined.includes("360se6"), "包含 360se6")
  ok(joined.includes("qqbrowser"), "包含 QQ 浏览器")
  ok(joined.includes("sogou"), "包含搜狗浏览器")

  // 每个候选都要有名字，报错文案要能说清是哪个浏览器
  ok(win.every((c) => typeof c.name === "string" && c.name.trim()), "每个候选都带 name")
}

console.log("\n═══ ②b 优先级：Chromium 在前，Edge 垫底 ═══")
{
  // 用户的明确诉求：本机有 Chromium 就用 Chromium，不要 Edge。
  // 所以候选表里**所有**非 Edge 项都必须排在**任何** Edge 项之前。
  for (const [plat, env] of [
    ["win32", { LOCALAPPDATA: "C:\\L", PROGRAMFILES: "C:\\PF", "PROGRAMFILES(X86)": "C:\\PF86", APPDATA: "C:\\R", USERPROFILE: "C:\\U" }],
    ["darwin", { HOME: "/u" }],
    ["linux", { HOME: "/u" }],
  ]) {
    const list = browserCandidates(plat, env)
    const firstEdge = list.findIndex((c) => c.name === "Edge")
    const lastNonEdge = list.map((c) => c.name).lastIndexOf(list.filter((c) => c.name !== "Edge").at(-1))
    ok(firstEdge === -1 || firstEdge > lastNonEdge, `${plat}：Edge 排在所有非 Edge 之后`, `firstEdge=${firstEdge} lastNonEdge=${lastNonEdge}`)
  }

  // Chromium 必须真的排在最前面几个 —— 不是「非 Edge」就算数
  const win = browserCandidates("win32", {
    LOCALAPPDATA: "C:\\L", PROGRAMFILES: "C:\\PF", "PROGRAMFILES(X86)": "C:\\PF86",
    APPDATA: "C:\\R", USERPROFILE: "C:\\U",
  })
  const names = win.map((c) => c.name)
  const firstChromium = names.indexOf("Chromium")
  const firstChrome = names.indexOf("Chrome")
  ok(firstChromium !== -1, "Windows 候选里有 Chromium")
  ok(firstChromium < names.indexOf("Brave"), "Chromium 排在 Brave 之前", `chromium@${firstChromium}`)
  ok(firstChromium < names.indexOf("360极速浏览器X"), "Chromium 排在国产浏览器之前", `chromium@${firstChromium}`)
  ok(Math.min(firstChrome, firstChromium) <= 1, "Chrome/Chromium 是第一批候选", `chrome@${firstChrome} chromium@${firstChromium}`)

  // scoop 安装的 Chromium（本机就是这条路径）
  ok(
    win.some((c) => c.path.toLowerCase().includes("scoop\\apps\\chromium")),
    "认得 scoop 装的 Chromium",
  )
}

console.log("\n═══ ③ 平台差异 ═══")
{
  const mac = browserCandidates("darwin", { HOME: "/Users/u" })
  ok(mac.length > 0, "macOS 有候选")
  ok(mac.some((c) => c.path.includes("Google Chrome.app")), "macOS 认 Chrome.app")

  const linux = browserCandidates("linux", { HOME: "/home/u" })
  ok(linux.length > 0, "Linux 有候选")
  ok(linux.some((c) => c.path === "/usr/bin/google-chrome"), "Linux 认 /usr/bin/google-chrome")
}

console.log("\n═══ ④ 选中逻辑：跳过不存在，取第一个存在的 ═══")
{
  const tmp = mkdtempSync(join(tmpdir(), "magicrew-detect-"))
  const a = join(tmp, "a", "browser-a.exe")
  const b = join(tmp, "b", "browser-b.exe")
  mkdirSync(dirname(a), { recursive: true })
  mkdirSync(dirname(b), { recursive: true })
  writeFileSync(a, "x")

  const cands = [
    { name: "Missing", path: join(tmp, "nope", "x.exe") },
    { name: "A", path: a },
    { name: "B", path: b },
  ]
  const picked = findBrowser({ candidates: cands })
  ok(picked?.name === "A", "跳过不存在的，返回第一个存在的", JSON.stringify(picked))
  ok(picked?.path === a, "返回的是它的完整路径")

  // b 也建出来之后，仍应取 A（顺序优先，不随机）
  writeFileSync(b, "x")
  ok(findBrowser({ candidates: cands })?.name === "A", "两个都存在时取靠前的那个（顺序稳定）")

  const none = findBrowser({ candidates: [{ name: "X", path: join(tmp, "no", "x.exe") }] })
  ok(none === null, "一个都不存在 → null（不是抛错，调用方据此降级）")

  rmSync(tmp, { recursive: true, force: true })
}

console.log("\n═══ ⑤ 真实机器上不会误报「没找到」═══")
{
  // 这条跑的是**本机真实**候选表。装了什么就认什么，一个都没有才允许为 null。
  // 关键是：不允许因为「文件名写错」而把装着的浏览器当成没装。
  const c = findBrowser()
  if (process.platform === "win32") {
    // 微软真实落盘的名字带空格 —— 这正是本次 bug 的来源
    const edgeExe = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\Microsoft Edge.exe"
    if (existsSync(edgeExe)) {
      ok(c !== null, "本机装了 Edge（Microsoft Edge.exe）→ findBrowser 不能返回 null", String(c))
      if (c) {
        ok(
          /edge|chrome|brave|chromium|360|qq|sogou/i.test(c.name + " " + c.path),
          "返回的确实是浏览器",
          c.name + " / " + c.path,
        )
      }
    } else {
      console.log("  · 本机没有 Edge，跳过（不构成失败）")
    }
  } else {
    console.log(`  · 非 win32（${process.platform}），只看不判`)
  }
}

console.log(failed ? `\n✗ ${failed} 项失败` : "\n✓ 全部通过")
if (failed) process.exitCode = 1
