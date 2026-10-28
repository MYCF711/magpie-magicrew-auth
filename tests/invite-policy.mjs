// 邀请上级策略 —— 纯离线测试
//
//   node tests/invite-policy.mjs
//
// 钉住邀请设置的存储层与解析链路（0.3.32 页面版）：
//   · 策略三态 auto / fixed / custom；锁定开关关掉时一律回落到滚动
//   · 登录用码的来源优先级：页面 options（inviteBySite）→ 文件策略 → 滚动 → 作者码
//   · 账号被删（org 不在 plugin-auth.json）→ fixed/滚动码作废，自动回落
//   · 按钮标题（inviteTag）与登录真正用的码同源，死号不显示
//
// 隔离 HOME，不碰真实策略/账号文件，不联网。
// （设置入口自页面版起不在 methods 里 —— 见 page/，那里是纯前端，无断言价值。）

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
  pruneDeadAccounts,
  syncInvitePage,
} = await import("../src/store.mjs")
const { makeMethods, inviteFromOptions } = await import("../src/hooks/methods.mjs")
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
/** magpie 的账号文件（只读它拿账号名；liveOrgs 也读它判断账号死活） */
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
  seedRolling()
})

check("authorInvite 就是作者码", () => {
  assert.equal(authorInvite(SITE), AUTHOR)
})

// ═══ ② 账号被删（liveOrgs）══════════════════════════════════════════
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

check("账号文件读不到 → 不校验，行为与从前一致", () => {
  const authFile = join(CONFIG, "plugin-auth.json")
  const keep = readFileSync(authFile, "utf8")
  rmSync(authFile, { force: true })
  writeInvitePolicy(SITE, { mode: "fixed", code: "IVWHATEVER001", org: "orgGONE", accountId: "x" })
  assert.equal(inviteToUse(SITE, true), "IVWHATEVER001")
  writeFileSync(authFile, keep)
})

// ═══ ②′ 账号删除 / 新号注册竞态（pruneDeadAccounts）════════════════
console.log("\n删除账号的清理 与 新号注册的竞态保护")

check("死号（老条目）→ 从缓存清掉；滚动码属它 → 一并清掉", () => {
  const OLD = "2026-10-01T00:00:00Z"
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({
      orgA: { code: ACCOUNT_CODE, accountId: "138****0000", at: OLD },
      orgDEAD: { code: "IVDEADROLL01", accountId: "已删除", at: OLD },
    }),
  )
  writeFileSync(join(CACHE, `magicrew-invite-${SITE}.json`), JSON.stringify({ code: "IVDEADROLL01", at: "x" }))
  const r = pruneDeadAccounts(SITE)
  assert.deepEqual(r, { dead: ["orgDEAD"], rollingCleared: true })
  const cache = JSON.parse(readFileSync(join(CACHE, `magicrew-invite-codes-${SITE}.json`), "utf8"))
  assert.deepEqual(Object.keys(cache), ["orgA"])
  assert.equal(existsSync(join(CACHE, `magicrew-invite-${SITE}.json`)), false)
  seedRolling()
})

check("新号竞态：刚记录（auth 文件还没有它）→ 不清", () => {
  const NOW = new Date().toISOString()
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({
      orgA: { code: ACCOUNT_CODE, accountId: "138****0000", at: NOW },
      orgNEW: { code: "IVNEWCODE001", accountId: "832****143", at: NOW },
    }),
  )
  const r = pruneDeadAccounts(SITE)
  assert.deepEqual(r, { dead: [], rollingCleared: false })
  const cache = JSON.parse(readFileSync(join(CACHE, `magicrew-invite-codes-${SITE}.json`), "utf8"))
  assert.equal(cache.orgNEW.code, "IVNEWCODE001")
})

check("滚动码属于刚注册的新号 → 不清", () => {
  const NOW = new Date().toISOString()
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({ orgNEW: { code: "IVNEWCODE001", accountId: "832****143", at: NOW } }),
  )
  writeFileSync(join(CACHE, `magicrew-invite-${SITE}.json`), JSON.stringify({ code: "IVNEWCODE001", at: "x" }))
  const r = pruneDeadAccounts(SITE)
  assert.deepEqual(r, { dead: [], rollingCleared: false })
  assert.equal(existsSync(join(CACHE, `magicrew-invite-${SITE}.json`)), true)
  seedCodes()
  seedRolling()
})

// ═══ ③ 按钮标题与登录同源 ═══════════════════════════════════════════
console.log("\n按钮标题（inviteTag）—— 与登录真正用的码同一个来源")

function mobileLabel(getLock, getOpts) {
  return makeMethods(c, getLock, getOpts).find((m) => /手机号/.test(m.label)).label
}

check("页面选了活账号 → 标题带它的名字", () => {
  const opts = { inviteBySite: { [SITE]: { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" } } }
  assert.match(mobileLabel(() => true, () => opts), /（上级 138\*\*\*\*0000）/)
})

check("页面选了已删除的账号 → 标题不显示它，回落文件策略", () => {
  clearInvitePolicy(SITE)
  const opts = { inviteBySite: { [SITE]: { mode: "fixed", code: "IVDEAD000001", org: "orgDEAD", accountId: "已删除" } } }
  assert.doesNotMatch(mobileLabel(() => true, () => opts), /已删除/)
})

check("文件策略 fixed → 标题带策略里的账号；策略指向死号 → 不带", () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" })
  assert.match(mobileLabel(() => true, () => ({})), /（上级 138\*\*\*\*0000）/)
  writeInvitePolicy(SITE, { mode: "fixed", code: "IVDEAD000001", org: "orgDEAD", accountId: "已删除" })
  assert.doesNotMatch(mobileLabel(() => true, () => ({})), /已删除/)
})

check("锁定关掉 → 标题不带上级", () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" })
  assert.doesNotMatch(mobileLabel(() => false, () => ({})), /（上级/)
})

// ═══ ④ 锁定开关 + 工厂第二参数（官方契约：`(ctx, options)`）══════════
console.log("\ninviteLock / 工厂第二参数 —— buildPlugin 暴露，默认开")

await checkAsync("buildPlugin 读第二参数 inviteLock；锁定关掉时标题不带上级", async () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" })
  const on = await _internal.buildPlugin(c)({}, { inviteLock: true })
  const off = await _internal.buildPlugin(c)({}, { inviteLock: false })
  assert.match(on.auth.methods.find((m) => /手机号/.test(m.label)).label, /（上级/)
  assert.doesNotMatch(off.auth.methods.find((m) => /手机号/.test(m.label)).label, /（上级/)
})

await checkAsync("页面选码 + 锁定关闭 → 登录仍回到滚动（页面选择不作数）", async () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: "IVKEEP000001", org: "orgA", accountId: "138****0000" })
  const opts = { inviteBySite: { [SITE]: { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" } } }
  assert.equal(inviteFromOptions(c, () => opts, () => false), ROLLING)
  assert.equal(inviteFromOptions(c, () => opts, () => true), ACCOUNT_CODE)
  const auto = { inviteBySite: { [SITE]: { mode: "auto", code: "" } } }
  assert.equal(inviteFromOptions(c, () => auto, () => true), ROLLING)
})

await checkAsync("页面按站点写 inviteLockBySite，优先于全局 inviteLock", async () => {
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" })
  const off = await _internal.buildPlugin(c)({}, { inviteLock: true, inviteLockBySite: { [SITE]: false } })
  assert.doesNotMatch(off.auth.methods.find((m) => /手机号/.test(m.label)).label, /（上级/)
  const on = await _internal.buildPlugin(c)({}, { inviteLock: false, inviteLockBySite: { [SITE]: true } })
  assert.match(on.auth.methods.find((m) => /手机号/.test(m.label)).label, /（上级/)
})

await checkAsync("工厂第二参数就是页面 options —— 标题按它显示（死号同前规则）", async () => {
  clearInvitePolicy(SITE)
  const p = await _internal.buildPlugin(c)({}, {
    inviteBySite: { [SITE]: { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" } },
  })
  assert.match(p.auth.methods.find((m) => /手机号/.test(m.label)).label, /（上级 138\*\*\*\*0000）/)
  const dead = await _internal.buildPlugin(c)({}, {
    inviteBySite: { [SITE]: { mode: "fixed", code: "IVDEAD000001", org: "orgDEAD", accountId: "已删除" } },
  })
  assert.doesNotMatch(dead.auth.methods.find((m) => /手机号/.test(m.label)).label, /已删除/)
})

check("syncInvitePage 生成 codes.js（作者 / 账号 / 策略）", () => {
  const root = join(FAKE, "pkgroot")
  mkdirSync(join(root, "page"), { recursive: true })
  writeInvitePolicy(SITE, { mode: "fixed", code: ACCOUNT_CODE, org: "orgA", accountId: "138****0000" })
  syncInvitePage({ root })
  const text = readFileSync(join(root, "page", "codes.js"), "utf8")
  assert.match(text, /^window\.MAGICREW_CODES = /)
  const data = JSON.parse(text.replace(/^window\.MAGICREW_CODES = /, "").replace(/;\s*$/, ""))
  assert.equal(data.sites[SITE].author, AUTHOR)
  assert.equal(data.sites[SITE].codes.orgA.code, ACCOUNT_CODE)
  assert.equal(data.sites[SITE].policy.mode, "fixed")
})

check("页面包含作者项与按站点的锁定复选框；package 打包 page/", () => {
  const page = readFileSync(new URL("../page/app.js", import.meta.url), "utf8")
  assert.match(page, /我的（作者 MYCF711）/)
  assert.match(page, /inviteLockBySite/)
  assert.match(page, /锁定（签到不再覆盖）/)
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.ok(pkg.files.includes("page"))
  assert.equal(pkg.magpie.page.file, "page/index.html")
})

// ── 收尾 ───────────────────────────────────────────────────────────────
for (const k of ["HOME", "USERPROFILE"]) {
  if (ORIG[k] === undefined) delete process.env[k]
  else process.env[k] = ORIG[k]
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
