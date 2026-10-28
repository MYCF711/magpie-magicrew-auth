// 自动维护的两个功能 —— 纯离线测试
//
//   node tests/auto-maintenance.mjs
//
// 钉住：
//   ① ensureCheckinDefault：只在「用户从未设置过」时补 true，显式 false 绝不覆盖
//   ② pickSelfUpdate / noteUpdated：从 magpie 的 plugin-updates.json 认出自己，
//      并在真正更新成功后补「已自动更新」记录（徽章读的就是它）
//   ③ kick：节流、无 exe 降级、干跑、成功/失败状态
//
// 为什么值得钉：这两个功能都在 magpie 的边界上（插件默认签到是关闭的；
// 第三方插件不会被 magpie 自动更新）。写错方向就会变成「把用户关掉的签到
// 又打开」或「伪造已自动更新徽章」—— 两种都比没有功能更糟。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"

// ── 隔离 HOME（auto-maintenance 的路径都是 homedir() 拼出来的）─────────
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-auto-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
const CONFIG = join(FAKE, ".config", "magpie")
const CACHE = join(FAKE, ".cache", "magpie")
mkdirSync(CONFIG, { recursive: true })
mkdirSync(CACHE, { recursive: true })

const {
  ensureCheckinDefault,
  pickSelfUpdate,
  noteUpdated,
  readAutoState,
  findMagpieExe,
  kick,
  initAutoMaintenance,
} = await import("../src/auto-maintenance.mjs")

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
const read = (p) => JSON.parse(readFileSync(p, "utf8"))
const settingsPath = join(CONFIG, "settings.json")

// ═══ ① ensureCheckinDefault ═══════════════════════════════════════════
console.log("ensureCheckinDefault —— 只补「从未设置过」的默认值")

check("没有 settings.json → 创建并写 pluginCheckins[provider]=true", () => {
  rmSync(settingsPath, { force: true })
  const r = ensureCheckinDefault("magicrew")
  assert.equal(r.changed, true)
  const s = read(settingsPath)
  assert.equal(s.pluginCheckins.magicrew, true)
})

check("已有 magicrew=true → 不改", () => {
  writeFileSync(settingsPath, JSON.stringify({ pluginCheckins: { magicrew: true, other: false } }))
  const before = readFileSync(settingsPath, "utf8")
  const r = ensureCheckinDefault("magicrew")
  assert.equal(r.changed, false)
  assert.equal(r.reason, "explicit")
  assert.equal(readFileSync(settingsPath, "utf8"), before)
})

check("已有 magicrew=false（用户显式关掉）→ 绝不改回 true", () => {
  writeFileSync(settingsPath, JSON.stringify({ pluginCheckins: { magicrew: false } }))
  const r = ensureCheckinDefault("magicrew")
  assert.equal(r.changed, false)
  assert.equal(r.on, false)
  assert.equal(read(settingsPath).pluginCheckins.magicrew, false)
})

check("有其它 provider 的开关 → 原样保留", () => {
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", pluginCheckins: { other: true } }))
  const r = ensureCheckinDefault("magicrew")
  assert.equal(r.changed, true)
  const s = read(settingsPath)
  assert.equal(s.theme, "dark")
  assert.equal(s.pluginCheckins.other, true)
  assert.equal(s.pluginCheckins.magicrew, true)
})

check("settings.json 坏了 → 不覆盖（宁可没功能，也不毁用户配置）", () => {
  writeFileSync(settingsPath, "{not json")
  const before = readFileSync(settingsPath, "utf8")
  const r = ensureCheckinDefault("magicrew")
  assert.equal(r.changed, false)
  assert.equal(r.reason, "settings-unreadable")
  assert.equal(readFileSync(settingsPath, "utf8"), before)
})

// ═══ ② pickSelfUpdate / noteUpdated ═══════════════════════════════════
console.log("\npickSelfUpdate / noteUpdated —— 只认自己，不伪造")

check("waiting 里有 Magicrew + git=true → 命中", () => {
  const w = pickSelfUpdate([
    { package: "Other", git: true, version: "a", latest: "b" },
    { package: "Magicrew", git: true, version: "272b812", latest: "050b0f4" },
  ])
  assert.equal(w.latest, "050b0f4")
})

check("Magicrew 的 npm 源条目（git=false）→ 不命中", () => {
  assert.equal(pickSelfUpdate([{ package: "Magicrew", git: false, version: "0.3.29", latest: "0.3.30" }]), null)
})

check("waiting 不是数组 → null", () => {
  assert.equal(pickSelfUpdate(null), null)
  assert.equal(pickSelfUpdate({}), null)
})

check("noteUpdated 追加到 updated[]，保留已有记录", () => {
  const p = join(CONFIG, "plugin-updates.json")
  writeFileSync(p, JSON.stringify({ checked: "x", waiting: [], updated: [{ package: "Other", from: "1", to: "2", at: "2026-10-01T00:00:00Z" }] }))
  assert.equal(noteUpdated("Magicrew", "272b812", "050b0f4"), true)
  const u = read(p)
  assert.equal(u.updated.length, 2)
  assert.equal(u.updated[1].package, "Magicrew")
  assert.equal(u.updated[1].from, "272b812")
  assert.equal(u.updated[1].to, "050b0f4")
})

check("同一次更新 24 小时内不重复写", () => {
  const p = join(CONFIG, "plugin-updates.json")
  const before = read(p).updated.length
  noteUpdated("Magicrew", "272b812", "050b0f4")
  assert.equal(read(p).updated.length, before)
})

check("超过 20 条只留最后 20 条", () => {
  const p = join(CONFIG, "plugin-updates.json")
  const many = Array.from({ length: 25 }, (_, i) => ({ package: "P" + i, from: "1", to: "2", at: "2026-10-01T00:00:00Z" }))
  writeFileSync(p, JSON.stringify({ updated: many }))
  noteUpdated("Magicrew", "a", "b")
  assert.equal(read(p).updated.length, 20)
})

// ═══ ③ findMagpieExe ══════════════════════════════════════════════════
console.log("\nfindMagpieExe —— 环境变量优先，找不到返回空")

check("MAGPIE_EXE 指向存在的文件 → 直接用它", () => {
  const exe = join(FAKE, "magpie-fake.exe")
  writeFileSync(exe, "")
  assert.equal(findMagpieExe({ env: { MAGPIE_EXE: exe } }), exe)
})

check("都不存在 → 返回空串（不硬编码本机路径）", () => {
  assert.equal(findMagpieExe({ env: {}, ppid: 999999, platform: "linux" }), "")
})

// ═══ ④ kick ═══════════════════════════════════════════════════════════
console.log("\nkick —— 节流 / 降级 / 成功记录")

function seedUpdates(waiting) {
  writeFileSync(join(CONFIG, "plugin-updates.json"), JSON.stringify({ checked: "x", waiting, updated: [] }))
}
function seedState(site, state) {
  writeFileSync(join(CACHE, `magicrew-auto-${site}.json`), JSON.stringify(state))
}
const waiting = [{ package: "Magicrew", git: true, version: "272b812", latest: "050b0f4" }]

await checkAsync("没有自己的更新 → no-update", async () => {
  seedUpdates([])
  const r = await kick({ id: "kick0" }, { dir: CONFIG, cacheDir: CACHE, exe: "" })
  assert.equal(r.skipped, "no-update")
})

await checkAsync("有更新但找不到 magpie exe → no-magpie-exe，并记录状态", async () => {
  seedUpdates(waiting)
  seedState("kick1", {})
  const r = await kick({ id: "kick1" }, { dir: CONFIG, cacheDir: CACHE, exe: "" })
  assert.equal(r.skipped, "no-magpie-exe")
  assert.equal(readAutoState("kick1", { cacheDir: CACHE }).reason, "no-magpie-exe")
})

await checkAsync("已在 6 小时内失败过同一版本 → throttled", async () => {
  seedUpdates(waiting)
  seedState("kick2", { lastAttempt: Date.now() - 1000, latest: "050b0f4", reason: "exit-1" })
  const r = await kick({ id: "kick2" }, { dir: CONFIG, cacheDir: CACHE, exe: "/fake" })
  assert.equal(r.skipped, "throttled")
})

await checkAsync("已成功更新过同版本 → done", async () => {
  seedUpdates(waiting)
  seedState("kick3", { done: { from: "272b812", to: "050b0f4", at: "2026-10-29T00:00:00Z" } })
  const r = await kick({ id: "kick3" }, { dir: CONFIG, cacheDir: CACHE, exe: "/fake" })
  assert.equal(r.skipped, "done")
})

await checkAsync("dryRun → 只返回 wouldRun，不 spawn", async () => {
  seedUpdates(waiting)
  seedState("kick4", {})
  let called = false
  const r = await kick({ id: "kick4" }, {
    dir: CONFIG, cacheDir: CACHE, exe: "/fake-magpie", dryRun: true,
    spawnFn: () => { called = true; return new EventEmitter() },
  })
  assert.equal(r.wouldRun, "/fake-magpie")
  assert.equal(called, false)
})

await checkAsync("spawn 成功退出 0 → 写 updated[] 与 done 状态", async () => {
  seedUpdates(waiting)
  seedState("kick5", {})
  const child = new EventEmitter()
  child.unref = () => {}
  let spawned = null
  const r = await kick({ id: "kick5" }, {
    dir: CONFIG, cacheDir: CACHE, exe: "/fake-magpie",
    spawnFn: (exe, args, opts) => {
      spawned = { exe, args, opts }
      process.nextTick(() => child.emit("exit", 0))
      return child
    },
  })
  assert.equal(r.started, true)
  assert.equal(spawned.exe, "/fake-magpie")
  assert.deepEqual(spawned.args, ["plugin", "update"])
  await new Promise((res) => setTimeout(res, 20))
  const u = read(join(CONFIG, "plugin-updates.json"))
  const mine = u.updated.find((x) => x.package === "Magicrew" && x.to === "050b0f4")
  assert.ok(mine)
  assert.equal(readAutoState("kick5", { cacheDir: CACHE }).done.to, "050b0f4")
})

// ═══ ⑤ initAutoMaintenance ════════════════════════════════════════════
console.log("\ninitAutoMaintenance —— config 时补默认签到")

await checkAsync("设置里没有该 provider → 补 true", async () => {
  rmSync(settingsPath, { force: true })
  initAutoMaintenance({ PROVIDER: "magicrew-intl", id: "magicrew-intl" })
  assert.equal(read(settingsPath).pluginCheckins["magicrew-intl"], true)
})

// ── 收尾 ───────────────────────────────────────────────────────────────
for (const k of ["HOME", "USERPROFILE"]) {
  if (ORIG[k] === undefined) delete process.env[k]
  else process.env[k] = ORIG[k]
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
