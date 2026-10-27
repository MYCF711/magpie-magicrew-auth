// key 的唯一出口
//
// 全插件只在这里签发和续期 —— 因为服务端「签一把顶一把」，两个入口必然互相吊销。
//
//   登录成功  → issueAndStore()   签一把，落盘
//   loader    → ensureKey()       不新鲜就续，然后永远用落盘那把
//   refresh   → ensureKey()       同上，magpie 拿到的也是落盘那把
//
// 三个入口最终都落到 key-store 的同一个文件，只保留最新一把。

import { issueGatewayKey, refreshGatewayKey } from "./api.mjs"
import { readKey, writeKey, isFresh, toEpochMs, renewOnce } from "./key-store.mjs"

/**
 * 拿到一把能用的 key。**永不抛** —— 续不上就退回 magpie 给的那把，
 * 让请求自己撞上游的错误，比在这里抛更能说明问题。
 *
 * @param {object} c      站点上下文
 * @param {Function} getAuth  magpie 的取账号函数（或返回 auth 的闭包）
 */
export async function ensureKey(c, getAuth, { leadMs } = {}) {
  const stored = readKey(c.id)
  if (isFresh(stored, leadMs)) return stored

  // key-store 还是空的（第一次跑、或文件被清掉）：
  // 从 magpie 存的凭据**接管一次**，落到自己的文件里 —— 之后全部自管。
  if (!stored) {
    try {
      const auth = typeof getAuth === "function" ? await getAuth() : getAuth
      if (auth?.access) {
        const rec = {
          apiKey: auth.access,
          refreshToken: auth.refresh || "",
          expiresAt: Number(auth.expires) || 0,
        }
        writeKey(c.id, rec)
        // 接管来的这把如果也不新鲜了，继续往下走去续期
        if (isFresh(rec, leadMs)) return rec
        return (await renewOnce(c.id, async () => {
          const ref = rec.refreshToken
          if (!ref) return null
          const k = await refreshGatewayKey(ref, c.host)
          const next = { apiKey: k.apiKey, refreshToken: k.refreshToken || ref, expiresAt: toEpochMs(k.apiKeyExpiresAt) }
          writeKey(c.id, next)
          return next
        })) || rec
      }
    } catch {}
  }

  const renewed = await renewOnce(c.id, async () => {
    // 再读一次：可能别的请求刚续过，那这次就不用再签（每签一次吊销一次）
    const again = readKey(c.id)
    if (isFresh(again, leadMs)) return again

    const ref = again?.refreshToken || stored?.refreshToken || ""
    if (!ref) return null

    const k = await refreshGatewayKey(ref, c.host)
    const rec = {
      apiKey: k.apiKey,
      refreshToken: k.refreshToken || ref,
      expiresAt: toEpochMs(k.apiKeyExpiresAt),
    }
    writeKey(c.id, rec)
    return rec
  })
  if (renewed) return renewed

  // 续不上：退回 magpie 存的那把（可能是死的，但让上游报错更清楚）
  try {
    const auth = typeof getAuth === "function" ? await getAuth() : getAuth
    if (auth?.access) {
      return { apiKey: auth.access, refreshToken: auth.refresh || "", expiresAt: 0 }
    }
  } catch {}
  return null
}

/**
 * 登录成功后签一把并落盘（覆盖旧的）。
 * @returns {Promise<{apiKey,refreshToken,expiresAt}>}
 */
export async function issueAndStore(c, jwt, org) {
  const k = await issueGatewayKey(jwt, org, c.host)
  const rec = {
    apiKey: k.apiKey,
    refreshToken: k.refreshToken || "",
    expiresAt: toEpochMs(k.apiKeyExpiresAt),
  }
  writeKey(c.id, rec)
  return rec
}
