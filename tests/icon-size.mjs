// 图标尺寸 —— 卡片上那两个 128×128 必须「内容满格」且四角透明
//
//   node tests/icon-size.mjs
//
// 判据（0.3.70，主人 2026-10-31 报「国际服图标还是很小很小」）：
//   ① 两个 data URI 都是 **解码得出** 的 128×128 RGBA PNG（不是看字符串长度猜的）；
//   ② 内容的 alpha bbox 要铺满画面 —— 国际站必须是 (0,0,128,128)；
//      国内站是 (0,3,128,125)，同样要求宽高都 ≥ 90%（它不是纯圆，上下各差 3px）；
//   ③ 四角 alpha 必须是 0 —— 黑底/实心方块的四角在卡片上会顶出黑边，主人挑过。
//
// 为什么要自己解 PNG：本仓库零依赖、CI 只有 node；`node:zlib` 足够解 8-bit RGBA
// 非隔行的 PNG（IHDR + IDAT + 五种 filter），不需要装 sharp/pngjs。

import assert from "node:assert/strict"
import { inflateSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const SRC = fileURLToPath(new URL("../src/icons.mjs", import.meta.url))

// ═══ 极简 PNG 解码（只支持 8-bit RGBA、非隔行 —— 我们自己生成的图就是这个格式）═══
function decodePng(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) assert.equal(buf[i], SIG[i], "不是 PNG（签名不对）")

  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString("ascii", off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") {
      break
    }
    off += 12 + len
  }
  assert.equal(bitDepth, 8, "只解 8-bit PNG")
  assert.equal(colorType, 6, "只解 RGBA PNG")
  assert.equal(interlace, 0, "只解非隔行 PNG")

  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(width * height * bpp)

  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      const v = line[x]
      row[x] =
        filter === 0 ? v
        : filter === 1 ? (v + a) & 0xff
        : filter === 2 ? (v + b) & 0xff
        : filter === 3 ? (v + ((a + b) >> 1)) & 0xff
        : filter === 4 ? (v + paeth(a, b, c)) & 0xff
        : (() => { throw new Error(`未知 filter ${filter}`) })()
    }
  }
  return { width, height, rgba: out }
}

/** alpha > 0 的包围盒（PNG 的 bbox 是左闭右开，和 Pillow 的 getbbox 一致）*/
function alphaBbox({ width, height, rgba }) {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
    }
  }
  return [x0, y0, x1 + 1, y1 + 1]
}

/** 四个角（左下、右下、右上、左上）的 RGBA */
function corners({ width, height, rgba }) {
  const at = (x, y) => Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
  return [at(0, height - 1), at(width - 1, height - 1), at(width - 1, 0), at(0, 0)]
}

// ═══ 取 data URI ═══════════════════════════════════════════════════════
const src = readFileSync(SRC, "utf8")
const uriOf = (name) => {
  const m = new RegExp(`${name}\\s*=\\s*\\n?\\s*"(data:image/png;base64,[A-Za-z0-9+/=]+)"`).exec(src)
  assert.ok(m, `src/icons.mjs 里找不到 ${name}`)
  return m[1]
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
    console.log(`      ${String(e?.message ?? e).split("\n")[0]}`)
  }
}

const intl = decodePng(Buffer.from(uriOf("ICON_INTL").split(",")[1], "base64"))
const cn = decodePng(Buffer.from(uriOf("ICON_CN").split(",")[1], "base64"))

console.log("① 解码 —— 两张都得是 128×128 RGBA PNG")
check("ICON_INTL 128×128", () => {
  assert.equal(intl.width, 128)
  assert.equal(intl.height, 128)
})
check("ICON_CN 128×128", () => {
  assert.equal(cn.width, 128)
  assert.equal(cn.height, 128)
})

console.log("\n② 内容满格 —— alphabbox 要铺满画面（0.3.70 的判据）")
check("ICON_INTL 的 alpha bbox = (0,0,128,128)", () => {
  assert.deepEqual(alphaBbox(intl), [0, 0, 128, 128], "四周还有留白 = 卡片上会显得很小")
})
check("ICON_INTL 内容占比 ≥ 99%", () => {
  const [x0, y0, x1, y1] = alphaBbox(intl)
  const ratio = ((x1 - x0) * (y1 - y0)) / (128 * 128)
  assert.ok(ratio >= 0.99, `内容只占 ${(ratio * 100).toFixed(1)}%`)
})
check("ICON_CN 也没留大边（宽高都 ≥ 90%）", () => {
  const [x0, y0, x1, y1] = alphaBbox(cn)
  assert.ok(x1 - x0 >= 115, `宽只有 ${x1 - x0}px`)
  assert.ok(y1 - y0 >= 115, `高只有 ${y1 - y0}px`)
})

console.log("\n③ 四角必须透明 —— 实心方块的四角在卡片上会顶出黑边")
check("ICON_INTL 四角 alpha 全 0", () => {
  for (const c of corners(intl)) assert.equal(c[3], 0, `角上有不透明像素：${c}`)
})
check("ICON_CN 四角 alpha 全 0", () => {
  for (const c of corners(cn)) assert.equal(c[3], 0, `角上有不透明像素：${c}`)
})

console.log("\n④ 两个图不是同一张（卡片上要一眼分得开）")
check("data URI 不同且长度都在合理范围", () => {
  assert.notEqual(uriOf("ICON_CN"), uriOf("ICON_INTL"))
  for (const n of ["ICON_CN", "ICON_INTL"]) {
    const len = uriOf(n).length
    assert.ok(len > 2000 && len < 40000, `${n} 长度 ${len} 不在 2k~40k`)
  }
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
