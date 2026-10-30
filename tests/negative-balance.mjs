// 负数积分（欠费）与三种上游返回形状 —— 纯函数 + 钩子测试，不联网。
//
//   node tests/negative-balance.mjs
//
// ═══ 为什么这条要单独钉 ═══════════════════════════════════════════════════
//
// 2026-10-30：国内站四个号在卡片上显示「-1 / -31 / -32 / -153 积分」，
// 主人以为是「邀请注册的号被清空了」。实测（原样 JSON 见 CHANGELOG 0.3.65）：
//
//   GET /api/v1/quota/points/total
//   → {"code":1000,"message":"ok","data":{"organization_total_points":-31,
//      "total_points":-31,"expiring_quota_details":[],"next_cycle_grant":null,…}}
//
// 上游**真的**给负数 —— 插件没有把「已用」读成「剩余」，也没有把 `"-31"` 解析错。
// 但显示层原来照抄上游：窗口 `balance: -31`、顶层 `balance: "-31 积分"`。
// 负数摆在「剩余」位上的后果不是「少一点信息」，是用户看不懂：
// 是欠 31？是花了 31？还是插件算错了？
//
// 这条测试锁四件事：
//   ① 上游四种形状（number / 带单位字符串 / Unicode 负号 / 缺字段）都读得对；
//   ② 窗口 `balance` **永远 ≥ 0** —— 它进路由算占比，负数没有意义；
//   ③ 欠费必须显式说成「已欠费 N 积分」，且**任何用户可见文案里没有负号**；
//   ④ 读不到 ≠ 0：缺字段要报 error，不能谎报「已耗尽」。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeUsage } from "../src/hooks/usage.mjs"
import { parsePointsValue } from "../src/api.mjs"
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
    console.log(`      ${String(e?.message ?? e).split("\n")[0]}`)
  }
}

// ── 假环境：usage 会碰设置 / 缓存目录，给它一个空 HOME ──────────────────
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-negative-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
mkdirSync(join(FAKE, ".cache", "magpie"), { recursive: true })
mkdirSync(join(FAKE, ".config", "magpie"), { recursive: true })

/**
 * 起一个 usage 钩子，积分接口返回给定的 `data` 原文（保留 null / 缺字段）。
 *
 * `data` 直接塞进 `data:` 里 —— 测试要能造出「字段整个不存在」这种形状，
 * 所以不能在这里先补默认值。
 */
function usageWithData(data) {
  const c = siteCtx(SITES.cn)
  const hook = makeUsage(c)
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/v1/quota/points/total")) {
      return new Response(JSON.stringify({ code: 1000, message: "ok", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return origFetch(url)
  }
  return {
    hook,
    restore: () => {
      globalThis.fetch = origFetch
    },
  }
}

const auth = () => ({ org: "acc1", jwt: "x".repeat(350), host: SITES.cn.host })

/** 用户可见的每一段文案（顶层 + 每个窗口） */
function visibleStrings(out) {
  return [
    out.plan,
    out.balance,
    ...(out.windows ?? []).map((w) => w.display),
  ].filter((s) => typeof s === "string")
}

// ══ 一、parsePointsValue：四种上游形状 ═════════════════════════════════

console.log("上游字段解析（number / 带单位字符串 / Unicode 负号 / 缺字段）")

check("number -31 → -31", () => assert.equal(parsePointsValue(-31), -31))
check("number 0 → 0（0 是「用完」，不是「读不到」）", () => assert.equal(parsePointsValue(0), 0))
check("number 107 → 107", () => assert.equal(parsePointsValue(107), 107))
check('"-31" → -31', () => assert.equal(parsePointsValue("-31"), -31))
check('"-31 积分" → -31（带单位）', () => assert.equal(parsePointsValue("-31 积分"), -31))
check('"−32"（U+2212 减号）→ -32', () => assert.equal(parsePointsValue("−32"), -32))
check('"-153积分"（无空格）→ -153', () => assert.equal(parsePointsValue("-153积分"), -153))
check('"1,234 积分" → 1234（千分位）', () => assert.equal(parsePointsValue("1,234 积分"), 1234))
check('"(31)" / "（31）" → -31（会计写法）', () => {
  assert.equal(parsePointsValue("(31)"), -31)
  assert.equal(parsePointsValue("（31）"), -31)
})
check('"已欠费 31" → null（不是纯数字开头就不猜）', () => assert.equal(parsePointsValue("已欠费 31"), null))
check("null / undefined / 空串 → null（读不到）", () => {
  assert.equal(parsePointsValue(null), null)
  assert.equal(parsePointsValue(undefined), null)
  assert.equal(parsePointsValue(""), null)
  assert.equal(parsePointsValue("   "), null)
})
check("NaN / true / 对象 → null", () => {
  assert.equal(parsePointsValue(Number.NaN), null)
  assert.equal(parsePointsValue(true), null)
  assert.equal(parsePointsValue({}), null)
})

// ══ 二、上游给负数 → 窗口 0 + 文案「已欠费 N」 ═════════════════════════

console.log("\n上游给负数（欠费）")

for (const [label, data, expectDebt] of [
  ["number -31", { total_points: -31, expiring_quota_details: [] }, 31],
  ['字符串 "-153 积分"', { total_points: "-153 积分", expiring_quota_details: [] }, 153],
  ['Unicode "-32"（U+2212）', { total_points: "−32", expiring_quota_details: [] }, 32],
]) {
  await checkAsync(`${label} → 已欠费 ${expectDebt} 积分`, async () => {
    const u = usageWithData(data)
    try {
      const out = await u.hook(auth)
      const w = out.windows.find((x) => x.name === "积分余额")

      assert.ok(w, "要有「积分余额」窗口")
      // ① 数值位永远是 0，不是负数
      assert.equal(w.balance, 0, `窗口 balance 必须钳到 0，实际 ${w.balance}`)
      assert.ok(w.balance >= 0 && Number.isFinite(w.balance))
      // ② 文案说清是欠费
      assert.equal(w.display, `已欠费 ${expectDebt} 积分`)
      assert.equal(out.balance, `已欠费 ${expectDebt} 积分`)
      assert.equal(out.plan, "已欠费")
      // ③ 欠费也要报 resetsAt（宿主据此睡到下一次补充积分，别一分钟一醒）
      assert.ok(w.resetsAt, "欠费同样要报 resetsAt")
      assert.ok(Date.parse(w.resetsAt) > Date.now(), `resetsAt 要在未来: ${w.resetsAt}`)
      // ④ 用户可见的每一段文案里都不许出现负号
      for (const s of visibleStrings(out)) {
        assert.ok(!/[-−–—－]/.test(s), `文案里不该有负号：「${s}」`)
      }
      // ⑤ 欠费不是「积分制」，也别落回「已耗尽」
      assert.notEqual(out.plan, "积分制")
      assert.notEqual(out.plan, "已耗尽")
    } finally {
      u.restore()
    }
  })
}

await checkAsync("欠费时不出「今日 / 限时 / 永久」那几行（余额 0，批次没意义）", async () => {
  const u = usageWithData({
    total_points: -1,
    expiring_quota_details: [{ remaining_points: 0, expires_at: "2026-10-30 23:59:59" }],
  })
  try {
    const out = await u.hook(auth)
    assert.deepEqual(out.windows.map((x) => x.name), ["积分余额"])
  } finally {
    u.restore()
  }
})

// ══ 三、读不到 ≠ 0 ═════════════════════════════════════════════════════

console.log("\n读不到（缺字段 / null）—— 不许谎报「已耗尽」")

for (const [label, data] of [
  ["字段整个缺失", { expiring_quota_details: [] }],
  ["total_points: null", { total_points: null, expiring_quota_details: [] }],
  ["total_points 不是数字", { total_points: "暂无", expiring_quota_details: [] }],
]) {
  await checkAsync(`${label} → error，且没有「积分余额」窗口`, async () => {
    const u = usageWithData(data)
    try {
      const out = await u.hook(auth)
      assert.ok(out.error, `应该带 error，实际 ${JSON.stringify(out)}`)
      assert.ok(!out.balance, "读不到时不报余额")
      assert.ok(!(out.windows ?? []).some((w) => w.name === "积分余额"), "不许伪造一条「已耗尽」")
    } finally {
      u.restore()
    }
  })
}

// ══ 四、0 与正数：老行为不变 ═══════════════════════════════════════════

console.log("\n0 与正数：老行为不能被这次改动带偏")

await checkAsync("total=0 → 「已耗尽」、balance 0、plan 已耗尽、有 resetsAt", async () => {
  const u = usageWithData({ total_points: 0, expiring_quota_details: [] })
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    assert.equal(w.balance, 0)
    assert.equal(w.display, "已耗尽")
    assert.equal(out.plan, "已耗尽")
    assert.equal(out.balance, "0 积分")
    assert.ok(w.resetsAt, "0 也要报 resetsAt")
    assert.equal(w.runsOutAt, undefined)
  } finally {
    u.restore()
  }
})

await checkAsync("total=107 → 「107 积分」、plan 积分制、没有 resetsAt", async () => {
  const u = usageWithData({ total_points: 107, expiring_quota_details: [] })
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    assert.equal(w.balance, 107)
    assert.equal(w.display, "107 积分")
    assert.equal(out.balance, "107 积分")
    assert.equal(out.plan, "积分制")
    assert.equal(w.resetsAt, undefined, "有余额时不该报 resetsAt")
  } finally {
    u.restore()
  }
})

await checkAsync('字符串 "1,234 积分" → 1,234 积分（千分位不会解析成 1）', async () => {
  const u = usageWithData({ total_points: "1,234 积分", expiring_quota_details: [] })
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    assert.equal(w.balance, 1234)
    assert.equal(w.display, "1,234 积分")
  } finally {
    u.restore()
  }
})

await checkAsync("有余额 + 今日批次 → runsOutAt 照旧（批次字段也走同一个解析器）", async () => {
  const u = usageWithData({
    total_points: "100 积分",
    expiring_quota_details: [{ remaining_points: "50 积分", expires_at: "2026-10-30 23:59:59" }],
  })
  try {
    const out = await u.hook(auth)
    const w = out.windows.find((x) => x.name === "积分余额")
    assert.equal(w.balance, 100)
    assert.ok(w.runsOutAt, "有批次到期就该报 runsOutAt")
    assert.equal(w.runsOut, 50)
  } finally {
    u.restore()
  }
})

// ══ 五、签到报告：也别把负数甩给用户 ═══════════════════════════════════

console.log("\n签到报告（runCheckin）")

/**
 * 签到的假上游：积分读两次（before / after），登录礼一个结果，新手任务全已领完
 * （这样不会走到 autoFirstChat —— 那条会真的发消息花钱）。
 */
function checkinFetch({ pointsSeq, granted = false, giftPoints = 0 }) {
  const orig = globalThis.fetch
  let i = 0
  globalThis.fetch = async (url, opt) => {
    const u = String(url)
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    if (u.includes("/api/v1/quota/points/total")) {
      const v = pointsSeq[Math.min(i, pointsSeq.length - 1)]
      i++
      return json({ code: 1000, message: "ok", data: { total_points: v, expiring_quota_details: [] } })
    }
    if (u.includes("/api/v1/login-gift")) return json({ code: 1000, data: { granted, point_amount: giftPoints } })
    if (u.includes("/api/v1/onboarding/tasks")) {
      return json({
        code: 1000,
        data: { tasks: [{ code: "t1", title: "已完成的任务", points: 10, status: "COMPLETED", reward_status: "GRANTED" }] },
      })
    }
    return orig(url, opt)
  }
  return { restore: () => { globalThis.fetch = orig } }
}

const checkinAuth = { jwt: "x".repeat(350), org: "acc1", host: SITES.cn.host }

await checkAsync("余额 -32 → 签到报告写「已欠费 32 积分（本次无变动）」，不出现 -32", async () => {
  const { runCheckin } = await import("../src/tasks.mjs")
  const env = checkinFetch({ pointsSeq: [-32, -32], granted: false })
  try {
    const r = await runCheckin(checkinAuth)
    assert.ok(r.message.startsWith("已欠费 32 积分（本次无变动）"), `实际：${r.message}`)
    assert.ok(!/-\d/.test(r.message), `报告里不该有负数：${r.message}`)
    assert.equal(r.outcome, "done")
  } finally {
    env.restore()
  }
})

await checkAsync("余额 -32 → 168（领到 200）→「积分 +200（已欠费 32 → 168）」", async () => {
  const { runCheckin } = await import("../src/tasks.mjs")
  const env = checkinFetch({ pointsSeq: [-32, 168], granted: true, giftPoints: 200 })
  try {
    const r = await runCheckin(checkinAuth)
    assert.ok(r.message.startsWith("积分 +200（已欠费 32 → 168）"), `实际：${r.message}`)
    assert.equal(r.credit, 200)
    assert.ok(!/-\d/.test(r.message), `报告里不该有负数：${r.message}`)
  } finally {
    env.restore()
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