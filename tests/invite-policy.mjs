// 邀请码 —— 纯离线测试（0.3.64：三模式收成双模式，模式由 magpie 开关决定）
//
//   node tests/invite-policy.mjs
//
// 钉住：
//   · 只有两种模式：开关关 = 自动（滚动码）；开关开 = 挂 magpie「首选」那个账号
//   · 开关读不到（magpie 老版本 / 没注册 reader）一律当**关** —— 老用户行为不变
//   · 满额自动换上级的落点（策略文件 auto:true）在开关开时优先于「首选」
//   · 作者码必须指向还有名额的号（值本身钉在这里，换码要一起改）
//   · 死号自动回落：策略指向已删除账号 → 滚动；滚动码归属已删除 → 作者码
//   · 登录方式列表里**不再**有「邀请码」那一条（设置搬去供应商编辑器了）
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
  INVITE_FIRST_OPTION,
  authorInvite,
  inviteFirstOn,
  preferredInviteOf,
  readInvitePolicy,
  writeInvitePolicy,
  clearInvitePolicy,
  inviteToUse,
  preferredOrg,
  setInviteOptionReader,
  backfillInviteCodes,
} = await import("../src/store.mjs")
const { makeMethods, inviteNote } = await import("../src/hooks/methods.mjs")
const { siteCtx, SITES } = await import("../src/context.mjs")

const c = siteCtx(SITES.cn)
const SITE = c.id
const AUTHOR = AUTHOR_INVITE[SITE]
const ACCOUNT_CODE = "IVACCOUNT001"
const OTHER_CODE = "IVOTHER00001"
const ROLLING = "IVROLLING001"

/** 拨开关：true = 首选模式，false = 自动模式 */
function setSwitch(on) {
  setInviteOptionReader(SITE, (key) => key === INVITE_FIRST_OPTION && on === true)
}
/** 模拟 magpie 根本没有 option 能力：reader 抛错 */
function breakSwitch() {
  setInviteOptionReader(SITE, () => {
    throw new Error("no option")
  })
}

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

// ═══ ① 开关本身 ═══════════════════════════════════════════════════════
console.log("开关 —— 双模式的唯一入口（magpie 的 auth.options）")

check("没给这个站点注册 reader（老 magpie / 未注入）→ 开关当关", () => {
  assert.equal(inviteFirstOn(SITE), false)
})

check("reader 抛错 → 当关（不能因为读个开关把登录搞挂）", () => {
  breakSwitch()
  assert.equal(inviteFirstOn(SITE), false)
  setSwitch(false)
})

check("开关 key 是 invite-first（和 index.mjs 声明的是同一个）", () => {
  assert.equal(INVITE_FIRST_OPTION, "invite-first")
  let asked = null
  setInviteOptionReader(SITE, (key) => {
    asked = key
    return true
  })
  inviteFirstOn(SITE)
  assert.equal(asked, "invite-first")
  setSwitch(false)
})

// ═══ ② 作者码 ═════════════════════════════════════════════════════════
console.log("\n作者码 —— 必须指向还有名额的号（满了 = 新装机第一次注册白送）")

check("两站作者码就是本次换上去的那两个", () => {
  // 换这两个值必须同时改这里 —— 这条测试就是「换码忘记同步」的拦截网
  assert.equal(AUTHOR_INVITE.magicrew, "IV18D8KHVZ7T")
  assert.equal(AUTHOR_INVITE["magicrew-intl"], "IV486F5O59SC")
  assert.equal(AUTHOR_INVITE.magicrew, AUTHOR)
  assert.equal(authorInvite(SITE), AUTHOR)
})

// ═══ ③ 双模式语义 ═════════════════════════════════════════════════════
console.log("\n双模式 —— 开关关=自动（滚动）；开关开=首选账号")

check("开关关 → 用滚动码", () => {
  setSwitch(false)
  clearInvitePolicy(SITE)
  assert.equal(inviteToUse(SITE), ROLLING)
})

check("开关开 → 用 magpie 首选账号自己的码", () => {
  setSwitch(true)
  clearInvitePolicy(SITE)
  seedLogins("orgA")
  assert.equal(inviteToUse(SITE), ACCOUNT_CODE, "orgA 是首选，它的码是 IVACCOUNT001")
})

check("开关开 + 换首选 → 立刻跟着换（不用重新选）", () => {
  setSwitch(true)
  clearInvitePolicy(SITE)
  seedLogins("orgC")
  assert.equal(inviteToUse(SITE), OTHER_CODE)
  seedLogins("orgA")
})

check("开关开 + 首选账号的码还没缓存 → 回落滚动", () => {
  setSwitch(true)
  clearInvitePolicy(SITE)
  seedLogins("orgA")
  // 码缓存里只有 orgC，首选 orgA 一条码都没有
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({ orgC: { code: OTHER_CODE, accountId: "177****0000", at: "x" } }),
  )
  assert.equal(preferredInviteOf(SITE), null)
  assert.equal(inviteToUse(SITE), ROLLING)
  seedCodes()
})

check("开关开 + 首选账号被删（不在 plugin-auth）→ 回落滚动", () => {
  setSwitch(true)
  clearInvitePolicy(SITE)
  seedLogins("orgA")
  writeFileSync(
    join(CONFIG, "plugin-auth.json"),
    JSON.stringify({ [`${SITE}#def456`]: { org: "orgC", accountId: "177****0000", type: "oauth", jwt: "jwt-orgC" } }),
  )
  assert.equal(inviteToUse(SITE), ROLLING)
  seedAuth()
})

check("开关开 + 自动换的落点还在 → 用它，而不是退回满额的首选", () => {
  writeInvitePolicy(SITE, { mode: "fixed", auto: true, code: "IVAUTOPIN001", org: "orgC", accountId: "177****0000" })
  setSwitch(true)
  seedLogins("orgA")
  assert.equal(inviteToUse(SITE), "IVAUTOPIN001")
  clearInvitePolicy(SITE)
})

check("开关关了 → 满额换过来的落点不再生效（回到滚动）", () => {
  writeInvitePolicy(SITE, { mode: "fixed", auto: true, code: "IVAUTOPIN001", org: "orgC", accountId: "177****0000" })
  setSwitch(true)
  assert.equal(inviteToUse(SITE), "IVAUTOPIN001", "开关开时，自动换的落点优先")
  setSwitch(false)
  assert.equal(inviteToUse(SITE), ROLLING, "开关关了就回滚动码，落点不作数")
  clearInvitePolicy(SITE)
})

check("老策略（auto:false 的 fixed，用户当年手选的）→ 开关开时被忽略，改用首选", () => {
  // 0.3.63 及更早，fixed 是用户在登录页输 1 选出来的；现在模式归开关管，
  // 那份快照不能再压过 magpie 的首选（不然用户换了首选也不生效）。
  writeInvitePolicy(SITE, { mode: "fixed", code: "IVLEGACY0001", org: "orgC", accountId: "177****0000" })
  setSwitch(true)
  seedLogins("orgA")
  assert.equal(inviteToUse(SITE), ACCOUNT_CODE, "应该用首选 orgA 的码，不是那份老快照")
  setSwitch(false)
  clearInvitePolicy(SITE)
})

check("没有滚动文件 + 开关关 → 回落到作者码", () => {
  setSwitch(false)
  clearInvitePolicy(SITE)
  rmSync(join(CACHE, `magicrew-invite-${SITE}.json`), { force: true })
  assert.equal(inviteToUse(SITE), AUTHOR)
  seedRolling()
})

// ═══ ④ 存储层 ═════════════════════════════════════════════════════════
console.log("\n策略文件 —— 只记「满额自动换过来的落点」")

check("默认是 auto", () => {
  clearInvitePolicy(SITE)
  assert.deepEqual(readInvitePolicy(SITE), {
    mode: "auto",
    code: "",
    org: "",
    accountId: "",
    auto: false,
    at: "",
  })
})

check("auto:true 能存能读（这是「满额换过来的」标记）", () => {
  writeInvitePolicy(SITE, { mode: "fixed", auto: true, code: ACCOUNT_CODE, org: "orgA", accountId: "181****632" })
  const pol = readInvitePolicy(SITE)
  assert.equal(pol.mode, "fixed")
  assert.equal(pol.auto, true)
  assert.equal(pol.code, ACCOUNT_CODE)
  assert.equal(pol.org, "orgA")
  clearInvitePolicy(SITE)
})

check("老文件里的 custom 读成 auto（三模式已经收掉）", () => {
  writeFileSync(
    join(CACHE, `magicrew-invite-policy-${SITE}.json`),
    JSON.stringify({ mode: "custom", code: "IVCUSTOM0001" }),
  )
  assert.equal(readInvitePolicy(SITE).mode, "auto")
  clearInvitePolicy(SITE)
})

check("乱写的 mode 一律读成 auto", () => {
  writeFileSync(join(CACHE, `magicrew-invite-policy-${SITE}.json`), JSON.stringify({ mode: "nonsense" }))
  assert.equal(readInvitePolicy(SITE).mode, "auto")
  clearInvitePolicy(SITE)
})

check('旧 org:"author" 读成空 org（作者不是账号）', () => {
  // 开关开着才会读策略（关着直接走滚动码，与这条无关）
  setSwitch(true)
  writeInvitePolicy(SITE, { mode: "fixed", auto: true, code: AUTHOR, org: "author", accountId: "MYCF711" })
  assert.equal(readInvitePolicy(SITE).org, "")
  assert.equal(inviteToUse(SITE), AUTHOR)
  clearInvitePolicy(SITE)
  setSwitch(false)
})

// ═══ ⑤ 死号回退 ══════════════════════════════════════════════════════
console.log("\n账号删除后的回落 —— 落点/滚动码不作废就注册落空")

check("自动换的落点指向已删除的账号 → 回落首选", () => {
  setSwitch(true)
  writeInvitePolicy(SITE, { mode: "fixed", auto: true, code: "IVDEAD000001", org: "orgDEAD", accountId: "已删除" })
  seedLogins("orgA")
  assert.equal(inviteToUse(SITE), ACCOUNT_CODE, "死落点不认，改用首选 orgA")
  clearInvitePolicy(SITE)
})

check("滚动码归属已删除的账号 → 回落作者码", () => {
  setSwitch(false)
  writeFileSync(
    join(CACHE, `magicrew-invite-codes-${SITE}.json`),
    JSON.stringify({
      orgA: { code: ACCOUNT_CODE, accountId: "181****632", at: "x" },
      orgDEAD: { code: "IVDEADROLL01", accountId: "已删除", at: "x" },
    }),
  )
  writeFileSync(join(CACHE, `magicrew-invite-${SITE}.json`), JSON.stringify({ code: "IVDEADROLL01", at: "x" }))
  assert.equal(inviteToUse(SITE), AUTHOR)
  seedCodes()
  seedRolling()
})

check("滚动码归属不明（不在缓存里）→ 保守保留", () => {
  setSwitch(false)
  assert.equal(inviteToUse(SITE), ROLLING)
})

// ═══ ⑥ 登录方式列表 ═══════════════════════════════════════════════════
console.log("\n登录方式列表 —— 「邀请码」那条已经拆掉（设置搬去供应商编辑器）")

check("preferredOrg 读 logins.json 的 first", () => {
  assert.equal(preferredOrg(SITE), "orgA")
  seedLogins("orgC")
  assert.equal(preferredOrg(SITE), "orgC")
  seedLogins("orgA")
})

check("国内站 3 条、国际站 4 条，且都不含「邀请码」", () => {
  const cnLabels = makeMethods(c).map((m) => m.label)
  const intlLabels = makeMethods(siteCtx(SITES.intl)).map((m) => m.label)
  assert.equal(cnLabels.length, 3, `国内站应该 3 条，实际：${cnLabels.join(" / ")}`)
  assert.equal(intlLabels.length, 4, `国际站应该 4 条，实际：${intlLabels.join(" / ")}`)
  for (const l of [...cnLabels, ...intlLabels]) {
    assert.ok(!/邀请码/.test(l), `不该再有「邀请码」入口：${l}`)
    // 0.3.50：label 在插件加载时被 magpie 缓存，放会变的上级就等于永远显示旧值
    assert.ok(!/上级/.test(l), `标签里不该出现上级（加载时缓存，不会刷新）：${l}`)
  }
})

// ═══ ⑦ inviteNote ═════════════════════════════════════════════════════
console.log("\ninstructions 里的「本次邀请上级」—— 每次点登录现算")

await checkAsync("开关关 → 不写上级（自动模式没什么可说的）", async () => {
  setSwitch(false)
  clearInvitePolicy(SITE)
  assert.doesNotMatch(inviteNote(c), /本次邀请上级/)
})

await checkAsync("开关开 + 首选 → 写「magpie 账号页的首选」", async () => {
  setSwitch(true)
  clearInvitePolicy(SITE)
  seedLogins("orgA")
  const note = inviteNote(c)
  assert.match(note, /本次邀请上级：181\*\*\*\*632/, `实际：${note}`)
  assert.match(note, /首选/)
})

await checkAsync("开关开 + 满额换过 → 写「首选已满，自动换的」", async () => {
  setSwitch(true)
  writeInvitePolicy(SITE, { mode: "fixed", auto: true, code: "IVAUTOPIN001", org: "orgC", accountId: "177****0000" })
  const note = inviteNote(c)
  assert.match(note, /本次邀请上级：177\*\*\*\*0000/, `实际：${note}`)
  assert.match(note, /自动换的/)
  clearInvitePolicy(SITE)
})

await checkAsync("开关开但还没有首选 → 明说「自动」，不留空", async () => {
  setSwitch(true)
  clearInvitePolicy(SITE)
  seedLogins("none")
  // seedLogins("none") 时 preferredOrg 会退回 order/第一行 —— 要真没有首选就得拿掉 logins.json
  rmSync(join(CONFIG, "logins.json"), { force: true })
  assert.match(inviteNote(c), /自动/, `实际：${inviteNote(c)}`)
  seedLogins("orgA")
})

// ═══ ⑧ backfill ═══════════════════════════════════════════════════════
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
// Windows 上临时目录偶尔被占用（杀软 / 索引服务正扫着），删不掉不该让测试失败
try {
  rmSync(FAKE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {}

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)