// 积分核对：跑完导览后确认真的到账了
//
//   node tools/points.mjs                 # 从本机 Edge 读登录态
//   MAGICREW_JWT=... MAGICREW_ORG=... node tools/points.mjs
//   node tools/points.mjs --records 10    # 连最近 10 条流水一起打
//
// 只看两个数：余额，和流水里有没有「新人引导任务奖励 / 每日登录」这类入账。

import { homedir } from "node:os"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { SITES, fetchPoints, fetchPointRecords } from "../src/api.mjs"

const EDGE_DIR = join(homedir(), "AppData/Local/Microsoft/Edge/User Data/Default/Local Storage/leveldb")

function fromEdge() {
  let jwt = ""
  let org = ""
  let best = 0
  for (const f of readdirSync(EDGE_DIR)) {
    let d
    try {
      d = readFileSync(join(EDGE_DIR, f))
    } catch {
      continue
    }
    const s = d.toString("latin1")
    if (!s.includes("letsmagic") && !s.includes("magicrew")) continue
    for (const m of s.matchAll(/"key":"authorization","value":"([^"]+)"/g)) {
      const t = m[1]
      let iat = 0
      try {
        iat = JSON.parse(Buffer.from(t.split(".")[1], "base64").toString()).iat || 0
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

const cred = process.env.MAGICREW_JWT
  ? { jwt: process.env.MAGICREW_JWT, org: process.env.MAGICREW_ORG || "" }
  : fromEdge()

if (!cred.jwt) {
  console.error("没有凭据。设 MAGICREW_JWT，或先在 Edge 里登录过。")
  process.exit(1)
}

const siteId = process.argv.includes("--intl") ? "intl" : "cn"
const host = SITES[siteId].host
const ri = process.argv.indexOf("--records")
const recordCount = ri >= 0 ? Number(process.argv[ri + 1] || 10) : 0

const p = await fetchPoints(cred.jwt, cred.org, host)
console.log(`站点：${SITES[siteId].label}（${host}）`)
// 排错工具就报原值：读不到（字段缺失 / null）要看得见，别退化成 0 骗自己
console.log(`积分余额：${p.totalKnown ? p.total : `读不到（原值 ${JSON.stringify(p.totalRaw)}）`}`)
if (p.expiring?.length) {
  console.log("会过期的额度包：")
  for (const e of p.expiring) console.log(`  ${String(e.points).padStart(7)}  ${e.expiresAt}`)
}

if (recordCount > 0) {
  // POST /api/v1/quota/points/records/queries 在云版上恒 500（试过 5 种 body），
  // 所以流水拿不到，只能靠余额变化核对。这里降级而不是崩。
  try {
    const rows = await fetchPointRecords(cred.jwt, cred.org, { pageSize: recordCount, host })
    console.log("")
    console.log("最近 " + rows.length + " 条流水：")
    for (const r of rows) {
      const detail = r?.detail ?? r?.description ?? r?.type ?? JSON.stringify(r).slice(0, 60)
      const change = r?.change ?? r?.point_change ?? r?.points ?? "?"
      const at = r?.created_at ?? r?.time ?? ""
      console.log("  " + String(at).padEnd(20) + " " + String(change).padStart(6) + "  " + String(detail).slice(0, 50))
    }
  } catch (e) {
    console.log("")
    console.log("流水接口不可用（" + (e?.message ?? e) + "）—— 用余额变化核对即可。")
  }
}
