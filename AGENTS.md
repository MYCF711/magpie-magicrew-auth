# AGENTS.md —— 给 AI 执行者的入口

> 人类请看 [README](./README.md)。这份只回答两件事：**你现在该读哪一份**、
> **忘了哪一条会静默出错**。
>
> 结构照搬 [magpie-plugin-scaffold](../magpie-plugin-scaffold/AGENTS.md) 的入口式写法；
> 下面第二节是本仓库自己的坑，不是通用套话。

---

## 零、magpie 升级时：只看稳定版

**判断「要不要跟着 magpie 改这个插件」看稳定渠道，不看每版本渠道。**
magpie 设置里有「更新渠道：每个版本 / 稳定版」，用户默认跑后者，插件要跟的也是后者。

```bash
curl -s "https://usemagpie.ai/api/latest?channel=stable" | grep -o '"version":"[^"]*"'
```

实测（2026-10-28）：两档差 **400 多个版本**（每版本 0.1.1763 / 稳定版 0.1.1327），
但把两边内嵌契约都提取出来逐字段比对后 —— **插件相关的字段一条不差**。
多出来的段是 GUI 历史，不是插件契约。⇒ 追每版本几乎全是白跑。

**稳定版版本号变了**，才需要重提取契约（脚手架的 `extract-contract.py`）→
跑 `contract-diff.mjs` → 看差集里有没有「不写会关掉某个能力」的字段。
完整判据见脚手架的
[HOOKS.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/HOOKS.md) 顶部
与 [UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md) 第七节。

---

## 一、先定位你在哪一步

| 你在做什么 | 必读（按顺序） | 做完的判据 |
|---|---|---|
| **改协议 / 接口调用** | [docs/internals.md](./docs/internals.md) 的「三、接口清单」「十二、流式」「十六、上下文窗口」 | 改动在两站（`magicrew` 与 `magicrew-intl`）都验过 |
| **改登录链路** | internals 的「二、三层凭证」「十一、浏览器登录怎么做到全自动」 | 三条登录路径（本机浏览器 / 浏览器登录 / 手填 JWT）都还能登 |
| **改 key / 续期** | internals 的「十三、签新 key 会吊销旧 key」「十四、三层凭据的有效期与保活」 | 没引入第二份 refresh_token（会和 `src/keys.mjs` 分叉） |
| **改模型目录** | internals 的「十六、上下文窗口必须查库」+ HOOKS 十一之二（`free`） | 上下文来自查库；`free` 来自厂商声明，不从 `rate` 反推 |
| **改签到 / 首任务** | internals 的 checkin 小节（一次性闸门、五种状态） | 不漏发、不重发、失败方向是「宁可晚一轮」 |
| **改邀请额度 / 自动换上级 / 邀请码开关** | [src/invite-quota.mjs](./src/invite-quota.mjs) 头（封顶口径 + 白名单 + 触发点）+ [src/store.mjs](./src/store.mjs) 的 `inviteFirstOn` + [tests/invite-quota.mjs](./tests/invite-quota.mjs) / [tests/invite-policy.mjs](./tests/invite-policy.mjs) | **判满只认积分封顶**（人数不是上限）；模式由 `invite-first` 开关决定；国内站默认不切 |
| **代码写完，准备交付** | [CHECKLIST.md](./CHECKLIST.md) 的 **A 表** | A 表全勾 + `node scripts/check.mjs` 退出 0 |
| **要发版本** | **[UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)**（脚手架的，七步） | CHECKLIST B 表全勾 + 四条验证 |
| **用户说「更新了没变化」** | 本文件坑 12（git 源只提示、要手动点更新） | `magpie plugin list` 里的 commit 真的变了 |

**最容易漏的是「要发版本」这一行。** 禁止直接推 main：只能推功能分支，
PR 的 `rules` 检查全绿并合并后，才从与 `origin/main` 一致的提交发布。

---

## 二、本仓库的坑

| # | 症状（出问题时你看到什么） | 判据 | 出处 |
|---|---|---|---|
| 1 | 改好了国内站，国际站用户报同样的错 | **两站是同一个 Go 服务、逐字符同构**，改一处就要两站都验；`SITES.cn` / `SITES.intl` 只是 host 不同 | internals 一 |
| 2 | 国际站 `/v1/chat/completions` 回 `HTTP 500` + 22 字节裸文本（不是 JSON） | 国际站网关**强制**要 `organization-code` 头，缺了就是这个 500 | internals 一 / 五 |
| 3 | 换了 key 之后老 key 立刻失效、用户被要求重登 | **「签新 key 会吊销旧 key」已被实测推翻（2026-10-28）** —— 见下方「最容易误信的旧说法」。仍然只留一把、只走 `src/keys.mjs` 的唯一出口，理由是**本地别分叉**，不是互相吊销 | internals 十四 |
| 4 | 刷新 token 之后两处 refresh_token 不一致、用户莫名掉登录 | 只允许**一个**出口持有 refresh_token；`src/hooks/refresh.mjs` 必须走 `keys.mjs` 的 `renewViaStore()`（0.3.29 起已收敛，与 `ensureKey` 共用 `renewOnce` 锁和同一个 key-store）。若改回自调 `refreshGatewayKey` 就会分叉 | internals 二 / 十四 |
| 5 | agent 说「上下文放不下」，而实际模型能吃更长 | 上下文窗口**必须查 magpie 的模型库**，不能填保守值（早前一刀切 256K，实际 1M） | internals 十六 |
| 6 | 流式回复拿到了，但 `usage` 永远是空、额度不扣 | 流式请求必须补 `stream_options.include_usage`，否则上游不回 usage | internals 十二 |
| 7 | 模型被标成免费、Free first 一直派到它 | `free` 只认厂商声明（`input_points === 0`），**不能从 `rate === 0` 反推**；价格缺失 = 不列，不猜 | internals 十六 · HOOKS 十一之二 |
| 8 | 新号邀请奖励不到账 | 国际站判据是**有没有话题**，不是有没有项目 —— 项目打开工作台就会自动建 | internals checkin 小节 |
| 9 | 一个号天天烧一次模型积分 | 首任务是**每账号一辈子一次**（`isAutoChatSettled`），别改回按日期；失败才重试，最多 3 次 | internals checkin 小节 |
| 10 | 话题接口抖一下，就白花一次积分去补消息 | 查不到判据时**这次不发**、不落标记、不计数 —— 消息发出去花钱且不可撤 | `src/tasks.mjs` 的 `autoFirstChat` |
| 11 | Windows 上点登录，浏览器窗口拉不起来 | 浏览器可执行文件名**随版本变**（`msedge.exe` / Chrome 各版本目录不同），要逐个试候选，别写死一个名字 | internals 十一 |
| 12 | 用户点「检查更新」显示有新提交，点了更新却没变化 | 本仓库是 **git 源**：magpie 比默认分支 HEAD 的 commit，只提示不自动更新，要用户点那一行的「更新」；更新后 `magpie plugin list` 的 commit 应变化 | 脚手架 UPDATING 一 |
| 13 | 想让卡片标题 / 「源码」按钮对，去改了 magpie 的缓存 | 插件对 magpie 目录**只有读的份**；唯一载体是 `registry-entry.json`（提交给 `registry.json`） | internals 二 · README |
| 14 | **卡片上额度正常，路由页里这个号却是「剩余额度未知」** | 窗口**不能标 `aside`**：magpie 的 `allowanceOf()` 把 `Aside`/`Text` 的窗口整条跳过，一条不剩 ⇒ 该号 `Known=false`（官网文档 issue #3650 明写）。判据：`curl -s http://127.0.0.1:3425/v1/magpie/trace`，看这个 provider 的 `known` 是 `true` 还是**字段缺失** | HOOKS 三 · `src/hooks/usage.mjs` 头 |
| 15 | 接 ZCode / Claude Code 系客户端，带工具的请求回 `400 {"error":{"message":"模型响应失败","code":4017}}` | **上游的 `additionalProperties` 只认布尔值，任何对象形态都拒** —— 不只是 `{}`，`{type:"string"}` 这种有约束的 schema 一样 400（两个模型逐行一致）。判据：同一请求只把该字段换成 `true` → 200。改写已在 `rewriteRequestBody` 里做（非布尔一律换 true；**这是降级放宽、会丢约束**，取舍见 internals 十七） | internals 十七 · `tests/body-rewrite.mjs` |
| 16 | 网关路径（agent 从 magpie 的 `/v1` 进来）报 `502 did not stream: token无效`，而 provider 显示已登录 | auth 里没带 org → `accountOf()` 落 `"default"` → 读不到真实账号的 key 槽 → 只能用 `auth.access`，它过了 2 小时就 403。`accountFor()` 已在**恰好一个真实账号**时兜到它；**多账号不猜**（猜错就是拿别人的 key 扣别人的积分） | internals 十四 · 十五 · `tests/account-fallback.mjs` |
| 17 | 单轮回 `400 ... tools.N.function.parameters/properties/functions/items: invalid JSON Schema` | 上游不接受**空 schema 对象**当 `items`：`items:{}` 必 400，`items:{description:"x"}` 却 200。判据：同一请求只删 `items:{}` → 200。改写已做（删 `items:{}` / `true`，**严格等价**；`false` 不动） | internals 十七 · `tests/body-rewrite.mjs` |
| 18 | 某个账号积分耗尽后整轮回 400「可用积分已不足」，其它有余额的账号一次没被问 | **上游用 HTTP 400 报额度耗尽，magpie 的 `retryable()` 400 分支只认 `quotaWords`（不含「积分」「充值」）** ⇒ `hw.failed()=false`，既不走 `!last && hw.failed()` 的换号分支，也不 rest 该账号。插件 `rewriteCreditRefusal()` 把这种 400/422 改写成 402 Payment Required（`tests/credit-refusal.mjs` 锁死）；magpie 侧修复方案见 https://github.com/yetone/magpie/issues/4095 （`retryable()` 的 400 分支补 `creditWords`） | CHANGELOG 0.3.26 |
| 19 | 单轮回 `400 ... tools.N.function.parameters/properties/functions/items: invalid JSON Schema`，但请求里**没有**空 `items` | 上游对 **`items` 子树内部**比根节点严：`anyOf`/`oneOf`/`allOf`/`not`/`const`/`if`+`then`+`else`/`{}` 全 400，**tuple 形式的 `items`（数组）国际站拒**，而同样形态放在顶层 parameters 里 200。命中来源是 **MCP 工具 schema**（REA MCP 7 个工具的 `functions` 数组）。判据：同一请求只把 `items` 子树里的 `anyOf` 摊平 → 200；改完**必须复查没留下空 `{}`**（删 `not`/`const` 会删空）。⚠ **上游 2026-10-29 00:25 起放宽了这层校验（raw 也 200），同一夜里还出现过波动** —— 判要不要改写请看 `_probe/items-subtree-stability.mjs` 的多轮统计，别信单次探针。改写已做（`loosenItemsSchema`，**只动 `items` 子树**、顶层 union 不动） | internals 十七 · `tests/body-rewrite.mjs` · `_probe/items-subtree-upstream.mjs` |
| 20 | 邮箱验证码登录报「phone 字段是必须的」或「captcha 字段是必须的」 | 邮箱和手机是**两套端点**：发信 `/v4/user/send-email` vs `/send-sms`，换登录态 `/v4/user/login-email` vs `/login`；邮箱那条验证码字段叫 **`captcha`**（不是 `code`）。判据：往 `/v4/user/login` 发任何 type 都回「phone 字段是必须的」 | `src/captcha.mjs` 头 · CHANGELOG 0.3.28 |
| 21 | 无头登录「旋转验证连试 4 张图都没过」，而这号本来就是自己的 | 先分清两件事：① **已注册的号服务端根本不出图**（`/captcha/generate` 对已注册账号直接回 `business_token`）—— 所以必须**先取图、再判识图模型**，一上来就 `if (!vision) throw` 会把这条免费通道堵死；② 识图模型 `max_tokens` 太小会把推理答案饿死（`workbuddy/deepseek-v4.1-flash` 给 400 → `content:null`，判官抓空串） | CHANGELOG 0.3.28 · `src/vision.mjs` |
| 22 | 同一账号有的请求 200、有的 403 `token无效`（`retryable=false`），换个时间又好了 | key 有两条签发路径时 store 与 magpie 各存一把，**静态挑一把必有一半踩空**。0.3.29 起 `keyCandidates()` 把 store 两槽 + `auth.access` 逐把打 chat，命中的写回 store；全被拒才交 402 让 magpie 换号。判据：`GET /v1/models` 对死 key **放行**，逐把探活必须用 `/v1/chat/completions` | CHANGELOG 0.3.29 · `tests/key-failover.mjs` |
| 23 | 插件列表里别人有「已自动更新」徽章，magicrew 没有 | magpie 只自动更新包名以 `@magpie-community/` 开头的包（`internal/plugin/updates.go` 的 `Official()` 硬编码前缀）；第三方 npm / git 源永远只提示。本插件用 `src/auto-maintenance.mjs` 复刻：读 `plugin-updates.json` 的 `waiting` → 调 `magpie plugin update` → 成功后补 `updated[]`（徽章读它）。判据：`plugin-updates.json` 的 waiting 有 `package:"Magicrew", git:true`；`findMagpieExe()` 能解析到 magpie 可执行文件。⚠ 网络源（git / npm）更新由 magpie 热加载，`magpie plugin update` 后直接生效，**不需要重启 magpie** | CHANGELOG 0.3.30 · `tests/auto-maintenance.mjs` |
| 24 | 新装插件后没有任何签到记录，`plugin-checkin.json` 里没有 magicrew | magpie 的 `PluginCheckinOn()`：`pluginCheckins` 没有显式值时默认 **false**（只有 WorkBuddy / Trae / MiniMax / Qoder 有内置开关）。插件只能在加载时把 `settings.json` 的 `pluginCheckins[provider]` 补成 true —— **只在键不存在时补**，用户显式 false 不覆盖。判据：`settings.json` 的 `pluginCheckins` 有 `magicrew` / `magicrew-intl` 键 | CHANGELOG 0.3.30 · `src/auto-maintenance.mjs` |
| 25 | 想改「邀请码挂谁」，在登录方式列表里找不到入口了 | **0.3.64 起没有「邀请码」登录方式**（原来那个数字框 0/1 已删）。模式改成供应商编辑器 →「插件选项」→ **「邀请码挂到首选账号」** 一个布开关（关=自动，**跟随最后一个注册成功的新号**；开=挂 magpie 账号页「首选」那个号）。它是 magpie 的 `auth.options`，插件用 `input.magpie.option(provider,"invite-first")` 读，**拨一下立刻生效、不重启 host**。判据：`grep -n "invite-first" index.mjs src/store.mjs`；`node tests/invite-policy.mjs` | CHANGELOG 0.3.64 / 0.3.67 · `src/store.mjs` 的 inviteFirstOn |
| 26 | 想让用户「从账号列表里挑一个当邀请上级」/ 想加第三档「指定任意码」 | **两件都做不了**，同一个根因：magpie 的插件选项**只存布尔**（`settings.PluginOptions map[string]map[string]bool`，`internal/settings/settings.go:276-279`；设置接口 `POST /api/settings/plugin-option` 入参只有 `{Provider, Key, On bool}`，`internal/gui/api.go:1945-1950`；插件侧声明的是 `plugin.Option` + `On bool`，`internal/gui/plugins.go:39-49`）。装不下字符串，也装不下「从 N 项里选一个」。行号核对于本机 magpie **0.1.2145** 的源码快照（`D:\主工作区\tmp\magpie-pr12\magpie-src`，文件名是 `internal_<包>_<文件>.go` 的扁平形式）。（本仓库另有一处 `providers.go:170-187` 的 `Default bool` 说法，讲的是同一件事，以本条为准。）要指定码只能改 `AUTHOR_INVITE` 常量或 `~/.cache/magpie/magicrew-invite-*.json` | CHANGELOG 0.3.64 / 0.3.67 · `src/store.mjs` 的模式注释 |
| 27 | 数字方法的账号列表是空的 / 顺序不对 | 首选来自 `~/.config/magpie/logins.json` 的 `first`（Make first 写入），账号的码来自 `magicrew-invite-codes-<site>.json`（签到/登录时 `rollInvite` 记录；老用户升级后 config 20s 由 `backfillInviteCodes()` 用 plugin-auth 的 JWT 补）。页面/`page/codes.js` 已在 0.3.36 删除 | CHANGELOG 0.3.40 · `src/store.mjs` |
| 28 | 验证码登录成功，却报「登录成功但拿不到组织码」，探测里 `auth-status/裸: code 3102 用户尚未创建账号` | 这不是令牌错，是**该号在用户中心登录成功、Magic 里还没用户/组织**。0.3.44 起 `finishCodeLogin` 在「组织探测为空且见过 3102」时自动建首个组织：`POST {keewood}/v4/user/organizations`（`{name:"个人组织", industry_type:"其他", register_code:<邀请码>, logo:{}}`）→ `GET auth/status` + `Organization-Code` 绑定。接口在 **keewood 用户中心**（不是 magic-service），`authorization` 是**裸 access_token**（加 `Bearer` 会被 nginx 401）；邀请码 2152 时改走 `/v4/users/organizations/create`。⚠ 建组织成功可能回 `{code:1000,message:"请求成功",data:[]}`——**1000 但没组织码**，0.3.45 起会重新探测组织列表（0/1.2s/3s 三次）而不是直接报错。判据：`tests/code-login.mjs` 的 ⑥b 八条；真机端点：无效邀请码回 `{"code":2152,"message":"邀请码错误"}`、`check-create` 回 `{"code":1000,"data":{"result":true}}` | CHANGELOG 0.3.44/0.3.45 · `src/headless.mjs` |
| 29 | 验证码 `/captcha/verify` 回 `2000 客户端信息不匹配` | `/captcha/generate` 会回 `set-cookie: acw_tc=…`（阿里云 WAF），verify 必须把同一个 cookie 带回去；Node fetch 默认没有 cookie 罐，前端浏览器天生带所以看不出来。0.3.44 起 `src/captcha.mjs` 自带按 origin 的 cookie 罐。判据：`tests/code-login.mjs` 的「generate 的 set-cookie 会带回 verify」；真机不带 cookie 回客户端信息不匹配、带上后变成按角度判的「验证不通过」 | CHANGELOG 0.3.44 · `src/captcha.mjs` |
| 30 | 国际站没代理时「刚报错，短信才到手机」/ 浏览器登录 5 分钟就判失败 | 默认 20s HTTP 超时对跨国链路太短，`send-sms` 会在服务端已发信、客户端已超时之间错位。0.3.49 起 keewood HTTP 统一 90s；浏览器登录等待国际站 15 分钟（国内 5）；Edge 调试端口/启动等待 20s/30s。判据：`grep -n "90_000" src/captcha.mjs src/headless.mjs`、`grep -n "browserWaitMs" src/hooks/methods.mjs` | CHANGELOG 0.3.49 · `src/captcha.mjs` / `src/headless.mjs` / `src/hooks/methods.mjs` |
| 31 | 登录方式按钮上挂着旧的「上级 xxx」，改了邀请码策略 / 切首选也不变 | **magpie 在插件加载时把 `methods[].label` 读走并缓存**，之后重新算也不会重新展示（不是写死常量）。0.3.51 起 labels 只放稳定文案；动态的「本次邀请上级」放 `authorize` 返回的 `instructions`（每次点登录现算）。判据：`tests/code-login.mjs` 断言 labels 不含「上级」；`tests/invite-policy.mjs` 固定/auto 都不带 | CHANGELOG 0.3.51 · `src/hooks/methods.mjs` |
| 32 | 额度里没有「邀请额度」，或首选模式满额以后新号还挂在封顶号名下 | 上游 `/api/v1/invitations/info` **只给已邀人数、不给上限**（17 条候选路径全 404），唯一的硬上限是**邀请积分封顶**（国际 10,000 / 国内 60,000）。0.3.64 起额度窗口显示 `邀请额度 20 人 · 4,000 / 10,000 分`（`aside`，**不给 limit**，否则被当额度算占比）；开关开着时封顶就自动把上级换成「真实邮箱 + 未封顶 + 剩余额度最多」的号，只改 `magicrew-invite-policy-<site>.json`，**不动 `logins.json` 的 `first`**；触发点是插件加载 20s / 签到 / 登录成功，10 分钟节流。判据：`node tests/invite-quota.mjs` |
| 33 | 真实注册 + 做完 8 个任务 + 发了对话，两边都没到邀请奖励，怀疑上游取消了 | **先看批次，别下结论**。奖励记录的 `scheduled_at` 是**日期**（`2026-10-30 00:00:00`，日期粒度、可回溯），不是发放时刻；同一批能覆盖当天中午之后注册的号。实测 2026-10-30：全账号 25 笔奖励只分布在 10-27(5)/10-28(7)/10-29(13)，**当天批次 0 笔** → 当天没到账是批次没跑，不是机制停了（停了的话前一天就该是 0）。判据：`~/.cache/magpie/bun/1.4.4/magpie-bun.exe ./_probe/invite-today-batches.mjs` |
| 34 | 拿 `/api/v1/invitations/info` 的 `invite_count` 当「名额用完了」，据此换上级或喊「那个满了」 | **人数不是上限**（2026-10-30 实测推翻）：该接口没有 limit 字段、也没有「名额已满」错误码；官方文案讲的是**积分**封顶。反例：国际 `1451895195@qq.com` 已邀 **54 人**（> 折算的 50），10-29 批次仍照常结算。且**注册不发分**，被邀请人完成首任务/对话才发，所以「54 人 / 10 笔」是常态。判据：`node tests/invite-quota.mjs` 的「人数到顶但积分没封顶 → 不满」 |
| 35 | 额度卡片上显示 `-1` / `-31` / `-153 积分`，用户以为「邀请注册的号积分被清空 / 变成负数了」 | **上游真的给负数**（2026-10-30 逐字段核对）：`GET /api/v1/quota/points/total` 原样回 `"total_points":-31`（number，不是字符串、没有单位），与 `quotas.json` 里存的一致 —— 既不是把「已用」读成「剩余」，也不是解析错；流水接口仍 `500`，逐笔扣费拿不到。**与邀请注册无关**：国内 0 邀请的号也负、国际 54 邀请的号是 +107。0.3.65 起窗口 `balance` 钳到 0、文案写「已欠费 N 积分」（0 写「已耗尽」）、顶层 `balance` 不再吐负数；读不到（缺字段 / `null`）返回 `error` 而不是 0。判据：`node tests/negative-balance.mjs`；真机复核 `node _probe/points-ledger.mjs` 看不到流水（500）就说明只能靠余额变化 | CHANGELOG 0.3.65 · `src/api.mjs` 的 `parsePointsValue` · `src/hooks/usage.mjs` 头 |
| 36 | 新号注册完，八个新人任务当天没补上，要等第二天签到；或者反过来——登录后补任务把登录卡住几十秒 | 0.3.66 起四条登录路成功那一刻都会 `kickoffOnboarding()` → 后台触发 `runCheckin`（pending 过滤 + `first_ai_work` 走消息通道 + 其余 7 项 PUT 全在它里面，不要另写一份）。**绝不能 await**：8 项 × 400ms + 建项目 + 等结算最坏几分钟，await 就是「点登录没反应」。登录补任务会和每日签到抢同一个账号 ⇒ `runCheckin` 有进程内锁（键是 `host|org`，不是 `org`——宿主一个进程跑所有账号，只用 org 会两站串号），撞上直接返回 `done`。判据：`node tests/onboarding-kickoff.mjs`（fire-and-forget、callback < 1s、连跑两轮 0 次重复 PUT、并发两轮只跑一轮） | CHANGELOG 0.3.66 · `src/hooks/methods.mjs` 的 `kickoffOnboarding` · `src/tasks.mjs` 的 `runCheckin` |

**坑 14 的两个附带判据**（都实测过）：

- **只有直接改「已安装副本 / 本地路径源」的代码才需要让 host 重新加载** —— 那是本地文件，
  不经过 magpie 的网络更新流程；从 git / npm 网络源更新会自动 Restart 插件 host，
  对用户就是热加载，不需要重启 app。若确实改了本地副本，重新加载 host 后
  `curl /v1/magpie/quotas` 看窗口里的 `spans`：
  `[{}]` = 没标 aside，`[{"aside":true}]` = 还标着。
- **额度读取有 1 分钟缓存**，改完立刻看可能还是旧值。

补充一条最容易误信的旧说法：

| 症状 | 判据 | 出处 |
|---|---|---|
| 以为 checkin 会「顺带续 key」 | **从来没有**。`src/hooks/checkin.mjs` → `src/tasks.mjs` 全链路没 import 过 `ensureKey`；保活由 magpie 按 `refreshLead` 主动调 `auth.refresh` | internals 十四 · CHANGELOG 0.x |
| 以为「签一把顶一把」、`key-store` 里的 key 会「时间没到就被顶掉」 | **已实测推翻（2026-10-28）**：同账号两把相隔 67 秒签的 key 同时有效；12 把 key 逐把探活，403 **全部**对应 `expiresAt` 已过（剩 -173～-541 分），没有一个「时间没到就失效」的样本。仍只留一把、只走唯一出口的理由是「本地别分叉」，不是「互相吊销」。据此加「跨账号挑活 key」的兜底 = 把别人的 key 交出去 | internals 十四 · 十五 |

---

## 三、命令

```bash
# 合规检查（脚手架里的脚本，直接指到本仓库）
node ../magpie-plugin-scaffold/scripts/check.mjs .

# 两站都要能跑：真实登录态在 ~/.cache/magpie/magicrew-session-<siteId>.json
#   siteId = magicrew（国内） / magicrew-intl（国际）
# 探针脚本必须放进仓库目录用 magpie 自带的 bun 跑（node 连不上国际站域名）：
~/.cache/magpie/bun/1.4.4/magpie-bun.exe ./_probe/xxx.mjs

# 打包面预演
npm pack --dry-run

# 发布（包内 name 是 Magicrew，npm 包名是 magicrew-auth）
npm run publish:npm

# Release：本仓库没有 .github/workflows，必须手工建
git tag v0.3.16 && git push origin v0.3.16
#   然后 POST /repos/MYCF711/magpie-magicrew-auth/releases
```

---

## 四、两个交付门

**门 1 · 代码交付**

```
□ node ../magpie-plugin-scaffold/scripts/check.mjs . 退出码 = 0
□ CHECKLIST.md 的 A 表全勾
□ 改动涉及的站点都跑过（国内 / 国际，别只验一个）
```

**门 2 · 发布**

```
□ CHECKLIST.md 的 B 表全勾（七步）
□ 四条验证：npm view magicrew-auth version / tarball 内容 / magpie plugin list / Release 在
```

⚠ 没过门 2 不许说「已发布」。

---

## 五、文档地图

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| [README](./README.md) | 用户看的门面：功能、模型、安装 | 改用户可见行为时 |
| [docs/internals.md](./docs/internals.md) | 17 章实测：两站同构、三层凭证、接口清单、协议要点、工具 schema 兼容 | 改代码前按章查 |
| [CHANGELOG.md](./CHANGELOG.md) | 每版一节 | 写新版本时 |
| [CHECKLIST.md](./CHECKLIST.md) | 两张勾选表 | 两个交付门 |
| 脚手架 [AGENTS.md](../magpie-plugin-scaffold/AGENTS.md) | 通用坑（九项清单、三条铁律、check 能查什么） | 第一次接触这个插件族时 |

---

## 六、这份文件的维护规矩

1. 任何一次「不报错、要几小时才找到」的坑，收工前在第二节加一行（症状 → 判据 → 出处）。
2. 第二节只放一句话判据，论证留在 `docs/internals.md`。
3. 判据要能当场验证（命令、字段、界面现象），写不成判据的是感想。
