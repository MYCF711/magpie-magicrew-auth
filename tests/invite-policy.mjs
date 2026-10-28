// 邀请上级 —— 纯离线测试（0.3.36：登录页一个数字文本框）
//
//   node tests/invite-policy.mjs
//
// 钉住：
//   · 策略 auto / fixed / custom；作者码 org 为空、死号自动回落
//   · 数字方法：0=我的（作者 MYCF711），1..N=账号（按账号名排序），-1=自动，
//     留空 / 不存在数字回退 0
//   · 对照表写进 prompt message；ask 每次按最新账号清单生成
//   · backfillInviteCodes 给老账号补码
//
// 隔离 HOME，不碰真实策略/账号文件，不联网。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
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
  backfillInviteCodes,
} = await import("../src/store.mjs")
const { makeMethods } = await import("../src/hooks/methods.mjs")
const { siteCtx, SITES } = await import("../src/context.mjs")

const c = siteCtx(SITES.cn)
const SITE = c.id
const AUTHOR = AUTHOR_INVITE[SITE]
const ACCOUNT_CODE = "IVACCOUNT001"
const OTHER_CODE = "IVOTHER00001"
const ROLLING = "IVROLLING001"

function seedCodes() {
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({
      orgA: { code: ACCOUNT_CODE, accountId: "138****0000", at: "2026-10-29T00:00:00Z" },
      orgB: { code: AUTHOR, accountId: "author-duplicate", at: "2026-10-29T00:00:00Z" },
      orgC: { code: OTHER_CODE, accountId: "177****0000", at: "2026-10-29T00:00:00Z" },
    }),
  )
}
function seedRolling() {
  writeFileSync(join(CACHE, `magicrew-invite-${SITE}.json`), JSON.stringify({ code: ROLLING, at: "x" }))
}
function seedAuth() {
  writeFileSync(
    join(CONFIG, "plugin-auth.json"),
    JSON.stringify({
      [`${SITE}#abc123`]: { org: "orgA", accountId: "138****0000", type: "oauth", jwt: "jwt-orgA" },
      [`${SITE}#def456`]: { org: "orgC", accountId: "177****0000", type: "oauth", jwt: "jwt-orgC" },
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
console.log("邀请策略存储 —— auto / fixed / custom")

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
  seedRolling()
})

check("authorInvite 就是作者码", () => {
  assert.equal(authorInvite(SITE), AUTHOR)
})

check('旧 org:"author" 读成空 org（作者不是账号）', () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: AUTHOR, org: "author", accountId: "MYCF711" })
  assert.equal(readInvitePolicy(SITE).org, "")
  assert.equal(inviteToUse(SITE, true), AUTHOR)
})

// ═══ ② 死号回退 ══════════════════════════════════════════════════════
console.log("\n账号删除后的回落 —— fixed/滚动码不作废就注册落空")

check("fixed 指向已删除的账号 → 回落滚动", () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: "IVDEAD000001", org: "orgDEAD", accountId: "已删除" })
  assert.equal(inviteToUse(SITE, true), ROLLING)
})

check("滚动码归属已删除的账号 → 回落作者码", () => {
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({
      orgA: { code: ACCOUNT_CODE, accountId: "138****0000", at: "x" },
      orgDEAD: { code: "IVDEADROLL01", accountId: "已删除", at: "x" },
    }),
  )
  writeFileSync(join(CACHE, `magicrew-invite-${SITE}.json`), JSON.stringify({ code: "IVDEADROLL01", at: "x" }))
  assert.equal(inviteToUse(SITE, true), AUTHOR)
  seedCodes()
  seedRolling()
})

check("滚动码归属不明（不在缓存里）→ 保守保留", () => {
  assert.equal(inviteToUse(SITE, true), ROLLING)
})

// ═══ ③ 数字方法 ══════════════════════════════════════════════════════
console.log("\n邀请上级（数字）—— 0=当前滚动码，1..N=账号")

function inviteMethod() {
  return makeMethods(c).find((m) => m.type === "api" && String(m.label).includes("邀请上级"))
}

check("message：0=当前滚动账号，1..N=账号；0 指向的那格隐藏", () => {
  writeFileSync(join(CACHE, `magicrew-invite-${SITE}.json`), JSON.stringify({ code: OTHER_CODE, at: "x" }))
  const msg = inviteMethod().prompts[0].message
  assert.match(msg, /0 = 177\*\*\*\*0000（IVOTHER00001）/)
  assert.match(msg, /1 = 138\*\*\*\*0000（IVACCOUNT001）/)
  assert.doesNotMatch(msg, /2 = /) // orgC 是当前 0，后端占 n=2，但页面不显示
  assert.doesNotMatch(msg, /author-duplicate/)
  seedRolling()
})

check("ask 每次按最新清单生成；已填 invite 后不再问", async () => {
  const m = inviteMethod()
  const p = await m.ask({})
  assert.equal(p.type, "text")
  assert.match(p.message, /IVACCOUNT001/)
  assert.equal(await m.ask({ invite: "1" }), null)
})

await checkAsync("填 0 → auto（当前滚动码）", async () => {
  const r = await inviteMethod().authorize({ invite: "0" })
  assert.equal(r.type, "failed")
  assert.equal(readInvitePolicy(SITE).mode, "auto")
})

await checkAsync("填 1 → 第一个账号", async () => {
  await inviteMethod().authorize({ invite: "1" })
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.mode, "fixed")
  assert.equal(pol.code, ACCOUNT_CODE)
  assert.equal(pol.org, "orgA")
  assert.equal(pol.accountId, "138****0000")
})

await checkAsync("填 2（当前 0 的账号，后端存在但页面隐藏）→ 仍可选中", async () => {
  writeFileSync(join(CACHE, `magicrew-invite-${SITE}.json`), JSON.stringify({ code: OTHER_CODE, at: "x" }))
  await inviteMethod().authorize({ invite: "2" })
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.mode, "fixed")
  assert.equal(pol.code, OTHER_CODE)
  assert.equal(pol.org, "orgC")
  seedRolling()
})

await checkAsync("填 -1（超出范围）→ 回退 0 auto", async () => {
  await inviteMethod().authorize({ invite: "-1" })
  assert.equal(readInvitePolicy(SITE).mode, "auto")
})

await checkAsync("留空 → 0 auto", async () => {
  await inviteMethod().authorize({ invite: "" })
  assert.equal(readInvitePolicy(SITE).mode, "auto")
})

await checkAsync("不存在的数字 / 非数字 → 回退 0 auto", async () => {
  await inviteMethod().authorize({ invite: "99" })
  assert.equal(readInvitePolicy(SITE).mode, "auto")
  await inviteMethod().authorize({ invite: "abc" })
  assert.equal(readInvitePolicy(SITE).mode, "auto")
})

await checkAsync("已保存提示里带账号与码", async () => {
  const r = await inviteMethod().authorize({ invite: "1" })
  assert.match(r.error, /138\*\*\*\*0000/)
  assert.match(r.error, /IVACCOUNT001/)
})

check("标题与当前策略同源（固定时带上级，auto 不带）", () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" })
  const label = makeMethods(c).find((m) => /手机号/.test(m.label)).label
  assert.match(label, /（上级 138\*\*\*\*0000）/)
  writeInvitePolicy(SITE, { mode: "auto" })
  const auto = makeMethods(c).find((m) => /手机号/.test(m.label)).label
  assert.doesNotMatch(auto, /（上级/)
})

// ═══ ④ backfill ══════════════════════════════════════════════════════
console.log("\nbackfillInviteCodes —— 老账号补码")

await checkAsync("给 plugin-auth 里有 JWT 的账号补码", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 1000, data: { invite_code: "IVBACK000001" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  try {
    rmSync(join(CACHE, `magicrew-invite-codes-${SITE}.json`), { force: true })
    await backfillInviteCodes()
    const codes = JSON.parse(readFileSync(join(CACHE, `magicrew-invite-codes-${SITE}.json`), "utf8"))
    assert.equal(codes.orgA.code, "IVBACK000001")
    assert.equal(codes.orgA.accountId, "138****0000")
  } finally {
    globalThis.fetch = orig
    seedCodes()
  }
})

// ── 收尾 ───────────────────────────────────────────────────────────────
for (const k of ["HOME", "USERPROFILE"]) {
  if (ORIG[k] === undefined) delete process.env[k]
  else process.env[k] = ORIG[k]
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
