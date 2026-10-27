// publish-npm.mjs —— 发布到 npm 时临时换包名，跑完无论成败都还原。
//
// 为什么必须换：一个 package.json 要喂两个地方
//   git 源安装（magpie plugin add github:…）→ bun 拿 name 当依赖键 → 卡片标题，要看到 `Magicrew`
//   npm publish                              → registry 拿 name 当包名，且**拒绝含大写字母的新包名**
// 所以只能在发布那一下换成 npm 上的小写名，发完立刻改回来。
//
// 用法：
//   npm run publish:npm                # 真发
//   npm run publish:npm -- --dry-run   # 预演（不上传），看包名与打包面
//
// 实测（脚手架 UPDATING.md，officeace / loomy 各一次）：全程不碰任何文件，
// 装出来的依赖键仍是包内 name，npm 那边包名不变。
import fs from "node:fs"
import { execSync } from "node:child_process"

const NPM_NAME = "magicrew-auth"
const FILE = new URL("./package.json", import.meta.url)
const orig = fs.readFileSync(FILE, "utf8")
const pkg = JSON.parse(orig)

if (pkg.name === NPM_NAME) {
  console.error(`package.json 的 name 已经是 ${NPM_NAME}，直接 npm publish 就行`)
  process.exit(1)
}

// 无论正常结束、抛错还是 Ctrl+C，都把原文写回去
let restored = false
const restore = () => {
  if (restored) return
  restored = true
  fs.writeFileSync(FILE, orig)
  console.error(`\npackage.json 已还原：name = ${JSON.parse(orig).name}`)
}
process.on("exit", restore)
process.on("SIGINT", () => { restore(); process.exit(130) })

pkg.name = NPM_NAME
fs.writeFileSync(FILE, JSON.stringify(pkg, null, 2) + "\n")

try {
  execSync(["npm publish", ...process.argv.slice(2)].join(" "), { stdio: "inherit" })
} finally {
  restore()
}
