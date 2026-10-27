// 把第 8 项（first_ai_work，100 分）也做掉
//
// 为什么这一项不能像其他 7 项那样 PUT：
//   PUT /api/v1/onboarding/tasks/first_ai_work/completion
//   → {"code":9303,"message":"该新人引导任务不支持手动完成"}
//
// 服务端认的是「真的跑完过一次 AI 任务」，发消息走 socket 不是 REST，
// 所以只能让浏览器替我们发一条。这个脚本就干这一件事。

import { connect, waitFor } from "./cdp.mjs"

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : d
}
const PORT = String(arg("port", "9222"))
const URL_HINT = String(arg("url", "letsmagic"))
const TEXT = String(arg("text", "用一句话介绍你自己"))
const DRY = Boolean(arg("dry", false))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const endpoint = `http://127.0.0.1:${PORT}`
console.log(`连接 ${endpoint} …`)
const cdp = await connect(endpoint, { urlIncludes: URL_HINT })
console.log(`页面：${cdp.target.url}`)

// 找输入框：这个产品用的是 contenteditable 的富文本编辑器
const findBox = `
(() => {
  const sels = ['[contenteditable="true"]', 'textarea', '[role="textbox"]'];
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 80 && r.height > 20; };
  for (const s of sels) {
    const els = [...document.querySelectorAll(s)].filter(vis);
    if (els.length) {
      const el = els[els.length - 1]; // 取最后一个，通常是最上面的主输入框
      const r = el.getBoundingClientRect();
      return { ok: true, tag: el.tagName, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), placeholder: el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '' };
    }
  }
  return { ok: false };
})()
`

const box = await cdp.eval(findBox)
console.log("输入框：", JSON.stringify(box))
if (!box.ok) {
  console.log("找不到输入框。先把页面切到「对话」再跑。")
  cdp.close()
  process.exit(1)
}
if (DRY) {
  cdp.close()
  process.exit(0)
}

// 点进去
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 })
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 })
await sleep(300)

// 输入（insertText 对 contenteditable 有效，不受输入法影响）
await cdp.send("Input.insertText", { text: TEXT })
await sleep(400)
console.log(`已输入：${TEXT}`)

// 回车
for (const type of ["keyDown", "keyUp"]) {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
    text: type === "keyDown" ? "\r" : undefined,
  })
}
console.log("已回车，等任务跑起来…")

// 看页面有没有进入「任务处理中」并且最终出结果
let sawWork = false
for (let i = 0; i < 60; i++) {
  const st = await cdp.eval(`(() => {
    const t = document.body.innerText || '';
    return {
      sending: /停止|生成中|思考中|处理中|running|thinking/i.test(t),
      len: t.length,
    };
  })()`)
  if (st.sending) sawWork = true
  if (sawWork && !st.sending && i > 3) break
  await sleep(2000)
}
console.log(sawWork ? "看见任务跑了" : "没看见任务状态（可能已经延迟结算）")

console.log("\n现在核对（等 10 秒让服务端结算）：")
await sleep(10_000)
console.log("  node tools/points.mjs")
console.log("  node tools/onboarding-status.mjs   # 看 first_ai_work 是否 COMPLETED")

cdp.close()
