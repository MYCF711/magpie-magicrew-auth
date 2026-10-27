// ⑦ provider.models(provider, { auth }) —— 每账号的模型目录
//
// ⚠ 返回的是**这个账号真正能选**的模型，不是厂商标称的全部：
//   混进 VIP 锁定 / 生图 / embedding，用户选中就报错。
//
// 失败回退三种选一种：原样返回 provider.models / 抛异常 /
// 返回自己的列表并标 Symbol.for("magpie.fellBack")。
// ⚠ 局部成功时别标 fellBack —— magpie 会整份丢弃。
//
// 登录态失效 → 抛带 signIn: "expired" 的错误。

import { fetchModels } from "../api.mjs"
import { modelEntry } from "../context.mjs"
import { readSnapshot, writeSnapshot } from "../store.mjs"

export function makeModels(c) {
  return async (provider, { auth } = {}) => {
    const snapshot = readSnapshot(c.id)
    if (!auth) return snapshot ?? {}

    try {
      const live = await fetchModels(auth.jwt, auth.org, c.host)
      if (!live.length) return snapshot ?? {}

      const out = {}
      for (const m of live) out[m.id] = modelEntry(c, m.id, m.name, m.vision)
      writeSnapshot(c.id, out)
      return out
    } catch (e) {
      if (/401|403|unauthorized|expired|用户不存在|登录失败/i.test(String(e?.message ?? e))) {
        throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
      }
      // 网络抖动：退回上次的快照，别让整个供应商从列表里消失
      return snapshot ?? {}
    }
  }
}
