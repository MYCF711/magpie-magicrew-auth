// 从**本机浏览器的 localStorage** 里读 magicrew 登录态 —— 不开窗口、不让用户粘任何东西。
//
// ═══ 为什么需要这条路 ═══════════════════════════════════════════════
//
// magicrew 没有 OAuth 回调通道（见 docs/internals.md 第九节），所以「用户在网页上
// 登录成功」这件事，插件原本只能靠「自己起的那个浏览器」知道。于是有一个反复被报的
// 现象：**用户在自己浏览器里登好了，插件里却没有多出账号** —— 因为那是另一个浏览器。
//
// 但凭据其实就躺在本地：Chromium 系（Edge / Chrome / Brave）把 localStorage 明文写在
//
//     <User Data>/<Default|Profile N>/Local Storage/leveldb/*.log|*.ldb
//
// 里，key 是 `_<origin>\x00\x01<name>`，值是 JSON。直接读文件就行，不用 CDP、不用开窗口。
//
// 读法：把 leveldb 目录按 latin1 拼成文本 → 以站点 host 出现的位置开一个窗口 →
// 在同一个窗口里找 `"key":"authorization"` 与 `"key":"organizationCode2?"`。
// LevelDB 按 key 排序，同一 origin 的记录挨在一起，所以窗口内配对是可靠的
// （实测本机 Edge：`www.letsmagic.cn` 命中、`www.magicrew.ai` 不命中，不会串）。
//
// 成本：本机 Edge 27 MB / 34 ms。全部浏览器扫一遍通常 < 300 ms。
//
// ⚠ 只读。不写文件、不改浏览器数据、不碰 cookie。

import { homedir } from "node:os"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** 同一个 origin 的若干条记录（theme / i18n / userInfo / authorization …）挤在一起，
 *  2000 字节足够覆盖到 organizationCode；太小会漏、太大可能跨到另一个站点 */
const WINDOW = 2000

/** 各平台的浏览器 User Data 根目录；不存在就跳过 */
function roots() {
  const h = homedir()
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(h, "AppData", "Local")
    const roaming = process.env.APPDATA || join(h, "AppData", "Roaming")
    return [
      // ── 国际主流 ──
      ["Edge", join(local, "Microsoft", "Edge", "User Data")],
      ["Chrome", join(local, "Google", "Chrome", "User Data")],
      ["Brave", join(local, "BraveSoftware", "Brave-Browser", "User Data")],
      ["Chromium", join(local, "Chromium", "User Data")],
      ["Vivaldi", join(local, "Vivaldi", "User Data")],
      // ── 国产 Chromium 系 ──
      // ⚠ 2026-10-28 实测：用户日常用的是 360 极速浏览器 X（360ChromeX），
      //   它的 localStorage 里确实有 www.letsmagic.cn 的记录。
      //   不加这一行，「本机浏览器已登录就直接认」这条首选路径对它永远不生效 ——
      //   用户明明在网页上登着，插件却还要他再登一次。
      ["360极速浏览器X", join(local, "360ChromeX", "Chrome", "User Data")],
      ["360浏览器", join(local, "360Chrome", "Chrome", "User Data")],
      ["360安全浏览器", join(roaming, "secoresdk", "360se6", "User Data")],
      ["QQ浏览器", join(local, "Tencent", "QQBrowser", "User Data")],
      ["搜狗浏览器", join(local, "SogouExplorer", "User Data")],
      ["2345浏览器", join(local, "2345Explorer", "User Data")],
      ["猎豹浏览器", join(local, "liebao", "User Data")],
      ["UC浏览器", join(local, "UCBrowser", "User Data")],
      ["夸克浏览器", join(local, "Quark", "User Data")],
    ]
  }
  if (process.platform === "darwin") {
    return [
      ["Chrome", join(h, "Library/Application Support/Google/Chrome")],
      ["Edge", join(h, "Library/Application Support/Microsoft Edge")],
      ["Brave", join(h, "Library/Application Support/BraveSoftware/Brave-Browser")],
      ["Chromium", join(h, "Library/Application Support/Chromium")],
      ["Vivaldi", join(h, "Library/Application Support/Vivaldi")],
    ]
  }
  return [
    ["Chrome", join(h, ".config/google-chrome")],
    ["Chromium", join(h, ".config/chromium")],
    ["Edge", join(h, ".config/microsoft-edge")],
    ["Brave", join(h, ".config/BraveSoftware/Brave-Browser")],
    ["Vivaldi", join(h, ".config/vivaldi")],
  ]
}

function profilesOf(root) {
  try {
    return readdirSync(root).filter((n) => n === "Default" || /^Profile \d+$/.test(n))
  } catch {
    return []
  }
}

function leveldbText(root, profile) {
  const dir = join(root, profile, "Local Storage", "leveldb")
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return ""
  }
  let text = ""
  for (const f of files) {
    try {
      text += readFileSync(join(dir, f)).toString("latin1")
    } catch {}
  }
  return text
}

/** jwt 里的 iat / exp；解不出来返回 0 */
function jwtTimes(jwt) {
  try {
    const body = JSON.parse(Buffer.from(String(jwt).split(".")[1] || "", "base64url").toString("utf8"))
    return { iat: Number(body.iat) || 0, exp: Number(body.exp) || 0 }
  } catch {
    return { iat: 0, exp: 0 }
  }
}

/** LevelDB 里一条记录的前缀：`_https://<origin>\x00\x01<name>` */
const ORIGIN_RE = /_https?:\/\/([^\x00\x01"\\]{4,80})\x00\x01/g

/**
 * 在 host 每一次出现的位置开窗，取窗口内同一 origin 的 jwt × org 组合。
 *
 * ⚠ 必须按 origin 截断：两个站点的记录可能相邻（用户两个都登录过），
 *   2000 字节的窗口会把国际站的 org 配到国内站的 jwt 上。
 *   截断点 = 「下一个**不同站点**的 origin」，同站点的多条记录不截断。
 */
function credsNear(text, host, win = WINDOW) {
  const bare = host.replace(/^www\./, "")
  const origins = []
  for (const m of text.matchAll(ORIGIN_RE)) origins.push({ host: m[1], at: m.index })

  const out = []
  let at = -1
  while ((at = text.indexOf(host, at + 1)) !== -1) {
    let stop = Math.min(text.length, at + win)
    for (const o of origins) {
      if (o.at > at && !o.host.includes(bare)) {
        stop = o.at
        break
      }
    }
    const w = text.slice(at, stop)
    // 每把 jwt 配**它自己后面**最近的那个组织码：
    // LevelDB 按 key 排序（authorization < organizationCode），同一批写入的挨在一起；
    // 取「窗口内第一个 org」会在同一站点存过多把凭据时配错。
    for (const m of w.matchAll(/"key":"authorization","value":"(eyJ[^"]+)"/g)) {
      const tail = w.slice(m.index)
      const org = (tail.match(/"key":"organizationCode2?","value":"([^"]+)"/) || [])[1]
      if (org) out.push({ jwt: m[1], org })
    }
  }
  return out
}

/**
 * 读本机浏览器里属于这个站点的登录态。
 *
 * @param {string} hostname 例如 `www.letsmagic.cn`
 * @returns {{jwt:string, org:string, browser:string, profile:string, host:string, iat:number} | null}
 *          取 iat 最新、且未过期的那一把；读不到返回 null（调用方降级到窗口登录）。
 */
export function readLocalCreds(hostname, { now = Date.now() } = {}) {
  const bare = String(hostname || "").trim().replace(/^www\./, "")
  if (!bare) return null
  const hosts = [hostname, bare, `www.${bare}`].filter((v, i, a) => v && a.indexOf(v) === i)

  let best = null
  for (const [browser, root] of roots()) {
    for (const profile of profilesOf(root)) {
      const text = leveldbText(root, profile)
      if (!text) continue
      for (const host of hosts) {
        for (const c of credsNear(text, host)) {
          const { iat, exp } = jwtTimes(c.jwt)
          if (!iat) continue
          if (exp && exp * 1000 < now) continue
          if (!best || iat > best.iat) best = { ...c, iat, browser, profile, host }
        }
      }
    }
  }
  return best
}

export const _internal = { roots, profilesOf, leveldbText, credsNear, jwtTimes, WINDOW }
