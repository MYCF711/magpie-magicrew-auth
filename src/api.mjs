// Magicrew / 超级麦吉 的 HTTP 层
//
// 一个产品两个站，后端不同、模型也不同：
//
//   国内  超级麦吉   www.letsmagic.cn        i-magic-service.letsmagic.cn
//   国际  MagiCrew   www.magicrew.ai         待定（客户端是同一个包，API host 还没摸到）
//
// 每个站点两个 base：
//   业务 API   <host>/api/v1/...      要网页 JWT
//   模型网关   <host>/v1/...          OpenAI 兼容，要 mgw_ api_key
//
// 三层凭证，有效期完全不同：
//   ① 网页登录 JWT   30 天
//   ② mgw_ api_key   2 小时
//   ③ refresh_token  7 天（PUT 一次轮换一次，一次性）
//
// ⇒ 插件只需要 ① 在登录时拿一次，之后 30 天全靠 ③ 自动滚。

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

export const SITES = {
  cn: {
    id: "cn",
    label: "国内 · 超级麦吉",
    web: "https://www.letsmagic.cn",
    host: "https://i-magic-service.letsmagic.cn",
  },
  intl: {
    id: "intl",
    label: "国际 · MagiCrew",
    web: "https://www.magicrew.ai",
    // ⚠ 未验证：api.magicrew.ai 对已知路径全部返回 "not match rule path"
    host: "https://api.magicrew.ai",
    unverified: true,
  },
}

export function site(id) {
  return SITES[id] ?? SITES.cn
}

class MagicrewError extends Error {
  constructor(message, { status, code, site: s } = {}) {
    super(message)
    this.name = "MagicrewError"
    this.status = status
    this.code = code
    this.site = s
  }
}

function headersFor(token, org, host) {
  const h = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": UA,
    accept: "application/json",
    // 网关会看 Origin，缺了偶发 403
    origin: host ? new URL(host).origin : "https://www.letsmagic.cn",
  }
  if (org) h["organization-code"] = org
  return h
}

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
 * 实测（2026-10-27 国内站）：type 只认 "phone_password"；"phone_code" 直接 500。
 * 账号不存在时返回 {"code":33002,"message":"账号不存在"}。
 *
 * 国际站登录页有 Google / Password / Email / Private Service 四种，password 这条大概率同构。
 */
export async function login({ phone, password, stateCode = "+86", organizationCode = "", host = SITES.cn.host }) {
  const res = await fetch(`${host}/api/v1/sessions`, {
    method: "POST",
    headers: headersFor("", organizationCode, host),
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

// ── ② 模型网关的 key ─────────────────────────────────────────────────

/** 用登录 JWT 签发一把 mgw_ key（2 小时）。 */
export async function issueGatewayKey(token, org, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/model-gateway/tokens`, {
    method: "POST",
    headers: headersFor(token, org, host),
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
export async function refreshGatewayKey(refreshToken, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/model-gateway/tokens`, {
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
 * 注意别用 /v1/models —— 国内站它返回 44 个，含 VIP 锁定、生图、embedding，
 * 塞进 magpie 会让用户选到根本调不动的模型。可选模型只有这里这 27 个。
 *
 * 实测返回字段：value / label / icon / tags / configs / vision
 */
export async function fetchModels(token, org, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/flows/models`, { headers: headersFor(token, org, host) })
  const body = await read(res)
  const list = body?.data?.models ?? []
  return list.map((m) => ({
    id: m.value,
    name: (m.label || m.value).trim(),
    vision: !!m.vision,
  }))
}

/** 网关上的全量模型 id（含生图/视频/embedding），用来做分类。 */
export async function fetchAllModels(apiKey, host = SITES.cn.host) {
  const res = await fetch(`${host}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, "user-agent": UA },
  })
  const body = await read(res)
  return (body?.data ?? []).map((m) => m.id)
}

/**
 * 每个模型的计费类型与积分单价。
 *
 * billing_type: TextTokens / Tokens → 语言或向量
 *               Times / ImageCount / Seedream5ProImage → 生图
 * input_points / output_points 是**每百万 token 的积分**。
 */
export async function fetchModelPoints(token, org, modelIds, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/products/model-points`, {
    method: "POST",
    headers: headersFor(token, org, host),
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

// ── ③b 新手任务（onboarding）──────────────────────────────────────────
//
// 这条是前端 chunk `onboarding-CZBI0pQt.js` 里挖出来的，只有一行：
//   GET  /api/v1/onboarding/tasks
//   PUT  /api/v1/onboarding/tasks/{code}/completion
//
// 8 项任务里 7 项可以纯 HTTP 完成（PUT 即到账），只有 `first_ai_work`
// 返回 9303「该新人引导任务不支持手动完成」—— 那项是真的要跑一次 AI 任务。

export async function fetchOnboardingTasks(token, org, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/onboarding/tasks`, { headers: headersFor(token, org, host) })
  const body = await read(res)
  return (body?.data?.tasks ?? []).map((t) => ({
    code: t.code,
    title: t.title,
    points: Number(t.points ?? 0),
    status: t.status,
    rewardStatus: t.reward_status,
    completedAt: t.completed_at,
  }))
}

/**
 * 标记一项任务完成。成功返回 { points }，失败抛出带 code 的错误。
 * 已知失败码：9303 = 该任务不支持手动完成。
 */
export async function completeOnboardingTask(token, org, code, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/onboarding/tasks/${encodeURIComponent(code)}/completion`, {
    method: "PUT",
    headers: headersFor(token, org, host),
    body: "{}",
  })
  const body = await read(res)
  return { points: Number(body?.data?.points ?? 0) }
}

// ── ④ 积分与任务 ─────────────────────────────────────────────────────

/**
 * 积分余额。
 *
 * expiring_quota_details 每一段是一个会过期的额度包，列表顺序 = 先过期的先扣。
 */
export async function fetchPoints(token, org, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/quota/points/total`, { headers: headersFor(token, org, host) })
  const body = await read(res)
  const d = body?.data ?? {}
  return {
    total: Number(d.total_points ?? 0),
    expiring: (d.expiring_quota_details ?? []).map((q) => ({
      points: Number(q.remaining_points ?? 0),
      expiresAt: q.expires_at,
    })),
    nextGrant: d.next_cycle_grant ?? null,
  }
}

/** 积分流水（倒序）。签到和任务做完后可以用来确认到账。 */
export async function fetchPointRecords(token, org, { page = 1, pageSize = 20, host = SITES.cn.host } = {}) {
  // ⚠ 是 POST 不是 GET（GET 回 405 Allow: POST）
  const res = await fetch(`${host}/api/v1/quota/points/records/queries`, {
    method: "POST",
    headers: headersFor(token, org, host),
    body: JSON.stringify({ page: String(page), page_size: String(pageSize) }),
  })
  const body = await read(res)
  return body?.data?.list ?? body?.data ?? []
}

export { MagicrewError, headersFor as _headers }
