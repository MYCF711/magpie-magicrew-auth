# 版权与归属声明

本插件（`magpie-magicrew-auth`）由 MYCF711 编写，以 MIT 许可发布。
正文见 [`LICENSE`](./LICENSE)。

## 上游服务

- **超级麦吉 / MagiCrew** —— 广东灯塔引擎科技有限公司的产品，其开源部分见
  [dtyq/magic](https://github.com/dtyq/magic)（Magic Open Source License：Apache 2.0 + 附加限制）。
  本插件**不复制**该仓库的任何代码，只调用两套云对外公开的 HTTP 接口，
  接口契约的取证来源见 README 的「参考源」一节与 [`docs/internals.md`](./docs/internals.md)。

## 第三方写法参考

- **[@magpie-community/opencode-workbuddy-auth](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)**（MIT）
  —— 「一个包导出多个 `XxxAuthPlugin`，每个站点一个供应商」的组织方式取自这里。
  本插件按同一模式实现，未复制其代码。
- **[@magpie-community/opencode-qoder-auth](https://github.com/magpie-community/plugins/tree/main/packages/qoder)**（MIT）
  —— 同一模式的多站点（四导出）对照例。
- **[magpie-plugin-template](https://github.com/MYCF711/magpie-plugin-template)**（MIT）
  —— README / CHANGELOG / NOTICE 的骨架与硬规则。

## 品牌资源

插件内嵌的两张图标来自各站点自己的公开图标文件（抓取日期 2026-10-27）：

| 站点 | 来源 | 用途 |
|---|---|---|
| 国内 · 超级麦吉 | `https://www.letsmagic.cn/web/favicon.png` | 供应商图标（512×512 → 128×128） |
| 国际 · MagiCrew | `www.magicrew.ai` 的 `<link rel="icon">`，托管于其 OSS | 供应商图标（200×200 → 128×128） |

两张图仅用于在 magpie 界面里标识对应供应商，版权归各自权利人所有。
本项目与广东灯塔引擎科技有限公司无隶属关系，未获其背书。
