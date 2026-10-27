# 超级麦吉 / MagiCrew for magpie

**一个包，两个供应商：国内 27 个模型、国际 49 个模型，原样走它的 OpenAI 兼容网关。**

超级麦吉（`letsmagic.cn`）和 MagiCrew（`magicrew.ai`）是同一产品的两套云。这个插件把它们各接成一个独立供应商 —— 在 magpie 的供应商列表、用量概览、模型目录里各占一行，不聚合、不互相覆盖登录态。

```
国内   超级麦吉   www.letsmagic.cn     27 个账号可选模型
国际   MagiCrew   www.magicrew.ai      49 个账号可选模型
协议   OpenAI Chat Completions —— 原生，不是翻译出来的
计费   积分（预充值，不是月度配额）
凭证   登录一次 30 天全自动：api_key 两小时自续，refresh_token 自滚
```

> 数字是 2026-10-27 实测：`GET <站点>/api/v1/flows/models` 各拉一遍数出来的。两站列表不一样，而且会随订阅档位变 —— 所以插件里**没有一张写死的模型清单**，账户能选什么就显示什么。

---

## 功能

- **两个供应商分得开** —— 国内、国际各一行，图标、名字、模型、积分、登录态全部独立
- **模型跟着账号走** —— 每次登录后按 `/api/v1/flows/models` 实时拉，账户当前能选什么就展示什么，生图和 embedding 不会混进来
- **积分算得准** —— 余额读的是 `/api/v1/quota/points/total`；空号就显示空，不会被优先派活
- **登录一次管 30 天** —— 网页 JWT 顶 30 天，`mgw_` api_key 每 2 小时自续，refresh_token 每次续期时自滚
- **点一下，全自动** —— 插件自己拉起浏览器停在官方登录页，你在里面登（手机号 / 密码 / Google / 邮箱验证码 / 飞书 / 钉钉都行），登录完成那一刻它自己把凭据读走，不用回来点任何东西
- **登录方式还有两条备选** —— 手机号+密码走 API；或者直接粘 JWT + 组织码
- **新手奖励自动领** —— 国内站 8 项里 7 项 PUT 即到账，每天跑一次幂等
- **邀请码自动滚** —— 第一次注册带作者的码，之后每次登录都记住「上一个登录账号」的码，拿到新的就覆盖旧的

---

## 模型

不写死。上面那张表是**数量**，不是清单：

| 站点 | 可选语言模型 | 网关全量（含生图/向量） |
|---|---|---|
| 国内 · 超级麦吉 | 27 | 44 |
| 国际 · MagiCrew | 49 | 65 |

用的是 `/api/v1/flows/models`（网页模型选择器里眼睛能点到的那些），不是 `/v1/models` —— 后者混着 VIP 锁定、生图、embedding，塞进来用户会选到根本调不动的模型。

上下文窗口统一按 **256K** 保守填：这两个接口都不返回 `context_length`。填大了 agent 要等上游报错才知道越界，填小了自己压得早。

推理模型会吃 `max_tokens`：`glm-5.3-flash` 给 64 个 token 时 `reasoning_content` 就吃满、`content` 是空串。插件把低于 512 的 `max_tokens` 抬到 512。

国际站有 27 个模型是国内没有的：GPT 5.x / 6-luna、Gemini 3.x、Claude Haiku 5.5、Kimi K3 等。

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

在 magpie 的 **插件 → 发现** 搜 `magpie-magicrew-auth`，点**安装**。

装完选站点，然后**点第一个「浏览器登录」** —— 没有任何输入框，插件自己把浏览器拉起来：

1. 浏览器窗口弹出，停在官方登录页
2. 用你平时的方式登进去（手机号 / 密码 / Google / 邮箱验证码 / 飞书 / 钉钉都行）
3. **登录完成那一刻它自己就接上了** —— 不用回来点任何按钮，不用开 DevTools

原理：插件不是调用系统浏览器，而是自己起一个 Edge / Chrome（独立 profile +
`--remote-debugging-port`），所以登录成功后能用 CDP 在页面上下文里把它自己的
localStorage 读走，拿到 JWT 和组织码，签完密钥就关窗。

> **为什么必须自己拉浏览器？** 因为 magicrew 没有 OAuth 回调通道 —— 它的登录类型只有 13 种、全是「拿凭据换 token」，没有设备码、没有插件授权、没有一次性 ticket；也没有 WorkBuddy 那种 `/v2/plugin/auth/state` + `/v2/plugin/auth/token` 协议。网页登录成功后 token 只在 `www.magicrew.ai` 的 localStorage 里，而 magpie 打开的是你系统默认那个浏览器，插件够不到它的存储。自己起一个，就够得到了。
>
> 本机没装 Chrome / Edge 时自动降级：改用系统浏览器打开，登录完把凭证送进剪贴板，插件从剪贴板读。

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
# 从 npm（推荐）
magpie plugin add magpie-magicrew-auth

# 从仓库源码（拿最新代码，不走 npm）
magpie plugin add github:MYCF711/magpie-magicrew-auth
```

装完确认：

```bash
magpie plugin list
# magpie-magicrew-auth  on
#   magicrew (超级麦吉, 27 models)  signed in as ...
#   magicrew-intl (MagiCrew, 49 models)  signed in as ...
```

两个供应商各一行 —— 这就是「不聚合」的样子。

---

## 常见问题

**两个站要装两次吗？** 不用。一个包导出两个插件，装一次两个供应商都在，各自登录。

**为什么国际站的模型数会变？** 因为这个数字是从 `/api/v1/flows/models` 实时拉的。订阅档位变了、平台方开关变了，数字就跟着变 —— 插件里没有需要维护的清单。

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
