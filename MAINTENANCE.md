# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 用途：任何人（Lead 或专员）接手这个仓库前先读这一页，30 秒内知道「现在在哪一步、下一步是什么、哪里会踩坑」。
> 读完再去读 `AGENTS.md`（入口与坑表）和 `CHANGELOG.md`（历史）。
> **每次干完活必须回来更新本文件的「当前状态」与「下一步」。**

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `magpie-magicrew-auth`（目录名） |
| 包内 name | `Magicrew`（`package.json` 的 `name`） |
| npm 包名 | `magicrew-auth`（与包内 name 不同，发布用这个） |
| 当前版本 | `0.3.63` |
| 上游 | magpie（`yetone/magpie`）插件协议 |
| 关联仓库 | `magpie-plugin-scaffold`（脚手架 / HOOKS.md / UPDATING.md / check.mjs） |
| 现状负责人 | 待派（候选角色：`plugin-forge`） |

## 二、当前状态（2026-10-30 15:xx 盘点）

```
分支        feat/invite-two-mode-switch
相对 main   0 ahead / 0 behind（还没有提交）
未提交      index.mjs                 +40 −?
            src/hooks/methods.mjs     (大改，+120 行区域)
            src/invite-quota.mjs      +35 −?
            src/store.mjs             +129 −?
            合计 4 文件 +190 −134
```

**⚠ 交接前必须先处理这 4 个未提交改动**：来源与完成度未核实，不要直接在它上面叠第二个人的改动。

最近 5 个提交：

```
9dd4e02 ci: gate Magicrew releases on merged verified commits (#21)
0f2a587 ci: keep browser launch out of the required gate (#20)
8ae4922 ci: require pull request checks before release (#19)
fdcb035 0.3.63: 登录框灰色字只写模式，不再重复上级与邀请次数
326393c 0.3.62: 额度里看得到邀请名额，首选满额自动换到真实邮箱号
```

## 三、下一步

1. 先弄清上面 4 个未提交改动是什么、是否可交付（`git diff` 逐文件看，对照 CHANGELOG 0.3.62/0.3.63 的意图）。
2. 若可交付：按发布流程走 —— 功能分支 → PR → `rules` 全绿 → 合并 → 从与 `origin/main` 一致的提交发版。**禁止直推 main。**
3. 若不可交付：先落盘成 WIP 提交或 stash，写清状态，再交接。

## 四、硬约束（违反会静默出错）

- **禁止直接推 `main`**：只能功能分支 → PR → 必需检查 `rules` 全绿 → 合并 → 从与 `origin/main` 完全一致的提交打 tag / 发 npm。
- **两站同构**：`SITES.cn` / `SITES.intl` 是同一个 Go 服务、逐字符同构 —— 改一处必须两站都验。
- **国际站网关强制 `organization-code` 头**，缺了回 500 + 22 字节裸文本，不是 JSON。
- **refresh_token 只有一个出口**（`src/keys.mjs` 的 `renewViaStore()`），不许在别处自调 `refreshGatewayKey`，否则两份 token 分叉、用户莫名掉登录。
- **上下文窗口必须查 magpie 模型库**，不许填保守值（早前一刀切 256K，实际 1M）。
- **流式必须带 `stream_options.include_usage`**，否则 usage 永远空、额度不扣。
- 其余坑见 `AGENTS.md` 第二节的 12 条表。

## 五、交付前自检

```bash
node ../magpie-plugin-scaffold/scripts/check.mjs .    # 退出码必须 0
```

再对 `CHECKLIST.md` 的 **A 表**逐条勾。要发版走 `CHECKLIST.md` **B 表** + 脚手架 `UPDATING.md` 七步。

⚠ 本仓库**没有 `.github/workflows`**，Release 必须手工建：`git tag v0.x.y && git push origin v0.x.y`，然后 `POST /repos/MYCF711/magpie-magicrew-auth/releases`。
⚠ 探针脚本必须放进仓库目录、用 magpie 自带的 bun 跑（node 连不上国际站域名）：`~/.cache/magpie/bun/1.4.4/magpie-bun.exe ./_probe/xxx.mjs`。

## 六、给接手者的最短路径

1. 读本文件（你在读）
2. `git status` + `git log --oneline -5` 核实现状（别信台账里的旧快照）
3. 读 `AGENTS.md` 的「一、先定位你在哪一步」表，按你要做的事找必读
4. 干活 → `node scripts/check.mjs` → 更新本文件「当前状态」与「下一步」→ 回报 Lead
