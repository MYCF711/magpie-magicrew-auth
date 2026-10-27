// Magicrew / 超级麦吉 的 HTTP 层
//
// 两个 base 是同一个 host：
//   业务 API   https://i-magic-service.letsmagic.cn/api/v1/...
//   模型网关   https://i-magic-service.letsmagic.cn/v1/...        ← OpenAI 兼容
//
// 三层凭证，有效期完全不同：
//   ① 网页登录 JWT   30 天   （本地存 localStorage 的 MAGIC:user:authorization）
//   ② mgw_ api_key   2 小时  （拿 JWT 换，或拿 refresh_token 换）
//   ③ refresh_token  7 天    （PUT 一次就轮换一次，一次性）
//
// ⇒ 插件只需要 ① 在登录时拿一次，之后 30 天全靠 ③ 自动滚。

const HOST = "https://i-magic-service.letsmagic.cn"
const API = `${HOST}/api/v1`
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

class MagicrewError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = "MagicrewError"
    this.status = status
    this.code = code
  }
}

/** 业务接口的公共头。organization-code 必需，否则多数接口 404/403。 */
function headers(token, org) {
  const h = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": UA,
    accept: "application/json",
  }
  if (org) h["organization-code"] = org
  return h
}

/** 把 HTTP 层和业务层的错误都压成一句话，够定位就行。 */
async function read(res) {
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { message: text.slice(0, 200) }
  }
  if (!res.ok) {
    throw new MagicrewError(body?.message || `HTTP ${res.status}`, { status: res.status, code: body?.code })
  }
  // magic 的业务错误码：1000 = ok，其它都是错
  if (typeof body?.code === "number" && body.code !== 1000) {
    throw new MagicrewError(body.message || `code ${body.code}`, { status: res.status, code: body.code })
  }
  return body
}

// ── ① 登录 ───────────────────────────────────────────────────────────

/**
 * 手机号 + 密码登录。
 *
 * 实测（2026-10-27）：type 只认 "phone_password"；"phone_code" 直接 500。
 * 账号不存在时返回 {"code":33002,"message":"账号不存在"}。
 *
 * @returns {{ token: string, organizationCode: string, raw: object }}
 */
export async function login({ phone, password, stateCode = "+86", organizationCode = "" }) {
  const res = await fetch(`${API}/sessions`, {
    method: "POST",
    headers: headers(""), // 登录不需要 bearer
    body: JSON.stringify({
      type: "phone_password",
      phone: String(phone || "").replace(/[^\d]/g, ""),
      password: password || "",
      state_code: stateCode || "+86",
      organization_code: organizationCode || "",
      email: "",
      redirect: "",
    }),
  })
  const body = await read(res)
  const d = body?.data ?? body

  // 字段名官方文档没有；三种写法都兜住，别赌一个
  const token = d?.token || d?.access_token || d?.accessToken || d?.jwt || ""
  if (!token) throw new MagicrewError("登录成功但没拿到 token", { code: body?.code })

  return {
    token,
    organizationCode: d?.organization_code || d?.organizationCode || organizationCode || "",
    raw: d,
  }
}

/**
 * 直接吃网页登录留下的 JWT。
 *
 * 从 letsmagic.cn 的 localStorage 里复制 `MAGIC:user:authorization` 的 value，
 * 或者浏览器 devtools 里任一请求的 Authorization 头去掉 "Bearer "。
 */
export async function whoami(token, org) {
  // 拿到组织码，顺便验证 token 有效
  const res = await fetch(`${API}/quota/points/total`, { headers: headers(token, org) })
  const body = await read(res)
  return body?.data ?? {}
}

// ── ② 模型网关的 key ─────────────────────────────────────────────────

/** 用登录 JWT 签发一把 mgw_ key（2 小时）。 */
export async function issueGatewayKey(token, org) {
  const res = await fetch(`${API}/model-gateway/tokens`, {
    method: "POST",
    headers: headers(token, org),
    body: "{}",
  })
  const body = await read(res)
  const d = body?.data ?? {}
  if (!d.api_key) throw new MagicrewError("签发密钥失败：没有 api_key")
  return {
    apiKey: d.api_key,
    refreshToken: d.refresh_token,
    apiKeyExpiresAt: d.api_key_expires_at,
    refreshTokenExpiresAt: d.refresh_token_expires_at,
  }
}

/**
 * 用 refresh_token 换新的 api_key。
 * 不需要登录态；refresh_token 会**轮换**（一次性的），必须串行调用。
 */
export async function refreshGatewayKey(refreshToken) {
  const res = await fetch(`${API}/model-gateway/tokens`, {
    method: "PUT",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const body = await read(res)
  const d = body?.data ?? {}
  if (!d.api_key) throw new MagicrewError("续期失败：没有 api_key")
  return {
    apiKey: d.api_key,
    refreshToken: d.refresh_token,
    apiKeyExpiresAt: d.api_key_expires_at,
    refreshTokenExpiresAt: d.refresh_token_expires_at,
  }
}

// ── ③ 模型 ───────────────────────────────────────────────────────────

/**
 * 账号**当前能选**的语言模型。
 *
 * 注意别用 /v1/models —— 那个返回 44 个，含 VIP 锁定、生图、embedding，
 * 塞进 magpie 会让用户选到根本调不动的模型。
 *
 * 实测返回 27 个，字段：value / label / icon / tags / configs / vision
 */
export async function fetchModels(token, org) {
  const res = await fetch(`${API}/flows/models`, { headers: headers(token, org) })
  const body = await read(res)
  const list = body?.data?.models ?? []
  return list.map((m) => ({
    id: m.value,
    name: (m.label || m.value).trim(),
    vision: !!m.vision,
  }))
}

/** 全量模型（含生图/视频/embedding）+ 计费类型，用来分类。 */
export async function fetchAllModels(apiKey) {
  const res = await fetch(`${HOST}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, "user-agent": UA },
  })
  const body = await read(res)
  return (body?.data ?? []).map((m) => m.id)
}

/**
 * 拉每个模型的计费类型和积分单价。
 *
 * billing_type: TextTokens / Tokens → 语言或向量
 *               Times / ImageCount / Seedream5ProImage → 生图
 * input_points / output_points 是**每百万 token 的积分**（实测口径见 docs/internals.md）
 */
export async function fetchModelPoints(token, org, modelIds) {
  const res = await fetch(`${API}/products/model-points`, {
    method: "POST",
    headers: headers(token, org),
    body: JSON.stringify({ model_ids: modelIds }),
  })
  const body = await read(res)
  const out = {}
  for (const m of body?.data ?? []) {
    out[m.model_id] = {
      billingType: m.billing_type,
      inputPoints: m.input_points,
      outputPoints: m.output_points,
      kind: classify(m.billing_type, m.model_id),
    }
  }
  return out
}

const EMBEDDING_RE = /embedding|dmeta/i
const IMAGE_RE = /image|seedream|aes_general/i

function classify(billingType, modelId) {
  if (EMBEDDING_RE.test(modelId)) return "embedding"
  if (billingType === "Times" || billingType === "ImageCount" || /Image$/i.test(billingType || "")) return "image"
  if (IMAGE_RE.test(modelId)) return "image"
  if (billingType === "TextTokens" || billingType === "Tokens") return "language"
  return "other"
}

// ── ④ 积分与任务 ─────────────────────────────────────────────────────

/**
 * 积分余额。
 *
 * 返回里 expiring_quota_details 每一段是一个会过期的额度包，
 * 列表顺序 = 先过期的先扣。
 */
export async function fetchPoints(token, org) {
  const res = await fetch(`${API}/quota/points/total`, { headers: headers(token, org) })
  const body = await read(res)
  const d = body?.data ?? {}
  const total = Number(d.total_points ?? 0)
  const expiring = d.expiring_quota_details ?? []
  return {
    total,
    expiring: expiring.map((q) => ({
      points: Number(q.remaining_points ?? 0),
      expiresAt: q.expires_at,
    })),
    nextGrant: d.next_cycle_grant ?? null,
  }
}

/** 积分流水（倒序）。签到和任务做完后可以用来确认到账。 */
export async function fetchPointRecords(token, org, { page = 1, pageSize = 20 } = {}) {
  const qs = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
  const res = await fetch(`${API}/quota/points/records/queries?${qs}`, { headers: headers(token, org) })
  const body = await read(res)
  return body?.data?.list ?? body?.data ?? []
}

export { HOST, API, MagicrewError, headers as _headers }
