// 邀请额度 —— 纯离线测试（0.3.62：名额口径 / 真实邮箱判定 / 满了自动换上级）
//
//   node tests/invite-quota.mjs
//
// 钉住：
//   · 名额上限按站点奖励口径算：国内 60,000÷1,000 = 60、国际 10,000÷200 = 50
//   · 判满两条路取或：名额用完 **或** 邀请积分封顶
//   · 「真实邮箱」只认白名单后缀 —— temp-mail.io 的域名是动态的，黑名单追不上
//   · 首选模式下上级满了 → 自动切到「真实邮箱 + 未满 + 剩余最多」的账号
//   · 非首选模式不动；没有真实邮箱替补不硬切；10 分钟内不重复查
//
// 隔离 HOME，不碰真实策略/账号文件；网络用 mock，不联网。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-quota-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
const CACHE = join(FAKE, ".cache", "magpie")
const CONFIG = join(FAKE, ".config", "magpie")
mkdirSync(CACHE, { recursive: true })
mkdirSync(CONFIG, { recursive: true })

const {
  quotaConfig,
  limitOf,
  quotaOf,
  isRealMailbox,
  isEligibleParent,
  accountsOf,
  statusOf,
  readQuotaCache,
  findInviteSuccessor,
  enforceInviteSwitch,
} = await import("../src/invite-quota.mjs")
const { readInvitePolicy, writeInvitePolicy } = await import("../src/store.mjs")
const { siteCtx, SITES } = await import("../src/context.mjs")

const cn = siteCtx(SITES.cn)
const intl = siteCtx(SITES.intl)

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

/** 每个用例前把落盘状态清干净，避免互相污染（两站都清 —— 只清一站会跨用例串号） */
function reset() {
  for (const f of ["plugin-auth.json", "logins.json"]) rmSync(join(CONFIG, f), { force: true })
  for (const f of readdirSync(CACHE)) {
    if (f.startsWith("magicrew-")) rmSync(join(CACHE, f), { force: true })
  }
}

/** plugin-auth.json：本站点登录着的账号 */
function seedAuth(rows) {
  const auth = {}
  for (const r of rows) auth[r.home] = { type: "oauth", org: r.org, accountId: r.accountId, uid: r.org, jwt: r.jwt ?? `jwt-${r.org}` }
  writeFileSync(join(CONFIG, "plugin-auth.json"), JSON.stringify(auth))
}

/**
 * mock 上游邀请接口。
 *
 * fetch 的第二个参数（headers 里有 organization-code）在 mock 里不方便区分
 * 调用方，所以走 `globalThis.__currentOrg`：每个用例自己设当前账号。
 * `byOrg[org] = { code, count, earned }`；没配的 org 回 2155（用户不存在）。
 */
function mockFetch(byOrg) {
  const orig = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    const row = byOrg[globalThis.__currentOrg]
    if (!row) return new Response(JSON.stringify({ code: 2155, message: "用户不存在" }), { status: 200 })
    if (u.includes("/rewards/total-points")) {
      return new Response(JSON.stringify({ code: 1000, data: { total_earned_points: row.earned ?? 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(
      JSON.stringify({
        code: 1000,
        data: {
          invite_code: row.code,
          invite_count: row.count ?? 0,
          invited_users: [],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  return { calls, restore: () => { globalThis.fetch = orig } }
}

// ═══ ① 名额口径 ══════════════════════════════════════════════════════
console.log("\n名额上限 —— 按站点奖励口径换算（上游不给 limit 字段）")

check("国内站 60,000÷1,000 = 60 次", () => {
  reset()
  assert.deepEqual(quotaConfig("magicrew"), { perInvite: 1000, capPoints: 60_000 })
  assert.equal(limitOf("magicrew"), 60)
})

check("国际站 10,000÷200 = 50 次（用户界面复核口径）", () => {
  reset()
  assert.deepEqual(quotaConfig("magicrew-intl"), { perInvite: 200, capPoints: 10_000 })
  assert.equal(limitOf("magicrew-intl"), 50)
})

check("配置文件可以覆盖口径（活动调整时不用改代码）", () => {
  reset()
  writeFileSync(
    join(CACHE, "magicrew-invite-quota-config-magicrew.json"),
    JSON.stringify({ perInvite: 500, capPoints: 10_000 }),
  )
  assert.equal(limitOf("magicrew"), 20)
})

// ═══ ② 判满 ══════════════════════════════════════════════════════════
console.log("\n判满 —— 名额用完 或 积分封顶，两条取或")

check("已邀 20 / 上限 50 → 20/50，还剩 30", () => {
  reset()
  const q = quotaOf("magicrew-intl", { count: 20, earned: 4000 })
  assert.equal(q.limit, 50)
  assert.equal(q.left, 30)
  assert.equal(q.full, false)
  assert.equal(q.display, "20 / 50 次")
})

check("名额到顶 → 满", () => {
  reset()
  const q = quotaOf("magicrew-intl", { count: 50, earned: 2000 })
  assert.equal(q.full, true)
  assert.equal(q.left, 0)
})

check("名额没到但积分已封顶（订阅奖励顶上去）→ 也满", () => {
  reset()
  const q = quotaOf("magicrew-intl", { count: 42, earned: 10_000 })
  assert.equal(q.full, true)
})

check("超额的脏数据不会算出负数剩余", () => {
  reset()
  const q = quotaOf("magicrew", { count: 999, earned: 0 })
  assert.equal(q.left, 0)
  assert.equal(q.full, true)
})

// ═══ ③ 真实邮箱判定 ══════════════════════════════════════════════════
console.log("\n真实邮箱 —— 只认白名单后缀（临时邮箱域名是动态的，黑名单追不上）")

check("常见邮箱服务商 → 真", () => {
  reset()
  for (const a of [
    "1451895195@qq.com",
    "1470292681@qq.com",
    "someone@163.com",
    "a.b@gmail.com",
    "x@outlook.com",
    "y@icloud.com",
    "m18970098051_1@163.com",
  ]) {
    assert.equal(isRealMailbox("magicrew-intl", a), true, a)
  }
})

check("temp-mail.io 的域名 → 假（实测 jbsze.net / yzcalo.com）", () => {
  reset()
  assert.equal(isRealMailbox("magicrew-intl", "vtnbieqimcguyjrnun@jbsze.net"), false)
  assert.equal(isRealMailbox("magicrew-intl", "abc@yzcalo.com"), false)
})

check("没有 @ 的 accountId（临时邮箱号 / 组织码兜底）→ 假", () => {
  reset()
  for (const a of ["dkroe85ii62n", "7fli52t2tc2b", "189****051", "", undefined]) {
    assert.equal(isRealMailbox("magicrew", a), false, String(a))
  }
})

check("形如邮箱但后缀不在白名单 → 假（不猜）", () => {
  reset()
  assert.equal(isRealMailbox("magicrew-intl", "a@random-corp-xyz.dev"), false)
})

check("国内站默认：打码手机号不算（国内站根本没有邮箱登录）", () => {
  reset()
  assert.equal(isEligibleParent("magicrew", "189****051"), false)
  assert.equal(isEligibleParent("magicrew", "181****632"), false)
})

check("打开 allowPhoneAccounts 后，打码手机号可以当上级（随机串仍不行）", () => {
  reset()
  writeFileSync(
    join(CACHE, "magicrew-invite-quota-config-magicrew.json"),
    JSON.stringify({ allowPhoneAccounts: true }),
  )
  assert.equal(isEligibleParent("magicrew", "189****051"), true)
  assert.equal(isEligibleParent("magicrew", "dkroe85ii62n"), false)
  assert.equal(isEligibleParent("magicrew", "1@qq.com"), true, "真邮箱始终合格")
})

check("配置文件能追加自建域名后缀", () => {
  reset()
  writeFileSync(
    join(CACHE, "magicrew-invite-quota-config-magicrew-intl.json"),
    JSON.stringify({ realMailDomains: ["mycorp.com"] }),
  )
  assert.equal(isRealMailbox("magicrew-intl", "boss@mycorp.com"), true)
  assert.equal(isRealMailbox("magicrew-intl", "boss@othercorp.com"), false)
})

// ═══ ④ 账号表 ════════════════════════════════════════════════════════
console.log("\naccountsOf —— 本站点账号表")

check("按 org 去重，优先留带 jwt 的那条", () => {
  reset()
  seedAuth([
    { home: "magicrew-intl", org: "orgA", accountId: "dkroe85ii62n", jwt: "" },
    { home: "magicrew-intl#wx4jsu", org: "orgA", accountId: "a@qq.com", jwt: "jwt-a" },
    { home: "magicrew", org: "orgB", accountId: "b@163.com", jwt: "jwt-b" },
  ])
  const list = accountsOf("magicrew-intl")
  assert.equal(list.length, 1)
  assert.equal(list[0].org, "orgA")
  assert.equal(list[0].jwt, "jwt-a")
  assert.equal(list[0].accountId, "a@qq.com")
})

// ═══ ⑤ 查额度 + 缓存 ═════════════════════════════════════════════════
console.log("\nstatusOf —— 查额度并缓存")

await checkAsync("拿到 count / earned / code，并写进缓存", async () => {
  reset()
  seedAuth([{ home: "magicrew-intl#a", org: "orgA", accountId: "a@qq.com", jwt: "jwt-a" }])
  globalThis.__currentOrg = "orgA"
  const m = mockFetch({ orgA: { code: "IVAAAA000001", count: 20, earned: 4000 } })
  try {
    const st = await statusOf(intl, "orgA", { force: true })
    assert.equal(st.count, 20)
    assert.equal(st.earned, 4000)
    assert.equal(st.limit, 50)
    assert.equal(st.display, "20 / 50 次")
    assert.equal(st.full, false)
    assert.equal(readQuotaCache("magicrew-intl").orgA.count, 20)
  } finally {
    m.restore()
  }
})

await checkAsync("5 分钟内的第二次调用不再打网络", async () => {
  reset()
  seedAuth([{ home: "magicrew-intl#a", org: "orgA", accountId: "a@qq.com", jwt: "jwt-a" }])
  globalThis.__currentOrg = "orgA"
  const m = mockFetch({ orgA: { code: "IVAAAA000001", count: 20, earned: 4000 } })
  try {
    await statusOf(intl, "orgA", { force: true })
    const before = m.calls.length
    await statusOf(intl, "orgA")
    assert.equal(m.calls.length, before, "缓存命中时不该再发请求")
  } finally {
    m.restore()
  }
})

// ═══ ⑥ 挑替补 ════════════════════════════════════════════════════════
console.log("\nfindInviteSuccessor —— 真实邮箱 + 未满 + 剩余最多")

await checkAsync("跳过临时邮箱号和已满的真邮箱号", async () => {
  reset()
  seedAuth([
    { home: "magicrew-intl#a", org: "orgTemp", accountId: "dkroe85ii62n", jwt: "jwt-temp" },
    { home: "magicrew-intl#b", org: "orgFull", accountId: "full@qq.com", jwt: "jwt-full" },
    { home: "magicrew-intl#c", org: "orgSmall", accountId: "small@163.com", jwt: "jwt-small" },
    { home: "magicrew-intl#d", org: "orgBig", accountId: "big@gmail.com", jwt: "jwt-big" },
  ])
  // 预填缓存：findInviteSuccessor 会依次问每个候选的 statusOf，缓存命中就不打网络
  const { writeQuotaCache } = await import("../src/invite-quota.mjs")
  for (const [org, row] of Object.entries({
    orgTemp: { code: "IVTEMP000001", count: 0, earned: 0 },
    orgFull: { code: "IVFULL000001", count: 50, earned: 10_000 },
    orgSmall: { code: "IVSMALL00001", count: 40, earned: 8000 },
    orgBig: { code: "IVBIG0000001", count: 3, earned: 600 },
  })) writeQuotaCache("magicrew-intl", org, row)

  const pick = await findInviteSuccessor(intl, { excludeOrg: "" })
  assert.ok(pick, "应该挑出一个")
  assert.equal(pick.org, "orgBig", "剩余最多（47 个）的那个")
  assert.equal(pick.left, 47)
})

await checkAsync("候选多到查不完时按预算收手（不能把登录拖成几分钟）", async () => {
  reset()
  const rows = []
  for (let i = 0; i < 20; i++) rows.push({ home: `magicrew-intl#a${i}`, org: `org${i}`, accountId: `u${i}@qq.com`, jwt: `jwt-${i}` })
  seedAuth(rows)
  // 每个请求慢 4ms；预算 20ms ⇒ 只能查前几个
  const orig = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++
    await new Promise((r) => setTimeout(r, 4))
    const body = String(url).includes("/rewards/total-points")
      ? { code: 1000, data: { total_earned_points: 0 } }
      : { code: 1000, data: { invite_code: "IVX00000001", invite_count: 0, invited_users: [] } }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    const t0 = Date.now()
    const pick = await findInviteSuccessor(intl, { excludeOrg: "", budgetMs: 20 })
    const took = Date.now() - t0
    assert.ok(pick, "预算内查到第一个就该返回它")
    assert.ok(took < 1000, `耗时 ${took}ms，应该远小于预算上限`)
    assert.ok(calls < 40, `只查了 ${calls} 次请求，不该把 20 个候选全打完`)
  } finally {
    globalThis.fetch = orig
  }
})

await checkAsync("预算内一个都没查到 → 这一轮不切（返回 null）", async () => {
  reset()
  seedAuth([{ home: "magicrew-intl#a", org: "orgA", accountId: "a@qq.com", jwt: "jwt-a" }])
  const orig = globalThis.fetch
  globalThis.fetch = async () => { throw new Error("网络不通") }
  try {
    assert.equal(await findInviteSuccessor(intl, { excludeOrg: "" }), null)
  } finally {
    globalThis.fetch = orig
  }
})

// ═══ ⑦ 自动换上级 ════════════════════════════════════════════════════
console.log("\nenforceInviteSwitch —— 首选模式下满了就换真实邮箱号")

await checkAsync("非首选模式（auto）不动策略", async () => {
  reset()
  writeInvitePolicy("magicrew", { mode: "auto" })
  const r = await enforceInviteSwitch(cn)
  assert.equal(r.switched, false)
  assert.match(r.reason, /非首选模式/)
  assert.equal(readInvitePolicy("magicrew").mode, "auto")
})

await checkAsync("首选未满 → 不动", async () => {
  reset()
  seedAuth([{ home: "magicrew#a", org: "orgA", accountId: "a@qq.com", jwt: "jwt-a" }])
  writeInvitePolicy("magicrew", { mode: "fixed", code: "IVAAAA000001", org: "orgA", accountId: "a@qq.com" })
  const { writeQuotaCache } = await import("../src/invite-quota.mjs")
  writeQuotaCache("magicrew", "orgA", { code: "IVAAAA000001", count: 20, earned: 20_000 })
  const r = await enforceInviteSwitch(cn, { force: true })
  assert.equal(r.switched, false)
  assert.match(r.reason, /还没满/)
  assert.equal(readInvitePolicy("magicrew").org, "orgA")
})

await checkAsync("首选满额 → 自动切到真实邮箱且没满的账号", async () => {
  reset()
  seedAuth([
    { home: "magicrew#a", org: "orgA", accountId: "full@qq.com", jwt: "jwt-a" },
    { home: "magicrew#b", org: "orgB", accountId: "b@163.com", jwt: "jwt-b" },
    { home: "magicrew#c", org: "orgC", accountId: "tmpxxxx", jwt: "jwt-c" },
  ])
  writeInvitePolicy("magicrew", { mode: "fixed", code: "IVAAAA000001", org: "orgA", accountId: "full@qq.com" })
  const { writeQuotaCache } = await import("../src/invite-quota.mjs")
  writeQuotaCache("magicrew", "orgA", { code: "IVAAAA000001", count: 60, earned: 60_000 })
  writeQuotaCache("magicrew", "orgB", { code: "IVBBBB000001", count: 5, earned: 5000 })
  writeQuotaCache("magicrew", "orgC", { code: "IVCCCC000001", count: 0, earned: 0 })
  const r = await enforceInviteSwitch(cn, { force: true })
  assert.equal(r.switched, true)
  assert.match(r.reason, /b@163\.com/, "切换理由必须写清切给谁（只写「切到 0 / 50 次」没法排查）")
  const pol = readInvitePolicy("magicrew")
  assert.equal(pol.mode, "fixed")
  assert.equal(pol.org, "orgB", "跳过临时邮箱号 orgC，选真邮箱 orgB")
  assert.equal(pol.code, "IVBBBB000001")
  assert.equal(pol.accountId, "b@163.com")
  // 切换日志留痕
  const log = readFileSync(join(CACHE, "magicrew-invite-switch-magicrew.log"), "utf8")
  assert.match(log, /已满/)
  assert.match(log, /b@163\.com/)
})

await checkAsync("满额但没有真实邮箱替补 → 保持原样并留痕", async () => {
  reset()
  seedAuth([
    { home: "magicrew#a", org: "orgA", accountId: "full@qq.com", jwt: "jwt-a" },
    { home: "magicrew#c", org: "orgC", accountId: "tmpxxxx", jwt: "jwt-c" },
  ])
  writeInvitePolicy("magicrew", { mode: "fixed", code: "IVAAAA000001", org: "orgA", accountId: "full@qq.com" })
  const { writeQuotaCache } = await import("../src/invite-quota.mjs")
  writeQuotaCache("magicrew", "orgA", { code: "IVAAAA000001", count: 60, earned: 60_000 })
  writeQuotaCache("magicrew", "orgC", { code: "IVCCCC000001", count: 0, earned: 0 })
  const r = await enforceInviteSwitch(cn, { force: true })
  assert.equal(r.switched, false)
  assert.equal(readInvitePolicy("magicrew").org, "orgA")
  const log = readFileSync(join(CACHE, "magicrew-invite-switch-magicrew.log"), "utf8")
  assert.match(log, /没有「真实邮箱 \+ 未满」的替补/)
})

await checkAsync("10 分钟内重复调用直接跳过（节流）", async () => {
  reset()
  seedAuth([{ home: "magicrew#a", org: "orgA", accountId: "a@qq.com", jwt: "jwt-a" }])
  writeInvitePolicy("magicrew", { mode: "fixed", code: "IVAAAA000001", org: "orgA", accountId: "a@qq.com" })
  const { writeQuotaCache } = await import("../src/invite-quota.mjs")
  writeQuotaCache("magicrew", "orgA", { code: "IVAAAA000001", count: 10, earned: 10_000 })
  const first = await enforceInviteSwitch(cn, { force: true })
  assert.equal(first.switched, false)
  const again = await enforceInviteSwitch(cn)
  assert.equal(again.switched, false)
  assert.match(again.reason, /10 分钟内/)
})

// ═══ ⑧ 额度窗口里的那一行 ════════════════════════════════════════════
console.log("\nusage —— 额度窗口里的「邀请次数」行")

await checkAsync("窗口里出现「邀请次数 20 / 50 次」，并且不参与路由", async () => {
  reset()
  seedAuth([{ home: "magicrew-intl#a", org: "orgA", accountId: "a@qq.com", jwt: "jwt-a" }])
  const { writeQuotaCache } = await import("../src/invite-quota.mjs")
  writeQuotaCache("magicrew-intl", "orgA", { code: "IVAAAA000001", count: 20, earned: 4000 })

  // 积分接口要 mock 掉（usage 的其余部分靠它）
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/quota/points/total")) {
      return new Response(JSON.stringify({ code: 1000, data: { total_points: 1000, expiring_quota_details: [] } }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  try {
    const { makeUsage } = await import("../src/hooks/usage.mjs")
    const usage = await makeUsage(intl)(async () => ({ jwt: "jwt-a", org: "orgA" }))
    const w = usage.windows.find((x) => x.name === "邀请次数")
    assert.ok(w, "应该有「邀请次数」窗口")
    assert.equal(w.display, "20 / 50 次")
    assert.equal(w.aside, true, "必须是 aside：不参与路由占比")
    assert.equal(w.used, undefined, "aside 行不给 used（HOOKS 三·①）")
    assert.equal(w.amount, undefined)
    assert.equal(w.limit, undefined, "绝不能给 limit，否则被当额度算占比")
  } finally {
    globalThis.fetch = orig
  }
})

await checkAsync("满额的账号显示「已满」，且余额窗口仍非 aside（这个号不会从路由里消失）", async () => {
  reset()
  seedAuth([{ home: "magicrew-intl#a", org: "orgA", accountId: "a@qq.com", jwt: "jwt-a" }])
  const { writeQuotaCache } = await import("../src/invite-quota.mjs")
  writeQuotaCache("magicrew-intl", "orgA", { code: "IVAAAA000001", count: 50, earned: 10_000 })

  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/quota/points/total")) {
      return new Response(JSON.stringify({ code: 1000, data: { total_points: 800, expiring_quota_details: [] } }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  try {
    const { makeUsage } = await import("../src/hooks/usage.mjs")
    const usage = await makeUsage(intl)(async () => ({ jwt: "jwt-a", org: "orgA" }))
    const inv = usage.windows.find((x) => x.name === "邀请次数")
    assert.equal(inv.display, "50 / 50 次 · 已满")
    const bal = usage.windows.find((x) => x.name === "积分余额")
    assert.ok(bal)
    assert.notEqual(bal.aside, true, "余额窗口必须参与路由，否则这个号 Known=false")
  } finally {
    globalThis.fetch = orig
  }
})

await checkAsync("查不到邀请额度就不加这一行（不显示假数字）", async () => {
  reset()
  // 没有 plugin-auth、没有缓存 ⇒ statusOf 返回 null
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/quota/points/total")) {
      return new Response(JSON.stringify({ code: 1000, data: { total_points: 500, expiring_quota_details: [] } }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  try {
    const { makeUsage } = await import("../src/hooks/usage.mjs")
    const usage = await makeUsage(intl)(async () => ({ jwt: "jwt-a", org: "orgNobody" }))
    assert.equal(usage.windows.find((x) => x.name === "邀请次数"), undefined)
    assert.ok(usage.windows.find((x) => x.name === "积分余额"), "余额窗口不受影响")
  } finally {
    globalThis.fetch = orig
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
