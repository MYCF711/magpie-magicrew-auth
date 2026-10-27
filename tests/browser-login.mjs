// 浏览器登录那条路的验证：authorize 立刻返回 + callback 从剪贴板接住凭证。
//
//   bun tests/browser-login.mjs
//
// 不碰网络也能验：把一份**假凭证**放进剪贴板，看 callback 能不能认出来、
// 以及认出来之后是「验不过」而不是「读不到」。
//
// 想验真链路就把 MAGICREW_INTL_JWT / MAGICREW_INTL_ORG 设上，脚本会放真值。

import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { MagicrewIntlAuthPlugin } from "../index.mjs"

const execFile = promisify(execFileCb)

function setClipboard(text) {
  return execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$input | Set-Clipboard -Value $_"], {
    input: text,
    windowsHide: true,
  })
}

const jwt = process.env.MAGICREW_INTL_JWT || ""
const org = process.env.MAGICREW_INTL_ORG || ""

console.log("═══ ① authorize 立刻返回、无输入 ═══")
const ctx = await MagicrewIntlAuthPlugin({ client: null, directory: "." })
const m = ctx.auth.methods[0]
console.log("  label    :", m.label)
console.log("  prompts  :", m.prompts ? `${m.prompts.length} 个` : "无（点了直接开页面）")

const t0 = Date.now()
const started = await m.authorize()
const dt = Date.now() - t0
console.log("  url      :", started.url)
console.log("  opened   :", started.opened, "| method:", started.method)
console.log("  authorize 耗时:", dt, "ms  →", dt < 50 ? "✓ 没阻塞" : "⚠ 可能偏慢")
if (dt >= 50) process.exitCode = 1

console.log("\n═══ ② callback 从剪贴板认凭证 ═══")
if (!jwt || !org) {
  // 假凭证：认得出形状，但换不出 key —— 应该报「验证不过」，不是「读不到」
  await setClipboard(JSON.stringify({ jwt: "eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoxfQ.deadbeef", org: "fakeorg12345" }))
  console.log("  （没给真凭据，放了一份假的下剪贴板）")
} else {
  await setClipboard(JSON.stringify({ jwt, org }))
  console.log("  （放了真凭据进剪贴板）")
}

const r = await Promise.race([started.callback(), new Promise((r) => setTimeout(() => r(null), 30_000))])
if (!r) {
  console.log("  ✗ 30 秒没返回 —— 剪贴板没读到？")
  process.exitCode = 1
} else if (r.type === "success") {
  console.log("  ✓ 登录成功  accountId:", r.accountId, "| org:", r.org)
} else {
  console.log("  error:", r.error)
  const readIt = !/没在剪贴板里读到/.test(String(r.error))
  console.log(readIt ? "  ✓ 读到了（只是这份凭据本身无效，符合预期）" : "  ✗ 压根没读到剪贴板")
  if (!readIt) process.exitCode = 1
}

console.log("\n═══ ③ 三个方法的顺序 ═══")
for (const [i, x] of ctx.auth.methods.entries()) {
  console.log(`  ${i + 1}. ${x.label}${x.prompts ? `（${x.prompts.length} 输入）` : "（无输入）"}`)
}
const first = ctx.auth.methods[0]
if (first.prompts?.length) {
  console.log("  ✗ 第一个方法不该带输入")
  process.exitCode = 1
}
