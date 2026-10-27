# 更新记录

## 0.3.2

**key 收敛到唯一出口 + 三层凭据各有各的保活**

三层有效期，一层比一层长：

| 凭据 | 活多久 | 说明 |
|---|---|---|
| 网页 JWT | 30 天 | 登录时签发 |
| `mgw_` api_key | **2 小时** | 签一把顶一把，旧的当场吊销 |
| refresh_token | **7 天** | 用一次轮换一次 |

- **所有签发/续期只走 `src/keys.mjs`**，落到 `~/.cache/magpie/magicrew-key-<站点>.json`，**只保留最新一把**
  - 之前 magpie 的 `auth.refresh` 和 loader 各有一次签发机会，两边各签一把就互相吊销，
    表现是「显示已登录、模型也列得出来，一发请求 403」
- **首次运行自动接管**：key-store 空时从 magpie 存的凭据接一次，之后全部自管
- **到期前 10 分钟自动续**（`ensureKey` 在每次请求前检查）
- **checkin 每天顺手续一次**（24 小时提前量）：一天没请求时也不会让 refresh_token 闲置到 7 天失效
- **续期串行化**：同一站点同时只跑一个 `renewOnce`，避免并发签多把互相吊销
- **`writeKey` 校验 key 形状**：只接受 `mgw_` + 20 位以上，测试/占位值不许落盘
  （曾经因为假 key `mgw_test_key` 被接管落盘，把国际站那把真 key 顶掉）
- 实测「过夜 key 过期」：把落盘那把的 `expiresAt` 改到 3 小时前 → 来一发请求 →
  HTTP 200 正常回复，落盘自动换成新 key（耗时 1885ms，含续期）


## 0.3.1

- **流式请求补 `stream_options: { include_usage: true }`**（防御性）
  - magicrew 在 `stream: true` 下默认不返回 usage；补上之后 `[DONE]` 前会多一条
    `{"choices":[],"usage":{...}}` 的收尾 chunk，流更完整，下游判定"结束了"更有把握
  - 实测：补之前 `usage=无`，补之后 `finish_reason=stop · usage=有 · 收尾chunk=true · [DONE]=true`

> ⚠ `Stream ended without finish_reason` 的真正根因**不是流式**，而是下面这条
> 「签新 key 会吊销旧 key」—— 见 docs/internals.md 第十三节。这一项留着是因为
> 它让流更完整，不是因为它是那个报错的解药。

## 0.3.0

**结构重构：一个针脚一个模块。行为不变，形状变了。**

magpie 是主板 —— 九个针脚，能力全在它那边；插件只填自己那一份。
原来 `makePlugin` 返回一个大对象把九样东西焊在一起，现在拆成：

```
index.mjs                 框：把选中的小插头拼起来，不实现任何东西
src/context.mjs           站点上下文（siteCtx(SITES.cn) → 一个供应商）
src/store.mjs             三份落盘：模型快照 / 邀请码 / 登录态
src/clipboard.mjs         剪贴板降级通道
src/browser-login.mjs     自己拉浏览器 + CDP 读凭据（可选能力，按需加载）
src/hooks/config.mjs      ① config(cfg)
src/hooks/methods.mjs     ② auth.methods[]
src/hooks/refresh.mjs     ③ auth.refresh
src/hooks/loader.mjs      ④ auth.loader
src/hooks/usage.mjs       ⑤ auth.usage
src/hooks/checkin.mjs     ⑥ auth.checkin
src/hooks/models.mjs      ⑦ provider.models
src/hooks/headers.mjs     ⑧ chat.headers
```

- **一个模块坏了不影响别的**：`browser-login` 和 `tasks` 都是运行时按需加载，
  它们挂了这个插件照常登录（走登录态那条路）、拉模型、报额度
- **只做一半功能也能用**：不要签到就把那行从 `index.mjs` 的 return 里删掉，别处不用改
- 每个 hook 文件头写清「magpie 什么时候调它、拿到什么、要返回什么、**不要**做什么」

## 0.2.1

- **删掉「密码登录」** —— 两站都删，只剩浏览器登录与「登录态（JWT + 组织码）」两条。网页登录拿到的 token 一样能签 `mgw_` key，让用户再输一次手机号密码是多余的一步
- **卡片显示手机号** —— `orgcode12345` 换成 `138****8000`。优先级 手机号 → 邮箱 → 昵称 → 真名（昵称是用户自己填的，新号可以不填也可以乱填）
- **包名改为 `Magicrew`**，卡片标题就是它，不再显示 `magpie-magicrew-auth`。已装用户需按 HOOKS.md「改名的完整步骤」同步三处键名，或 `plugin rm` 后重装
- **浏览器登录的 URL 也带 `?invitation=`** —— 原来只有密码登录的 body 带，用户在网页里注册就丢了邀请码
- **修浏览器起不来**：`magicrew-login-profile` 里残留的 `SingletonLock` / `lockfile` 会让新进程把 URL 转交给一个已退出的实例后自己退出，`DevToolsActivePort` 永远不出现，于是白等 20 秒再降级。现在启动前清掉这些标记，超时收到 8 秒，`closeSession` 用 `taskkill /T /F` 连子进程一起杀
- **更正一条错误结论**：网页版 354 字符 token（`device_id` 空）**完全可用**，`invitations/info` / `flows/models` / `gateway-tokens` / `quota` 四条全通。之前「不被网关接受一律 2155」是拿过期 token 测出来的
- **`opened: true` 的语义**：那是「我自己已经开过页面了，你别再开」，传错会点了登录却不弹页面

## 0.2.0

- **一个包两个供应商**：国内「超级麦吉」（`magicrew`）与国际「MagiCrew」（`magicrew-intl`）各占一行，不聚合
- **支持国际站**：`magicrew.ai` / 网关 `magic-service.magicrew.ai`，49 个可选模型（国内 27 个）
- **模型不再写死**：按账号实时拉 `/api/v1/flows/models`，账户能选什么就显示什么；登录过的快照只作未登录时的兜底
- **两套图标**：国内用超级麦吉的卡通角色，国际用 MagiCrew 的黑底六边形，供应商列表里一眼分得开
- **点一下，全自动**：插件自己拉起浏览器（独立 profile + 调试端口）停在官方登录页，用户在里面登录，插件通过 CDP 读走它自己的 localStorage 拿到 JWT + 组织码 —— 零手动操作；本机没 Chrome/Edge 时降级为「系统浏览器 + 剪贴板」
- **登录方式只剩两条**：浏览器登录（默认）与手填 JWT + 组织码。手机号+密码那条已删除 —— 网页登录拿到的 token 一样能签 `mgw_` key
- **卡片显示手机号，不再显示组织码**：`orgcode12345` 换成 `138****8000`。优先级手机号 → 邮箱 → 昵称 → 真名：昵称是用户自己填的（新号可以不填、也可以乱填），手机号是登录凭据本身
- **包名改为 `Magicrew`**，卡片标题就是它（原来显示 `magpie-magicrew-auth`）；已装的用户需要重装一次
- 修正：`opened: true` 的语义是「我已自己开过页面」，传错会点了登录却不弹页面
- 修正：网页版登录态（354 字符，`device_id` 空）**完全可用**，之前「不被网关接受」的结论是拿过期 token 测出来的
- **邀请码自动滚**：第一次带作者的码，之后每次登录都记住上一个登录账号的码，拿到新的覆盖旧的，存在 `~/.cache/magpie/magicrew-invite-<站点>.json`
- 国际站 `/v1/chat/completions` 强制 `organization-code`，按站点自动带
- `max_tokens` 低于 512 时抬到 512（推理模型会把短额度吃光，`content` 返回空串）

## 0.1.0

- 首个版本：国内站「超级麦吉」（`letsmagic.cn`）接入 magpie / OpenCode
- 手机号+密码登录，网页 JWT 换 `mgw_` api_key，两小时自续
- 账号当前可选的 27 个语言模型、积分余额、新手奖励自动领取
