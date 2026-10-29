// 额度窗口的 resetsAt —— 纯函数测试，不联网。
//
//   node tests/usage-resets-at.mjs
//
// 为什么这条要单独钉（2026-10-29 实测，本机一天 1,332 次 402）：
//
//   一池账号全耗尽时，宿主挨个试过去（一次请求 tries=13），每个都回 402。
//   而上游那条文案里有「充值」，宿主读成 out-of-credit —— 那种休息是**猜的**
//   ，一分钟后就把账号叫醒再问一次。于是：撞 402 → 睡 1 分钟 → 又醒 → 又撞。
//   30 分钟里同一个账号被撞 134 次。
//
// 修法的一半在上报里：余额 ≤ 0 时报 resetsAt（下一次补充积分的时刻），
// 宿主才知道这个账户的额度是「满的，直到那一刻」，休息能睡到那里，
// 积分补上后还会自动醒。
//
// 另一半在 loader（tests/credit-to-quota.mjs）：正文改成「额度 / 用量」的说法，
// 宿主才肯按 out-of-quota 那套（睡到额度恢复）来休息。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeUsage } from "../src/hooks/usage.mjs"
import { siteCtx, SITES } from "../src/context.mjs"

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

// ── 起一个假环境：usage 只读 auth，不碰磁盘，但 ensureCheckinDefault 会
//    读设置 —— 给它一个空 HOME 就好。
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-usage-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
mkdirSync(join(FAKE, ".cache", "magpie"), { recursive: true })
mkdirSync(join(FAKE, ".config", "magpie"), { recursive: true })

/**
 * 造一个 usage 钩子，积分接口返回给定的余额与批次。
 */
function usageWith(total, expiring = []) {
  const c = siteCtx(SITES.cn)
  const real = c.host
  const hook = makeUsage(c)
  // fetchPoints 走 fetch —— 这里直接替换全局 fetch，只认积分那个接口
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/v1/quota/points/total")) {
      return new Response(
        JSON.stringify({
          data: {
            total_points: total,
            expiring_quota_details: expiring,
            next_cycle_grant: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return origFetch(url)
  }
  return {
    hook,
    restore: () => {
      globalThis.fetch = origFetch
    },
    host: real,
  }
}

const auth = () => ({ org: "acc1", jwt: "x".repeat(350), host: SITES.cn.host })

console.log("余额 ≤ 0（耗尽）—— 窗口要带 resetsAt")

await checkAsync("total=0 → 窗口报 resetsAt（RFC 3339，在未来）", async () => {
  const u = usageWith(0)
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    assert.ok(w, "要有「积分余额」窗口")
    assert.equal(w.balance, 0)
    assert.ok(w.resetsAt, "耗尽时必须报 resetsAt")
    // RFC 3339
    const t = Date.parse(w.resetsAt)
    assert.ok(Number.isFinite(t), `resetsAt 要能解析: ${w.resetsAt}`)
    // 在未来
    assert.ok(t > Date.now(), `resetsAt 要在未来: ${w.resetsAt}`)
    // plan 说清楚是耗尽
    assert.equal(out.plan, "已耗尽")
  } finally {
    u.restore()
  }
})

await checkAsync("total=-28（欠费）→ 同样报 resetsAt", async () => {
  const u = usageWith(-28)
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    assert.ok(w.resetsAt, "负余额也要报 resetsAt")
    assert.ok(Date.parse(w.resetsAt) > Date.now())
  } finally {
    u.restore()
  }
})

await checkAsync("resetsAt 落在下一个北京时间 00:00（每日积分补充点）", async () => {
  const u = usageWith(0)
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    const bj = new Date(Date.parse(w.resetsAt) + 8 * 3600e3)
    assert.equal(bj.getUTCHours(), 0, `应是北京时间 0 点: ${w.resetsAt}`)
    assert.equal(bj.getUTCMinutes(), 0)
    assert.equal(bj.getUTCSeconds(), 0)
    // 在今天或明天（不会更远）
    const days = Math.round((bj.getTime() - (Date.now() + 8 * 3600e3)) / 86400e3)
    assert.ok(days >= 0 && days <= 1, `应在 24 小时内: ${days}`)
  } finally {
    u.restore()
  }
})

console.log("\n余额 > 0 —— 不该被当成耗尽")

await checkAsync("total=966 → 不报 resetsAt（走 runsOutOf 那条路）", async () => {
  const u = usageWith(966)
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    assert.equal(w.balance, 966)
    assert.equal(w.resetsAt, undefined, "有余额时不该报 resetsAt")
    assert.equal(out.plan, "积分制")
  } finally {
    u.restore()
  }
})

await checkAsync("total=100 + 一个今日批次 → 仍不报 resetsAt，但有 runsOutAt", async () => {
  const u = usageWith(100, [
    { remaining_points: 50, expires_at: "2026-10-29 23:59:59" },
  ])
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    assert.equal(w.resetsAt, undefined)
    assert.ok(w.runsOutAt, "有批次到期就该报 runsOutAt")
  } finally {
    u.restore()
  }
})

console.log("\n耗尽时不报「今日 / 限时 / 永久」那几行")

await checkAsync("total=0 → 只有余额窗口，没有展示用的批次行", async () => {
  const u = usageWith(0)
  try {
    const out = await u.hook(auth)
    const names = out.windows.map((x) => x.name)
    assert.deepEqual(names, ["积分余额"])
  } finally {
    u.restore()
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
