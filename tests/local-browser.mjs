// 「从本机浏览器读登录态」的解析与归属。
//
//   node tests/local-browser.mjs
//
// 全程在临时 HOME / LOCALAPPDATA 里跑，不读真实的 Edge/Chrome 数据。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fake = mkdtempSync(join(tmpdir(), "magicrew-local-test-"))
process.env.USERPROFILE = fake
process.env.HOME = fake
process.env.LOCALAPPDATA = fake // Windows 的 roots() 先用它

let failed = 0
const ok = (cond, label, extra = "") => {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failed++
}

const { readLocalCreds, _internal } = await import("../src/local-browser.mjs")
const { noteOrg, readKnownOrgs } = await import("../src/store.mjs")

/** 造一把形状合法的 jwt（只用于解析 iat/exp，不会被验证） */
const mkJwt = (iat, exp) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ iat, exp })).toString("base64url")}.c2ln`

/** 造一条 Chromium localStorage 记录：origin 前缀 + key + value */
const rec = (host, key, value) => `_https://${host}\x00\x01${key}\x00\x01"key":"${key}","value":"${value}"`

const JWT_CN = mkJwt(1793000000, 1795600000)
const JWT_INTL = mkJwt(1793100000, 1795700000)

console.log("═══ ① 两个站点在同一文件里也不能串号 ═══")
{
  // 国内站与国际站的记录**紧挨着**（用户两个都登录过）
  const text =
    rec("www.letsmagic.cn", "authorization", JWT_CN) +
    rec("www.letsmagic.cn", "organizationCode", "") +
    rec("www.letsmagic.cn", "organizationCode2", "orgcn1234567") +
    rec("www.magicrew.ai", "authorization", JWT_INTL) +
    rec("www.magicrew.ai", "organizationCode2", "orgintl12345")

  const cn = _internal.credsNear(text, "www.letsmagic.cn")
  const intl = _internal.credsNear(text, "www.magicrew.ai")
  ok(cn.length === 1 && cn[0].org === "orgcn1234567", "国内站只拿到自己的 org", JSON.stringify(cn.map((x) => x.org)))
  ok(intl.length === 1 && intl[0].org === "orgintl12345", "国际站只拿到自己的 org", JSON.stringify(intl.map((x) => x.org)))
  ok(cn[0]?.jwt === JWT_CN && intl[0]?.jwt === JWT_INTL, "jwt 也对得上")
}

console.log("\n═══ ② 空组织码、过期凭据都不算 ═══")
{
  const text =
    rec("www.letsmagic.cn", "authorization", mkJwt(1793000000, 1000)) + // 早就过期
    rec("www.letsmagic.cn", "organizationCode2", "orgooooold1")
  ok(_internal.credsNear(text, "www.letsmagic.cn").length === 1, "解析层拿到 1 条（过期与否在 readLocalCreds 里判）")

  // 直接验 readLocalCreds 的过期过滤：在临时浏览器目录里落一份过期记录
  const dir = join(fake, "Microsoft", "Edge", "User Data", "Default", "Local Storage", "leveldb")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "000003.log"), text)
  ok(readLocalCreds("www.letsmagic.cn") === null, "只有过期 jwt → 返回 null")

  // 换成有效凭据，并且放两把（旧的 + 新的）—— 必须取 iat 大的那把
  const older = mkJwt(1793000000, 1795600000)
  const newer = mkJwt(1793500000, 1796100000)
  writeFileSync(
    join(dir, "000004.log"),
    rec("www.letsmagic.cn", "authorization", older) +
      rec("www.letsmagic.cn", "organizationCode2", "orgolder1234") +
      rec("www.letsmagic.cn", "authorization", newer) +
      rec("www.letsmagic.cn", "organizationCode2", "orgnewer1234"),
  )
  const got = readLocalCreds("www.letsmagic.cn")
  ok(got?.jwt === newer, "多把凭据时取 iat 最大的")
  ok(got?.org === "orgnewer1234", "org 跟着那把走", got?.org)
  ok(got?.browser === "Edge", "报出是哪个浏览器读到的", got?.browser)
  ok(readLocalCreds("www.magicrew.ai") === null, "另一个站点读不到（不会借用国内站的凭据）")
}

console.log("\n═══ ③ 没有浏览器数据时安静返回 null ═══")
{
  const empty = mkdtempSync(join(tmpdir(), "magicrew-local-empty-"))
  const saved = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = empty
  process.env.USERPROFILE = empty
  const r = readLocalCreds("www.letsmagic.cn")
  ok(r === null, "空目录 → null（调用方据此降级到窗口登录）")
  process.env.LOCALAPPDATA = saved
  process.env.USERPROFILE = fake
  rmSync(empty, { recursive: true, force: true })
}

console.log("\n═══ ④ 已加过的账号记在本地，避免重复自动接 ═══")
{
  ok(readKnownOrgs("magicrew").length === 0, "初始为空")
  noteOrg("magicrew", "orgcn1234567")
  noteOrg("magicrew", "orgcn1234567")
  noteOrg("magicrew", "orgintl12345")
  const list = readKnownOrgs("magicrew")
  ok(list.length === 2 && list[0] === "orgcn1234567", "去重且保序", JSON.stringify(list))
  ok(readKnownOrgs("magicrew-intl").length === 0, "两个站点各记各的")
}

rmSync(fake, { recursive: true, force: true })
console.log(failed ? `\n✗ ${failed} 项失败` : "\n✓ 全部通过")
if (failed) process.exitCode = 1
