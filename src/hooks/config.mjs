// ① config(cfg) —— 声明 provider
//
// magpie 启动时调一次：写「我是谁、用哪个 SDK、有哪些模型」。
//
// ⚠ 三条不许改：
//   · 用 ??= 不用 =，否则覆盖用户在 plugins.json 里手配的值
//   · models 必须有内容 —— 未登录也要有，空表会让卡片显示 "0 models"
//   · 不要在这里发**业务**网络请求：它是配置，不是钩子（本地默认设置与
//     延迟的自动维护见 src/auto-maintenance.mjs，失败不影响 config）

import { SDK } from "../context.mjs"
import { readSnapshot } from "../store.mjs"
import { initAutoMaintenance } from "../auto-maintenance.mjs"
import { warmUpDns } from "../schannel.mjs"

export function makeConfig(c) {
  return async (cfg) => {
    // 默认开启本 provider 的签到；并在后台检查插件自身更新。
    // 两者都尽力而为，失败不影响 config（见 src/auto-maintenance.mjs 的边界说明）。
    initAutoMaintenance(c)

    // 预热 DNS：这个域名冷解析要 7–10 秒（见 src/schannel.mjs 的 warmUpDns）。
    // 后台发射、不 await —— config 是配置阶段，慢一点点都不能拖住 magpie 启动。
    try { warmUpDns([new URL(c.host).host]) } catch {}

    cfg.provider ??= {}
    cfg.provider[c.PROVIDER] ??= {
      name: c.SHORT,
      npm: SDK,
      api: c.BASE,
      // 未登录时给上次的快照；从没登录过就是空表（宁缺毋假）。
      // 一旦登录，⑦ models 会把真表拉回来并落盘。
      models: readSnapshot(c.id) ?? {},
    }
  }
}
