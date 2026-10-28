// ⑥ auth.checkin(getAuth) —— 签到
//
// magpie 按北京时间每账号每天调一次，失败当天重试。
// 幂等、状态文件、UI 全是 magpie 的，插件只回答「这一次做成没有」。
//
// ⚠ 不要写定时器、不要自己存状态 —— 会让同一天跑两次。
//
// 签到逻辑在独立模块里**按需加载**：它挂了，登录/模型/额度照常工作。

import { rollInvite } from "../store.mjs"
import { kick } from "../auto-maintenance.mjs"

export function makeCheckin(c) {
  return async (getAuth) => {
    const auth = await getAuth()
    if (!auth) return { outcome: "failed", message: "未登录" }
    try {
      // 每天顺带把邀请码滚一次。
      // 登录那一路虽然已经改成 await，但万一 host 进程在中途被回收，
      // 滚动仍会丢；挂在这里（magpie 保证每天跑一次）可以第二天补上。
      // rollInvite 内部自带超时和 try/catch，失败不影响签到。
      await rollInvite(c.id, auth.jwt, auth.org, c.host)
      const { runCheckin } = await import("../tasks.mjs")
      const result = await runCheckin({ ...auth, host: c.host })
      // 签到成功后再给自动更新一次机会（config 启动时已试过一次；
      // 这里覆盖「magpie 长期不重启」的情况）。kick 自己有 6 小时节流，
      // 且不阻塞签到结果。
      kick(c).catch(() => {})
      return result
    } catch (e) {
      return { outcome: "failed", message: String(e?.message ?? e) }
    }
  }
}
