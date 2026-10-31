// 「注册成功那一下就把八个新人任务补完」—— kickoffOnboarding 的接线 + runCheckin 的幂等
//   ＋ 顺带钉住「注册成功那一刻把邀请码记成『最后注册的新号』」（0.3.67）
//
//   node tests/onboarding-kickoff.mjs
//
// 背景（主人 2026-10-30）：八个新人引导任务原来只在**每天一次的签到**里跑，
// 新号注册完当天要等下一次签到才补；主人问「能不能在注册成功的时候跑完」。
//
// 实现没重写一套：登录成功的公共出口 `kickoffOnboarding()` 里多触发一次
// `tasks.runCheckin()` —— 它本来就有 pending 过滤 / first_ai_work / 其余 7 项 PUT。
//
// 这份测试锁四件事：
//   ① **fire-and-forget**：runCheckin 再慢也不许卡住登录 callback（用永不 resolve 的 fake 计时）；
//   ② **接线**：JWT 登录那条路的 `callback()` 返回 success 之后，runCheckin 确实被触发一次；
//   ③ **注册落点**：第一次见的 org 要把自己的邀请码记成「最后注册的新号」，重登不许覆盖
//      （0.3.67 起自动模式跟的是它，不是「最后一个登录 / 签到的号」）；
//   ④ **幂等**：连跑两轮不重复 PUT / 不重复领每日积分；同一账号并发两轮只跑一轮。
//
// ⚠ 假 HOME 必须在 import methods.mjs **之前**设好：credentials.mjs 在模块初始化时
//   就把 `~/.config/magpie/magicrew-login-states` 算成常量；设晚了测试会往真目录写凭证。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SITES } from "../src/api.mjs"

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-onboarding-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
mkdirSync(join(FAKE, ".cache", "magpie"), { recursive: true })
mkdirSync(join(FAKE, ".config", "magpie"), { recursive: true })

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
    console.log(`      ${String(e?.message ?? e).split("\n")[0]}`)
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
    console.log(`      ${String(e?.message ?? e).split("\n").join("\n      ")}`)
  }
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
const site = { id: SITES.cn.id, host: SITES.cn.host, web: SITES.cn.web, SHORT: "超级麦吉 Super Magic" }
const authOf = (org) => ({ jwt: "jwt-test", org, host: SITES.cn.host })

const { kickoffOnboarding, makeMethods } = await import("../src/hooks/methods.mjs")
const { runCheckin } = await import("../src/tasks.mjs")

// ══ 一、kickoffOnboarding：必须 fire-and-forget ═════════════════════════

console.log("\n① kickoffOnboarding —— 不 await、不阻塞")

await checkAsync("runCheckin 永不返回 → kickoffOnboarding 也立刻返回（计时 < 50ms）", async () => {
  let calls = 0
  let got = null
  const never = (args) => {
    calls++
    got = args
    return new Promise(() => {}) // 永远不结束，模拟「8 项任务 + 等结算」的最坏情况
  }
  const t0 = Date.now()
  const p = kickoffOnboarding(site, "jwt-a", "org-a", { runCheckin: never })
  const ms = Date.now() - t0
  assert.ok(ms < 50, `调用本身必须同步返回，实际 ${ms}ms`)
  assert.equal(typeof p?.then, "function", "应返回可等待的 promise（测试用）")
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1, `runCheckin 要被触发一次，实际 ${calls}`)
  assert.deepEqual(got, { jwt: "jwt-a", org: "org-a", host: SITES.cn.host }, "参数必须带 host")
})

await checkAsync("runCheckin 抛错 → 只留日志，不冒泡（登录不受影响）", async () => {
  const logs = []
  const orig = console.error
  console.error = (...a) => logs.push(a.join(" "))
  try {
    await kickoffOnboarding(site, "jwt-b", "org-b", {
      runCheckin: async () => {
        throw new Error("boom-123")
      },
    })
  } finally {
    console.error = orig
  }
  assert.ok(logs.some((l) => l.includes("boom-123")), `失败要留一行日志，实际 ${JSON.stringify(logs)}`)
})

// ══ 二、登录 callback 的接线：返回 success 之后触发一次、且不等待 ══════

console.log("\n② JWT 登录 callback —— 先返回 success，再在后台补任务")

/**
 * 登录链路（JWT 那条）需要的假上游。
 * `login-gift` 故意挂住：如果 callback 偷偷 await 了 runCheckin，测试会直接超时。
 */
function installLoginServer({ inviteCode = "IVTESTCODE1" } = {}) {
  const orig = globalThis.fetch
  const state = { giftCalls: 0, release: null, gate: null }
  state.gate = new Promise((r) => { state.release = r })

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const method = String(init.method || "GET").toUpperCase()
    if (u.includes("/api/v1/quota/points/total")) return json({ code: 1000, data: { total_points: 100, expiring_quota_details: [] } })
    if (u.includes("/api/v1/model-gateway/tokens") && method === "POST") {
      return json({ code: 1000, data: { api_key: "mgw_test", refresh_token: "rt_test", api_key_expires_at: "2026-10-31T00:00:00Z", refresh_token_expires_at: "2026-11-30T00:00:00Z" } })
    }
    if (u.includes("/api/v1/invitations/info")) return json({ code: 1000, data: { invite_code: inviteCode, invite_count: 0, invited_users: [] } })
    if (u.includes("/api/v1/contact/accounts/me/users")) return json({ code: 1000, data: { items: [{ phone: "13800000000" }] } })
    if (u.includes("/api/v1/login-gift")) {
      state.giftCalls++
      await state.gate // 卡住：模拟 runCheckin 还没跑完
      return json({ code: 1000, data: { granted: false } })
    }
    throw new Error(`unexpected fetch ${method} ${u}`)
  }
  return { state, restore: () => { globalThis.fetch = orig } }
}

await checkAsync("callback() 在 runCheckin 还卡着时就返回 success（< 1s），并触发了一次 runCheckin", async () => {
  const srv = installLoginServer()
  try {
    const methods = makeMethods(site)
    const method = methods.find((m) => String(m.label).includes("登录态"))
    assert.ok(method, "要能找到「登录态（JWT + 组织码）」这条方法")
    const flow = await method.authorize({ jwt: "eyJ" + "x".repeat(60), org: "orglogin001" })

    const t0 = Date.now()
    const r = await flow.callback()
    const ms = Date.now() - t0
    assert.equal(r?.type, "success", `要返回 success，实际 ${JSON.stringify(r)}`)
    assert.ok(ms < 1000, `callback 不能被补任务拖住，实际 ${ms}ms`)
    // 给后台的 runCheckin 一点时间发出第一个请求
    await new Promise((res) => setTimeout(res, 30))
    assert.equal(srv.state.giftCalls, 1, `runCheckin 应被触发一次（每日登录接口被问一次），实际 ${srv.state.giftCalls}`)
  } finally {
    srv.state.release()
    await new Promise((res) => setTimeout(res, 30))
    srv.restore()
  }
})

// ══ 三、注册那一刻记下「最后注册的新号」的邀请码 ═══════════════════════
//
// 主人 2026-10-30 的要求：自动模式要跟「最后一个注册进来的新号」，
// 不是「最后一个登录 / 签到的号」。所以注册成功那一刻要把这个号的邀请码记下来，
// 而重登同一个号只能刷滚动码、不许改这条记录。

console.log("\n③ 注册那一刻记下它的邀请码（重登不覆盖）")

const { readRegisteredInvite, readInvite } = await import("../src/store.mjs")
const SITE_ID = SITES.cn.id

/** 走 JWT 登录那条路，org 已给定时用它自己的邀请码 */
async function jwtLogin(org, inviteCode) {
  const srv = installLoginServer({ inviteCode })
  try {
    const methods = makeMethods(site)
    const method = methods.find((m) => String(m.label).includes("登录态"))
    const flow = await method.authorize({ jwt: "eyJ" + "x".repeat(60), org })
    const r = await flow.callback()
    await new Promise((res) => setTimeout(res, 30))
    return r
  } finally {
    srv.state.release()
    await new Promise((res) => setTimeout(res, 30))
    srv.restore()
  }
}

await checkAsync("magpie 里第一次见的 org → 记成「最后注册的新号」", async () => {
  const r = await jwtLogin("orgreg001", "IVNEWACCT001")
  assert.equal(r?.type, "success", `要返回 success，实际 ${JSON.stringify(r)}`)
  const reg = readRegisteredInvite(SITE_ID)
  assert.ok(reg, "要写下注册记录")
  assert.equal(reg.code, "IVNEWACCT001")
  assert.equal(reg.org, "orgreg001")
})

await checkAsync("同一个号再登一次 → 注册记录不动，只刷滚动码", async () => {
  const r = await jwtLogin("orgreg001", "IVNEWACCT002")
  assert.equal(r?.type, "success")
  assert.equal(readRegisteredInvite(SITE_ID).code, "IVNEWACCT001", "重登不许改「最后注册的新号」")
  assert.equal(readInvite(SITE_ID), "IVNEWACCT002", "滚动码照旧刷新（它只是兜底）")
})

// ══ 四、runCheckin 幂等 ═════════════════════════════════════════════════

console.log("\n④ runCheckin 幂等 —— 重复调用不重复领奖")

/** 有状态的假上游：签到接口会真的把任务标记完成、把积分加上去 */
function installCheckinServer() {
  const orig = globalThis.fetch
  const state = {
    tasks: [
      { code: "t1", title: "任务一", points: 100, status: "PENDING", reward_status: "PENDING" },
      { code: "t2", title: "任务二", points: 50, status: "PENDING", reward_status: "PENDING" },
    ],
    giftGranted: false,
    gifts: 0,
    puts: [],
    total: 0,
    releaseGift: null,
    giftGate: null,
  }
  state.giftGate = new Promise((r) => { state.releaseGift = r })

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const method = String(init.method || "GET").toUpperCase()
    if (u.includes("/api/v1/quota/points/total")) return json({ code: 1000, data: { total_points: state.total, expiring_quota_details: [] } })
    if (u.includes("/api/v1/login-gift")) {
      state.gifts++
      if (state.giftGranted) return json({ code: 1000, data: { granted: false, message: "今天已领取" } })
      state.giftGranted = true
      state.total += 200
      return json({ code: 1000, data: { granted: true, point_amount: 200 } })
    }
    if (u.includes("/api/v1/onboarding/tasks")) {
      if (method === "GET") return json({ code: 1000, data: { tasks: state.tasks } })
      const m = /\/onboarding\/tasks\/([^/]+)\/completion$/.exec(u)
      if (m) {
        const code = decodeURIComponent(m[1])
        state.puts.push(code)
        const t = state.tasks.find((x) => x.code === code)
        if (t && t.status !== "COMPLETED") {
          t.status = "COMPLETED"
          t.reward_status = "GRANTED"
          state.total += t.points
        }
        return json({ code: 1000, data: { points: t ? t.points : 0 } })
      }
    }
    throw new Error(`unexpected fetch ${method} ${u}`)
  }
  return { state, restore: () => { globalThis.fetch = orig } }
}

await checkAsync("连跑两轮：第一轮补 2 项，第二轮 0 次 PUT、每日积分不重复发", async () => {
  const srv = installCheckinServer()
  try {
    const auth = authOf("org-idem")
    const r1 = await runCheckin(auth)
    assert.equal(r1.outcome, "claimed", r1.message)
    assert.ok(r1.message.includes("每日登录 +200"), r1.message)
    assert.ok(r1.message.includes("新手福利完成 2 项：任务一、任务二"), r1.message)
    assert.deepEqual(srv.state.puts, ["t1", "t2"], "第一轮要把两项都补上")

    const r2 = await runCheckin(auth)
    assert.equal(r2.outcome, "done", r2.message)
    assert.ok(r2.message.includes("每日登录已领过"), r2.message)
    assert.ok(r2.message.includes("新手福利 2 项均已领完"), r2.message)
    assert.deepEqual(srv.state.puts, ["t1", "t2"], "第二轮不许再 PUT（重复领奖）")
    assert.equal(srv.state.total, 350, "积分只该加一次：200 签到 + 100 + 50")
  } finally {
    srv.restore()
  }
})

await checkAsync("同一账号并发两轮：第二轮直接跳过，服务端只被问一轮", async () => {
  const srv = installCheckinServer()
  try {
    // 第一轮卡在「每日登录」上，确保它还在跑
    const inner = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/api/v1/login-gift")) {
        srv.state.gifts++
        await srv.state.giftGate
        return json({ code: 1000, data: { granted: true, point_amount: 200 } })
      }
      return inner(url, init)
    }

    const auth = authOf("org-concurrent")
    const p1 = runCheckin(auth)
    await new Promise((r) => setTimeout(r, 30)) // 让第一轮进到 login-gift
    const r2 = await runCheckin(auth)
    assert.equal(r2.outcome, "done", r2.message)
    assert.ok(r2.message.includes("已有一轮"), `第二轮应说明被跳过：${r2.message}`)

    srv.state.releaseGift()
    const r1 = await p1
    assert.equal(r1.outcome, "claimed", r1.message)
    assert.equal(srv.state.gifts, 1, "只该有一轮打到每日登录接口")
    assert.deepEqual(srv.state.puts, ["t1", "t2"], "任务也只该补一轮")
  } finally {
    srv.restore()
  }
})

// 收尾
for (const [k, v] of Object.entries(ORIG)) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
