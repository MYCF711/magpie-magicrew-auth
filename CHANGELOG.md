# 更新记录

## 0.3.23

**网关路径的 key 兜底 —— 修「超级麦吉 did not stream: token无效」**

magpie 当网关被调用时（别的 agent 通过 magpie 的 OpenAI/Anthropic 端点进来），
本插件的 provider 可能整个用不上：

```
POST /v1/chat/completions  model=magicrew/glm-5.3-flash
→ 502 {"message":"超级麦吉 did not stream: token无效"}
```

三个事实凑起来才看得清（2026-10-28 实测）：

1. 直连官方 API，一切正常 —— 同一把 key、同一批参数（`reasoning_effort`、tools、
   `max_tokens`）都试过，模型名、organization-code、`/v1/models` 也都正常。
2. 插件自己的 key store 里**有一把好着的 key**，拿它直连上游 → HTTP 200。
3. magpie 手里的 `plugin-auth.json` 那把 access **是废的** —— 服务端「签一把顶一把」，
   插件自己轮换签发新 key 的瞬间，magpie 手里的就作废了。

于是死结是：magpie 传给 loader 的 auth 里未必带 org → `accountOf()` 落到
`"default"` → `readStore` 读不到这个账号的槽 → `ensureKey` 只能退回
「用 magpie 手里的 access」→ 那把已经被顶掉 → 上游 403。

**兜底**：`ensureKey` 在按账号找不到新鲜 key 时，再扫一遍**该站点所有账号**的
store，挑一把还没过期、到期最晚的。key 与账号一一对应，用谁的 key 就是以谁的
身份跑 —— 对「几个号轮流扛、积分少的先上」这种用法正合适。

```js
const anyLive = anyLiveKey(c, leadMs)
if (anyLive) return anyLive
```

实测（模拟网关路径：auth 里没有 org，access 是废 key）：

```
ensureKey 返回: mgw_7d6325c1fd3b4b90…   ← store 里那把有效的
是否等于 magpie 手里的（废）key ? false
直连上游 → HTTP 200
```

## 0.3.22 — 2026-10-28

**余额窗口保留「今日 / 限时 / 永久」拆分展示**

0.3.21 只发一条总余额，路由对了，但看不出每日 23:59 到期的额度。现在在
`积分余额` 余额窗口之后追加三条只展示的 `aside` 文本行：

- `今日积分`：`185 / 200 积分 · 今日 23:59 到期`
- `限时积分`：剩余限时批次 + 最早到期日
- `永久积分`：不过期部分

它们不带 `used` / `limit` / `balance`，宿主把它们当 `aside` 文本，不参与
`Allowance.Left`，路由仍只按 `积分余额` 排序；总余额不会被拆分窗口压低。

## 0.3.21 — 2026-10-28

**积分改为 magpie 的「余额型窗口」：不再编造百分比**

magpie 0.1.1790（issue #3950）起支持 `usage.windows[].balance`：只报余额和单位，
不写 `used` / `limit` / `aside`。本版把原来「今日 / 限时 / 永久」三条假百分比窗口
合并成一条 `积分余额`：

- `balance = total_points`、`unit = "积分"`；
- `runsOutAt` / `runsOut` 取最早过期的一批，让 smart 路由知道谁先失效；
- 余额 0 也报 `balance: 0`，由宿主判定为用完，不再合成 `used: 100`。

宿主现在按同 provider、同单位的余额从多到少排；不再显示「总量 = 余额」的
100% 假进度条。旧版三窗口写法是宿主支持余额前的过渡，已删除。

## 0.3.20 — 2026-10-28

**积分按「什么时候失效」拆成三块：今日 / 限时 / 永久**

0.3.19 把整池积分压成一条窗口，百分比是「总量 = 余额」的恒等式，没有信息量。
现在拆成三块（数据都来自 `/api/v1/quota/points/total`）：

| 窗口 | 是什么 | 百分比 | 参与路由 |
|---|---|---|---|
| **今日积分** | 今天 23:59:59 到期的批次（每日登录赠送，国内 200 / 国际 50） | **真的**（分母是每日额度） | 是 |
| **限时积分** | 其余会过期批次的剩余之和 | 无（服务端不给原始额度） | 是（带 `runsOutAt`） |
| **永久积分** | `total - Σ限时`，不过期 | — | 否（`aside` 只展示） |

三块加起来正好等于 `total_points`，实测四个号都对得上。

**为什么「限时积分」条目不标 `aside`**：标了会被 `allowanceOf()` 整条跳过，
`runsOutAt` 就进不了路由 —— 这个号又会变回「未知」。所以它给 `used: 0` +
`limit = 当前余量`，让 magpie 收下它并读到 `runsOutAt`。百分比（恒 100%）无意义，
但路由能按「谁的积分先过期」排。

**关于「7 个依次递减的到期时间」**：`runsOutAt` 是单值字段（`*time.Time`），
语义就是「最早失效的那一批」，所以 7 个批次也只会出现一条提醒，不会堆成 7 条。
magpie 自己的 WorkBuddy 插件就是这么用的。magicrew 的每日登录积分是
「当天 23:59:59 到期」（`expire_type: 1`，不累积），更不存在滚动多批。

**为什么还是要给 magpie 提 issue**：magpie 的契约把「有进度条」和「参与路由」
焊在同一个窗口上 —— 要进度条就得给 `used`+`limit`，钱包没有分母就只能编；
不编就判成纯文本 + `aside`，路由又当未知。三条不可能同时满足。
真正的解是宿主支持「余额型窗口」：有读数、能参与路由，但不参与百分比。

## 0.3.19 — 2026-10-28

**路由页不再说「剩余额度未知」：窗口不能标 `aside`**

0.3.18 把积分窗口改成 `aside: true` + 只给 `display` —— 卡片好了，
**路由页还是「剩余额度未知」**。

根因在 magpie 宿主侧，读源码可证：

```
provider/routing.go   allowanceOf()     if (w.Aside || w.Text) { continue }    ← 整条跳过
provider/routing.go   routedAllowance() if len(a) == 0 { return nil, false }   ← 一条不剩 ⇒ 不 ok
gateway/trace.go      weighed()         if l, ok := wg.lefts[key]; ok { w.Known = true }
routing/client.js     w.known 为假且 kind == "account" ⇒ 「剩余额度未知」
```

官方文档也逐字写着（`docs/subsystems/provider-plugins.md`，issue #3650）：

> An account whose windows all tell no share has no allowance, so routing counts
> it not known ... as one never read. A window that says `used: 0` is a reading
> at 0, as before.

⇒ **`aside` 的代价不是「不参与排序」，是这个号在路由里整个消失**
（unknown 一律排在已知的之后）。

现在改成钱包的恒等式：`limit = 余额`、`amount = 0`、`used = 0`，**不加 `aside`**。
`used` 仍然是「已用 0」而不是缺省 —— 缺省会被 magpie 判成「没有份额的文本行」，
又回到未知。

判据（2026-10-28 实测，两站四个号）：

| | 修复前 | 修复后 |
|---|---|---|
| `/v1/magpie/trace` 的 `known` | **字段缺失** | `true`，`limit` = 余额 |
| 路由页那一行 | 剩余额度未知 | `1,363 / 1,363 积分 · 剩余 100%` |

A/B 都跑过：把 `aside: true` 加回去、重启 magpie，`known` 立刻变回缺失；
换回来就恢复 `true`。

⚠ 代价说清楚：这样算出来的百分比**没有信息量**（分母就是分子）——
magpie 的额度契约是为「周期配额」设计的，钱包型额度它没有专门表达。
真正该修的是宿主侧，插件侧只能给出最接近的形态。

## 0.3.18 — 2026-10-28

- **AGENTS 新增「零、magpie 升级时：只看稳定版」** —— magpie 有「更新渠道：每个版本 / 稳定版」，用户默认跑稳定版。两渠道实测差 **400 多个版本**（每版本 0.1.1763 / 稳定版 0.1.1327），但插件相关的契约字段**一条不差** ⇒ 追每版本几乎全是白跑。判断依据只有一条：**稳定版版本号变了**才需要重新同步

## 0.3.17

**不用开浏览器也能登录了 —— 手机号 + 短信验证码，纯 HTTP 走完**

那个卡了很久的「拖动滑块使图片角度为正」现在能自动过：用 magpie 设置里你自己选的
识图模型（`settings.json` 的 `vision`）判断旋转角度，然后纯 HTTP 把整条链走完。

### 之前为什么做不了，以及真相

旧文档（internals 第九节）写着「magicrew 没有这条路」。**那是错的，原因是找错了域名。**
登录用的用户中心不在 `i-magic-service.letsmagic.cn`，而在另一套 keewood 服务上：

| 站点 | 用户中心 |
|---|---|
| 国内 letsmagic.cn | `https://i-keewood-service.teamshare.cn` |
| 国际 magicrew.ai | `https://keewood-service.magicrew.ai`（**没有 `i-` 前缀**） |

换成这个域名，整条链一个 404 都没有。

### 五步链路（全部实测）

```
POST /captcha/generate    {account_type:"mobile", mobile, state_code}
     → {token, image(data:image/webp;base64,…), expire_time}      ← 纯 JSON，无 cookie、无指纹
POST /captcha/verify      {token, angle, account_type, mobile, state_code}
     → {verified:true, business_token:"biz_…"}
POST /v4/user/send-sms    {type:"account_login", phone, state_code}
     + header X-Captcha-Token: <business_token>                  ← 这个 type 填错会炸
POST /v4/user/login       {type:"phone_captcha", phone, state_code, code, device:{id,name}}
     → jwt + 组织
```

**`angle` 不是一个裸角度，是加密过的整数**，前端那么算：

```
l = deg,  u = n (n = Date.now()%90000+10000)
d = 52249517 × (l + u) + 5976906165
angle = String(d & 0xFFFFFFFF) + String(n)
```

`deg` 就是「图片要顺时针转多少度」，**1 px = 1.6°，满行程 225 px = 360°**。
验证方式：抓浏览器真实提交的 4 组 angle，对每组正向穷举 0…359 **都唯一命中**，
命中值与拖动像素严格成 1.6 倍；另用图像互相关独立验算，拖 100px 前后帧相差 160°±0.25°。

### 识图判角度：问钟点，不问角度

**不要问模型「这图歪了多少度」** —— 实测填空 6 次错 5 次。改问
「主体自己的『上方向』指向钟面的几点」（12=正上、3=正右），再 `deg = (12 - clock) × 30`。

而且**必须问两遍比分歧**：实测的失败样本是两个判官给出 1.7 和 7.5 钟点（相差 174°），
其中一个把方向看反了 —— 这种情况取平均毫无意义，只能换图重来。
分歧阈值 1.5 钟点（45°）。

服务端**容差实测 ≥ ±10°**（正确答案 120°，故意提交 130° 仍然通过），所以钟点法的
精度是够的：24 格 15° 网格的那点误差根本不影响。

⚠ `Bun.Image.rotate()` **只支持 90° 的倍数**（`rotate: only multiples of 90 are supported`），
`bytes()`/`buffer()` 给的是编码后的 PNG、拿不到原始像素 —— 所以「旋转 24 格网格」
这条路在插件里走不通，才改用钟点法。

### 新增

- `src/captcha.mjs` —— 取图 / 角度加密 / 验证 / 发短信 / 验证码换登录态 / 三站域名映射
- `src/vision.mjs` —— 读 `settings.json` 的 `vision`、找 magpie 自己的网关
  （默认 `127.0.0.1:3425`，`MAGPIE_GATEWAY_PORT` 可覆盖）、webp→png、钟点双问与分歧判定
- `src/headless.mjs` —— 编排：最多换 4 张图、每张只提交一次（风控不允许反复试同一 token）、
  失败把每轮原因带出来
- 登录方法「手机号验证码」—— `prompts` 问手机号，`authorize` 里过验证并发短信，
  然后 `method: "code"` 等用户填 6 位验证码，`callback(code)` 换登录态并建号

### 两个坑，都是实测撞出来的

1. **`send-sms` 的 `type` 必须是 `"account_login"`**。填 `"login"` / `"phone_captcha"`
   / `"sms_login"` 全部返回 `9999 服务异常，请联系管理员` —— 后端内部炸了，不是参数校验，
   所以从错误信息上完全看不出是 type 的问题。这个值是从浏览器真实请求里抓出来的。
2. **`device` 是必填且结构要试**：缺 → 9999；给字符串 → 9999；
   `{device_id}` → 「id 字段是必须的」；`{id, name}` → 放行。
   ⇒ `{id: 64 位 hex, name: "web"}`。

### 另外两个更贵的修正（第一版发出去就踩了）

1. **`opened` 必须是 `true`。** 这条链路全在后台走完，不需要任何浏览器；写成 `false`
   会让 magpie 拿 `url` 去开**系统默认浏览器** —— 而那个浏览器里往往本来就登着这个站，
   用户看到的是已登录界面，进不了「添加新号」，还以为插件把他登进了旧账号。
   这正是浏览器登录那条路修过的坑，这次在新方法里又踩了一遍。
2. **新号注册要带 `auto_register: true` 和 `redirect`，而邀请码是靠 `redirect` 传的。**
   网页表单的初始值就是
   `{ phone, state_code, code, auto_register: true, type: "phone_captcha", redirect: window.location.href }` —
   服务端从 `redirect` 上取 `?invitation=<码>`，`invite_code` 不是独立字段。
   ⇒ 无头这条路没有「打开带邀请码的页面」这一步，所以必须自己拼出带邀请码的
   `redirect: ${web}/login?invitation=<码>`。少了它，新注册的号就没有邀请关系。


### 没配识图模型时

**不瞎猜。** 容差 ±10° 意味着瞎猜命中率只有约 5.6%（20/360），平均要试十几次，
先撞上的会是「验证提交过于频繁」。这种情况直接报错并指路：去 magpie 设置里配一个
识图模型，或者改用「浏览器登录」。

### ⚠ 未实测的一步

`/v4/user/login` 成功之后**响应里 jwt / 组织码的确切结构没验到** —— 手上没有能收短信的
号码，只能验到 `2168 验证码错误`（这已经证明参数结构对了）。所以那一步写成：
按 `eyJ` 三段式特征找 JWT、组织码找不着就用拿到的 JWT 调
`/api/v1/aggregation/login-data` 补；两条都拿不到时把原始响应带进错误信息。

## 0.3.16

**加了给 AI 执行者的入口 —— 因为「发布」这一步真的被漏过一次**

不是功能改动。这个仓库 0.3.14 发布时只 `git push`，没发 npm、没打 tag、没建 Release，
结果 GitHub 右侧一直挂着「暂无发布版本」、npm 停在 0.3.8。根因不是不知道有发布流程，
是它没进阅读路径。

- **新增 `AGENTS.md`** —— 按「你在哪一步」给阅读顺序（改协议 / 改登录 / 改 key /
  改模型 / 改签到 / 交付 / 发版），外加**本仓库 13 条会静默出错的坑**，
  每条带「症状 → 判据 → 出处章节」。坑都来自 `docs/internals.md` 的实测记录
- **新增 `CHECKLIST.md`** —— A 表代码交付前 14 项（含「两站都验过」「上下文来自查库」
  「流式带 include_usage」「话题查不到就不发」），B 表发版前七步带命令与判据
- [README](./README.md) —— 顶部加三行指路：改代码 / 发版前先看这两份；发布是七步，
  `git push` 只是第 4 步

## 0.3.15

**修掉「网页已经登好、magpie 里一直转圈等」—— 弹窗永远拉不起来**

现象：点「浏览器登录」，浏览器里登完了、跳到 agent 界面了，magpie 的卡片一直停在
「请在浏览器中完成登录」，直到 5 分钟超时。

根因在 `~/.cache/magpie/magicrew-login-<site>.log` 里躺着，每次都是同一行：

```
launch: 本机没找到 Chrome / Edge / Bravo / Chromium
```

**这台机器上 Edge 是装着的**（122.0.2365.106，微软官方包）。`findBrowser()` 写死的
文件名是 `msedge.exe`，但这台机器上微软落盘的名字是 **`Microsoft Edge.exe`**
（带空格、带大写）—— 而另一台机器的 156 版只有 `msedge.exe`。**落盘名随安装方式/版本变**，
写死任何一个都必有一类机器命中不到。`existsSync` 一路 miss → 返回 `null` →
永远走「降级到系统浏览器 + 让用户去 Console 粘一行」。用户看到的就是「登好了但插件还在等」。

顺带两件事：

- **国产 Chromium 系一个都没列**。用户日常用的是 360 极速浏览器 X（360ChromeX，
  Chrome 132 内核），实测 `--remote-debugging-port=0` + CDP `Runtime.evaluate`
  完全可用 —— 没有任何理由不支持。
- **只挑「第一个存在的」**，一旦那个起不来就彻底失败。改成**逐个试**，
  第一个真写出 `DevToolsActivePort` 的才算数；全失败时把每个候选的失败原因都带出来。

### 浏览器优先级（按「谁最干净」排，不是按名气）

```
① Chrome / Chromium   自己装的，无企业策略、无强制登录  ← 首选
② 国产 Chromium 系    用户日常在用的，CDP 实测一样能用
③ Edge                垫底：策略最多、最容易被拦、且用户明确不想用它
```

本机实测（Chromium 154.0.8037.93，scoop 安装）：**起 CDP 650–800ms，页面就绪 ~2s，
`waitForCreds` 正常读到凭据，关窗后 profile 彻底删除。**

- `findBrowser()` 改为返回 `{ name, path }`（原来是裸字符串），新增 `browserCandidates()`
- 新增 scoop / 便携版 Chromium 路径（本机就是 scoop 装的那条）
- `waitPort()` 支持「进程已退出就别白等 8 秒」的提前放弃
- `launchLoginBrowser()` 返回体新增 `name` / `exe`，卡片文案会写明用的是哪个浏览器
- `local-browser.mjs` 的 `roots()` 补上 360 / QQ / 搜狗等，让「本机已登录就直接认」也能命中
- 判据：`node tests/browser-detect.mjs`（Edge 真实文件名 / 国产覆盖 / Chromium 优先 / 逐个试）

### 为什么先修「怎么把窗口拉起来」，而不是去补更多登录方式

这条链只有一个出口：**窗口拉不起来，后面的 CDP 读取一步都走不到**。
0.3.12 及更早的失败还是**静默**的 —— 它会「成功」降级到剪贴板通道，而那一步要求
用户知道有 F12 这回事。所以症状不是「报错」，而是「看起来什么都没发生」。
判据落在 `magicrew-login-<site>.log` 里，就是为了这种静默失败下次能一眼看见。

## 0.3.14

**两处判据修正：国际站看「话题」而不是「项目」；「免费」不再从倍率反推**

来自 PR #4（`fix/free-rate-and-topic-guard`，白九）。两点判断都对，都收；
落地时各改了一处。

### 一、国际站首对话：判据从「有没有项目」换成「有没有话题」

上一版把「已有工作台项目」当成「发过消息」。**这个前提不成立** —— 项目在打开
工作台时就会自动建，「建了项目、一句话没说」的新号很常见，而那种号正是要补的。
被误判成「用过」之后还会落一次性标记，等于永久跳过。

改成：拿项目 → 列它的话题 → 有话题才跳过，没话题就补一条。

```
GET /api/v1/super-agent/projects/{id}/topics
→ { code:1000, data:{ total, list:[{ id, chat_topic_id, chat_conversation_id, topic_name, task_status, … }] } }
```

### 二、`free` 改成三分支（按 `HOOKS.md` 十一之二）

`free` 的判据是「花不花这份订阅的额度」，**不能从 `rate` 反推**。原来的二元
判断把「价格为 0」和「价格未知」混在一起，两种情况都变成 `rate: 0`：

| `input_points` | 处理 |
|---|---|
| > 0 | `rate = n / 2000`，不设 `free` |
| === 0 | `free: true`，不给 `rate`（厂商声明免费 → 进 Free first 那一档） |
| 缺失 | **不列** —— 不猜价格，也不谎标免费 |

产出走 `modelEntry` 已有的 `free` / `rate` 出口（`src/context.mjs` 里
`free` 为真时不输出 `rate`，两者不会同时出现）。

### 与原 PR 的两处不同

1. **查不到 ≠ 没说过话。** 原版 `fetchProjectTopics(...).catch(() => [])`，
   接口抖一下就当成「没有话题」，于是白花一次积分去补消息。改成：查不到就
   **这次不发**、不落标记、不计失败次数，留到下次登录 / 签到再查。
   失败方向要选「宁可漏一轮」那一侧 —— 消息发出去是花钱且不可撤的。
2. **`Number("") === 0` 会误判免费。** 原版用 `p.inputPoints != null` 判「已知」，
   空串也会通过并被算成 0 点。现在要求非空且是有限数字，才算已知价格。

### 实测（2026-10-28，两站真接口）

```
magicrew       org=66p0q56qo47j  workspace 801580653401091055  projects 1  topics 2   ✓
magicrew-intl  org=67u4oe6fbenj  workspace 801566935627653258  projects 1  topics 1   ✓
```

两站同一个 workspace 下 `GET /projects/{id}/topics` 都是 `code:1000`、
`data.list[]` 字段名逐字一致（`chat_topic_id` / `chat_conversation_id` /
`topic_name` / `task_status`），与国内站的 chat-task 链路同构。

⚠ 当前两个账号的模型表里 **76 条模型的 `input_points` 全部 > 0，没有一条 0**
（国内 27 + 国际 49，实测快照）—— 所以三分支这批改动眼下不改变任何列表内容，
它防的是「以后出现真免费的模型」。这一条未能在本机实测覆盖。

## 0.3.13

**首任务补完：登录那一刻做一次，之后永不再发（补齐 0.3.12 的另一半）**

0.3.12 已经把闸门从「按日期」换成「按账号一次」（`src/store.mjs` 的
`isAutoChatSettled` / `noteAutoChatFailure`），国内站的 `autoFirstWork` 也接上了。
这一版补齐剩下的：

- 国际站的 `autoFirstChat` 同样走一次性闸门；「已有工作台项目」直接落成 `sent`，
  以后连查都不查
- **登录成功那一刻**就做 —— `src/hooks/methods.mjs` 三条登录路径
  （本机浏览器接上 / 浏览器登录 / 手填登录态）都会 `kickoffFirstTask(c, jwt, org)`，
  发射后不管、不阻塞登录；签到退回兜底位，只防「登录那次进程被杀 / 网络抖」
- `docs/internals.md` 的 checkin 小节按现状重写：标记文件结构、五种状态各写不写、
  老日期格式怎么读

回顾 0.3.11 的问题：闸门按**日期**记（`{ [org]: "YYYY-MM-DD" }`），服务端没把
`first_ai_work` 翻成 COMPLETED 时，第二天签到又看到 PENDING，就再发一条 ——
一个号天天烧一次模型积分。可这只是「让邀请奖励到账」的一次性条件，做一次就够。

### 实测（2026-10-28，改完当场跑到的）

```
magicrew        (h97gk…)   first_ai_work  PENDING/PENDING → COMPLETED/GRANTED
magicrew#g8rptf (66p0q…)   first_ai_work  PENDING/PENDING → COMPLETED/GRANTED
```

两个号各发一条（都是 `Qwen3.5 Flash`，topicId `973747526032797697` /
`973747424593612801`），结算后任务真的翻成 COMPLETED/GRANTED —— 邀请奖励那条判据拿到。

再调一次 `ensureFirstTaskOnce` 直接返回 `{ settled: true }`：不打网络、不发消息，
一次性闸门生效。


## 0.3.12

**插件不再写 magpie 自己的缓存**

`src/self-register.mjs` 每次加载都往 `~/.cache/magpie/plugin-market.json` merge 一条
自己的条目。那份文件属于 magpie；按包名 merge 意味着一旦包进了官方 registry，
每次启动都会把 registry 条目盖回包里写死的那份 —— 插件不该改写 magpie 给它自己看的列表。

- 删掉 `src/self-register.mjs` 与 `index.mjs` 里的调用
- 顺带修掉一个一直没生效的 bug：条目里 `package` 写的是 `Magicrew`，而 npm 包名是
  `magicrew-auth`，两者对不上，这条自注册从来没能对上卡片
- 卡片标题与文案的唯一载体是 registry 条目；其余行为一行未动

## 0.3.11

**签到接管「完成第一次 AI 工作」—— 不再单开一个按钮**

之前的做法是加一个「进行一次聊天」按钮，手动点。实际用起来多余：
签到本来就是每天跑一次，而首任务只需要做一次。

现在 checkin 里直接做掉，**两个站点都覆盖**：

| 站点 | 判据 | 动作 |
|---|---|---|
| 国内站 | `first_ai_work` 待完成 | 建话题 + 发一条消息，轮询等变 COMPLETED |
| 国际站 | 没有 onboarding 任务，改看「有没有工作台项目」 | 一个项目都没有（从没说过话）→ 建项目 + 发一条 |

一次签到的完整动作：

1. 领每日登录积分
2. 首任务 / 首对话没做过 → 替它发一条消息（纯协议，不开浏览器）
3. 其余新手福利 PUT 完成
4. 报积分变化

「进行一次聊天」按钮已撤掉，登录方式回到原来的两条。

### 实测（2026-10-28）

国际站新号 `bdfbfvre6ml3`（被 `IV3E15GQDCDR` 邀请）发一条消息后：

```
邀请人 dhj：积分 150 → 350
奖励明细：{ reward_points: 200, description: "注册奖励", status: "COMPLETED" }
invited_user_id: usi_817a358e06be15b7…   ← 正是那个新号
```

国内站同样的链路此前已验过（+1000）。**「被邀请人完成首个任务或对话」这条判据，
两个站点都靠一条真实消息满足。**

### 新号没有项目怎么办

新注册的账号只有工作区、没有项目，直接发消息会失败。实测
`POST /api/v1/super-agent/projects { workspace_id, project_name }` 可以建，
名字从固定池里随机挑（和话题名同一个池），已集成进 `runChatTask`。

## 0.3.10

**新增「进行一次聊天（未完成的账号）」—— 纯协议补完首次 AI 工作，不开浏览器**

邀请奖励不是注册即得，条件是「被邀请人完成首个任务或对话」。而这道判定只认
**产品内真的跑完过一次** —— 通过 magpie 调模型不算（实测同一个号调了好几轮、
真扣了积分，`first_ai_work` 仍是 PENDING）。

所以要补的就是「在产品里发一条消息」。原来只能靠 CDP 开浏览器点输入框，
现在不用了。

### 协议（2026-10-27 抓包摸清，已实测跑通）

消息走 **Socket.IO**（Engine.IO v3）：

```
连接    wss://<host>/socket.io/?EIO=3&transport=websocket
登录    42/im,<ns>["login",{context:{authorization:JWT, organization_code, language:"zh_CN"}}]
聊天    42/im,<ns>["chat",{context:{…},data:{message:{…},conversation_id}}]
     → 43/im,<ns>[{code:1000,…seq}]
```

几个反直觉的点，都在 `src/chat-task.mjs` 顶部注释里：

- **鉴权在消息体里**，握手头不带 token —— 所以不用 Cookie、不用登录态
- **不需要先发 `40` CONNECT**，直接 `42` 事件就能被受理
- `<ns>` 是客户端自己生成的唯一数字（浏览器用 `Date.now()`），随便给都行
- 消息里的 `conversation_id` 必须非空，空着回 `3007`；填错回 `3016 话题未找到`

三个 id 的来源（最容易卡住的地方）：

```
conversation_id  ← topic.chat_conversation_id
message.topic_id ← topic.chat_topic_id
（⚠ 不是 project.current_topic_id，用它会 3016）
```

话题直接建：`POST /api/v1/super-agent/topics { topic_name, project_id }`，
返回体里就带 `chat_topic_id` / `chat_conversation_id`。

### 按钮行为

点一下，遍历该站点所有账号：

- 首任务已完成 → 跳过
- 本站没有新手福利（国际站）→ 跳过
- 未完成 → 建话题、发一条、等 AI 回复

两个细节：

- **话题名从固定池随机挑**（`TOPIC_NAMES`，8 个日常短语），免得一堆「测试话题」扎堆
- **模型按积分倍率自动选最便宜的**：查 `/api/v1/products/model-points`，按
  `input_points + output_points` 升序取最小 —— 目前是 `qwen3.5-flash`（20 / 200），
  也正是网页的默认模型。没有免费档

### 模型列表显示计费倍率

网站（模型选择器）名字后面带一个「0.01×」这样的倍率，插件这边原来只有名字。

倍率本身来自运营后台的「模型参考倍率」，前端 locale 原文是
`division: 模型平均金额 ÷ 当前基准金额`。那套配置走 admin 接口，
普通账号的 token 调不到（`/api/v1/flows/model-multipliers` 回 31001）。
magpie 的模型条目里也没有倍率字段，所以直接把倍率拼进 `name`。

数值用 `input_points / 2000` 估：

| 模型 | in | 网站 | 本插件 |
|---|---|---|---|
| Qwen3.5 Flash | 20 | 0.01× | **0.01×** |
| Qwen3.8 Flash | 100 | 0.05× | **0.05×** |
| Qwen3.7 Plus | 200 | 0.10× | **0.10×** |
| MiMo V2.6 Flash | 100 | 0.04× | 0.05× |
| Seed 2.0 Pro | 480 | 0.26× | 0.24× |
| Qwen3.8 Max | 1200 | 0.56× | 0.60× |

低位完全吻合；高位因为真实公式里 output 也参与，有 10% 左右偏差，横向比价够用。
统一两位小数（否则 0.15 会被截成 0.1，和 0.10 混同）。
计费接口失败时退回原名，不影响模型列表。

### 0.3.9 的「体检」按钮撤掉了

功能还在（`src/inspect.mjs` 的 `listAccounts` / `inspectOne` 被新按钮复用），
但不再单独占一个登录方式的位置 —— 需求是「原本两个按钮不动，只加一个」。

### 实测

```
[0s] 挑选模型… [0s] 定位项目… [0s] 建一个话题… [1s] 发送消息…
结果: { ok: true, replies: 1, topicName: "介绍一下你自己",
        model: "Qwen3.5 Flash", messageId: "973731075754430466" }
```

从建话题到 AI 回复完，全程 1 秒多。

## 0.3.9

这一版两件事：新增「体检」，以及删掉一个从来没被读过的字段。

### 新增「体检」：一键看清每个号的首任务做没做、邀请奖励到没到账

拉新有个坑：**邀请奖励不是注册即得**。官方前端 locale 的原文是
「被邀请人完成首个任务或对话后，即可获得 {{points}} 积分奖励」。
于是每次都要手工去网页翻「免费积分计划」那张表确认，号一多就分不清
哪个小号还没跑、哪笔钱卡在什么状态。

在 magpie 的登录方式列表里加两条**只读**检查：

- `超级麦吉: 体检（首任务 / 邀请奖励）`
- `MagiCrew: 体检（首任务 / 邀请奖励）`

点一下，列出该站点所有账号的：积分、首任务状态、邀请码 / 已邀人数 /
已到账积分、奖励明细（含量、状态、对应被邀请人）。

实现：

- 新增 `src/inspect.mjs`
  - `listAccounts()` 枚举宿主 `~/.config/magpie/plugin-auth.json` 里的 magicrew 账号
    （跟 zcode 插件同一套办法，只读本地文件）
  - `inspectOne()` 对单个账号并发查 5 个接口，任一失败只记录不中断
  - `buildReport()` 拼成可直接展示的纯文本
- `src/api.mjs` 新增 `fetchInviteRewards()` —— `GET /api/v1/invitations/rewards`
- `src/hooks/methods.mjs` 各挂一条 method：不输入、不改任何状态；
  用 `throw` 把报告当错误信息弹出来，不在账号列表里留下一条假登录

⚠ 顺带核实的两件事（实测，已写进代码注释）：

1. **通过 magpie 调模型不算「完成首任务」**。同一个号用 magpie 调了好几轮、
   真扣了积分，`first_ai_work` 仍然是 PENDING，邀请奖励一分不发。
   必须在网页 / 官方客户端里跑完一次对话或任务。
2. **8 项任务里只有 `first_ai_work` 要真发消息**。`ai_ppt` 那项虽然也有
   「写好内容，点击发送」的引导，但原文写着「这里仅用于了解发送入口和操作方式，
   不会实际生成内容」—— 是纯点击导览，`PUT` 就能完成。

一个小坑记一下：宿主里的键名有 `magicrew-intl` / `magicrew-intl#z983c8` 这种，
过滤正则写成 `/^magicrew(#|$)/` 会把国际站全部漏掉（体检显示「还没有登录任何账号」）。
正确写法 `/^magicrew(-intl)?(#|$)/`。

### 「承载」徽章由 magpie 自己派生：删掉从没被读过的 `magpie.carries`

0.3.5 为了卡片上那个「承载 X、Y」的徽章，在 `package.json` 里加了 `magpie.carries`。
那是我方提的方案（[#3902](https://github.com/yetone/magpie/issues/3902) 里的 option 1），
magpie 侧**从未发布过读它的版本** —— 上游选了另一条路：

- `766356c`，v0.1.1744 起，`/api/plugins` 每个插件多一个 `serves` 字段：插件**注册的
  provider 名**，每个一次，内置订阅迁到插件上的那些不重复列（页面按内置名字画）。
- 徽章出现条件：有内置订阅迁到这个插件 **或** 注册了两个及以上 provider。单 provider 不出现
  —— 行的标题本来就说了它是谁。
- 「… 正由此插件代替内置运行」那句 tooltip 只留在「名字里有内置订阅」的徽章上。
- 名字就是 `cfg.provider[id].name`，所以想让它读起来清楚，改的是**供应商名**，不是 package.json。

实测（v0.1.1744，windows/amd64，独立 data 目录，本包 0.3.8 以文件夹方式安装）：

```
$ curl /api/plugins
{"spec":"...\\magpie-magicrew-auth","providers":["超级麦吉","MagiCrew"],
 "moved":[],"serves":["超级麦吉","MagiCrew"]}

卡片：承载 超级麦吉、MagiCrew      （一个 pm-chip moved）
title: null                      （没有内置订阅 → 没有「代替内置」那句）
```

修法：删掉 `magpie.carries`。宿主不读它，留着只会让下一个人以为它有用。

判据：装 magpie ≥ 0.1.1744，本包注册 2 个 provider ⇒ 卡片上必然有「承载 超级麦吉、MagiCrew」，
package.json 里不需要任何字段。

## 0.3.8

**签到补上「每日登录积分」—— 国际站一直领不到，根因是它压根不在 onboarding 任务里**

症状：国际站账号点「立即签到」，永远回一句「新手福利 0 项已全部完成（当前积分 N）」，
积分一动不动；可这个号在网页上手动登录，却能拿到一笔「Daily Login Bonus +50」。

根因有两层：

1. 国际站的每日奖励走 `POST /api/v1/login-gift`，和「新手福利」
   （`GET /api/v1/onboarding/tasks` + `PUT .../completion`）是**两套完全独立的机制**。
   0.3.7 的 checkin 只实现了后者，`login-gift` 一次都没调过。
2. 国际站的 onboarding 接口对未登记账号恒返回 `{"participant_type":null,"tasks":[]}`。
   `runCheckin` 把「0 项待办」当成「已全部完成」，于是 outcome 报 `done`、消息报
   「0 项已全部完成」—— 看起来一切正常，实际上什么都没做。

修法：

- `src/api.mjs` 新增 `claimLoginGift(token, org, host)` —— `POST /api/v1/login-gift`，
  无请求体，靠返回的 `granted` 区分「领到了」和「今天已经领过」
- `src/tasks.mjs` 的 `runCheckin` 改成两步：先领每日登录积分，再处理新手福利，
  任一步失败不影响另一步；消息里分别报两块的结果
- 空任务列表不再算成功：如实报「本站无新手福利任务」，不再谎报「已全部完成」

实测（2026-10-27，三个账号）：

| 站点 | 每日登录 | 当天重复调用 |
|---|---|---|
| 国际站 magicrew.ai | +50 | `granted:false`「今日已领取登录积分」 |
| 国内站 letsmagic.cn | **+200** | 同上 |

- 两站路径、方法、返回结构完全一致，只是金额不同
- **幂等**：当天已领返回 `granted:false`，HTTP 仍 200，不是错误 —— 可以每天无脑调
- 国内站同样在漏领：实测 1350 → 1550（+200），不是国际站独有的问题
- 奖励进的是当日 23:59:59 过期的额度包（`expire_type:1`），不累积
- 接口来源：网页登录过程抓包（CDP Network），`POST /api/v1/login-gift` 无请求体

---

**邀请码滚动修复：`store.mjs` 少了一行 import，这个功能从上线起就没工作过**

症状：每个新号注册，浏览器都被带到 `?invitation=<作者的码>`。用户自己的
`invite_count` 永远是 0 —— 也就是说每注册一个号，都在给作者送积分
（国际站 200/次，国内站 1,000/次）。

根因：`src/store.mjs` 的 `rollInvite()` 里调 `fetchOwnInviteCode()`，但文件头
**只 import 了 `node:fs` / `node:os` / `node:path`**，从来没 import 过这个函数。
于是每次调用都在那一行抛 `ReferenceError`，又被下面的空 `catch {}` 静默吞掉：

```js
async function rollInvite(siteId, jwt, org, host) {
  try {
    const own = await fetchOwnInviteCode(jwt, org, host)  // ← ReferenceError
    return writeInvite(siteId, own.code)
  } catch {
    return ""          // ← 错误在这里消失，调用方只看到「没滚到」
  }
}
```

结果 `magicrew-invite-<site>.json` 从来没被写过，`inviteToUse()` 每次都掉进
「没有记录 → 用作者码」这个分支。滚动机制形同虚设。

修法：

- `src/store.mjs` 补上 `import { fetchOwnInviteCode } from "./api.mjs"`
  （`api.mjs` 不反向依赖 store，无循环依赖）
- `rollInvite` 加 6 秒超时（`Promise.race`），失败不再完全静默 ——
  设 `MAGICREW_DEBUG=1` 时打一行错误，避免同类问题再次「安静地死掉」
- `src/hooks/methods.mjs` 三处调用从 `rollInvite(...).catch(() => {})`
  改成 `await rollInvite(...)`：发射后不管的话，host 进程在 callback 之后被回收，
  滚动一样会丢
- `src/hooks/checkin.mjs` 每天签到时顺带滚一次 —— 登录那一路万一被打断，
  第二天还能补上

实测（2026-10-27，隔离 HOME 里验的，不污染真实配置）：

| 站点 | 滚动前 | 滚动后 |
|---|---|---|
| 国际站 | `IV75F0ZKVKXG`（作者） | `IVF4A4H12KM8`（账号自己的） |
| 国内站 | `IVC8BAWYXRY1`（作者） | `IV1475HL797R`（账号自己的） |

> 附带更正 `src/api.mjs` 里一条过时的注释：原来写「网页版 JWT（`device_id` 空）
> 调 `/api/v1/invitations/info` 回 2155 用户不存在」。实测四个账号全是 354 字符的
> 网页 JWT、`device_id` 全为空，接口全部返回 200 并正常给出邀请码 ——
> 上游已经放宽了这个限制，滚动现在是通的，只是以前的 import 缺失挡住了它。

---

**文档更正：checkin 从来没有「顺带续 key」，那条保活链路只存在于文档里**

`docs/internals.md` 第十四节和本文件 0.3.2 那条都写着「checkin 每天用 24 小时
提前量强制续一次 key，防止 refresh_token 闲置 7 天失效」。逐版本核对
0.3.0 / 0.3.2 / 0.3.7：**checkin 路径（`src/hooks/checkin.mjs` → `src/tasks.mjs`）
从未 import 过 `ensureKey`**，全仓 `leadMs` 只出现在 `src/keys.mjs` 自身。

它本来也不需要存在 —— 原来那段论证有个漏洞：

- 「一整天没有请求，key 会静静过期」不成立：续期不靠请求触发，是 magpie 按
  `refreshLead`（10 分钟）主动调 `auth.refresh`。只要 magpie 在跑，有没有请求都会续
- 「挂在 checkin 上补洞」也补不了：真会让 refresh_token 闲置到 7 天失效的场景，
  是 magpie 整整 7 天没开 —— 那时 checkin 同样不跑

**所以没有去补这个功能，而是把文档改回实况**：`src/hooks/refresh.mjs` 绕过了
`keys.mjs` 这个「唯一出口」（它直接调 `api.refreshGatewayKey(auth.refresh)`），
两处各持一份 refresh_token 会分叉。补上 `ensureKey` 会把 key-store 写起来、
进而抢轮换，结果是用户莫名被要求重新登录。真要补，得先把 `auth.refresh`
收敛进 `ensureKey` —— 那是另一件事，不在本 PR 范围。

顺带修正 `internals` 里过时的落盘路径：单槽 `magicrew-key-<siteId>.json`
→ 0.3.3 起的 `<siteId>__<account>` A/B 双槽。并在 `src/keys.mjs` 顶部注释里
标明「refresh 不经过本模块」这处未收敛的口子，避免后人照旧注释误判。

## 0.3.7

**登录先看本机浏览器：你在自己浏览器里登过，插件直接认，不再开窗让你重登**

- 症状（反复被报）：在自己浏览器里登录成功，插件这边却「没多出账号」；点「添加账号」还要在另一个窗口重登一遍
- 做法：点「浏览器登录」时先读本机 Edge / Chrome / Brave / Chromium 的 localStorage
  （`<User Data>/<profile>/Local Storage/leveldb`，明文），找到**这个站点**的 jwt + 组织码就直接接上 ——
  不开窗口、零输入；读不到、或这个账号已经加过，才走原来的自拉窗口
- 关键实现（`src/local-browser.mjs`）：
  - **按 origin 截断**窗口，避免两站记录相邻时串号（把国际站的 org 配到国内站的 jwt 上）
  - **每把 jwt 配它自己后面的 org**（同一站点存过多把凭据时，「窗口里第一个 org」会配错）
  - 过期 / 空组织码丢弃；多把有效凭据取 `iat` 最大的
- 防重复加号：`magicrew-orgs-<站点>.json` 记着加过的 org，命中就不再自动接
  （否则用户想加新账号时只会把它替换成同一个）
- 实测：本机 Edge 27 MB / 29 ms；国内站快速通道 33 ms；国际站注入测试数据 1 ms
- 判据：`node tests/local-browser.mjs`（13 项）

## 0.3.6

**修：添加第二个账号时网页闪一下就关，magpie 里没多出账号**

- 症状：点「添加账号」→ 浏览器正常弹出 → 一两秒内自己关掉；用户确实也登录成功了，但账号列表里没有新账号
- 根因：登录浏览器**复用**同一个 profile（`~/.cache/magpie/magicrew-login-profile`）。第二个窗口一打开，
  localStorage 里就是上一个账号的 `MAGIC:user:authorization` / `organizationCode`，`waitForCreds`
  第一轮（1.5 秒）读到它 → 判定登录完成 → 关窗；magpie 拿到的 `accountId` / `uid` 与已有账号完全相同，
  按契约「同 accountId + 同 uid → 替换旧账号」→ 不新增
- 修法：每次登录一个**一次性** profile（`magicrew-login-<pid>-<ts>-<rand>`），`closeSession()` 关窗后删；
  `launchLoginBrowser()` 开头先 `sweepProfiles()` 清掉历史复用目录与超过 2 小时的一次性目录
  （只认本插件造的名字，且只动目录 —— 同前缀的 `.log` 不碰）
- 第二道防线：`waitForCreds(..., { baseline })` —— 窗口打开时就存在的凭据不算登录成功
- 代价：每次都要在窗口里重新登录一次（独立 profile 本来也没有日常 cookie），换来「读到的凭据一定是本次的」
- 判据：`node tools/verify-profile-scope.mjs`（窗口打开 4 秒后 `READ_CREDS` 必须是空串、关窗后目录必须不存在）
  + `node tests/login-profile.mjs`

## 0.3.5

**卡片上多一个「承载」徽章：`magpie.carries`**

- 症状：Qoder 插件的卡片有「承载 Qoder 国际版 (qoder.com)、Qoder CN」，Magicrew 没有
- 成因：那个徽章的数据源是 `provider.MovedOnto`，只认 **magpie 内置订阅被迁移到插件上**。
  Magicrew 从来不是内置订阅（`internal/provider/migrate.go` 的 `movers` 表），所以永远是空
- 修法：magpie 加 `magpie.carries` —— 插件在 `package.json` 里自己声明它承载哪些供应商，
  后端读进 `pluginEntryJSON.Carries`（JSON 字段 `carries`），前端照样画同一个 `pm-chip moved`
- 本插件声明：`["超级麦吉 (letsmagic.cn)", "MagiCrew (magicrew.ai)"]`
- 兼容性：**旧 magpie 不认这个字段，直接忽略**；只有带 `carries` 能力的 magpie 才画这个徽章

**上下文窗口的三档优先级，兜底从 256K 提到 1M**

```
① 用户在 magpie GUI 里手选的「上下文窗口」   ← 最优先，magpie 直接用
② 模型库（~/.cache/magpie/models.json）查到的真实值
③ 兜底 1M
```

- 兜底从 `256_000` 改成 `1_048_576`：给 1M 而实际只有 128K，上游会在超限时报错、用户看得见；
  给 256K 而实际有 1M，agent 会主动拒绝一段本可以处理的对话 —— 那是静默的能力损失，
  比报错更难查（`pi-ai detected context overflow` 就是这么来的）
- 对照官方社区插件：Qoder 纯硬编码（`context: 1_000_000`）；WorkBuddy 硬编码一张表，
  再从自家 `/v3/config` 的 `maxInputTokens` 覆盖。magicrew 不提供后者，所以查模型库更省事

**发布到 npm：包名 `magicrew-auth`**

- `magpie plugin add magicrew-auth` 从此可用；npm 源的更新按 `version` 检测，有新版本会提示
- git 源标题仍是 `Magicrew`：npm 拒绝含大写字母的新包名，所以发布走 `npm run publish:npm`
  —— `publish-npm.mjs` 临时把 `name` 换成 `magicrew-auth`、跑完无论成败都还原（已实测逐字节一致）
- **README 模型段改版** —— 按 [magpie-plugin-scaffold 0.1.7](https://github.com/MYCF711/magpie-plugin-scaffold/blob/main/README-TEMPLATE.md)：
  开头写发行商（GLM / DeepSeek / Qwen / Kimi…），不写「支持 N 个模型」；表格只列各家最新 / 热门

## 0.3.4

**上下文窗口向 magpie 的模型库查，不再一律填 256K**

- 症状：`pi-ai detected context overflow for model "magicrew/deepseek-v4.1-flash"` —— 会话明明还能继续
- 成因：magicrew 的两个模型接口（`/api/v1/flows/models`、`/v1/models`）**都不返回上下文窗口**，
  早前一律填 `256_000` 当保守值。而 `deepseek-v4.1-flash` 实际是 **1,048,576**，
  等于把可用容量砍掉四分之三 —— agent 拿 256K 判断"放不下"就拒绝了
- 修法：`src/model-context.mjs` 向 magpie 自己的 `~/.cache/magpie/models.json` 查
  （按 `limit.context`，支持全名 / 尾段 / 多厂商前缀取最大），查不到才退回 256K
- 实测：deepseek-v4.1-flash 1,048,576 · qwen3.5-flash 1,000,000 · glm-5.3-flash 262,144 ·
  kimi-k3.1-pro 1,048,576 · 查不到的 256,000

## 0.3.3

**key 按账号隔离 + A/B 双槽，保证每个账号至少一把活的**

- **按账号一份文件**：`magicrew-key-<站点>__<org>.json`
  - 同一站点登两个账号时，第二个登录**不会**覆盖第一个的 key
  - 账号标识用 `org`（组织码，登录后不变），拿不到才退回 `accountId`
- **双槽轮换**：续期签到「另一个槽」再切过去，旧的留在原槽当回退 —— 中途出错能切回来
- **403 自动切槽**：当前这把被上游拒了就换另一槽重试一次（`body` 是字符串时才重发）
- **实测**：`mgw_55ac` 失效后自动续出 `mgw_0671`（槽 a→b），回退槽保留，新 key 立即可用
- **实测**：同一把 key 并发 6 个请求全部成功 —— `mgw_` 是账号级凭据，不是会话级，不存在"被占用"

## 0.3.2

**key 收敛到唯一出口 + 三层凭据各有各的保活**

三层有效期，一层比一层长：

| 凭据 | 活多久 | 说明 |
|---|---|---|
| 网页 JWT | 30 天 | 登录时签发 |
| `mgw_` api_key | **2 小时** | 签一把顶一把，旧的当场吊销 |
| refresh_token | **7 天** | 用一次轮换一次 |

- **所有签发/续期只走 `src/keys.mjs`**，落到 `~/.cache/magpie/magicrew-key-<站点>.json`，**只保留最新一把**
  - 动机：magpie 的 `auth.refresh` 和 loader 若各有一次签发机会，两份本地凭据会分叉，
    谁都不确定手里那把是不是服务端认的
  - ⚠ 早前版本这里写的是「签一把顶一把、旧的当场吊销」—— **那条没验证充分**。
    实测两把不同时间签发的 `mgw_` key 可以同时有效；到底哪种操作会让旧 key 失效
    （PUT 续期？只在 refresh_token 轮换时？）还没分清，见 internals 第十四节的更正
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
