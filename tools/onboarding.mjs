// 新手福利八项自动化
//
// ═══════════════════════════════════════════════════════════════════════
// 要解决的是什么
// ═══════════════════════════════════════════════════════════════════════
//
// 超级麦吉的「新手福利」是 8 项导览任务，合计 500 积分：
//
//   workbench        了解工作台            4 步
//   first-ai-work    完成第一次 AI 工作    10 步   ← 唯一能纯 HTTP 做的
//   create-ai-ppt    了解如何使用 AI PPT   4 步
//   audio-recording  AI 录音              7 步
//   hire-employee    雇佣数字员工          5 步
//   manage-skill     添加/管理技能         7 步
//   create-micro-app 微应用                3 步
//   super-lobster    超级龙虾              3 步
//
// 步骤定义就在前端包里（`var Lfe={workbench:{key:...steps:[...]}}`），
// 每步只是「高亮一个元素 + 点下一步」，没有服务端请求。
// 奖励是后端**自动发**的 —— 导览走完，积分自己进账（流水里叫「新人引导任务奖励」）。
//
// ⇒ 所以自动化的本质是：把 43 次「下一步」在真实浏览器里点完。
//
// ═══════════════════════════════════════════════════════════════════════
// 怎么用
// ═══════════════════════════════════════════════════════════════════════
//
// 1. 让浏览器/客户端开调试端口：
//      客户端（Electron）: Magic.exe --remote-debugging-port=9222
//      Chrome          : chrome.exe --remote-debugging-port=9222
// 2. 在这个浏览器里登录好超级麦吉 / MagiCrew
// 3. node tools/onboarding.mjs --port 9222
//
// 可选：
//   --url letsmagic     只操作 URL 含 letsmagic 的页面（多标签时用）
//   --dry               只探测页面和按钮，不点任何东西
//   --only first-ai-work 只跑一项
//   --slow              每步多等一会儿（网络慢的时候）
//
// ⚠ 它会真的点按钮。第一次建议先 --dry，看清找到的是什么再跑。

import { connect } from "./cdp.mjs"

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : dflt
}
const PORT = String(arg("port", "9222"))
const URL_HINT = String(arg("url", ""))
const DRY = Boolean(arg("dry", false))
const SLOW = Boolean(arg("slow", false))
const ONLY = arg("only", "")

// ── 8 项任务 ─────────────────────────────────────────────────────────
//
// start:  任务卡上的按钮文案
// finish: 导览最后一屏的按钮文案（中英都列，因为国际版是英文）
const TASKS = [
  {
    code: "workbench",
    label: "了解工作台",
    start: ["开始体验", "Start", "Replay", "回看"],
    steps: 4,
  },
  {
    code: "first-ai-work",
    label: "完成第一次 AI 工作",
    start: ["开始体验", "Start"],
    steps: 10,
  },
  {
    code: "create-ai-ppt",
    label: "了解如何使用 AI PPT",
    start: ["开始体验", "Start"],
    steps: 4,
  },
  {
    code: "audio-recording",
    label: "了解 AI 录音完成流程",
    start: ["开始体验", "Start"],
    steps: 7,
  },
  {
    code: "hire-employee",
    label: "了解如何雇佣数字员工",
    start: ["开始体验", "Start"],
    steps: 5,
  },
  {
    code: "manage-skill",
    label: "了解如何添加/管理技能",
    start: ["开始体验", "Start"],
    steps: 7,
  },
  {
    code: "create-micro-app",
    label: "了解微应用创建流程",
    start: ["开始体验", "Start"],
    steps: 3,
  },
  {
    code: "super-lobster",
    label: "了解超级龙虾如何使用",
    start: ["开始体验", "Start"],
    steps: 3,
  },
]

// ── 页面侧的查询函数（注入到页面里跑）─────────────────────────────────

const HELPERS = `
window.__mw = window.__mw || {};

// 可见且可点
window.__mw.visible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
  return true;
};

// 按文本找元素。exactFirst=true 时先找完全相等的，再退到包含匹配。
window.__mw.byText = (texts, opts) => {
  const { selector = 'button,[role="button"],a,div,span,li', exactFirst = true, maxDepth = 99 } = opts || {};
  const all = [...document.querySelectorAll(selector)];
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const cands = all.filter((el) => {
    const t = norm(el.innerText);
    if (!t || t.length > 80) return false;
    if (!window.__mw.visible(el)) return false;
    // 元素里不能再有同样文本的可点子元素（否则点到容器）
    return ![...el.children].some((c) => norm(c.innerText) === t && window.__mw.visible(c));
  });
  for (const pass of exactFirst ? ['exact', 'includes'] : ['includes']) {
    for (const el of cands) {
      const t = norm(el.innerText);
      const hit = texts.some((x) => (pass === 'exact' ? t === x : t.includes(x)));
      if (hit) return el;
    }
  }
  return null;
};

// 点它
window.__mw.click = (el) => {
  if (!el) return false;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
};

// 页面上所有可见按钮的文案（调试用）
window.__mw.buttonTexts = () => {
  const set = new Set();
  for (const el of document.querySelectorAll('button,[role="button"],a')) {
    if (!window.__mw.visible(el)) continue;
    const t = String(el.innerText || '').replace(/\\s+/g,' ').trim();
    if (t && t.length <= 40) set.add(t);
  }
  return [...set];
};
`

// 导览的「下一步 / 结束」按钮文案
const NEXT_TEXTS = ["下一步", "Next"]
const FINISH_TEXTS = [
  "完成导览，领取",
  "完成导览",
  "结束导览",
  "完成回看",
  "Finish",
  "Done",
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pace = () => sleep(SLOW ? 1200 : 450)

async function pageEval(cdp, expr) {
  await cdp.eval(HELPERS)
  return cdp.eval(expr)
}

async function clickText(cdp, texts, opts = {}) {
  const found = await pageEval(
    cdp,
    `(() => { const el = window.__mw.byText(${JSON.stringify(texts)}, ${JSON.stringify(opts)}); if (!el) return false; window.__mw.click(el); return window.__mw.byText(${JSON.stringify(texts)}, ${JSON.stringify(opts)}) !== null; })()`,
  )
  return !!found
}

/** 打开「新手福利」面板 */
async function openWelfare(cdp) {
  const opened = await clickText(cdp, ["新手福利", "Newcomer", "Beginner", "Welcome bonus"], { exactFirst: false })
  if (opened) await pace()
  return opened
}

/** 跑完一个导览：反复点下一步，直到点不动 */
async function runTour(cdp, task) {
  let next = 0
  let finished = false
  let lastBtn = ""

  for (let i = 0; i < 40; i++) {
    // 先看有没有终点按钮
    const fin = await clickText(cdp, FINISH_TEXTS, { exactFirst: false })
    if (fin) {
      finished = true
      await pace()
      break
    }
    const nx = await clickText(cdp, NEXT_TEXTS, { exactFirst: false })
    if (!nx) {
      // 没有下一步也没有终点 —— 可能导览已关闭
      break
    }
    next++
    await pace()
  }

  return { next, finished }
}

async function tryTask(cdp, task) {
  const log = []
  log.push(`开始 ${task.code}`)

  if (!(await openWelfare(cdp))) {
    log.push("  找不到「新手福利」入口，跳过")
    return { code: task.code, ok: false, log }
  }

  // 面板里点这个任务的「开始体验」。
  // 任务标题和按钮不在同一个节点上，所以先按标题定位卡片，再在卡片里找按钮。
  const clicked = await pageEval(
    cdp,
    `(() => {
      const norm = (s) => String(s||'').replace(/\\s+/g,' ').trim();
      const title = ${JSON.stringify(task.label)};
      const starts = ${JSON.stringify(task.start)};
      const cards = [...document.querySelectorAll('div,li,section')].filter((el) => {
        const t = norm(el.innerText);
        return t.includes(title) && t.length < 400 && window.__mw.visible(el);
      });
      // 取最内层那张卡
      const card = cards.sort((a,b) => a.innerText.length - b.innerText.length)[0];
      const scope = card || document;
      const btn = [...scope.querySelectorAll('button,[role="button"],a,div,span')].find((el) => {
        const t = norm(el.innerText);
        return starts.some((s) => t === s || t.includes(s)) && window.__mw.visible(el);
      });
      if (!btn) return false;
      window.__mw.click(btn);
      return true;
    })()`,
  )

  if (!clicked) {
    log.push(`  面板里找不到「开始体验」（任务：${task.label}）`)
    return { code: task.code, ok: false, log }
  }

  await pace()
  const tour = await runTour(cdp, task)
  log.push(`  导览：点了 ${tour.next} 次下一步，${tour.finished ? "已点完成" : "未见完成按钮"}`)

  return { code: task.code, ok: tour.finished || tour.next > 0, log, tour }
}

// ── main ─────────────────────────────────────────────────────────────

const endpoint = `http://127.0.0.1:${PORT}`
console.log(`连接 ${endpoint} …`)
const cdp = await connect(endpoint, { urlIncludes: URL_HINT })
console.log(`页面：${cdp.target.url}`)

await cdp.eval(HELPERS)

if (DRY) {
  const info = await cdp.eval(`({
    url: location.href,
    title: document.title,
    buttons: window.__mw.buttonTexts(),
    welfare: !!window.__mw.byText(["新手福利","Newcomer","Beginner","Welcome bonus"], { exactFirst: false }),
  })`)
  console.log(JSON.stringify(info, null, 2))
  cdp.close()
  process.exit(0)
}

const todo = ONLY ? TASKS.filter((t) => t.code === String(ONLY)) : TASKS
const results = []

for (const task of todo) {
  try {
    results.push(await tryTask(cdp, task))
  } catch (e) {
    results.push({ code: task.code, ok: false, log: [`异常：${e?.message ?? e}`] })
  }
  await sleep(1200)
}

console.log("\n=== 结果 ===")
for (const r of results) {
  console.log(`${r.ok ? "✅" : "❌"} ${r.code}`)
  for (const line of r.log) console.log(line)
}

const okCount = results.filter((r) => r.ok).length
console.log(`\n${okCount}/${results.length} 项走完`)
console.log("积分到账核对：node tools/points.mjs --port " + PORT + "   （或直接看页面右上角的积分）")

cdp.close()
