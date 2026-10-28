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
| 4 | 刷新 token 之后两处 refresh_token 不一致、用户莫名掉登录 | 只允许**一个**出口持有 refresh_token；`src/hooks/refresh.mjs` 绕过出口就会分叉 | internals 二 / 十四 |
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
| [docs/internals.md](./docs/internals.md) | 16 章实测：两站同构、三层凭证、接口清单、协议要点 | 改代码前按章查 |
| [CHANGELOG.md](./CHANGELOG.md) | 每版一节 | 写新版本时 |
| [CHECKLIST.md](./CHECKLIST.md) | 两张勾选表 | 两个交付门 |
| 脚手架 [AGENTS.md](../magpie-plugin-scaffold/AGENTS.md) | 通用坑（九项清单、三条铁律、check 能查什么） | 第一次接触这个插件族时 |

---

## 六、这份文件的维护规矩

1. 任何一次「不报错、要几小时才找到」的坑，收工前在第二节加一行（症状 → 判据 → 出处）。
2. 第二节只放一句话判据，论证留在 `docs/internals.md`。
3. 判据要能当场验证（命令、字段、界面现象），写不成判据的是感想。
