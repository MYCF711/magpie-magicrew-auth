// 看新手福利八项现在什么状态
//   node tools/onboarding-status.mjs
//   MAGICREW_JWT=... MAGICREW_ORG=... node tools/onboarding-status.mjs
//   node tools/onboarding-status.mjs --intl

import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { SITES, fetchOnboardingTasks, fetchPoints } from "../src/api.mjs"

const EDGE_DIR = join(homedir(), "AppData/Local/Microsoft/Edge/User Data/Default/Local Storage/leveldb")

function fromEdge() {
  let jwt = "", org = "", best = 0
  for (const f of readdirSync(EDGE_DIR)) {
    let d
    try { d = readFileSync(EDGE_DIR + "/" + f) } catch { continue }
    const s = d.toString("latin1")
    if (!s.includes("letsmagic") && !s.includes("magicrew")) continue
    for (const m of s.matchAll(/"key":"authorization","value":"([^"]+)"/g)) {
      const t = m[1]; let i = 0
      try { i = JSON.parse(Buffer.from(t.split(".")[1], "base64").toString()).iat || 0 } catch {}
      if (i >= best) { best = i; jwt = t }
    }
    for (const m of s.matchAll(/"key":"organizationCode2?","value":"([^"]*)"/g)) if (m[1]) org = m[1]
  }
  return { jwt, org }
}

const cred = process.env.MAGICREW_JWT
  ? { jwt: process.env.MAGICREW_JWT, org: process.env.MAGICREW_ORG || "" }
  : fromEdge()
if (!cred.jwt) { console.error("没有凭据"); process.exit(1) }

const siteId = process.argv.includes("--intl") ? "intl" : "cn"
const host = SITES[siteId].host

const tasks = await fetchOnboardingTasks(cred.jwt, cred.org, host)
const p = await fetchPoints(cred.jwt, cred.org, host)

console.log(`站点：${SITES[siteId].label}`)
console.log(`积分：${p.total}\n`)

let got = 0, left = 0
for (const t of tasks) {
  const done = t.status === "COMPLETED" || t.rewardStatus === "GRANTED"
  if (done) got += t.points; else left += t.points
  console.log(`${done ? "✅" : "▫️"} ${t.code.padEnd(20)} ${String(t.points).padStart(3)} 分  ${done ? "已到账" : "未完成"}${t.completedAt ? "  " + t.completedAt : ""}`)
}
console.log(`\n已拿 ${got} 分，还剩 ${left} 分`)
