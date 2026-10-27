// Magicrew · 超级麦吉 / MagiCrew —— magpie 供应商插件
//
// 上游是 dtyq/magic（开源企业级 AI Agent 平台）的两套云：
//   国内  超级麦吉  www.letsmagic.cn   i-magic-service.letsmagic.cn
//   国际  MagiCrew  www.magicrew.ai    magic-service.magicrew.ai
//
// 两套后端是同一份 Go 服务，接口逐字符同构；前端也是同一份构建
// （MAGIC_APP_SHA 两边都是 fb90a86c…），只换注入的服务名。
//
// ═══ 一个包，两个供应商 ═══════════════════════════════════════════════
//
// 这里刻意不做成「登录时选站点」的单供应商。两个站点各自导出成一个插件：
//
//   export const MagicrewAuthPlugin     = makePlugin(SITES.cn)
//   export const MagicrewIntlAuthPlugin = makePlugin(SITES.intl)
//
// magpie 把包里的每个具名导出当成一个独立插件，于是它们在供应商列表、
// 用量概览、模型目录里各占一行，不聚合、不互相覆盖登录态。
// 这和 @magpie-community/opencode-workbuddy-auth 承载 WorkBuddy / WorkBuddy AI、
// opencode-qoder-auth 承载 Qoder / Qoder CN / QwenWork 是同一个做法。
//
// 它自带 OpenAI 兼容网关，所以这个插件不做协议翻译，只做三件事：
//   ① 登录，把网页的 JWT 换成网关的 mgw_ api_key
//   ② 每 2 小时把 api_key 续一次（refresh_token 双旋转）
//   ③ 把「账号当前能选的模型」「积分余额」「新手任务」接进 magpie 的卡片
//
// ⚠ 模型**不写死**：账户当前能选什么就展示什么，权威来源只有
//   GET <host>/api/v1/flows/models（详见下面「模型」一节）。

import { startSelfRegister } from "./src/self-register.mjs"
import {
  SITES,
  site as siteOf,
  login,
  issueGatewayKey,
  refreshGatewayKey,
  fetchModels,
  fetchPoints,
  fetchOwnInviteCode,
} from "./src/api.mjs"
import { runCheckin } from "./src/tasks.mjs"
import { ICON_BY_SITE } from "./src/icons.mjs"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

const COMMUNITY_ENTRY = {
  package: "magpie-magicrew-auth",
  name: "超级麦吉 / MagiCrew",
  providers: ["magicrew", "magicrew-intl"],
  community: true,
  summary: {
    en: "Magicrew (super-magic) — an OpenAI-compatible gateway behind the agent platform, both builds: 超级麦吉 (letsmagic.cn) and MagiCrew (magicrew.ai). Sign-in by password or by pasting the web JWT; points metering.",
    zh: "超级麦吉 / MagiCrew：Agent 平台背后的 OpenAI 兼容网关，国内站与国际站双份。密码登录或粘贴网页 JWT，积分计费。",
  },
}

const SDK = "@ai-sdk/openai-compatible"
const REFRESH_LEAD_MS = 10 * 60_000 // api_key 只活 2 小时，提前 10 分钟换

// ═══ 模型：不写死，按账号实时拉 ═══════════════════════════════════════
//
// 权威来源只有一条：
//
//   GET <host>/api/v1/flows/models        （要网页 JWT + organization-code）
//     → { data: { models: [{ value, label, vision, tags, icon, configs }] } }
//
// 实测（2026-10-27）：国内 27 个、国际 49 个。两站列表**不一样**，而且会
// 随订阅档位和平台方开关变 —— 所以这个包里没有一张模型清单要维护。
//
// ⚠ 别改成读 /v1/models：那个国内 44、国际 65，混着 VIP 锁定、生图、
//   embedding，塞进 magpie 用户会选到根本调不动的模型。
//
// ⚠ 上下文窗口：flows/models 和 /v1/models **都不返回** context_length
//   （/v1/models 只有 id / object / created_at / owner_by）。所以一律按
//   256K 保守填 —— 填大了 agent 要等上游报错才知道越界，填小了自己压得早。
//
// 未登录时 config() 用**上次登录成功时落盘的快照**，没有快照就是空表。
// 空表让卡片显示 0 models，但那是诚实的：这会儿确实不知道账号能选什么。

/** 快照落在 magpie 自己的缓存目录，按站点分开 */
function snapshotPath(siteId) {
  return join(homedir(), ".cache", "magpie", `magicrew-models-${siteId}.json`)
}

function readSnapshot(siteId) {
  try {
    const v = JSON.parse(readFileSync(snapshotPath(siteId), "utf8"))
    return v && typeof v === "object" && Object.keys(v).length ? v : null
  } catch {
    return null
  }
}

function writeSnapshot(siteId, models) {
  try {
    const f = snapshotPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(models))
  } catch {}
}

// ═══ 邀请码：作者码默认开，可以关，也可以换成自己的 ═══════════════════
//
// 两件事分开：
//
//   ① 作者邀请码 —— 注册时默认带上，给作者记一点积分。纯常量，随时能关。
//   ② 自己的邀请码 —— 真去调 /api/v1/invitations/info 拿，拿不到就报错。
//
// 为什么 ② 要有「上次登录的 JWT」：那个接口只认客户端登录态签的 JWT
// （payload 里带用户字段），网页 localStorage 里那把调过去回 2155 用户不存在。
// 而登录进行中还没拿到新 JWT，所以只能用上一次登录成功时存下的那把。
// ⇒ 从没登录过就选「用自己的」，得到的是一句明确的报错，不是猜出来的码。
//
// 奖励口径（上游前端 constants，2026-10-27）：
//            每次注册   每次订阅   邀请注册封顶   总额封顶
//   国内      1,000      3,000       60,000      300,000
//   国际        200        500       10,000       30,000
const AUTHOR_INVITE = {
  // 国内站的作者码 —— 待作者提供（他没给过国内的）
  magicrew: "",
  // 国际站
  "magicrew-intl": "IV75F0ZKVKXG",
}

/** 上次登录成功时落盘的 { jwt, org }，只给「自己的邀请码」用 */
function sessionPath(siteId) {
  return join(homedir(), ".cache", "magpie", `magicrew-session-${siteId}.json`)
}

function readSession(siteId) {
  try {
    const v = JSON.parse(readFileSync(sessionPath(siteId), "utf8"))
    return v?.jwt ? v : null
  } catch {
    return null
  }
}

function writeSession(siteId, jwt, org) {
  try {
    const f = sessionPath(siteId)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ jwt, org }))
  } catch {}
}

// ═══ 站点差异 ═════════════════════════════════════════════════════════

/** 国际站的登录页有 Google / Password / Email / Private Service 四种 */
const INTL_STATE_CODES = [
  { label: "+1 美国 / 加拿大", value: "+1" },
  { label: "+44 英国", value: "+44" },
  { label: "+81 日本", value: "+81" },
  { label: "+65 新加坡", value: "+65" },
  { label: "+852 香港", value: "+852" },
  { label: "+886 台湾", value: "+886" },
  { label: "+86 中国", value: "+86" },
]

const CN_STATE_CODES = [
  { label: "+86 中国", value: "+86" },
  { label: "+852 香港", value: "+852" },
  { label: "+886 台湾", value: "+886" },
  { label: "+1 美国", value: "+1" },
]

// ═══ 插件工厂 ═════════════════════════════════════════════════════════
//
// 一个 SITE 进，一个完整插件出。每个插件只认自己那一个站点：
// auth 里不存 site 字段，所有 host 都来自闭包里的 SITE。

function makePlugin(SITE) {
  const PROVIDER = SITE.id // = magpie 的供应商 id
  const SHORT = SITE.id === "magicrew" ? "超级麦吉" : "MagiCrew"
  const BASE = `${SITE.host}/v1`
  const STATE_CODES = SITE.id === "magicrew" ? CN_STATE_CODES : INTL_STATE_CODES
  // 两个站点的品牌图各用各的（见 src/icons.mjs），在 GUI 里一眼分得开
  const ICON = SITE.id === "magicrew" ? ICON_BY_SITE.cn : ICON_BY_SITE.intl

  /** 把 flows/models 的一条变成一个 magpie 模型条目 */
  function modelEntry(id, name, vision) {
    return {
      id,
      name,
      api: { id, url: BASE, npm: SDK },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 256_000, output: 64_000 },
      capabilities: {
        temperature: true,
        reasoning: true,
        toolcall: true,
        attachment: !!vision,
        input: { text: true, image: !!vision },
        output: { text: true },
      },
    }
  }

  return async ({ client, directory }) => {
    startSelfRegister(COMMUNITY_ENTRY, {
      configDir: directory,
      log: (msg) => {
        try {
          client?.app?.log?.({ service: PROVIDER, level: "info", message: msg })
        } catch {}
      },
    })

    return {
      // ═══ ① 声明 provider ══════════════════════════════════════════════
      config: async (cfg) => {
        cfg.provider ??= {}
        cfg.provider[PROVIDER] ??= {
          name: SHORT,
          npm: SDK,
          api: BASE,
          // 未登录时给上次的快照；从没登录过就是空表（宁缺毋假）。
          // 一旦登录，provider.models 会把真表拉回来并落盘。
          models: readSnapshot(SITE.id) ?? {},
        }
      },

      auth: {
        provider: PROVIDER,

        icon: ICON,
        maxConcurrency: 4,
        refreshLead: REFRESH_LEAD_MS,

        // ═══ ② 登录 ═══════════════════════════════════════════════════
        methods: [
          {
            type: "oauth",
            label: `${SHORT} 密码登录`,
            prompts: [
              {
                type: "text",
                key: "phone",
                message: "手机号",
                placeholder: "13800138000",
                validate: (v) =>
                  /^\d{6,15}$/.test(String(v || "").replace(/\D/g, "")) ? undefined : "只要数字",
              },
              {
                type: "password",
                key: "password",
                message: "密码（网页「密码登录」那个，不是验证码）",
              },
              {
                type: "select",
                key: "stateCode",
                message: "区号",
                options: STATE_CODES,
              },
              {
                // 默认带作者邀请码；换成「我自己的」就真去调接口取，取不到报错。
                // 这项只在**这次登录顺带建组织**时生效（账号早就有组织的，服务端不再记账）。
                type: "select",
                key: "invite",
                message: "注册邀请码",
                options: [
                  {
                    label: AUTHOR_INVITE[SITE.id]
                      ? `作者邀请码 ${AUTHOR_INVITE[SITE.id]}（默认）`
                      : "作者邀请码（这个站点作者没给码，等于不用）",
                    value: "author",
                  },
                  { label: "我自己的邀请码（真去取，取不到会报错）", value: "own" },
                  { label: "不用邀请码", value: "none" },
                ],
              },
            ],

            async authorize(inputs) {
              // ⚠ 这里必须立刻返回，真正等结果的是 callback
              const phone = String(inputs?.phone || "").replace(/\D/g, "")
              const password = String(inputs?.password || "")
              const stateCode = String(inputs?.stateCode || (SITE.id === "magicrew" ? "+86" : "+1"))
              const inviteMode = String(inputs?.invite || "author")

              const result = (async () => {
                let inviteCode = ""
                if (inviteMode === "author") {
                  inviteCode = AUTHOR_INVITE[SITE.id] || ""
                } else if (inviteMode === "own") {
                  // 真跑一次。拿不到就抛，让 callback 把真实原因回给用户 —— 不猜、不静默降级。
                  const prev = readSession(SITE.id)
                  if (!prev) {
                    throw new Error(
                      "这个站点还没登录成功过，拿不到你自己的邀请码 —— 先按「作者邀请码」或「不用」登录一次，之后再来选这项",
                    )
                  }
                  const own = await fetchOwnInviteCode(prev.jwt, prev.org, SITE.host)
                  inviteCode = own.code
                }

                const { token, organizationCode, raw } = await login({
                  phone,
                  password,
                  stateCode,
                  host: SITE.host,
                  inviteCode,
                })
                const key = await issueGatewayKey(token, organizationCode, SITE.host)
                return { token, organizationCode, key, raw, inviteCode }
              })()

              // 同步就能拼的只有作者码；「自己的」那一刻还没取到
              const authorCode = AUTHOR_INVITE[SITE.id] || ""
              const loginUrl =
                inviteMode === "author" && authorCode
                  ? `${SITE.web}/login?invitation=${encodeURIComponent(authorCode)}`
                  : `${SITE.web}/login`

              return {
                url: loginUrl,
                instructions: "正在用手机号+密码登录…",
                method: "auto",
                opened: true,
                async callback() {
                  let r
                  try {
                    r = await result
                  } catch (e) {
                    return { type: "failed", error: String(e?.message ?? e) }
                  }
                  if (!r) return { type: "failed", error: "登录超时" }
                  // 存下这把 JWT：下次选「我自己的邀请码」要用它换码
                  // （只有登录态签的 JWT 能调 /api/v1/invitations/info）
                  writeSession(SITE.id, r.token, r.organizationCode)
                  return {
                    type: "success",
                    access: r.key.apiKey,
                    refresh: r.key.refreshToken,
                    expires: Date.now() + 2 * 3600_000,
                    accountId: phone,
                    uid: String(r.raw?.magic_id || r.raw?.userId || r.raw?.user_id || phone),
                    // 额外字段：models / usage / checkin 要用网页 JWT，mgw key 调不动业务接口
                    jwt: r.token,
                    org: r.organizationCode,
                    inviteCode: r.inviteCode || "",
                  }
                },
              }
            },
          },
          {
            // 兜底，也是国际站现在最好走的一条：直接从浏览器复制登录态。
            //
            // 两样都在 DevTools → Application → Local Storage → <站点域名>：
            //   MAGIC:user:authorization     → JSON，取 value   = JWT
            //   MAGIC:user:organizationCode  → JSON，取 value   = 组织码
            //
            // ⚠ 组织码**不能从 JWT 推**：JWT 里只有 cus.tenant_id（18 位数字，
            //   例 765235992687812611），组织码是另一套短串（例 67u4oe6fbenj）。
            //   服务端按组织码查组织：缺了它 /api/v1/* 回
            //   {"code":2182,"message":"用户所在组织不存在"}；
            //   给错了回 {"code":3035,"message":"登录失败"}。
            type: "oauth",
            label: `${SHORT} 登录态（JWT + 组织码）`,
            prompts: [
              {
                type: "text",
                key: "jwt",
                message: "JWT（MAGIC:user:authorization 的 value）",
                placeholder: "eyJhbGciOi...",
                validate: (v) =>
                  String(v || "").trim().startsWith("eyJ") ? undefined : "不是 JWT，要以 eyJ 开头",
              },
              {
                type: "text",
                key: "org",
                message: "组织码（MAGIC:user:organizationCode 的 value）",
                placeholder: "67u4oe6fbenj",
                validate: (v) =>
                  /^[a-z0-9]{6,32}$/i.test(String(v || "").trim())
                    ? undefined
                    : "12 位左右的字母数字",
              },
            ],

            async authorize(inputs) {
              const jwt = String(inputs?.jwt || "")
                .trim()
                .replace(/^Bearer\s+/i, "")
              const org = String(inputs?.org || "").trim()
              if (!jwt.startsWith("eyJ")) return { type: "failed", error: "不是 JWT" }
              if (!org) return { type: "failed", error: "没填组织码" }

              const result = (async () => {
                // 先验一次：读积分。这一步失败就说明 JWT 或组织码不对，
                // 不用等签密钥那种更绕的错误
                await fetchPoints(jwt, org, SITE.host)
                return issueGatewayKey(jwt, org, SITE.host)
              })()

              return {
                url: `${SITE.web}/login`,
                instructions: "正在验证登录态…",
                method: "auto",
                opened: false,
                async callback() {
                  let r
                  try {
                    r = await result
                  } catch (e) {
                    return { type: "failed", error: String(e?.message ?? e) }
                  }
                  return {
                    type: "success",
                    access: r.apiKey,
                    refresh: r.refreshToken,
                    expires: Date.now() + 2 * 3600_000,
                    accountId: org,
                    uid: org,
                    jwt,
                    org,
                  }
                },
              }
            },
          },
        ],

        // ═══ ③ 续期 ═══════════════════════════════════════════════════
        async refresh(auth) {
          if (!auth?.refresh) return undefined
          try {
            const k = await refreshGatewayKey(auth.refresh, SITE.host)
            return {
              access: k.apiKey,
              // ⚠ 服务端每次 PUT 都轮换 refresh_token，必须用新的
              refresh: k.refreshToken ?? auth.refresh,
              expires: Date.now() + 2 * 3600_000,
            }
          } catch (e) {
            if (/invalid|expired|401|403/i.test(String(e?.message))) {
              throw Object.assign(new Error("登录已失效，请重新登录"), { signIn: "expired" })
            }
            throw e
          }
        },

        // ═══ ④ 请求接管 ═══════════════════════════════════════════════
        async loader(getAuth) {
          const auth = await getAuth()
          if (!auth) return {}
          return {
            baseURL: BASE,
            apiKey: auth.access,
            headers: { "user-agent": "MagicrewClient/1.0" },
            async fetch(input, init) {
              const fresh = await getAuth()
              if (!fresh) throw new Error(`${SHORT} 未登录`)

              const req = input instanceof Request ? input : null
              const url =
                typeof input === "string"
                  ? input
                  : input instanceof URL
                    ? input.toString()
                    : (req?.url ?? "")

              const incoming = new Headers(init?.headers ?? req?.headers ?? {})
              const headers = {
                authorization: `Bearer ${fresh.access}`,
                "content-type": "application/json",
              }
              // ⚠ 国际站网关**强制**要 organization-code：缺了 /v1/chat/completions
              //   直接 HTTP 500 "Internal Server Error."（22 字节裸文本）。
              //   国内站不需要，所以按站点发。
              if (SITE.needsOrgOnGateway && fresh.org) headers["organization-code"] = fresh.org

              for (const [k, v] of incoming) {
                if (["authorization", "host", "content-length", "user-agent"].includes(k.toLowerCase()))
                  continue
                headers[k] = v
              }

              let body = init?.body
              if (body === undefined && req) body = await req.text()

              // 推理模型的坑：短 max_tokens 会被 reasoning 吃光，content 返回空串。
              // 抬到至少 512，否则 magpie 看到的是一次「空回复」。
              // 实测 glm-5.3-flash：64 → finish_reason:"length" 且 content:""；
              //                    512 → 正常出话（reasoning 208 / total 233）。
              if (typeof body === "string" && body.includes('"max_tokens"')) {
                try {
                  const j = JSON.parse(body)
                  if (Number(j.max_tokens) > 0 && Number(j.max_tokens) < 512) j.max_tokens = 512
                  body = JSON.stringify(j)
                } catch {}
              }

              return fetch(url, {
                method: init?.method ?? "POST",
                headers,
                body,
                signal: init?.signal ?? req?.signal ?? AbortSignal.timeout(300_000),
              })
            },
          }
        },

        // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
        //
        // 超级麦吉是预充值积分，没有「月度配额百分比」这种东西。
        // 给一个 aside 窗口：显示余额，不参与「用光就往下排」的判定；
        // 余额为 0 时 used 置 100，让它老老实实排到最后。
        async usage(getAuth) {
          const auth = await getAuth()
          if (!auth) return { error: "未登录", windows: [] }
          try {
            const p = await fetchPoints(auth.jwt, auth.org, SITE.host)
            const nextExpiry = p.expiring?.[0]?.expiresAt
            return {
              plan: p.total > 0 ? "积分制" : "已耗尽",
              balance: `${p.total.toLocaleString("zh-CN")} 积分`,
              windows: [
                p.total > 0
                  ? {
                      name: "积分余额",
                      used: 0,
                      display: `${p.total.toLocaleString("zh-CN")} 积分`,
                      amount: 0,
                      limit: p.total,
                      unit: "积分",
                      resetsAt: nextExpiry,
                      aside: true,
                    }
                  : { name: "积分余额", used: 100, display: "已耗尽" },
              ],
            }
          } catch (e) {
            return { error: String(e?.message ?? e), windows: [] }
          }
        },

        // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
        //
        // magpie 每账号每天按北京时间调一次。国内站的 8 项新手奖励里
        // 7 项 PUT 即到账（实测 1240 → 1540，+300）。
        // 国际站 /api/v1/onboarding/tasks 现在回空列表（tasks:[]），
        // 说明这个账号的引导已结束 —— 接口在，但没东西可领。
        async checkin(getAuth) {
          const auth = await getAuth()
          if (!auth) return { outcome: "failed", message: "未登录" }
          try {
            return await runCheckin({ ...auth, host: SITE.host })
          } catch (e) {
            return { outcome: "failed", message: String(e?.message ?? e) }
          }
        },
      },

      // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
      provider: {
        id: PROVIDER,

        async models(provider, { auth } = {}) {
          const snapshot = readSnapshot(SITE.id)
          if (!auth) return snapshot ?? {}

          try {
            const live = await fetchModels(auth.jwt, auth.org, SITE.host)
            if (!live.length) return snapshot ?? {}

            const out = {}
            for (const m of live) out[m.id] = modelEntry(m.id, m.name, m.vision)
            writeSnapshot(SITE.id, out)
            return out
          } catch (e) {
            if (/401|403|unauthorized|expired|用户不存在|登录失败/i.test(String(e?.message ?? e))) {
              throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
            }
            // 网络抖动：退回上次的快照，别让整个供应商从列表里消失
            return snapshot ?? {}
          }
        },
      },

      // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
      "chat.headers": async (input, output) => {
        const id = input?.model?.providerID ?? input?.provider?.info?.id
        if (id !== PROVIDER || !input?.sessionID) return
        output.headers["x-magicrew-session"] = String(input.sessionID).slice(0, 128)
      },
    }
  }
}

// ═══ 两个供应商，各占一行 ═════════════════════════════════════════════

export const MagicrewAuthPlugin = makePlugin(SITES.cn)
export const MagicrewIntlAuthPlugin = makePlugin(SITES.intl)

export const _internal = {
  makePlugin,
  baseOf: (siteId) => `${siteOf(siteId).host}/v1`,
  SITES,
  readSnapshot,
  snapshotPath,
}
