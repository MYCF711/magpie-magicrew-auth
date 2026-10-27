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

export function makeMethods(c) {
  return [
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
            ? "浏览器已打开官方登录页 —— 用你平时的方式登进去，这个窗口会自动继续，不用回来点任何东西。"
            : `没能自己拉起浏览器${why ? `（${why}）` : "（本机没找到 Chrome / Edge）"}，已改用系统浏览器打开登录页。\n登录完成后，在页面里按 F12 → Console 粘这一行：\n${CLIP_HINT}`,
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
    // ── 体检 ────────────────────────────────────────────────────────
    //
    // 借「登录方式」这个位置挂一个**只读**检查：点一下，把本机该站点所有账号的
    // 首任务状态、邀请人数、奖励明细一次列出来。不输入、不改任何状态。
    //
    // 为什么需要：邀请奖励不是注册即得，条件是「被邀请人完成首个任务或对话」
    // （见 api.mjs 的 fetchInviteRewards 注释）。号一多就分不清哪个小号还没跑、
    // 哪笔钱卡在什么状态 —— 这个按钮就是回答那两个问题的。
    //
    // ⚠ 用 throw 而不是返回 success：这不是登录，不该在账号列表里留下一条记录。
    //   magpie 会把错误信息原样显示出来，正好当报告用。
    {
      type: "oauth",
      label: `${c.SHORT}: 体检（首任务 / 邀请奖励）`,
      async authorize() {
        const { buildReport } = await import("../inspect.mjs")
        throw new Error(await buildReport({ siteId: c.id === "magicrew-intl" ? "intl" : "cn" }))
      },
    },
  ]
}
