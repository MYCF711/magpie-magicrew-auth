# 超级麦吉 / MagiCrew for magpie

**一个包，两个供应商：国内的 GLM / DeepSeek / Qwen / Kimi，国际再加 Claude / GPT / Gemini —— 原样走它的 OpenAI 兼容网关。**

超级麦吉（`letsmagic.cn`）和 MagiCrew（`magicrew.ai`）是同一产品的两套云。这个插件把它们各接成一个独立供应商 —— 在 magpie 的供应商列表、用量概览、模型目录里各占一行，不聚合、不互相覆盖登录态。

```
国内   超级麦吉   www.letsmagic.cn     GLM / DeepSeek / Qwen / Kimi / MiniMax / MiMo / 豆包
国际   MagiCrew   www.magicrew.ai      上面全部，再加 Claude / GPT / Gemini
协议   OpenAI Chat Completions —— 原生，不是翻译出来的
计费   积分（预充值，不是月度配额）
凭证   登录一次 30 天全自动：api_key 两小时自续，refresh_token 自滚
```

> 上面那排是 2026-10-27 从两站 `GET /api/v1/flows/models` 拉下来核对的。清单会随订阅档位和平台上下架变 —— 所以插件里**没有一张写死的模型清单**，账户能选什么就显示什么。

> **改代码 / 发版本之前**：先看 [AGENTS.md](./AGENTS.md) —— 按「你在哪一步」给阅读顺序，
> 外加本仓库 13 条**会静默出错**的坑（症状 → 判据 → 出处）。交付与发版逐条走
> [CHECKLIST.md](./CHECKLIST.md) 的两张表。
> 发布是**七步**，`git push` 只是第 4 步。

---

## 功能

- **两个供应商分得开** —— 国内、国际各一行，图标、名字、模型、积分、登录态全部独立
- **本机浏览器登过就直接认** —— 你平时那个 Edge / Chrome / Brave 里登过 magicrew，点登录时插件读它的 localStorage 接上：不开窗口、不用重登
- **模型跟着账号走** —— 每次登录后按 `/api/v1/flows/models` 实时拉，账户当前能选什么就展示什么，生图和 embedding 不会混进来
- **积分算得准** —— 余额读的是 `/api/v1/quota/points/total`；空号就显示空，不会被优先派活
- **登录一次管 30 天** —— 网页 JWT 顶 30 天，`mgw_` api_key 每 2 小时自续，refresh_token 每次续期时自滚
- **点一下，全自动** —— 插件自己拉起浏览器停在官方登录页，你在里面登（手机号 / 密码 / Google / 邮箱验证码 / 飞书 / 钉钉都行），登录完成那一刻它自己把凭据读走，不用回来点任何东西
- **登录方式还有两条备选** —— 手机号+密码走 API；或者直接粘 JWT + 组织码
- **新手奖励自动领** —— 国内站 8 项里 7 项 PUT 即到账，每天跑一次幂等
- **邀请码自动滚** —— 第一次注册带作者的码，之后每次登录都记住「上一个登录账号」的码，拿到新的就覆盖旧的

---

## 模型

**国内的 GLM、DeepSeek、Qwen、Kimi、MiniMax、MiMo、豆包；国际站再加 Claude、GPT、Gemini 三家。**

登录后按账号实时拉 `/api/v1/flows/models`，账户能选什么就显示什么 —— 下表只列各家**最新**和**热门**的那几款：

| 发行商 | 最新 / 热门 | 上下文 | 国内 | 国际 |
|---|---|---|---|---|
| GLM（智谱） | `glm-5.3` · `glm-5.3-flash` | 1M · 256K | ✓ | ✓ |
| DeepSeek | `deepseek-v4.1-flash` | 1M | ✓ | ✓ |
| DeepSeek | `deepseek-v4-pro` | 128K | — | ✓ |
| Qwen（阿里） | `qwen3.8-max` · `qwen3.7-plus` | 1M | ✓ | ✓ |
| Kimi（月之暗面） | `kimi-k3.1-pro` | 1M | ✓ | ✓ |
| MiniMax | `minimax-m3` · `minimax-m3.1-flash` | 1M | ✓ | ✓ |
| MiMo（小米） | `mimo-v2.6-pro` · `mimo-v2.6-flash` | 1M | ✓ | ✓ |
| 豆包 Seed（字节） | `doubao-seed-2.0-pro` · `doubao-seed-2.0-code` | 256K | ✓ | ✓ |
| Claude（Anthropic） | `claude-haiku-5.5` | 1M | — | ✓ |
| GPT（OpenAI） | `gpt-6-luna` · `gpt-5.4-mini` | 1.05M · 400K | — | ✓ |
| Gemini（Google） | `gemini-3.7-flash` | 1M | — | ✓ |

全量（含生图、向量、各家历史版本）不进 README —— 装好以后模型选择器里看到的才是账号真实的全部。

用的是 `/api/v1/flows/models`（网页模型选择器里眼睛能点到的那些），不是 `/v1/models` —— 后者混着 VIP 锁定、生图、embedding，塞进来用户会选到根本调不动的模型。

上下文按三档取：magpie GUI 里手选 > 模型库（`~/.cache/magpie/models.json`）> 兜底 1M。这两个接口都不返回 `context_length`；早先一律填 256K，把 `deepseek-v4.1-flash` 真实 1M 的窗口砍成四分之一，agent 反而更早拒绝 —— 根因与取舍见 `docs/internals.md` 第十六节。

推理模型会吃 `max_tokens`：`glm-5.3-flash` 给 64 个 token 时 `reasoning_content` 就吃满、`content` 是空串。插件把低于 512 的 `max_tokens` 抬到 512。

两站不是简单叠加：国际站多出 Claude / GPT / Gemini 三家，另有豆包 Seed 1.8 / 2.0-mini / seed-code、Kimi K2.6 / K2.7-code / K3、GLM 5.2、Qwen3.7-max 这些国内没有的档位。

---

## 新手奖励

国内站 8 项任务合计 500 积分，7 项 PUT 一次就完成（实测 1240 → 1540，+300，六项当场入账）。只有「完成第一次 AI 工作」那项服务端认死必须真的跑过一次，PUT 回 `9303`。

国际站 `/api/v1/onboarding/tasks` 现在返回空列表 —— 接口在，这个账号没东西可领。

每天跑一次，幂等。

---

## 邀请码

只一条规则，不需要你选任何东西：

```
① 固定位置有记录 → 用记录里那个
② 没有记录     → 用作者的码
③ 登录成功后   → 查这个账号自己的码 → 覆盖写回
```

效果：第一次注册带作者的码，之后每次都用「上一个登录成功的账号」的码，一路滚下去。

固定位置：

```
~/.cache/magpie/magicrew-invite-<站点 id>.json      {"code":"...","at":"..."}
```

> ③ 不是每次都能成。`/api/v1/invitations/info` 只认带 `device_id` 的 JWT —— 同一个账号同一时刻签的两把，差别就在这一个字段：桌面客户端 438 字符（`device_id` = 64 位 hex）能拿到码，网页版 350 字符（`device_id` 空）回 `2155 用户不存在`。
> 密码登录走 API、带 device 指纹，滚得动；浏览器登录拿到的是网页那把，滚不动 —— 那就保留旧值，不报错、不挡登录。

奖励口径（上游前端常量，2026-10-27）：

| | 每次注册 | 每次订阅 | 邀请注册封顶 | 总额封顶 |
|---|---|---|---|---|
| 国内 | 1,000 | 3,000 | 60,000 | 300,000 |
| 国际 | 200 | 500 | 10,000 | 30,000 |

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `magicrew`，点**安装**（npm 上的包名是 `magicrew-auth`）。

装完选站点，然后**点第一个「浏览器登录」**。它先看你平时用的那个浏览器：

**① 那边已经登录过 magicrew** → 插件直接读它的 localStorage 接上，**不开窗口、不用再登一次**。
凭据就明文躺在 `Local Storage/leveldb` 里（Edge / Chrome / Chromium / Brave / 360 / QQ / 搜狗 都行）。

**② 没登录过，或者这个账号已经加过** → 插件自己拉起一个窗口：

1. 浏览器窗口弹出，停在官方登录页
2. 用你平时的方式登进去（手机号 / 密码 / Google / 邮箱验证码 / 飞书 / 钉钉都行）
3. **登录完成那一刻它自己就接上了** —— 不用回来点任何按钮，不用开 DevTools

原理：插件不是调用系统浏览器，而是自己起一个 Chromium 内核的浏览器（独立 profile +
`--remote-debugging-port=0`），所以登录成功后能用 CDP 在页面上下文里把它自己的
localStorage 读走，拿到 JWT 和组织码，签完密钥就关窗。

**用哪个浏览器？** 按「谁更干净」排，不是按名气：

```
① Chrome / Chromium   自己装的，无企业策略、无强制登录     ← 首选
② 国产 Chromium 系    360 / QQ / 搜狗 / 2345 / 猎豹 / UC / 夸克
③ Edge                垫底（策略最多、最容易被拦住调试端口）
```

前一个起不来（策略禁用调试端口、启动就退出）会自动换下一个，
**第一个真正打开调试通道的才算数**，不用你操心。
窗口标题/提示里会写明这次用的是哪个。

**每次登录都是一个新的 profile，用完就删。** 这是必须的：共用一个 profile 的话，
添加第二个账号时窗口一打开，页面里已经躺着上一个账号的凭据 —— 插件会以为登录完成、
立刻关窗，而 magpie 拿到的还是旧账号（同账号 → 替换，不新增）。

> **为什么两条路都要？** magicrew 没有 OAuth 回调通道 —— 登录类型只有 13 种、全是「拿凭据换 token」，没有设备码、没有插件授权、没有一次性 ticket。凭据只可能落在两个地方：你自己浏览器的 localStorage（插件读文件就能拿到，所以优先），或者插件自己起的那个窗口（读不到时才需要）。
>
> 本机没有任何 Chromium 内核浏览器时自动降级：改用系统浏览器打开，登录完把凭证送进剪贴板，插件从剪贴板读。

不想碰 Console 的话，另外两条：

- **密码登录** —— 手机号 + 密码 + 区号，走 API，全程在 magpie 里
- **登录态（JWT + 组织码）** —— 手填两个字段：

```
DevTools → Application → Local Storage → https://www.magicrew.ai
  MAGIC:user:authorization     → JSON，取 value     = JWT
  MAGIC:user:organizationCode  → JSON，取 value     = 组织码（12 位小写字母数字）
```

> 组织码**不能从 JWT 推**。JWT 里只有 `cus.tenant_id`（18 位数字），组织码是另一套短串。缺了它 `/api/v1/*` 回 `2182 用户所在组织不存在`，给错了回 `3035 登录失败`。

### 命令行

```bash
# npm（推荐：magpie 按 version 检测更新，有新版本会提示）
magpie plugin add magicrew-auth

# 从仓库源码（拿最新提交，不走 npm；更新按 commit，要手动 update）
magpie plugin add github:MYCF711/magpie-magicrew-auth
```

> **两条路的卡片标题不一样**：npm 装 → 卡片标题就是包名 `magicrew-auth`；git 装 → 取 `package.json` 的 `name`，也就是 **`Magicrew`**。功能一样，只是标题。
> 从旧包名 `magpie-magicrew-auth` 过来的，先 `magpie plugin rm magpie-magicrew-auth` 再装。

装完确认：

```bash
magpie plugin list
# magicrew-auth  on
#   magicrew (超级麦吉, 27 models)  signed in as ...
#   magicrew-intl (MagiCrew, 49 models)  signed in as ...
```

两个供应商各一行 —— 这就是「不聚合」的样子。

---

## 常见问题

**两个站要装两次吗？** 不用。一个包导出两个插件，装一次两个供应商都在，各自登录。

**我在自己浏览器里登了 magicrew，插件能自动认出来吗？** 能。点「浏览器登录」时插件先去本机 Edge / Chrome / Chromium / Brave / 360 / QQ / 搜狗 等浏览器的 localStorage 里找**这个站点**的登录态，找到就直接接上，不弹窗口。读不到、或者这个账号已经加过，才会开窗口让你登新的。

**点了「浏览器登录」，网页上明明登好并跳到 agent 界面了，magpie 里却一直转圈等？** 0.3.12 及更早会这样：插件拉起浏览器的判断依赖一个写死的文件名 `msedge.exe`，而有些机器上微软落盘的名字是 **`Microsoft Edge.exe`**（带空格、带大写；落盘名随安装方式和版本变），于是每次都判定「本机没装浏览器」，永远走「让你去 Console 粘一行」的降级路径 —— 而你不知道有这一步。0.3.15 起：两种落盘名都认、把 360 / QQ / 搜狗 等国产 Chromium 也纳入候选、并且逐个试启动（第一个真能开调试通道的才用）。判据在 `~/.cache/magpie/magicrew-login-<站点>.log`，出问题先看它最后一行。

**添加第二个账号时，网页闪一下就关了、magpie 里也没多出账号？** 0.3.5 及更早会这样：登录浏览器复用同一个 profile，第二个窗口一打开就读到上一个账号的凭据，于是立刻「登录成功」并关窗 —— 加到的是已有账号。0.3.6 起每次登录用一个一次性 profile（关窗即删），不会再串号。

**npm 上叫 `magicrew-auth`，为什么卡片显示 `Magicrew`？** 卡片标题取包内 `package.json` 的 `name`（`Magicrew`），而 npm 拒绝含大写字母的新包名。发布时用 `publish-npm.mjs` 临时换成 `magicrew-auth`、发完还原 —— 所以 npm 页面是小写包名，git 源装出来是 `Magicrew`。功能完全一样。

**为什么模型列表会变？** 因为清单是从 `/api/v1/flows/models` 实时拉的。订阅档位变了、平台方上下架变了，清单就跟着变 —— 插件里没有需要维护的模型表。

**国际站 `/v1/chat/completions` 报 500，22 字节的纯文本？** 那是缺 `organization-code` 请求头。国内站不需要，国际站强制。插件按站点自动带。

**`glm-5.3-flash` 回复是空的？** 推理 token 吃满了 `max_tokens`。插件已经把低于 512 的抬到 512；还是空就把 `max_tokens` 再调大。

**Android / macOS 也支持吗？** 插件只调 HTTP 接口，跟客户端无关。设备上能登录，这里就能用。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [dtyq/magic](https://github.com/dtyq/magic)（Apache 2.0 + 附加限制） | 接口契约：`types/login.ts` 的 `invite_code`、`LoginService.ts` 关于「邀请码在创建组织时消费」的注释、`constants/api.ts` 的错误码 |
| [@magpie-community/opencode-workbuddy-auth](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)（MIT） | 「一个包导出多个 `XxxAuthPlugin`」的写法：每个站点一个具名导出，各成一个供应商 |
| [@magpie-community/opencode-qoder-auth](https://github.com/magpie-community/plugins/tree/main/packages/qoder)（MIT） | 同上，四站点四导出的对照例 |
| [magpie-plugin-template](https://github.com/MYCF711/magpie-plugin-template)（MIT） | README / CHANGELOG / NOTICE 的骨架与硬规则 |

本插件不复制上游代码，只调它的公开 HTTP 接口。完整版权声明见 [`NOTICE.md`](./NOTICE.md)。

---

> 更新记录：[`CHANGELOG.md`](./CHANGELOG.md)

## 许可

MIT。
