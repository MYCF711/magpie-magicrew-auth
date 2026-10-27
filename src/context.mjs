// 站点上下文 —— 每个供应商拿到的那一份「我是谁」
//
// 一个包两个供应商，所以这里不是常量，是**按站点生成**的：
//
//   siteCtx(SITES.cn)   → magicrew       超级麦吉
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
 *   SHORT   卡片上显示的短名
 *   BASE    模型网关 <host>/v1
 *   ICON    这个供应商自己的图标（插件卡片的图标另外在 package.json.magpie.icon）
 */
export function siteCtx(SITE) {
  return {
    ...SITE,
    PROVIDER: SITE.id,
    SHORT: SITE.id === "magicrew" ? "超级麦吉" : "MagiCrew",
    BASE: `${SITE.host}/v1`,
    ICON: SITE.id === "magicrew" ? ICON_BY_SITE.cn : ICON_BY_SITE.intl,
  }
}

/** 把一条 flows/models 变成一个 magpie 模型条目 */
export function modelEntry(c, id, name, vision) {
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
  }
}
