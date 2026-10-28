// 同一账号多把 key 逐把试 + 全部被拒改 402 + 续期收敛到 key-store —— 纯离线测试。
//
//   node tests/key-failover.mjs
//
// 钉住 0.3.29（PR #12）的四条线：
//   ① keyCandidates() 把 store 两槽 + magpie 的 auth.access 合成候选，按到期时间倒序
//   ② adoptKey() 把实测能用的那把写回 store（包括空 store 首次接管时的 refresh_token）
//   ③ renewViaStore() 走 store、与 ensureKey 共用 renewOnce 锁；store 的 refresh_token
//      可能已废（升级前 refresh.mjs 自己续过），必须能回退到 auth.refresh
//   ④ loader 只对「key 被拒」逐把重试；正常响应（哪怕正文里出现 unauthorized）绝不重发
//
// 为什么值得单独钉：0.3.29 之前 key 有两条签发路径，2026-10-29 实测 5 个国际站
// 账号里 3 个「静态挑一把」必踩空（方向还各不相同）。这不是概率问题，是结构问题。
// 同时这条链路很容易写成「见 200 就当成功」或「见 403 就重试所有」—— 前者漏掉
// HTTP 200 + code 403 的形态，后者会把模型的正常回复当成错误重发、重复计费。
//
// 全程隔离 HOME，不碰真实 key-store，不联网。

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── 隔离 HOME ───────────────────────────────────────────────────────────
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, fetch: globalThis.fetch }
const FAKE = mkdtempSync(join(tmpdir(), "magicrew-failover-"))
process.env.HOME = FAKE
process.env.USERPROFILE = FAKE
const CACHE = join(FAKE, ".cache", "magpie")
mkdirSync(CACHE, { recursive: true })

const { keyCandidates, adoptKey, renewViaStore, ensureKey } = await import("../src/keys.mjs")
const { makeRefresh } = await import("../src/hooks/refresh.mjs")
const { makeLoader } = await import("../src/hooks/loader.mjs")
const { siteCtx, SITES } = await import("../src/context.mjs")

const SITE = "magicrew"
const c = siteCtx(SITES.cn)
const K = (n) => `mgw_${String(n).repeat(30)}` // 必须通过 key-store 的 REAL_KEY 校验
const FAR = 4102444800000 // 2100-01-01，永远新鲜
const now = Date.now()

function seed(account, st) {
  writeFileSync(
    join(CACHE, `magicrew-key-${SITE}__${account}.json`),
    JSON.stringify(st),
  )
}
function dump(account) {
  return JSON.parse(readFileSync(join(CACHE, `magicrew-key-${SITE}__${account}.json`), "utf8"))
}
function cleanStore(account) {
  rmSync(join(CACHE, `magicrew-key-${SITE}__${account}.json`), { force: true })
}

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message.split("\n")[0]}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message.split("\n")[0]}`)
  }
}

// ═══ ① keyCandidates ═══════════════════════════════════════════════════
console.log("keyCandidates —— 同一账号的所有候选，按到期时间倒序")

await checkAsync("store 两槽 + auth.access → 三把，按 expiresAt 倒序", async () => {
  seed("cand1", {
    current: "a",
    refreshToken: "rt",
    keys: { a: { apiKey: K("a"), expiresAt: now + 1000 }, b: { apiKey: K("b"), expiresAt: now + 5000 } },
    at: "x",
  })
  const cands = await keyCandidates(c, { org: "cand1", access: K("c"), expires: now + 9000 })
  assert.deepEqual(cands.map((x) => x.apiKey.slice(4, 7)), ["ccc", "bbb", "aaa"])
})

await checkAsync("同一把 key 从两路拿到 → 去重并保留更晚的 expiresAt", async () => {
  seed("cand2", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: now + 1000 }, b: null },
    at: "x",
  })
  const cands = await keyCandidates(c, { org: "cand2", access: K("a"), expires: now + 9999 })
  assert.equal(cands.length, 1)
  assert.equal(cands[0].expiresAt, now + 9999)
})

await checkAsync("空 store + auth.access → 只有一把", async () => {
  seed("cand3", { current: "a", refreshToken: "", keys: { a: null, b: null }, at: "" })
  const cands = await keyCandidates(c, { org: "cand3", access: K("d"), expires: FAR })
  assert.deepEqual(cands.map((x) => x.apiKey.slice(4, 7)), ["ddd"])
})

await checkAsync("什么都没有 → []（loader 会抛未登录，不空跑）", async () => {
  seed("cand4", { current: "a", refreshToken: "", keys: { a: null, b: null }, at: "" })
  assert.deepEqual(await keyCandidates(c, { org: "cand4" }), [])
})

await checkAsync("不跨账号：另一个账号的槽不参与", async () => {
  seed("cand5", { current: "a", refreshToken: "", keys: { a: null, b: null }, at: "" })
  seed("other", { current: "a", refreshToken: "", keys: { a: { apiKey: K("o"), expiresAt: FAR }, b: null }, at: "" })
  assert.deepEqual(await keyCandidates(c, { org: "cand5" }), [])
})

// ═══ ② adoptKey ════════════════════════════════════════════════════════
console.log("\nadoptKey —— 命中的那把写回 store")

await check("命中另一槽 → 写进另一槽并切 current", () => {
  seed("adopt1", {
    current: "a",
    refreshToken: "rt-keep",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: null },
    at: "x",
  })
  adoptKey(c, { org: "adopt1", refresh: "rt-auth" }, K("b"), FAR)
  const st = dump("adopt1")
  assert.equal(st.current, "b")
  assert.equal(st.keys.b.apiKey, K("b"))
  assert.equal(st.refreshToken, "rt-keep")
})

await check("空 store 首次接管 → 保留 auth.refresh（否则 2 小时后没人能续）", () => {
  seed("adopt2", { current: "a", refreshToken: "", keys: { a: null, b: null }, at: "" })
  adoptKey(c, { org: "adopt2", refresh: "rt-from-auth" }, K("c"), FAR)
  const st = dump("adopt2")
  assert.equal(st.refreshToken, "rt-from-auth")
  assert.equal(st.keys.b.apiKey, K("c"))
})

await check("命中的就是 current → 不重写（保持原样）", () => {
  seed("adopt3", {
    current: "a",
    refreshToken: "rt-x",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: null },
    at: "x",
  })
  const before = readFileSync(join(CACHE, `magicrew-key-${SITE}__adopt3.json`), "utf8")
  adoptKey(c, { org: "adopt3" }, K("a"), FAR)
  const after = readFileSync(join(CACHE, `magicrew-key-${SITE}__adopt3.json`), "utf8")
  assert.equal(after, before)
})

// ═══ ③ renewViaStore ══════════════════════════════════════════════════
console.log("\nrenewViaStore —— 续期写回 store，两处 refresh_token 都试")

function mockRefresh({ deadTokens = [], onCall } = {}) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || "{}")
    const token = body.refresh_token
    if (onCall) onCall(token)
    if (deadTokens.includes(token)) {
      return new Response(JSON.stringify({ code: 4003, message: "invalid refresh_token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(
      JSON.stringify({
        code: 1000,
        data: { api_key: K("n"), refresh_token: "rt-new", api_key_expires_at: FAR },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
}

await checkAsync("store 的 refresh_token 有效 → 用它，写回新 key / 新 refresh", async () => {
  seed("ren1", {
    current: "a",
    refreshToken: "rt-store",
    keys: { a: { apiKey: K("a"), expiresAt: now - 1000 }, b: null },
    at: "x",
  })
  const used = []
  mockRefresh({ onCall: (t) => used.push(t) })
  const rec = await renewViaStore(c, { org: "ren1", refresh: "rt-auth" })
  assert.deepEqual(used, ["rt-store"])
  assert.equal(rec.apiKey, K("n"))
  assert.equal(rec.refreshToken, "rt-new")
  const st = dump("ren1")
  assert.equal(st.current, "b")
  assert.equal(st.keys.b.apiKey, K("n"))
  assert.equal(st.refreshToken, "rt-new")
})

await checkAsync("store 的 refresh_token 已废（升级前分叉）→ 回退 auth.refresh", async () => {
  seed("ren2", {
    current: "a",
    refreshToken: "rt-store-dead",
    keys: { a: { apiKey: K("a"), expiresAt: now - 1000 }, b: null },
    at: "x",
  })
  const used = []
  mockRefresh({ deadTokens: ["rt-store-dead"], onCall: (t) => used.push(t) })
  const rec = await renewViaStore(c, { org: "ren2", refresh: "rt-auth-live" })
  assert.deepEqual(used, ["rt-store-dead", "rt-auth-live"])
  assert.equal(rec.apiKey, K("n"))
  assert.equal(dump("ren2").refreshToken, "rt-new")
})

await checkAsync("store 没 refresh_token → 用 auth.refresh", async () => {
  seed("ren3", { current: "a", refreshToken: "", keys: { a: null, b: null }, at: "" })
  const used = []
  mockRefresh({ onCall: (t) => used.push(t) })
  await renewViaStore(c, { org: "ren3", refresh: "rt-auth-only" })
  assert.deepEqual(used, ["rt-auth-only"])
})

await checkAsync("两处都没有 → 抛「没有 refresh_token」", async () => {
  seed("ren4", { current: "a", refreshToken: "", keys: { a: null, b: null }, at: "" })
  mockRefresh()
  await assert.rejects(
    () => renewViaStore(c, { org: "ren4" }),
    /没有 refresh_token/,
  )
})

await checkAsync("两块都废 → 抛最后一个错误（不是「续期失败」吞掉原因）", async () => {
  seed("ren5", {
    current: "a",
    refreshToken: "rt-store-dead",
    keys: { a: { apiKey: K("a"), expiresAt: now - 1000 }, b: null },
    at: "x",
  })
  mockRefresh({ deadTokens: ["rt-store-dead", "rt-auth-dead"] })
  await assert.rejects(
    () => renewViaStore(c, { org: "ren5", refresh: "rt-auth-dead" }),
    /invalid refresh_token/,
  )
})

await checkAsync("与 ensureKey 并发 → 共用 renewOnce，只发一次 PUT", async () => {
  seed("ren6", {
    current: "a",
    refreshToken: "rt-concurrent",
    keys: { a: { apiKey: K("a"), expiresAt: now - 1000 }, b: null },
    at: "x",
  })
  const used = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || "{}")
    used.push(body.refresh_token)
    await new Promise((r) => setTimeout(r, 50))
    return new Response(
      JSON.stringify({ code: 1000, data: { api_key: K("z"), refresh_token: "rt-new", api_key_expires_at: FAR } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  await Promise.all([
    renewViaStore(c, { org: "ren6", refresh: "rt-concurrent" }),
    ensureKey(c, { org: "ren6", refresh: "rt-concurrent" }),
  ])
  assert.equal(used.length, 1)
})

// ═══ ④ makeRefresh ════════════════════════════════════════════════════
console.log("\nmakeRefresh —— 走 store；auth 没 refresh 也能续")

await checkAsync("auth.refresh 为空、store 有 → 仍然续期（旧实现会直接 return undefined）", async () => {
  seed("ref1", {
    current: "a",
    refreshToken: "rt-store",
    keys: { a: { apiKey: K("a"), expiresAt: now - 1000 }, b: null },
    at: "x",
  })
  mockRefresh()
  const out = await makeRefresh(c)({ org: "ref1" })
  assert.ok(out)
  assert.equal(out.access, K("n"))
  assert.equal(out.refresh, "rt-new")
})

await checkAsync("续期失败（invalid）→ 转成「登录已失效，请重新登录」", async () => {
  seed("ref2", {
    current: "a",
    refreshToken: "rt-dead",
    keys: { a: { apiKey: K("a"), expiresAt: now - 1000 }, b: null },
    at: "x",
  })
  mockRefresh({ deadTokens: ["rt-dead"] })
  await assert.rejects(
    () => makeRefresh(c)({ org: "ref2", refresh: "rt-dead" }),
    (e) => e.message === "登录已失效，请重新登录" && e.signIn === "expired",
  )
})

// ═══ ⑤ makeLoader.fetch 端到端 ════════════════════════════════════════
console.log("\nmakeLoader.fetch —— 逐把试 / 全挂 402 / 正常响应不重发")

/** 造一个只在 chat 路径上响应的 fetch mock。`handler(apiKey)` 返回 Response */
function mockChat(handler) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    const auth = String(init?.headers?.authorization || "")
    const key = auth.replace(/^Bearer /, "")
    seen.push(key)
    return handler(key)
  }
  return seen
}
const json200 = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })

function loaderFor(account, auth) {
  return makeLoader(c)(async () => ({ org: account, ...auth }))
}

await checkAsync("store 两把都死、auth.access 活 → 逐把试到最后一把，命中并写回 store", async () => {
  // 到期时间：a 最晚、b 次之、auth 最早 —— 正是「到期越晚越可能是活的那把」
  // 这条启发式失效的形态，用来钉住「不能只看第一把」。
  seed("load1", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: now + 5000 }, b: { apiKey: K("b"), expiresAt: now + 4000 } },
    at: "x",
  })
  const seen = mockChat((key) =>
    key === K("c") ? json200({ choices: [{ message: { content: "ok" } }] }) : json200({ code: 403, message: "token无效" }),
  )
  const loader = await loaderFor("load1", { access: K("c"), expires: now + 3000, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).choices[0].message.content, "ok")
  assert.deepEqual(seen.map((x) => x.slice(4, 7)), ["aaa", "bbb", "ccc"])
  assert.equal(dump("load1").current, "b")
  assert.equal(dump("load1").keys.b.apiKey, K("c"))
})

await checkAsync("全部被拒 → 402，body 说明本账号几把都挂", async () => {
  seed("load2", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: { apiKey: K("b"), expiresAt: FAR } },
    at: "x",
  })
  mockChat(() => json200({ code: 403, message: "token无效" }))
  const loader = await loaderFor("load2", { access: K("c"), expires: FAR, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res.status, 402)
  const body = await res.json()
  assert.equal(body.error.code, 402)
  assert.match(body.error.message, /3 把密钥均已被上游拒绝/)
  assert.match(body.error.message, /magpie 换下一个账号/)
})

await checkAsync("HTTP 403 → 也逐把试（不能只看 HTTP 200 JSON）", async () => {
  seed("load3", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: null },
    at: "x",
  })
  const seen = mockChat((key) =>
    key === K("b")
      ? json200({ choices: [{ message: { content: "ok" } }] })
      : new Response("forbidden", { status: 403 }),
  )
  const loader = await loaderFor("load3", { access: K("b"), expires: FAR, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 2)
})

await checkAsync("HTTP 200 + {\"error\":{\"code\":403}} → 也识别为 key 拒绝", async () => {
  seed("load4", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: null },
    at: "x",
  })
  const seen = mockChat((key) =>
    key === K("b")
      ? json200({ choices: [{ message: { content: "ok" } }] })
      : json200({ error: { code: 403, message: "token无效" } }),
  )
  const loader = await loaderFor("load4", { access: K("b"), expires: FAR, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 2)
})

await checkAsync("正常 200 回复正文里出现 unauthorized → 不重发、不误判", async () => {
  seed("load5", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: { apiKey: K("b"), expiresAt: FAR } },
    at: "x",
  })
  const seen = mockChat(() =>
    json200({ choices: [{ message: { content: "this request is unauthorized, see docs" } }] }),
  )
  const loader = await loaderFor("load5", { access: K("c"), expires: FAR, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.match((await res.json()).choices[0].message.content, /unauthorized/)
})

await checkAsync("正常 200 回复正文里出现 token无效 → 不重发", async () => {
  seed("load6", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: { apiKey: K("b"), expiresAt: FAR } },
    at: "x",
  })
  const seen = mockChat(() =>
    json200({ choices: [{ message: { content: "请检查 token无效 的原因" } }] }),
  )
  const loader = await loaderFor("load6", { access: K("c"), expires: FAR, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
})

await checkAsync("SSE 响应 → 不读流、不重试、原对象返回", async () => {
  seed("load7", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: null },
    at: "x",
  })
  const sse = new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const seen = mockChat(() => sse)
  const loader = await loaderFor("load7", { access: K("a"), expires: FAR, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res, sse) // 同一个对象，没有被 clone / 重建
  assert.equal(seen.length, 1)
})

await checkAsync("上游 500 → 不是 key 问题，原样返回不重试", async () => {
  seed("load8", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: { apiKey: K("b"), expiresAt: FAR } },
    at: "x",
  })
  const seen = mockChat(() => new Response("boom", { status: 500 }))
  const loader = await loaderFor("load8", { access: K("c"), expires: FAR, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res.status, 500)
  assert.equal(seen.length, 1)
})

await checkAsync("200 + {code:402, message:积分不足} 不在 key 拒绝里，交给 rewriteCreditRefusal 原样 400 逻辑", async () => {
  seed("load9", {
    current: "a",
    refreshToken: "",
    keys: { a: { apiKey: K("a"), expiresAt: FAR }, b: null },
    at: "x",
  })
  const seen = mockChat(() => json200({ code: 402, message: "nope" }))
  const loader = await loaderFor("load9", { access: K("a"), expires: FAR, refresh: "" })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
})

// ── 收尾 ───────────────────────────────────────────────────────────────
globalThis.fetch = ORIG.fetch
for (const k of ["HOME", "USERPROFILE"]) {
  if (ORIG[k] === undefined) delete process.env[k]
  else process.env[k] = ORIG[k]
}
rmSync(FAKE, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
