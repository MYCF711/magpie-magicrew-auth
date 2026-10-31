// 站点上下文 —— 每个供应商拿到的那一份「我是谁」
//
// 一个包两个供应商，所以这里不是常量，是**按站点生成**的：
//
//   siteCtx(SITES.cn)   → magicrew       超级麦吉 Super Magic
//   siteCtx(SITES.intl) → magicrew-intl  MagiCrew
//
// 所有小插头（hooks/*）拿到的都是这个对象，它们不自己去认站点。

import { SITES } from "./api.mjs"
import { ICON_BY_SITE } from "./icons.mjs"
import { contextOf } from "./model-context.mjs"

export { SITES }

/** 决定 API 形状，别乱选（见 src/api.mjs 的 base 与 hooks/models 的 api 字段） */
export const SDK = "@ai-sdk/openai-compatible"

/** api_key 只活 2 小时时，提前多久换 */
export const REFRESH_LEAD_MS = 10 * 60_000

/**
 * 站点 → 上下文。
 *
 * 除了 SITES 里那些（id / host / web / needsOrgOnGateway），再补三个派生值：
 *   SHORT   供应商的显示名（= magpie 卡片 / 供应商列表 / 登录方式按钮上那个名字）
 *   BASE    模型网关 <host>/v1
 *   ICON    这个供应商自己的图标（插件卡片的图标另外在 package.json.magpie.icon）
 *
 * ⚠ 显示名约定（2026-10-31，脚手架 UPDATING 第三节）：`<中文> <English>`，英文照抄厂商
 *   官方大小写。这一条对**插件卡片的标题**（package.json 的 name）同样适用。
 *   · 国内站：官网 letsmagic.cn 的中文名是「超级麦吉」，英文名是 `Super Magic` ——
 *     /login、/en、/workspace 三处的 `<title>` 原文都是
 *     `Super Magic - Lighthouse Engine Next-Gen Enterprise AI Application Engine`，
 *     登录页 meta 描述也写 `Super Magic is … launched by Lighthouse Engine`。
 *     是**两个词**，不是 SuperMagic。
 *   · 国际站：官网 magicrew.ai 的 og:site_name 是 `MagiCrew`，连它自己的 /zh 中文版
 *     也照写 `MagiCrew`（标题：`MagiCrew - 一个平台，替代你现在为 AI 工具支付的所有费用`）
 *     ⇒ **上游没给过 MagiCrew 的官方中文名**。但显示名约定要求中英并列（脚手架
 *     check.mjs 逐条卡：必须含中文 + 必须含 English + 必须有空格），所以中文侧取
 *     「麦吉」—— 官网自己就在正文里这么简称（letsmagic.cn 首页 16 处「麦吉帮我…」
 *     「让麦吉直接…」），而 超级麦吉 = 超级 + 麦吉，麦吉 就是 Magi 的音译。
 *     哪天上游给出 MagiCrew 的官方中文名，改这一行即可。
 */
export function siteCtx(SITE) {
  return {
    ...SITE,
    PROVIDER: SITE.id,
    SHORT: SITE.id === "magicrew" ? "超级麦吉 Super Magic" : "麦吉 MagiCrew",
    BASE: `${SITE.host}/v1`,
    ICON: SITE.id === "magicrew" ? ICON_BY_SITE.cn : ICON_BY_SITE.intl,
  }
}

/**
 * 把一条 flows/models 变成一个 magpie 模型条目。
 *
 * `opts.rate` / `opts.free` 是 **magpie 自己的字段**（从 codearts 插件里挖到的，
 * packages/codearts/index.mjs 的 modelOf）：
 *
 *   free  boolean  → 名字后面画一个绿色的「免费」胶囊
 *   rate  number   → 画一个灰色的倍率胶囊（0.09× 这种，就是网站上的「消耗系数」）
 *
 * 关键规则（codearts 原注释）：**free 的时候不给 rate** ——
 *   免费模型不该再标一个倍率，两个胶囊并排没意义。
 * 没有 rate 就什么都不画，正好符合「没有倍率就不显示」。
 *
 * ⚠ 别再用 name 拼倍率了：那样筛选框会连倍率一起匹配，
 *   而且和真正的胶囊样式差得远。
 */
export function modelEntry(c, id, name, vision, opts = {}) {
  const { rate = 0, free = false } = opts
  return {
    id,
    name,
    api: { id, url: c.BASE, npm: SDK },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // 上下文窗口向 magpie 的模型库查 —— 两个模型接口都不返回它，
    // 早前一律填 256K，结果 agent 拿 256K 判断"放不下"，而实际是 1M
    limit: { context: contextOf(id), output: 64_000 },
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      attachment: !!vision,
      input: { text: true, image: !!vision },
      output: { text: true },
    },
    ...(free ? { free: true } : {}),
    ...(!free && Number(rate) > 0 ? { rate: Number(rate) } : {}),
  }
}
