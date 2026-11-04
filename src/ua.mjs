// 出站 User-Agent —— 全插件唯一的一条，api / loader / 首任务 / 组织探测 / 无头登录共用。
//
// 值为什么是 `curl/8.0` 而不是浏览器 UA（2026-11-03 ~ 11-04 逐组真机实测，别再来一遍）：
//
//   国内 i-magic-service.letsmagic.cn（火山 WAF）
//     · `magpie-magicrew-auth` / Bun 默认 UA / 浏览器 UA  → 空 403
//     · `curl/8.0` + 官网 Origin                        → 200
//   国际 magic-service.magicrew.ai（阿里云 ESA）
//     · 浏览器 UA                                        → 405 + 一整页 HTML
//     · `curl/8.0`，且**不带任何 Origin**                 → 200
//   ⇒ 两站唯一共同可通行值就是 `curl/8.0`。它不是「官方客户端 UA」，但它是唯一
//     实测能过两套边缘 WAF 的形态；换成完整 Chrome UA 会在国际站直接 405。
//     判据：`node tests/upstream-ua.mjs`（离线锁）+ 真机 A/B（见 CHANGELOG / 本文件下方）。
//
// 为什么不放 src/api.mjs：src/schannel.mjs 也要用它（DNS 预热那条 HEAD），
// 而 api.mjs → schannel.mjs 是单向依赖，放 api 里会成环。所以单独一个文件，
// api.mjs 再 `export { UA }` 把它转出去，历史导入路径不变。
//
// 三条禁令（踩过就 403）：
//   ① 不许出现 `magpie/…`、`magpie-magicrew-auth` 这类我们自己的名字；
//   ② 不许透传宿主的 UA（插件 host 拿到的是 `magpie/<version>`）；
//   ③ 不许用 `Bun/…` / `node` / `undici` 这类运行时默认 UA。
export const UA = "curl/8.0"
