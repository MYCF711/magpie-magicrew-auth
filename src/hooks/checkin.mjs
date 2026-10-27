// ⑥ auth.checkin(getAuth) —— 签到
//
// magpie 按北京时间每账号每天调一次，失败当天重试。
// 幂等、状态文件、UI 全是 magpie 的，插件只回答「这一次做成没有」。
//
// ⚠ 不要写定时器、不要自己存状态 —— 会让同一天跑两次。
//
// 签到逻辑在独立模块里**按需加载**：它挂了，登录/模型/额度照常工作。

export function makeCheckin(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { outcome: "failed", message: "未登录" }
    try {
      const { runCheckin } = await import("../tasks.mjs")
      return await runCheckin({ ...auth, host: c.host })
    } catch (e) {
      return { outcome: "failed", message: String(e?.message ?? e) }
    }
  }
}
