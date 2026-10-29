// 自测：不依赖 magpie，直接跑钩子。
//
//   node tests/smoke.mjs              # 只跑不花钱的（config / models / usage）
//   node tests/smoke.mjs full         # 加上签到探测（会真的打接口）
//
// 凭据来源（按优先级）：
//   1. 环境变量 MAGICREW_JWT + MAGICREW_ORG
//   2. 本机 Edge 的 localStorage（key `MAGIC:user:authorization`）

import { homedir } from "node:os"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const EDGE_DIR = join(homedir(), "AppData/Local/Microsoft/Edge/User Data/Default/Local Storage/leveldb")

function fromEdge() {
  let jwt = ""
  let org = ""
  let best = 0
  let files
  try {
    files = readdirSync(EDGE_DIR)
  } catch {
    // 非 Windows / 本机没装 Edge：这是「没有凭据」，不是测试崩溃。
    return { jwt, org }
  }
  for (const f of files) {
    let d
    try {
      d = readFileSync(join(EDGE_DIR, f))
    } catch {
      continue
    }
    const s = d.toString("latin1")
    if (!s.includes("letsmagic")) continue
    for (const m of s.matchAll(/"key":"authorization","value":"([^"]+)"/g)) {
      const t = m[1]
      let iat = 0
      try {
        const p = t.split(".")[1]
        iat = JSON.parse(Buffer.from(p, "base64").toString()).iat || 0
      } catch {}
      if (iat >= best) {
        best = iat
        jwt = t
      }
    }
    // 站点存了好几条 organizationCode，其中一条是空串；只取非空的
    for (const m of s.matchAll(/"key":"organizationCode2?","value":"([^"]*)"/g)) {
      if (m[1]) org = m[1]
    }
  }
  return { jwt, org }
}

const env = process.env.MAGICREW_JWT
  ? { jwt: process.env.MAGICREW_JWT, org: process.env.MAGICREW_ORG || "" }
  : fromEdge()

const { MagicrewAuthPlugin } = await import("../index.mjs")
const { issueGatewayKey } = await import("../src/api.mjs")

const plugin = await MagicrewAuthPlugin(
  { client: { app: { log: () => {} } }, directory: process.env.TEMP || "." },
  {},
)

// ① config
const cfg = {}
await plugin.config(cfg)
const prov = cfg.provider?.magicrew
const modelCount = Object.keys(prov?.models ?? {}).length
console.log("① config:", prov ? `provider ok, ${modelCount} models, api=${prov.api}` : "FAILED")
if (modelCount !== 27) console.log("  ⚠ 期望 27 个模型，实际", modelCount)

if (!env.jwt) {
  console.log("没有凭据，后面的跳过。设 MAGICREW_JWT / MAGICREW_ORG 再来。")
  process.exit(modelCount === 27 ? 0 : 1)
}

// 用真 JWT 换一把网关密钥，拼出 magpie 那份 auth 对象
const key = await issueGatewayKey(env.jwt, env.org)
const auth = {
  type: "oauth",
  access: key.apiKey,
  refresh: key.refreshToken,
  expires: Date.now() + 2 * 3600_000,
  accountId: "smoke",
  jwt: env.jwt,
  org: env.org,
}
const getAuth = async () => auth

// ③ refresh（会轮换 refresh_token，拿返回值就行，不写回）
const renewed = await plugin.auth.refresh({ ...auth }, {})
console.log("③ refresh:", renewed?.access ? `ok (new key ${String(renewed.access).slice(0, 8)}…, rotated=${renewed.refresh !== auth.refresh})` : "FAILED")

// ④ loader
const loader = await plugin.auth.loader(getAuth, {})
console.log("④ loader:", loader.baseURL === "https://i-magic-service.letsmagic.cn/v1" ? "ok" : `FAILED ${loader.baseURL}`)

// ⑤ 一次真实对话（走 loader 的 fetch，验证 max_tokens 抬升与流式都活）
try {
  const body = JSON.stringify({
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "只回答两个字：收到" }],
    max_tokens: 8,
    stream: false,
  })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.access}` },
    body,
  })
  const j = await res.json()
  const msg = j?.choices?.[0]?.message
  console.log(
    "⑤ chat:",
    res.status,
    "| content=", JSON.stringify(msg?.content?.slice(0, 20) ?? null),
    "| usage=", JSON.stringify(j?.usage?.total_tokens ?? null),
    "| max_tokens 抬升到 512 =>", !!msg?.content,
  )
} catch (e) {
  console.log("⑤ chat FAILED:", String(e?.message ?? e))
}

// ⑥ usage
const u = await plugin.auth.usage(getAuth, {})
console.log("⑥ usage:", u.error ? `FAILED ${u.error}` : `plan=${u.plan} balance=${u.balance}`)

// ⑦ models（每账号目录）
const list = await plugin.provider.models({}, { auth })
console.log("⑦ models:", Object.keys(list).length, "个 |", Object.keys(list).slice(0, 4).join(", "))

// ⑧ checkin（只在 full 模式跑，它会真的打接口）
if (process.argv.includes("full")) {
  const c = await plugin.auth.checkin(getAuth, {})
  console.log("⑧ checkin:", JSON.stringify(c))
} else {
  console.log("⑧ checkin: 跳过（加 full 参数才跑）")
}
