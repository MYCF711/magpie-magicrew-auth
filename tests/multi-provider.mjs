// 双供应商验证：一个包两个插件，各自独立。
//
//   node tests/multi-provider.mjs
//
// 凭据（国际站）：MAGICREW_INTL_JWT / MAGICREW_INTL_ORG
//                没有就从 _probe/.gwkey 那种临时文件读
//
// 这个脚本不打真模型请求（不花钱），只验四件事：
//   ① 两个插件声明的 provider id 不同
//   ② 各自的模型目录各拉各的（国内 27 / 国际 49）
//   ③ 各自的 usage 各读各的积分
//   ④ loader 拼出来的头：国际站带 organization-code，国内站不带

import { readFileSync, existsSync } from "node:fs"
import { MagicrewAuthPlugin, MagicrewIntlAuthPlugin, _internal } from "../index.mjs"

const { SITES } = _internal

function credentialsOf(siteId) {
  const envJwt = process.env[`MAGICREW_${siteId === "cn" ? "CN" : "INTL"}_JWT`]
  const envOrg = process.env[`MAGICREW_${siteId === "cn" ? "CN" : "INTL"}_ORG`]
  if (envJwt && envOrg) return { jwt: envJwt, org: envOrg }
  const probe = new URL("../_probe/", import.meta.url)
  const f = new URL(".probe-creds.json", probe)
  if (existsSync(f)) {
    const all = JSON.parse(readFileSync(f, "utf8"))
    if (all[siteId]) return all[siteId]
  }
  return null
}

/** 把一个插件跑起来，返回它的钩子包 */
async function boot(factory) {
  const ctx = await factory({ client: null, directory: "." })
  return ctx
}

const cases = [
  ["国内", MagicrewAuthPlugin, "cn"],
  ["国际", MagicrewIntlAuthPlugin, "intl"],
]

let failures = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`)
  if (!cond) failures++
}

console.log("═══ ① provider 声明 ═══")
const seen = new Set()
for (const [label, factory, siteId] of cases) {
  const ctx = await boot(factory)
  const cfg = {}
  await ctx.config(cfg)
  const ids = Object.keys(cfg.provider)
  console.log(`  ${label}: ${JSON.stringify(ids)}  api=${cfg.provider[ids[0]]?.api}`)
  ok(ids.length === 1 && ids[0] === SITES[siteId].id, `${label} 只声明 ${SITES[siteId].id}`)
  ok(ctx.auth.provider === SITES[siteId].id, `${label} auth.provider = ${ctx.auth.provider}`)
  ok(ctx.provider.id === SITES[siteId].id, `${label} provider.id = ${ctx.provider.id}`)
  ok(!seen.has(ids[0]), `provider id 不与前一个重复：${ids[0]}`)
  seen.add(ids[0])
}
ok(seen.size === 2, `一共 2 个不同的 provider（实得 ${seen.size}）`)

console.log("\n═══ ② 模型目录各拉各的 ═══")
for (const [label, factory, siteId] of cases) {
  const ctx = await boot(factory)
  const creds = credentialsOf(siteId)
  if (!creds) {
    console.log(`  ${label}: 无凭据，跳过（未验证）`)
    continue
  }
  const auth = { type: "oauth", access: "x", jwt: creds.jwt, org: creds.org }
  try {
    const ms = await ctx.provider.models({}, { auth })
    const n = Object.keys(ms).length
    console.log(`  ${label}: ${n} 个模型，示例 ${Object.keys(ms).slice(0, 3).join(", ")}`)
    ok(n > 0, `${label} 拉到模型`)
  } catch (e) {
    ok(false, `${label} 拉模型失败：${e?.message ?? e}`)
  }
}

console.log("\n═══ ③ usage 各读各的积分 ═══")
for (const [label, factory, siteId] of cases) {
  const ctx = await boot(factory)
  const creds = credentialsOf(siteId)
  if (!creds) {
    console.log(`  ${label}: 无凭据，跳过（未验证）`)
    continue
  }
  const auth = { type: "oauth", access: "x", jwt: creds.jwt, org: creds.org }
  const u = await ctx.auth.usage(async () => auth)
  console.log(`  ${label}: plan=${u.plan} balance=${u.balance}${u.error ? ` error=${u.error}` : ""}`)
  ok(!u.error, `${label} usage 无错`)
}

console.log("\n═══ ④ loader 拼出来的头 ═══")
for (const [label, factory, siteId] of cases) {
  const ctx = await boot(factory)
  const auth = {
    type: "oauth",
    access: "mgw_test_key",
    jwt: "x",
    org: "orgcode67890",
  }
  let captured = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url, headers: init.headers, body: init.body }
    return new Response("{}", { status: 200 })
  }
  try {
    const l = await ctx.auth.loader(async () => auth)
    await l.fetch(`${l.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 64 }),
    })
  } finally {
    globalThis.fetch = realFetch
  }
  const hasOrg = !!captured?.headers?.["organization-code"]
  const expectOrg = !!SITES[siteId].needsOrgOnGateway
  console.log(
    `  ${label}: baseURL=${SITES[siteId].host}/v1  organization-code=${captured?.headers?.["organization-code"] ?? "(无)"}  max_tokens=${JSON.parse(captured?.body ?? "{}").max_tokens}`,
  )
  ok(hasOrg === expectOrg, `${label} organization-code ${expectOrg ? "必须带" : "不该带"}`)
  ok(JSON.parse(captured?.body ?? "{}").max_tokens === 512, `${label} max_tokens 抬到 512`)
}

console.log(`\n${failures ? `✗ ${failures} 项失败` : "✓ 全部通过"}`)
process.exit(failures ? 1 : 0)
