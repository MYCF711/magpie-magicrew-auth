// 签到 + 新手任务
//
// ═══════════════════════════════════════════════════════════════════════
// 现状（2026-10-27 实测，别凭这个文件猜）
// ═══════════════════════════════════════════════════════════════════════
//
// 超级麦吉的新手福利是 8 项任务，共 500 积分：
//
//   first_ai_work     完成第一次 AI 工作         +100
//   super_magic_intro 了解工作台                +50
//   ai_ppt            了解 AI PPT               +50
//   ai_recording      AI 录音                   +50
//   digital_employee  雇佣数字员工               +50
//   skill_management  添加/管理技能              +50
//   micro_app         微应用                     +50
//   magiclaw          超级龙虾                   +50
//
// 任务状态存在服务端；**奖励是自动发的**（积分流水里叫「新人引导任务奖励」），
// 不需要点「领取」—— 这块在积分记录里核对过（2026-10-27 13:40:57 +50）。
//
// 但「完成」的判定发生在前端导览里：本地存储的 key 形如
// `onboarding_first_ai_work`，上报事件名 `onboarding_guide_step_click` 等。
// 我们没找到可以纯 HTTP 复现这些完成动作的接口 —— 已试过 14 个候选路径，全 404。
//
// ⇒ 所以这个模块只做**它能做的那部分**，并把做不到的如实写进 message：
//    · 每日登录积分（活动期 200/天）：候选接口探测
//    · 把 still-missing 的任务列出来，让用户知道还差什么
//    · 余额变化写进 message，方便核对有没有到账
//
// 要真正「自动完成导览类任务」，得用浏览器把 7 个导览走一遍（每项 1~2 分钟）。
// 那属于一次性的人工动作，不是签到能带的。

import { fetchPoints, fetchPointRecords } from "./api.mjs"

/** 每日登录积分的候选接口。第一个命中的就用，全不中就算 inactive。 */
const DAILY_CLAIM_CANDIDATES = [
  { method: "POST", path: "/api/v1/quota/points/daily-claim" },
  { method: "POST", path: "/api/v1/quota/points/free-claim" },
  { method: "POST", path: "/api/v1/user/daily-reward" },
  { method: "POST", path: "/api/v1/growth/daily-checkin" },
]

const GUIDE_TASKS = [
  { code: "ai_ppt", label: "了解如何使用 AI PPT", points: 50 },
  { code: "ai_recording", label: "了解 AI 录音完成流程", points: 50 },
  { code: "digital_employee", label: "了解如何雇佣数字员工", points: 50 },
  { code: "skill_management", label: "了解如何添加/管理技能", points: 50 },
  { code: "micro_app", label: "了解微应用创建流程", points: 50 },
  { code: "magiclaw", label: "了解超级龙虾如何使用", points: 50 },
]

async function callJson(method, path, headers) {
  const res = await fetch(`https://i-magic-service.letsmagic.cn${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {}
  }
  return { status: res.status, code: body?.code, message: body?.message, data: body?.data }
}

function headersFor(auth) {
  const h = {
    authorization: `Bearer ${auth.jwt}`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MagicrewClient/1.0",
    accept: "application/json",
  }
  if (auth.org) h["organization-code"] = auth.org
  return h
}

/**
 * 返回 magpie 的 checkin 契约对象。
 *
 * outcome: claimed | done | ineligible | inactive | captcha | failed
 */
export async function runCheckin(auth) {
  const h = headersFor(auth)

  // 1) 先记下余额，用来核对「这次到底有没有到账」
  let before = null
  try {
    before = (await fetchPoints(auth.jwt, auth.org)).total
  } catch (e) {
    return { outcome: "failed", message: `读不到积分：${e?.message ?? e}` }
  }

  // 2) 试领每日积分
  let claimed = false
  let claimNote = ""
  let sawEndpoint = false

  for (const c of DAILY_CLAIM_CANDIDATES) {
    const r = await callJson(c.method, c.path, h)
    if (r.status === 404) continue // 这个接口不存在，试下一个
    sawEndpoint = true
    if (r.code === 1000) {
      claimed = true
      claimNote = `领取成功（${c.path}）`
    } else {
      claimNote = `接口存在但拒绝：${r.message || r.code}`
    }
    break
  }

  // 3) 看余额
  let after = before
  try {
    after = (await fetchPoints(auth.jwt, auth.org)).total
  } catch {}

  const gained = after - before

  // 4) 读最近流水，看有没有「每日登录奖励」这类入账
  let recent = []
  try {
    recent = await fetchPointRecords(auth.jwt, auth.org, { page: 1, pageSize: 5 })
  } catch {}

  const todayHit = recent.find(
    (r) =>
      /每日登录|签到|daily/i.test(String(r?.detail ?? r?.description ?? "")) &&
      Number(r?.change ?? r?.point_change ?? 0) > 0,
  )

  const parts = []
  if (gained > 0) parts.push(`积分 +${gained}（${before} → ${after}）`)
  else parts.push(`积分 ${after}（本次无变动）`)
  if (claimNote) parts.push(claimNote)
  if (todayHit) parts.push("今天已有登录奖励入账")

  // 5) 没找到任何领取接口 —— 说明每日奖励是登录自动发的，不是签到制
  if (!sawEndpoint) {
    return {
      outcome: gained > 0 || todayHit ? "claimed" : "inactive",
      credit: gained > 0 ? gained : undefined,
      message:
        `超级麦吉没有独立签到接口，每日积分随登录自动发放。${parts.join("；")}。` +
        `新手导览还有 ${GUIDE_TASKS.length} 项要在网页里各点 1~2 分钟（${GUIDE_TASKS.map((t) => t.label).join("、")}）。`,
    }
  }

  if (claimed || gained > 0) {
    return {
      outcome: "claimed",
      credit: gained > 0 ? gained : undefined,
      message: parts.join("；"),
    }
  }

  return {
    outcome: "done",
    message: parts.join("；"),
  }
}

export { GUIDE_TASKS, DAILY_CLAIM_CANDIDATES }
