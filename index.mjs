// Magicrew · 超级麦吉 / MagiCrew —— magpie 供应商插件
//
// ═══ 这是一块「框」，不是插头 ═════════════════════════════════════════
//
// magpie 是主板：它规定了九个针脚，能力（调度、账号池、续期、UI、路由、
// 流式转发）全在主板那边。插件要做的只是把**自己那一份**填进去。
//
// 所以这里不实现任何东西 —— 每个针脚是一个独立的小模块：
//
//   src/hooks/config.mjs    ① config(cfg)              声明 provider + 模型表
//   src/hooks/methods.mjs   ② auth.methods[]           登录
//   src/hooks/refresh.mjs   ③ auth.refresh(auth)       续期
//   src/hooks/loader.mjs    ④ auth.loader(getAuth)     请求接管
//   src/hooks/usage.mjs     ⑤ auth.usage(getAuth)      额度
//   src/hooks/checkin.mjs   ⑥ auth.checkin(getAuth)    签到
//   src/hooks/models.mjs    ⑦ provider.models()        每账号模型目录
//   src/hooks/headers.mjs   ⑧ "chat.headers"()         每请求加头
//
// 每个模块只读一个 c（站点上下文，见 src/context.mjs），互不依赖：
// 一个坏了，其余照常 —— 按需加载的那两个（browser-login / tasks）尤其如此。
//
// 想只做一半功能？把对应那行从下面的 return 里删掉就行，不用改别处。
//
// ═══ 一个包，两个供应商 ═══════════════════════════════════════════════
//
//   export const MagicrewAuthPlugin     = buildPlugin(siteCtx(SITES.cn))
//   export const MagicrewIntlAuthPlugin = buildPlugin(siteCtx(SITES.intl))
//
// magpie 把包里每个具名导出当成一个独立插件，所以它们在供应商列表、用量概览、
// 模型目录里各占一行，不聚合、不互相覆盖登录态。

import { SITES, siteCtx, REFRESH_LEAD_MS } from "./src/context.mjs"
import { makeConfig } from "./src/hooks/config.mjs"
import { makeMethods } from "./src/hooks/methods.mjs"
import { makeRefresh } from "./src/hooks/refresh.mjs"
import { makeLoader } from "./src/hooks/loader.mjs"
import { makeUsage } from "./src/hooks/usage.mjs"
import { makeCheckin } from "./src/hooks/checkin.mjs"
import { makeModels } from "./src/hooks/models.mjs"
import { makeHeaders } from "./src/hooks/headers.mjs"

/** 一个站点进，一个完整插件出 */
function buildPlugin(c) {
  return async () => {
    // 卡片标题与文案不在这里做 —— 那是 registry 条目的职责。
    // 插件不写 magpie 自己的缓存目录：那份文件属于 magpie，插件只读不写。
    return {
      config: makeConfig(c),

      auth: {
        provider: c.PROVIDER,
        icon: c.ICON,
        maxConcurrency: 4,
        refreshLead: REFRESH_LEAD_MS,

        methods: makeMethods(c),
        refresh: makeRefresh(c),
        loader: makeLoader(c),
        usage: makeUsage(c),
        checkin: makeCheckin(c),
      },

      provider: {
        id: c.PROVIDER,
        models: makeModels(c),
      },

      "chat.headers": makeHeaders(c),
    }
  }
}

// ═══ 两个供应商，各占一行 ═════════════════════════════════════════════

export const MagicrewAuthPlugin = buildPlugin(siteCtx(SITES.cn))
export const MagicrewIntlAuthPlugin = buildPlugin(siteCtx(SITES.intl))

// 供测试引用（⚠ 入口文件不要导出别的「像插件的对象」，否则会被 magpie 当插件加载）
export { SITES }
export const _internal = { buildPlugin, siteCtx, SITES }
