// 显示名 = `<中文> <English>`（2026-10-31 约定）
//
//   node tests/display-names.mjs
//
// 钉住三件事，防止以后被改回「纯英文」或「直接拿 npm 包名当标题」：
//   ① 插件卡片标题（package.json 的 name）是 `超级麦吉 Magicrew`，含中文 + English + 空格；
//   ② 两个供应商的 name 是 `超级麦吉 Super Magic` / `麦吉 MagiCrew`，且**真的**进了
//      `config()` 写出的 `cfg.provider[*].name`（只改常量、没接到 config 上等于没改）；
//   ③ 显示名与 npm 包名是两回事：npm 包名仍是 `magicrew-auth`，任何显示名都不许等于它。
//
// 英文大小写的出处（改这里之前先回官网核，别凭记忆）：
//   letsmagic.cn 的 /login、/en、/workspace 三页 <title> 都是
//     `Super Magic - Lighthouse Engine Next-Gen Enterprise AI Application Engine`
//     ⇒ `Super Magic` 是**两个词**（不是 SuperMagic）。
//   magicrew.ai 的 og:site_name 是 `MagiCrew`（它的中文版 /zh 也照写 MagiCrew）。
//
// 纯离线：不联网、不读 ~/.cache，只 import 代码 + 读仓库里两个 json。

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = new URL("..", import.meta.url)
const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, ROOT)), "utf8"))

const pkg = read("package.json")
const registry = read("registry-entry.json")

const { siteCtx, SITES } = await import(new URL("../src/context.mjs", import.meta.url).href)
const { makeConfig } = await import(new URL("../src/hooks/config.mjs", import.meta.url).href)

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

const CJK = /[\u3400-\u9fff]/
const LATIN = /[A-Za-z]/
const shape = (label, v) => {
  assert.equal(typeof v, "string", `${label} 必须是字符串`)
  assert.ok(CJK.test(v), `${label} 要含中文（只写英文，用户搜中文时找不到）：${JSON.stringify(v)}`)
  assert.ok(LATIN.test(v), `${label} 要含 English（只写中文，用户搜英文时找不到）：${JSON.stringify(v)}`)
  assert.ok(/\s/.test(v), `${label} 中英文之间要有空格（没有会读成一串）：${JSON.stringify(v)}`)
}

// ═══ ① 卡片标题 ═══════════════════════════════════════════════════════
console.log("① 插件卡片标题 —— package.json 的 name")

check("就是「超级麦吉 Magicrew」", () => {
  assert.equal(pkg.name, "超级麦吉 Magicrew", `实际：${pkg.name}`)
})

check("形状是 <中文> <English>，不是 npm 包名", () => {
  shape("package.json.name", pkg.name)
  assert.notEqual(pkg.name, registry.package, "显示名不许等于 npm 包名")
  assert.ok(!/^[a-z0-9-]+$/.test(pkg.name), "不许是 npm 风格的小写包名")
})

check("npm 包名仍是 magicrew-auth（发布时注入，不受显示名影响）", () => {
  assert.equal(registry.package, "magicrew-auth")
  // publish-npm.mjs 里的常量必须和 registry 一致，否则会往另一个包名上发
  const pub = readFileSync(fileURLToPath(new URL("publish-npm.mjs", ROOT)), "utf8")
  const m = pub.match(/const NPM_NAME = "([^"]+)"/)
  assert.ok(m, "publish-npm.mjs 里要有 NPM_NAME")
  assert.equal(m[1], registry.package)
})

// ═══ ② 两个供应商的 name ═════════════════════════════════════════════
console.log("\n② 供应商 name —— config() 实际写进 cfg.provider[*].name 的那个值")

check("国内 magicrew → 超级麦吉 Super Magic", () => {
  assert.equal(siteCtx(SITES.cn).SHORT, "超级麦吉 Super Magic")
})

check("国际 magicrew-intl → 麦吉 MagiCrew", () => {
  assert.equal(siteCtx(SITES.intl).SHORT, "麦吉 MagiCrew")
})

await checkAsync("config() 真的把这两个名字写出去（不是只改了常量）", async () => {
  for (const site of [SITES.cn, SITES.intl]) {
    const cfg = {}
    await makeConfig(siteCtx(site))(cfg)
    const p = cfg.provider?.[site.id]
    assert.ok(p, `config() 没写出 provider ${site.id}`)
    assert.equal(p.name, siteCtx(site).SHORT, `${site.id} 的 name 与 SHORT 不一致`)
    shape(`${site.id} 的 name`, p.name)
  }
})

check("英文大小写照抄官网：Super Magic 是两个词，MagiCrew 是大写 C", () => {
  const names = [siteCtx(SITES.cn).SHORT, siteCtx(SITES.intl).SHORT].join(" | ")
  assert.match(names, /Super Magic/, `实际：${names}`)
  assert.doesNotMatch(names, /SuperMagic|Supermagic/, "官网写的是 Super Magic（两个词）")
  assert.match(names, /MagiCrew/, `实际：${names}`)
  assert.doesNotMatch(names, /Magicrew\b/, "国际站的官方写法是 MagiCrew（大写 C），不是 Magicrew")
})

check("供应商名不是 npm 包名 / 不是纯 id", () => {
  for (const site of [SITES.cn, SITES.intl]) {
    const n = siteCtx(site).SHORT
    assert.notEqual(n, registry.package, "不许直接显示 npm 包名")
    assert.notEqual(n, site.id, "不许直接显示 provider id")
  }
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
