# 发 npm：`magicrew-auth`

> 线上：https://www.npmjs.com/package/magicrew-auth
> 首次发布 2026-10-27，`0.3.5`。**这个包名已经是我们的，之后只增版本，不再改名。**

## 一条命令

```bash
npm run publish:npm                 # 真发
npm run publish:npm -- --dry-run    # 预演，看包名与打包面，不上传
```

脚本是 `publish-npm.mjs`，做的事只有一件：**发布那一下把 `name` 换成 `magicrew-auth`，跑完还原。**

## 为什么必须换名

registry 拒绝含大写字母的**新**包名，而 `package.json` 的 `name` 要同时喂两个地方：

| 谁读 | 读哪份 | 决定什么 |
|---|---|---|
| `bun`（`magpie plugin add github:…`） | 仓库里的 `package.json` | 依赖键 → **卡片标题 `Magicrew`** |
| `npm publish` | 同一份 | npm 上的**包名** → 必须小写 `magicrew-auth` |

所以 npm 装的卡片标题是 `magicrew-auth`，git 装的卡片标题是 `Magicrew` —— 功能一样，只是标题。
FAQ 里对用户写过这条，别把它当 bug 修。

还原是硬要求：脚本在 `finally` 之外还挂了 `exit` / `SIGINT` 钩子。实测跑完
`sha256sum package.json` 与跑前逐字节一致。

## 发之前的三条

1. **bump `version`** —— 同版本号 publish 会被 registry 拒。
2. **`npm view magicrew-auth version` 看现在线上的版本**，别发重复。
3. README 会随包发出去，成为 magpie 卡片正文 —— **npm 用户的卡片只有发版才更新**
   （git 源用户 push 即见）。所以 README 改完要跟着一个版本走。

## 发完之后会看到 `0.0.0-stage`，别慌

registry 上会先多出一个占位版本：

```json
{ "version": "0.0.0-stage", "stub": true,
  "description": "Temporary package placeholder for staged publishing" }
```

`dist-tags.latest` 可能先指向它，几秒后指向真版本；`npm stage list` 显示「没有 staged 版本」。
判据：

```bash
curl -s https://registry.npmjs.org/magicrew-auth | python -c "import json,sys;d=json.load(sys.stdin);print(d['dist-tags'])"
# {'latest': '0.3.5'}
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/magicrew-auth/0.3.5
# 200
```

## 验收（2026-10-27 实测）

```
npm view magicrew-auth version     → 0.3.5
npm view magicrew-auth dist-tags   → { latest: '0.3.5' }
npm i magicrew-auth && node -e "import('magicrew-auth')"
  → exports: MagicrewAuthPlugin, MagicrewIntlAuthPlugin, SITES, _internal
tarball 26 files / 118.5 kB，README 是当期版本
```

## ⚠ npm 搜索搜不到，不等于包有问题

magpie 的发现搜索是 `/-/v1/search?text=<query> opencode`。实测：

| 查询 | 结果 |
|---|---|
| `text=magicrew` | total 1，命中 |
| `text=magicrew opencode` | total 18500，**前 250 条里没有它** |
| `text=letsmagic` | total 1，命中 |

零下载的新包在混合查询里会被 opencode 生态的高下载包淹没。**能保证被发现的路径是 GitHub topic**
（仓库已带 `magpie-plugin` / `magpie` / `opencode` → Discover → Unofficial）。搜索排名随下载量积累会好转。
