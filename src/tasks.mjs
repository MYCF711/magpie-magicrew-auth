// 签到 = 自动做完新手福利
//
// ═══════════════════════════════════════════════════════════════════════
// 结论先说：不用浏览器
// ═══════════════════════════════════════════════════════════════════════
//
// 一开始从主 chunk 里只挖到埋点事件名（`onboarding_guide_step_click`），
// 所以以为任务要靠前端导览判定。翻到 `onboarding-CZBI0pQt.js` 才发现
// 真正的接口只有两行：
//
//   GET  /api/v1/onboarding/tasks
//   PUT  /api/v1/onboarding/tasks/{code}/completion
//
// 8 项任务里 7 项 PUT 一下就完成、积分当场到账。只有 `first_ai_work`
// 回 9303「该新人引导任务不支持手动完成」—— 那项得真的跑一次 AI 任务。
//
// 实测（2026-10-27）：1240 → 1540，+300，六项全部当场入账。
//
// ═══════════════════════════════════════════════════════════════════════
//
// 所以 magpie 的 auth.checkin 钩子做的事：
//   ① 拉任务列表
//   ② 把 PENDING 的挨个 PUT（跳过不支持手动的）
//   ③ 报积分变化
//
// 每天跑一次，第一次就把 300 分拿完；之后每次都是 done。

import { fetchPoints, fetchOnboardingTasks, completeOnboardingTask } from "./api.mjs"

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

  let tasks = []
  try {
    tasks = await fetchOnboardingTasks(h.jwt, h.org, h.host)
  } catch (e) {
    return { outcome: "failed", message: `读不到新手任务：${e?.message ?? e}` }
  }

  const done = tasks.filter((t) => t.status === "COMPLETED" || t.rewardStatus === "GRANTED")
  const pending = tasks.filter((t) => t.status !== "COMPLETED" && t.rewardStatus !== "GRANTED")

  if (!pending.length) {
    return {
      outcome: "done",
      message: `新手福利 ${tasks.length} 项已全部完成（当前积分 ${before}）`,
    }
  }

  // 挨个完成
  const claimed = []
  const skipped = []
  const failed = []

  for (const t of pending) {
    if (NOT_MANUALLY_COMPLETABLE.has(t.code)) {
      skipped.push(`${t.title}（${t.points} 分，要真跑一次 AI 任务）`)
      continue
    }
    try {
      const r = await completeOnboardingTask(h.jwt, h.org, t.code, h.host)
      claimed.push({ code: t.code, title: t.title, points: r.points || t.points })
    } catch (e) {
      if (e?.code === CODE_NOT_SUPPORTED) {
        skipped.push(`${t.title}（${t.points} 分，不支持手动完成）`)
      } else {
        failed.push(`${t.code}: ${e?.message ?? e}`)
      }
    }
    // 服务端限流留点余地
    await new Promise((r) => setTimeout(r, 400))
  }

  let after = before
  try {
    after = (await fetchPoints(h.jwt, h.org, h.host)).total
  } catch {}

  const gained = after - before
  const parts = []
  if (gained > 0) parts.push(`积分 +${gained}（${before} → ${after}）`)
  else parts.push(`积分 ${after}（本次无变动）`)
  if (claimed.length) parts.push(`完成 ${claimed.length} 项：${claimed.map((c) => c.title).join("、")}`)
  if (skipped.length) parts.push(`需手动：${skipped.join("、")}`)
  if (failed.length) parts.push(`失败 ${failed.length} 项：${failed.join("；")}`)

  if (claimed.length) {
    return {
      outcome: "claimed",
      credit: gained > 0 ? gained : undefined,
      message: parts.join("。"),
    }
  }

  return {
    outcome: failed.length ? "failed" : "done",
    message: parts.join("。"),
  }
}

export { NOT_MANUALLY_COMPLETABLE }
