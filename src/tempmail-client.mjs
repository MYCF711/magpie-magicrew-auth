// temp-mail.io 客户端：给「邮箱验证码（临时邮箱·自动）」这条登录方式用
// 公开站点内部 API，无需 key；域名默认 yzcalo.com（magicrew 不拦这个域）
const BASE = "https://api.internal.temp-mail.io/api"
const DOMAIN = "yzcalo.com"

function nameOf() {
  return "mk" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export async function createTempMailbox() {
  const res = await fetch(`${BASE}/v3/email/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: nameOf(), domain: DOMAIN }),
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await res.text()
  let j = null
  try { j = JSON.parse(raw) } catch {}
  if (!j?.email) throw new Error(`temp-mail.io 建邮箱失败 HTTP ${res.status}：${raw.slice(0, 300)}`)
  return { address: j.email, token: j.token || "" }
}

function codeOf(text) {
  const s = String(text || "")
  const near = s.match(/(?:验证码|校验码|验证代码|verification\s*code|code)[^\d]{0,30}(\d{4,8})/i)
  if (near) return near[1]
  const six = s.match(/(?<!\d)(\d{6})(?!\d)/)
  return six ? six[1] : ""
}

export async function waitTempCode(address, { timeoutMs = 150_000, intervalMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/v3/email/${address}/messages`, { signal: AbortSignal.timeout(20_000) })
    const list = await res.json().catch(() => null)
    if (Array.isArray(list)) {
      for (const m of list) {
        const code = codeOf(`${m.body_text || ""}\n${m.body_html || ""}`)
        if (code) return code
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error("临时邮箱 150 秒内没收到验证码")
}