# 更新记录

## 0.3.51 — 2026-10-29

**登录方式按钮不再显示会过期的「上级 xxx」**

真机问题：六个（现在五个）登录按钮上全挂着 `（上级 iuruijtjmkef）`，改了邀请码策略、切了首选账号也不变。
原因不是写死常量，是 **magpie 在插件加载时把 `methods[].label` 读走并缓存** —— 之后 labels 再算也不会重新展示；
0.3.41 起把「当前上级」拼进 label 时就有这个坑。

- `src/hooks/methods.mjs`：所有登录方式的 label 去掉 `（上级 …）`，改成稳定文案
- 动态信息改放 `authorize` 的 `instructions`（每次点登录现算）：
  `本次邀请上级：<accountId|code>（想换：登录页「邀请码」）`
- 覆盖验证码（邮箱/手机）、浏览器登录两处；本机浏览器即时登录那条不带（组织已存在，不消费邀请码）
- 测试：`code-login` 断言 labels 不含「上级」；`invite-policy` 的旧断言改成「固定/auto 都不带」

## 0.3.50 — 2026-10-29

**撤回内置「临时邮箱自动注册机」：注册不是插件该做的事**

- 删除 0.3.47/0.3.48 加的 `tempMailMethod` 与 `src/tempmail-client.mjs`：
  插件不再自己建邮箱、不自动过图、不自动注册账号
- 登录方式回到 5 条（邮箱 / 手机号 / 浏览器 / 登录态 / 邀请码）
- 临时邮箱能力保留在独立页面插件 `magpie-tempmail`：页面只负责建邮箱、收信、捕获验证码；
  用户在供应商登录里自己填邮箱、自己粘贴验证码
- 说明：之前 0.3.47/0.3.48 的自动注册行为只用于本地验证，已作废

# 更新记录

## 0.3.49 — 2026-10-29

**国际站等待时间拉长：HTTP 90 秒、浏览器登录 15 分钟（没代理时不再「刚报错短信才到」）**

真机反馈：国际站没代理时，`/v4/user/send-sms` 20 秒超时先报错，随后短信才到手机；
浏览器登录 5 分钟等待也经常在「验证码刚到、窗口还没打开」时就判失败。

- `src/captcha.mjs`、`src/headless.mjs`：所有 keewood HTTP 请求超时 **20s → 90s**
  （generate / verify / send-sms / login / 组织探测 / 建组织 / 绑定）
- `src/hooks/methods.mjs`：浏览器登录等待 **国际站 5 → 15 分钟**（国内保持 5 分钟），
  提示文案跟着实际分钟数走；两处 `waitForCreds` 都传 `timeout`
- `src/browser-login.mjs`：浏览器调试端口等待 8s → 20s，启动等待 10s → 30s（冷启动/慢盘）
- 测试：`tests/code-login.mjs` 45 条全过（方法表按 0.3.47 的 6 条更新）；`check.mjs` 30/4/0

## 0.3.48 — 2026-10-29

**临时邮箱自动登录：旋转验证整轮重试（4×4 张图）**

0.3.47 的 `startCodeLogin` 一轮只换 4 张图；实测新号第一次点「临时邮箱·自动」时，4 张全撞上
「两个判官分歧」直接失败。现在 callback 里整轮重试，最多 4 轮（16 张图），每轮之间歇 2.5 秒。
`yzcalo.com` 不在 magicrew 的一次性域名黑名单里，角度只要有一次判对就能过。

## 0.3.47 — 2026-10-29

**国际站新增「邮箱验证码（临时邮箱·自动）」：点一下，插件自己建临时邮箱、过旋转验证、收码、完成登录**

- 新文件 `src/tempmail-client.mjs`：temp-mail.io 公开 API（`yzcalo.com` 域名），建自定义地址、轮询收件、抽 6 位码
- `src/hooks/methods.mjs` 的 `tempMailMethod(c)`：只挂国际站；无 prompts，`authorize` 只建邮箱（秒回），
  `callback` 里走 `startCodeLogin → waitTempCode → finishCodeLogin → completeSignIn`
- 为什么用 temp-mail.io：实测 `maxxspace.com`（mail.tm）/ `guerrillamailblock.com` / `mailinator.com`
  的地址在 `/captcha/verify` 全部被拒；`qq.com` / `163.com` / `gmail.com` / `yzcalo.com` 直接过。
  这是域名黑名单，不是识图问题
- `tests/browser-login.mjs` 的顺序断言改成 6 条（邮箱 → 临时邮箱 → 手机号 → 浏览器 → 登录态 → 邀请码）
- 真机验证：`mkmvt4ecngirl1@yzcalo.com` 完整登录成功（JWT 354 字节、org `njekbb588hnn`）；
  CLI 再登一次新地址 `mk1793253651x@yzcalo.com` 也成功，落库 key 后 `/v1/chat/completions` 回 200

## 0.3.46 — 2026-10-29

**浏览器登录也走「无组织就建第一个组织」**

0.3.44 只在验证码登录那条路补了建组织；浏览器登录（本机浏览器 / 插件拉起的窗口）拿到的是
localStorage 里的 `authorization` + `organizationCode`，**无组织账号的 organizationCode 是空的**，
于是 `completeSignIn` 拿空组织码去 `fetchPoints` 必失败，报「没有可用的组织码」。

- `completeSignIn`（`src/hooks/methods.mjs`）：候选组织全验不过时，重新探测一次组织列表；
  仍为空且 `auth/status` 回过 **3102** → 建首个组织（邀请码在这一步消费）→ 绑定 → 再验一次
- 只认 3102，别的失败（网络抖动 / token 过期）绝不顺手建组织
- `bindOrganization` 从 `headless.mjs` 导出复用
- 这样三条登录路（验证码 / 浏览器 / 登录态）对「已注册但 Magic 没组织」的号行为一致

验证：`tests/code-login.mjs` 45 条、`tests/browser-login.mjs` 顺序断言、`tests/invite-policy.mjs` 23 条全过

## 0.3.45 — 2026-10-29

**建组织回 `{code:1000, data:[]}` 时不再误报「没有组织码」**

真机（用户重试 0.3.44 的原文）：

```
the sign-in failed: 建组织回了 1000 但没有组织码：{code:number, message:str(4), data:[0]}
```

`POST /v4/user/organizations` 成功时可能回 `{code:1000, message:"请求成功", data:[]}` ——
**1000 但没有组织码**。组织这时可能已经建好了，只是响应里不带码；上游前端拿到
`undefined` 也照样去 `auth/status` 拉一遍组织列表。

改动（`src/headless.mjs`）：

- `createFirstOrganization`：1000 + 无码 → 返回 `{org:"", via}`，不再抛
- `finishCodeLogin`：拿不到码就重新探测组织列表（0 / 1.2s / 3s 三次，给最终一致性），
  探测到就用；三次都没有才报错
- 测试：`tests/code-login.mjs` 新增「建组织回 1000 + data:[] → 重新探测拿到组织」

## 0.3.44 — 2026-10-29

**修掉「登录成功但拿不到组织码」：无组织的新号自动建首个组织（邀请码在这一步消费）**

真机症状（用户截图）：验证码登录成功、拿到了 438 字符的 `access_token`，但组织探测全是空：

```
login-data/Bearer  200 但列表为空
auth-status/Bearer 3103 authorization 不合法
auth-status/裸     3102 用户尚未创建账号   ← 关键
me-organizations   3103
```

原因不是「令牌不对」，是**这个号在用户中心登录成功了，但 Magic 里还没有用户/组织**。
上游前端的正解不是报错，是建第一个组织 —— 邀请码也正是在这一步才消费（不是登录那一下）。

改动（`src/headless.mjs`）：

- `finishCodeLogin` 在「组织探测为空 **且** `auth/status` 回过 3102」时，自动建首个组织：
  - 有邀请码 → `POST {keewood}/v4/user/organizations`
    `{ name:"个人组织", industry_type:"其他", register_code:<邀请码>, logo:{} }`
  - 码已被用（2152）→ 自动改走 `POST {keewood}/v4/users/organizations/create` `{invite_code:""}`（前端「继续登录」那条）
  - 建完用 `GET /api/v1/auth/status` + `Organization-Code:<新码>` 再绑一次，拿 magic 侧真正的组织码
  - 建组织返回的码也保留为候选，`completeSignIn` 会逐个用 `fetchPoints` 验
- **只认 3102 才建**：3103（token 过期）、网络抖动、有组织但探测失败，都不会顺手新建组织 ——
  否则会给已有账号多建一个组织
- `methods.mjs` 把当前邀请码（`inviteToUse`）传进 `finishCodeLogin`
- **附带修掉一个只有纯 HTTP 客户端才踩的坑（`src/captcha.mjs`）**：`/captcha/generate` 会回
  `set-cookie: acw_tc=…`（阿里云 WAF），`/captcha/verify` 不带回去就回 `2000 客户端信息不匹配`。
  Node 的 fetch 默认没有 cookie 罐，现在自己记住并在后续每个 keewood 请求里带上。
  真机实测：带 cookie 后同样的验证请求从「客户端信息不匹配」变成按角度判的「验证不通过」

验证：

- `tests/code-login.mjs` 新增 8 条：端点/请求体/authorization/origin、绑定、2152 兜底、失败不吞错、
  **没有 3102 不建组织**、WAF cookie 回传
- 真机端点核对（2026-10-29）：用真实 354 字符 JWT 调 `check-create` 回 `{"code":1000,"data":{"result":true}}`；
  同一把令牌 POST `/v4/user/organizations` + 无效邀请码回 `{"code":2152,"message":"邀请码错误"}`
  ⇒ 端点、裸令牌（不带 Bearer）、请求体都对得上；这一步不创建任何组织

## 0.3.43 — 2026-10-29

**国际站「邀请码」之后默认改问邮箱（原来写死手机号）**

用户报的 bug：国际站（magicrew.ai）点「邀请码」→ 填完邀请码 → 下一个输入框默认问**手机号**。
国际站用户大多是邮箱注册的，这条入口又是给新号带邀请码用的，默认问手机号等于把注册路带偏。

- `src/hooks/methods.mjs`：`makeMethods` 里新增 `primaryMethod` / `primaryKey`（国际站 = 邮箱方法，国内站 = 手机号方法）
- 「邀请码」的 `ask` 链改成 `邀请码 → primaryMethod 的第一个输入项 → null`；`authorize` 保存策略后调用 `primaryMethod.authorize`
- 国际站的邮箱方法只建一次，登录方式列表和「邀请码」入口共用同一份（避免以后改文案只改一处）
- **手机号验证码本身不受影响**：国际站仍有第 ② 条「手机号验证码」，想用手机号注册直接点它；邀请策略对两条路都生效
- 国内站行为不变：仍然是「邀请码 → 手机号验证码」

验证：

- `tests/invite-policy.mjs` 23 条（新增国际站 ask 链 / authorize 分支；国内站分支仍锁死）
- `tests/code-login.mjs` 36 条（方法表按 0.3.41 之后的真实条数修正：国际站 5 条、国内站 4 条；新增邀请码 → 邮箱/手机号的分叉断言）
- `tests/browser-login.mjs` 方法顺序修正为 5 条（0.3.41 加「邀请码」时漏更新，这次一并补上）

## 0.3.42 — 2026-10-29

**邀请码灰色字去掉「固定」：只有自动 / 首选两种**

0.3.41 把「已保存的首选快照」在首选项后来变化时显示成「固定」，看起来像第三种模式。
它只是显示标签，不是用户选项；现在统一成：

- 自动 → `当前模式：自动，输入 1 切换：首选`
- 已保存首选 → `当前模式：首选，输入 0 切换：自动`

内部策略仍可能是 `fixed`（保存的是当时首选的码快照），但界面不再出现「固定」。

验证：`tests/invite-policy.mjs` 20 条。

## 0.3.41 — 2026-10-29


**按钮改名「邀请码」；灰色字显示当前模式；保存后直接接手机号验证码**

- 登录方式 `超级麦吉 邀请上级` → **`超级麦吉 邀请码`**（去掉歧义）
- 输入框灰色字（placeholder）每次点开按已保存策略实时生成：
  - 自动 → `当前模式：自动，输入 1 切换：首选`
  - 首选 / 固定 → `当前模式：首选`（或 `固定`）`，输入 0 切换：自动`
- 0 / 留空 / 非法文本 = 自动；1 = 当前首选账号；保存发生在手机验证码之前
- `authorize` 保存策略后**直接调用手机号验证码方法**：邀请码 → 手机号 → 验证码，
  不再返回「已保存」的失败提示
- `tests/invite-policy.mjs` 20 条（灰色字实时、ask 链、保存后接手机、首选切换）

## 0.3.40 — 2026-10-29


**邀请上级简化：自动=0；首选=1（0.3.39 补丁）**

按截图页面反馈，不再列 1..N 账号；只看 magpie 账号页「首选」：

- **0 / 留空 / 非法文本** = 自动（首次用作者码，之后跟随最后登录 / 签到的滚动码）
- **1** = 当前首选账号（`logins.json` 的 `first`，Make first 写的那一个）的邀请码
- 想换：先在 magpie 账号页切首选，再点一次「邀请上级」填 1
- 没有列表、没有 1..N、没有 -1；首选账号没有码时回退 0 auto

`preferredOrg(siteId)` 只读 `logins.json` + `plugin-auth.json` 换 org；
提示固定一行「邀请上级：自动=0；首选=1；不填=默认自动」。

验证：`tests/invite-policy.mjs` 19 条（0/1/切换首选/首选无码回退）。

## 0.3.39 — 2026-10-29


**点开「邀请上级」时提示文本刷新到当时态**

0.3.38 靠 `ask()` 动态生成提示；部分宿主/调用路径直接读 `prompts` 时仍是插件
加载时那一份。现在 `prompts` 改成 **getter**：每次 magpie 点开登录方式时按当时
的 `magicrew-invite-<site>.json`（0 的滚动码）和账号清单重新生成；`ask()` 保留。

验证：`tests/invite-policy.mjs` 22 条（新增 getter 动态刷新）。

## 0.3.38 — 2026-10-29


**邀请上级：0 改为「当前滚动码」并按需隐藏重复账号（0.3.36 / 0.3.37 补丁）**

0.3.36 把 0 做成了固定作者码；用户指出 0 应该是**老的滚动规则最新那个**：
0 显示的账号/码随 `magicrew-invite-<site>.json` 滚动；当前 0 指向的账号仍在
后端 1..N 的编号里，但提示里隐藏，等 0 换成新号后自动露出来。

- 0 / 留空 / 非法文本 = auto（当前滚动码；没有滚动时作者码 MYCF711）
- 1..N = `magicrew-invite-codes-<site>.json` 的记录顺序（不重排；排除与作者码
  重复的作者账号）；当前 0 指向的那一格隐藏
- 1..N 固定该账号；填后端存在但隐藏的编号（如 3）仍可选
- 删掉 0.3.36 的 -1（0 已经是自动）

验证：`tests/invite-policy.mjs` 21 条（0 当前滚动 / 隐藏重复 / 1..N / 越界回退 /
backfill）。

## 0.3.37 — 2026-10-29


**邀请上级数字列表过滤已删除账号（0.3.36 补丁）**

`inviteEntries()` 按 `liveOrgs()` 过滤码缓存里的死号（只看 `plugin-auth.json` 里
还登录着的 org），避免数字列表里出现已删除账号；账号文件读不到时不过滤。

## 0.3.36 — 2026-10-29


**设置回到登录页：一个数字文本框（0=作者，1..N=账号，-1=自动）**

按反馈把 0.3.33 的插件页面删掉 —— 不需要单独一个界面，登录页多一个按钮就够：

- 登录方式列表新增 **`超级麦吉 邀请上级`**：一个 `text` 输入框，填数字
  - **0 / 留空** = 我的（作者 MYCF711）的作者码
  - **1..N** = 已登录账号（按 accountId 排序，稳定），保存账号 + 它的邀请码
  - **-1** = 自动（跟随最后一个登录 / 签到的号）
  - 不存在的数字 / 非数字 → 回退 0
- 对照表（`0 = 我的…；1 = 138****0000（IV…）`）由 `ask()` 每次打开时按最新账号
  清单生成，写进 prompt 的 message
- 保存只落盘策略，不登录、不新增账号（`authorize` 返回 `{type:"failed"}`）

删掉的：`page/`（index/app）、`package.json` 的 `magpie.page` 与 `files` 里的
`page`、`syncInvitePage()` / `readAccountLabels()` / `pruneDeadAccounts()` 和
`usage` 的页面心跳。保留 `backfillInviteCodes()`（config 后 20s 给老账号补码）。

**限制**：magpie 的 prompts 只有 `text` / `select`，没有「输入框右边实时显示对应
账号」的复合控件；所以对照表在提示里，输入后点下一步回一条「新号挂在 X（码）」。
要真正的右侧实时刷新得等上游加控件。

验证：`tests/invite-policy.mjs` 20 条（数字方法 0/1/-1/留空/越界、死号回退、
backfill）；其余测试不变。

## 0.3.35 — 2026-10-29

**设置页：锁定关闭时明确说明「选择只保存、不生效」**

0.3.34 的页面在「锁定」关掉时仍提示「下一个新号就按这个走」，与实际行为不符
（登录侧会回到滚动 / 作者码）。现在：

- 锁定关掉时，勾选框下面直接写明「下面选的码只保存，不生效」
- 此时点账号 / 保存自定义码，状态栏提示「已保存选择；但锁定已关闭，当前仍跟随
  最后一个登录/签到的号」

只改页面文案，行为不变。

## 0.3.34 — 2026-10-29

**页面账号列表为空：升级后补一次邀请码（0.3.33 补丁）**

0.3.33 的页面清单只读 `magicrew-invite-codes-<site>.json` —— 老用户升级上来时
这份缓存可能一条都没有（旧版从不记），页面就是空的，要等下一次签到/登录。

现在 `config` 之后 20 秒异步跑一次 `backfillInviteCodes()`：读 `plugin-auth.json`
里每个账号的 JWT，逐个问 `/api/v1/invitations/info`，补进码缓存并刷新
`page/codes.js`。只补缺口；失败静默（JWT 过期 / 设备指纹不对就跳过），下次签到
仍会补。

验证：`tests/invite-policy.mjs` 24 条断言（新增 backfill 一条）。

## 0.3.33 — 2026-10-29

**批量：登录窗口去重 · key 自愈 / 413 人话 · 「超级麦吉设置」页面 · 死号回退**

（核心改动来自 PR #17，作者 @baijiu666，合并了原 #14 / #15 / #16；合入时补了页面作者项 / 锁定勾选 / 页面 auto 语义等，见文末。）

### 一、登录窗口只拉一个浏览器（原 #14）

Windows 实测：Chrome + Edge 并存时一次点击 spawn 两次；浏览器父进程 `exit 0` 后
窗口挂在另一批子进程上，点几次叠几个。现在：

- 只试第一个能用的浏览器，失败直接交手动登录，不再用窗口堆失败
- 参数集照 `GoogleChrome/chrome-launcher` 补全（含 `--remote-allow-origins=*`）
- 失败按一次性 `--user-data-dir` 精确杀进程树，再删目录
- 一次失败后 30 分钟冷却（`cdpDownUntil`），冷却期内直接走手动登录

### 二、key 自愈 + 413 人话（原 #15）

- **自愈**：候选 key 全被拒时，用 `refresh_token` 续一把再试一次（只一次，失败照旧
  402 交 magpie 换号）。修「有积分却一直 403 / 已耗尽」：key 被别处会话顶掉后，
  不到 `expiresAt` 不会自动续，三把全死就死循环。
- **413**：上游（Swow/PHP）请求体硬上限约 8MB（实测 6MB 过、8MB 拒），超了回
  HTML 页；插件改写成人话 JSON：压缩上下文或新开会话，换账号无效。

### 三、「超级麦吉设置」页面 + 死号回退（原 #16）

- 插件页（`page/`）按站点设置：**我的（作者 MYCF711）** / 自动 / 每个已登录账号
  （打码手机号·自己的码）/ 自定义码；**「锁定（签到不再覆盖）」勾选框**
- 设置写进插件 options（`inviteBySite` / `inviteLockBySite`），登录侧优先于文件策略
- 页面数据 `page/codes.js` 由 Node 侧生成（页面沙箱读不到账号），在 config / 签到 /
  登录 / 策略变更 / usage 轮询（60s 节流）时刷新
- 两个「只设置不登录」的 methods 入口删除 —— 不再用 `{type:"failed"}` 伪装登录
- 账号删除后：`liveOrgs()` 只认 `plugin-auth.json` 里还登录着的 org；fixed 指向死号 /
  滚动码归属死号 → 自动回落（滚动 → 作者码）；`syncInvitePage()` 清码缓存和归属死号
  的滚动码；页面打 ⚠ 标
- `inviteTag` 与登录同源：标题显示的上级 = 登录真正会用的码的来源（含死号校验）

### 合入时补的

1. **页面加「我的（作者 MYCF711）」** —— PR 的页面只有自动 / 各账号 / 自定义，没有作者项
2. **页面加「锁定（签到不再覆盖）」勾选框**（按站点 `inviteLockBySite`）—— PR 的
   `auth.options` 开关读的是 `input.magpie.options()`，实测恒为 `{}`，失效；现在改用
   工厂第二参数 `(ctx, options)`，页面写 `inviteLockBySite`，登录侧实时读
3. **页面「自动」不再被文件策略覆盖** —— `optionInvite()` 显式 auto，`inviteFromOptions()`
   回落到滚动 / 作者码；锁定关闭时页面选的码也不作数
4. **作者 org 统一为空** —— 旧版把作者码存成 `org:"author"`，会被死号校验当已删除；
   读策略时归一化，页面/方法都用 `org:""`
5. `package.json` 的 `files` 补 `page`（否则 npm 包里没有页面）；`.gitignore` 忽略
   运行时生成的 `page/codes.js`；页面主题变量改用 `--magpie-*`
6. `tests/invite-policy.mjs` 扩到 23 条（死号回退、页面 auto / 锁定、codes.js 生成）

### 验证

```
tests/invite-policy.mjs    23 通过 · 0 失败
tests/key-failover.mjs     26 通过 · 0 失败
tests/auto-maintenance.mjs 21 通过 · 0 失败
tests/credit-refusal.mjs   19 通过 · 0 失败
tests/account-fallback.mjs 10 通过 · 0 失败
tests/body-rewrite.mjs     48 通过 · 0 失败
multi-provider / browser-detect / smoke 全过；scaffold check.mjs 30 通过 0 失败
```

## 0.3.32 — 2026-10-29

**邀请上级可固定 / 自定义（PR #13，作者 @baijiu666）**

### 你看到的

登录方式列表里多了两个入口：

- **`超级麦吉 邀请上级`** —— 展开的按钮列表，第一项是「我的（作者 MYCF711）」，
  接着是「自动（跟随最后一个登录 / 签到的号）」，然后是每个已登录账号
  （手机号/邮箱打码 + 自己的邀请码）
- **`超级麦吉 邀请上级：自定义码`** —— 文本框，IV 开头 12 位；留空不改

另外 provider 设置里多了一个开关：

- **`锁定邀请上级（签到不再覆盖）`**，默认开。打开时新号固定挂在选定的码下；
  关掉就回到「跟随最后一个登录/签到的账号」。

两个入口都只落盘 + 回一条「已保存」，不登录、不新增账号
（`authorize` 返回 `{ type: "failed" }` 是 magpie 唯一不建号的出口）。

### 为什么不是「一个文本框 + 展开按钮」

magpie 的 `prompts` 只有两种控件：`select`（一排按钮）和 `text`（输入框），
没有把两者合成一个控件的口子；要真正做组合控件只能写插件页面/面板，而页面
**读不到账号邀请码**（`PageReads` 只给 `usage:summary` / `providers:list`，
不含账号）。所以用两个单步入口，最稳。

### 实现

- `src/store.mjs`：`readInvitePolicy` / `writeInvitePolicy` /
  `magicrew-invite-codes-<site>.json`；`inviteToUse(siteId, locked)` 在锁定时
  优先策略，否则回落到滚动文件；`authorInvite()` 给「我的」。
- `src/hooks/methods.mjs`：两个 `api + keyless` 入口；`inviteChoices()` 生成
  作者 → 自动 → 各账号的列表；`accountLabel()` 只认本站点的 provider key。
- `index.mjs`：`auth.options` 声明 `inviteLock`，用 `input.magpie.options()` 读
  （不是 `option()` —— 后者对未知键也返回 false，加载早期会把默认 true 误判成关）。

### 合入时改的

- PR 原列表第一项是「保持当前」；改成「我的（作者 MYCF711）」在第一位，并补上作者码。
- `accountLabel` 原来用 `startsWith(siteId)`，`magicrew` 会把 `magicrew-intl#…`
  也算进来；改成 `k === siteId || k.startsWith(siteId + "#")`。
- 增加「锁定邀请上级」开关（PR 只有 fixed/custom 就默认覆盖，没有显式锁）。
- 补 `tests/invite-policy.mjs` 17 条断言。

## 0.3.31 — 2026-10-29

**自动更新加全局锁（0.3.30 补丁）**

0.3.30 的 `magicrew` 与 `magicrew-intl` 两个 provider 会在同一时刻各自跑
`config`，各调一次 `kick`，可能同时 spawn 两个 `magpie plugin update`。
0.3.31 加全局锁 `~/.cache/magpie/magicrew-auto-update.lock`（10 分钟过期）：
一个更新进程在跑时，另一个 provider 直接跳过。

验证：`tests/auto-maintenance.mjs` 21 条断言（新增「已有未过期全局锁 → locked」
与「进程退出后释放锁」）。

## 0.3.30 — 2026-10-29

**默认开启自动签到 · 插件自身自动更新**

### 一、默认开启自动签到

magpie 的插件签到开关 `pluginCheckins` 默认是**关**的：`PluginCheckinOn()`
在没有显式值时只跟随厂商内置开关（WorkBuddy / Trae / MiniMax / Qoder），
magicrew 没有内置开关，于是新装插件不会自动签到。

插件加载时读 `~/.config/magpie/settings.json`：**只有这个 provider 从未被
用户设置过**，才补一个 `pluginCheckins[provider] = true`。用户显式关掉的
（false）绝不覆盖；settings.json 读不出来也不覆盖。config 钩子先补一次，
usage 钩子再兜一次（防止 magpie 启动时把内存里的旧 settings 写回）。

### 二、插件自身自动更新

magpie 的自动更新只认 `@magpie-community/*`（源码 `internal/plugin/updates.go`
的 `Official()` 硬编码这个前缀）—— 第三方插件无论 npm 源还是 git 源，都只会
在插件列表里提示「有新提交」，等用户点更新。这就是为什么社区包（Qoder、
CodeArts、商汤小浣熊、OpenCode Zen Free）有「已自动更新」徽章，而本插件没有。

插件没法改 magpie 的判断，只能在插件侧复刻同一套机制：

1. `config` 加载 15 秒后、以及每次签到成功后，读 magpie 写好的
   `~/.config/magpie/plugin-updates.json`，看 `waiting` 里有没有
   `package === "Magicrew" && git === true` 的自己；
2. 有就调本机 magpie 的 CLI：`magpie plugin update`（进程树里找 magpie，
   也可以用环境变量 `MAGPIE_EXE` 明示；找不到就记 `no-magpie-exe` 并放弃，
   不伪造徽章）；
3. CLI 成功退出（code 0）后，在 `plugin-updates.json` 的 `updated[]` 里补一条
   `{package:"Magicrew", from, to, at}` —— magpie 的「已自动更新」徽章
   （`plugin.LastUpdated()`）读的就是这个记录。

节流：同一版本 6 小时内最多试一次；成功后按 `to` 版本记住不再重复。所有失败
都只写状态文件，不影响签到/额度/登录。

### 边界（必须知道）

- `magpie plugin update` 是 CLI 进程内的 `plugin.Update()`，会重装**所有**
  非路径插件；它不会重启正在运行的 magpie —— 更新文件后，下次启动 magpie
  才会加载新代码。插件列表的「已自动更新」徽章会立即出现（读的是文件记录）。
- 找不到 magpie 可执行文件时不会自动更新，也不会显示徽章；设 `MAGPIE_EXE`
  可指定。
- 这一步是插件对 magpie 的两个配置文件（settings.json / plugin-updates.json）
  的读写 —— magpie 没有给插件提供这两个能力的 API（GUI API 只服务于它自己的
  WebView，不是 TCP 端口）。写 settings 只在「该键不存在」时发生，且先备份为
  `settings.json.bak-magicrew-auto`。

### 验证

- `tests/auto-maintenance.mjs` 20 条断言 0 失败：默认签到只补缺失、显式 false
  不覆盖、坏 JSON 不覆盖；`pickSelfUpdate` 只认自己且只认 git；`noteUpdated`
  去重/截断；`kick` 的 no-update / no-exe / throttled / done / dryRun / 成功
- 本机真实 `plugin-updates.json` 的 dryRun：命中 `Magicrew 272b812 → 050b0f4`，
  解析到 `E:\Downloads\magpie-windows-amd64.exe`；`ensureCheckinDefault` 对
  `magicrew` / `magicrew-intl` 均返回 explicit:true（已是用户开着的，不改）
- `magpie plugin list` CLI 正常（只读）

## 0.3.29 — 2026-10-29

**同一账号多把 key 逐把试 · 全部被拒改 402 · 续期收敛到 key-store**

（核心改动来自 PR #12，作者 @baijiu666；合入时补了五处，见文末「合入时补的五处」。）

### 症状

ZCode 经 magpie 网关调 `magicrew-intl/deepseek-v4.1-flash` 整轮失败：

```
provider_code=403  reason=auth_failed  status=403  retryable=false
界面显示：token无效
```

`retryable=false` ⇒ magpie 不换号，错误直接抛给客户端。同一 provider 下其他账号明明还有余额。

### 根因：key 有两条签发路径，本地各存一把、静态挑一把

- `src/hooks/refresh.mjs` —— magpie 的续期，签发后只交给 magpie，**不写** key-store
- `src/keys.mjs` 的 `ensureKey` —— 请求路径自己续期，写 key-store

两边各存一把；api_key 只活 2 小时，两条路各自什么时候续、续到哪把，本地并不一致。
静态挑其中一把，踩空就是 403「token无效」。

PR 提交者 2026-10-29 逐把打 `/v1/chat/completions` 实测（5 个国际站账号）：

| 账号 | `auth.access` | store 当前槽 |
|---|---|---|
| magicrew-intl | ✅ | ❌ |
| magicrew-intl#z983c8 | ✅ | ❌ |
| magicrew-intl#3oqx5z | ❌ | ✅ |
| magicrew-intl#h2mcxi | ❌ | ✅ |
| magicrew-intl#8amjca | ❌ | ❌ |

**5 个里 3 个两路状态不一致，方向还各不相同** —— 静态顺序（先 store 或先 auth）都救不了。

⚠ 不要把这条读成「服务端同一账号只认最新签发的那把」—— 2026-10-28 的受控实验
已经推翻过这个说法：同账号相隔 67 秒签的两把同时有效；12 把逐把探活，403 **全部**
对应 `expiresAt` 已过。真正的失效原因是**手里那把过期了**，而两条路径让本地不知道
自己手里的是哪把。逐把试解决的是这个「不知道」。

补一条取证经验：对这种死 key，`GET /v1/models` 是**放行**的，只有 chat 才 403。逐把探活必须用 chat。

### 修法（三处）

1. **`src/keys.mjs` 新增 `keyCandidates()`** —— 同一账号的所有候选 key（store 当前槽 / 另一槽 / `auth.access`），去重后按 `expiresAt` 倒序。到期越晚 = 签发越晚 = 越可能是活着的那把。配套 `adoptKey()` 把命中的那把写回 store。

2. **`src/hooks/loader.mjs` 逐把试 + 全挂改 402** —— `isKeyRejected()` 认两种形态：`HTTP 403`，以及 **`HTTP 200` + `{"code":403,"message":"token无效"}`**（绝大多数是这种，只看状态码会漏）。全部被拒时返回 **402** 而不是 403 —— 402 在 magpie 里是 `failCredit`，会把这个账号 rest 30 分钟、去问下一个账号 / 组的下一个成员，与 0.3.26「积分不足改写 402」同一条通路。SSE 一律不碰。

3. **`src/hooks/refresh.mjs` 收敛到 key-store** —— 改调 `renewViaStore()`，由 store 统一持有 `refresh_token` 并写回新 key，magpie 拿到的是同一把；且与 `ensureKey` 共用 `renewOnce` 锁（按 siteId+account 去重），避免两条路径同时续期、后到的那次用废 token 被误判成「登录已失效」。

### 验证（PR 提交者实测，2026-10-29）

`makeLoader().fetch` 直接喂真实账号（不经过 magpie）：

```
① store 那把已死 / auth 活的（z983c8） → HTTP 200 ✅
② 两把都死（8amjca）                  → HTTP 402 + 可读原因（交给 magpie 换号）
③ auth 已死 / store 活的（h2mcxi）     → HTTP 200 ✅
```

全账号跑一遍：国际站 5/5 → 200；国内站 `magicrew` / `lky0b4` / `0ok4oa` → 200；`4rm3fp`（积分 -28）→ 402「可用积分已不足」（0.3.26 的改写，正确）。

经网关三条链路 `magicrew/…`、`magicrew-intl/…`、`group/never-stuck` 全部 200。

### 验证（合入后复核，2026-10-29 02:15）

两站各取真实账号（国际 `magicrew-intl#m2orth` / 国内 `magicrew#3wbzad`），隔离 HOME、
复制真实 key 构造四场景，用 magpie 自带的 bun 直打上游：

| 场景 | 国际站 | 国内站 |
|---|---|---|
| A 基线（store 活 + auth 活） | 200 | 200 |
| B store 死 / auth 活 | 200，且写回 store 另一槽 | 200，且写回 |
| C store 活 / auth 死 | 200（命中 store 那把，不重写） | 200 |
| D 三把全死 | 402 + 可读原因 | 402 + 可读原因 |

`tests/key-failover.mjs` 25 条断言把以上全部离线钉死（`node tests/key-failover.mjs` 退出 0）。

### 边界

- 不跨账号借身份：只用**本账号**的 key；本账号全挂就交 402 让 magpie 决定换谁，与 0.3.23 `accountFor()` 的保守立场一致
- 只有第一把被拒时才会多发请求；命中那把只走 1 次

### 合入时补的五处

1. **`renewViaStore` 会试两处 refresh_token** —— 升级上来的第一次续期，store 那份可能早被旧的 `refresh.mjs` 轮换废了；只认 store 会让用户莫名被要求重新登录。现在 store → `auth.refresh` 依次试，谁活谁写回。
2. **`adoptKey` 空 store 时保留 `auth.refresh`** —— 首次接管、续期失败但 `auth.access` 还能用时，PR 初版写回 store 会丢掉 refresh_token，2 小时后没人能续。
3. **`isKeyRejected` 只认业务错误码** —— PR 初版用文本正则，正常回复正文里恰好出现 `unauthorized` / `token无效` 就会被当成 key 拒绝，白白重发（可能重复计费）。现在先 `JSON.parse`，只看 `code` / `message` 字段；有 `choices` 的正常响应绝不判。
4. **被拒响应的 body 显式取消** —— 逐把试时，每条死连接的响应体不会一直挂着等 GC。
5. **`refresh.mjs` 不再要求 `auth.refresh` 存在** —— refresh_token 只躺在 key-store 里时（`ensureKey` 续过、magpie 那份已轮换），PR 初版直接 `return undefined`，key 到期就掉登录。

## 0.3.28 — 2026-10-29

**邮箱验证码登录（内置）· 已有账号不再过旋转图 · 识图模型被 `max_tokens` 饿死的修复**

### 一、邮箱验证码登录

国际站用户大多是邮箱注册的，之前只有手机号验证码这一条零浏览器路。现在两条都有，
**而且共用同一份实现**（`makeCodeMethod(c, kind)`）—— 复制成两份的那天，下次改超时
或改文案必然只改一份。

协议是逆前端 chunk + 两站实测出来的，全部记在 `src/captcha.mjs` 的头部注释里：

```
取图    POST /captcha/generate   {account_type:"email", email}          ← 无 state_code
过验证  POST /captcha/verify     {token, angle, account_type, email}
发信    POST /v4/user/send-email {email, type:"account_login"} + X-Captcha-Token
换登录态 POST /v4/user/login-email {email, captcha, device, auto_register, redirect}
```

三个**必须记住**的点（都实测过，写错的表现完全看不出是它们的错）：

1. 邮箱**必须**走 `/v4/user/login-email`。往 `/v4/user/login` 发任何 type
   （`email` / `email_captcha` / `email_code`）都回 `2000「phone 字段是必须的」`。
2. 邮箱那条的**验证码字段叫 `captcha`，不叫 `code`**。发 `code` 回
   `2000「captcha 字段是必须的」`；发 `captcha` 回 `2168「验证码错误」`（= 参数对了）。
3. 发信端点的 `type` 也是 `"account_login"`（与手机号同）。填 `"login"` 回
   `2000「服务异常，请联系管理员」`——后端内部炸了，不是参数校验失败。

前端来源：`LoginCoreForm` chunk 里的
`loginService.sendEmailVerificationCode(email, "account_login", captchaToken)` 与
`login(LoginType.EmailVerificationCode, …)`（枚举值就是字符串 `"email"`）；
端点定义在 `UserApi`（`loginByEmail()` 显式 `delete("organization-code")`）。

**⚠ 这条方法只在国际站出现，国内站不给。** 两条实测判据：

1. `www.letsmagic.cn/login` 的登录方式只有 **微信 / 苹果 / 密码 / 手机 / 私有部署**，
   没有邮箱（国际站 `www.magicrew.ai/login` 才有 `switch-to-email`）⇒ 国内站
   不存在邮箱注册的账号，摆出来只会让用户填完邮箱撞一个看不懂的错；
2. 同一个发信请求，国内站 `/v4/user/send-email` 回 `2000 服务异常，请联系管理员`，
   国际站回 `1000 请求成功`。

所以方法表按站点分叉：国际站 `邮箱 → 手机号 → 浏览器 → 登录态`，
国内站 `手机号 → 浏览器 → 登录态`（`tests/code-login.mjs` 把条数也钉死了 ——
国内站必须**恰好 3 条**，多一条就红）。

### 二、已有账号**不再出现**旋转验证图

这是顺手挖出来的、比邮箱本身更值钱的一条：**服务端对已注册的账号本来就不出图。**

实测（2026-10-29，两站）：

| 请求对象 | `/captcha/generate` 返回 |
|---|---|
| 已注册邮箱 | `business_token`（**直接放行，连图都不给**） |
| 从没注册过的邮箱 | `token` + `image`（要给图） |

也就是说「把我已有的账号加进 magpie」这条路**根本不需要识图模型**，全程只有
「填邮箱/手机号 → 填验证码」两步。而之前 `startCodeLogin()` 第一句就是
`if (!readVisionModel()) throw no-vision-model` —— **把这条免费通道堵死了**：
没配识图模型的人连自己已有的账号都加不进来。

改动：

- `startCodeLogin()` 改成**先取图，再决定要不要识图模型**：`registered` → 直接发码；
  只有确实要给新号过图时才要求模型（抛 `code: "no-vision-model"`）
- `passCaptcha(site, ident, firstCap)` 接受调用方已经取到的那张图，省一次请求
- `methods.mjs` 里「回退浏览器」那段从 `authorize` 开头挪进 `catch (no-vision-model)` ——
  只有真新号注册才回退
- 提示语跟着分叉：免图时告诉用户「这一环跳过了，识图模型这次也用不上」

### 三、识图模型的 `max_tokens` 把它自己饿死（真 bug）

`src/vision.mjs` 原本写 `max_tokens: 400`。实测 `workbuddy/deepseek-v4.1-flash`：

```
max_tokens=400  → finish_reason:"length"  reasoning_tokens:400  content:null
max_tokens=2000 → finish_reason:"length"  reasoning_tokens:2000 content:null
max_tokens=8000 → finish_reason:"stop"    reasoning_tokens:899  content:"10"
```

它是**推理模型**，400 个 token 全被 `reasoning_content` 吃掉，答案一个字都没输出 ⇒
判官拿到空串 ⇒ 判成「判角度不可信」⇒ 每轮都换图 ⇒ 整条无头登录直接挂。
**这个值买的是思考空间，不是答案长度。**

改成 `max_tokens: 6000`，并加一层兜底：`content` 为空时从 `reasoning_content`
的**最后 300 字**里找数字（实测尾巴就长「最终决定：10。」这样）。

### 四、删掉 `tools/first-ai-work.mjs`

那个脚本是早期用 CDP 拉浏览器、点输入框、按回车替账号发第一条消息的。
`src/tasks.mjs` 的 `autoFirstWork()` 早就用纯协议（`chat-task.mjs`）取代了它，
留着只会让人以为「第一项任务还得手动跑脚本」。新手奖励 8 项现在**全自动**。

### 五、识图模型：思考关不掉，但能砍一半

`workbuddy/deepseek-v4.1-flash` 是推理模型。让它**别思考**（更快、更省、不怕
`max_tokens` 被思考吃光）这件事，12 组参数逐个试过 —— 同一模型、同一张图：

| 参数 | reasoning 字数 | content | 结论 |
|---|---|---|---|
| 不传 | 1867 | `10.5` | 基线 |
| `reasoning_effort: "none"` | 2824 | `10.5` | ❌ 比不传**还长**（网关按未知参数丢了） |
| `reasoning_effort: "minimal"` | 2514 | `10.2` | ❌ 同上 |
| **`reasoning_effort: "low"`** | **835** | `10.5` | ✅ 唯一有效的 |
| `enable_thinking: false` | 3346 | **空** | ❌ 思考更长，且交白卷 |
| `thinking_budget: 0` | 3156 | **空** | ❌ 同上 |
| `thinking: {type:"disabled"}` | 1533 | `10.7` | 小幅 |
| `chat_template_kwargs` / `extra_body` / `reasoning:{enabled:false}` | 1161–1563 | 有 | 小幅 |
| 模型名后缀 `-nothink` / `/no_think` | — | — | HTTP 400 模型不存在 |

⇒ **这个模型在网关侧关不掉思考。** 真想「不思考」，只能换一个**非推理的视觉模型**
（那是用户在 magpie 设置里选的，插件不替用户选）。

于是取唯一有效的那条，再连跑 6 轮统计（3 张图 × 2 轮，同一张图重复问）：

| | 出数字 | 平均耗时 | 平均 tokens | 平均 reasoning |
|---|---|---|---|---|
| 不传 | 5/6 | 20.6 s | 2343 | 3581 字 |
| `reasoning_effort: "low"` | **6/6** | **8.4 s** | **1007** | 1646 字 |

`low` 不但更快更省，**还更稳** —— 不传的那一组有一次把 6000 token 全烧在思考上、
`content` 交白卷（和 `max_tokens: 400` 那个坑是同一个形态）。两种配置判出来的角度一致。

另外把**两个判官改成并行**：原来 `await a; await b` 串行，把延迟叠成两倍；
现在耗时等于较慢的那一次。`reasoning_effort: "low"` + 并行之后，一次真实验证
（国内站，取图 → 识图 → 过旋转验证）判出 `clock=6.00 / deg=180`，verify 回
`1000 验证成功`。

**那换一个不思考的模型呢？** 能换，但别指望白捡。同一张图喂几个候选（都在
`magicrew-intl` 下）：

| 模型 | 耗时 | reasoning | 完成 tokens | 答案 |
|---|---|---|---|---|
| `gpt-4o` | **3.2 s** | **0** | **3** | 7.5 |
| `gpt-5.4-mini` | **2.9 s** | **0** | **12** | 10.5 |
| `gemini-3.7-flash` | 7.9 s | 0 | 425 | 2.5 |
| `glm-5.3-flash` | 27.5 s | 3588 | 879 | 1.5 |
| `qwen3.5-flash` | 45.1 s | 9087 | 5575 | 2.0 |
| `workbuddy/deepseek-v4.1-flash`（当前） | 19.4 s | 3769 | 2475 | 2.5 |

`gpt-4o` / `gpt-5.4-mini` 确实**完全不思考**（`reasoning_tokens: 0`，2～3 秒）。
但同一张图六个模型给出 **1.5～10.5 钟点**的答案 —— 差得离谱，说明「谁对」必须用
**通过率**判，不能只看快。小样本（每模型 3 张图、完整跑两问 + 提交）的结果：

| 模型 | 通过 | 平均判角度耗时 |
|---|---|---|
| `workbuddy/deepseek-v4.1-flash`（当前） | 2/3 | 23.6 s |
| `gpt-5.4-mini` | 1/3 | 7.4 s |
| `gemini-3.7-flash` | 1/3 | 9.8 s |
| `gpt-4o` | 0/3 | 1.1 s（三次都解析不出数字） |

⚠ 样本太小（3 张/模型），**不能据此换模型**。但能确定两件事：① 换模型是唯一能
真「不思考」的路；② 换之前必须用 `_probe/vision-accuracy.mjs` 跑 10 张以上比通过率，
别拿速度当唯一指标。当前默认保持原模型 + `effort=low` + 并行。

**兜底：`reasoning_effort` 被 400 就退一步。** 它**不是** OpenAI 规范字段，而识图模型是
用户自己在 magpie 里选的（模型库 + 自定义 provider 什么都可能有）—— 有的端点认得，
有的会为未知字段直接回 400。所以 `askClock()` 里加了一层：带它发出去被 400 时，
去掉该字段重发一次，行为退回「不传」那一档（少省几秒，但也别把整条无头登录打死）。
实测该路径：首次 400 → 去掉字段 → 200 → 正常解析出答案。

### 验证

- **新增 `tests/code-login.mjs`：34 个断言** —— 拦全局 fetch 换成可编程假服务端，
  逐个钉死请求本身：邮箱不带 `state_code`、邮箱不进 `send-sms`、
  `login-email` 用 `captcha` 而 `login` 用 `code`、`device` 是 64 位 hex、
  `auto_register` / `redirect` 都在、2168 原样透出；另含**免图通道**两条
  （已注册 → 只走 generate + send-email、不碰 verify；新号 → 取了图但**不**直接发码）
- **`tests/browser-login.mjs` 更新**：改成按 label 找「浏览器登录」，
  并新增四条方法的顺序断言（国际站 邮箱 → 手机号 → 浏览器 → 登录态；
  国内站 手机号 → 浏览器 → 登录态，**没有邮箱那条**）。`authorize` 的耗时阈值从 50ms 放宽到
  5s —— 它允许花几百毫秒拉起浏览器，红线是「**不卡在等用户**」；剪贴板起不来的
  环境里那一段改成跳过，而不是让整份测试崩
- 回归：`multi-provider` 全过、`credit-refusal` 18 通过、`account-fallback` 10 通过、
  `body-rewrite` **48 通过**（本版落地前先并了 0.3.27 的 `items` 子树改写，那一版把
  它的断言从 36 加到 48）、`login-profile` / `local-browser` / `browser-detect` / `smoke` 全过；
  `node ../magpie-plugin-scaffold/scripts/check.mjs .` → 30 通过 / 0 失败
- 两站实测：邮箱取图 / 过验证（国际站 50° 通过）/ 发信（`code 1000`）/ 换登录态
  （`2168` = 参数结构正确）都验过

## 0.3.27 — 2026-10-29

**修 `items` 子树内部的 union / 空 schema 导致的整轮 400**

（内容来自 PR #10，作者 @Jet；合入时补了三处漏洞，见「合入时补的三处」。）

### 症状

DSH 经 magpie 网关调用 DeepSeek-V4.1-Flash 时整轮失败：

```
本轮运行失败 400: {"code":null,"message":"超级麦吉: HTTP 400 请求错误:
{\"error\":{\"code\":\"InvalidParameter\",\"message\":\"tools.40.function.parameters/
 properties/functions/items: invalid JSON Schema; check the schema keywords
 and references Request id: ...\",\"param\":\"\",\"type\":\"BadRequest\"}}",
 "param":null,"type":"invalid_request_error"}
```

0.3.24 已修过 `items: {}`，但这一类**没被覆盖** —— 0.3.24 只删 `items`
**自己**的空对象，而这里出问题的是 `items` **内部**的 schema。

### 根因（2026-10-29 实测，直打上游、同一把 key、同一份请求、只改一个字段）

上游的 JSON Schema 校验器对**数组元素的 schema** 比对根节点更严。放在
**顶层 parameters** 里上游**收**（200）的形态，放进 `items` 子树就一律 400：

| `items` 内部的形态 | 结果 |
|---|---|
| `anyOf` / `oneOf` / `allOf` | **400** |
| `not` / `const` | **400** |
| `if` + `then`（`else` 同理） | **400** |
| `{}`（空 schema） | **400** |
| `items` 本身是**数组**（draft-04 tuple 形式） | 国内站 200 / **国际站 400** |
| `type` / `enum` / `pattern` / `minLength` / `minItems` / `format` / `$ref` / 数值边界 | 200 |
| `type:["object","string","number","boolean","array","null"]` | 200 ← 「任意值」的合法写法 |
| 顶层 parameters 里的 `anyOf` / `const` / `not` / `{}` | 200 |

命中来源是**MCP 服务器**的工具 schema：REA MCP（`mcp__rea__build_call_path`、
`mcp__rea__compare_application_versions` 等 **7 个工具**）的 `functions` 数组参数，
元素 schema 用了 `anyOf: [{…}, {type:"null"}]`（可选参数的标准写法）、`oneOf`，
还有 `{}` 空 schema。一份 65 工具的请求里 7 个工具中招 ⇒ 整轮 400。

### 修法

`src/hooks/loader.mjs` 新增 `loosenItemsSchema()`，只作用于 **`items` 子树**：

```
anyOf / oneOf / allOf  → 取一个分支内联（分支本身先递归修），优先取非纯 null 的分支
not / const            → 删除
if / then / else       → 删除
{}                     → {type:["object","string","number","boolean","array","null"]}
items 是数组（tuple）   → {type:[同上]}
```

全部是**降级放宽**（方向安全：宁可约束松一点，也不要整轮失败）：

- union 取一个分支：`anyOf:[{…},{type:"null"}]` 取到的正是「非空」那个。
  ⚠ 顺序反过来（null 在前）时要跳过 null 分支 —— 照抄第一个会把「可选」压成
  「只能 null」，那是**收紧**；
- `const` 删除 ⇒ 「只能是这一个值」变「任意值」，放宽；
- `not` / `if+then+else` 无等价物，删掉同样是放宽；
- `{}` → 六类型 `type` 数组：与空 schema **严格等价**（六种 JSON 类型全覆盖），
  而 `{}` / `true` 在这层都被上游拒，只能落成这个显式写法。

⚠ 顶层 parameters 的 union **不动** —— 上游收它，动了白白丢约束。

递归同样遵守 schema 位置纪律（`properties` 的值 / union 的分支 / `items` 的值……），
不碰 `enum` / `default` / `examples` 里的字面值。

### 合入时补的三处（PR 初版的漏洞）

1. **删 `not` / `const` 会删成空节点** —— 初版只把 ``{}` 当空 schema 处理，删完没复查，
   于是 `{const:"x"}` 变成 `{}` 留在 `items` 子树里，**改写后仍然 400**（实测：
   `items/not` 与 `items/const` 两例 raw=400 → 改写后 400）。现在删除后统一补
   「任意值」，两例都变成 200。
2. **`{}` 曾被改成 `{type:"object",additionalProperties:true}`** —— 那不是等价改写，
   是把「任意值」收紧成「只能是对象」。改成六类型 `type` 数组。
3. **`if` / `then` / `else` 与 tuple 形式的 `items` 没被覆盖** —— 前者在 `items` 子树里
   实测 400，后者国际站 400；两者现在都处理。

### 验证

- `tests/body-rewrite.mjs`：**48 个断言**（初版 45 个；新增断言覆盖删空补位、
  `if/then` 删除、null 在前的 union、tuple 形式）。
- 端到端（00:19~00:24 实测，那时上游还在拒）：真实报障形态的 65 工具请求体
  （58 填充 + 7 个中招的 REA 工具）**国内站** 原样 → 400、过 `rewriteRequestBody` → **200**；
  **国际站** 原样 → 400（`tools.58…/items`）、过 `rewriteRequestBody` → **200**。
  单点矩阵：21 个形态 × raw/改写后 × 两站，所有 `items` 子树非法形态 400 → 200，
  顶层对照形态保持 200，合法关键字原样保留。
- ⚠ **上游在 00:25~00:29 之间放宽了这层校验**：同一批形态的 raw 请求随后也回 200
  （含真实报障形态）。同一夜里 `tuple` 形式与 `if+then` 还出现过 200/400 波动。
  ⇒ 这个改写现在是**保险**，不是必需；上游随时可能收回去。
  判「要不要改写」请看多轮统计，别信单次探针。
- 复跑：`_probe/items-subtree-upstream.mjs`（`[cn|intl]`）、
  `_probe/items-subtree-stability.mjs`（`N 轮`，输出 `400 次数 / 轮数`）。


## 0.3.26 — 2026-10-28

**积分耗尽的 400 不再让整轮对话失败：改写成 402，让 magpie 换下一个账号**

### 症状

三个「超级麦吉」账号（余额 6,467 / 82 / 0 积分）接在同一个路由组里。余额 82 的账号
被会话亲和（affinity）留在回复链上，一轮对话把它烧到负数，上游回：

```
HTTP 400
超级麦吉: 非常抱歉，当前对话需要调用大模型 / 付费工具，您的可用积分已不足。
您可以点击右上角「用户头像」，通过「充值」通道补充积分，完成后即可继续对话。
```

DSH 界面显示「本轮运行失败」，magpie 的 trace 里只有两次 try —— 都在
`magicrew@181****710`，余额 6,467 的 `magicrew`（189****051）**一次都没被问**。

### 根因

magpie 的 `failure()` 已经能认出这条错误（`creditWords` 命中「充值」）并把
`try.Fail` 记成 `credit`；但 `retryable()` 的 `status == 400, 422` 分支只查
`quotaWords`，而 `quotaWords` 不含「积分」「充值」。于是：

```
hw.failed() == false
  ⇒ 走不到 `!last && hw.failed()` 的换账号分支
  ⇒ 不 rest、不换号、直接把 400 交给客户端
```

账号于是永远留在轮换里，下一次请求继续撞同一个错误。

> 已把 magpie 侧根因与修法报到 https://github.com/yetone/magpie/issues/4095 ——
> 插件这一层是绕过，不是根修。

### 修法（插件层）

`src/hooks/loader.mjs` 增加 `rewriteCreditRefusal()`：只在
**400/422 + 文案确认是「积分/余额不足」** 时把状态码改成 `402 Payment Required`，
body 原样保留。402 在 magpie 的 `retryable()` 里无条件可重试、`failure(402)` 也是
`failCredit`，因此会 rest 该账号 30 分钟并继续问同 provider 的下一个账号 / 组的下一个成员。

边界钉死：schema 错误的 400、参数错误的 400、200/402 响应一律原样透传，不读成功流。

### 验证

- `tests/credit-refusal.mjs`：18 个断言 —— 中文真实文案 / 英文 insufficient credits /
  余额不足 / schema 400 不命中 / 参数 400 不命中 / 402 与 200 不碰 / content-length 与
  content-encoding 被丢掉 / **端到端**：拦全局 fetch，`makeLoader().fetch` 收到 400 积分
  不足时交给 magpie 的是 402，收到 schema 400 时仍是 400。
- `tests/body-rewrite.mjs` 36 通过、`tests/account-fallback.mjs` 10 通过。
- 两站共用同一 Go 服务与同一错误文案（AGENTS 坑 1），逻辑按站点无关实现。

## 0.3.25 — 2026-10-28

**0.3.24 的 schema 扫描范围收窄：只走 schema 位置**

0.3.24 的 `loosenEmptyItems()` 与 `loosenAdditionalProperties()` 递归了**所有**对象。
那会把 `properties` 里恰好叫 `items` / `additionalProperties` 的工具参数当成 schema
关键字：`properties.items = {}` 的参数会被删掉，`properties.additionalProperties =
{type:"string"}` 会被改成 `true`；`enum` / `default` 值里的同名键也会被误改。

两者现在共用 `walkSchema()`，只进入真正的 schema 位置：

- `properties` / `patternProperties` / `$defs` / `definitions` / `dependentSchemas` 的**值**
- `allOf` / `anyOf` / `oneOf` / `prefixItems`
- `items` / `additionalProperties` / `unevaluatedProperties` / `propertyNames` /
  `contains` / `not` / `if` / `then` / `else` / `contentSchema` / `dependencies`
- 不扫键名，不扫 `enum` / `default` / `const` / `examples`（它们不是 schema）

0.3.24 的 `items:{}` 等价替换规则不变，本版只修扫描范围。

### 验证

- `tests/body-rewrite.mjs`：36 个断言（新增 5 个同名属性 / `enum` 值反例）。
- 端到端复跑：41 个工具、`properties.functions.items:{}` → 200（国内 / 国际）。

## 0.3.24 — 2026-10-28

**修 `items: {}` 导致的整轮 400**

### 症状

用户的一次普通对话直接失败，界面只显示：

```
本轮运行失败 400: {"code":null,"message":"超级麦吉: HTTP 400 请求错误:
{\"error\":{\"code\":\"InvalidParameter\",\"message\":\"tools.40.function.parameters/
 properties/functions/items: invalid JSON Schema; check the schema keywords
 and references Request id: ...\",\"param\":\"\",\"type\":\"BadRequest\"}}",
 "param":null,"type":"invalid_request_error"}
```

### 根因

某个工具的参数 schema 里，数组的 `items` 是**空对象 `{}`**。上游的 JSON Schema
校验器只拒这一种空 schema 形态；`items:{description:"x"}`、`items:{type:"string"}`、
缺省 `items` 都是 200。国内站 `magicrew` 与国际站 `magicrew-intl` 的报错逐行一致。

按 JSON Schema 规范 `items:{}` 是合法的（"任意元素"），客户端没写错；这是上游
兼容性不足。但插件是唯一能改请求体的地方。

### 修法

`src/hooks/loader.mjs` 新增 `loosenEmptyItems()`，在 `rewriteRequestBody` 里递归扫
`tools[].function.parameters`：

```
items: {}      → 删除      // JSON Schema 缺省值就是 {}，严格等价
items: true    → 删除      // 同上；上游对它回的是另一种 400
items: false   → 不动      // 「数组必须为空」，删掉就是放开
items: {...}   → 不动      // 有任何一个键，上游都收
```

与 `additionalProperties`、`max_tokens`、`stream_options` 共用一次 `JSON.parse`；
没改到时仍返回原始字符串。

### 验证

- `tests/body-rewrite.mjs`：31 个断言（新增 11 个），`items:{}` / `true` 删除、
  `{description}` / `{type}` / `false` 不动、`tools[40]` 命中、combined 改写、不误伤。
- 端到端（2026-10-28）：41 个工具、第 41 个带 `properties.functions.items:{}`，
  原样请求 → `400 tools.40.../items`；过 `rewriteRequestBody` → `200`。
  国内站、国际站都跑过。

## 0.3.23 — 2026-10-28

**修工具 schema 兼容 + 网关路径拿错 key，顺手把「签一把顶一把」测清楚了**

### 一、上游不认 `additionalProperties: {}`

接 ZCode / Claude Code 系客户端时，一次带 54 个工具定义的请求必回
`400 {"error":{"message":"模型响应失败","code":4017}}`。根因是这些客户端把
"允许任意属性"写成空对象，而上游适配层只认布尔值。

同一把 key、同一份请求、只改这一个字段（2026-10-28 实测，glm-5.3-flash 与
deepseek-v4.1-flash **逐行一致**）：

```
additionalProperties: 缺省             → 200
additionalProperties: false            → 200
additionalProperties: true             → 200
additionalProperties: {}               → 400 code 4017
additionalProperties: {type:"string"}  → 400 code 4017
```

**上游不是「只认布尔」，是根本不支持 schema 形态** —— 只处理空对象不够。这一点是拿
改动端到端跑一遍才发现的：对照组 400 → 只改空对象**仍然 400** → 非布尔全换 true 才 200。

`rewriteRequestBody` 里加递归规范化，把**所有非布尔值**换成 `true`。
`{}` → `true` 是严格等价；`{type:"string"}` → `true` 是**降级放宽**、丢了约束，
但上游无法表达它，留原值就是整个请求失败。方向安全（放宽不是收紧）。

请求体三处改写（max_tokens / stream_options / additionalProperties）合并成**一次**
`JSON.parse`，没改到时返回原始字符串（54 个工具的请求体可达上百 KB）。

> 这处改动来自社区 PR #8（@baijiu666），按其最小复现验证后采纳。

### 二、网关路径下拿不到正确账号的 key

agent 从 magpie 的 `/v1/chat/completions` 进来时，`getAuth()` 返回的 auth
**可能不带 org**，`accountOf()` 于是落到 `"default"` —— 读不到真实账号的 key 槽，
`ensureKey` 只能退回 `auth.access`；它过了 2 小时就 403，表现成
`502 {"message":"超级麦吉 did not stream: token无效"}`。

新增 `accountFor()`：拿不到标识时，**只有该站点恰好一个真实账号**才退到它。
0 个沿用原来的「首次接管」；**≥2 个不猜** —— 用错账号的 key 是拿别人的积分、
别人的组织出话，本地看不出来，不是报错是错账。

⚠ 多账号 + 网关路径这个组合仍然无解：需要 magpie 把 provider 实例 id 传给插件
（`plugin-auth.json` 里已经有 `magicrew#p4nwa7` 这种 key），插件侧拿不到。
在那之前只能保守 —— 宁可这次请求失败，也不借身份。

### 三、「签一把顶一把」实测推翻（不涉及代码，只更正文档）

`docs/internals.md` 第十四节一直挂着「要判定需要一次受控实验」。做完了：
本机 12 把 key 逐把打 `GET /v1/models`（只读、不签发、不吊销），结果是

- 同账号两把相隔 **67 秒**签发的 key **同时有效**
- 所有 403 都对应 `expiresAt` 已过（剩 -173～-541 分），**没有**「时间没到就失效」的样本

⇒ 后签的**不吊销**先签的；唯一失效条件是 2 小时到期。`AGENTS.md` 坑 3 与
internals 十三节据此更正。「只留一把、只走唯一出口」的设计保留，理由改为
「本地别分叉」而不是「互相吊销」。

### 测试

- `tests/body-rewrite.mjs` —— 20 个断言：只换空对象、非空 schema 不动、
  其余字段一字不动、没改就不重新序列化
- `tests/account-fallback.mjs` —— 10 个断言：单账号才兜、多账号不猜、空壳文件不算账号

---

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
