// browser-channel 的静态断言 —— 不起浏览器、不碰网络。
//
// 这一层是「WAF 把 curl 也拦了」之后的最后兜底（0.3.74）。它有几个
// **一改就静默出错**的地方，全部钉在这里：
//
//   1. 不许加 `--disable-web-security` —— 它的"有效"是因为顺手不发 Origin，
//      正确做法是页面停在官网，让浏览器发它自己那套合法 Origin。
//   2. 页面 origin 必须映射到**官网**，不是 API 域（API 域 Origin 会被 WAF 403）。
//   3. 浏览器通道必须**惰性加载** —— 静态 import 会把整个插件加载拖死。
//   4. 不许碰 magpie 的 proxy、不许开监听端口（全局 proxy 一挂就是整个网关断网）。
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const src = readFileSync(new URL("../src/browser-channel.mjs", import.meta.url), "utf8")
const schannel = readFileSync(new URL("../src/schannel.mjs", import.meta.url), "utf8")

// ① 启动参数
const argsBlock = src.slice(src.indexOf("const BROWSER_ARGS"), src.indexOf("]", src.indexOf("const BROWSER_ARGS")))
assert.ok(!/disable-web-security/.test(argsBlock), "不许给浏览器加 --disable-web-security（根因是 Origin 头，不是同源策略）")
assert.ok(/--remote-debugging-port=0/.test(argsBlock), "CDP 端口必须由浏览器自己挑（=0），不许写死")
assert.ok(/--headless/.test(argsBlock), "必须无头 —— 不许弹窗口抢用户焦点")
assert.ok(/--user-data-dir/.test(src), "必须用临时 profile，不许复用用户自己的浏览器配置")

// ② 页面 origin 必须是官网
assert.ok(/PAGE_ORIGIN/.test(src), "必须有 API host → 官网 origin 的映射表")
assert.ok(/openapi\.letsmagic\.cn"\s*,\s*"https:\/\/www\.letsmagic\.cn/.test(src.replace(/\s+/g, " ")),
  "cn：当前在用的 API 域 openapi.letsmagic.cn 必须映射到 www.letsmagic.cn")
assert.ok(/i-magic-service\.letsmagic\.cn"\s*,\s*"https:\/\/www\.letsmagic\.cn/.test(src.replace(/\s+/g, " ")),
  "cn：回退域 i-magic-service.letsmagic.cn 也要留着映射（WAF 策略会回滚）")
assert.ok(/magic-service\.magicrew\.ai"\s*,\s*"https:\/\/www\.magicrew\.ai/.test(src.replace(/\s+/g, " ")),
  "intl：API 域必须映射到 www.magicrew.ai")

// ③ 安全边界：不许开端口、不许碰 proxy
assert.ok(!/createServer|\.listen\(/.test(src), "browser-channel 不许开监听端口（只做 fetch 的下游）")
assert.ok(!/settings\.json|config\/magpie\/settings|HTTPS_PROXY|HTTP_PROXY/.test(src),
  "browser-channel 不许碰 magpie 的 proxy / 全局代理环境变量")

// ④ schannel 里必须是惰性加载
assert.ok(/async function browserChannel/.test(schannel), "schannel 必须通过 browserChannel() 惰性加载")
assert.ok(!/^import\s*{[^}]*}\s*from\s*"\.\/browser-channel\.mjs"/m.test(schannel),
  "schannel 不许静态 import browser-channel —— 它坏掉不能连累插件加载")

// ⑤ 三层顺序：runtime fetch → curl → 浏览器（浏览器必须是最后一层）
const fsBody = schannel.slice(schannel.indexOf("export async function fetchWithFallback"), schannel.indexOf("// ═══", schannel.indexOf("export async function fetchWithFallback")))
const iCurl = fsBody.indexOf("curlFetch(")
const iBrowser = fsBody.indexOf("browserFetch(")
assert.ok(iCurl > 0 && iBrowser > iCurl, "fetchWithFallback：curl 必须在浏览器之前（curl 快得多）")

const ssBody = schannel.slice(schannel.indexOf("export async function fetchStreamWithFallback"))
const sCurl = ssBody.indexOf("curlStreamFetch(")
const sBrowser = ssBody.indexOf("browserStreamFetch(")
assert.ok(sCurl > 0 && sBrowser > sCurl, "fetchStreamWithFallback：curl 必须在浏览器之前")

// ⑥ 两条都必须「浏览器失败就退回原响应」，不许把 null 当结果
assert.ok(/return alt \?\? res/.test(fsBody), "fetchWithFallback：浏览器失败要退回 curl 的原响应")
assert.ok(/return alt \?\? res/.test(ssBody), "fetchStreamWithFallback：同上")

// ⑦ 流式那条必须是流 —— 不许 readAll 之类的缓冲
assert.ok(/ReadableStream/.test(src), "browserStreamFetch 必须基于 ReadableStream（SSE 不许缓冲）")
assert.ok(/getReader\(\)/.test(src), "页面里必须用 getReader() 逐块推，不许 r.text() 憋到最后")


// ⑧ 频次闸门（2026-11-04 02:13 真机事故：把 IP 打封了）
//    这一层必须自己限速，不能指望调用方克制。
assert.ok(/asyn?c? function passGate|async function passGate/.test(src), "必须有频次闸门 passGate")
assert.ok(/maxPerWindow:\s*\d+/.test(src), "闸门要有「每分钟上限」这个常数")
assert.ok(/minIntervalMs:\s*\d+/.test(src), "闸门要有「两次请求最小间隔」这个常数")
assert.ok(/banCooldownMs:\s*[\d_\s*]+/.test(src), "必须定义静默时长（撞到拦截页后要停多久）")

const nFetch = (src.match(/if \(!\(await passGate\(origin\)\)\) return null/g) || []).length
assert.equal(nFetch, 2, "两条出口（普通 + 流式）都必须过闸门，一条都不能漏")

assert.ok(/function looksLikeWafPage/.test(src), "必须能认出火山 WAF 拦截页")
assert.ok(/请求已被阻断|Web应用防火墙|事件编号/.test(src), "拦截页判据要含火山 WAF 的中文文案")
assert.ok((src.match(/noteWafBlock\(origin\)/g) || []).length >= 2, "认出拦截页后两条出口都要触发静默")
assert.ok(/export function gateStatus/.test(src), "要能查闸门状态（诊断用，不产生请求）")

// ⑨ 跨域拿不到 CORS 头时，status 读不到 —— catch 分支也必须计入闸门
//    实测（2026-11-04）：上游 403 时不带 access-control-allow-origin，
//    浏览器只抛 "Failed to fetch"，`looksLikeWafPage` 永远等不到 status。
assert.ok(/function noteMiss/.test(src), "必须有 noteMiss（连续失败计数）")
assert.ok(/function noteHit/.test(src), "必须有 noteHit（拿到正常响应就清零）")
assert.ok(/g\.misses\s*>=\s*3/.test(src), "连续 3 次拿不到响应当作被拦")
assert.ok((src.match(/noteMiss\(origin\)/g) || []).length >= 2, "两条出口的失败分支都要计入")
assert.ok((src.match(/noteHit\(origin\)/g) || []).length >= 2, "两条出口的成功分支都要清零")
assert.ok(/misses: g\.misses/.test(src), "gateStatus 要能看见连续失败计数")

// ⑩ 模型目录必须跳过浏览器层（magpie 给 0–2 秒，冷启动 10 秒必超时）
//    2026-11-04 实测日志：`provider.models: the plugin's model list didn't finish in 0s`
const schSrc = readFileSync(new URL("../src/schannel.mjs", import.meta.url), "utf8")
assert.ok(/fb\.skipBrowser/.test(schSrc), "fetchWithFallback 必须支持 skipBrowser")
const apiSrc = readFileSync(new URL("../src/api.mjs", import.meta.url), "utf8")
assert.ok(/fetchModels[\s\S]{0,400}skipBrowser: true/.test(apiSrc), "fetchModels 必须传 skipBrowser")
assert.ok(/fetchAllModels[\s\S]{0,500}skipBrowser: true/.test(apiSrc), "fetchAllModels 必须传 skipBrowser")

// ⑪ 卡死防线（2026-11-04「一签到就把 GO 侧锁堵死」事故）
//    magpie 调插件钩子时**持着 Go 侧的锁**，插件里任何一个 await 不回来，
//    那把锁就永远拿着 → 整个网关僵死，用户只能 taskkill。
//    判据：① checkin 钩子必须不注册；② CDP send 必须有超时；
//          ③ 浏览器通道外面必须有整体 deadline。
const idxSrc = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
assert.ok(/\/\/\s*checkin:\s*makeCheckin/.test(idxSrc), "index.mjs 里 checkin 必须是**注释掉**的")
assert.ok(!/^\s*checkin:\s*makeCheckin/m.test(idxSrc), "index.mjs 不许真的注册 checkin")
assert.ok(!/import \{ makeCheckin \}/.test(idxSrc), "不该再 import makeCheckin（导入了却不用会看着像漏注册）")

assert.ok(/const SEND_TIMEOUT_MS\s*=/.test(src), "CDP send 必须有超时常数")
assert.ok(/CDP \$\{method\} 超时/.test(src), "send 超时必须 reject 而不是永久挂起")
assert.ok(/BROWSER_DEADLINE_MS\s*=/.test(schSrc), "浏览器通道外面必须有整体 deadline")
const wrapped = (schSrc.match(/withDeadline\(chan\.browser/g) || []).length
assert.equal(wrapped, 2, "两条出口（普通 + 流式）都要套 withDeadline")

const autoSrc = readFileSync(new URL("../src/auto-maintenance.mjs", import.meta.url), "utf8")
assert.ok(/\[provider\]: false/.test(autoSrc), "ensureCheckinDefault 必须补 false，不是 true")

console.log("browser-channel: 41 条断言全过（闸门 14 + skipBrowser 3 + 卡死防线 8）")
