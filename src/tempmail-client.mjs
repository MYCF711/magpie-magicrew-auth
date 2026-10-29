// 临时邮箱插件的本机服务客户端。
//
// ⚠ 边界：这个插件**不建邮箱、不碰 temp-mail.io**。建邮箱/收信/抽码都在
//   `magpie-tempmail` 插件里（风险集中在那里）；这里只通过它暴露的本机 HTTP API
//   领取一个已建好的邮箱，并等它的验证码。
//
// 发现文件：~/.config/magpie/tempmail.json
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createDirectMailbox, waitDirectCode } from "./tempmail-io.mjs"

const DISCOVERY = () => join(homedir(), ".config", "magpie", "tempmail.json")
const HEARTBEAT_MS = 15_000

/** 同步判断宿主服务是否还在：端口 + 发现文件 15 秒内更新过 */
export function tempMailAvailable() {
  try {
    const p = DISCOVERY()
    const st = statSync(p)
    if (Date.now() - st.mtimeMs > HEARTBEAT_MS) return false
    const d = JSON.parse(readFileSync(p, "utf8"))
    return Boolean(d?.port && d?.token)
  } catch {
    return false
  }
}

function discovery() {
  const d = JSON.parse(readFileSync(DISCOVERY(), "utf8"))
  if (!d?.port || !d?.token) throw new Error("临时邮箱插件没有在运行（发现文件缺 port/token）")
  return d
}

async function call(path, init = {}) {
  const d = discovery()
  const headers = { "x-tempmail-token": d.token, ...(init.headers || {}) }
  const res = await fetch(`http://127.0.0.1:${d.port}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(init.timeout || 20_000),
  })
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch {}
  if (!res.ok) throw new Error(`临时邮箱服务 ${res.status}：${(j?.error || text).slice(0, 200)}`)
  return j
}

/** 领取一个给 magicrew-intl 用的邮箱；没有就现建一个（建邮箱仍发生在 temp 插件里） */
export async function claimTempMailbox(providerId) {
  // 优先用临时邮箱插件（面板里能看见这个邮箱）；它没在跑就直连 temp-mail.io，
  // 保证「自动捕获验证码」是全自动的，不要求用户先去面板建邮箱。
  try {
    const j = await call("/mailboxes/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId }),
      timeout: 6_000,
    })
    if (j?.address) return { address: j.address, created: Boolean(j.created), via: "service" }
  } catch {}
  const mb = await createDirectMailbox()
  return { address: mb.address, created: true, via: "direct" }
}

/** 等验证码：先直连 temp-mail.io（服务建的地址也在它上面），失败再问插件服务 */
export async function waitTempCode(address, { timeoutMs = 150_000 } = {}) {
  try {
    return await waitDirectCode(address, { timeoutMs })
  } catch (directErr) {
    try {
      const j = await call(`/mailboxes/${address}/code?timeoutMs=${timeoutMs}`, { timeout: timeoutMs + 10_000 })
      if (j?.code) return j.code
    } catch {}
    throw directErr
  }
}