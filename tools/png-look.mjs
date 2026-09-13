// ============================================================================
// png-look —— 给 agent 一双"看截图"的眼睛（纯 Node，零依赖）
//
// 起因：模型读不了图片时，任何"看起来不对"都只能靠嘴辩。这个工具把 PNG 解成像素，
// 再用**字符画 + 填充率**把形状/颜色/边界变成可核查的数字。第一版就是靠它定位了
// 「border-radius:50% 在分数设备像素下被栅格成圆角方形」那个 bug。
//
// 用法：
//   node tools/png-look.mjs <png> [x,y,w,h] [选项]
//   node tools/png-look.mjs shot.png --find          # 自动找最大的暗色块并放大
//   node tools/png-look.mjs shot.png --find --json   # 只要数字（脚本用）
//   node tools/png-look.mjs shot.png --light         # 找亮色块（深底上的白棋子）
//
// 选项：
//   x,y,w,h     取景（图片像素坐标；不给则整图）
//   --find      自动定位最大连通块，把它作为取景（省掉人工猜坐标）
//   --light     掩膜改成"又亮又中性"的像素（深色棋盘上的白子）
//   --strict    掩膜收紧（暗且中性；排除棕色网格线之类"看着暗但不是目标"的东西）
//   --cols=N    字符画宽度（默认 110）
//   --json      只输出 JSON 指标，不画字符画
//   --pad=N     --find 时取景外扩的像素（默认 4）
//
// 支持 8-bit 非交错 PNG（colorType 0/2/6）—— Chrome 截图正是这种。
// 通用工具，随本插件一起走；dsh-gomoku 的几何自检与浏览器插件的视觉验证都用它。
// ============================================================================

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let pos = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('只支持 8-bit，实际 ' + bitDepth)
  if (interlace !== 0) throw new Error('不支持交错 PNG')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
  if (channels === null) throw new Error('不支持 colorType ' + colorType)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = (prev && x >= channels) ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
  }
  return { width, height, channels, data: out }
}

// ---- 参数 -------------------------------------------------------------------
const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--') && !/^\d+(,\d+){3}$/.test(a))
const regionArg = argv.find((a) => /^\d+(,\d+){3}$/.test(a))
if (!file) { console.error('用法: node png-look.mjs <png> [x,y,w,h] [--find] [--light] [--strict] [--cols=N] [--json] [--pad=N]'); process.exit(2) }
const has = (f) => argv.includes(f)
const num = (f, d) => { const hit = argv.find((a) => a.startsWith(f + '=')); return hit ? Number(hit.split('=')[1]) : d }
const FIND = has('--find')
const LIGHT = has('--light')
const STRICT = has('--strict')
const JSON_OUT = has('--json')
const COLS = num('--cols', 110)
const PAD = num('--pad', 4)

const img = decodePng(readFileSync(file))
const px = (x, y) => {
  const i = (y * img.width + x) * img.channels
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}
const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

// 掩膜：
//  暗色（默认/--strict）：棋子、文字、按钮
//  亮色（--light）：深底上的白棋子 / 高光
//  --strict 额外要求"中性"（各通道差 < 30）—— 棋盘网格线是棕色的（lum≈84 却偏红），
//  不排除掉就会把圆面积算大，这个坑踩过一次。
const isSolid = (r, g, b) => {
  const lum = lumOf(r, g, b)
  if (STRICT && Math.max(r, g, b) - Math.min(r, g, b) >= 30) return false
  if (LIGHT) return lum > (STRICT ? 210 : 165)
  return lum < (STRICT ? 45 : 90)
}

// ---- --find：最大连通块（4 邻域，迭代式栈，避免递归爆栈） ---------------------
// 判据不是"像素最多"，而是 **像素数 × 长宽比惩罚**：一条 277×21 的界面文字条
// 像素数往往比一颗 24×24 的棋子还多，但长宽比 0.08 一眼就知道不是目标。
// 第一版没乘这个系数，于是 --find 老是命中状态栏（实测踩过）。
function largestBlob(x0, y0, w, h) {
  const seen = new Uint8Array(w * h)
  let best = null
  const stack = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (seen[idx]) continue
      const [r, g, b] = px(x0 + x, y0 + y)
      if (!isSolid(r, g, b)) { seen[idx] = 1; continue }
      let count = 0, minX = x, maxX = x, minY = y, maxY = y
      stack.length = 0
      stack.push(idx)
      seen[idx] = 1
      while (stack.length) {
        const cur = stack.pop()
        const cx = cur % w, cy = (cur - cx) / w
        count++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        const neighbours = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const ni = ny * w + nx
          if (seen[ni]) continue
          const [nr, ng, nb] = px(x0 + nx, y0 + ny)
          if (!isSolid(nr, ng, nb)) { seen[ni] = 1; continue }
          seen[ni] = 1
          stack.push(ni)
        }
      }
      const bwid = maxX - minX + 1, bhei = maxY - minY + 1
      const aspect = Math.min(bwid, bhei) / Math.max(bwid, bhei)
      const score = count * aspect
      if (!best || score > best.score) best = { count, minX, minY, maxX, maxY, aspect, score }
    }
  }
  return best
}

let [rx, ry, rw, rh] = [0, 0, img.width, img.height]
if (regionArg) {
  const p = regionArg.split(',').map(Number)
  if (p.length === 4 && p.every((n) => Number.isFinite(n))) [rx, ry, rw, rh] = p
}
let blob = null
if (FIND) {
  blob = largestBlob(rx, ry, rw, rh)
  if (!blob) { console.error('没找到任何符合条件的像素块（试试去掉 --strict 或加 --light）'); process.exit(1) }
  rx = Math.max(0, rx + blob.minX - PAD)
  ry = Math.max(0, ry + blob.minY - PAD)
  rw = Math.min(img.width - rx, (blob.maxX - blob.minX + 1) + PAD * 2)
  rh = Math.min(img.height - ry, (blob.maxY - blob.minY + 1) + PAD * 2)
}
rx = Math.max(0, rx); ry = Math.max(0, ry)
rw = Math.min(rw, img.width - rx); rh = Math.min(rh, img.height - ry)

// ---- 统计 -------------------------------------------------------------------
let solid = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
for (let y = 0; y < rh; y++) {
  for (let x = 0; x < rw; x++) {
    const [r, g, b] = px(rx + x, ry + y)
    if (!isSolid(r, g, b)) continue
    solid++
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
}
const bw = maxX - minX + 1, bh = maxY - minY + 1
const boxArea = bw * bh
const circleArea = Math.PI * (bw / 2) * (bh / 2)
const fill = solid / boxArea
// 判形：正方形 1.000 / 正圆 0.785 / 圆角方形在两者之间。阈值取经验值。
const verdict = fill >= 0.96 ? 'square' : (fill <= 0.82 ? 'circle' : 'rounded-square')

if (JSON_OUT) {
  console.log(JSON.stringify({
    image: { width: img.width, height: img.height, channels: img.channels },
    region: { x: rx, y: ry, w: rw, h: rh },
    blob: blob ? { count: blob.count, aspect: Number(blob.aspect.toFixed(2)), score: Math.round(blob.score) } : null,
    bbox: { x: rx + minX, y: ry + minY, w: bw, h: bh },
    solidPx: solid, boxArea, circleArea: Math.round(circleArea),
    fill: Number(fill.toFixed(4)), verdict,
  }))
  process.exit(0)
}

// ---- 字符画 -----------------------------------------------------------------
console.log(`图片 ${img.width}x${img.height}  通道 ${img.channels}  取景 (${rx},${ry}) ${rw}x${rh}`
  + (FIND && blob ? `  [--find 命中 ${blob.count}px 长宽比 ${blob.aspect.toFixed(2)}]` : '')
  + (LIGHT ? '  [亮色掩膜]' : '') + (STRICT ? '  [strict]' : ''))

const ramp = (lum) => (lum < 70 ? '#' : lum < 130 ? '+' : lum < 200 ? '.' : ' ')
const tint = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  if (mx - mn < 26) return null
  if (r === mx) return 'r'
  if (b === mx) return 'b'
  return 'g'
}
const cell = (x, y) => {
  const [r, g, b] = px(x, y)
  const t = tint(r, g, b)
  const lum = lumOf(r, g, b)
  return t && lum < 210 ? t : ramp(lum)
}
const scale = Math.max(1, Math.ceil(rw / COLS))
const rows = []
for (let y = 0; y < rh; y += scale) {
  let line = ''
  for (let x = 0; x < rw; x += scale) line += cell(rx + x, ry + y)
  rows.push(line)
}
console.log(rows.join('\n'))

console.log(`\n暗区 bbox=${bw}x${bh}  实心像素=${solid}  外接方框=${boxArea}  同直径圆≈${Math.round(circleArea)}`)
console.log(`fill = ${fill.toFixed(3)}   （正圆≈0.785，正方形=1.000）  →  ${verdict}`)
