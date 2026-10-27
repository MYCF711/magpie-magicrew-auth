// 模型上下文窗口 —— 向 magpie 自己的模型库查
//
// ═══ 为什么不能自己填一个值 ═══════════════════════════════════════════
//
// magicrew 的两个模型接口**都不返回上下文窗口**：
//   GET /api/v1/flows/models  → value / label / vision / tags / configs
//   GET /v1/models            → id / object / created_at / owner_by
//
// 早前这里一律填 256_000 当保守值，后果是反的：
// `pi-ai detected context overflow for model "magicrew/deepseek-v4.1-flash"`
// —— agent 拿 256K 判断"放不下了"，而实际窗口是 1M，白砍掉四分之三。
//
// magpie 自己有一份模型库（`~/.cache/magpie/models.json`，按厂商分组，
// 每条带 `limit.context`），它本来就随 magpie 更新。**向它查，不要自己编。**
//
// 查不到才退回保守值 —— 宁可保守，不要给出超过真实窗口的数（那会让 agent
// 以为还有余量，请求超了上游才报错）。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 查不到时的兜底 */
const FALLBACK_CONTEXT = 256_000

let cache = null
let cacheAt = 0

/** models.json 5-6MB，读一次缓存住；10 分钟内不重复读 */
const CACHE_MS = 10 * 60_000

function loadLibrary() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache
  const idx = new Map()
  try {
    const raw = readFileSync(join(homedir(), ".cache", "magpie", "models.json"), "utf8")
    const walk = (o) => {
      if (Array.isArray(o)) {
        for (const v of o) walk(v)
        return
      }
      if (!o || typeof o !== "object") return
      const id = typeof o.id === "string" ? o.id : ""
      const ctx = o.limit?.context ?? o.context_length ?? o.context_window
      if (id && Number(ctx) > 0) {
        idx.set(id.toLowerCase(), Number(ctx))
        // 同一个模型可能挂在多个厂商下（deepseek-ai/x、Pro/deepseek-ai/x …），
        // 只保留最大值 —— 那才是它真能收的
        const tail = id.toLowerCase().split("/").pop()
        if (tail) {
          const prev = idx.get(`~${tail}`) || 0
          if (Number(ctx) > prev) idx.set(`~${tail}`, Number(ctx))
        }
      }
      for (const v of Object.values(o)) walk(v)
    }
    walk(JSON.parse(raw))
  } catch {}
  cache = idx
  cacheAt = Date.now()
  return idx
}

/**
 * 这个模型的上下文窗口。
 * @param {string} modelId  插件侧的模型 id，如 `deepseek-v4.1-flash`
 * @returns {number} 字节按 token 计；查不到给保守值
 */
export function contextOf(modelId) {
  const id = String(modelId || "").toLowerCase()
  if (!id) return FALLBACK_CONTEXT
  const idx = loadLibrary()

  // ① 全名命中（插件 id 恰好等于库里的 id）
  if (idx.has(id)) return idx.get(id)

  // ② 尾段命中：库里的 `deepseek-ai/deepseek-v4.1-flash` ↔ 我们的 `deepseek-v4.1-flash`
  if (idx.has(`~${id}`)) return idx.get(`~${id}`)

  // ③ 同一个模型挂在不同厂商前缀下，取最大的那个（真能收的容量）
  let best = 0
  for (const [k, v] of idx) {
    if (k.startsWith("~")) continue
    if (k.endsWith(`/${id}`) && v > best) best = v
  }
  return best || FALLBACK_CONTEXT
}

export const _internal = { FALLBACK_CONTEXT, loadLibrary }
