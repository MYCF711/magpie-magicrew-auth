// ① config(cfg) —— 声明 provider
//
// magpie 启动时调一次：写「我是谁、用哪个 SDK、有哪些模型」。
//
// ⚠ 三条不许改：
//   · 用 ??= 不用 =，否则覆盖用户在 plugins.json 里手配的值
//   · models 必须有内容 —— 未登录也要有，空表会让卡片显示 "0 models"
//   · 不要在这里发网络请求：它是配置，不是钩子

import { SDK } from "../context.mjs"
import { readSnapshot } from "../store.mjs"

export function makeConfig(c) {
  return async (cfg) => {
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
