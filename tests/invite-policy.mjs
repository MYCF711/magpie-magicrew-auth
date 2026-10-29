// 邀请上级 —— 纯离线测试（0.3.40：自动=0；首选=1）
//
//   node tests/invite-policy.mjs
//
// 钉住：
//   · 策略 auto / fixed / custom；作者码 org 为空、死号自动回落
//   · 0 / 留空 / 非法文本 = 自动（滚动码）；1 = 当前首选账号的邀请码
//   · 首选来自 magpie logins.json 的 first（Make first 写的那一个）
//   · 切换首选后再点 1，读到的是新的首选账号
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
  preferredOrg,
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
      orgA: { code: ACCOUNT_CODE, accountId: "181****632", at: "2026-10-29T00:00:00Z" },
      orgB: { code: AUTHOR, accountId: "189****051", at: "2026-10-29T00:00:00Z" },
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
      [`${SITE}#abc123`]: { org: "orgA", accountId: "181****632", type: "oauth", jwt: "jwt-orgA" },
      [`${SITE}#def456`]: { org: "orgC", accountId: "177****0000", type: "oauth", jwt: "jwt-orgC" },
      "magicrew-intl#xyz": { org: "orgB", accountId: "189****051", type: "oauth" },
    }),
  )
}
/** magpie 的 logins.json：first=true 的账号就是账号页「首选」 */
function seedLogins(preferred = "orgA") {
  const rows = [
    { agent: `plugin:${SITE}`, user: "181****632", home: `${SITE}#abc123`, on: true, first: preferred === "orgA" },
    { agent: `plugin:${SITE}`, user: "177****0000", home: `${SITE}#def456`, on: true, first: preferred === "orgC" },
  ]
  if (preferred === "none") for (const r of rows) r.first = false
  writeFileSync(join(CONFIG, "logins.json"), JSON.stringify(rows))
}
seedCodes()
seedRolling()
seedAuth()
seedLogins("orgA")

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
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "181****632" })
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
      orgA: { code: ACCOUNT_CODE, accountId: "181****632", at: "x" },
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

// ═══ ③ 0=自动 / 1=首选 ═══════════════════════════════════════════════
console.log("\n邀请上级 —— 自动=0；首选=1")

function inviteMethod() {
  return makeMethods(c).find((m) => m.type === "api" && String(m.label).includes("邀请上级"))
}

check("preferredOrg 读 logins.json 的 first", () => {
  assert.equal(preferredOrg(SITE), "orgA")
  seedLogins("orgC")
  assert.equal(preferredOrg(SITE), "orgC")
  seedLogins("orgA")
})

check("提示只有一行：自动=0；首选=1", () => {
  const msg = inviteMethod().prompts[0].message
  assert.equal(msg, "邀请上级：自动=0；首选=1；不填=默认自动")
})

check("ask 每次按当时首选生成；已填 invite 后不再问", async () => {
  seedLogins("orgC")
  const m = inviteMethod()
  const p = await m.ask({})
  assert.equal(p.type, "text")
  assert.match(p.message, /首选=1/)
  assert.equal(await m.ask({ invite: "1" }), null)
  seedLogins("orgA")
})

await checkAsync("填 0 / 留空 / 非法文本 → auto", async () => {
  for (const v of ["0", "", "abc", "-1", "99"]) {
    await inviteMethod().authorize({ invite: v })
    assert.equal(readInvitePolicy(SITE).mode, "auto")
  }
})

await checkAsync("填 1 → 当前首选（orgA）的码", async () => {
  seedLogins("orgA")
  const r = await inviteMethod().authorize({ invite: "1" })
  assert.equal(r.type, "failed")
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.mode, "fixed")
  assert.equal(pol.code, ACCOUNT_CODE)
  assert.equal(pol.org, "orgA")
  assert.equal(pol.accountId, "181****632")
})

await checkAsync("切换首选后重新点 1 → 新首选（orgC）的码", async () => {
  seedLogins("orgC")
  await inviteMethod().authorize({ invite: "1" })
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.code, OTHER_CODE)
  assert.equal(pol.org, "orgC")
  seedLogins("orgA")
})

await checkAsync("首选账号没有码 → 回退 0 auto", async () => {
  seedLogins("orgC")
  // 删掉 orgC 的码，只剩 orgA
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({ orgA: { code: ACCOUNT_CODE, accountId: "181****632", at: "x" } }),
  )
  const r = await inviteMethod().authorize({ invite: "1" })
  assert.match(r.error, /回退 0/)
  assert.equal(readInvitePolicy(SITE).mode, "auto")
  seedCodes()
  seedLogins("orgA")
})

check("标题与当前策略同源（固定时带上级，auto 不带）", () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "181****632" })
  const label = makeMethods(c).find((m) => /手机号/.test(m.label)).label
  assert.match(label, /（上级 181\*\*\*\*632）/)
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
    assert.equal(codes.orgA.accountId, "181****632")
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
