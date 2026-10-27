// 登录 profile 的作用域：每次一个新目录、旧目录会被扫掉；
// 以及「读到上一个账号的凭据不算登录成功」这道判据。
//
//   node tests/login-profile.mjs
//
// 全程在临时 HOME 里跑，不碰真实的 ~/.cache/magpie。

import { mkdtempSync, mkdirSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fake = mkdtempSync(join(tmpdir(), "magicrew-profile-test-"))
process.env.USERPROFILE = fake
process.env.HOME = fake

let failed = 0
const ok = (cond, label, extra = "") => {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failed++
}

const { newProfileDir, sweepProfiles, waitForCreds } = await import("../src/browser-login.mjs")
const magpie = join(fake, ".cache", "magpie")

console.log("═══ ① 每次登录一个一次性目录 ═══")
const a = newProfileDir()
const b = newProfileDir()
ok(a !== b, "两次调用拿到不同目录")
ok(existsSync(a) && existsSync(b), "目录已创建")
ok(a.toLowerCase().startsWith(magpie.toLowerCase()), "落在 <home>/.cache/magpie 下", a)
ok(!a.includes("magicrew-login-profile"), "不再用历史上那个复用目录")

console.log("\n═══ ② 历史复用目录必删；一次性目录按年龄删 ═══")
const legacy = join(magpie, "magicrew-login-profile")
mkdirSync(legacy, { recursive: true })
sweepProfiles()
ok(!existsSync(legacy), "sweep 删掉了历史复用目录（这次 bug 的来源）")

const fresh = newProfileDir()
sweepProfiles()
ok(existsSync(fresh), "新鲜的一次性目录不删（可能正有别的账号在登）")

const oldTs = new Date(Date.now() - 3 * 3600_000)
utimesSync(fresh, oldTs, oldTs)
sweepProfiles()
ok(!existsSync(fresh), "超过 2 小时的一次性目录被清掉")

const unrelated = join(magpie, "someone-elses-dir")
mkdirSync(unrelated, { recursive: true })
sweepProfiles()
ok(existsSync(unrelated), "不碰不是自己命名的目录")

const logFile = join(magpie, "magicrew-login-magicrew.log")
writeFileSync(logFile, "not a profile\n")
sweepProfiles()
ok(existsSync(logFile), "同前缀的日志文件不当 profile 删")

console.log("\n═══ ③ baseline：窗口打开时就有的凭据不算登录成功 ═══")
const baseline = { jwt: "eyJoldbaseline", org: "orgold" }
const next = { jwt: "eyJnewaccount", org: "orgnew", name: "138****8000" }

let calls = 0
const probe = async () => (calls++ === 0 ? JSON.stringify(baseline) : JSON.stringify(next))
calls = 0
const r1 = await waitForCreds({ port: 1 }, "example.test", { baseline, probe, timeout: 3000, interval: 5 })
ok(r1?.jwt === next.jwt, "先读到旧凭据 → 继续等，直到新凭据出现")

const r2 = await waitForCreds({ port: 1 }, "example.test", {
  baseline: null,
  probe: async () => JSON.stringify(baseline),
  timeout: 300,
  interval: 5,
})
ok(r2?.jwt === baseline.jwt, "没有 baseline 时，第一份凭据就算数（一次性 profile 的正常路径）")

const r3 = await waitForCreds({ port: 1 }, "example.test", {
  baseline,
  probe: async () => JSON.stringify(baseline),
  timeout: 300,
  interval: 5,
})
ok(r3 === null, "只有旧凭据、始终没新登录 → 超时返回 null，不会被当成登录成功")

console.log("\n═══ ④ 清理 ═══")
rmSync(fake, { recursive: true, force: true })
console.log(failed ? `\n✗ ${failed} 项失败` : "\n✓ 全部通过")
if (failed) process.exitCode = 1
