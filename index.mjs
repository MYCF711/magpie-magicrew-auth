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
import { backfillInviteCodes, setInviteOptionReader, INVITE_FIRST_OPTION } from "./src/store.mjs"
import { makeMethods } from "./src/hooks/methods.mjs"
import { makeRefresh } from "./src/hooks/refresh.mjs"
import { makeLoader } from "./src/hooks/loader.mjs"
import { makeUsage } from "./src/hooks/usage.mjs"
import { makeCheckin } from "./src/hooks/checkin.mjs"
import { makeModels } from "./src/hooks/models.mjs"
import { makeHeaders } from "./src/hooks/headers.mjs"

/** 一个站点进，一个完整插件出 */
function buildPlugin(c) {
  return async (input) => {
    // 把「怎么读这个供应商的开关」交给 store —— 邀请码模式就靠它。
    //
    // ⚠ 必须传**读取函数**，不能在这里读一次存下来：magpie 的 option 是
    //   「拨一下 -> 立刻生效」的（providers.go 的 setProviderOptions 不重启
    //   host，只把新值递过去），每读一次才是当前值。
    //   input 可能是 undefined（老 magpie / 测试直接调工厂），一律可选链。
    setInviteOptionReader(c.PROVIDER, (key) => input?.magpie?.option?.(c.PROVIDER, key) === true)

    return {
      // 老用户升级上来时码缓存可能是空的：延迟补一次（只补缺口，失败静默）
      config: (cfg) => {
        try {
          const t = setTimeout(() => {
            backfillInviteCodes().catch(() => {})
            // 开关打开时，启动就把「首选满了没」查一次（每个站点 10 分钟节流，
            // 启动这一次不会比登录 / 签到多打请求）。放在这里是因为用户可能
            // 拨完开关就去注册新号，等不到下一次登录。
            import("./src/invite-quota.mjs")
              .then((m) => m.enforceInviteSwitch(c))
              .catch(() => {})
          }, 20_000)
          t.unref?.()
        } catch {}
        return makeConfig(c)(cfg)
      },

      auth: {
        provider: c.PROVIDER,
        icon: c.ICON,
        maxConcurrency: 4,
        refreshLead: REFRESH_LEAD_MS,

        // ── 供应商编辑器里的「插件选项」：邀请码挂谁 ───────────────────
        //
        // magpie 自己的字段（#2038）：每项都是 Off/On 一个开关，存在
        // `settings.PluginOptions[provider][key]` 里，插件用
        // `input.magpie.option(provider, key)` 读，**改完不重启 host**。
        //
        // 只有这一个开关 = 只有两种模式（自动 / 首选）。要「指定任意码」就得有
        // 一个能装字符串的控件，而选项只能是布尔 —— 那正是这次拆掉的登录页文本框；
        // 「列出账号让人挑」同理，也做不了（settings.PluginOptions 是 map[string]bool）。
        // 能做的只是「看得见」：点登录时 instructions 里会写这次挂在哪个账号名下（打码）。
        options: [
          {
            key: INVITE_FIRST_OPTION,
            label: "邀请码挂到首选账号",
            description:
              "开：新号注册挂在 magpie 账号页「首选」那个账号名下，它满了自动换到未满的真实邮箱号。关：跟随最后一个注册成功的新号（默认）。两种模式点登录时都会写明这次挂在谁名下。",
            default: false,
          },
        ],

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
