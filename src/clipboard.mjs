// 剪贴板 —— 浏览器登录的降级通道
//
// 场景：本机没有 Chrome / Edge，或者自己拉起来的那个没读出凭据。
// 这时让用户在官方登录页的 Console 里粘一行，把 jwt + org 送进剪贴板，
// 插件读回来 —— 不用他去 DevTools 里翻两个字段。
//
// ⚠ authorize() 里不能 await 读剪贴板（起 powershell 要几百毫秒，它必须立刻返回）；
//   把 promise 递到 callback 才落地。

import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCb)

// ═══ 浏览器登录：为什么只能「开页面 + 接剪贴板」═══════════════════════
//
// 想要的那种「点一下 → 跳官网 → 用 Google / 邮箱 / 手机登 → 插件自己拿到凭证」
// magicrew **没有这条路**，不是没找到实现方法，是接口不存在：
//
//   ① 它的登录类型只有 13 种，全是「拿凭据换 token」的：
//        phone_password / phone_captcha / email / DingTalk / DingTalkAvoid /
//        wecom / Lark / LarkRedirect / wechat_official_account / wechat_app /
//        dingtalk_app / redirect / apple_login / google_login / feishu_oauth
//      （dtyq/magic `frontend/magic-web/src/types/login.ts` 的 LoginType 枚举，
//       注释写明「登录方式(与API强绑定，禁止修改)」）
//      —— 没有设备码、没有插件授权、没有一次性 ticket。
//
//   ② WorkBuddy 那种做法在它这里是空的：它没有
//        POST /v2/plugin/auth/state      （开登录会话）
//        GET  /v2/plugin/auth/token      （轮询拿 token）
//      这套 `/plugin/auth/*` 协议。
//
//   ③ 也试过 `/api/v1/auth/status`、`/api/v1/auth/environment`、
//      `/api/v1/aggregation/login-data` —— status 要 authorization（3103），
//      environment 回 `{"login_code":null}` 且没有配套的兑现接口。
//
//   ④ 网页登录成功后 token 只在 www.magicrew.ai 的 localStorage 里，
//      插件读不到别的源的存储；`redirect` 字段也不能收任意回调地址。
//
// ⇒ 所以能做的最短路径是：**用系统浏览器打开官方登录页（官方登录方式一样不少），
//   登录完粘一行 Console 命令把两个值送进剪贴板，插件自己读回来。**
//   用户不用在 magpie 里输手机号密码，也不用去 DevTools 里翻两个字段。
//
// 剪贴板读法（三平台）：
//   win32   powershell Get-Clipboard -Raw
//   darwin  pbpaste
//   linux   xclip -selection clipboard -o
const CLIP_HINT = [
  "浏览器已打开官方登录页 —— 用你平时的方式登进去（Google / 邮箱 / 手机号都行）。",
  "登录完成后回到那个页面按 F12 → Console，粘这一行回车：",
  `copy(JSON.stringify({jwt:(()=>{try{return JSON.parse(localStorage["MAGIC:user:authorization"]).value}catch{return localStorage["MAGIC:user:authorization"]}})(),org:(()=>{try{return JSON.parse(localStorage["MAGIC:user:organizationCode"]).value}catch{return localStorage["MAGIC:user:organizationCode"]}})()}))`,
  "插件会自己从剪贴板读，读到就完成 —— 不用回来点任何按钮。",
].join("\n")

async function clipboardText() {
  try {
    const { stdout } = await execFile(CLIP_CMD[process.platform]?.[0] ?? "true", CLIP_CMD[process.platform]?.slice(1) ?? [], {
      timeout: 6000,
      windowsHide: true,
      maxBuffer: 1 << 20,
    })
    return String(stdout ?? "")
  } catch {
    return ""
  }
}

const CLIP_CMD = {
  win32: ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
  darwin: ["pbpaste"],
  linux: ["xclip", "-selection", "clipboard", "-o"],
}

/** 剪贴板里的内容 → { jwt, org }，认不出返回 null */
function parseCreds(txt) {
  const s = String(txt || "").trim()
  if (!s) return null
  // ① Console 那行给的 JSON
  try {
    const o = JSON.parse(s)
    if (typeof o?.jwt === "string" && o.jwt.startsWith("eyJ")) {
      return { jwt: o.jwt, org: String(o?.org || "").trim() }
    }
  } catch {}
  // ② 只粘了 JWT（组织码空着，后面会报错让人补）
  if (s.startsWith("eyJ") && s.split(".").length === 3) return { jwt: s, org: "" }
  return null
}

/**
 * 盯着剪贴板，直到出现能认的凭证。
 * @param skip 打开登录页之前剪贴板里就有的内容 —— 不能拿它当结果
 */
async function pollClipboard({ skip = "", timeout = 300_000, interval = 1500 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const txt = (await clipboardText()).trim()
    if (txt && txt !== skip) {
      const got = parseCreds(txt)
      if (got) return got
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return null
}


export { CLIP_HINT, clipboardText, parseCreds, pollClipboard }
