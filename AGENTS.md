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
| **代码写完，准备交付** | [CHECKLIST.md](./CHECKLIST.md) 的 **A 表** | A 表全勾 + `node scripts/check.mjs` 退出 0 |
| **要发版本** | **[UPDATING.md](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/UPDATING.md)**（脚手架的，七步） | CHECKLIST B 表全勾 + 四条验证 |
| **用户说「更新了没变化」** | 本文件坑 12（git 源只提示、要手动点更新） | `magpie plugin list` 里的 commit 真的变了 |

**最容易漏的是「要发版本」这一行。** `git push` 只是七步里的第 4 步 ——
本仓库真踩过：0.3.14 只 push，结果 GitHub 右侧「暂无发布版本」、npm 停在 0.3.8。

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
| 23 | 插件列表里别人有「已自动更新」徽章，magicrew 没有 | magpie 只自动更新包名以 `@magpie-community/` 开头的包（`internal/plugin/updates.go` 的 `Official()` 硬编码前缀）；第三方 npm / git 源永远只提示。本插件用 `src/auto-maintenance.mjs` 复刻：读 `plugin-updates.json` 的 `waiting` → 调 `magpie plugin update` → 成功后补 `updated[]`（徽章读它）。判据：`plugin-updates.json` 的 waiting 有 `package:"Magicrew", git:true`；`findMagpieExe()` 能解析到 magpie 可执行文件。⚠ 更新后要重启 magpie 才加载新代码 | CHANGELOG 0.3.30 · `tests/auto-maintenance.mjs` |
| 24 | 新装插件后没有任何签到记录，`plugin-checkin.json` 里没有 magicrew | magpie 的 `PluginCheckinOn()`：`pluginCheckins` 没有显式值时默认 **false**（只有 WorkBuddy / Trae / MiniMax / Qoder 有内置开关）。插件只能在加载时把 `settings.json` 的 `pluginCheckins[provider]` 补成 true —— **只在键不存在时补**，用户显式 false 不覆盖。判据：`settings.json` 的 `pluginCheckins` 有 `magicrew` / `magicrew-intl` 键 | CHANGELOG 0.3.30 · `src/auto-maintenance.mjs` |
| 25 | 邀请上级选完，第二天签到后又变回别的号 | 0.3.40 起登录页「邀请上级」一个数字文本框：0=自动（首次用作者码，之后跟随最后登录 / 签到的滚动码）、1=当前首选账号（magpie 账号页 Make first 的 logins.json `first`）；留空/非法文本回退 0。切首选后重新点 1 取新首选。选中即写 `magicrew-invite-policy-<site>.json`（fixed），`inviteToUse` 优先它；死号自动回落滚动→作者码。判据：`tests/invite-policy.mjs` | CHANGELOG 0.3.40 · `src/hooks/methods.mjs` |
| 26 | 邀请上级的数字文本框有没有「右边实时显示账号」 | magpie 的 `prompts` 只有 `text` / `select`，没有复合控件；提示只有一行「自动=0；首选=1；不填=默认自动」；没有实时右侧显示，保存后回一条「新号挂在首选 X（码）」说明。要真正的右侧实时刷新得等上游加控件 | CHANGELOG 0.3.40 · `src/hooks/methods.mjs` |
| 27 | 数字方法的账号列表是空的 / 顺序不对 | 首选来自 `~/.config/magpie/logins.json` 的 `first`（Make first 写入），账号的码来自 `magicrew-invite-codes-<site>.json`（签到/登录时 `rollInvite` 记录；老用户升级后 config 20s 由 `backfillInviteCodes()` 用 plugin-auth 的 JWT 补）。页面/`page/codes.js` 已在 0.3.36 删除 | CHANGELOG 0.3.40 · `src/store.mjs` |

**坑 14 的两个附带判据**（都实测过）：

- **改了 `src/hooks/usage.mjs` 要重启 magpie 才生效** —— 插件跑在 `magpie-bun` 子进程里，
  模块缓存不随文件变化失效。改完先 `Stop-Process` 再 `Start-Process` 同一个 exe，
  然后 `curl /v1/magpie/quotas` 看窗口里的 `spans`：`[{}]` = 没标 aside，`[{"aside":true}]` = 还标着。
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
