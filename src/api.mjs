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

// 一个包 = 两个 provider。
//
// 每个站点的 `id` 就是它在 magpie 里的**供应商 id** —— 不是内部代号。
// 所以两个站会各自占一行（供应商列表、用量概览、模型目录全分开），
// 和 @magpie-community/opencode-workbuddy-auth 承载 WorkBuddy / WorkBuddy AI、
// opencode-qoder-auth 承载 Qoder / Qoder CN / QwenWork 是同一个做法：
//   export const MagicrewAuthPlugin     = makePlugin(SITES.cn)
//   export const MagicrewIntlAuthPlugin = makePlugin(SITES.intl)
//
// ⚠ `cn` 的 id 必须保持 `magicrew` —— 已装的用户靠这个 id 认领登录态。
export const SITES = {
  cn: {
    id: "magicrew",
    label: "国内 · 超级麦吉",
    web: "https://www.letsmagic.cn",
    host: "https://i-magic-service.letsmagic.cn",
  },
  intl: {
    id: "magicrew-intl",
    label: "国际 · MagiCrew",
    web: "https://www.magicrew.ai",
    // 实测（2026-10-27）：来源是 www.magicrew.ai 的运行时配置注入页
    //   GET https://www.magicrew.ai/workspace  →  HTML 里内嵌 window 配置
    //   "MAGIC_SERVICE_BASE_URL":"https://magic-service.magicrew.ai"
    //   "MAGIC_APP_ENV":"international-prod"
    //
    // ⚠ api.magicrew.ai 不是这套 API —— 它是 MAGIC_GATEWAY_ADDRESS（teamshare 网关），
    //   对 /v1/models、/api/v1/* 一律回 "not match rule path"。
    //
    // 该网关与国内 i-magic-service.letsmagic.cn 逐字符同构（同一个 Go 服务）：
    //   GET /                     → hello, magic-service!
    //   GET /v1/models            → {"code":403,"message":"token无效"}
    //   GET /api/v1/flows/models  → {"code":2179,"message":"auth_token 不存在"}
    host: "https://magic-service.magicrew.ai",
    // 国际站 /v1/chat/completions **强制**要求 organization-code：
    //   不带 → HTTP 500 "Internal Server Error."（22 字节裸文本，不是 JSON）
    //   带上 → 200 正常 chat.completion
    // 国内站 /v1/* 不需要（README 里那套一直是两条 base 分开用的）。
    needsOrgOnGateway: true,
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
export async function login({
  phone,
  password,
  stateCode = "+86",
  organizationCode = "",
  host = SITES.cn.host,
  inviteCode = "",
}) {
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
      // 注册邀请码。
      //
      // 字段名来自上游前端 dtyq/magic 的 `types/login.ts`（`invite_code?: string`），
      // 消费时机写在 `LoginService.ts` 的注释里：
      //   // PS: 改到在无组织下创建组织的时候再消费邀请码
      //   // values.invite_code = consumeInvitationCookie()
      // ⇒ 不是登录那一下生效，是「该账号还没有组织、这次登录顺手建个人组织」时生效。
      //   已经是老账号、组织早就有了，传了也不会再记账。
      //
      // 不传就是空串，服务端忽略（登录本身不受影响）。
      invite_code: inviteCode || "",
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

// ── ③c 每日登录积分（每日签到）────────────────────────────────────────
//
// POST /api/v1/login-gift，**无请求体**。这条是 2026-10-27 从网页抓包里挖出来的：
//
//   POST /api/v1/login-gift
//   → {"code":1000,"data":{"granted":true,"point_amount":50,
//                          "expire_type":1,"message":"成功领取每日登录积分"}}
//
// 关键性质（同日实测，两个站点都验过）：
//
//   · 幂等：当天已领过 → granted:false, point_amount:0, "今日已领取登录积分"
//            HTTP 仍是 200，不是错误 —— 所以可以每天无脑调用
//   · 两站同构：国际站 +50/天，国内站 **+200/天**，路径、方法、返回结构完全一样
//   · 奖励进的是当天 23:59:59 过期的额度包（expire_type:1），不累积
//
// ⚠ 这条和「新手福利」（onboarding/tasks）是两套完全独立的机制。
//   国际站的 onboarding 接口 participant_type 恒为 null、tasks 恒为空数组，
//   靠它永远领不到每日登录积分 —— 早前版本就是这么漏的。

/**
 * 领取当日登录积分。已领取不是错误，靠 granted 字段区分。
 *
 * @returns {{granted:boolean, points:number, message:string}}
 */
export async function claimLoginGift(token, org, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/login-gift`, {
    method: "POST",
    headers: headersFor(token, org, host),
    body: "",
  })
  const body = await read(res)
  const d = body?.data ?? {}
  return {
    granted: Boolean(d.granted),
    points: Number(d.point_amount ?? 0),
    message: String(d.message ?? ""),
  }
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

// ── ④b 自己的邀请码 ──────────────────────────────────────────────────
//
// 「Free Points Program」那套分享激励。页面上看到的现成链接长这样：
//
//   https://www.magicrew.ai/?invitation=IV75F0ZKVKXG
//   https://www.letsmagic.cn/?invitation=<code>
//
// 奖励口径两站不同（来自上游前端 constants，2026-10-27 读的）：
//
//            每次注册   每次订阅   邀请注册封顶   总额封顶
//   国内      1,000      3,000       60,000      300,000
//   国际        200        500       10,000       30,000
//
// 接口（2026-10-27 实测，从客户端 Cache/Cache_Data/data_1 里读出来的）：
//
//   GET /api/v1/invitations/info                  → { invite_code, invite_count, invited_users }
//   GET /api/v1/invitations/activity              → 活动配置
//   GET /api/v1/invitations/rewards/total-points  → 已赚积分
//
// ⚠ 早前这里写着「这三个接口只认客户端那把 JWT（438 字符），网页版那把 354 字符的
//   调过去回 2155 用户不存在」—— **2026-10-27 复核，这条已经不成立**：
//   四个账号（两站各两个）全是 354 字符的网页 JWT、cus.device_id 全为空，
//   `/api/v1/invitations/info` 全部返回 200 并正常给出 invite_code。
//   上游放宽了这个限制。所以「用我自己的邀请码」不再受 JWT 来源限制，
//   只要手里有登录态就能换成自己的码。
export const INVITE_CODE_PATH = "/api/v1/invitations/info"

/** 拿不到就抛错 —— 调用方要的是「真实结果」，不是静默降级 */
export async function fetchOwnInviteCode(token, org, host = SITES.cn.host) {
  const res = await fetch(`${host}${INVITE_CODE_PATH}`, { headers: headersFor(token, org, host) })
  const body = await read(res)
  const d = body?.data ?? {}
  const code = d.invite_code || d.inviteCode || d.code || d.invitation_code || ""
  if (!code) throw new MagicrewError("接口通了但返回里没有 invite_code")
  return {
    code,
    count: Number(d.invite_count ?? 0),
    invited: Array.isArray(d.invited_users) ? d.invited_users.length : 0,
  }
}

// ── ④b-2 邀请奖励明细 ────────────────────────────────────────────────
//
//   GET /api/v1/invitations/rewards  → { page, total, list:[…] }
//
// 每条 = 一笔「因为邀请而该发给我的奖励」：
//
//   { reward_points: 1000, description: "注册奖励", status: "COMPLETED",
//     status_description: "已完成", scheduled_at: "…", invited_user_id: "usi_…" }
//
// 发放条件（前端 locale 原文，2026-10-27 核对）：
//
//   「被邀请人完成首个任务或对话后，即可获得 {{points}} 积分奖励。」
//   「邀请的用户开通付费套餐，在其套餐每个月度周期结束后，发放奖励积分」
//
// ⚠ 这就是「小号注册了、邀请人却没到账」的答案：**光注册不发**。
//   被邀请人得真的在**产品里**跑完一次任务/对话 —— 走 socket 的那条路。
//   通过 magpie / OpenAI 兼容网关调模型**不算**：实测同一个号用 magpie
//   调了好几轮、真扣了积分，`first_ai_work` 仍然是 PENDING（见 CHANGELOG 0.3.9）。
export async function fetchInviteRewards(token, org, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/invitations/rewards`, {
    headers: headersFor(token, org, host),
  })
  const body = await read(res)
  const d = body?.data ?? {}
  const list = Array.isArray(d.list) ? d.list : []
  return {
    total: Number(d.total ?? list.length),
    earned: list
      .filter((r) => String(r.status).toUpperCase() === "COMPLETED")
      .reduce((s, r) => s + Number(r.reward_points ?? 0), 0),
    list: list.map((r) => ({
      points: Number(r.reward_points ?? 0),
      description: String(r.description ?? ""),
      status: String(r.status ?? ""),
      statusText: String(r.status_description ?? ""),
      scheduledAt: r.scheduled_at ?? null,
      invitedUserId: String(r.invited_user_id ?? ""),
    })),
  }
}

// ── ④e 某个项目下的话题 ────────────────────────────────────────────
//
//   GET /api/v1/super-agent/projects/{id}/topics → { total, list:[{ id, chat_topic_id, chat_conversation_id, topic_name, … }] }
//
// 两个用途：
//   ① 发消息时拿 chat_topic_id / chat_conversation_id
//   ② **判断这个账号到底说没说过话** —— 有话题 = 发过。
//
// ⚠ 别用「有没有项目」来判断：项目在打开工作台时就会自动建，
//   建了项目但一句话没说的情况很常见（新号就是）。
export async function fetchProjectTopics(token, org, projectId, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/super-agent/projects/${projectId}/topics`, {
    headers: headersFor(token, org, host),
  })
  const body = await read(res)
  const d = body?.data ?? {}
  const list = Array.isArray(d.list) ? d.list : []
  return list.map((t) => ({
    id: String(t.id ?? ""),
    chatTopicId: String(t.chat_topic_id ?? ""),
    chatConversationId: String(t.chat_conversation_id ?? ""),
    name: String(t.topic_name ?? ""),
    status: String(t.task_status ?? ""),
  }))
}

// ── ④d 第一个工作区 ──────────────────────────────────────────────────
//
// 自动完成首任务要打开 `/<站点>/global/super/workspace/<id>`，这个 id 只有接口给。
// 每个账号注册时会自动建一个默认工作区，取第一个就够。
export async function fetchFirstWorkspaceId(token, org, host = SITES.cn.host) {
  const res = await fetch(
    `${host}/api/v1/super-agent/workspaces/queries?page=1&page_size=1&pin_priority=true`,
    { headers: headersFor(token, org, host) },
  )
  const body = await read(res)
  const d = body?.data ?? {}
  const list = d.list ?? d.items ?? []
  const w = list[0] ?? null
  return String(w?.id ?? w?.workspace_id ?? w?.workspaceId ?? "")
}

// ── ④c 这个登录态是谁 ────────────────────────────────────────────────
//
// 卡片上原来显示组织码（orgcode67890 / orgcode12345），那是随机串，用户认不出是谁。
//
// 优先级：**手机号 → 邮箱 → 昵称 → 真名**。
//
// ⚠ 昵称排在后面是有原因的：那是用户自己填的，新账号可以不填、也可以随便填
//   （作者自己的账号填的是 "MYCF711"，跟他是谁毫无关系）。手机号是登录凭据本身，
//   改不了、也漏不掉。
//
// ⚠ 服务端把手机号打码了（实测 `138****8000`，中间四位星号），邮箱常常是 null。
//   打码归打码，它仍然是唯一稳定的账号标识 —— 至少能看出是哪个号。
//
// 接口来自客户端缓存里出现过的清单（docs/internals.md 第九节的办法找到的）。
export async function fetchWho(token, org, host = SITES.cn.host) {
  const res = await fetch(`${host}/api/v1/contact/accounts/me/users`, { headers: headersFor(token, org, host) })
  const body = await read(res)
  const u = body?.data?.items?.[0] ?? body?.data ?? {}
  const name = String(u.phone || u.email || u.nickname || u.real_name || "").trim()
  return {
    name,
    nickname: String(u.nickname || "").trim(),
    phone: String(u.phone || ""),
    email: String(u.email || ""),
  }
}

export { MagicrewError, headersFor as _headers }
