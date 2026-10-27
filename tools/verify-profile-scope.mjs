// 真机验证：登录窗口打开的那一刻，localStorage 里到底有没有「上一个账号」的凭据。
//
//   node tools/_verify_profile_scope.mjs
//
// 会弹一个浏览器窗口，约 6 秒后自己关掉。不登录、不碰任何账号数据。

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { launchLoginBrowser, closeSession, _internal } from "../src/browser-login.mjs"

const base = join(homedir(), ".cache", "magpie")
const legacy = join(base, "magicrew-login-profile")
const url = "https://www.letsmagic.cn/login"
const host = new URL(url).hostname

console.log("① 启动前")
console.log("   历史复用目录存在:", existsSync(legacy), legacy)

const s = await launchLoginBrowser(url)
console.log("   新 profile:", s.dir)
console.log("   历史复用目录已被 sweep:", !existsSync(legacy))

console.log("\n② 等页面加载 4 秒，再读 localStorage")
await new Promise((r) => setTimeout(r, 4000))
let raw = ""
try {
  raw = await _internal.evaluate(s.port, host, _internal.READ_CREDS)
} catch (e) {
  raw = `ERR ${e?.message ?? e}`
}
console.log("   READ_CREDS →", JSON.stringify(raw))
console.log(raw === "" ? "   ✓ 空 —— 窗口打开时没有任何旧凭据，不会秒关" : "   ✗ 读到了凭据，第二次登录还会串号")

console.log("\n③ 关窗")
await closeSession(s)
await new Promise((r) => setTimeout(r, 1000))
console.log("   一次性目录已删:", !existsSync(s.dir))
console.log("   目录仍在:", existsSync(s.dir))
