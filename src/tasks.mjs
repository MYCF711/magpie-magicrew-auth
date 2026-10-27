// 签到 = 每日登录积分 + 自动做完新手福利
//
// ═══════════════════════════════════════════════════════════════════════
// 两套机制，别混
// ═══════════════════════════════════════════════════════════════════════
//
// ① 每日登录积分 —— POST /api/v1/login-gift（无 body）
//      两站同构，幂等，每天一次。国际站 +50/天，国内站 +200/天。
//      当天已领 → granted:false「今日已领取登录积分」，HTTP 仍 200。
//      **这才是真正的「每日签到」**，也是 0.3.7 及更早版本完全漏掉的那一块。
//      来源：2026-10-27 用真实网页登录抓包得到（magicrew.ai 的 /login-gift）。
//
// ② 新手福利任务 —— GET /api/v1/onboarding/tasks + PUT .../completion
//      一次性收益，8 项里 7 项 PUT 即完成，first_ai_work 服务端不收手动完成。
//      ⚠ 国际站这个接口恒返回 {participant_type:null, tasks:[]} —— 是「这个账号
//        没被登记进引导计划」，不是「已经领完了」。0.3.7 把 0 项当成功上报，
//        于是 msg 写着「新手福利 0 项已全部完成」，实际上什么都没做。
//
// ═══════════════════════════════════════════════════════════════════════
//
// 每天跑一次，两步都做，任一步失败不影响另一步。

import { fetchPoints, claimLoginGift, fetchOnboardingTasks, completeOnboardingTask, fetchFirstWorkspaceId, fetchProjectTopics } from "./api.mjs"
import { sentToday, noteAutoChat } from "./store.mjs"

/** 站点 id —— 去重标记按站点分文件存 */
function siteIdOf(host) {
  return host.includes("magicrew") ? "magicrew-intl" : "magicrew"
}

/** 已知不支持手动完成的任务，别再白试 */
const NOT_MANUALLY_COMPLETABLE = new Set(["first_ai_work"])

/** 9303 = 该新人引导任务不支持手动完成 */
const CODE_NOT_SUPPORTED = 9303

/**
 * @param {{ jwt: string, org: string, host: string }} auth
 *   host 由调用方的插件闭包给（每个供应商绑定一个站点，不在 auth 里存站点代号）
 */
export async function runCheckin(auth) {
  const host = auth.host
  const h = { jwt: auth.jwt, org: auth.org, host }

  let before = null
  try {
    before = (await fetchPoints(h.jwt, h.org, h.host)).total
  } catch (e) {
    return { outcome: "failed", message: `读不到积分：${e?.message ?? e}` }
  }

  const parts = []
  let claimedAnything = false
  let failed = false

  // ── ① 每日登录积分 ────────────────────────────────────────────────
  try {
    const gift = await claimLoginGift(h.jwt, h.org, h.host)
    if (gift.granted) {
      claimedAnything = true
      parts.push(`每日登录 +${gift.points}`)
    } else {
      parts.push("每日登录已领过")
    }
  } catch (e) {
    failed = true
    parts.push(`每日登录失败：${e?.message ?? e}`)
  }

  // ── ② 新手福利任务 ────────────────────────────────────────────────
  let tasks = []
  let tasksErr = null
  try {
    tasks = await fetchOnboardingTasks(h.jwt, h.org, h.host)
  } catch (e) {
    tasksErr = e
  }

  if (tasksErr) {
    failed = true
    parts.push(`新手任务读取失败：${tasksErr?.message ?? tasksErr}`)
  } else if (!tasks.length) {
    // 国际站：onboarding 接口恒返回空数组，没有「新手福利」这套任务。
    // 但**邀请奖励的判据是一样的** —— 官方 locale 原文「被邀请人完成首个任务
    // 或对话后，即可获得 {{points}} 积分奖励」，而国际站没有任务清单，
    // 所以那条判据在这边就等于「发过一条消息」。
    //
    // 实测（2026-10-28）：新号发一条消息后，邀请人立刻 +200。
    //
    // 怎么判断「要不要发」：看这个账号有没有工作台项目 ——
    //   一个项目都没有 = 从没发过消息 → 建项目 + 发一条
    //   已经有项目     = 用过 → 跳过（别每天签到都发，白烧积分）
    const r = await autoFirstChat(h)
    if (r.ok) {
      claimedAnything = true
      parts.push(`首对话：已自动完成（${r.topicName}，模型 ${r.model}）`)
    } else if (r.skipped) {
      parts.push("首对话：此前已用过，跳过")
    } else {
      parts.push(`首对话：${r.reason}`)
    }
  } else {
    const pending = tasks.filter((t) => t.status !== "COMPLETED" && t.rewardStatus !== "GRANTED")

    if (!pending.length) {
      parts.push(`新手福利 ${tasks.length} 项均已领完`)
    } else {
      const claimed = []
      const skipped = []
      const taskFailed = []

      for (const t of pending) {
        // 「完成第一次 AI 工作」是唯一 PUT 不掉的：服务端认死必须是产品内
        // 真的跑完过一次对话（PUT 回 9303）。所以改成**替它发一条消息** ——
        // 走 chat-task 的纯协议通道，不开浏览器。
        // 这也是邀请奖励的触发条件：被邀请人完成首个任务后，邀请人才拿到分。
        if (t.code === "first_ai_work") {
          const r = await autoFirstWork(h)
          if (r.ok) {
            claimed.push({ code: t.code, title: t.title, points: t.points })
            if (r.pending) parts.push("首任务：消息已发出，等结算")
          } else if (r.skipped) {
            // 今天已经补过 —— 不是失败，只是不再重复发
            parts.push(`首任务：${r.reason}`)
          } else {
            skipped.push(`${t.title}（${t.points} 分）：${r.reason}`)
          }
          continue
        }
        try {
          const r = await completeOnboardingTask(h.jwt, h.org, t.code, h.host)
          claimed.push({ code: t.code, title: t.title, points: r.points || t.points })
        } catch (e) {
          if (e?.code === CODE_NOT_SUPPORTED) {
            skipped.push(`${t.title}（${t.points} 分，不支持手动完成）`)
          } else {
            taskFailed.push(`${t.code}: ${e?.message ?? e}`)
          }
        }
        // 服务端限流留点余地
        await new Promise((r) => setTimeout(r, 400))
      }

      if (claimed.length) {
        claimedAnything = true
        parts.push(`新手福利完成 ${claimed.length} 项：${claimed.map((c) => c.title).join("、")}`)
      }
      if (skipped.length) parts.push(`需手动：${skipped.join("、")}`)
      if (taskFailed.length) {
        failed = true
        parts.push(`新手福利失败 ${taskFailed.length} 项：${taskFailed.join("；")}`)
      }
    }
  }

  // ── ③ 复读积分，报净变化 ──────────────────────────────────────────
  let after = before
  try {
    after = (await fetchPoints(h.jwt, h.org, h.host)).total
  } catch {}

  const gained = after - before
  const head = gained > 0 ? `积分 +${gained}（${before} → ${after}）` : `积分 ${after}（本次无变动）`
  const msg = [head, ...parts].join("。")

  return {
    outcome: claimedAnything ? "claimed" : failed ? "failed" : "done",
    credit: gained > 0 ? gained : undefined,
    message: msg,
  }
}

/**
 * 替账号完成「第一次 AI 工作」：建个话题、发一条消息、等结算。
 *
 * 为什么不能 PUT：`PUT /onboarding/tasks/first_ai_work/completion` 回 9303
 * 「该新人引导任务不支持手动完成」—— 服务端只认产品内真的有一次对话。
 *
 * 为什么不用浏览器：消息走 Socket.IO，协议已经摸清（见 chat-task.mjs），
 * 纯 Node 发得出去，比拉一个 Chrome 再点输入框可靠得多。
 *
 * @returns {{ok:boolean, pending?:boolean, reason?:string}}
 */
async function autoFirstWork(h) {
  const siteId = siteIdOf(h.host)
  // 闸门：每个账号每天最多补一次。结算慢 / checkin 重试 / 判定不到，
  // 都不会让它反复往外发消息。
  if (sentToday(siteId, h.org)) {
    return { ok: false, skipped: true, reason: "今天已经补过一次，不再重复发送" }
  }

  try {
    const wsId = await fetchFirstWorkspaceId(h.jwt, h.org, h.host).catch(() => "")
    if (!wsId) {
      return { ok: false, reason: "这个账号还没有工作台项目 —— 先在网页里进一次工作台" }
    }

    // 重模块按需加载：WebSocket 那套挂了不该拖累整个签到
    const { runChatTask } = await import("./chat-task.mjs")
    const r = await runChatTask({
      jwt: h.jwt,
      org: h.org,
      host: h.host,
      workspaceId: wsId,
    })
    if (!r.ok) return { ok: false, reason: r.reason || "发送失败" }

    // 消息确实发出去了 —— 立刻落标记，之后不管结算成不成功都不再发第二条
    noteAutoChat(siteId, h.org)

    // 等结算：服务端是异步判定，实测通常 5～40 秒内变成 COMPLETED。
    // 拿不到就算了，标记已经写了，别把这次签到判成失败。
    for (let i = 0; i < 12; i++) {
      await new Promise((res) => setTimeout(res, 5000))
      const list = await fetchOnboardingTasks(h.jwt, h.org, h.host).catch(() => null)
      if (!list) continue
      const fw = list.find((x) => x.code === "first_ai_work")
      if (fw && (fw.status === "COMPLETED" || fw.rewardStatus === "GRANTED")) {
        return { ok: true }
      }
    }
    return { ok: true, pending: true }
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) }
  }
}

/**
 * 国际站的「首个对话」：没有任务清单可依，只能看它用没用过。
 *
 * 判据是**有没有工作台项目**：项目是发第一条消息时前端顺带建的，
 * 一个都没有基本等于从没说过话。已经有项目就跳过，免得每天签到都发一条。
 *
 * @returns {{ok?:boolean, skipped?:boolean, reason?:string, topicName?:string, model?:string}}
 */
async function autoFirstChat(h) {
  const siteId = siteIdOf(h.host)
  // 同一道闸门：每账号每天最多一条
  if (sentToday(siteId, h.org)) {
    return { skipped: true, reason: "今天已经补过一次" }
  }

  try {
    const wsId = await fetchFirstWorkspaceId(h.jwt, h.org, h.host).catch(() => "")
    if (!wsId) return { reason: "这个账号还没有工作区，先在网页里进一次" }

    // ── 判据：**有没有话题**，不是有没有项目 ──────────────────────────
    //
    // 项目在打开工作台时就会自动建，建了项目却一句话没说很常见（新号就是）。
    // 而邀请奖励要的是「被邀请人完成首个任务或对话」—— 落到国际站就是
    // **真的发过一条消息**，也就是有过一个话题。
    //
    // 拿项目 -> 列它的话题：有话题 = 说过话，跳过；没话题 = 得补一条。
    const { findProjectId, runChatTask } = await import("./chat-task.mjs")
    const pid = await findProjectId(h.jwt, h.org, h.host, wsId).catch(() => "")
    if (pid) {
      const topics = await fetchProjectTopics(h.jwt, h.org, pid, h.host).catch(() => [])
      if (topics.length > 0) {
        return { skipped: true, reason: `已有 ${topics.length} 个话题，说明发过消息` }
      }
    }

    const r = await runChatTask({ jwt: h.jwt, org: h.org, host: h.host, workspaceId: wsId })
    if (!r.ok) return { reason: r.reason || "发送失败" }

    // 发出去了才落标记；失败的不写，留给下一次（明天）重试
    noteAutoChat(siteId, h.org)
    return { ok: true, topicName: r.topicName, model: r.model }
  } catch (e) {
    return { reason: String(e?.message ?? e) }
  }
}

export { NOT_MANUALLY_COMPLETABLE }
