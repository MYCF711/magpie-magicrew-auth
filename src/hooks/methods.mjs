// ② auth.methods[] —— 登录
//
// 两条路，按可靠性排：
//
//   ① 浏览器登录（默认，零输入）：插件自己拉起一个能被 CDP 看进去的浏览器，
//      用户在官方页里用任何方式登，登录成功那一刻插件把 localStorage 读走。
//      拉不起来就降级成「magpie 开系统浏览器 + 用户粘一行 Console」。
//   ② 登录态（JWT + 组织码）：手填两个字段，兜底用。
//
// ⚠ 两条铁律：
//   · authorize() 必须立刻返回 —— 真正等用户的是 callback()，死等会和 magpie 互锁
//   · opened: true 的语义是「我自己已经开过页面了，你别再开」；
//     只返回 url 让它去开的，**不许**传 opened

import {
  issueGatewayKey,
  fetchPoints,
  fetchWho,
  fetchOwnInviteCode,
} from "../api.mjs"
import { inviteToUse, readSession, writeSession, noteLoginFailure, noteOrg, readKnownOrgs, rollInvite } from "../store.mjs"
import { readLocalCreds } from "../local-browser.mjs"
import { CLIP_HINT, clipboardText, parseCreds, pollClipboard } from "../clipboard.mjs"
import { readVisionModel } from "../vision.mjs"
import { finishSmsLogin, startSmsLogin } from "../headless.mjs"

/**
 * 账号刚加进来（登录成功）→ 一次性把「首次 AI 工作 / 首个对话」补掉。
 *
 * 不 await、不抛：建项目 + 发消息 + 兜底等结算最坏一分钟，登录必须立刻返回；
 * 失败也不该让登录报错。真正的兜底是签到 —— 两边共用同一道闸门
 * （`isAutoChatSettled`：每账号一次，永久），所以重复登录、刷新页面都不会重发。
 */
function kickoffFirstTask(c, jwt, org) {
  import("../tasks.mjs")
    .then((m) => m.ensureFirstTaskOnce({ jwt, org, host: c.host }))
    .catch(() => {})
}

/**
 * 登录拿到 jwt + org 之后的统一收尾。
 *
 * 无头登录和浏览器登录最后都落到这里，保证「验证一次 / 建 key / 落 session /
 * 记组织 / 滚邀请码 / 补首任务 / 取昵称」这一串只有一份实现。
 *
 * `orgs` 是候选组织列表（无头那条路拿不到「用户当前选中的组织」，只能猜）。
 * 按顺序用 `fetchPoints` 真验一遍，第一个验得过才算。
 *
 * ⚠ 别说这解决了「多组织选哪个」—— **它没解决，只是容错**：
 *   账号所属的任何一个组织都能通过 `fetchPoints`（只要 JWT 有效），
 *   所以「第一个验得过的」实际就是「列表第一个」。
 *   真正的区别在浏览器登录那条路：它直接读 localStorage 里用户**当前选中**的那个。
 *   服务端虽然给了 `is_current` 字段，但实测恒为 false（带不带 organization-code
 *   头都一样），不能拿来判断。⇒ 多组织账号在无头这条路上会落到列表第一个组织，
 *   这是已知限制，不是 bug。
 */
async function completeSignIn(c, jwt, org, orgs = []) {
  const candidates = [org, ...orgs.filter((o) => o && o !== org)]
  let lastErr = null
  let picked = null

  for (const o of candidates) {
    try {
      // 真的验一次：读积分能过，说明 JWT + 组织码都对
      await fetchPoints(jwt, o, c.host)
      picked = o
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!picked) throw lastErr ?? new Error("没有可用的组织码")

  const key = await issueGatewayKey(jwt, picked, c.host)
  writeSession(c.id, jwt, picked)
  noteOrg(c.id, picked)
  // 滚邀请码：把这个账号自己的码存成下一次用的
  await rollInvite(c.id, jwt, picked, c.host)
  kickoffFirstTask(c, jwt, picked)
  const who = await fetchWho(jwt, picked, c.host).catch(() => null)
  return {
    type: "success",
    access: key.apiKey,
    refresh: key.refreshToken,
    expires: Date.now() + 2 * 3600_000,
    accountId: who?.name || picked,
    uid: picked,
    jwt,
    org: picked,
  }
}

export function makeMethods(c) {
  return [
    {
      // 手机号 + 短信验证码，**不开浏览器**。
      //
      // 卡点从来不是协议，是那张「拖动滑块使图片角度为正」的图。现在的做法：
      // 用 magpie 设置里用户自己选的识图模型（settings.json 的 vision）
      // 判断「主体上方向指向钟面几点」，再换算成拖动角度 —— 实测 120° 的图判出 122°，
      // 而服务端容差 ±10°，够用。
      //
      // 没配识图模型时不在这里瞎猜（猜中概率只有 ~5.6%，会先撞「验证提交过于频繁」），
      // 而是让这条方法直接报错并指路 —— 详见下面那段说明。
      type: "oauth",
      label: `${c.SHORT} 手机号验证码`,
      prompts: [
        {
          type: "text",
          key: "phone",
          message: "手机号",
          placeholder: "13800138000",
          validate: (v) =>
            /^1\d{10}$/.test(String(v || "").replace(/[\s-]/g, "")) ? undefined : "11 位手机号，只要数字",
        },
      ],
      async authorize(inputs) {
        const phone = String(inputs?.phone || "").replace(/[\s-]/g, "")
        if (!/^1\d{10}$/.test(phone)) return { type: "failed", error: "手机号不完整" }

        const vision = readVisionModel()
        const masked = phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")

        if (!vision) {
          // 没有识图模型 → 回退到浏览器：打不开就不硬撑。
          //
          // 为什么不在这里瞎猜角度：容差 ±10° 意味着瞎猜命中率只有 ~5.6%（20/360），
          // 平均要试十几次，而服务端有「验证提交过于频繁」和「验证次数已超限」两道风控 ——
          // 等不到猜中，先被限流。所以老老实实让用户转那一下。
          let browser = null
          let why = ""
          try {
            browser = await import("../browser-login.mjs")
          } catch (e) {
            why = `浏览器登录模块加载失败：${String(e?.message ?? e).slice(0, 200)}`
            noteLoginFailure(c.id, why)
          }

          const inviteCode = inviteToUse(c.id)
          const url = inviteCode
            ? `${c.web}/login?invitation=${encodeURIComponent(inviteCode)}`
            : `${c.web}/login`
          const hostFragment = new URL(c.web).hostname

          const session = browser
            ? await browser.launchLoginBrowser(url).catch((e) => {
                why = String(e?.message ?? e).slice(0, 300)
                noteLoginFailure(c.id, `launch: ${why}`)
                return null
              })
            : null

          return {
            url,
            ...(session ? { opened: true } : {}),
            instructions: session
              ? `没有配置识图模型，那个「拖动滑块使图片角度为正」得你自己转一下 —— 已经用 ${session.name || "浏览器"} 打开了登录页。\n` +
                `在里面选「手机登录」，填 ${masked}，把图片转正、收到验证码后填进去；登录完成这个窗口会自动接上，不用回来点任何东西。\n` +
                `（想全自动的话：magpie 设置 → 识图模型，选一个能看图的，下次就只需要填手机号和验证码。）`
              : `没能自己拉起浏览器${why ? `（${why}）` : "（本机没找到 Chromium 内核浏览器）"}，已改用系统浏览器打开登录页。\n` +
                `登录完成后，在页面里按 F12 → Console 粘这一行：\n${CLIP_HINT}`,
            method: "auto",
            async callback() {
              let got = null
              if (session && browser) {
                got = await browser.waitForCreds(session, hostFragment).catch(() => null)
                await browser.closeSession(session).catch(() => {})
              }
              if (!got && !session) {
                got = await pollClipboard({ skip: "" }).catch(() => null)
              }
              if (!got) {
                return {
                  type: "failed",
                  error: session
                    ? "浏览器开着了，但 5 分钟内没在里面读到登录状态 —— 是还没登完，还是登的不是这个站点？"
                    : "5 分钟内没拿到登录状态。可以改用「登录态（JWT + 组织码）」那条备选。",
                }
              }
              try {
                if (!got.org) throw new Error("只拿到 JWT，没有组织码")
                return await completeSignIn(c, got.jwt, got.org)
              } catch (e) {
                return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
              }
            },
          }
        }

        // 邀请码两条路都要出现：登录页的 URL，以及最终注册时服务端读到的那份。
        // ⚠ 无头这条路**没有**「打开带邀请码的页面」这一步，所以邀请码只能靠
        //   `redirect` 传 —— 网页表单的初始值里 redirect 就是 window.location.href，
        //   服务端从它上面取 `?invitation=`。少了它，新注册的号就没有邀请关系。
        const inviteCode = inviteToUse(c.id)
        const loginUrl = inviteCode
          ? `${c.web}/login?invitation=${encodeURIComponent(inviteCode)}`
          : `${c.web}/login`

        // 发短信这一步最慢（过验证最多试 3 张图、每张问两遍模型）。
        // 但必须等它结束才能告诉用户「验证码已发出」—— 所以这里不甩到 callback 里。
        let sent
        try {
          sent = await startSmsLogin(c, { mobile: phone })
        } catch (e) {
          return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
        }

        return {
          url: loginUrl,
          instructions:
            `验证码已发送到 ${masked}。\n` +
            `旋转验证由识图模型（${vision}）自动通过，试了 ${sent.rounds} 张图。\n` +
            `把收到的 6 位验证码填进下面的框就行。`,
          method: "code",
          // ⚠ 必须是 true。这条链路**全在后台走完**，不需要任何浏览器；
          //   opened: false 会让 magpie 拿 url 去开**系统默认浏览器** —— 而那个浏览器里
          //   往往本来就登着这个站，用户看到的是已登录界面，根本进不了「添加新号」，
          //   还会以为插件把他登进了旧账号。这正是浏览器登录那条路修过的坑。
          opened: true,
          async callback(code) {
            const c0 = String(code || "").replace(/\D/g, "")
            if (c0.length < 4) return { type: "failed", error: "验证码是 4~8 位数字" }
            let creds
            try {
              creds = await finishSmsLogin(c, { mobile: phone, code: c0, redirect: loginUrl })
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
            }
            try {
              return await completeSignIn(c, creds.jwt, creds.org, creds.orgs)
            } catch (e) {
              return { type: "failed", error: `登录成功了，但换 key 失败：${String(e?.message ?? e).slice(0, 300)}` }
            }
          },
        }
      },
    },

    {
      type: "oauth",
      label: `${c.SHORT} 浏览器登录`,
      async authorize() {
        // 邀请码两条路都要出现：登录页的 URL，以及最终注册时服务端读到的那份
        const inviteCode = inviteToUse(c.id)
        const url = inviteCode
          ? `${c.web}/login?invitation=${encodeURIComponent(inviteCode)}`
          : `${c.web}/login`
        const hostFragment = new URL(c.web).hostname

        // ⓿ 本机浏览器里已经有这个站点的登录态 → 直接接上，不开窗口。
        //
        //   这是「有的人网页登录了、插件里却没多出账号」的正解：用户平时那个浏览器
        //   登录完，凭据就已经落在它的 localStorage 里了 —— 读文件就能拿到，
        //   不用再让他在这个窗口里重登一次。
        //
        //   ⚠ 只在这个账号**还没加过**时自动接：否则用户点登录是想加新账号，
        //     自动接上的会是同一个，magpie 侧（同 accountId + 同 uid）只会替换旧账号。
        const local = readLocalCreds(hostFragment)
        if (local && !readKnownOrgs(c.id).includes(local.org)) {
          return {
            url,
            opened: true, // 凭据来自本机浏览器，我们没开页面 —— 别让 magpie 再开一个
            instructions: `已从本机 ${local.browser} 读到 ${c.SHORT} 的登录态，正在验证…`,
            method: "auto",
            async callback() {
              let r
              try {
                // 请求放在 callback 里：authorize 必须立刻返回，而且没被调用时不该打网络
                await fetchPoints(local.jwt, local.org, c.host)
                r = await issueGatewayKey(local.jwt, local.org, c.host)
              } catch (e) {
                // 本机那把失效了：记进「加过」名单，下次点登录就走窗口
                noteOrg(c.id, local.org)
                return {
                  type: "failed",
                  error: `本机 ${local.browser} 里的登录态已失效（${String(e?.message ?? e)}）。再点一次登录会打开窗口；或者先去那个浏览器里重新登录。`,
                }
              }
              writeSession(c.id, local.jwt, local.org)
              noteOrg(c.id, local.org)
              // 等它落盘再返回：这条以前是 .catch(()=>{}) 发射后不管，
              // 一旦 host 进程在 callback 之后被回收，滚动就永远不生效
              await rollInvite(c.id, local.jwt, local.org, c.host)
              kickoffFirstTask(c, local.jwt, local.org)
              const who = await fetchWho(local.jwt, local.org, c.host).catch(() => null)
              return {
                type: "success",
                access: r.apiKey,
                refresh: r.refreshToken,
                expires: Date.now() + 2 * 3600_000,
                accountId: who?.name || local.org,
                uid: local.org,
                jwt: local.jwt,
                org: local.org,
              }
            },
          }
        }

        // 浏览器登录是**可选能力**，按需加载：这个模块用 child_process /
        // WebSocket / 端口探测，环境依赖最重。静态 import 一旦失败，
        // 整个插件都加载不起来 —— 连「登录态」那条备选也没了。
        let browser = null
        let why = ""
        try {
          browser = await import("../browser-login.mjs")
        } catch (e) {
          why = `浏览器登录模块加载失败：${String(e?.message ?? e).slice(0, 200)}`
          noteLoginFailure(c.id, why)
        }

        // ⚠ 启动失败的原因必须留下 —— 静默降级会让用户以为「本机没装 Chrome」
        const session = browser
          ? await browser.launchLoginBrowser(url).catch((e) => {
              why = String(e?.message ?? e).slice(0, 300)
              noteLoginFailure(c.id, `launch: ${why}`)
              return null
            })
          : null

        // 降级通道要用的「打开前剪贴板」（不 await：起 powershell 要几百毫秒）
        const skipPromise = session ? null : clipboardText()

        return {
          url,
          ...(session ? { opened: true } : {}),
          instructions: session
            ? `已用 ${session.name || "浏览器"} 打开官方登录页 —— 用你平时的方式登进去，这个窗口会自动继续，不用回来点任何东西。`
            : `没能自己拉起浏览器${why ? `（${why}）` : "（本机没找到 Chrome / Edge / 360 等 Chromium 内核浏览器）"}，已改用系统浏览器打开登录页。\n登录完成后，在页面里按 F12 → Console 粘这一行：\n${CLIP_HINT}`,
          method: "auto",
          async callback() {
            let got = null

            // ① 首选：从我们自己拉起来的浏览器里读
            if (session && browser) {
              got = await browser.waitForCreds(session, hostFragment).catch(() => null)
              // 拿到就关窗：先 Browser.close 让它把 cookie 刷到磁盘，
              // 关不掉再 taskkill 整棵进程树
              await browser.closeSession(session).catch(() => {})
            }

            // ② 降级：读剪贴板
            if (!got && skipPromise) {
              const skip = (await skipPromise).trim()
              got = await pollClipboard({ skip })
            }

            if (!got) {
              return {
                type: "failed",
                error: session
                  ? "浏览器开着了，但 5 分钟内没在里面读到登录状态 —— 是还没登完，还是登的不是这个站点？"
                  : "5 分钟内没拿到登录状态。可以改用「登录态（JWT + 组织码）」那条备选。",
              }
            }

            try {
              if (!got.org) throw new Error("只拿到 JWT，没有组织码")
              // 真的验一次：读积分能过，说明 JWT + 组织码都对
              await fetchPoints(got.jwt, got.org, c.host)
              const key = await issueGatewayKey(got.jwt, got.org, c.host)
              writeSession(c.id, got.jwt, got.org)
              noteOrg(c.id, got.org)
              // 滚邀请码：把这个账号自己的码存成下一次用的（等落盘再返回）
              await rollInvite(c.id, got.jwt, got.org, c.host)
              kickoffFirstTask(c, got.jwt, got.org)
              return {
                type: "success",
                access: key.apiKey,
                refresh: key.refreshToken,
                expires: Date.now() + 2 * 3600_000,
                // 卡片显示能认的名字（手机号 / 邮箱 / 昵称），不是随机组织码
                accountId: got.name || got.org,
                uid: got.org,
                jwt: got.jwt,
                org: got.org,
              }
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e) }
            }
          },
        }
      },
    },
    {
      // 兜底：直接从浏览器复制登录态。
      //
      // 两样都在 DevTools → Application → Local Storage → <站点域名>：
      //   MAGIC:user:authorization     → JSON，取 value   = JWT
      //   MAGIC:user:organizationCode  → JSON，取 value   = 组织码
      //
      // ⚠ 组织码**不能从 JWT 推**：JWT 里只有 cus.tenant_id（18 位数字），
      //   组织码是另一套短串。服务端按组织码查组织：
      //   缺了 → {"code":2182,"message":"用户所在组织不存在"}
      //   错了 → {"code":3035,"message":"登录失败"}
      type: "oauth",
      label: `${c.SHORT} 登录态（JWT + 组织码）`,
      prompts: [
        {
          type: "text",
          key: "jwt",
          message: "JWT（MAGIC:user:authorization 的 value）",
          placeholder: "eyJhbGciOi...",
          validate: (v) => (String(v || "").trim().startsWith("eyJ") ? undefined : "不是 JWT，要以 eyJ 开头"),
        },
        {
          type: "text",
          key: "org",
          message: "组织码（MAGIC:user:organizationCode 的 value）",
          placeholder: "orgcode67890",
          validate: (v) => (/^[a-z0-9]{6,32}$/i.test(String(v || "").trim()) ? undefined : "12 位左右的字母数字"),
        },
      ],
      async authorize(inputs) {
        const jwt = String(inputs?.jwt || "").trim().replace(/^Bearer\s+/i, "")
        const org = String(inputs?.org || "").trim()
        if (!jwt.startsWith("eyJ")) return { type: "failed", error: "不是 JWT" }
        if (!org) return { type: "failed", error: "没填组织码" }

        const result = (async () => {
          await fetchPoints(jwt, org, c.host)
          return issueGatewayKey(jwt, org, c.host)
        })()

        return {
          url: `${c.web}/login`,
          instructions: "正在验证登录态…",
          method: "auto",
          opened: false,
          async callback() {
            let r
            try {
              r = await result
            } catch (e) {
              return { type: "failed", error: String(e?.message ?? e) }
            }
            writeSession(c.id, jwt, org)
            noteOrg(c.id, org)
            await rollInvite(c.id, jwt, org, c.host)
            kickoffFirstTask(c, jwt, org)
            // 卡片上显示手机号/邮箱/昵称，取不到就退回组织码
            const who = await fetchWho(jwt, org, c.host).catch(() => null)
            return {
              type: "success",
              access: r.apiKey,
              refresh: r.refreshToken,
              expires: Date.now() + 2 * 3600_000,
              accountId: who?.name || org,
              uid: org,
              jwt,
              org,
            }
          },
        }
      },
    },
  ]
}
