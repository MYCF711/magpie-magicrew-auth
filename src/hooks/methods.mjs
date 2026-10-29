// ② auth.methods[] —— 登录
//
// 四条路，按可靠性排：
//
//   ① 手机号验证码（零浏览器）：识图模型过旋转验证 → 发短信 → 用户填码。
//   ② 邮箱验证码：同一条链，只有标识字段和两个端点不同（见下面 makeCodeMethod）。
//   ③ 浏览器登录（默认零输入）：插件自己拉起一个能被 CDP 看进去的浏览器，
//      用户在官方页里用任何方式登，登录成功那一刻插件把 localStorage 读走。
//      拉不起来就降级成「magpie 开系统浏览器 + 用户粘一行 Console」。
//   ④ 登录态（JWT + 组织码）：手填两个字段，兜底用。
//
// ⚠ 三条铁律：
//   · authorize() 必须立刻返回 —— 真正等用户的是 callback()，死等会和 magpie 互锁
//   · opened: true 的语义是「我自己已经开过页面了，你别再开」；
//     只返回 url 让它去开的，**不许**传 opened
//   · authorize() 里失败只能抛异常，**不能** return { type: "failed" } ——
//     magpie 把它的返回值当「登录流程对象」，会去调 `.callback()`，于是崩在一句
//     `callback is not a function` 上（实测触发路径：callback 失败 → 用户点「重试」
//     → 重新调 authorize → 又走到失败分支 → 崩）
//
// ⚠ 数组顺序 = magpie 登录方式列表里的顺序，所以**按站点分**：
//   国际站（magicrew-intl）邮箱在前 —— 那边用户大多是邮箱注册的；
//   国内站手机号在前。

import {
  issueGatewayKey,
  fetchPoints,
  fetchWho,
  fetchOwnInviteCode,
} from "../api.mjs"
import {
  inviteToUse,
  liveOrgs,
  preferredOrg,
  readAccountCodes,
  writeInvitePolicy,
  readSession,
  writeSession,
  noteLoginFailure,
  noteOrg,
  readKnownOrgs,
  rollInvite,
  readInvitePolicy,
} from "../store.mjs"
import { readLocalCreds } from "../local-browser.mjs"
import { CLIP_HINT, clipboardText, parseCreds, pollClipboard } from "../clipboard.mjs"
import { readVisionModel } from "../vision.mjs"
import {
  bindOrganization,
  createFirstOrganization,
  fetchOrgs,
  finishCodeLogin,
  orgProbeCodes,
  startCodeLogin,
} from "../headless.mjs"

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
 * 后两个参数只影响**卡片上显示的名字**，但选错会让同一个号在两条登录路上
 * 算出不同的 accountId，magpie 就把同一个号加成两条（真机踩过）。三档优先级：
 *
 *   preferredAccountId → who.name（服务端给的手机号/邮箱/昵称）→ fallbackAccountId → 组织码
 *
 *   · 手机号验证码那条传 preferred —— 服务端只回打码号（`189****051`），
 *     得由我们自己把它固定成同一个字符串，两条路才一致
 *   · 邮箱验证码那条传 fallback —— 邮箱不需要打码；who 成功时优先用 who，
 *     这样和浏览器登录那条路算出来的是同一个
 *
 * ⚠ 别说这解决了「多组织选哪个」—— **它没解决，只是容错**：
 *   账号所属的任何一个组织都能通过 `fetchPoints`（只要 JWT 有效），
 *   所以「第一个验得过的」实际就是「列表第一个」。
 *   真正的区别在浏览器登录那条路：它直接读 localStorage 里用户**当前选中**的那个。
 *   服务端虽然给了 `is_current` 字段，但实测恒为 false（带不带 organization-code
 *   头都一样），不能拿来判断。⇒ 多组织账号在无头这条路上会落到列表第一个组织，
 *   这是已知限制，不是 bug。
 */
async function completeSignIn(c, jwt, org, orgs = [], preferredAccountId = null, fallbackAccountId = null) {
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

  // 浏览器登录那条路可能拿到一把「用户中心已登录、Magic 里没用户」的令牌
  // （localStorage 里的 organizationCode 是空的）。和 finishCodeLogin 一样：
  // 重新探测一次组织列表；仍为空且 auth/status 回过 3102 才建首个组织。
  // ⚠ 只在 **3102** 时建 —— 别的失败（网络抖动 / token 过期）绝不能顺手建组织。
  if (!picked) {
    const found = await fetchOrgs(c, jwt).catch(() => [])
    const more = [...found]
    if (!more.length && orgProbeCodes().some((x) => x.code === 3102)) {
      try {
        const made = await createFirstOrganization(c, jwt, inviteToUse(c.id))
        if (made.org) {
          const bound = await bindOrganization(c, jwt, made.org)
          more.push(...(bound.length ? bound : []), made.org)
        }
      } catch (e) {
        lastErr = e
      }
    }
    for (const o of [...new Set(more)]) {
      try {
        await fetchPoints(jwt, o, c.host)
        picked = o
        break
      } catch (e) {
        lastErr = e
      }
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

  // ⚠ `accountId` 决定 magpie 是「替换」还是「新增」—— 同一个账号在两条登录路上
  //   必须算出同一个字符串，否则就会出现「同一个号被加了两遍」。
  //
  //   真机踩过：浏览器登录拿到的是打码手机号 `189****051`（fetchWho 成功，
  //   服务端只给打码号）；无头那条路 fetchWho 挂了（438 字符的 access_token
  //   配 Bearer 头不通），于是兜底用了组织码 `h97gkbu8bruj` ⇒ 两条并存。
  const accountId = preferredAccountId || who?.name || fallbackAccountId || picked
  return {
    type: "success",
    access: key.apiKey,
    refresh: key.refreshToken,
    expires: Date.now() + 2 * 3600_000,
    accountId,
    uid: picked,
    jwt,
    org: picked,
  }
}

/** 邮箱的粗校验。别搬 RFC 那个怪物正则 —— 服务端还会再验一次 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * 「验证码登录」——手机号与邮箱共用一份实现。
 *
 * 两条链的协议**完全一样**：取图 → 识图判角度 → 过旋转验证 → 发码 → 用户填码 →
 * 换登录态。差异只有三处，而且都已收敛进 captcha.mjs / headless.mjs 按 ident 分派：
 *
 *   · 问用户要什么：11 位手机号 / 邮箱
 *   · 发码端点：`/v4/user/send-sms` / `/v4/user/send-email`
 *   · 换登录态：`/v4/user/login`（验证码字段叫 `code`）/
 *              `/v4/user/login-email`（字段叫 `captcha`）
 *
 * 所以这里只写一份、传 kind。哪天被复制成两份，下次改超时或改文案必然只改一份。
 *
 * 卡点从来不是协议，是那张「拖动滑块使图片角度为正」的图：用 magpie 设置里用户
 * 自己选的识图模型（settings.json 的 vision）判「主体上方向指向钟面几点」，再换算
 * 成拖动角度 —— 实测 120° 的图判出 122°，而服务端容差 ±10°，够用。
 *
 * 没配识图模型时**不在这里瞎猜**（猜中概率只有 ~5.6%，会先撞「验证提交过于频繁」），
 * 而是回退到浏览器登录，让用户自己转那一下。
 *
 * @param {object} c     站点闭包（id / SHORT / web / host）
 * @param {"mobile"|"email"} kind
 */
/** org 已不在 magpie 的账号文件里（= 账号被删）；文件读不到时按「不知道」处理 */
function orgDead(c, org) {
  if (!org) return false
  const live = liveOrgs(c.id)
  return Boolean(live && live.size && !live.has(org))
}

function makeCodeMethod(c, kind) {
  const isEmail = kind === "email"
  const what = isEmail ? "邮箱" : "手机号"
  /** 官方登录页上那个 tab 的名字 —— 回退到浏览器时要说清楚点哪个 */
  const tab = isEmail ? "邮箱登录（Email）" : "手机登录（Phone）"

  /** 用户填的那一项 → 之后每个请求都要带的标识字段 */
  const identOf = (inputs) =>
    isEmail
      ? { email: String(inputs?.email || "").trim() }
      : { mobile: String(inputs?.phone || "").replace(/[\s-]/g, ""), stateCode: "+86" }

  /**
   * 给用户看的那个标识。
   * 手机号打码（服务端自己也是这么回的），邮箱原样 —— 邮箱没有打码这回事，
   * 而且它正好是浏览器登录那条路上 `who.name` 会给出的字符串。
   */
  const displayOf = (ident) =>
    isEmail ? ident.email : String(ident.mobile).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")

  const looksInvalid = (ident) => (isEmail ? !EMAIL_RE.test(ident.email) : !/^1\d{10}$/.test(ident.mobile))

  return {
    type: "oauth",
    label: `${c.SHORT} ${what}验证码${inviteTag(c)}`,
    prompts: [
      isEmail
        ? {
            type: "text",
            key: "email",
            message: "邮箱",
            placeholder: "you@example.com",
            validate: (v) =>
              EMAIL_RE.test(String(v || "").trim()) ? undefined : "填一个完整邮箱，例如 you@example.com",
          }
        : {
            type: "text",
            key: "phone",
            message: "手机号",
            placeholder: "13800138000",
            validate: (v) =>
              /^1\d{10}$/.test(String(v || "").replace(/[\s-]/g, "")) ? undefined : "11 位手机号，只要数字",
          },
    ],
    async authorize(inputs) {
      const ident = identOf(inputs)
      // ⚠ 这里是 authorize，失败只能抛异常，不能返回 { type: "failed" }（见文件头铁律）
      if (looksInvalid(ident)) throw new Error(`${what}不完整`)

      const shown = displayOf(ident)

      // 邀请码两条路都要出现：登录页的 URL，以及最终注册时服务端读到的那份。
      // ⚠ 无头这条路**没有**「打开带邀请码的页面」这一步，所以邀请码只能靠
      //   `redirect` 传 —— 网页表单的初始值里 redirect 就是 window.location.href，
      //   服务端从它上面取 `?invitation=`。少了它，新注册的号就没有邀请关系。
      const inviteCode = inviteToUse(c.id)
      const loginUrl = inviteCode
        ? `${c.web}/login?invitation=${encodeURIComponent(inviteCode)}`
        : `${c.web}/login`

      /**
       * 需要过图、但用户没配识图模型 → 回退到浏览器，让他自己转那一下。
       *
       * ⚠ 只有**这个号还没注册**时才该走到这里：已注册的号服务端根本不发旋转图，
       *   `startCodeLogin` 会直接发码（见 headless.mjs 里那段说明）。
       *
       * 为什么不在这里瞎猜角度：容差 ±10° 意味着瞎猜命中率只有 ~5.6%（20/360），
       * 平均要试十几次，而服务端有「验证提交过于频繁」和「验证次数已超限」两道风控 ——
       * 等不到猜中，先被限流。所以老老实实让用户转那一下。
       */
      async function browserFallback() {
        const url = loginUrl
        const hostFragment = new URL(c.web).hostname
        let browser = null
        let why = ""
        try {
          browser = await import("../browser-login.mjs")
        } catch (e) {
          why = `浏览器登录模块加载失败：${String(e?.message ?? e).slice(0, 200)}`
          noteLoginFailure(c.id, why)
        }

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
              `在里面选「${tab}」，填 ${shown}，把图片转正、收到验证码后填进去；登录完成这个窗口会自动接上，不用回来点任何东西。\n` +
              `（想全自动的话：magpie 设置 → 识图模型，选一个能看图的，下次就只需要填${what}和验证码。）`
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

      // 发码这一步最慢（要给新号过验证时最多试 4 张图、每张问两遍模型）。
      // 但必须等它结束才能告诉用户「验证码已发出」—— 所以这里不甩到 callback 里。
      let sent
      try {
        sent = await startCodeLogin(c, ident)
      } catch (e) {
        if (e?.code === "no-vision-model") {
          // ⚡ 只有这一种情况才回退到浏览器：这个号**还没注册**（服务端给了旋转图），
          //    而用户没配识图模型。已注册的号走不到这里 —— 服务端不出图。
          return browserFallback()
        }
        // 其余一律抛：authorize 里 return failed 会让 magpie 崩在 `.callback()`
        throw new Error(String(e?.message ?? e).slice(0, 500))
      }

      return {
        url: loginUrl,
        instructions: sent.skippedCaptcha
          ? `验证码已发送到 ${shown}。\n` +
            `这个号服务端那边已经注册过，旋转验证直接放行 —— 这一环跳过了，识图模型这次也用不上。\n` +
            `把收到的 6 位验证码填进下面的框就行。`
          : `验证码已发送到 ${shown}。\n` +
            `旋转验证由识图模型（${readVisionModel()}）自动通过，试了 ${sent.rounds} 张图。\n` +
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
            creds = await finishCodeLogin(c, { ...ident, code: c0, redirect: loginUrl, inviteCode })
          } catch (e) {
            return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
          }
          try {
            // 手机号：把打码号钉成 accountId（浏览器登录那条路拿到的也是这个字符串）；
            // 邮箱：优先让 who 决定（那才是浏览器登录会给出的一致值），who 挂了才退回邮箱
            return await completeSignIn(
              c,
              creds.jwt,
              creds.org,
              creds.orgs,
              isEmail ? null : shown,
              isEmail ? ident.email : null,
            )
          } catch (e) {
            return { type: "failed", error: `登录成功了，但换 key 失败：${String(e?.message ?? e).slice(0, 300)}` }
          }
        },
      }
    },
  }
}

/**
 * 面板标题后缀 —— 让「当前挂在谁名下」在选登录方式那一屏就能看见。
 * （那张面板只能显示 methods 的 label，插件没有别的可写位置。）
 *
 * ⚠ 值在插件加载时算一次；改完设置要重启 magpie 才会刷新标题。
 *   设置本身是立即生效的，标题只是个提示。
 */
function inviteTag(c) {
  const pol = readInvitePolicy(c.id)
  if ((pol.mode === "fixed" || pol.mode === "custom") && pol.code && !orgDead(c, pol.org)) {
    return `（上级 ${pol.accountId || pol.code}）`
  }
  return ""
}


// ═══ 邀请码：登录页一个按钮 + 一个数字文本框 ═══════════════════════
//
// 用户要的是「一个文本框就够」：
//   0 / 留空 / 非法文本 = 自动（首次用作者码，之后跟随最后登录/签到的滚动码）
//   1 = 当前首选账号（magpie 账号页「首选」那个）的邀请码
// 没有列表、没有 1..N —— 想换首选就在 magpie 账号页切首选，再点这个按钮。
//
// 0 的自动不需要在这里算：store.inviteToUse 的 auto 分支就是
// readInvite(site) || AUTHOR_INVITE。1 每次点开时读 logins.json 的 first。

function preferredInvite(c) {
  const org = preferredOrg(c.id)
  if (!org) return null
  const v = readAccountCodes(c.id)[org]
  if (!v?.code) return null
  return {
    code: v.code,
    label: String(v.accountId || org),
    org,
    accountId: String(v.accountId || org),
  }
}

function modeHint(c) {
  const pol = readInvitePolicy(c.id)
  // 只有两种模式：自动 / 首选。fixed 就是「上次保存的首选快照」，
  // 不再另叫「固定」—— 首选项后来变了也还是「首选」，输入 0 即可回自动。
  if (pol.mode === "auto" || !pol.code) return "当前模式：自动，输入 1 切换：首选"
  return "当前模式：首选，输入 0 切换：自动"
}

function invitePrompt(c) {
  return { type: "text", key: "invite", message: "邀请码", placeholder: modeHint(c) }
}

function saveInviteChoice(c, raw) {
  const n = String(raw ?? "").trim() === "" ? 0 : Number(String(raw).trim())
  if (n === 1) {
    const pick = preferredInvite(c)
    if (pick) {
      writeInvitePolicy(c.id, {
        mode: "fixed",
        code: pick.code,
        org: pick.org,
        accountId: pick.accountId,
      })
      return
    }
  }
  writeInvitePolicy(c.id, { mode: "auto" })
}

export function makeMethods(c) {
  // 顺序 = magpie 登录方式列表里的顺序。
  //
  // ⚠ **邮箱验证码只有国际站有**，国内站不给。实测两件事：
  //   ① www.letsmagic.cn/login 的登录方式只有 微信 / 苹果 / 密码 / 手机 / 私有部署，
  //      **没有邮箱**（国际站 www.magicrew.ai/login 才有 `switch-to-email`）；
  //   ② 同一个发信请求，国内站 `/v4/user/send-email` 回 `2000 服务异常，请联系管理员`，
  //      国际站回 `1000 请求成功`。
  //   国内站既然没有邮箱入口，也就不存在邮箱注册的账号 —— 把这条方法摆出来，
  //   只会让用户填完邮箱撞一个看不懂的错。
  const mobileMethod = makeCodeMethod(c, "mobile")
  // 国际站的邮箱方法只建一次：登录方式列表要用，末尾的「邀请码」入口也要用。
  // 建两份的话，下次改文案 / 超时必然只改一处 —— 同一个「只写一份」的理由，
  // 见 makeCodeMethod 头上那段。
  const emailMethod = c.id === "magicrew-intl" ? makeCodeMethod(c, "email") : null
  const codeMethods = emailMethod ? [emailMethod, mobileMethod] : [mobileMethod]

  // 「邀请码」入口保存完策略后接哪条验证码登录 —— **跟站点主登录方式一致**：
  //   国际站 → 邮箱（那边用户大多是邮箱注册的）
  //   国内站 → 手机号（国内站没有邮箱方法）
  //
  // ⚠ 0.3.43 之前这里写死 `mobileMethod`：国际站点「邀请码」→ 保存 → 被问手机号，
  //   等于把这个入口从「给新号带邀请码」带偏成「只有手机号能注册」。
  //   手机号验证码本身仍然独立存在，国际站想用手机号登录直接点那一条。
  const primaryMethod = emailMethod ?? mobileMethod
  const primaryKey = emailMethod ? "email" : "phone"

  return [
    ...codeMethods,

    {
      type: "oauth",
      label: `${c.SHORT} 浏览器登录${inviteTag(c)}`,
      async authorize(inputs) {
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
        // 同一条规矩：authorize 里失败只抛异常，不返回 { type: "failed" }
        if (!jwt.startsWith("eyJ")) throw new Error("不是 JWT")
        if (!org) throw new Error("没填组织码")

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

    // ── 邀请码：一个数字框；保存后接**本站主验证码方式** ─────────────
    //
    // 0/留空 = 自动（首次作者码，之后滚动最新号）；1 = 当前首选账号。
    // 保存写在这条验证码登录**之前**：接下来无论走哪条登录，注册时读到的都是这个模式。
    //
    // ⚠ 不写死手机号：国际站接邮箱（primaryMethod），国内站接手机号。
    //   站点分叉只在这一个变量上，别在 ask / authorize 里再抄一遍条件。
    {
      type: "oauth",
      label: `${c.SHORT} 邀请码`,
      get prompts() {
        return [invitePrompt(c)]
      },
      async ask(inputs) {
        if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, "invite")) return invitePrompt(c)
        if (!Object.prototype.hasOwnProperty.call(inputs, primaryKey)) return primaryMethod.prompts[0]
        return null
      },
      async authorize(inputs) {
        saveInviteChoice(c, inputs?.invite)
        return await primaryMethod.authorize(inputs)
      },
    },
  ]
}
