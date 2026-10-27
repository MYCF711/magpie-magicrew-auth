// 纯协议完成「第一次 AI 工作」—— 不开浏览器、不点页面
//
// ═══════════════════════════════════════════════════════════════════════
// 为什么能做到
// ═══════════════════════════════════════════════════════════════════════
//
// 2026-10-27 用 CDP 抓了网页发消息的全过程，发现：
//
//   · 消息走 Socket.IO（Engine.IO v3），wss://<host>/socket.io/?EIO=3&transport=websocket
//   · **鉴权在消息体里**（context.authorization = JWT），不在握手头 —— 所以不用带 Cookie
//   · 不需要先发 `40` CONNECT，直接 `42/im,<ns>["login",…]` 就能被受理
//   · <ns> 是客户端自己生成的唯一数字（浏览器用 Date.now()），随便给不重复的就行
//
// 帧格式（实测）：
//
//   42/im,<ns>["login",{context:{…}}]        → 43/im,<ns>[{code:1000,…user}]
//   42/im,<ns>["chat", {context:{…},data:{…}}] → 43/im,<ns>[{code:1000,…seq}]
//
// ═══════════════════════════════════════════════════════════════════════
// 那三个 id 从哪来（这是最容易卡住的地方）
// ═══════════════════════════════════════════════════════════════════════
//
//   conversation_id      ← topic.chat_conversation_id
//   message.topic_id     ← topic.chat_topic_id
//   （⚠ 不是 project.current_topic_id —— 那个传过去回 3016「话题未找到」）
//
// 话题可以直接建：POST /api/v1/super-agent/topics { topic_name, project_id }
// 返回体里就带着 chat_topic_id / chat_conversation_id，拿来即用。
//
// ═══════════════════════════════════════════════════════════════════════
// 模型
// ═══════════════════════════════════════════════════════════════════════
//
// chat 帧里必须写死一个模型。查 /api/v1/products/model-points 拿每个模型的
// input_points / output_points，按两者之和升序取最小的 —— 目前是 qwen3.5-flash
// （20 / 200），也正是网页的默认模型。没有免费档。

import { fetchModels, fetchModelPoints, SITES } from "./api.mjs"

/** 建话题用的名字池 —— 随机挑一个，别每次都是「测试」那种一眼假的 */
const TOPIC_NAMES = [
  "你好",
  "介绍一下你自己",
  "今天适合做什么",
  "帮我理一下思路",
  "随便聊聊",
  "写一句鼓励的话",
  "解释一下什么是 AI",
  "推荐一本值得读的书",
]

const PICK_TEXT = "你好，介绍一下你自己"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pickName() {
  return TOPIC_NAMES[Math.floor(Math.random() * TOPIC_NAMES.length)]
}

/** 极简 CDP 无关：这是 WebSocket 客户端，只收发文本帧 */
async function openSocket(host, origin) {
  const url = `wss://${host}/socket.io/?EIO=3&transport=websocket&timestamp=${Date.now()}`
  const ws = new WebSocket(url, { headers: { Origin: origin } })
  const queue = []
  let notify = null

  ws.addEventListener("message", (ev) => {
    const d = String(ev.data || "")
    if (d === "2") { try { ws.send("3") } catch {} return }   // Engine.IO ping → pong
    queue.push(d)
    if (notify) { const n = notify; notify = null; n() }
  })

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("WebSocket 连接超时")), 15_000)
    ws.addEventListener("open", () => { clearTimeout(t); res() }, { once: true })
    ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("WebSocket 连接失败")) }, { once: true })
  })

  return {
    ws,
    /** 等下一条满足条件的帧；超时返回 null */
    async next(pred, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        for (let i = 0; i < queue.length; i++) {
          if (pred(queue[i])) return queue.splice(i, 1)[0]
        }
        await new Promise((res) => {
          notify = res
          setTimeout(() => { if (notify === res) { notify = null; res() } }, 500)
        })
      }
      return null
    },
    /** 把队列里所有帧读掉（用于等 AI 回复） */
    drain() {
      const all = queue.slice()
      queue.length = 0
      return all
    },
    close() { try { ws.close() } catch {} },
  }
}

/** 按投入+产出积分之和挑最便宜的模型 */
export async function pickCheapestModel(jwt, org, host = SITES.cn.host) {
  const models = await fetchModels(jwt, org, host).catch(() => [])
  if (!models.length) return null
  const byId = new Map(models.map((m) => [m.id, m]))
  let points = {}
  try {
    points = await fetchModelPoints(jwt, org, models.map((m) => m.id), host)
  } catch {}

  const scored = models
    .map((m) => {
      const p = points[m.id] || {}
      const cost = Number(p.inputPoints ?? 0) + Number(p.outputPoints ?? 0)
      return { id: m.id, name: m.name, cost, known: p.inputPoints != null }
    })
    // 有计费信息的优先；都没有就按名字兜底
    .sort((a, b) => (b.known - a.known) || (a.cost - b.cost))

  const best = scored[0]
  if (!best) return null
  const icon = models.find((m) => m.id === best.id)?.icon || ""
  return { model_id: best.id, model_name: byId.get(best.id)?.name || best.id, model_icon: icon || "" }
}

/** 找一个能挂话题的项目；没有就返回空串 */
export async function findProjectId(jwt, org, host, workspaceId) {
  const res = await fetch(`${host}/api/v1/super-agent/projects/participated`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      accept: "application/json",
      origin: host.includes("magicrew") ? "https://www.magicrew.ai" : "https://www.letsmagic.cn",
      "organization-code": org,
    },
    body: JSON.stringify({ workspace_id: workspaceId, page: 1, page_size: 20, show_collaboration: 1, include_special: 0 }),
  })
  const body = await res.json().catch(() => ({}))
  const list = body?.data?.list ?? body?.data?.items ?? []
  return String(list[0]?.id ?? "")
}

/** 建一个话题，返回 chat_topic_id / chat_conversation_id */
export async function createTopic(jwt, org, host, projectId, name = pickName()) {
  const res = await fetch(`${host}/api/v1/super-agent/topics`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      accept: "application/json",
      origin: host.includes("magicrew") ? "https://www.magicrew.ai" : "https://www.letsmagic.cn",
      "organization-code": org,
    },
    body: JSON.stringify({ topic_name: name, project_id: projectId }),
  })
  const body = await res.json().catch(() => ({}))
  const d = body?.data ?? {}
  if (body?.code !== 1000 || !d.chat_topic_id || !d.chat_conversation_id) {
    throw new Error(`建话题失败：${body?.message ?? "无返回"}（code ${body?.code}）`)
  }
  return {
    name,
    topicId: String(d.chat_topic_id),
    conversationId: String(d.chat_conversation_id),
    id: String(d.id ?? ""),
  }
}

/**
 * 发一条消息并等 AI 回复完。
 *
 * @returns {{ok:boolean, messageId?:string, replies?:number, reason?:string}}
 */
export async function sendChat(jwt, org, host, { topicId, conversationId, text = PICK_TEXT, model }) {
  const origin = host.includes("magicrew") ? "https://www.magicrew.ai" : "https://www.letsmagic.cn"
  const sock = await openSocket(host.replace(/^https?:\/\//, ""), origin)
  const ns = String(Date.now())
  const appMsgId = `${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 14)}`
  const ctx = () => ({
    timestamp: Date.now(),
    authorization: jwt,
    organization_code: org,
    language: "zh_CN",
    signature: "",
  })

  try {
    // ① 登录
    sock.ws.send(
      `42/im,${ns}` +
        JSON.stringify([
          "login",
          { context: ctx(), data: { message: { type: "text", text: { content: "登录" }, app_message_id: "WEB-" + appMsgId }, conversation_id: "" } },
        ]),
    )
    const loginAck = await sock.next((d) => d.startsWith(`43/im,${ns}`), 20_000)
    if (!loginAck) return { ok: false, reason: "登录无响应" }
    const la = JSON.parse(loginAck.slice(`43/im,${ns}`.length))?.[0] || {}
    if (la.code !== 1000) return { ok: false, reason: `登录失败：${la.message}（code ${la.code}）` }
    const senderId = String(la.data?.user?.user_id ?? "")

    // ② 发消息
    const richText = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { suggestion: "", wechatMediaState: null, wechatInstruction: false },
          content: [{ type: "text", text }],
        },
      ],
    })
    const m = model || { model_id: "qwen3.5-flash", model_name: "Qwen3.5 Flash", model_icon: "" }
    sock.ws.send(
      `42/im,${ns}` +
        JSON.stringify([
          "chat",
          {
            context: ctx(),
            data: {
              message: {
                type: "rich_text",
                rich_text: {
                  content: richText,
                  instructs: [{ value: "normal" }],
                  extra: {
                    super_agent: {
                      mentions: [],
                      chat_mode: "normal",
                      topic_pattern: "general",
                      model: m,
                      enable_web_search: false,   // 首任务不需要联网，关掉省时间也省钱
                      image_model: { model_id: "doubao-seedream-5-0-pro", model_name: "Seedream 5.0 Pro", model_icon: "" },
                      dynamic_params: { message_version: "v2" },
                    },
                  },
                },
                send_timestamp: Date.now(),
                send_time: Date.now(),
                sender_id: senderId,
                app_message_id: appMsgId,
                message_id: appMsgId,
                topic_id: topicId,
              },
              conversation_id: conversationId,
            },
          },
        ]),
    )
    const chatAck = await sock.next((d) => d.startsWith(`43/im,${ns}`), 25_000)
    if (!chatAck) return { ok: false, reason: "发送无响应" }
    const ca = JSON.parse(chatAck.slice(`43/im,${ns}`.length))?.[0] || {}
    if (ca.code !== 1000) return { ok: false, reason: `发送失败：${ca.message}（code ${ca.code}）` }

    // ③ 等 AI 真的回一条（看到 super_magic_message 就算数），最多 90 秒
    const deadline = Date.now() + 90_000
    let replies = 0
    while (Date.now() < deadline) {
      const f = await sock.next((d) => d.includes(`42/im,["chat"`) || d.includes("super_magic_message") || d.includes("end_conversation_input"), 5_000)
      if (f && f.includes("super_magic_message")) replies++
      if (replies >= 1) break
    }
    return { ok: true, messageId: String(ca.data?.seq?.seq_id ?? ""), replies }
  } finally {
    sock.close()
  }
}

/**
 * 完整链路：找项目 → 建话题（随机名）→ 挑最便宜的模型 → 发一条消息。
 * 不改任何账号状态，失败只返回原因。
 */
export async function runChatTask({ jwt, org, host = SITES.cn.host, workspaceId, text, onProgress = () => {} }) {
  onProgress("挑选模型…")
  const model = await pickCheapestModel(jwt, org, host).catch(() => null)

  onProgress("定位项目…")
  const projectId = await findProjectId(jwt, org, host, workspaceId)
  if (!projectId) {
    return { ok: false, reason: "这个账号还没有工作台项目 —— 先在网页里进一次工作台，或换用「浏览器登录」让它自动建项目" }
  }

  onProgress("建一个话题…")
  const topic = await createTopic(jwt, org, host, projectId, pickName())

  onProgress("发送消息…")
  const r = await sendChat(jwt, org, host, {
    topicId: topic.topicId,
    conversationId: topic.conversationId,
    text: text || PICK_TEXT,
    model,
  })

  return {
    ...r,
    topicName: topic.name,
    topicId: topic.topicId,
    model: model?.model_name || "(默认)",
  }
}

export { TOPIC_NAMES, PICK_TEXT }
