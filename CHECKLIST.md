# CHECKLIST —— 两张表，两个交付门

> 给 `magpie-magicrew-auth`。`scripts/check.mjs`（在脚手架仓库里）只查**能自动查的那部分**；
> 下面这些查不到，但漏了照样出事，而且通常**不报错**。
>
> 逐条勾，勾不上就是还没好。表格里的「判据」都能当场验。

---

## A 表 · 代码交付前

```
□ 1. config.models 有内容
      判据：插件装上后模型列表不是空的（未登录时也要有静态表）
      出处：README

□ 2. authorize() 立刻返回
      判据：登录时没有长时间转圈
      出处：docs/internals.md 二

□ 3. 两站都验过
      判据：国内（magicrew）与国际（magicrew-intl）各跑一次目标路径，都通
      出处：internals 一 —— 同一个 Go 服务，一边过不代表另一边过

□ 4. 国际站请求带 organization-code
      判据：/v1/chat/completions 不是 HTTP 500 + 22 字节裸文本
      出处：internals 一 / 五

□ 5. 上下文窗口来自查库，不是保守常数
      判据：模型条目的 limit.context 与实际能吃的长度对得上（早前一刀切 256K 是错的）
      出处：internals 十六

□ 6. 流式请求带 stream_options.include_usage
      判据：流式回复里有 usage，额度真的扣了
      出处：internals 十二

□ 7. 模型 free 来自厂商声明，不是从 rate 反推
      判据：input_points === 0 才 free；缺失就不列，不猜
      出处：internals 十六 · HOOKS 十一之二

□ 8. 只有一处持有 refresh_token
      判据：`src/hooks/refresh.mjs` 没有绕过 `src/keys.mjs`；没有第二次签发 key 的调用
      出处：internals 十三 / 十四

□ 9. 首任务仍是一次性闸门
      判据：isAutoChatSettled 还在用；失败最多 3 次；不落日期格式
      出处：internals checkin 小节

□ 10. 话题查不到时「这次不发」
      判据：fetchProjectTopics 抛错时不写标记、不计数、不发送
      出处：src/tasks.mjs 的 autoFirstChat

□ 11. 登录三条路径都还能登
      判据：本机浏览器接上 / 浏览器登录 / 手填 JWT，各走一次
      出处：internals 十一

□ 12. 浏览器可执行文件是逐个试候选，不是写死一个名字
      判据：Windows 上点登录能起浏览器（文件名随浏览器版本变）
      出处：internals 十一

□ 13. 没有写 magpie 的市场缓存
      判据：src 里搜不到 plugin-market.json
      出处：CHANGELOG 0.1.9 那段事故

□ 14. node ../magpie-plugin-scaffold/scripts/check.mjs . 退出码 = 0
      判据：末尾「失败 0」
```

---

## B 表 · 发版前（七步，一步不能少）

> ⚠ **`git push` 只是第 4 步。** 本仓库真踩过：0.3.14 只 push，
> 结果 GitHub 右侧一直写着「暂无发布版本」、npm 停在 0.3.8。

```
□ 第 0 步 · 写 CHANGELOG
      判据：顶部是这个版本的一节，一条一行，说用户能感知的变化

□ 第 1 步 · bump version
      命令：npm version patch --no-git-tag-version
      判据：package.json 的 version 变了（同版本重打会命中 bun 缓存）

□ 第 2 步 · 打包面预演
      命令：npm pack --dry-run
      判据：清单里有 README.md / CHANGELOG.md / docs / AGENTS.md / CHECKLIST.md

□ 第 3 步 · 提交并推功能分支
      判据：推的是 feat/<改动>，不是 main

□ 第 4 步 · PR 全绿后合并
      判据：rules 成功、分支最新、讨论解决；禁止直接推 main

□ 第 5 步 · npm publish
      命令：npm run publish:npm          ← 包内 name 是 Magicrew，npm 包名是 magicrew-auth
      判据：返回 + magicrew-auth@<版本>，且 package.json 的 name 已还原成 Magicrew

□ 第 6 步 · tag + Release
      命令：git tag v<version> && git push origin v<version>
      本仓库**没有** .github/workflows ⇒ Release 必须手工建：
        POST /repos/MYCF711/magpie-magicrew-auth/releases
        { tag_name, target_commitish:"main", name, body:<CHANGELOG 该版本段>, draft:false }
      判据：tag 与 version 一致；Release 不是 draft

□ 第 7 步 · 四条验证
      ① npm view magicrew-auth version       → 新版本（登记可能延迟 1-2 分钟）
      ② 下载 dist.tarball 解包看内容          → 要看到新代码，不只看版本号
      ③ magpie plugin list                   → commit 变了（git 源看 commit 不看 version）
      ④ GET /releases/tags/v<version>        → 200 且 draft=false
```
