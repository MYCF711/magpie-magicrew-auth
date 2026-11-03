// 出口指纹：api.mjs 的请求**不许伪装浏览器**，上游回 HTML 时也不许把整页塞进错误文案。
// 纯离线 —— fetch 全是桩，不碰网络。
//
//   node tests/upstream-ua.mjs
//
// 为什么这条要单独钉（2026-11-03 真机，见 CHANGELOG 0.3.71）：
//   国际站 magic-service.magicrew.ai 挂到阿里云 ESA 边缘之后，
//   **带浏览器 UA 的请求一律 405 + 一整页 HTML**，非浏览器 UA 才透到 Go 服务。
//   于是国内站全好、国际站全挂，用户看到的是额度卡片上
//   `暂时无法获取额度：<!doctype html><html lang="zh-cn">…`。
//   两件事都要锁：① UA 形态不许回退成 Mozilla/*；② HTML 错误页只归一成一句人话。

import assert from "node:assert/strict"
import {
  login,
  issueGatewayKey,
  refreshGatewayKey,
  fetchModels,
  fetchAllModels,
  fetchModelPoints,
  SITES,
} from "../src/api.mjs"

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

const ORIG_FETCH = globalThis.fetch
const calls = []

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })
}

/** 换掉 fetch：所有请求记进 calls，回放 payload */
function stub(payload) {
  calls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers ?? {} })
    return typeof payload === "function" ? payload(url, init) : payload
  }
}

const ESA_405 =
  '<!doctype html><html lang="zh-cn"><meta charset="utf-8">' +
  '<meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1">' +
  '<meta name="data-spm" content="a3c0e"><title>405</title>' +
  "<style>a,body,div,h2,html,p{margin:0}</style></head><body>405</body></html>"

const uaOf = (call) => call.headers["user-agent"] ?? call.headers["User-Agent"] ?? ""

console.log("UA —— 只报「我是谁」，不抄浏览器")

await checkAsync("登录 / 签 key / 续期 / 模型目录都带同一个非浏览器 UA", async () => {
  // 每个请求一份新 Response —— 同一个 Response 的 body 只能读一次
  stub((url) => {
    if (url.includes("/api/v1/flows/models")) return json({ code: 1000, data: { models: [{ value: "m1", label: "M1" }] } })
    if (url.includes("/v1/models")) return json({ data: [{ id: "m1" }] })
    if (url.includes("/api/v1/products/model-points")) return json({ code: 1000, data: [] })
    return json({
      code: 1000,
      data: { token: "jwt", organization_code: "org", api_key: "mgw_x", refresh_token: "rf" },
    })
  })
  await login({ phone: "13800000000", password: "x" })
  await issueGatewayKey("jwt", "org")
  await refreshGatewayKey("rf", SITES.cn.host)
  await fetchModels("jwt", "org")
  await fetchAllModels("mgw_x")
  await fetchModelPoints("jwt", "org", ["m"])

  assert.equal(calls.length, 6)
  for (const c of calls) {
    const ua = uaOf(c)
    assert.ok(ua, `${c.url} 没带 user-agent`)
    assert.doesNotMatch(ua, /^Mozilla\//i, `${c.url} 又在伪装浏览器：${ua}`)
    assert.equal(ua, "magpie-magicrew-auth")
  }
})

await checkAsync("国际站的续期也带这个 UA（405 就出在那一站）", async () => {
  stub(json({ code: 1000, data: { api_key: "mgw_y", refresh_token: "rf2" } }))
  await refreshGatewayKey("rf", SITES.intl.host)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.startsWith(SITES.intl.host))
  assert.equal(uaOf(calls[0]), "magpie-magicrew-auth")
})

console.log("\n上游回 HTML —— 只归一成一句人话，不外泄整页")

await checkAsync("405 + ESA 错误页 → 短句，不含 HTML，带状态码", async () => {
  stub(new Response(ESA_405, { status: 405, headers: { "content-type": "text/html; charset=utf-8" } }))
  await assert.rejects(
    () => refreshGatewayKey("rf", SITES.intl.host),
    (e) => {
      const msg = String(e.message)
      assert.doesNotMatch(msg, /</, `错误文案里还带着 HTML 标签：${msg.slice(0, 80)}`)
      assert.doesNotMatch(msg, /doctype/i)
      assert.match(msg, /HTML 错误页/)
      assert.match(msg, /HTTP 405/)
      assert.ok(msg.length < 80, `文案太长：${msg.length} 字`)
      assert.equal(e.status, 405, "status 要留住，调用方靠它分类")
      return true
    },
  )
})

await checkAsync("HTML 页的 title 与状态码重复时只说一次", async () => {
  stub(new Response(ESA_405, { status: 405, headers: { "content-type": "text/html" } }))
  await assert.rejects(
    () => refreshGatewayKey("rf", SITES.intl.host),
    (e) => {
      assert.doesNotMatch(e.message, /405）.*405/, "405 重复了两遍")
      assert.equal((e.message.match(/405/g) || []).length, 1)
      return true
    },
  )
})

await checkAsync("纯文本 405（Go 服务自己的 Allow 头）照旧原样透出", async () => {
  stub(new Response("Allow: POST, PUT", { status: 405, headers: { "content-type": "text/plain" } }))
  await assert.rejects(
    () => refreshGatewayKey("rf", SITES.cn.host),
    (e) => {
      assert.equal(e.message, "Allow: POST, PUT")
      assert.equal(e.status, 405)
      return true
    },
  )
})

await checkAsync("magic 业务码的错误文案一个字符都不动（33002 账号不存在）", async () => {
  stub(json({ code: 33002, message: "账号不存在", data: {} }))
  await assert.rejects(
    () => login({ phone: "13800000000", password: "x" }),
    (e) => {
      assert.equal(e.message, "账号不存在")
      assert.equal(e.code, 33002)
      return true
    },
  )
})

await checkAsync("空 body + 500 → 退回 HTTP 状态码", async () => {
  stub(new Response("", { status: 500 }))
  await assert.rejects(
    () => refreshGatewayKey("rf", SITES.cn.host),
    (e) => {
      assert.equal(e.message, "HTTP 500")
      return true
    },
  )
})

globalThis.fetch = ORIG_FETCH

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
