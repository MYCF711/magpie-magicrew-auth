// 网关路径下「account 对不上」的兜底 —— accountFor 的三条分支
//
//   node tests/account-fallback.mjs
//
// 背景（2026-10-28 实测）：网关请求里 getAuth() 的 auth 可能不带 org，
// accountOf() 落到 "default"，于是读不到真实账号的 key 槽，只能退到
// auth.access —— 它过了 2 小时就 403，表现成 502「did not stream: token无效」。
//
// 兜底只做一半：**恰好一个真实账号**时才认它，多账号一律不猜。
// 这个文件就把那条线钉死 —— 因为猜错的后果是「拿别人的 key 扣别人的积分」，
// 不是报错，是错账。
//
// 用临时 HOME 造 key-store 文件，跑完恢复环境，不碰真实数据。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── 隔离 HOME ───────────────────────────────────────────────────────────
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-keytest-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE // Windows 上 os.homedir() 读的是这个

const { accountFor, accountOf } = await import("../src/keys.mjs")

const CACHE = join(FAKE, ".cache", "magpie")
mkdirSync(CACHE, { recursive: true })

const SITE = "magicrew"
const c = { id: SITE }
const KEY = (n) => `mgw_${String(n).repeat(30)}`

/** 造一个 key-store 文件。key 必须长得像真的（key-store 有 REAL_KEY 校验） */
function seedStore(account, { key = null, refresh = "" } = {}) {
  writeFileSync(
    join(CACHE, `magicrew-key-${SITE}__${account}.json`),
    JSON.stringify({
      current: "a",
      refreshToken: refresh,
      keys: { a: key ? { apiKey: key, expiresAt: 4102444800000 } : null, b: null },
      at: "2026-10-28T00:00:00.000Z",
    }),
  )
}

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
const clear = () => rmSync(CACHE, { recursive: true, force: true })

console.log("accountFor —— 拿不到 org 时最多只肯退一步")

check("auth 带 org → 直接用，绝不走兜底", () => {
  clear()
  mkdirSync(CACHE, { recursive: true })
  seedStore("orgA", { key: KEY(1) })
  seedStore("orgB", { key: KEY(2) })
  assert.equal(accountFor(c, { org: "orgB" }), "orgB")
})

check("auth 只有 accountId → 也直接用", () => {
  clear()
  assert.equal(accountFor(c, { accountId: "acc123" }), "acc123")
})

check("没有 org + 站点恰好 1 个真实账号 → 退到它（本次修复的主场景）", () => {
  clear()
  mkdirSync(CACHE, { recursive: true })
  seedStore("onlyone", { key: KEY(3) })
  assert.equal(accountOf({}), "default") // 前提：确实落到 default
  assert.equal(accountFor(c, {}), "onlyone")
})

check("没有 org + 该账号只有 refreshToken（还没签过 key）→ 也算真实账号", () => {
  clear()
  mkdirSync(CACHE, { recursive: true })
  seedStore("nodkey", { refresh: "r".repeat(64) })
  assert.equal(accountFor(c, {}), "nodkey")
})

check("没有 org + 空壳文件（keys 全 null、无 refreshToken）→ 不算账号", () => {
  clear()
  mkdirSync(CACHE, { recursive: true })
  seedStore("orgcode67890", {}) // 只有 shell，没有身份
  assert.equal(accountFor(c, {}), "default")
})

check("没有 org + 2 个真实账号 → 不猜，退回 default", () => {
  clear()
  mkdirSync(CACHE, { recursive: true })
  seedStore("orgA", { key: KEY(4) })
  seedStore("orgB", { key: KEY(5) })
  assert.equal(accountFor(c, {}), "default")
})

check("没有 org + 2 个真实 + 1 个空壳 → 仍然不猜（空壳不该把它变成「看起来唯一」）", () => {
  clear()
  mkdirSync(CACHE, { recursive: true })
  seedStore("orgA", { key: KEY(6) })
  seedStore("orgB", { key: KEY(7) })
  seedStore("orgcode67890", {})
  assert.equal(accountFor(c, {}), "default")
})

check("没有 org + 空壳 + 1 个真实 → 认那唯一的真实账号", () => {
  clear()
  mkdirSync(CACHE, { recursive: true })
  seedStore("realone", { key: KEY(8) })
  seedStore("orgcode67890", {})
  assert.equal(accountFor(c, {}), "realone")
})

check("没有 org + 一个文件都没有 → default（保持原行为：留给首次接管）", () => {
  clear()
  rmSync(CACHE, { recursive: true, force: true })
  assert.equal(accountFor(c, {}), "default")
})

check("不同站点互不串（intl 的账号不会被国内站认领）", () => {
  clear()
  mkdirSync(CACHE, { recursive: true })
  seedStore("cnonly", { key: KEY(9) })
  assert.equal(accountFor({ id: "magicrew" }, {}), "cnonly")
  assert.equal(accountFor({ id: "magicrew-intl" }, {}), "default")
})

// ── 收尾：恢复环境 ──────────────────────────────────────────────────────
clear()
for (const [k, v] of Object.entries(ORIG)) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
