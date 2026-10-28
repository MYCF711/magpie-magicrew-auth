# 实现细节与协议取证

README 里所有「为什么」都在这。取证日期统一是 **2026-10-27**，除非另注。

---

## 一、两站是同一份东西

| | 国内 · 超级麦吉 | 国际 · MagiCrew |
|---|---|---|
| 网页 | `www.letsmagic.cn` | `www.magicrew.ai` |
| 业务 API + 模型网关 | `i-magic-service.letsmagic.cn` | `magic-service.magicrew.ai` |
| `MAGIC_APP_ENV` | `saas-prod` | `international-prod` |
| `MAGIC_APP_SHA` | `fb90a86cd576dd10f25efdf914485a3bfcc0a13d` | **同一个值** |
| `MAGIC_APP_VERSION` | `5.0.157` | `5.0.157` |
| 套餐支付 | ALIPAY | STRIPE |

`MAGIC_APP_SHA` 相同 ⇒ 前端是同一份构建，两站差别只在服务端注入的 `MAGIC_*` 环境变量。
后端是同一个 Go 服务，逐字符同构：

```
GET /                        → hello, magic-service!
GET /v1/models               → {"code":403,"message":"token无效",...}
GET /api/v1/flows/models     → {"code":2179,"message":"auth_token 不存在",...}
```

### 站点地址是怎么找到的

客户端是个纯 webview 壳，`app.asar` 里只有区域枚举和 `WebUrl`，**没有 API 地址**：

```js
const Tp = {
  ChinaRegion:         { WebUrl: "https://www.letsmagic.cn", defaultLocale: zhCN },
  internationalRegion: { WebUrl: "https://www.magicrew.ai",  defaultLocale: enUS },
}
```

真正的地址在**运行时配置注入页**里 —— 任意非营销路由（比如 `/workspace`）返回的 HTML 内嵌了一份 `window` 配置：

```bash
curl -s https://www.magicrew.ai/workspace | grep -o '"MAGIC_[A-Z_]*":"[^"]*"'
```

```json
"MAGIC_SERVICE_BASE_URL": "https://magic-service.magicrew.ai"
"MAGIC_SOCKET_BASE_URL":  "wss://magic-service.magicrew.ai"
"MAGIC_GATEWAY_ADDRESS":  "https://api.magicrew.ai"
```

⚠ **`api.magicrew.ai` 不是这套 API**。它是 `MAGIC_GATEWAY_ADDRESS`（teamshare 网关），
对 `/v1/models`、`/api/v1/*` 一律回 `not match rule path`。它就是那个「看起来最像、
试了才发现全不对」的坑。

国内站同位置是 `i-magic-service.letsmagic.cn`，`MAGIC_GATEWAY_ADDRESS: https://api.teamshare.cn`。

---

## 二、三层凭证

```
网页 JWT       30 天    换密钥、读模型目录和积分
mgw_ api_key    2 小时   真正请求时的 Bearer
refresh_token   7 天     PUT 一次换新的 api_key；每换一次轮换一次
```

```bash
# ① 登录
POST /api/v1/sessions
  { type:"phone_password", phone, password, state_code, organization_code, invite_code }

# ② 签发网关密钥（要 JWT）
POST /api/v1/model-gateway/tokens          → { api_key, refresh_token, *_expires_at }

# ③ 续期（不需要登录态；refresh_token 一次性，必须串行）
PUT  /api/v1/model-gateway/tokens  { refresh_token }
```

`mgw_` key 是**站点绑定**的：国际站的 key 拿去国内站回 `{"code":403,"message":"token无效"}`。

### JWT 的形状

magic 自己那套，不是标准 JWT：每段 base64 **带 `==` 填充**，签名段是 64 位 **hex**（不是 base64url）。

```
header  {"alg":"HS256","type":"JWT"}
payload {"iss":<组织id>,"exp":<30天后>,"iat":<现在>,"jti":<会话id>,
         "cus":{"device_id":"","tenant_id":<18位数字>}}
```

### ⚠ `organization-code` 是另一个东西

JWT 里只有 `cus.tenant_id`（18 位数字，例 `700000000000000001`），而服务端要的
`organization-code` 是另一套 12 位短串（例 `orgcode67890`）。两者不能互推。

这个值在浏览器的 local storage：

```
MAGIC:user:organizationCode      → {"key":"organizationCode","value":"orgcode67890"}
MAGIC:user:teamshareOrganizationCode → 同值
```

错误码分得很清：

| 情况 | 返回 |
|---|---|
| 不带 `organization-code` | `{"code":2182,"message":"用户所在组织不存在"}` |
| 带任意非空值（token 无效） | `{"code":3035,"message":"登录失败"}` |
| 带对的值 + 有效 JWT | `{"code":1000,"message":"ok",...}` |

注意：**带错的码也还是 3035**，和「码对但 token 无效」同一个错误码 —— 所以不能靠错误码判断是码错还是 token 错。

### ⚠ 国际站 `/v1/*` 强制要 `organization-code`

这是两站唯一的网关层差异：

```bash
# 国际站，不带 organization-code
POST /v1/chat/completions
→ HTTP 500  "Internal Server Error."     ← 22 字节纯文本，不是 JSON

# 带上就正常
POST /v1/chat/completions  -H "organization-code: <code>"
→ HTTP 200  {"id":"...","choices":[...]}
```

国内站不需要（一直是 `i-magic-service.letsmagic.cn/v1` 裸调）。
插件在 `loader` 里按 `SITE.needsOrgOnGateway` 决定带不带。

**CORS 预检能问出允许的头名**，这条路对所有站点通用：

```bash
curl -s -X OPTIONS https://magic-service.magicrew.ai/api/v1/flows/models \
  -H "Origin: https://www.magicrew.ai" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization,organization-code" -D - -o /dev/null
```

两站返回的 `Access-Control-Allow-Headers` 完全一致：

```
DNT,Keep-Alive,User-Agent,Cache-Control,Content-Type,Authorization,
application-code,organization-code,x-forwarded-user,token,request-id,
Language,api-key,X-Magic-Image-Process,X-App-Id,X-Timestamp,X-Nonce,X-Sign
```

---

## 三、接口清单（实测）

### 业务 API（要 JWT + organization-code）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/sessions` | 登录；`invite_code` 字段在此 |
| POST/PUT | `/api/v1/model-gateway/tokens` | 签发 / 续期 `mgw_` key |
| GET | `/api/v1/flows/models` | 账号当前可选的语言模型 |
| POST | `/api/v1/products/model-points` | 每个模型的积分单价 |
| GET | `/api/v1/quota/points/total` | 积分余额 |
| POST | `/api/v1/quota/points/records/queries` | 积分流水（注意是 POST，GET 回 405） |
| GET | `/api/v1/onboarding/tasks` | 新手任务列表 |
| PUT | `/api/v1/onboarding/tasks/{code}/completion` | 标记完成；`9303` = 不支持手动完成 |
| GET | `/api/v1/invitations/info` | 自己的邀请码 + 已邀请人数 |
| GET | `/api/v1/invitations/activity` | 邀请活动配置 |
| GET | `/api/v1/invitations/rewards/total-points` | 邀请已赚积分 |

### 模型网关（要 `mgw_` key）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 全量（含生图/向量）；国内 44、国际 65 |
| POST | `/v1/chat/completions` | OpenAI 兼容；国际站另需 `organization-code` |

### `/api/v1/flows/models` 的返回

```json
{"code":1000,"message":"ok","data":{"models":[
  {"value":"mimo-v2.6-flash","label":" MiMo V2.6 Flash","vision":true,
   "tags":[{"type":1,"value":"Magic"}],"configs":{"temperature":0.5}}
]}}
```

`label` 前面常带前导空格，`name` 要 `.trim()`。
**不返回 `context_length`** —— 所以上下文统一按 256K 保守填。

---

## 四、邀请码

### 链接格式

```
https://www.magicrew.ai/?invitation=<code>
https://www.letsmagic.cn/?invitation=<code>
```

上游前端 `constants-BGteNvs6.js` 原文：`a = (e,t) => \`${e}/?${i}=${t}\``，其中 `i = "invitation"`。

### 消费时机

`LoginService.ts` 里那两行注释是全部答案（原文）：

```ts
// PS: 改到在无组织下创建组织的时候再消费邀请码
// values.invite_code = consumeInvitationCookie()
```

⇒ **不是登录那一下生效**，是「该账号还没有组织、这次登录顺手建个人组织」时生效。
老账号组织早就有，传了也不会再记账。

字段名来自 `types/login.ts`：`invite_code?: string`。
错误码 `2152` = 邀请码已被使用（`constants/api.ts`）。

### 接口只认客户端登录的 JWT

同一账号签的两把 JWT：

| 来源 | 长度 | `/api/v1/invitations/info` |
|---|---|---|
| 网页 local storage（354 字符） | 354 | `{"code":2155,"message":"用户不存在"}` |
| 桌面客户端（438 字符） | 438 | `{"code":1000,"data":{"invite_code":"..."}}` |

差别在 payload 里带不带用户字段。所以插件把**上次登录成功的那把 JWT** 落盘到
`~/.cache/magpie/magicrew-session-<siteId>.json`，专供「用我自己的邀请码」这一项；
从没登录过就没文件，选这项直接报错。

### 这个路径是怎么找到的（可复用）

盲试 30 余条候选路径全 404，最后从**客户端缓存**里读出来的：

```bash
C="$APPDATA/Magic/Cache/Cache_Data/data_1"
grep -a -o -E 'https://magic-service\.magicrew\.ai/api/v1/[a-zA-Z0-9/_.-]*' "$C" | sort -u
grep -a -o -E '"invite_code":"[A-Za-z0-9]+"' "$C"
```

Electron 的 `Cache/Cache_Data/data_*` 里留着客户端访问过的全部 URL 和响应体。
**这比扒 JS chunk 有效得多** —— chunk 是按路由懒加载、名字哈希化的；
缓存目录里是「它真的请求过什么」。

同一份缓存里还能顺手捞出别的接口：`/api/v1/settings/all`、`/api/v1/im/messages/page`、
`/api/v1/auth/status`、`/api/v1/notifications/counts` 等 20 余条。

---

## 五、一个包两个供应商

magpie 把包里的**每个具名导出**当成一个独立插件。所以：

```js
export const MagicrewAuthPlugin     = makePlugin(SITES.cn)
export const MagicrewIntlAuthPlugin = makePlugin(SITES.intl)
```

两个 provider id 不同（`magicrew` / `magicrew-intl`），于是：

- 供应商列表里两行
- 用量概览里两张卡
- 模型目录各拉各的
- 登录态各存各的，互不覆盖

对照实现：`@magpie-community/opencode-workbuddy-auth` 用 `makePlugin(site)` 做两个导出
（WorkBuddy / WorkBuddy AI），`opencode-qoder-auth` 用同一个模式做四个导出。

**`auth` 里不存站点**：所有 host 都来自闭包里的 `SITE`。这是这套写法的关键 ——
一旦把站点塞进 `auth`，同一个 provider id 就被两个站抢，登录态互相覆盖。

⚠ `magicrew` 这个 id 不能改 —— 已装的用户靠它认领登录态。

---

## 六、调试

```bash
# 不花钱的自测（config / models / usage / loader 头）
node  tests/multi-provider.mjs
bun   tests/multi-provider.mjs      # magpie 实际跑在 bun 上，用它更准

# 真打一发（会花积分）
MAGICREW_INTL_JWT=... MAGICREW_INTL_ORG=... node tests/smoke.mjs full
```

⚠ **Node 连不上 `magic-service.magicrew.ai`，bun 可以。** 同一台机器、同一个 IP：
`curl` 通、`bun fetch` 通、`node fetch` 与 `node https.get` 一律 `UND_ERR_CONNECT_TIMEOUT`
（TCP 和 TLS 握手都成功，卡在 HTTP 响应）。所以验证一律用 bun 跑，别被 Node 的超时误导。

⚠ **中文请求体别走 shell 内联**：Git Bash 把中文按 GBK 传给 `curl.exe`，服务端按 UTF-8 解，
结果是一律 `HTTP 500 Internal Server Error.`（22 字节纯文本）。看起来像接口挂了，其实是编码。
把 body 写成 UTF-8 文件再 `--data-binary @file`。

`max_tokens` 的实测（`glm-5.3-flash`，中文提问）：

| max_tokens | 结果 |
|---|---|
| 64 | `finish_reason:"length"`、`content:""`、reasoning 吃满 |
| 512 | 正常出话（reasoning 208 / total 233） |

---

## 七、客户端服务地址对照（供以后换站参考）

```bash
curl -s https://www.magicrew.ai/workspace | grep -o '"MAGIC_[A-Z_]*":"[^"]*"'
```

| 变量 | 国内 | 国际 |
|---|---|---|
| `MAGIC_SERVICE_BASE_URL` | `https://i-magic-service.letsmagic.cn` | `https://magic-service.magicrew.ai` |
| `MAGIC_SOCKET_BASE_URL` | `wss://i-magic-service.letsmagic.cn` | `wss://magic-service.magicrew.ai` |
| `MAGIC_SERVICE_KEEWOOD_BASE_URL` | `https://i-keewood-service.teamshare.cn` | `https://keewood-service.magicrew.ai` |
| `MAGIC_SERVICE_TEAMSHARE_BASE_URL` | `https://i-teamshare-service.teamshare.cn` | `https://teamshare-service.magicrew.ai` |
| `MAGIC_GATEWAY_ADDRESS` | `https://api.teamshare.cn` | `https://api.magicrew.ai` |
| `MAGIC_PUBLIC_CDN_URL` | `https://public-cdn.letsmagic.cn` | `https://public-cdn.magicrew.ai` |
| `MAGIC_CDNHOST` | `https://cdn.letsmagic.cn/__assets__/packages` | `https://cdn.magicrew.ai/__assets__/packages` |

## 八、客户端安装包

两站的包**同版本号、不同构建**（sha512 不同，差 104 字节，差的是 `app-update.yml` 那行更新源）：

```
国内  https://cdn.letsmagic.cn/download/latest.yml
      116003728 B  sha512 u7F2Y0c8vUdtEyUvQouQLe4f2uulGgUiD0ye0jOnKUPKNNNYodF5QPI3v3G7jK88FlfqK5vL1CgciSD5Bu136w==

国际  https://public-cdn.magicrew.ai/download/global/latest.yml
      116003832 B  sha512 KqHznUXQLCC6II82JAtY1VxzOFqx/VnEkdrxU0HUZHtUPu7pED9p0LvOD2EtAQJdrY4DthfYnfu2QCqI0oPdvQ==
```

⚠ 路径里必须有 **`/global/`**。`public-cdn.magicrew.ai/download/latest.yml`（不带 `global`）
和 `cdn.letsmagic.cn/download/latest.yml` **逐字节相同** —— 那是国内清单的镜像，
少一个目录名就落到国内包上。这是「从国际站网页下载，装出来是国内版」的原因。

装完自查：

```bash
cat "<安装目录>/resources/app-update.yml"
# 国内：url: https://cdn.letsmagic.cn/download
# 国际：url: https://public-cdn.magicrew.ai/download/global
```

---

## 九、为什么做不到「点一下全自动」

> ### ⚠ 更正（2026-10-28）：这一节原来的结论是**错的**
>
> 原文断言「magicrew 没有这条路」，理由是「登录类型全是拿凭据换 token，没有设备码、
> 没有一次性 ticket」。**真正的错因是找错了域名** —— 登录用的用户中心不在
> `i-magic-service.letsmagic.cn`，而在 keewood：
>
> | 站点 | 用户中心 |
> |---|---|
> | 国内 | `https://i-keewood-service.teamshare.cn` |
> | 国际 | `https://keewood-service.magicrew.ai`（**没有 `i-` 前缀**） |
>
> 换成这个域名，整条链一个 404 都没有：`/captcha/generate` → `/captcha/verify` →
> `/v4/user/send-sms` → `/v4/user/login`，**全程纯 HTTP、不开浏览器**。
> 那个「拖动滑块使图片角度为正」的答案就是提交参数里的 `angle`（加密过的整数），
> 用 magpie 设置里的识图模型判「主体上方向指向钟面几点」就能算出来。
>
> 实现见 `src/captcha.mjs` / `src/vision.mjs` / `src/headless.mjs`，
> 以及登录方法「手机号验证码」。下面保留原文，只为了说明**当时为什么判断错了**。

下面的分析**在换对域名之前**成立，其中「① 13 种登录类型」和「③ 试过的三个端点」
仍然是事实，只是它们不能推出「没有这条路」——真正缺的那个域名当时没找到。


对比 OfficeAce：它能做到「浏览器登录完，magpie 窗口自动继续」，因为华为云 OAuth 的
`redirect_uri` 指向一个**可控的服务**（`${CLAW_BASE}/v1/claw/auth/callback`），
插件轮询那个服务取结果。magicrew 没有这条通道：

**① 登录类型只有 13 种，全是「拿凭据换 token」。**
`frontend/magic-web/src/types/login.ts` 的 `LoginType` 枚举，注释写明「与API强绑定，禁止修改」：

```
phone_password / phone_captcha / email / DingTalk / DingTalkAvoid / wecom /
Lark / LarkRedirect / wechat_official_account / wechat_app / dingtalk_app /
redirect / apple_login / google_login / feishu_oauth
```

没有设备码、没有插件授权、没有一次性 ticket。

**② 没有 WorkBuddy 那套 `/plugin/auth/*` 协议。**
WorkBuddy 的 `browserSignIn` 走的是
`POST /v2/plugin/auth/state`（开登录会话）→ 打开 `authUrl` → `GET /v2/plugin/auth/token?state=`
轮询拿 token。magicrew 这两个端点都不存在。

**③ 试过的三个候选，都不行。**

| 端点 | 结果 |
|---|---|
| `/api/v1/auth/status` | 要 authorization，缺了回 `3103 authorization 不合法` |
| `/api/v1/auth/environment` | `{"code":1000,"data":{"login_code":null}}` —— 有 `login_code` 字段，但没有配套的兑现接口 |
| `/api/v1/aggregation/login-data` | 连不通 |

**④ 网页登录成功后 token 只在 `www.magicrew.ai` 的 localStorage 里。**
插件读不到别的源的存储；`redirect` 字段也不能收任意回调地址（那是第三方登录的 provider code）。

⇒ 能做的最短路径：**开官方登录页 + 把结果送进剪贴板 + 插件读剪贴板**。
剪贴板的读法三平台各一条命令，实测可用：

```js
win32   powershell -NoProfile -NonInteractive -Command Get-Clipboard -Raw
darwin  pbpaste
linux   xclip -selection clipboard -o
```

⚠ `authorize()` 里**不能 await** 读剪贴板 —— 起 powershell 要几百毫秒，而它必须立刻返回。
做法是把「读剪贴板」这个 promise 递下去，`callback()` 里才落地。

⚠ callback 里要拿「打开页面前的剪贴板内容」当 `skip` —— 否则用户上一次复制的东西会被当成结果。

## 十、两把 JWT 的差别（**不构成权限差别**）

同一账号签的两把，段数都是 3、header 都是 `{"alg":"HS256","type":"JWT"}`，签名段都是 64 位 hex。
唯一的差别是 `cus.device_id`：

| 来源 | 长度 | 各段 | `cus.device_id` |
|---|---|---|---|
| 桌面客户端 / `POST /api/v1/sessions` 带 `device` | 438 | 40 / 332 / 64 | 64 位 hex |
| 网页 localStorage | 354 | 40 / 244 / 64 | `""` |

### ⚠ 更正（2026-10-27，实测推翻前一条结论）

**这里原先写着「网页那把不被网关接受，一律 2155 用户不存在」—— 那是错的。**

错因：当时手里那把网页 JWT 已经过期（`iat` 是几小时前，中途在同一账号上登录过多次，
服务端按 `jti` 只认最新会话）。换一把新鲜的重新测：

```
网页 token（354 字符，cus.device_id 为空）
  /api/v1/quota/points/total        → 1000 ok, total_points 1538
  /api/v1/invitations/info          → 1000 ok, invite_code IVC8BAWYXRY1
  /api/v1/flows/models              → 1000 ok, 27 个
  /api/v1/model-gateway/tokens      → 1000 ok, 签出 mgw_ key
```

四条全通。**`device_id` 为空不构成任何限制**，两种 token 权限完全一样。

⇒ 「登录后把自己的邀请码滚上去」这件事，网页登录也滚得动。实现里那句
「滚不动就保留旧值」的兜底仍然留着（网络抖动、token 过期都会让那一次失败），
但不再是常态。

教训：**判断 token 失效要看 `iat` / `jti`，不要只看一个字段就下结论。**
`2155 用户不存在` 同时可能是「token 过期」和「组织码不对得上」，先确认手里这把是不是新的。

---

## 十一、浏览器登录怎么做到全自动

### 先说不能用 `opened: true` 的地方

`opened: true` 的语义是「**我已经自己把页面开出来了，你别再开**」（HOOKS.md 陷阱 3，
原文场景是 Grok 的 CLI 自己开页面）。所以：

| authorize 里做了什么 | 该传什么 |
|---|---|
| 只返回 url，让 magpie 去开 | **不传** `opened` |
| 自己 spawn 了浏览器 | `opened: true` |

传错的后果很具体：**点了登录，什么都不弹**。本项目 0.2.0 的中间版本踩过这个坑 ——
密码登录和浏览器登录都传了 `opened: true`，两处都点了没反应。

### 先读本机浏览器（首选路径，2026-10-27 加）

magicrew 没有 OAuth 回调（第九节），所以「用户在自己浏览器里登录完了」这件事，插件原本
只能靠「自己起的那个窗口」知道 —— 于是常有人报「网页登了、magpie 里却没多出账号」。
其实凭据就在本地：Chromium 系把 localStorage 明文写在

```
<User Data>/<Default|Profile N>/Local Storage/leveldb/*.log|*.ldb
```

读法（`src/local-browser.mjs`）：

```
leveldb 目录全部读成 latin1 文本
  → 以站点 host 出现的位置开窗（2000 字节）
  → 窗口内取 `"key":"authorization"` 的 jwt、`"key":"organizationCode2?"` 的组织码
```

三个必须注意的点：

1. **按 origin 截断**，否则串号：两个站点的记录可能紧挨着（用户两个都登过），窗口会把
   国际站的 org 配到国内站的 jwt 上。截断点 = 下一个**不同站点**的 origin（同 origin 的
   多条记录不截断）。
2. **每把 jwt 配它自己后面的那个 org**，不要配「窗口里第一个 org」—— 同一站点存过多把
   凭据时（旧值还没被 compaction 掉）会配错。
3. **过期、空组织码直接丢**；多把有效凭据取 `iat` 最大的。

实测（2026-10-27，本机 Edge）：**27 MB / 29 ms**，`www.letsmagic.cn` 命中、
`www.magicrew.ai` 不命中（没在那里登录过），两站不串。

读到之后还要防「重复加号」：`~/.cache/magpie/magicrew-orgs-<站点>.json` 记着**加过的 org**，
命中就不再自动接 —— 用户点登录多半是想加新账号，自动接上同一个会被 magpie 按
「同 accountId + uid → 替换旧账号」处理掉，看起来又像「没加上」。

判据：`node tests/local-browser.mjs`（两站分离 / 过期过滤 / iat 取最大 / org 配对 /
knownOrgs 去重）。真机：`node tests/smoke.mjs` 仍能跑通（凭据从同一个地方读）。

### 自己拉浏览器 + CDP 读凭据

```
launchLoginBrowser(url)
  → browserCandidates()    按优先级列出候选，逐个 existsSync 过滤出真实存在的
  → 对每个候选依次 launchOne()：
      spawn(exe, [
        --user-data-dir=~/.cache/magpie/magicrew-login-<pid>-<ts>-<rand>,   ← 一次性，见下面 ②
        --remote-debugging-port=0,      ← 0 = 让系统挑空闲端口
        --no-first-run, --no-default-browser-check,
        url,
      ])
      等 <user-data-dir>/DevToolsActivePort 出现，第一行是端口
      ├─ 拿到端口 → 就用它，返回 { port, dir, child, name, exe }
      └─ 没拿到   → 杀进程 + 删目录，换下一个候选
  → 全部失败才抛错，错误里带每个候选的失败原因
```

⚠ 启动前**必须删掉** `DevToolsActivePort` —— 上一次残留的文件会让 `waitPort` 立刻
返回一个已经失效的旧端口。

#### 浏览器优先级（0.3.15，按「谁最干净」而不是名气）

```
① Chrome / Chromium   自己装的，无企业策略、无强制登录、无侧边栏  ← 首选
② 国产 Chromium 系    360 / QQ / 搜狗 / 2345 / 猎豹 / UC / 夸克 —— 用户日常在用的
③ Edge                垫底
```

Edge 放最后的三个理由：

1. 企业/组策略常禁用远程调试，是所有候选里**起不来概率最高**的
2. 会被系统账号强制接管、带侧边栏与首次运行引导
3. 用户明确反馈不愿意用

#### ⚠ 本案根因（2026-10-28）：写死单个文件名一定漏

现象：点「浏览器登录」→ 用户在浏览器里登完了、页面跳到 agent 界面了 →
magpie 卡片一直停在「请在浏览器中完成登录」，5 分钟后超时。

判据（每次登录都往这里写一行）：

```
~/.cache/magpie/magicrew-login-<site>.log
  [2026-10-27T16:33:25.497Z] launch: 本机没找到 Chrome / Edge / Bravo / Chromium
```

**但这台机器上 Edge 是装着的**（`122.0.2365.106`，微软官方包）。查下来：

```
注册表 HKLM\...\StartMenuInternet\Microsoft Edge\shell\open\command
  → "C:\Program Files (x86)\Microsoft\Edge\Application\Microsoft Edge.exe"

实际目录里：  "Microsoft Edge.exe"    ← 微软落盘的名字，带空格、带大写
代码里写死：  "msedge.exe"            ← 这个名字在本机**不存在**
```

**反过来也成立** —— 另一台 Windows（Edge 156.0.4314.42）上照样跑同一份代码，
但它 `%ProgramFiles(x86)%\Microsoft\Edge\Application\` 里只有 `msedge.exe`，
`Microsoft Edge.exe` 不存在。⇒ **两个名字都得留，谁在就用谁**；
只留一个，就必有一类机器永远走降级。这一条 2026-10-28 在两台机器上双向验过。

`existsSync` 一路 miss → `findBrowser()` 返回 `null` → **永远**走降级路径
（系统浏览器 + 让用户去 Console 粘一行）。用户不知道有 Console 这一步，
只会觉得「我明明登好了，插件没反应」。

⇒ 修法两条，缺一不可：

1. **两个名字都留着**：`Microsoft Edge.exe`（微软真实落盘）+ `msedge.exe`（有些装法是这个）
2. **不能只挑「第一个存在的」就认定它能用** —— 存在 ≠ 能起 CDP。
   改成逐个试，第一个真写出 `DevToolsActivePort` 的才算数。

#### 实测数据（2026-10-28，本机）

| 浏览器 | 起 CDP | 页面就绪 | 读凭据 | 备注 |
|---|---|---|---|---|
| **Chromium 154.0.8037.93**（scoop） | 650–800 ms | ~2 s | ✓ | **当前选中**，端到端 3.4 s 全通 |
| Edge 122.0.2365.106 | ✓ | ~2 s | ✓ | 可用，但按上面理由垫底 |
| 360ChromeX（Chrome 132 内核） | ✓ | — | ✓ | 用户日常浏览器，CDP 正常 |
| 360se6 / 搜狗 / QQ | — | — | — | 本机装了 360se6，未逐一验证 |

真机复跑：`node tools/verify-profile-scope.mjs`（窗口打开 4 秒后 `READ_CREDS` 必须是空串，
关窗后目录必须不存在）。单元判据：`node tests/browser-detect.mjs`。

```js
waitForCreds(session, hostFragment)
  → 每 1.5s：连 /json/list → 找 URL 含 hostFragment 的 page target
    → WebSocket → Runtime.evaluate(READ_CREDS) → 有值就返回
```

`READ_CREDS` 一次求值取两个值：

```js
const pick = (k) => { const raw = localStorage.getItem(k); ... JSON.parse(raw).value ... }
JSON.stringify({ jwt: pick("MAGIC:user:authorization"), org: pick("MAGIC:user:organizationCode") })
```

### 三个实测踩到的坑

**① target 不能退回到 `pages[0]`。**
浏览器刚起来时第一个 page target 还是 `about:blank`，在它上面访问 `localStorage`
抛 SecurityError，被 `catch` 吞掉→看起来像「一直读不到」。必须只认 URL 匹配的 target，
匹配不上返回 null 让轮询继续。实测：启动 → 页面就绪只需 **1.5 秒**，但必须等到它跳转。

**② profile 目录必须一次性，用完删。**（2026-10-27 更正 —— 这里原先写的是「不能删」）

原先固定复用 `~/.cache/magpie/magicrew-login-profile`，理由是「登录态留着，下次不用重登」。
那会制造一个很隐蔽的串号 bug：**添加第二个账号时，浏览器一打开，localStorage 里就躺着
上一个账号的 jwt + org**，`waitForCreds` 第一轮（1.5 秒内）命中 → 立刻关窗；magpie 拿到的
`accountId` / `uid` 与已有账号一模一样，按契约「同一 accountId + 同一 uid → 替换旧账号」，
于是**不新增账号**。用户看到的就是「网页闪一下就没了，登录成功但 magpie 里没多出账号」。

现在的做法：

```
newProfileDir()        → magicrew-login-<pid>-<ts36>-<rand>，每次登录一个
sweepProfiles()        → launch 开头先清：历史复用目录一律删、一次性目录超过 2h 删
                         （只认本插件造的名字，且只动目录 —— 同前缀的 .log 不动）
closeSession()         → 关窗后删掉这一次的目录；删不掉留给下次 sweep
waitForCreds(..., { baseline })  → 第二道防线：窗口打开时就有的凭据不算登录成功
```

代价是每次都要在这个窗口里重新登录一次 —— 独立 profile 本来也没有他日常浏览器的 cookie。

判据（可复跑）：`node tools/verify-profile-scope.mjs` —— 窗口打开 4 秒后
`READ_CREDS` 必须返回**空串**，关窗后目录必须不存在。单元测试见 `tests/login-profile.mjs`。

**③ `authorize()` 里可以 await 启动浏览器（~270ms），但不能 await 用户操作。**
`launchLoginBrowser` 实测 273ms 返回，可接受；`waitForCreds` 必须放到 `callback()` 里。

### 实测数据（2026-10-27，本机 Edge）

| 步骤 | 结果 |
|---|---|
| findBrowser | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| launchLoginBrowser | 273 ms，port=55428 |
| 页面就绪（location.host === www.magicrew.ai） | 1518 ms |
| 写入两个 localStorage 后 waitForCreds | 1 ms 读到 |
| localStorage.clear() 后 | 空串 |

### 降级链

```
候选里有一个能起 CDP → 自己拉 + CDP 读              全自动
一个都起不来         → magpie 开系统浏览器 + 剪贴板   用户粘一行
连浏览器都没有       → 报错，让用户改用「登录态（JWT + 组织码）」
```

⚠ 这条链**只有第一环的判断是对的才算数**。0.3.12 及更早，第一环用的是
「文件名写死的 `msedge.exe` 是否存在」—— 文件名错了就永远落到第二环，
而第二环要求用户去按 F12 开 Console，绝大多数人不会做，看到的就是「一直等」。
判据是 `~/.cache/magpie/magicrew-login-<site>.log` 里那行 `launch: ...`。

> 0.2.0 里那条「密码登录」方法已经删掉了：网页登录拿到的 token 一样能签发
> `mgw_` key（见第十节的更正），再让用户在小窗里输手机号密码是多余的一步。

---

## 十二、流式请求必须补 `stream_options.include_usage`

**症状**：agent 里反复出现

```
模型请求重试 (3/5) · Stream ended without finish_reason
```

用户手动终止后，magpie 记 `499`（客户端断开，属于终止的后果，不是原因）。

**实测（2026-10-27，deepseek-v4-flash）**：magicrew 的流式返回本身是完整的 ——
`[DONE]` 前有 `choices[0].finish_reason = "stop"`，经我们的 loader 原样转发也没丢。
真正缺的是**收尾 chunk**：

| 请求 | finish_reason | usage | `[DONE]` 前的收尾 chunk |
|---|---|---|---|
| 不带 `stream_options` | `stop` | **无** | **无** |
| 带 `stream_options: {include_usage:true}` | `stop` | 有 | 有（`{"choices":[],"usage":{...}}`） |

magpie 新版靠那条**只含 usage、choices 为空**的收尾 chunk 判定「流正常结束了」。
缺了就报 `Stream ended without finish_reason` 并重试。

**修法**（`src/hooks/loader.mjs`）：流式请求且调用方没指定 `stream_options` 时，补上
`{ include_usage: true }`。upstream 支持，无害；实测补完后

```
finish_reason=stop | usage=有 | 收尾chunk=true | [DONE]=true
```

⚠ 只对 `stream: true` 生效，非流式请求不加（那是多余的字段，有的上游会 400）。

⚠ 这个坑的判据是「看流里有没有那条 choices 为空的收尾」，不是「看 finish_reason 在不在」——
后者一直在，容易误判成上游的问题。

---

## 十三、签新 key 会吊销旧 key —— 别随便签

**这是 `Stream ended without finish_reason` 的真正根因**（第十二节记的是排查过程中顺手补的防御项）。

### 现象

- agent 里反复 `Stream ended without finish_reason`，重试，用户终止 → magpie 记 `499`
- magpie 里 provider 显示「已登录」，模型列表也正常
- 但插件拿 `access` 去打上游，回 `{"code":403,"message":"token无效"}`

### 根因

`POST /api/v1/model-gateway/tokens` **一个账号只保留一把 `mgw_` key，签新的就把旧的顶掉**。
排查过程中反复签 key 验证接口，每签一次就让 magpie 存的那把失效一次 —— 于是
`plugin-auth.json` 里的 `access` 还在（`expires` 甚至没到期），但它已经不被上游承认了。

链路因此变成：插件用死 key → 上游 403 → magpie 把 `{"code":403,...}` 这个 **JSON** 回给 agent
→ agent 读流读到非 SSE 内容 → 判 `Stream ended without finish_reason` → 重试。

**那个报错是 403 的下游症状，不是流式的问题。** 判据：看插件发出的请求上游回什么，
而不是盯着流里有没有 `finish_reason`。

### 修法

用 `refresh_token` 换一把新的，写回 `plugin-auth.json`（magpie 直接读文件，**不用重启**）：

```bash
curl -X PUT <host>/api/v1/model-gateway/tokens \
  -H 'content-type: application/json' \
  -d '{"refresh_token":"<plugin-auth.json 里的 refresh>"}'
```

⚠ **body 只能有 `refresh_token` 这一个字段**。塞别的（或用 authorization 头发）会回：

```
{"code":5003,"message":"Request body must only contain refresh_token"}
```

换出来的 `api_key` 立刻可用，同时**又会吊销上一把** —— 所以换完要立刻写回，别在中途用二次。

### 教训

- **调试期间不要反复签 key**。要看接口通不通，用**已有的** `access` 打；真要签，签完立刻写回。
- `expires` 没到期 ≠ key 有效。这个网关的吊销是**服务端即时**的，本地那个时间戳只是"理论到期"。
- 排查上游问题时，**先看上游的原始响应**，再看下游报什么 —— 下游的报错经常是上游错误的二次加工。

---

## 十四、三层凭据的有效期与保活

| 凭据 | 有效期 | 从哪来 | 失效后果 |
|---|---|---|---|
| 网页 JWT | **30 天**（`exp - iat = 2592000`） | 登录 | 业务接口全挂，要重新登录 |
| `mgw_` api_key | **2 小时** | `POST /api/v1/model-gateway/tokens` | 请求 403 `token无效` |
| refresh_token | **7 天**，用一次轮换一次 | 同上 | 换不了新 key，要重新登录 |

### ⚠ 更正（2026-10-27 晚，实测推翻早前的说法）

早前这里写着「**api_key 签一把顶一把，新的签出来那一刻旧的当场死**」——
**这条没有验证充分，不能再当结论用。**

实测反例：同一个账号、两把不同时间签发的 key **同时有效**：

```
mgw_55ac…（18:08 用 refresh_token 换的）→ /v1/models 正常返回模型列表
mgw_8f9a…（18:14 又一次续期换的）       → 网关请求 HTTP 200 正常回复
```

两把都活着。所以「一签就吊销」不成立。

那第十三节那次 `mgw_63d4…` 为什么 403？当时只能说**不确定**，三种可能没分辨开：

1. 它真的过期了（2 小时），而本地 `expires` 字段显示还没到 —— 说明 `expires` 不可信
2. `PUT`（用 refresh_token 续期）会轮换/吊销旧的 `api_key`，而 `POST`（签发）不会
3. 别的吊销条件（重新登录、并发续期）

### ✅ 结论（2026-10-28 晚，受控实验做完了）

上面说「要判定需要一次受控实验」。实验做了，**答案落在第 1 条：只有「真的超过 2 小时」会 403，
「签一把顶一把」不成立，`expires` 也只是个理论值**。

做法：把本机**所有** key（magpie 的 `plugin-auth.json` 的 access + key-store 每个账号每个槽）
逐把打 `GET /v1/models`——只读、不签发、不吊销、不花钱。探针留在仓库外，
结论是这一张表（`剩余` = `expiresAt - now`，单位分钟）：

```
来源      站点            账号             槽       剩余(分)   判定
magpie  magicrew-intl  67u4oe6fbenj   access   116        HTTP 200 MODELS=65
magpie  magicrew       7fli52t2tc2b   access   115        HTTP 200 MODELS=44
magpie  magicrew       66p0q56qo47j   access   115        HTTP 200 MODELS=44
magpie  magicrew       h97gkbu8bruj   access   115        HTTP 200 MODELS=44
store   magicrew-intl  67u4oe6fbenj   a*       116        HTTP 200 MODELS=65
store   magicrew-intl  67u4oe6fbenj   b        -181       code=403 "token无效"
store   magicrew       66p0q56qo47j   a*       -227       code=403 "token无效"
store   magicrew       66p0q56qo47j   b        -541       code=403 "token无效"
store   magicrew       7fli52t2tc2b   a*       -173       code=403 "token无效"
store   magicrew       7fli52t2tc2b   b        -286       code=403 "token无效"
store   magicrew       h97gkbu8bruj   a*       117        HTTP 200 MODELS=44
store   magicrew       h97gkbu8bruj   b        -228       code=403 "token无效"
```

两条判据：

**① 403 与「剩余分钟数」完全一致** —— 每一个 403 的剩余都是负数（-173 到 -541），
每一个 200 的剩余都是正数。**没有一个「时间没到却不认」的样本。**
所以「本地时间没到但服务端已经吊销」这个状态，本次实测里根本不存在。

**② 同一账号同时有两把活 key，签发时刻相差 67 秒：**

```
magpie access  expires 2026-10-28T14:39:56.898Z   → 200
store  槽 a    expires 2026-10-28T14:41:03.000Z   → 200
```

两把都是 2 小时有效期，也就是一把签于 12:39:56、另一把签于 12:41:03 —— **后签的没有顶掉先签的**。

⇒ **一条账号一把活 key 这个说法彻底作废**。`POST` 与 `PUT` 都不吊销已签出的 key，
唯一的失效条件是 2 小时到期。

### 那这条为什么必须写下来

2026-10-28 的 PR #8 就是被「时间没到但已被顶掉」这个前提带偏的：它据此把
`ensureKey` 改成「优先用 `auth.access`」，并加了一个跨账号挑活 key 的兜底。
前提不成立 ⇒ 改动没有依据；而那个兜底会**把别的账号的 key 交出去**
（实测：auth 无 org 时 PR 分支返回了 `h97gkbu8bruj` 账号的 key，
而 main 返回调用方自己的）。教训不是「多加一层兜底」，是**先把前提测了再改代码**。

### 保活的正确说法

不管吊销机制是什么，**只留一把、只有一个出口**这个设计依然成立 ——
理由从「否则互相吊销」改成「否则本地会分叉，说不清手里那把是不是服务端认的」。

### 保活链路（2026-10-27 逐版本核对后的实况）

```
每次请求前   ensureKey(c, getAuth)          ← src/hooks/loader.mjs
               ├─ 文件里的 key 还能用（剩余 > 10 分钟）→ 直接用
               └─ 不够了 → renewOnce（同站点串行）
                            ├─ 有 refresh_token → PUT 换新的 → 覆盖落盘
                            └─ 没有 / 失败     → 退回 magpie 存的那把

到期前 10 分钟 auth.refresh(auth)           ← magpie 按 refreshLead 主动调度
               └─ src/hooks/refresh.mjs 直接调 api.refreshGatewayKey(auth.refresh)
                  ⚠ 不经过 keys.mjs，也不读 key-store

每天一次     checkin → runCheckin()         ← 领积分 / 补首任务 / 新手福利，**不碰 key**
```

### checkin 现在做四件事（0.3.11 起）

```
① POST /api/v1/login-gift          领每日登录积分（国内 +200、国际 +50；当天已领回 granted:false，幂等）
② 首任务 / 首对话没做过 → 走 Socket.IO 发一条消息（纯 Node，不开浏览器）
     国内站：onboarding 的 first_ai_work 还是 PENDING → 建话题 + 发一条，轮询等 COMPLETED
     国际站：onboarding 恒返回空任务 → 改看「有没有话题」，一个话题都没有才发
③ 其余新手福利 → PUT /api/v1/onboarding/tasks/<code>/completion
④ 报积分变化
```

② 是唯一有外部副作用的动作：会建项目 / 话题、真花一次模型积分（挑最便宜的模型）。

**它是每个账号一辈子只做一次的事，不是每天的事**（0.3.12 改正）。真正的触发点是
**登录成功那一刻**（`src/hooks/methods.mjs` 三条登录路径都会 `kickoffFirstTask`，
发射后不管、不阻塞登录）；签到只是兜底 —— 万一登录那次没跑成（进程被杀、网络抖），
下一次签到接着做。

闸门落在 `~/.cache/magpie/magicrew-autochat-<siteId>.json`
（`siteId` 取 `magicrew` / `magicrew-intl`），内容是：

```json
{ "<org>": { "at": "ISO", "status": "sent|failed|gave-up", "attempts": 1,
             "topicId": "…", "model": "Qwen3.5 Flash", "reason": "…" } }
```

规则：

| 情况 | 写什么 | 之后还发不发 |
|---|---|---|
| 消息发出去了 | `status: "sent"` | **永远不发**（换天、重登、重启都一样） |
| 真去发了但失败 | `status: "failed"`，`attempts++` | 发，最多 3 次 |
| 连失败 3 次 | `status: "gave-up"` | 不发（别让永远失败的号每次撞一遍） |
| 还没有工作台 / 项目 | 不写 | 发，下次再来（只读接口，成本低） |
| 有项目、但话题一个都没有 | 不写 | **发**（项目是打开工作台时自动建的，不代表说过话） |
| 话题清单查不到（接口失败） | 不写 | **这次不发**，下次再来（不把「查不到」当「没说过话」白花积分） |
| 服务端本来就是 COMPLETED | `status: "sent"` + `reason` | 不发 |

老版本（0.3.11）记的是 `{ [org]: "YYYY-MM-DD" }` 字符串日期 —— 读的时候按「已发过」
归一化，所以升级上来不会补发一遍。

怎么发的（协议帧、三个 id 从哪来、为什么不用浏览器）见 `src/chat-task.mjs` 顶部注释。
key 依然一个都不碰。

### ⚠ 更正（2026-10-27）：checkin 并不续 key

早前这里写着「每天一次 `checkin` 里 `ensureKey(c, getAuth, { leadMs: 24h })`，
用 24 小时提前量保证每天真的续一次」。核对 0.3.0 / 0.3.2 / 0.3.7 三个版本：
**checkin 路径（`src/hooks/checkin.mjs` → `src/tasks.mjs`）从未 import 过 `ensureKey`**，
全仓 `leadMs` 只出现在 `src/keys.mjs` 自身。这条链路只存在于文档里。

而且它本来也不需要存在 —— 原来那段论证有个漏洞：

- **「一整天没有请求，key 会静静过期」不成立**：续期不靠请求触发，是 magpie 按
  `refreshLead`（10 分钟）主动调 `auth.refresh`。只要 magpie 在跑，有没有请求都会续。
- **「挂在 checkin 上补洞」也补不了**：真会让 refresh_token 闲置到 7 天失效的场景，
  是 magpie 整整 7 天没开 —— 那时 checkin 同样不跑。

所以 checkin 续 key 的实际收益是 0，而**补上它反而有害**：`src/hooks/refresh.mjs`
绕过了唯一出口（见 `src/keys.mjs` 顶部注释），两处各持一份 refresh_token 会分叉 ——
补上 `ensureKey` 就会把 key-store 写起来，进而抢轮换，结果是「用户莫名被要求重新登录」。

真要补这个能力，前提是先把 `auth.refresh` 收敛进 `ensureKey`。在那之前，
如实描述现状，比圆一个不存在的承诺安全。

**落盘**：`~/.cache/magpie/magicrew-key-<siteId>__<account>.json`（0.3.3 起按账号隔离、
且改成 A/B 双槽；早前这里写的是不带账号后缀的单槽格式 `{apiKey, refreshToken, expiresAt}`，
读的时候有 `normalize()` 负责迁移）：

```json
{
  "current": "b",
  "refreshToken": "…",
  "keys": {
    "a": { "apiKey": "mgw_…", "expiresAt": 1793102896000 },
    "b": { "apiKey": "mgw_…", "expiresAt": 1793109996000 }
  },
  "at": "2026-10-27T18:20:00.000Z"
}
```

`current` 指向正在用的那一槽，另一槽是上一次的、留作 403 时回退。

### 首次运行怎么自举

key-store 是空的（第一次跑或文件被清）时，从 magpie 的 `plugin-auth.json` 里
**接管一次** `access` / `refresh` / `expires` 并落盘，之后完全自管。接管来的那把如果
已经不够新鲜，紧接着就走续期。

---

## 十五、key 按账号隔离 + 双槽（0.3.3）

### 为什么必须按账号分文件

同一个站点可以登多个账号（magpie 里显示成 `magicrew` / `magicrew#1` / …）。
key 若按站点存一份，第二个账号登录时会把第一个账号的 key 覆盖掉 —— 第一个账号从此 403，
而且看起来像"随机失效"。

落盘：`~/.cache/magpie/magicrew-key-<站点>__<账号>.json`，账号用 `org`（组织码，登录后固定）。

### 双槽怎么转

```
a 槽 ← 正在用
b 槽 ← 上一次的，还活着（回退用）

续期：  b 槽写新的 → current 切到 b → a 槽那把留着自然过期
403 ：  当前那把标失效（expiresAt=0）→ current 切到另一槽 → 重试一次
两槽都空：从 magpie 的 plugin-auth.json 接管一次
```

**为什么敢双槽**：实测同一账号两把 `mgw_` key 可以同时有效。
**为什么不需要"闲置池"**：实测一把 key 并发 6 个请求全成功 —— 它是账号级无状态凭据，
不存在"被占用 / 打架"。

### 实测记录（2026-10-27）

```
续期前 槽a = mgw_55accec4…  | refreshToken: 有
续期后 槽b = mgw_06713b5e…  | 到期 20:23:17
回退槽 = mgw_55accec4…      ← 保留
新 key 打上游 /v1/models → 正常返回模型列表

账号隔离：h97gkbu8bruj 与 otherOrg999 各自一份文件，互不覆盖

并发：同一把 key 发 6 个 chat.completions → #0✓ #1✓ #2✓ #3✓ #4✓ #5✓（18.1s）
```

### ⚠ 已知未解决

`403 自动切槽`在实测里没触发成功过一次（单独测 `switchSlot` 是好的，接进 loader 后
没观察到切换）。下次排查先看：`key.apiKey` 与 `switchSlot` 里比较的那把是否同一个对象、
`body` 是否真的是字符串。

### ⚠ 升级到按账号命名时，旧文件必须清掉

0.3.2 之前文件叫 `magicrew-key-<站点>.json`（按站点）；
0.3.3 起叫 `magicrew-key-<站点>__<账号>.json`（按账号）。

两套命名并存时，旧文件**不会被新代码读到**（文件名不匹配），但它会让人误判现场：
排查时看到 `magicrew-key-magicrew.json` 里躺着一把旧 key，会以为那是在用的。

实测踩到：旧文件残留 + magpie 重启，网关连续 502 `token无效`；
删掉旧文件后立刻恢复 200。**升级时先 `rm ~/.cache/magpie/magicrew-key-*` 再重启。**

### ⚠ 重启时序

magpie 刚起来时 `getAuth()` 可能还返回 null（账号未加载完），此时
`accountOf(auth)` 会退成 `default`，读不到该账号的文件 → 用 magpie 暂存那把（可能死）→ 403。
几次请求后账号加载完就正常。**排查时若看到 `__default.json`，就是这个时序。**

---

## 十六、上下文窗口必须查库，不能填保守值

**症状**：`pi-ai detected context overflow for model "magicrew/deepseek-v4.1-flash"`，
而会话实际还没到模型的真实上限。

**根因**：magicrew 这两个接口**都不返回上下文窗口**：

```
GET /api/v1/flows/models  → value / label / vision / tags / configs
GET /v1/models            → id / object / created_at / owner_by
```

（早前记的「/v1/models 有 context_length」是看错了 —— 那是 magpie 网关自己补的，
不是上游给的。）

于是插件一律填 `256_000` 当保守值。对 `deepseek-v4.1-flash` 来说这是错的：
它真实窗口 **1,048,576**，填 256K 等于把容量砍掉四分之三，agent 拿这个数判断"放不下"
就拒绝了 —— 保守值在这里反而变成了故障源。

**修法**（0.3.4）：向 magpie 自己的模型库查 —— `~/.cache/magpie/models.json`，
每条带 `limit.context`，magpie 自己会更新它。

匹配顺序：全名 → 尾段（`deepseek-ai/deepseek-v4.1-flash` ↔ `deepseek-v4.1-flash`）→
同尾段取最大（同一个模型挂多个厂商前缀时，取真能收的那个）。查不到才退回 256K。

实测值（2026-10-27）：

| 模型 | context |
|---|---|
| deepseek-v4.1-flash | 1,048,576 |
| deepseek-v4-flash | 1,048,576 |
| qwen3.5-flash | 1,000,000 |
| kimi-k3.1-pro | 1,048,576 |
| mimo-v2.6-flash | 1,048,576 |
| glm-5.3-flash | 262,144 |

⚠ 保守值的方向要想清楚：**填小了会让 agent 过早拒绝（这次就是这个）**，
填大了会让 agent 以为有余量、请求超了上游才报错。有权威来源时用权威来源，
没有时才选保守 —— 而"保守"在两者之间是矛盾的，得看哪个代价更小。

### 上下文窗口的优先级（0.3.5 起）

```
① magpie GUI 里「上下文窗口」那一行手选的     ← 最优先，magpie 直接采用
② ~/.cache/magpie/models.json 的 limit.context  ← 插件查到的真实值
③ 兜底 1_048_576
```

**兜底为什么给大不给小**：
- 给 1M 而实际只有 128K → 上游超限报错，**用户看得见**
- 给 256K 而实际有 1M → agent 主动拒绝本可以处理的对话，**静默损失能力**，
  表现成 `pi-ai detected context overflow`，比报错难查得多

参照官方社区插件：
- **Qoder** 纯硬编码（`{ id: "ultimate", context: 1_000_000 }`）
- **WorkBuddy** 硬编码一张 `[id, name, context, efforts]` 表，再从自家 `/v3/config`
  的 `maxInputTokens` 覆盖（`m.context = d.maxInputTokens`）

magicrew 既不返回 `maxInputTokens`（`flows/models` 的 `configs` 只有 temperature），
`/v1/models` 也只有 `id / object / created_at / owner_by` —— 所以走模型库这条路。

---

## 十七、上游不认空 schema —— `additionalProperties: {}` 与 `items: {}`

> 两处是同一类兼容性问题的两个面：客户端按 JSON Schema 规范写出**空对象**，
> 上游的校验器/适配层拒收。都只能在请求改写里兜。

### 一、`additionalProperties: {}` → `400 code 4017`

**症状**：接 ZCode / Claude Code 系客户端时，一次带 54 个工具定义的请求必定失败：

```
POST /v1/chat/completions
→ HTTP 400 {"error":{"message":"模型响应失败","code":4017","request_id":"..."}}
```

换成简单请求（一两个工具）就正常 —— 所以看起来像"某些模型不行"或"工具太多"。

### 根因

这些客户端生成工具 schema 时，会把"允许任意额外属性"写成**空对象**：

```json
"parameters": { "type": "object", "properties": {...}, "additionalProperties": {} }
```

按 JSON Schema（draft-07）这是合法的 —— `additionalProperties` 的值是 schema 时，
`{}` 表示"任意，不加约束"，与 `true` 语义等价。但**上游的适配层只认布尔值**，
收到一个对象就整个请求拒掉，还只回一句"模型响应失败"，不说是哪个字段。

### 最小复现（2026-10-28，同一把 key、同一份请求、只改这一个字段）

| `additionalProperties` | glm-5.3-flash | deepseek-v4.1-flash |
|---|---|---|
| 缺省 | 200 | 200 |
| `false` | 200 | 200 |
| `true` | 200 | 200 |
| `{}` | **400 code 4017** | **400 code 4017** |
| `{type:"string"}` | **400 code 4017** | **400 code 4017** |
| `{type:"string",description:"x"}` | **400 code 4017** | **400 code 4017** |

**两个模型逐行一致。结论比「上游只认布尔」更狠：它根本不支持 schema 形态** ——
不只是空对象，连 `{type:"string"}` 这种有约束的 schema 也一律拒。这一点很关键：
只处理空对象的改写在真实请求里仍会 400（实测过，见下方「修法」）。

### 修法：请求改写里做等价替换

`src/hooks/loader.mjs` 的 `rewriteRequestBody` 里，`loosenAdditionalProperties()`
递归扫 `tools[].function.parameters`，把**所有非布尔值**换成 `true`：

```js
"additionalProperties": 缺省         →  不动       // 等价于 true
"additionalProperties": true         →  不动       // 上游认
"additionalProperties": false        →  不动       // 「不许额外属性」，换掉就是反向放开
"additionalProperties": {}           →  true       // 等价改写
"additionalProperties": {type:"x"}   →  true       // ⚠ 降级放宽，丢了约束
```

**为什么接受那个不等价**：`{}` → `true` 是严格等价（都表示「任意，不加约束」）；
`{type:"string"}` → `true` 丢掉了「额外属性必须是 string」这条约束。但上游无法表达它，
保留原值就是整个请求失败。两害相权，让工具调用能跑（可能多出未声明的字段）
比让 agent 完全不可用要好；方向也安全 —— 是放宽不是收紧，不会让原本合法的调用被拒。

它与 `max_tokens`、`stream_options`、`items: {}` 四处改写共用**一次** `JSON.parse`；
没改到时返回原始字符串（省一次序列化 —— 54 工具的请求体可达上百 KB）。

边界由 `tests/body-rewrite.mjs` 钉住（36 个断言）：非布尔一律换、布尔一律不动、
其余字段一字不动、没改到就不重新序列化。

### 二、`items: {}` → `400 invalid JSON Schema`

**症状**（2026-10-28，用户截图原文）：

```
HTTP 400
{"code":null,"message":"超级麦吉: HTTP 400 请求错误: {\"error\":{\"code\":\"InvalidParameter\",
 \"message\":\"tools.40.function.parameters/properties/functions/items: invalid JSON Schema;
 check the schema keywords and references Request id: ...\",\"param\":\"\",\"type\":\"BadRequest\"}}",
 "param":null,"type":"invalid_request_error"}
```

与 `additionalProperties` 那条不同：这次上游**给了完整路径**（`tools.40.../items`），
而且国内站与 `magicrew-intl` 的报错逐行一致。

**最小复现**：41 个工具，第 41 个的参数是

```json
{"type":"object","properties":{"functions":{"type":"array","items":{}}},"required":["functions"]}
```

| `items` | 结果 |
|---|---|
| 缺省 | 200 |
| `{}` | **400 invalid JSON Schema**（路径 `.../properties/functions/items`） |
| `{description:"x"}` | 200 —— 空对象才炸，不是"缺 type" |
| `{type:"string"}` | 200 |
| `true` | 400 `模型响应失败`（另一条 400） |
| `false` | 400 `模型响应失败` |

**根因**：客户端用 `z.array(z.unknown())` / 动态函数列表生成 schema 时，数组元素序列化成
`{}`。JSON Schema 里 `items` 的缺省值本来就是 `{}` —— "任意元素"，所以
`items: {}` 删掉是**严格等价**，不是降级放宽；`items: true` 同理。
`items: false`（"数组必须为空"）语义不同，不能删，原样留着。

**修法**：`loosenEmptyItems()` 删 `items: {}` 与 `items: true`，与
`loosenAdditionalProperties()` 在同一个 `rewriteRequestBody` 里各跑一遍。

两者共用 `walkSchema()`，**只进入真正的 schema 位置**（`properties` 等映射的**值**、
`allOf` / `anyOf` / `oneOf`、`items` / `additionalProperties` / `not` / `if` 等），
不扫键名，也不扫 `enum` / `default` / `const`。否则一个恰好叫 `items` 或
`additionalProperties` 的工具参数会被当成关键字误删/误改（0.3.24 的教训，0.3.25 修）。

**端到端验证**（2026-10-28）：同一份 41 工具请求
`raw → 400 tools.40.../items`；过 `rewriteRequestBody` 后 `→ 200`。
国内站、国际站都验过。

### 为什么算插件的事，不算客户端的事

按规范 `{}` 与 `true` 等价，客户端没写错；**上游的兼容性不足**。
但插件是唯一能改请求体的地方（见 `src/hooks/loader.mjs` 顶部），
在这里兜住比让每个用户去改 ZCode 的源码现实。

### 同一处这些改写的两个教训

同一次排查里还确认了两件事，都值得记住：

1. **上游对"token 无效"回的是 HTTP 200**，body `{"code":403,"message":"token无效"}`，
   且 `error` 字段是空数组（falsy）。**只看 HTTP 状态码会把失败当成功** ——
   判断得用 `j.code !== 200`。排查时在这上面绕了很久。
2. **插件宿主是运行时从 `~/.cache/magpie/bun/install-cache/` 加载的**，
   不在 `plugin-host/host-*.js` 里；magpie 更新插件后会换目录（目录名带 commit hash），
   要改当前实际加载的那个。

---

## 十八、上游 400「可用积分已不足」：插件改写成 402

### 症状

多账号（同 provider 三号，余额 6,467 / 82 / 0 积分）时，一个账号被会话亲和留在
回复链上，一轮把余额烧穿，上游回 HTTP **400**：

```
超级麦吉: 非常抱歉，当前对话需要调用大模型 / 付费工具，您的可用积分已不足。
您可以点击右上角「用户头像」，通过「充值」通道补充积分，完成后即可继续对话。
```

DSH 显示「本轮运行失败」；trace 里只有两次 try（都在那个账号），余额 6,467 的账号一次没问。

### 根因（magpie 0.1.1899 / origin main `69626580`）

`internal/gateway/routing.go` 的 `failure()` 能认出（`creditWords` 命中「充值」）：

```go
creditWords = ...|余额|欠费|充值|账户.*(不足|停)
case status == 402, creditWords.Match(body) && ...:
    return failCredit
```

但 `internal/gateway/fallback.go` 的 `retryable()` 400/422 分支只查 `quotaWords`：

```go
case status == 400, status == 422:
    return quotaWords.Match(body) || unservedWords.Match(body) || ...
```

`quotaWords` 不含「积分」「充值」。⇒ `retryable(400, body) == false` ⇒
`hw.failed() == false` ⇒ 走不到 `!last && hw.failed()` 的换号分支，也不记 `Rest`。

### 插件修法（0.3.26）

`src/hooks/loader.mjs` 的 `rewriteCreditRefusal()`：只在 **400/422 + 文案命中
「积分/余额不足」** 时改写成 **402 Payment Required**，body 原样。402 在 magpie
的 `retryable()` 里无条件 true、`failure(402)` 也是 `failCredit`，于是会 rest 该账号
30 分钟并继续问同 provider 的下一个账号 / 组的下一个成员。

边界：`schema` 400、参数 400、200、402 一律原样透传；不读成功流（只克隆错误响应）。
`tests/credit-refusal.mjs` 18 个断言锁死，含 `makeLoader().fetch` 的端到端用例。

> 这是**绕过**，不是 magpie 根修。根修建议 `retryable()` 的 400/422 分支补
> `creditWords.Match(body)`（或直接 `failure(status, body) == failCredit`）；
> 已报 yetone/magpie#4095。

### 为什么这是插件能做的边界

插件能改上游响应（loader 的 `fetch` 返回 Response），改不了 magpie 的 `retryable()`。
把「支付问题」伪装成语义正确的 402，比让每个用户手动避开耗尽账号现实；等 magpie 修好后，
这段转换仍然无害（402 本来就是正确的语义）。

