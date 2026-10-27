// 这个插件自己维护的那一把 key
//
// ═══ 为什么必须自己管 ═══════════════════════════════════════════════════
//
// `POST /api/v1/model-gateway/tokens` **一个账号只保留一把 `mgw_` key**：
// 签一把新的，上一把立刻在服务端失效 —— 不是"过期"，是**当场吊销**。
//
// 所以只要有两个地方会签 key，它们就会互相顶掉：
//
//   ① magpie 到期前调 `auth.refresh`
//   ② loader 里发现 key 不新鲜了顺手续一次
//
// 一旦两边各签一把，先签的那把就成了死 key，而持有它的那一方还以为自己能用 ——
// 表现就是「登录着、模型也列得出来，一发请求 403 token无效」。
//
// ⇒ 全插件只有这一个文件是 key 的来源。所有签发、续期都写这里，**只留最新一把**，
//   旧的直接被覆盖（服务端那边它也已经失效了，留着没有意义）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

/** 提前多久续期。key 只活 2 小时，10 分钟够用 */
const LEAD_MS = 10 * 60_000

export function keyPath(siteId) {
  return join(homedir(), ".cache", "magpie", `magicrew-key-${siteId}.json`)
}

/** @returns {{apiKey:string, refreshToken:string, expiresAt:number, at:string} | null} */
export function readKey(siteId) {
  try {
    const v = JSON.parse(readFileSync(keyPath(siteId), "utf8"))
    if (typeof v?.apiKey !== "string" || !v.apiKey) return null
    return {
      apiKey: v.apiKey,
      refreshToken: String(v.refreshToken || ""),
      expiresAt: Number(v.expiresAt) || 0,
      at: String(v.at || ""),
    }
  } catch {
    return null
  }
}

/** 覆盖写 —— 只保留最新一把，旧的没了 */
export function writeKey(siteId, k) {
  const rec = {
    apiKey: String(k.apiKey || ""),
    refreshToken: String(k.refreshToken || ""),
    expiresAt: Number(k.expiresAt) || 0,
    at: new Date().toISOString(),
  }
  // ⚠ 只接受看起来像真的 key。测试/占位值（"mgw_test_key"、空串、随便写的）不许落盘 ——
  //   曾经因此把国际站那把真 key 顶成了 mgw_test_key。
  if (!/^mgw_[A-Za-z0-9_-]{20,}$/.test(rec.apiKey)) return ""
  try {
    const f = keyPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(rec))
  } catch {}
  return rec.apiKey
}

/** 还能用吗：没有到期信息时按「能用」处理，由服务端说了算 */
export function isFresh(k, leadMs = LEAD_MS) {
  if (!k?.apiKey) return false
  if (!k.expiresAt) return true
  return Date.now() + leadMs < k.expiresAt
}

/**
 * 把服务端给的到期时间标准化成毫秒时间戳。
 * 实测两种样子：`"2026-10-27 18:36:26"`（本地时间字符串）和毫秒数字。
 */
export function toEpochMs(v) {
  if (typeof v === "number" && v > 1e12) return v
  if (typeof v === "string" && v.trim()) {
    const s = v.trim()
    // "2026-10-27 18:36:26" —— 服务端给的是本地时间（UTC+8）
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

// ── 续期串行化 ────────────────────────────────────────────────────────
//
// 多个请求同时发现 key 不新鲜时会一起续 —— 每续一次吊销一次，最后只剩一把能活。
// 用一个进程内的 promise 把同一站点的续期合成一次。

const inflight = new Map()

/**
 * 续期：拿 refresh_token 换一把新的并落盘。同一站点同时只跑一个。
 * @returns {Promise<{apiKey,refreshToken,expiresAt} | null>} 失败返回 null，不抛
 */
export function renewOnce(siteId, doRenew) {
  const running = inflight.get(siteId)
  if (running) return running
  const p = (async () => {
    try {
      return await doRenew()
    } catch {
      return null
    } finally {
      inflight.delete(siteId)
    }
  })()
  inflight.set(siteId, p)
  return p
}
