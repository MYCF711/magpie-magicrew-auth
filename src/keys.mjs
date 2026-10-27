// key 的唯一出口 —— 按账号隔离的 A/B 双槽
//
//   登录成功  → issueAndStore()  签一把放进「另一个槽」，切过去
//   loader    → ensureKey()      快过期就把新的签到另一个槽，切过去；旧的留着当回退
//   refresh   → ⚠ **不经过本模块**。src/hooks/refresh.mjs 自己调
//               api.refreshGatewayKey(auth.refresh)，magpie 拿到的不是这一把。
//
// **每个账号一套槽，互不干扰** —— 同站点登两个账号时，第二个人登录不会碰第一个人的 key。
// 账号标识用 `org`（组织码），拿不到才退回 accountId。
//
// ⚠ 上面那条 refresh 是「唯一出口」这个设计里**唯一没落地的口子**（2026-10-27 核对）：
//   refresh_token 是一次性轮换的，两条路径各用各的那份会分叉 ——
//   ensureKey 轮换后 store 里是新值，refresh.mjs 手里 magpie 的还是旧值，
//   再调就是 401 → magpie 判定「登录已失效」→ 让用户重新登录。
//
//   目前不会触发，因为 **store 从来没被写过**（本机 magicrew-key-*.json 一个都没有，
//   说明 ensureKey 从没执行过 —— 没发过模型请求）。但这意味着：
//   **若将来要给 checkin 补 ensureKey，必须先把这个钩子也收敛进来**，
//   否则就是亲手把「一条路」掰成两条，用「多写一句文档」换「用户莫名掉登录」。

import { issueGatewayKey, refreshGatewayKey } from "./api.mjs"
import {
  readStore,
  writeStore,
  isFresh,
  toEpochMs,
  renewOnce,
  otherSlot,
  currentKey,
  safeAccount,
} from "./key-store.mjs"

/**
 * 从 auth 里取账号标识。org 是组织码，登录后固定不变，最稳。
 */
export function accountOf(auth) {
  return safeAccount(auth?.org || auth?.accountId || auth?.uid || "default")
}

/**
 * 拿到这个账号一把能用的 key。**永不抛** —— 续不上就交出手里那把（哪怕不新鲜），
 * 让请求自己去撞上游的错误，比在这里抛更能说明问题。
 *
 * @param {object} c         站点上下文
 * @param {Function} getAuth magpie 的取账号函数，或直接给 auth 对象
 * @param {{leadMs?:number}} opts 提前多久算「不新鲜」，默认 10 分钟
 */
export async function ensureKey(c, getAuth, { leadMs } = {}) {
  let auth = null
  try {
    auth = typeof getAuth === "function" ? await getAuth() : getAuth
  } catch {}
  const account = accountOf(auth)

  const st = readStore(c.id, account)
  const cur = currentKey(st)
  if (isFresh(cur, leadMs)) return cur

  const renewed = await renewOnce(c.id, account, async () => {
    const again = readStore(c.id, account)
    const againCur = currentKey(again)
    // 可能别的请求刚续过 —— 别再签一次（refresh_token 一次性）
    if (isFresh(againCur, leadMs)) return againCur

    let refreshToken = again.refreshToken

    // ── 该账号第一次跑：从 magpie 存的凭据接管一次 ────────────────────
    if (!againCur && !refreshToken && auth?.access) {
      const rec = { apiKey: auth.access, expiresAt: Number(auth.expires) || 0 }
      const seeded = {
        current: again.current,
        refreshToken: auth.refresh || "",
        keys: { ...again.keys, [again.current]: rec },
        at: again.at,
      }
      writeStore(c.id, account, seeded)
      if (isFresh(rec, leadMs)) return rec
      refreshToken = seeded.refreshToken
    }

    if (!refreshToken) return againCur ?? null

    // ── 续期：签到**另一个**槽再切过去；旧的留在原槽当回退 ────────────
    const k = await refreshGatewayKey(refreshToken, c.host)
    const rec = { apiKey: k.apiKey, expiresAt: toEpochMs(k.apiKeyExpiresAt) }
    const slot = otherSlot(again.current)
    writeStore(c.id, account, {
      current: slot,
      refreshToken: k.refreshToken || refreshToken,
      keys: { ...again.keys, [slot]: rec },
      at: again.at,
    })
    return rec
  })
  if (renewed) return renewed

  // 续不上：交出手里那把（可能是死的，但比"没有"更清楚）
  if (cur) return cur
  if (auth?.access) return { apiKey: auth.access, expiresAt: 0 }
  return null
}

/**
 * 登录成功后签一把并落盘：写进「另一个槽」再切过去，原来那把留着当回退。
 * @returns {Promise<{apiKey,expiresAt,refreshToken}>}
 */
export async function issueAndStore(c, jwt, org, account) {
  const acc = safeAccount(account || org)
  const st = readStore(c.id, acc)
  const k = await issueGatewayKey(jwt, org, c.host)
  const rec = { apiKey: k.apiKey, expiresAt: toEpochMs(k.apiKeyExpiresAt) }
  const slot = otherSlot(st.current)
  writeStore(c.id, acc, {
    current: slot,
    refreshToken: k.refreshToken || st.refreshToken,
    keys: { ...st.keys, [slot]: rec },
    at: st.at,
  })
  return { ...rec, refreshToken: k.refreshToken || st.refreshToken, account: acc }
}
