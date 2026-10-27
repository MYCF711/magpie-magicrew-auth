# magpie-magicrew-auth

**超级麦吉（Magicrew / letsmagic.cn）接进 magpie 和 OpenCode。**

手机号登录，直连它自己的 OpenAI 兼容网关，模型目录只给你账号**真正能选**的那 27 个，卡片上显示积分余额。

```
供应商 id   magicrew
API 基址    https://i-magic-service.letsmagic.cn/v1
协议        OpenAI Chat Completions（原生，不是翻译出来的）
```

---

## 为什么值得单独做一个

超级麦吉对外是个 AI Agent 平台（PPT、看板、云端 7×24 任务），所以几乎所有人都把 `dtyq/magic` 当企业平台看，没人去敲一下 `/v1/models`。

它其实**自带 OpenAI 兼容网关**：

```
GET  /v1/models              → 44 个模型，object:"list"
POST /v1/chat/completions    → 标准 chat.completion，带 usage 与 reasoning_content
```

所以这个插件**不翻译任何协议** —— 它只做三件事：登录、每 2 小时续一次密钥、把模型和积分摆到卡片上。跟那些要把 Agent 会话硬掰成 chat 格式的插件，不是一个量级的活。

---

## 登录

三种方式，按可用性排：

| 方式 | 怎么来 | 有效期 |
|---|---|---|
| **手机号 + 密码** | 网页「密码登录」那套密码 | 30 天 |
| **粘贴 JWT** | DevTools → Application → Local Storage → `MAGIC:user:authorization`，取 JSON 里的 `value` | 30 天 |
| 微信扫码 | 不支持（扫码拿不到可复用的凭据） | — |

登录后拿到三层凭证，有效期完全不同：

```
网页 JWT        30 天   用来换密钥、读模型目录和积分
mgw_ api_key     2 小时  真正请求时的 Bearer
refresh_token    7 天    PUT 一次换新的 api_key；每换一次就轮换一次
```

⇒ 只要登录一次，**30 天全自动**：api_key 每 2 小时自己续，refresh_token 每次续期时自己滚。

---

## 模型

卡片上的模型来自 `/api/v1/flows/models` —— 也就是你在网页模型选择器里**眼睛能点到的那些**，27 个。

**这里刻意没用 `/v1/models`。** 那个接口返回 44 个，混着 VIP 锁定（选不了）、生图、embedding：

| 分类 | 数量 | 例子 | 能不能进 magpie |
|---|---|---|---|
| 语言 | 27 | GLM 5.3 / DeepSeek V4.1 Flash / Qwen3.8 Max / Kimi K3.1 Pro / Seed 2.0 | ✅ 全部 |
| 生图 | 11 | qwen-image-3.0-pro、doubao-seedream-4.5 | ❌ chat 通道用不上 |
| 向量 | 6 | text-embedding-3-large、doubao-embedding | ❌ 同上 |

把生图模型塞进 magpie，用户选中就会报错 —— 所以宁可少 17 个。

### 积分单价（每百万 token，2026-10-27 实测）

`POST /api/v1/products/model-points` 拿到的官方数字。按 ¥3.4 / 1000 积分折算：

| 模型 | 输入积分 | 输出积分 | 折合 ¥/M in | ¥/M out |
|---|---|---|---|---|
| glm-5.3-flash | 80 | 280 | 0.27 | 0.95 |
| qwen3.5-flash | 20 | 200 | 0.07 | 0.68 |
| deepseek-v4.1-flash | 200 | 800 | 0.68 | 2.72 |
| doubao-seed-2.0-lite | 90 | 540 | 0.31 | 1.84 |
| glm-5.3 | 941 | 2956 | 3.20 | 10.05 |
| qwen3.8-max | 1200 | 3600 | 4.08 | 12.24 |
| kimi-k3.1-pro | 1300 | 6800 | 4.42 | 23.12 |

---

## 安装

magpie 里：

```bash
magpie plugin add https://github.com/MYCF711/magpie-magicrew-auth
```

或者本地开发：

```bash
git clone https://github.com/MYCF711/magpie-magicrew-auth
cd magpie-magicrew-auth
node tests/smoke.mjs          # 不花钱的自测：config / models / usage
node tests/smoke.mjs full     # 再加上签到探测
```

`tests/smoke.mjs` 的凭据来源：环境变量 `MAGICREW_JWT` + `MAGICREW_ORG`，没有就从本机 Edge 的 localStorage 读。

---

## 新手福利：7 项可以自动做完，1 项不行

8 项任务合计 500 积分。接口只有两行，藏在 `onboarding-CZBI0pQt.js` 里：

```
GET  /api/v1/onboarding/tasks
PUT  /api/v1/onboarding/tasks/{code}/completion
```

`magpie` 的 `auth.checkin` 钩子就干这件事：拉任务列表 → 把 PENDING 的挨个 PUT → 报积分变化。**每天跑一次，第一次就把 300 分拿完。**

实测（2026-10-27，国内站）：**1240 → 1540，+300，六项当场入账**。

| 任务 | code | 分 | 能不能自动 |
|---|---|---|---|
| 了解工作台 | `super_magic_intro` | 50 | ✅（网页上已点过） |
| 了解 AI PPT | `ai_ppt` | 50 | ✅ PUT 即到账 |
| AI 录音 | `ai_recording` | 50 | ✅ |
| 雇佣数字员工 | `digital_employee` | 50 | ✅ |
| 添加/管理技能 | `skill_management` | 50 | ✅ |
| 微应用 | `micro_app` | 50 | ✅ |
| 超级龙虾 | `magiclaw` | 50 | ✅ |
| **完成第一次 AI 工作** | `first_ai_work` | **100** | ❌ 回 `9303 该新人引导任务不支持手动完成` |

那一项服务端认死「必须真的跑过一次 AI 任务」，PUT 不进去。要拿就在网页里正常用一次（1~2 分钟），或者用 `tools/onboarding.mjs` 走浏览器自动化。

### 每日登录积分

价格页写「每日登录发放 200 积分」，但**没有独立的签到接口** —— 4 个候选路径全 404：

```
POST /api/v1/quota/points/daily-claim
POST /api/v1/quota/points/free-claim
POST /api/v1/user/daily-reward
POST /api/v1/growth/daily-checkin
```

它是登录即发，不需要签。所以签到钩子的实质产出就是上面那张表。

## 已知限制

- **只支持国内站（letsmagic.cn）**。国际站 `magicrew.ai` 是同一产品的英文品牌（同一个 `dtyq/magic` 仓库），但后端网关不同：`api.magicrew.ai` 存在却没有 `/v1/models`，暂未适配。
- **积分只读不写**。插件不会替你充值、不会自己领奖。
- **上下文窗口除 glm-5.3-flash 外未逐个实测**，一律按 256K 保守填。实测方法在 `docs/internals.md`。
- **推理模型会吃 max_tokens**：`glm-5.3-flash` 一次 60 token 的请求里 42 个花在 `reasoning_content` 上，content 是空串。插件在 loader 里把低于 512 的 `max_tokens` 抬到 512。
- 微信扫码登录不支持，因为拿不到可复用凭据。

---

## 协议与许可

MIT。上游 `dtyq/magic` 是 Magic Open Source License（Apache 2.0 + 附加限制），本插件不复制其代码，只调它的公开 HTTP 接口。
