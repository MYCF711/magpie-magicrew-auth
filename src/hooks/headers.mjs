// ⑧ "chat.headers"(input, output) —— 每请求加头
//
// input.sessionID 是 magpie 的会话 id，同一会话多轮不变，
// 拿它给上游做 session / prompt cache 的分组键。
//
// ⚠ 只加头，不改体 —— 改体在 loader 里。

export function makeHeaders(c) {
  return async (input, output) => {
    const id = input?.model?.providerID ?? input?.provider?.info?.id
    if (id !== c.PROVIDER || !input?.sessionID) return
    output.headers["x-magicrew-session"] = String(input.sessionID).slice(0, 128)
  }
}
