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
  listAccounts,
} from "./key-store.mjs"

/**
 * 从 auth 里取账号标识。org 是组织码，登录后固定不变，最稳。
 */
export function accountOf(auth) {
  return safeAccount(auth?.org || auth?.accountId || auth?.uid || "default")
}

/** 这个账号的 store 里到底有没有东西（登录过 / 接管过 / 续过期都算） */
function storeHasIdentity(siteId, account) {
  const st = readStore(siteId, account)
  return !!(
    st?.refreshToken ||
    st?.keys?.a?.apiKey ||
    st?.keys?.b?.apiKey
  )
}

/**
 * 这条请求属于哪个账号的 key 槽 —— 比 `accountOf` 多一层兜底。
 *
 * 为什么要多这一层（2026-10-28 实测的链路）：
 *
 *   网关路径下（ZCode 等 agent 从 magpie 的 `/v1/chat/completions` 进来），
 *   `getAuth()` 返回的 auth **可能不带 org / accountId / uid** ——
 *   于是 `accountOf()` 落到 `"default"`，`readStore(c.id, "default")` 读不到
 *   真实账号的槽，`ensureKey` 只能退到「从 magpie 存的凭据接管一次」用
 *   `auth.access`；而它过了 2 小时就 403，表现成
 *   `502 {"message":"超级麦吉 did not stream: token无效"}`。
 *
 * 兜底只做**一半**，这是关键：
 *
 *   · 该站点**恰好一个账号**（绝大多数用户）→ 那就是它，安全
 *   · 0 个 → 交给原来的「首次接管」
 *   · **≥2 个 → 不猜**，退回 `"default"`
 *
 * 为什么不猜：key 与账号一一对应，用错账号的 key 就是拿别人的积分、别人的
 * 组织出话，而且本地看不出来（不是报错，是错账）。多账号场景宁可让这次请求
 * 失败，也不要借身份 —— 判据见 docs/internals.md 第十五节。
 *
 * ⚠ 多账号 + 网关路径的组合目前仍然无解：需要 magpie 把 provider 实例 id
 *   传进来（`plugin-auth.json` 里已经有 `magicrew#p4nwa7` 这种带后缀的 key），
 *   插件侧拿不到。在那之前这里只能保守。
 */
export function accountFor(c, auth) {
  const direct = accountOf(auth)
  if (direct !== "default") return direct
  try {
    const live = listAccounts(c.id).filter((acc) => storeHasIdentity(c.id, acc))
    if (live.length === 1) return live[0]
  } catch {}
  return direct
}

/**
 * 拿到这个账号一把能用的 key。**永不抛** —— 续不上就交出手里那把（哪怕不新鲜），
 * 让请求自己去撞上游的错误，比在这里抛更能说明问题。
 *
 * @param {object} c         站点上下文
 * @param {Function} getAuth magpie 的取账号函数，或直接给 auth 对象
 * @param {{leadMs?:number}} opts 提前多久算「不新鲜」，默认 10 分钟
 */
/**
 * 这个账号**所有**可能能用的 key，按到期时间从晚到早排。
 *
 * 为什么需要「多把」：key 有两条签发路径 ——magpie 的 `auth.refresh` 一条
 * （src/hooks/refresh.mjs）、本模块的 `ensureKey` 一条，两边各写各的。
 * 而服务端同一时刻只认最新签发的那把，静态「只挑一把」必然有一半概率踩空。
 *
 * 2026-10-29 实测（5 个国际站账号，逐把打 /v1/chat/completions）：
 *
 *   magicrew-intl          auth.access ✅   store 槽 b ❌
 *   magicrew-intl#z983c8   auth.access ✅   store 槽 b ❌
 *   magicrew-intl#3oqx5z   auth.access ❌   store 槽 a ✅
 *   magicrew-intl#h2mcxi   auth.access ❌   store 槽 b ✅
 *   magicrew-intl#8amjca   auth.access ❌   store 槽 a ❌  ← 两把都死
 *
 * 到期越晚 = 签发越晚 = 越可能是活着的那把，所以按 expiresAt 倒序试。
 */
export async function keyCandidates(c, getAuth, { leadMs } = {}) {
  let auth = null
  try {
    auth = typeof getAuth === "function" ? await getAuth() : getAuth
  } catch {}
  const account = accountFor(c, auth)
  const st = readStore(c.id, account)

  const out = []
  const seen = new Set()
  const add = (k) => {
    if (!k?.apiKey || seen.has(k.apiKey)) return
    seen.add(k.apiKey)
    out.push(k)
  }
  add(currentKey(st))
  add(st?.keys?.[otherSlot(st.current)])
  if (auth?.access) add({ apiKey: auth.access, expiresAt: Number(auth.expires) || 0 })

  return out.sort((a, b) => Number(b.expiresAt || 0) - Number(a.expiresAt || 0))
}

/** 把实测能用的那把写回 store —— 下次直接命中，不再逐把试错 */
export function adoptKey(c, auth, apiKey, expiresAt) {
  try {
    const account = accountFor(c, auth)
    const st = readStore(c.id, account)
    if (currentKey(st)?.apiKey === apiKey) return
    const slot = otherSlot(st.current)
    writeStore(c.id, account, {
      current: slot,
      refreshToken: st.refreshToken || "",
      keys: { ...st.keys, [slot]: { apiKey, expiresAt: Number(expiresAt) || 0 } },
      at: st.at,
    })
  } catch {}
}

/**
 * 续期并**写回 store** —— 给 src/hooks/refresh.mjs 用。
 *
 * 收敛成一条路径的原因：refresh.mjs 原来自己调 `refreshGatewayKey`，
 * 拿到的 key 只交给 magpie，插件 store 里还是旧的。两条路径各存一份，
 * 服务端只认最新那把，于是另一半必然 403「token无效」——
 * 2026-10-29 实测 5 个账号里 3 个踩空，就是这么来的。
 *
 * ⚠ refresh_token 是一次性的：谁续谁负责写回，不能让两边各存各的。
 */
export async function renewViaStore(c, auth) {
  const account = accountFor(c, auth)

  // 与 ensureKey 共用同一把锁（renewOnce 按 siteId+account 去重）——
  // refresh_token 一次性，两条路径同时续期会让后到的那次用废 token → 误判掉登录。
  let err = null
  const rec = await renewOnce(c.id, account, async () => {
    try {
      const st = readStore(c.id, account)
      const refreshToken = st.refreshToken || auth?.refresh || ""
      if (!refreshToken) throw new Error("没有 refresh_token")

      const k = await refreshGatewayKey(refreshToken, c.host)
      const next = { apiKey: k.apiKey, expiresAt: toEpochMs(k.apiKeyExpiresAt) }
      const slot = otherSlot(st.current)
      const nextRefresh = k.refreshToken || refreshToken
      writeStore(c.id, account, {
        current: slot,
        refreshToken: nextRefresh,
        keys: { ...st.keys, [slot]: next },
        at: st.at,
      })
      return { ...next, refreshToken: nextRefresh }
    } catch (e) {
      err = e
      throw e
    }
  })

  if (!rec) throw err ?? new Error("续期失败")
  return rec
}

export async function ensureKey(c, getAuth, { leadMs } = {}) {
  let auth = null
  try {
    auth = typeof getAuth === "function" ? await getAuth() : getAuth
  } catch {}
  const account = accountFor(c, auth)

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
