// 每个账号一把活的 key —— A/B 双槽
//
// ═══ 两条不能破的线 ═══════════════════════════════════════════════════
//
// ① **按账号隔离**：同一个站点可以登多个账号（magpie 里就是 `magicrew` /
//    `magicrew#1` / …）。key 必须一个账号一份，否则第二个账号登录时
//    会把第一个账号的 key 覆盖掉，第一个账号从此 403。
//    账户标识用 `org`（组织码，登录后固定不变），拿不到才退回 accountId。
//
// ② **每个账号至少有一把活的**：一个账号存两槽（a / b）。
//    · 续期时把新的签到**另一个槽**再切过去，旧的留着 —— 中途出错还能切回来
//    · 当前这把被上游拒了（403）就切到另一槽
//    · 两槽都空时从 magpie 存的凭据接管一次
//
// 实测（2026-10-27）：同一账号的两把 `mgw_` key 可以同时有效，所以双槽是安全的；
// 一把 key 也能并发（6 个并发请求全成功），不需要"闲置池"。
//
// ⚠ 全插件只有这个文件是 key 的来源。magpie 的 `auth.refresh` 和 loader 都走
//   src/keys.mjs，不各自签发 —— 否则本地会分叉，说不清手里那把是不是服务端认的。

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

/** 提前多久续期。key 只活 2 小时，10 分钟够用 */
const LEAD_MS = 10 * 60_000

/** 只接受看起来像真的 key —— 测试/占位值不许落盘 */
const REAL_KEY = /^mgw_[A-Za-z0-9_-]{20,}$/

/** 账号标识净化：只留安全字符，空值给 default */
export function safeAccount(account) {
  const s = String(account || "").replace(/[^A-Za-z0-9_-]/g, "")
  return s || "default"
}

/** 一个账号一份文件 */
export function keyPath(siteId, account) {
  return join(homedir(), ".cache", "magpie", `magicrew-key-${siteId}__${safeAccount(account)}.json`)
}

function blank() {
  return { current: "a", refreshToken: "", keys: { a: null, b: null }, at: "" }
}

function normalize(v) {
  // 旧格式（单槽）：{ apiKey, refreshToken, expiresAt, at } → 迁移到 a 槽
  if (v && typeof v === "object" && typeof v.apiKey === "string" && !v.keys) {
    return {
      current: "a",
      refreshToken: String(v.refreshToken || ""),
      keys: {
        a: REAL_KEY.test(v.apiKey) ? { apiKey: v.apiKey, expiresAt: Number(v.expiresAt) || 0 } : null,
        b: null,
      },
      at: String(v.at || ""),
    }
  }
  const s = v && typeof v === "object" ? v : {}
  const keys = s.keys && typeof s.keys === "object" ? s.keys : {}
  const clean = (k) =>
    k && typeof k.apiKey === "string" && REAL_KEY.test(k.apiKey)
      ? { apiKey: k.apiKey, expiresAt: Number(k.expiresAt) || 0 }
      : null
  return {
    current: s.current === "b" ? "b" : "a",
    refreshToken: String(s.refreshToken || ""),
    keys: { a: clean(keys.a), b: clean(keys.b) },
    at: String(s.at || ""),
  }
}

export function readStore(siteId, account) {
  try {
    return normalize(JSON.parse(readFileSync(keyPath(siteId, account), "utf8")))
  } catch {
    return blank()
  }
}

export function writeStore(siteId, account, st) {
  const next = normalize(st)
  next.at = new Date().toISOString()
  try {
    const f = keyPath(siteId, account)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(next))
  } catch {}
  return next
}

/** 这个站点下所有账号的 key 文件（排障用） */
export function listAccounts(siteId) {
  try {
    const dir = join(homedir(), ".cache", "magpie")
    const pfx = `magicrew-key-${siteId}__`
    return readdirSync(dir)
      .filter((f) => f.startsWith(pfx) && f.endsWith(".json"))
      .map((f) => f.slice(pfx.length, -5))
  } catch {
    return []
  }
}

/** 清掉某个账号的 key（重新登录时用） */
export function dropStore(siteId, account) {
  try {
    unlinkSync(keyPath(siteId, account))
  } catch {}
}

export const otherSlot = (slot) => (slot === "a" ? "b" : "a")

/** 这一把还能用吗：没有到期信息时按「能用」处理，由服务端说了算 */
export function isFresh(k, leadMs = LEAD_MS) {
  if (!k?.apiKey) return false
  if (!k.expiresAt) return true
  return Date.now() + leadMs < k.expiresAt
}

export function currentKey(st) {
  return st?.keys?.[st.current] ?? null
}

/** 两槽里还有活的吗 */
export function hasLiveKey(st, leadMs = 0) {
  return ["a", "b"].some((s) => isFresh(st?.keys?.[s], leadMs))
}

/**
 * 把服务端给的到期时间标准化成毫秒时间戳。
 * 实测两种样子：`"2026-10-27 18:36:26"`（本地时间）和毫秒数字。
 */
export function toEpochMs(v) {
  if (typeof v === "number" && v > 1e12) return v
  if (typeof v === "string" && v.trim()) {
    const s = v.trim()
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
    if (m) {
      const [, y, mo, d, h, mi, se] = m.map(Number)
      return new Date(y, mo - 1, d, h, mi, se).getTime()
    }
    const t = Date.parse(s)
    if (!Number.isNaN(t)) return t
  }
  return 0
}

/**
 * 当前这把被上游拒了 → 切到另一槽。被拒的那把标失效，免得下次又用它。
 * @returns 另一槽那把 key，没有可用的就 null
 */
export function switchSlot(siteId, account, badApiKey) {
  const st = readStore(siteId, account)
  const keys = { ...st.keys }
  for (const slot of ["a", "b"]) {
    if (keys[slot]?.apiKey === badApiKey) keys[slot] = { ...keys[slot], expiresAt: 0 }
  }
  const alt = otherSlot(st.current)
  const target = keys[alt]?.apiKey ? alt : keys[st.current]?.apiKey ? st.current : null
  if (!target) return null
  writeStore(siteId, account, { ...st, current: target, keys })
  return keys[target]
}

// ── 续期串行化 ────────────────────────────────────────────────────────
//
// refresh_token 一次性。多个请求同时发现 key 不新鲜会一起续，除第一个外全失败。
// 按「站点 + 账号」把续期合成一次。

const inflight = new Map()

export function renewOnce(siteId, account, doRenew) {
  const k = `${siteId}__${safeAccount(account)}`
  const running = inflight.get(k)
  if (running) return running
  const p = (async () => {
    try {
      return await doRenew()
    } catch {
      return null
    } finally {
      inflight.delete(k)
    }
  })()
  inflight.set(k, p)
  return p
}
