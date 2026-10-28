// 邀请上级策略 —— 纯离线测试
//
//   node tests/invite-policy.mjs
//
// 钉住 PR #13 的存储层与两个入口：
//   · 策略三态 auto / fixed / custom；锁定开关关掉时一律回落到滚动
//   · 「我的（作者 MYCF711）」是第一项、也是默认可见项
//   · 账号名来自 plugin-auth.json，邀请码来自 magicrew-invite-codes-<site>.json
//   · 自定义码：trim + 大写 + IV 开头 12 位校验；空值不覆盖
//   · 两个设置入口都返回 { type: "failed" }（不建号、不登录）
//
// 隔离 HOME，不碰真实策略/账号文件，不联网。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-invite-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
const CACHE = join(FAKE, ".cache", "magpie")
const CONFIG = join(FAKE, ".config", "magpie")
mkdirSync(CACHE, { recursive: true })
mkdirSync(CONFIG, { recursive: true })

const {
  AUTHOR_INVITE,
  authorInvite,
  readInvitePolicy,
  writeInvitePolicy,
  clearInvitePolicy,
  inviteToUse,
} = await import("../src/store.mjs")
const { makeMethods } = await import("../src/hooks/methods.mjs")
const { _internal } = await import("../index.mjs")
const { siteCtx, SITES } = await import("../src/context.mjs")

const c = siteCtx(SITES.cn)
const SITE = c.id
const AUTHOR = AUTHOR_INVITE[SITE]
const ACCOUNT_CODE = "IVACCOUNT001"
const ROLLING = "IVROLLING001"

/** 一个已登录账号的邀请码记录（rollInvite 平时写的） */
function seedCodes() {
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({
      orgA: { code: ACCOUNT_CODE, accountId: "138****0000", at: "2026-10-29T00:00:00Z" },
      orgB: { code: AUTHOR, accountId: "author-duplicate", at: "2026-10-29T00:00:00Z" },
    }),
  )
}
/** 滚动文件（老行为） */
function seedRolling() {
  writeFileSync(join(CACHE, `magicrew-invite-${SITE}.json`), JSON.stringify({ code: ROLLING, at: "x" }))
}
/** magpie 的账号文件（只读它拿账号名） */
function seedAuth() {
  writeFileSync(
    join(CONFIG, "plugin-auth.json"),
    JSON.stringify({
      [`${SITE}#abc123`]: { org: "orgA", accountId: "138****0000", type: "oauth" },
      "magicrew-intl#xyz": { org: "orgB", accountId: "should-not-match@example.com", type: "oauth" },
    }),
  )
}

seedCodes()
seedRolling()
seedAuth()

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message.split("\n")[0]}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message.split("\n")[0]}`)
  }
}

// ═══ ① 存储层 ════════════════════════════════════════════════════════
console.log("邀请策略存储 —— auto / fixed / custom 与锁定")

check("默认是 auto", () => {
  clearInvitePolicy(SITE)
  assert.deepEqual(readInvitePolicy(SITE), { mode: "auto", code: "", org: "", accountId: "", at: "" })
})

check("fixed：锁定打开用策略码，锁关闭回落到滚动文件", () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" })
  assert.equal(inviteToUse(SITE, true), ACCOUNT_CODE)
  assert.equal(inviteToUse(SITE, false), ROLLING)
})

check("custom：锁定打开用自定义码，锁关闭回落到滚动文件", () => {
  writeInvitePolicy(SITE, { mode: "custom", code: "IVCUSTOM0001" })
  assert.equal(inviteToUse(SITE, true), "IVCUSTOM0001")
  assert.equal(inviteToUse(SITE, false), ROLLING)
})

check("auto：无论锁定与否都用滚动文件", () => {
  writeInvitePolicy(SITE, { mode: "auto" })
  assert.equal(inviteToUse(SITE, true), ROLLING)
  assert.equal(inviteToUse(SITE, false), ROLLING)
})

check("没有滚动文件时回落到作者码", () => {
  rmSync(join(CACHE, `magicrew-invite-${SITE}.json`), { force: true })
  assert.equal(inviteToUse(SITE, true), AUTHOR)
})

check("authorInvite 就是作者码", () => {
  assert.equal(authorInvite(SITE), AUTHOR)
})

// ═══ ② 列表 ══════════════════════════════════════════════════════════
console.log("\n邀请列表 —— 我的（作者）在第一位，账号名 + 码")

function inviteMethod(getLock = () => true) {
  return makeMethods(c, getLock).find((m) => m.type === "api" && String(m.label).includes("邀请上级：") === false)
}
function customMethod(getLock = () => true) {
  return makeMethods(c, getLock).find((m) => m.type === "api" && String(m.label).includes("自定义码"))
}

check("第一个选项是「我的（作者 MYCF711）：<作者码>」", () => {
  const m = inviteMethod()
  const opts = m.prompts[0].options
  assert.equal(opts[0].value, "__author__")
  assert.match(opts[0].label, /MYCF711/)
  assert.match(opts[0].label, new RegExp(AUTHOR))
  assert.equal(opts[1].value, "__auto__")
})

check("账号项带账号名与码；作者码重复出现时只保留「我的」那一项", () => {
  const opts = inviteMethod().prompts[0].options
  const acct = opts.find((o) => o.value === ACCOUNT_CODE)
  assert.ok(acct)
  assert.match(acct.label, /138\*\*\*\*0000/)
  assert.equal(opts.filter((o) => String(o.label).includes(AUTHOR)).length, 1)
})

check("锁定关掉时标题不带当前上级", () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" })
  assert.match(inviteMethod(() => true).label, /上级/)
  assert.doesNotMatch(inviteMethod(() => false).label, /（上级/)
})

check("自定义码校验：IV + 12 位；空值放行", () => {
  const v = customMethod().prompts[0].validate
  assert.equal(v("ivabc1234567"), undefined)
  assert.equal(v(""), undefined)
  assert.ok(v("nope"))
  assert.ok(v("IV123"))
})

// ═══ ③ 两个设置入口 ══════════════════════════════════════════════════
console.log("\n两个设置入口 —— 只落盘，不建号")

await checkAsync("选「我的（作者）」→ fixed + 作者码 + MYCF711", async () => {
  const r = await inviteMethod().authorize({ invite: "__author__" })
  assert.equal(r.type, "failed")
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.mode, "fixed")
  assert.equal(pol.code, AUTHOR)
  assert.equal(pol.accountId, "MYCF711")
})

await checkAsync("选账号 → fixed + 该账号 org/名字", async () => {
  const r = await inviteMethod().authorize({ invite: ACCOUNT_CODE })
  assert.equal(r.type, "failed")
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.mode, "fixed")
  assert.equal(pol.code, ACCOUNT_CODE)
  assert.equal(pol.org, "orgA")
  assert.equal(pol.accountId, "138****0000")
})

await checkAsync("选自动 → auto", async () => {
  await inviteMethod().authorize({ invite: "__auto__" })
  assert.equal(readInvitePolicy(SITE).mode, "auto")
})

await checkAsync("自定义码 → custom + 大写", async () => {
  const r = await customMethod().authorize({ inviteCode: "ivabc1234567" })
  assert.equal(r.type, "failed")
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.mode, "custom")
  assert.equal(pol.code, "IVABC1234567")
})

await checkAsync("自定义留空 → 不改动", async () => {
  writeInvitePolicy(SITE, { mode: "custom", code: "IVKEEP000001" })
  await customMethod().authorize({ inviteCode: "" })
  assert.equal(readInvitePolicy(SITE).code, "IVKEEP000001")
})

await checkAsync("已保存的提示里带当前上级", async () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: AUTHOR, org: "author", accountId: "MYCF711" })
  const r = await inviteMethod().authorize({ invite: "__author__" })
  assert.match(r.error, /MYCF711/)
  assert.match(r.error, /已保存/)
})

await checkAsync("buildPlugin 暴露 inviteLock 开关；getLock 读默认 true / 用户 false", async () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: AUTHOR, org: "author", accountId: "MYCF711" })
  const on = await _internal.buildPlugin(c)({ magpie: { options: () => ({ inviteLock: true }) } })
  const off = await _internal.buildPlugin(c)({ magpie: { options: () => ({ inviteLock: false }) } })
  assert.equal(on.auth.options[0].key, "inviteLock")
  assert.equal(on.auth.options[0].default, true)
  const inviteOn = on.auth.methods.find((m) => m.type === "api" && String(m.label).includes("邀请上级") && !String(m.label).includes("自定义"))
  const inviteOff = off.auth.methods.find((m) => m.type === "api" && String(m.label).includes("邀请上级") && !String(m.label).includes("自定义"))
  assert.match(inviteOn.label, /（上级/)
  assert.doesNotMatch(inviteOff.label, /（上级/)
})

// ── 收尾 ───────────────────────────────────────────────────────────────
for (const k of ["HOME", "USERPROFILE"]) {
  if (ORIG[k] === undefined) delete process.env[k]
  else process.env[k] = ORIG[k]
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
