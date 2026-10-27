// Magicrew · 超级麦吉 —— magpie 供应商插件
//
// 上游是 dtyq/magic（开源企业级 AI Agent 平台）的云版 letsmagic.cn。
// 它自带 OpenAI 兼容网关，所以这个插件不做协议翻译，只做三件事：
//   ① 登录，把网页的 JWT 换成网关的 mgw_ api_key
//   ② 每 2 小时把 api_key 续一次（refresh_token 双旋转）
//   ③ 把「账号当前能选的模型」「积分余额」「每日奖励 / 新手任务」接进 magpie 的卡片
//
// ⚠ 别改成读 /v1/models：那个返回 44 个，含 VIP 锁定、生图、embedding，
//   塞进 magpie 用户会选到根本调不动的模型。可选模型只有 /api/v1/flows/models 那 27 个。

import { startSelfRegister } from "./src/self-register.mjs"
import {
  SITES,
  site as siteOf,
  login,
  issueGatewayKey,
  refreshGatewayKey,
  fetchModels,
  fetchPoints,
} from "./src/api.mjs"
import { runCheckin } from "./src/tasks.mjs"

const REGISTRY_ENTRY = {
  package: "magpie-magicrew-auth",
  name: "超级麦吉",
  providers: ["magicrew"],
  community: true,
  summary: {
    en: "Magicrew (letsmagic.cn) — an OpenAI-compatible gateway behind a Chinese agent platform: phone sign-in, 27 account-selectable chat models, points metering.",
    zh: "超级麦吉（Magicrew / letsmagic.cn）：中国 Agent 平台背后的 OpenAI 兼容网关，手机号登录，27 个账号可选语言模型，积分计费。",
  },
}

// ── 配置 ──────────────────────────────────────────────────────────────

const PROVIDER = "magicrew"
const PROVIDER_NAME = "超级麦吉"

/** 内嵌图标（SVG→base64）。magpie 只存不拉：外部 URL 在 git 源下不渲染 */
const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNBNzhCRkEiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM1QjIxQjYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjMwIiBmaWxsPSIjMTYxMjFGIi8+PHJlY3QgeD0iMTgiIHk9IjE4IiB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHJ4PSIxMiIgZmlsbD0idXJsKCNnKSIgb3BhY2l0eT0iLjk1Ii8+PHJlY3QgeD0iNjgiIHk9IjE4IiB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHJ4PSIxMiIgZmlsbD0iIzIyRDNFRSIgb3BhY2l0eT0iLjc1Ii8+PHJlY3QgeD0iMTgiIHk9IjY4IiB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHJ4PSIxMiIgZmlsbD0iIzIyRDNFRSIgb3BhY2l0eT0iLjc1Ii8+PHJlY3QgeD0iNjgiIHk9IjY4IiB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHJ4PSIxMiIgZmlsbD0idXJsKCNnKSIgb3BhY2l0eT0iLjk1Ii8+PC9zdmc+"
const DEFAULT_SITE = "cn"
const baseOf = (s) => `${siteOf(s).host}/v1`
const SDK = "@ai-sdk/openai-compatible"
const REFRESH_LEAD_MS = 10 * 60_000 // api_key 只活 2 小时，提前 10 分钟换

// ── 模型表 ────────────────────────────────────────────────────────────
//
// [id, 显示名, 上下文, 是否视觉]
//
// ⚠ 上下文窗口除 glm-5.3-flash 外未逐个实测，一律填 256K 这个保守值：
//   填大了 agent 会等上游报错才知道越界，填小了自己压得早。
//   实测方法见 docs/internals.md。
//
// 积分单价（每百万 token，来自 /api/v1/products/model-points，2026-10-27 实测）
// 见 docs/internals.md 的价格表。
const MODELS = [
  ["glm-5.3-flash", "GLM 5.3 Flash", 256_000, true],
  ["glm-5.3", "GLM 5.3", 256_000, false],
  ["glm-5.1", "GLM 5.1", 256_000, false],
  ["glm-5", "GLM 5", 256_000, false],
  ["glm-5-turbo", "GLM 5 Turbo", 256_000, true],
  ["glm-4.7", "GLM 4.7", 256_000, false],
  ["glm-4.6", "GLM 4.6", 256_000, false],
  ["glm-4.5", "GLM 4.5", 256_000, false],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 256_000, true],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 256_000, true],
  ["qwen3.8-max", "Qwen3.8 Max", 256_000, true],
  ["qwen-3.8-flash", "Qwen3.8 Flash", 256_000, true],
  ["qwen3.7-plus", "Qwen3.7 Plus", 256_000, true],
  ["qwen3.6-plus", "Qwen3.6 Plus", 256_000, true],
  ["qwen3.5-plus", "Qwen3.5 Plus", 256_000, true],
  ["qwen3.5-flash", "Qwen3.5 Flash", 256_000, true],
  ["kimi-k3.1-pro", "Kimi K3.1 Pro", 256_000, true],
  ["minimax-m3", "MiniMax M3", 256_000, true],
  ["minimax-m3.1-flash", "MiniMax M3.1 Flash", 256_000, true],
  ["minimax-m2.7", "MiniMax M2.7", 256_000, true],
  ["minimax-m2.5", "MiniMax M2.5", 256_000, true],
  ["minimax-m2.1", "MiniMax M2.1", 256_000, true],
  ["doubao-seed-2.0-pro", "Seed 2.0 Pro", 256_000, true],
  ["doubao-seed-2.0-code", "Seed 2.0 Code", 256_000, true],
  ["doubao-seed-2.0-lite", "Seed 2.0 Lite", 256_000, true],
  ["mimo-v2.6-pro", "MiMo V2.6 Pro", 256_000, false],
  ["mimo-v2.6-flash", "MiMo V2.6 Flash", 256_000, true],
]

/** 静态模型表（未登录 / 拉取失败时兜底，必须有内容） */
function staticModels(siteId = DEFAULT_SITE) {
  const BASE = baseOf(siteId)
  const out = {}
  for (const [id, name, context, vision] of MODELS) {
    out[id] = {
      id,
      name,
      api: { id, url: BASE, npm: SDK },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context, output: 64_000 },
      capabilities: {
        temperature: true,
        reasoning: true,
        toolcall: true,
        attachment: vision,
        input: { text: true, image: vision },
        output: { text: true },
      },
    }
  }
  return out
}

// ── 插件入口 ──────────────────────────────────────────────────────────

export const MagicrewAuthPlugin = async ({ client, directory }, options) => {
  startSelfRegister(REGISTRY_ENTRY, {
    configDir: directory,
    log: (msg) => {
      try {
        client?.app?.log?.({ service: "magicrew", level: "info", message: msg })
      } catch {}
    },
  })

  return {
    // ═══ ① 声明 provider ══════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: baseOf(DEFAULT_SITE),
        models: staticModels(DEFAULT_SITE),
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
          label: `登录 ${PROVIDER_NAME}`,
          prompts: [
            {
              type: "select",
              key: "region",
              message: "站点",
              options: [
                { label: "国内 · 超级麦吉（letsmagic.cn）", value: "cn" },
                { label: "国际 · MagiCrew（magicrew.ai，未验证）", value: "intl" },
              ],
            },
            {
              type: "text",
              key: "phone",
              message: "手机号",
              placeholder: "13800138000",
              validate: (v) => (/^\d{6,15}$/.test(String(v || "").replace(/\D/g, "")) ? undefined : "只要数字"),
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
              options: [
                { label: "+86 中国", value: "+86" },
                { label: "+852 香港", value: "+852" },
                { label: "+886 台湾", value: "+886" },
                { label: "+1 美国", value: "+1" },
              ],
            },
          ],

          async authorize(inputs) {
            // ⚠ 这里必须立刻返回，真正等结果的是 callback
            const phone = String(inputs?.phone || "").replace(/\D/g, "")
            const password = String(inputs?.password || "")
            const stateCode = String(inputs?.stateCode || "+86")
            const siteId = String(inputs?.region || DEFAULT_SITE)
            const host = siteOf(siteId).host

            const result = (async () => {
              const { token, organizationCode, raw } = await login({ phone, password, stateCode, host })
              const key = await issueGatewayKey(token, organizationCode, host)
              return { token, organizationCode, key, raw }
            })()

            return {
              url: `${siteOf(siteId).web}/login`,
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
                  site: siteId,
                }
              },
            }
          },
        },
        {
          // 兜底：直接从浏览器复制网页登录态。
          // DevTools → Application → Local Storage → www.letsmagic.cn
          //   key `MAGIC:user:authorization`，值是 JSON，取其中的 value
          type: "api",
          label: `${PROVIDER_NAME} 登录态（JWT）`,
          placeholder: "eyJhbGciOi...（MAGIC:user:authorization 的 value）",
          async authorize(inputs) {
            const jwt = String(inputs?.key || "").trim().replace(/^Bearer\s+/i, "")
            if (!jwt.startsWith("eyJ")) return { type: "failed", error: "不是 JWT" }
            try {
              let org = ""
              // 组织码未知时，接口会报「用户不存在」；两个候选都试一次
              for (const guess of ["", "h97gkbu8bruj"]) {
                try {
                  await fetchPoints(jwt, guess)
                  org = guess
                  break
                } catch {}
              }
              const key = await issueGatewayKey(jwt, org)
              return {
                type: "success",
                access: key.apiKey,
                refresh: key.refreshToken,
                expires: Date.now() + 2 * 3600_000,
                accountId: "magicrew",
                jwt,
                org,
                site: DEFAULT_SITE,
              }
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e) }
            }
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      async refresh(auth, provider) {
        if (!auth?.refresh) return undefined
        try {
          const k = await refreshGatewayKey(auth.refresh, siteOf(auth.site).host)
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
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (!auth || auth.type !== "oauth") return {}
        return {
          baseURL: baseOf(auth.site),
          apiKey: auth.access,
          headers: { "user-agent": "MagicrewClient/1.0" },
          async fetch(input, init) {
            const fresh = await getAuth()
            if (!fresh) throw new Error(`${PROVIDER_NAME} 未登录`)

            const req = input instanceof Request ? input : null
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.toString() : req?.url ?? ""

            const incoming = new Headers(init?.headers ?? req?.headers ?? {})
            const headers = {
              authorization: `Bearer ${fresh.access}`,
              "content-type": "application/json",
            }
            for (const [k, v] of incoming) {
              if (["authorization", "host", "content-length", "user-agent"].includes(k.toLowerCase())) continue
              headers[k] = v
            }

            let body = init?.body
            if (body === undefined && req) body = await req.text()

            // 推理模型的坑：短 max_tokens 会被 reasoning 吃光，content 返回空串。
            // 抬到至少 512，否则 magpie 看到的是一次「空回复」。
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
      async usage(getAuth, provider) {
        const auth = await getAuth()
        if (!auth) return { error: "未登录", windows: [] }
        try {
          const p = await fetchPoints(auth.jwt, auth.org, siteOf(auth.site).host)
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
      // magpie 每账号每天按北京时间调一次。这里做三件事：
      //   1. 领每日登录积分（若该账号有未领的）
      //   2. 把能纯 HTTP 完成的新手任务做掉
      //   3. 剩下要 UI 导览的，列在 message 里
      async checkin(getAuth, provider) {
        const auth = await getAuth()
        if (!auth) return { outcome: "failed", message: "未登录" }
        try {
          return await runCheckin(auth)
        } catch (e) {
          return { outcome: "failed", message: String(e?.message ?? e) }
        }
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
    provider: {
      id: PROVIDER,

      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        if (!auth || auth.type !== "oauth") return fallback

        try {
          const live = await fetchModels(auth.jwt, auth.org, siteOf(auth.site).host)
          if (!live.length) return fallback

          const out = {}
          for (const m of live) {
            const base = fallback[m.id] ?? {
              ...Object.values(fallback)[0],
              limit: { context: 256_000, output: 64_000 },
            }
            out[m.id] = {
              ...base,
              id: m.id,
              name: m.name,
              api: { id: m.id, url: baseOf(auth.site), npm: SDK },
              capabilities: {
                ...base.capabilities,
                attachment: m.vision,
                input: { text: true, image: m.vision },
              },
            }
          }
          return out
        } catch (e) {
          if (/401|403|unauthorized|expired|用户不存在/i.test(String(e?.message))) {
            throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
          }
          return fallback
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

export const _internal = {
  PROVIDER,
  baseOf,
  staticModels,
  MODELS,
  SITES,
}
