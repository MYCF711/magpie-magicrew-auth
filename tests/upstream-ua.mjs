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
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  login,
  issueGatewayKey,
  refreshGatewayKey,
  fetchModels,
  fetchAllModels,
  fetchModelPoints,
  SITES,
  UA,
  originFor,
} from "../src/api.mjs"
import { findProjectId } from "../src/chat-task.mjs"
import { bindOrganization, fetchOrgs } from "../src/headless.mjs"

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
const originOf = (call) => call.headers.origin ?? call.headers.Origin ?? ""

console.log("UA / Origin —— 两站 WAF 的已验证通行组合")

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
    assert.equal(ua, "curl/8.0")
    assert.equal(originOf(c), SITES.cn.web, `${c.url} 国内 Origin 必须是官网`)
  }
})

await checkAsync("国际站的续期也带这个 UA（405 就出在那一站）", async () => {
  stub(json({ code: 1000, data: { api_key: "mgw_y", refresh_token: "rf2" } }))
  await refreshGatewayKey("rf", SITES.intl.host)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.startsWith(SITES.intl.host))
  assert.equal(uaOf(calls[0]), "curl/8.0")
  assert.equal(originOf(calls[0]), "", "国际站带任何 Origin 都会被 ESA 405")
})

await checkAsync("Origin 映射：国内官网、国际省略，绝不取 API host", async () => {
  assert.equal(originFor(SITES.cn.host), SITES.cn.web)
  assert.equal(originFor(SITES.intl.host), "")
  stub((url) =>
    url.includes("/v1/models")
      ? json({ data: [{ id: "m1" }] })
      : json({ code: 1000, data: { token: "jwt", organization_code: "org" } }),
  )
  await login({ phone: "13800000000", password: "x", host: SITES.intl.host })
  await fetchAllModels("mgw_x", SITES.intl.host)
  assert.equal(calls.length, 2)
  for (const c of calls) {
    assert.equal(uaOf(c), UA)
    assert.equal(originOf(c), "", `${c.url} 国际站不应带 Origin`)
  }
})

await checkAsync("首任务与组织探测也按站点带 UA / Origin", async () => {
  for (const site of [SITES.cn, SITES.intl]) {
    stub((url) => {
      if (String(url).includes("/projects/participated")) return json({ code: 1000, data: { list: [] } })
      return json({ code: 1000, data: [{ magic_organization_code: "abc123" }] })
    })
    // fetchOrgs 的 login-data 要把组织列表包在 auth_status 里；bindOrganization 直接吃数组。
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET", headers: init.headers ?? {} })
      if (String(url).includes("/projects/participated")) return json({ code: 1000, data: { list: [] } })
      if (String(url).includes("/aggregation/login-data")) {
        return json({ code: 1000, data: { auth_status: [{ magic_organization_code: "abc123" }] } })
      }
      return json({ code: 1000, data: [{ magic_organization_code: "abc123" }] })
    }
    await findProjectId("jwt", "org", site.host, "workspace")
    await fetchOrgs(site, "jwt")
    await bindOrganization(site, "jwt", "abc123")
    assert.equal(calls.length, 3)
    for (const c of calls) {
      assert.equal(uaOf(c), UA, `${c.url} 漏了共享 UA`)
      assert.equal(originOf(c), originFor(site.host), `${c.url} Origin 不符合站点规则`)
      assert.notEqual(originOf(c), site.host, `${c.url} 还在用 API host 当 Origin`)
    }
    globalThis.fetch = originalFetch
  }
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

await checkAsync("国内 WAF 的空 body + 403 → 保留状态码，不伪造成业务错误", async () => {
  stub(new Response("", { status: 403 }))
  await assert.rejects(
    () => refreshGatewayKey("rf", SITES.cn.host),
    (e) => {
      assert.equal(e.message, "HTTP 403")
      assert.equal(e.status, 403)
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

// ── 聊天路径（auth.loader 的 fetch 包装）也不许漏 UA ────────────────────────
//
// 上面钉的是 api.mjs 自己发的那几路：登录 / 刷新 / 额度 / 模型目录。
// 真正跑对话的是 auth.loader 返回的 fetch —— 它**重新构造** headers，再把宿主
// 传来的头逐条 pass-through（`user-agent` 被跳过）。漏了那一行，请求就带着
// bun 的默认 UA `Bun/1.4.4` 出去：同一台机器、同一个 token，额度读得到、
// 聊天 405。这是 #30 报的第二处，只修 api.mjs 会「额度好了、对话还是挂」。
const loaderSrc = readFileSync(new URL("../src/hooks/loader.mjs", import.meta.url), "utf8")
const apiSrc = readFileSync(new URL("../src/api.mjs", import.meta.url), "utf8")

check("api.mjs 导出的 UA 是两站实测共同可通行值", () => {
  const m = apiSrc.match(/export const UA = "([^"]+)"/)
  assert.ok(m, "api.mjs 没有导出 UA 常量")
  assert.equal(m[1], "curl/8.0")
  assert.doesNotMatch(m[1], /^Mozilla\/|^Bun\/|magpie-magicrew-auth/)
})

check("loader 从 api.mjs 取 UA，不另写一份", () => {
  assert.match(loaderSrc, /import\s*\{[^}]*\bUA\b[^}]*\}\s*from\s*"\.\.\/api\.mjs"/)
})

check("loader 的 fetch 包装显式带 user-agent", () => {
  const i = loaderSrc.indexOf("async fetch(input, init)")
  assert.ok(i > 0, "找不到 loader 的 fetch 包装")
  const block = loaderSrc.slice(i, i + 2000)
  assert.ok(block.includes('"user-agent": UA'), "fetch 包装的 headers 里没有 user-agent")
  assert.ok(
    block.includes('"authorization", "host", "content-length", "user-agent", "origin"'),
    "pass-through 的跳过名单变了：客户端 UA / Origin 可能盖掉我们的",
  )
})

check("loader 里不再留旧的 MagicrewClient/1.0", () => {
  assert.ok(!loaderSrc.includes("MagicrewClient/1.0"), "loader 顶层 headers 还写着 MagicrewClient/1.0")
})

check("WebSocket 首任务握手也显式带共享 UA", () => {
  const src = readFileSync(new URL("../src/chat-task.mjs", import.meta.url), "utf8")
  const i = src.indexOf("async function openSocket")
  assert.ok(i > 0)
  assert.ok(src.slice(i, i + 700).includes('"User-Agent": UA'))
})

// 动态拦最终出站 headers：错误 UA / Origin / authorization 都不许从客户端漏进去。
const ORIG_HOME = process.env.HOME
const ORIG_USERPROFILE = process.env.USERPROFILE
const FAKE_HOME = mkdtempSync(join(tmpdir(), "magicrew-ua-"))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
mkdirSync(join(FAKE_HOME, ".cache", "magpie"), { recursive: true })
const { makeLoader } = await import("../src/hooks/loader.mjs")
const { siteCtx } = await import("../src/context.mjs")

await checkAsync("loader 两站最终出站头：UA 固定、Origin 按站点、鉴权不被覆盖", async () => {
  for (const site of [SITES.cn, SITES.intl]) {
    const key = `mgw_${"x".repeat(30)}`
    stub(() => json({ choices: [{ message: { content: "ok" } }] }))
    const loader = await makeLoader(siteCtx(site))(async () => ({
      org: "acc1",
      access: key,
      refresh: "",
      expires: Date.now() + 3_600_000,
      jwt: "x".repeat(350),
    }))
    assert.equal(loader.headers["user-agent"], UA)
    assert.equal(loader.headers.origin ?? "", originFor(site.host))
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "user-agent": "Bun/1.4.4",
        origin: site.host,
        authorization: "Bearer client-must-not-win",
      },
      body: JSON.stringify({ model: "m1" }),
    })
    assert.equal(res.status, 200)
    assert.equal(calls.length, 1)
    const h = calls[0].headers
    assert.equal(uaOf(calls[0]), UA)
    assert.equal(originOf(calls[0]), originFor(site.host))
    assert.equal(h.authorization, `Bearer ${key}`)
    assert.equal(h["organization-code"] ?? "", site.id === SITES.intl.id ? "acc1" : "")
    await res.text()
  }
})

if (ORIG_HOME === undefined) delete process.env.HOME
else process.env.HOME = ORIG_HOME
if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE
else process.env.USERPROFILE = ORIG_USERPROFILE
rmSync(FAKE_HOME, { recursive: true, force: true })

globalThis.fetch = ORIG_FETCH

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
