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
import { isAutoChatSettled, noteAutoChat, noteAutoChatFailure } from "./store.mjs"

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
    } else if (!r.settled) {
      // settled = 这个账号早就补过了（一次性任务）—— 不必每天在签到消息里复述
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
          } else if (r.settled) {
            // 这个账号早就补过了（一次性任务）—— 安静跳过，不必每天复述
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
  // 余额可能是负数（上游欠费，见 CHANGELOG 0.3.65）：签到报告也别把 `-32` 甩给用户。
  // 增量那一句保留 before → after 的对照（那是事实），欠的那一头写成「已欠费 32」。
  const pointsText = (n) => (n < 0 ? `已欠费 ${-n}` : `${n}`)
  const head = gained > 0
    ? `积分 +${gained}（${pointsText(before)} → ${pointsText(after)}）`
    : after < 0
      ? `${pointsText(after)} 积分（本次无变动）`
      : `积分 ${after}（本次无变动）`
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

  // 闸门：这个账号**曾经**补过就不再发 —— 不是「今天发过没有」。
  // 邀请奖励只发一次，补第二遍纯属白烧积分（见 store.mjs 那节注释）。
  if (isAutoChatSettled(siteId, h.org)) {
    return { ok: false, settled: true, reason: "首任务此前已补过（一次性任务）" }
  }

  try {
    const wsId = await fetchFirstWorkspaceId(h.jwt, h.org, h.host).catch(() => "")
    if (!wsId) {
      // 账号还没进过工作台 —— 不算失败、也不计数：只读接口，下次签到再来
      return { ok: false, reason: "这个账号还没有工作台 —— 先在网页里进一次工作台" }
    }

    // 重模块按需加载：WebSocket 那套挂了不该拖累整个签到
    const { runChatTask } = await import("./chat-task.mjs")
    const r = await runChatTask({
      jwt: h.jwt,
      org: h.org,
      host: h.host,
      workspaceId: wsId,
    })
    if (!r.ok) {
      // 真去发了但没成 —— 计数，到上限就放弃，别让一个永远失败的号每次签到撞一遍
      const f = noteAutoChatFailure(siteId, h.org, r.reason || "发送失败")
      const why = r.reason || "发送失败"
      return { ok: false, reason: f.givenUp ? `${why}（已试 ${f.attempts} 次，不再重试）` : why }
    }

    // 消息确实发出去了 —— 立刻写**一次性**标记。之后不管结算成不成功、换不换天、
    // 重不重登，都不会再发第二条：这件事判的是「有没有过」，不是「今天有没有」。
    noteAutoChat(siteId, h.org, { topicId: r.topicId || undefined, model: r.model || undefined })

    // 顺手等一会儿结算，让签到消息报得准。拿不到也无所谓 —— 标记已经写了，
    // 下次签到看到 PENDING 只会安静跳过，不会再发消息。
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
    const why = String(e?.message ?? e)
    const f = noteAutoChatFailure(siteId, h.org, why)
    return { ok: false, reason: f.givenUp ? `${why}（已试 ${f.attempts} 次，不再重试）` : why }
  }
}

/**
 * 国际站的「首个对话」：没有任务清单可依，只能看它用没用过。
 *
 * 判据是**有没有话题**，不是有没有工作台项目 —— 项目在打开工作台时就会
 * 自动建，「建了项目、一句话没说」的新号很常见，而那种号正是需要补一条的。
 * 话题才是「真的发过消息」的证据。
 *
 * @returns {{ok?:boolean, settled?:boolean, reason?:string, topicName?:string, model?:string}}
 */
async function autoFirstChat(h) {
  const siteId = siteIdOf(h.host)
  // 同一道闸门：一次性。换天、重登、重启都不会再发。
  if (isAutoChatSettled(siteId, h.org)) {
    return { settled: true, reason: "首对话此前已补过（一次性任务）" }
  }

  try {
    const wsId = await fetchFirstWorkspaceId(h.jwt, h.org, h.host).catch(() => "")
    if (!wsId) return { reason: "这个账号还没有工作区，先在网页里进一次" }

    const { findProjectId, runChatTask } = await import("./chat-task.mjs")
    const pid = await findProjectId(h.jwt, h.org, h.host, wsId).catch(() => "")
    if (pid) {
      let topics
      try {
        topics = await fetchProjectTopics(h.jwt, h.org, pid, h.host)
      } catch (e) {
        // 查不到判据就**这次不发**：宁可漏一轮（下次登录 / 签到还会来），
        // 也不要把「接口抖了一下」当成「没说过话」白花一次积分。
        // 不落标记、不计数 —— 这不是失败，是没拿到判据。
        return { reason: `话题清单查不到（${String(e?.message ?? e)}），这次不发` }
      }
      if (topics.length > 0) {
        // 有话题 = 真的发过消息 → 落一次性标记，以后连查都不查
        noteAutoChat(siteId, h.org, { reason: `已有 ${topics.length} 个话题，视为用过` })
        return { settled: true, reason: `此前已用过（已有 ${topics.length} 个话题）` }
      }
      // 有项目、没话题：项目多半是打开工作台时自动建的，一句话没说 —— 往下补。
    }

    const r = await runChatTask({ jwt: h.jwt, org: h.org, host: h.host, workspaceId: wsId })
    if (!r.ok) {
      const f = noteAutoChatFailure(siteId, h.org, r.reason || "发送失败")
      const why = r.reason || "发送失败"
      return { reason: f.givenUp ? `${why}（已试 ${f.attempts} 次，不再重试）` : why }
    }

    // 光把消息写进 topic 不算「用过」：邀请奖励 / 首任务要的是真的完成一次对话。
    // sendChat 在 90 秒内没等到 super_magic_message 时 replies=0，但 ok=true；
    // 这里必须看 replies，否则会把「消息发出但 AI 没回」误落成已完成，永远不再补。
    if (!r.replies) {
      const why = "消息已发出，但 90 秒内没有 AI 回复"
      const f = noteAutoChatFailure(siteId, h.org, why)
      return { reason: f.givenUp ? `${why}（已试 ${f.attempts} 次，不再重试）` : why }
    }

    // 真的收到 AI 回复才写一次性标记；失败/无回复的一直不写，留给下一次
    noteAutoChat(siteId, h.org, { topicId: r.topicId || undefined, model: r.model || undefined })
    return { ok: true, topicName: r.topicName, model: r.model, replies: r.replies }
  } catch (e) {
    const why = String(e?.message ?? e)
    const f = noteAutoChatFailure(siteId, h.org, why)
    return { reason: f.givenUp ? `${why}（已试 ${f.attempts} 次，不再重试）` : why }
  }
}

/**
 * 账号刚加进来时的一次性补完 —— 登录成功后调用，和签到共用同一道闸门。
 *
 * 为什么单独开一个入口：主人的要求是「一个账号加入的时候做一次」，
 * 而不是「每天签到都做」。登录那一刻就是「加入」，做完就永久标记，
 * 之后无论重登多少次、签到多少天，都不会再发第二条消息。
 *
 * 调用方**不要 await** —— 建项目 + 发消息 + 兜底等结算最坏要一分钟，
 * 登录必须立刻返回。失败也不用管：下一个签到日 checkin 会接着做（同一道闸门）。
 *
 * @param {{jwt:string, org:string, host:string}} h
 */
export async function ensureFirstTaskOnce(h) {
  const siteId = siteIdOf(h.host)
  if (isAutoChatSettled(siteId, h.org)) return { settled: true }

  // 国内站：有任务清单。清单里没有 first_ai_work、或者已经完成 → 什么都不用做
  const tasks = await fetchOnboardingTasks(h.jwt, h.org, h.host).catch(() => null)
  if (Array.isArray(tasks) && tasks.length) {
    const fw = tasks.find((t) => t.code === "first_ai_work")
    if (!fw) return { skipped: true, reason: "本站没有这项任务" }
    if (fw.status === "COMPLETED" || fw.rewardStatus === "GRANTED") {
      // 服务端已经认过了 —— 落标记，以后不查了
      noteAutoChat(siteId, h.org, { reason: "服务端已标记完成" })
      return { skipped: true, reason: "已完成" }
    }
    return autoFirstWork(h)
  }

  // 国际站：没有任务清单 → 看有没有话题（不是有没有项目）
  return autoFirstChat(h)
}

export { NOT_MANUALLY_COMPLETABLE }
