// 浏览器登录那条路的验证：authorize 立刻返回 + callback 从剪贴板接住凭证。
// 外加「四条登录方法的顺序」—— 国际站邮箱优先那条规矩也钉在这里。
//
//   node tests/browser-login.mjs
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
    // ⚠ 超时不是锦上添花：这个环境里 `Set-Clipboard` 有时**既不返回也不报错**
    //   （被沙箱拦住，实测把整份测试挂在 ② 段十来分钟）。没超时的话，
    //   「跑一遍全部测试」这条判据会因为一个与登录逻辑无关的降级通道挂死。
    timeout: 15_000,
    killSignal: "SIGKILL",
  })
}

const jwt = process.env.MAGICREW_INTL_JWT || ""
const org = process.env.MAGICREW_INTL_ORG || ""

const ctx = await MagicrewIntlAuthPlugin({ client: null, directory: "." })
const methods = ctx.auth.methods

// 「浏览器登录」是唯一不带 prompts 的（点了直接开窗口/开页面）
const browserMethod = methods.find((m) => /浏览器登录/.test(m.label))

console.log("═══ ① authorize 立刻返回、无输入 ═══")
console.log("  label    :", browserMethod?.label)
console.log("  prompts  :", browserMethod?.prompts ? `${browserMethod.prompts.length} 个` : "无（点了直接开页面）")
if (!browserMethod) {
  console.log("  ✗ 找不到不带输入的方法（浏览器登录）")
  process.exit(1)
}

// ⚠ 这条 `authorize()` 会真的去拉浏览器；本机没浏览器时它降级到「系统浏览器 + 粘 Console」，
//   两条路都算过。所以阈值不能按「几十毫秒」卡 —— 它允许花几百毫秒去起一个进程，
//   但**不许**卡在等用户（那才是 authorize 的语义红线）。等用户的事都在 callback 里。
const t0 = Date.now()
const started = await browserMethod.authorize()
const dt = Date.now() - t0
console.log("  url      :", started.url)
console.log("  opened   :", started.opened, "| method:", started.method)
console.log("  authorize 耗时:", dt, "ms  →", dt < 5000 ? "✓ 没阻塞（等用户的事不在这一步）" : "⚠ 可能偏慢")
if (dt >= 5000) process.exitCode = 1

console.log("\n═══ ② callback 从剪贴板认凭证 ═══")
try {
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
} catch (e) {
  // 有些环境里 Set-Clipboard 起不来（被沙箱杀掉，退出码 143）。这一段验的是
  // 「剪贴板这条降级通道」，与登录逻辑无关，起不来就跳过，别让整份测试崩。
  console.log("  ⊘ 跳过：剪贴板/命令执行不可用 ——", String(e?.message ?? e).split("\n")[0].slice(0, 120))
}

console.log("\n═══ ③ 五条方法的顺序 ═══")
for (const [i, x] of methods.entries()) {
  console.log(`  ${i + 1}. ${x.label}${x.prompts ? `（${x.prompts.length} 输入）` : "（无输入）"}`)
}

const labels = methods.map((x) => x.label)
const fail = (msg) => {
  console.log("  ✗ " + msg)
  process.exitCode = 1
}

if (methods.length !== 5) fail(`应该有 5 条登录方法，实际 ${methods.length} 条`)
// 站点 id → 谁排前面。国际站用户大多是邮箱注册的，所以邮箱在前。
if (!/邮箱验证码/.test(labels[0] ?? "")) fail(`国际站第一条应该是「邮箱验证码」，实际是 ${labels[0]}`)
if (!/手机号验证码/.test(labels[1] ?? "")) fail(`国际站第二条应该是「手机号验证码」，实际是 ${labels[1]}`)
if (!/浏览器登录/.test(labels[2] ?? "")) fail(`第三条应该是「浏览器登录」，实际是 ${labels[2]}`)
if (!/登录态/.test(labels[3] ?? "")) fail(`第四条应该是「登录态（JWT + 组织码）」，实际是 ${labels[3]}`)
if (!/邀请码/.test(labels[4] ?? "")) fail(`第五条应该是「邀请码」，实际是 ${labels[4]}`)
if (labels[0] === labels[1]) fail("前两条方法的标题不能一样（magpie 列表里会分不出来）")

if (!process.exitCode) console.log("  ✓ 顺序正确：邮箱 → 手机号 → 浏览器 → 登录态 → 邀请码")

// ⚠ 这一份**会真的拉起浏览器**（见 ①），留着的句柄让 node 的事件循环不空 ——
// 光设 process.exitCode 不会结束进程。实测：结论早就打完，进程还挂着，
// 3 分半都退不出来，在「跑一遍全部测试」这条判据上表现为卡死。
// 打完结论就显式退出。
process.exit(process.exitCode ?? 0)
