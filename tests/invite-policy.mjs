// 邀请码 —— 纯离线测试（0.3.41：自动=0；首选=1；0.3.43 起保存后接本站主验证码方式）
//
//   node tests/invite-policy.mjs
//
// 钉住：
//   · 策略 auto / fixed / custom；作者码 org 为空、死号自动回落
//   · 0 / 留空 / 非法文本 = 自动（滚动码）；1 = 当前首选账号的邀请码
//   · 首选来自 magpie logins.json 的 first（Make first 写的那一个）
//   · 切换首选后再点 1，读到的是新的首选账号
//   · 保存后接哪条验证码：**国际站邮箱、国内站手机号**（站点分叉，别写死）
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

// ═══ ③ 邀请码：0=自动 / 1=首选，保存后接本站主验证码方式 ═══════
//     （国际站 → 邮箱；国内站 → 手机号。0.3.43 之前国际站也被写死成手机号。）
console.log("邀请码 —— 自动=0；首选=1；保存后接本站主验证码")

function inviteMethodOf(ctx) {
  return makeMethods(ctx).find((m) => m.type === "oauth" && String(m.label).includes("邀请码"))
}
const inviteMethod = () => inviteMethodOf(c)
const cIntl = siteCtx(SITES.intl)
const INTL_SITE = cIntl.id

check("preferredOrg 读 logins.json 的 first", () => {
  assert.equal(preferredOrg(SITE), "orgA")
  seedLogins("orgC")
  assert.equal(preferredOrg(SITE), "orgC")
  seedLogins("orgA")
})

check("提示灰色字：当前模式，自动 → 输入 1 切换首选", () => {
  writeInvitePolicy(SITE, { mode: "auto" })
  const p = inviteMethod().prompts[0]
  assert.equal(p.message, "邀请码")
  assert.equal(p.placeholder, "当前模式：自动，输入 1 切换：首选")
})

check("提示灰色字只有自动 / 首选两种（保存的首选快照也显示首选）", () => {
  seedLogins("orgA")
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "181****632" })
  // 0.3.63 撤回：框里只写模式（不写上级、不写邀请次数）。
  // 次数在额度卡片上已经有了，而且带邮箱后整串放不进输入框会被截断。
  assert.equal(inviteMethod().prompts[0].placeholder, "当前模式：首选，输入 0 切换：自动")
  seedLogins("orgC") // 首选项后来变了，保存的快照仍显示首选
  assert.equal(inviteMethod().prompts[0].placeholder, "当前模式：首选，输入 0 切换：自动")
  seedLogins("orgA")
})

await checkAsync("国内站 ask 链：邀请码 → 手机号 → null", async () => {
  writeInvitePolicy(SITE, { mode: "auto" })
  const m = inviteMethod()
  const p0 = await m.ask({})
  assert.equal(p0.key, "invite")
  assert.equal(p0.placeholder, "当前模式：自动，输入 1 切换：首选")
  const p1 = await m.ask({ invite: "1" })
  assert.equal(p1.key, "phone")
  assert.equal(p1.type, "text")
  assert.equal(await m.ask({ invite: "1", phone: "13800138000" }), null)
})

await checkAsync("国际站 ask 链：邀请码 → 邮箱 → null（0.3.43）", async () => {
  writeInvitePolicy(INTL_SITE, { mode: "auto" })
  const m = inviteMethodOf(cIntl)
  const p0 = await m.ask({})
  assert.equal(p0.key, "invite")
  const p1 = await m.ask({ invite: "1" })
  assert.equal(p1.key, "email", "国际站邀请码之后应该问邮箱，不是手机号")
  assert.equal(p1.type, "text")
  assert.equal(await m.ask({ invite: "1", email: "a@b.com" }), null)
})

await checkAsync("国际站 authorize：保存策略后接邮箱方法（缺邮箱 → 报「邮箱不完整」）", async () => {
  writeInvitePolicy(INTL_SITE, { mode: "auto" })
  await assert.rejects(inviteMethodOf(cIntl).authorize({ invite: "0" }), /邮箱不完整/)
  assert.equal(readInvitePolicy(INTL_SITE).mode, "auto")
})

await checkAsync("国内站 authorize：保存策略后接手机号方法（缺手机号 → 报「手机号不完整」）", async () => {
  writeInvitePolicy(SITE, { mode: "auto" })
  await assert.rejects(inviteMethod().authorize({ invite: "0" }), /手机号不完整/)
  assert.equal(readInvitePolicy(SITE).mode, "auto")
})

await checkAsync("填 0 / 留空 / 非法文本 → 保存 auto，然后接手机验证码", async () => {
  for (const v of ["0", "", "abc", "-1", "99"]) {
    await assert.rejects(inviteMethod().authorize({ invite: v }))
    assert.equal(readInvitePolicy(SITE).mode, "auto")
  }
})

await checkAsync("填 1 → 保存当前首选（orgA）的码，然后接手机验证码", async () => {
  seedLogins("orgA")
  await assert.rejects(inviteMethod().authorize({ invite: "1" }))
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.mode, "fixed")
  assert.equal(pol.code, ACCOUNT_CODE)
  assert.equal(pol.org, "orgA")
  assert.equal(pol.accountId, "181****632")
})

await checkAsync("切换首选后重新点 1 → 保存新首选（orgC）的码", async () => {
  seedLogins("orgC")
  await assert.rejects(inviteMethod().authorize({ invite: "1" }))
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.code, OTHER_CODE)
  assert.equal(pol.org, "orgC")
  seedLogins("orgA")
})

await checkAsync("首选账号没有码 → 保存 auto", async () => {
  seedLogins("orgC")
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({ orgA: { code: ACCOUNT_CODE, accountId: "181****632", at: "x" } }),
  )
  await assert.rejects(inviteMethod().authorize({ invite: "1" }))
  assert.equal(readInvitePolicy(SITE).mode, "auto")
  seedCodes()
  seedLogins("orgA")
})

check("标题不带上级（加载时缓存，动态信息放 instructions）", () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "181****632" })
  const label = makeMethods(c).find((m) => /手机号/.test(m.label)).label
  // 0.3.50：label 在插件加载时被 magpie 缓存，不能放会变的上级 —— 改了策略也不会刷新。
  assert.doesNotMatch(label, /上级/)
  writeInvitePolicy(SITE, { mode: "auto" })
  const auto = makeMethods(c).find((m) => /手机号/.test(m.label)).label
  assert.doesNotMatch(auto, /上级/)
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
