// ⑦ provider.models(provider, { auth }) —— 每账号的模型目录
//
// ⚠ 返回的是**这个账号真正能选**的模型，不是厂商标称的全部：
//   混进 VIP 锁定 / 生图 / embedding，用户选中就报错。
//
// 失败回退三种选一种：原样返回 provider.models / 抛异常 /
// 返回自己的列表并标 Symbol.for("magpie.fellBack")。
// ⚠ 局部成功时别标 fellBack —— magpie 会整份丢弃。
//
// 登录态失效 → 抛带 signIn: "expired" 的错误。

import { fetchModels, fetchModelPoints, isAuthRejection } from "../api.mjs"
import { modelEntry } from "../context.mjs"
import { readSnapshot, writeSnapshot } from "../store.mjs"

// 倍率系数：input_points / 2000 与网站实测值吻合
//   Qwen3.5 Flash  20   → 0.01  (网站 0.01) ✓
//   Qwen3.8 Flash  100  → 0.05  (网站 0.05) ✓
//   Qwen3.7 Plus   200  → 0.10  (网站 0.10) ✓
//   Qwen3.8 Max   1200  → 0.60  (网站 0.56)
const MULT_BASE = 2000

export function makeModels(c) {
  /**
   * 把「上游模型列表 + 计费表」折成 magpie 的模型目录。
   *
   * 抽成独立函数是**必须的**：缓存命中时要在后台线程里算出同样的结果，
   * 在 return 之后再走一遍，两处逻辑不能各写一份（会分叉）。
   */
  function buildOut(live, points) {
    const pointsOk = Object.keys(points).length > 0
    const out = {}
    for (const m of live) {
      // VIP / 锁定的模型不列 —— 选中会报错，插件注释里那条铁律
      // （语言模型这批实测 tags 全是 `Magic`，没有 VIP；VIP 只出现在
      //  网站的「生图模型 / 视频模型」里，那两个接口不在本插件范围内）
      const locked = (m.tags || []).some((t) => /vip|lock|pay|premium/i.test(String(t?.value ?? "")))
      if (locked) continue

      const p = points[m.id] || {}
      // 三分支 —— 按 HOOKS.md 十一之二：`free` 的判据是「花不花这份订阅的
      // 额度」，**不能从 rate 反推**（实测 rate===0 的 51 条里，38 条是
      // 「套餐内不按次计费」，照样吃配额；标成免费会让 Free first 一直派到它们身上）。
      //
      //   input_points > 0   → 有倍率，free 不设
      //   input_points === 0 → 厂商声明免费 → free: true，且不给 rate
      //   input_points 缺失  → 价格未知 → 不列（不猜，也不谎标免费）
      //
      // 「已知」要挡住空串与非数字：`Number("") === 0` 会把没填的价格当成免费。
      const raw = p.inputPoints
      const known = raw != null && String(raw).trim() !== "" && Number.isFinite(Number(raw))
      const isFree = known && Number(raw) === 0
      // 计费接口整体成功、但这条没价格 → 不列。
      // 不填 rate 就不会画倍率胶囊（正确），但也别让它出现在列表里 ——
      // 用户选了不知道花多少。接口整体失败时不过滤，免得列表空掉。
      if (pointsOk && !known) continue

      // name 保持干净，倍率走 magpie 自己的 `rate` 字段 → 渲染成灰色胶囊，
      // 免费走 `free` → 进 Free first 那一档（codearts 的 modelOf 认的就是这两个）。
      out[m.id] = modelEntry(c, m.id, m.name, m.vision, {
        rate: known ? Number(raw) / MULT_BASE : 0,
        free: isFree,
      })
    }
    return out
  }

  /** 拉一次线上目录并落快照；任何失败都返回 null（调用方自己决定回退） */
  async function refresh(auth) {
    const live = await fetchModels(auth.jwt, auth.org, c.host).catch(() => null)
    if (!live?.length) return null
    const points = await fetchModelPoints(auth.jwt, auth.org, live.map((m) => m.id), c.host).catch(() => ({}))
    const out = buildOut(live, points)
    if (Object.keys(out).length) writeSnapshot(c.id, out)
    return out
  }

  return async (provider, { auth } = {}) => {
    const snapshot = readSnapshot(c.id)
    if (!auth) return snapshot ?? {}

    // ⚠⚠⚠ 有快照就**立刻**用快照，网络刷新放后台 —— 这一跳必须做到**零网络**。
    //
    // 为什么不能靠「超时兜底」：Bun 在 Windows 上的 DNS 解析是**同步阻塞**的。
    // 冷缓存下 `await fetch(...)` 要 7 秒，而这 7 秒里 `setTimeout(1200)`
    // **根本触发不了**（事件循环被占住）—— Promise.race 的超时分支形同虚设。
    // 实测（2026-11-04）：加了 1.2 秒闸之后，这条钩子仍然要 **3.1 秒**才返回。
    //
    // 而 magpie 调 provider.models 时是**同步等着**的（预算 0–2 秒），等不到就
    // 打一条 `the plugin's model list didn't finish in 0s`。既然快照本来就在，
    // 没有任何理由让它等 —— 有快照就直接交，0ms。
    if (snapshot && Object.keys(snapshot).length) {
      // 后台刷新：结果落盘，下一次（或重启后）就是新的。
      // 不 await、不让异常冒到外面 —— 这条链挂了不能影响本次返回。
      refresh(auth).catch(() => {})
      return snapshot
    }

    // 从没成功拉过（新装）→ 这一跳只能等。但只等这一次，成功之后就有快照了。
    try {
      const out = await refresh(auth)
      return out ?? {}
    } catch (e) {
      // 判据见 api.mjs 的 isAuthRejection：WAF 的空 403 / HTML 405 **不算**登录失效。
      if (isAuthRejection(e)) {
        throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
      }
      return {}
    }
  }
}
