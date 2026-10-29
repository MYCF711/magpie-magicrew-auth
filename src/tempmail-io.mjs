// temp-mail.io 直连兜底：临时邮箱插件没在跑时，自动捕获验证码仍然要能完成。
// 只建地址 + 读收件，不写 magpie 账号库。
const BASE = "https://api.internal.temp-mail.io/api"
const DOMAIN = "yzcalo.com"

export async function createDirectMailbox() {
  const name = "mk" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const res = await fetch(`${BASE}/v3/email/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, domain: DOMAIN }),
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await res.text()
  let j = null
  try { j = JSON.parse(raw) } catch {}
  if (!j?.email) throw new Error(`temp-mail.io 建邮箱失败 HTTP ${res.status}：${raw.slice(0, 200)}`)
  return { address: j.email, token: j.token || "", via: "direct" }
}

function codeOf(text) {
  const s = String(text || "")
  const near = s.match(/(?:验证码|校验码|验证代码|verification\s*code|code)[^\d]{0,30}(\d{4,8})/i)
  if (near) return near[1]
  const six = s.match(/(?<!\d)(\d{6})(?!\d)/)
  return six ? six[1] : ""
}

export async function waitDirectCode(address, { timeoutMs = 150_000, intervalMs = 3_000 } = {}) {
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