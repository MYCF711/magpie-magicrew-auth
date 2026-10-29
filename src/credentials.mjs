// 凭证捕获目录：所有成功登录（验证码 / 浏览器 / 登录态导入 / 临时邮箱注册机）
// 都把 JWT + 组织码落一份到这里。
//
// 约定位置：~/.config/magpie/magicrew-login-states/<account>.json
// 内容：{ address, jwt, org, source, capturedAt }
//
// 只写凭证，不写 magpie 的 plugin-auth / logins；正式入库仍走导入 worker。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CREDENTIALS_DIR = join(homedir(), ".config", "magpie", "magicrew-login-states")

function safeName(s) {
  return String(s || "").replace(/[^a-z0-9@._-]/gi, "_").slice(0, 120)
}

/** 成功登录后调用；写失败不抛（不能因为落盘失败挡登录） */
export function captureCredential({ address, jwt, org, source = "login" } = {}) {
  try {
    if (!jwt || !org) return null
    mkdirSync(CREDENTIALS_DIR, { recursive: true })
    const name = safeName(address || org)
    const file = join(CREDENTIALS_DIR, `${name}.json`)
    writeFileSync(
      file,
      JSON.stringify({ address: address || org, jwt, org, source, capturedAt: Date.now() }, null, 2),
    )
    return file
  } catch {
    return null
  }
}

export function listCredentials() {
  try {
    return readdirSync(CREDENTIALS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(CREDENTIALS_DIR, f), "utf8")) } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}