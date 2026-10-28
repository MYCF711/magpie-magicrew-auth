// ③ auth.refresh(auth) —— 续期
//
// magpie 在 api_key 到期前（refreshLead）调一次，**返回的字段合并进旧账号**，
// 不是整体替换（client.auth.set 才是替换，两者不同）。
//
// ⚠ 一次性 refresh_token 必须串行 —— magpie 已按账号串行化；插件里
//   renewViaStore 与 ensureKey 共用 renewOnce 的同一把锁，也不会并发。
//   服务端每次换完会轮换，必须用返回的新值。

import { renewViaStore } from "../keys.mjs"

export function makeRefresh(c) {
  return async (auth) => {
    // 不要求 auth.refresh 存在：refresh_token 可能只躺在 key-store 里
    //（0.3.29 之前 ensureKey 续过、magpie 那份已经轮换废了）。由 renewViaStore
    // 两处都试，这里先别把它挡掉。
    if (!auth) return undefined
    try {
      // ⚠ 必须走 store —— 由它统一持有 refresh_token 并把新 key 写回。
      //   自己再调一次 refreshGatewayKey 会让两条路径各存一把，
      //   哪把还有效本地无法预判，请求侧就会 403「token无效」（2026-10-29 实测）。
      const k = await renewViaStore(c, auth)
      return {
        access: k.apiKey,
        // 服务端每次换完都轮换 refresh_token，必须用返回的新值
        refresh: k.refreshToken ?? auth.refresh,
        expires: k.expiresAt || Date.now() + 2 * 3600_000,
      }
    } catch (e) {
      if (/invalid|expired|401|403|token/i.test(String(e?.message))) {
        throw Object.assign(new Error("登录已失效，请重新登录"), { signIn: "expired" })
      }
      throw e
    }
  }
}
