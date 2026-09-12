// ============================================================================
// dsh-gomoku · 离线自检（不开浏览器）
//   node tools/verify-gomoku.mjs
// 覆盖：胜负判定（client 半）与坐标解析 / 兜底选点（host 半）。
// host/index.js 是 ESM 且需要 cordis 运行时，这里用「读取源码 + 剥掉 export
// 关键字再求值」的方式取纯函数，不启动 DSH。
// ============================================================================

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}

// ---- 从 client.js 里取 winnerAt / emptyCells（它们是纯函数） ----
const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
const clientBody = `(function(){
  var exports = {}
  ${clientSrc.slice(clientSrc.indexOf('var SIZE = 15'), clientSrc.indexOf('// host 路由往返'))}
  return {
    winnerAt: winnerAt, emptyCells: emptyCells, SIZE: SIZE,
    boardGeom: boardGeom, STARS: STARS, stoneShape: stoneShape,
  }
})()`
const C = eval(clientBody)

console.log('[1] 胜负判定（client 半）')
{
  const cells = C.emptyCells()
  const put = (r, c, v) => { cells[r * C.SIZE + c] = v }
  // 横五
  for (let c = 3; c < 8; c++) put(7, c, 1)
  check('横五连成 → 胜', C.winnerAt(cells, 7, 7, 1) === true)
  check('同一格判白方 → 不胜', C.winnerAt(cells, 7, 7, 2) === false)
  // 四子不叫赢
  const c2 = C.emptyCells()
  for (let c = 3; c < 7; c++) c2[7 * C.SIZE + c] = 1
  check('四子 → 不胜', C.winnerAt(c2, 7, 6, 1) === false)
  // 竖五
  const c3 = C.emptyCells()
  for (let r = 2; r < 7; r++) c3[r * C.SIZE + 4] = 2
  check('竖五连成 → 胜', C.winnerAt(c3, 4, 4, 2) === true)
  // 反对角五
  const c4 = C.emptyCells()
  for (let k = 0; k < 5; k++) c4[(3 + k) * C.SIZE + (9 - k)] = 1
  check('反对角五连成 → 胜', C.winnerAt(c4, 5, 7, 1) === true)
  // 边界不越界
  const c5 = C.emptyCells()
  for (let k = 0; k < 5; k++) c5[k * C.SIZE + 0] = 1
  check('贴着左边界竖五 → 胜', C.winnerAt(c5, 0, 0, 1) === true)
}

// ---- 从 index.js 里取 pickMove（剥掉 export，注入 scanCoords 依赖） ----
const hostSrc = readFileSync(join(root, 'index.js'), 'utf8')
const start = hostSrc.indexOf('function readBody')
const end = hostSrc.indexOf('export async function apply')
const hostBody = `(function(){
  ${hostSrc.slice(start, end).replace(/^export /gm, '')}
  return {
    pickMove: pickMove, scanCoords: scanCoords,
    rankMoves: rankMoves, rankMovesStrong: rankMovesStrong,
    lineValue: lineValue, reasonFor: reasonFor,
  }
})()`
const H = eval(hostBody)

const SIZE = 15
const empty = () => new Array(SIZE * SIZE).fill(0)
const at = (cells, r, c) => cells[r * SIZE + c]

console.log('[2] 坐标解析（host 半）')
{
  const cells = empty()
  check('标准「7,8」', JSON.stringify(H.pickMove('7,8', '', SIZE, cells)) === JSON.stringify({ r: 7, c: 8, fallback: false, from: 'text' }))
  check('中文逗号「7，8」', H.pickMove('7，8', '', SIZE, cells).from === 'text')
  check('带括号「(7,8)」', H.pickMove('(7,8)', '', SIZE, cells).r === 7)
  check('多话里挑坐标「我下 (6, 9) 这里」', (() => { const p = H.pickMove('我下 (6, 9) 这里', '', SIZE, cells); return p.r === 6 && p.c === 9 })())
  check('越界坐标被跳过，取下一个合法点', (() => { const p = H.pickMove('99,99 然后 3,4', '', SIZE, cells); return p.r === 3 && p.c === 4 })())
  check('已占用的点被跳过', (() => { const c2 = empty(); c2[7 * SIZE + 8] = 1; const p = H.pickMove('7,8 备用 2,2', '', SIZE, c2); return p.r === 2 && p.c === 2 })())
  check('无正文时读思考块（reasoning-delta）', H.pickMove('', '想一下… 落 5,6', SIZE, cells).from === 'reasoning')
}

console.log('[3] 兜底选点')
{
  const cells = empty()
  cells[7 * SIZE + 7] = 1 // 黑在中央
  const p = H.pickMove('我不知道', '', SIZE, cells)
  check('走兜底且标记 fallback', p.fallback === true && p.from === 'fallback')
  check('兜底落在已有棋子旁边', Math.abs(p.r - 7) <= 2 && Math.abs(p.c - 7) <= 2, p)
  check('兜底点本身是空的', at(cells, p.r, p.c) === 0)
  const full = new Array(SIZE * SIZE).fill(1)
  const q = H.pickMove('x', '', SIZE, full)
  check('棋盘满 → from=full / r=-1', q.from === 'full' && q.r === -1)
}

// ---- 棋盘几何：棋子必须落在线的交点上（用户实测反馈过"摆格子内"） ----
console.log('[4] 棋盘几何（棋子 = 交点）')
{
  const S = C.SIZE
  for (const compact of [false, true]) {
    const gm = C.boardGeom(compact)
    const tag = compact ? '浮窗' : '会话页'
    // 网格线 i 的位置
    const linePos = (i) => gm.pad + i * gm.step
    // 落子热区中心（Board 里热区方块 left = pad + c*step - step/2，宽 step）
    const zoneCenter = (c) => (gm.pad + c * gm.step - gm.step / 2) + gm.step / 2
    // 棋子圆心（stoneNode left = pad + c*step - d/2，直径 d）
    const stoneCenter = (c) => (gm.pad + c * gm.step - gm.stone / 2) + gm.stone / 2

    check(`${tag}：热区中心 == 交点`, [0, 7, S - 1].every((c) => zoneCenter(c) === linePos(c)), gm)
    check(`${tag}：棋子圆心 == 交点`, [0, 7, S - 1].every((c) => stoneCenter(c) === linePos(c)), gm)
    check(`${tag}：棋盘能装下最外圈棋子（含边距）`,
      gm.pad >= gm.stone / 2 && gm.size === linePos(S - 1) + gm.pad, gm)
    check(`${tag}：棋子直径 < 交点间距（相邻棋子不粘连）`, gm.stone < gm.step, gm)
    check(`${tag}：棋盘尺寸 = (15-1)*step + 2*pad`, gm.size === (S - 1) * gm.step + 2 * gm.pad, gm)
  }
  check('星位共 5 个且含天元', C.STARS.length === 5 && JSON.stringify(C.STARS).includes('[7,7]'))

  // 棋子必须是**真圆**：改用 SVG <circle> 画。此前用 border-radius:50%，
  // 在 19px×DPR1.25=23.75 个设备像素（分数）时被 Chrome 栅格成圆角方形
  // —— 实测填充率 0.830（正圆 0.785），用户一眼就看出来了。
  const gm = C.boardGeom(false)
  const bk = C.stoneShape(1, gm.stone, false)
  const wt = C.stoneShape(2, gm.stone, false)
  const last = C.stoneShape(2, gm.stone, true)
  check('圆心在尺寸正中心（cx = cy = d/2）', bk.cx === gm.stone / 2 && bk.cy === gm.stone / 2, bk)
  check('圆 + 描边整体落在 d×d 之内（r + strokeWidth/2 ≤ d/2）',
    [bk, wt, last].every((s) => s.r + s.strokeWidth / 2 <= gm.stone / 2 + 1e-9))
  check('黑白子半径与描边宽度一致（只有颜色不同）',
    bk.r === wt.r && bk.strokeWidth === wt.strokeWidth && bk.fill !== wt.fill)
  check('最后一手用红描边（2px）', last.stroke === '#e5534b' && last.strokeWidth === 2)
  check('普通子不用红描边', bk.stroke !== '#e5534b')
  for (const compact of [false, true]) {
    const g2 = C.boardGeom(compact)
    check(`${compact ? '浮窗' : '会话页'}：棋子直径在 DPR1.25 下是整数设备像素（${g2.stone}→${g2.stone * 1.25}）`,
      Number.isInteger(g2.stone * 1.25), g2.stone)
  }
}

// ---- 战术引擎：把"成五/挡五/活四"这些确定性的事交给引擎，弱模型只做选择 ----
console.log('[5] 战术引擎（候选点排序）')
{
  const N = 15
  const blank = () => new Array(N * N).fill(0)

  let c = blank()
  for (let col = 3; col <= 6; col++) c[7 * N + col] = 1 // 我方四连
  const win = H.rankMoves(c, N, 1, 3)
  check('自己四连 → 首选直接补成五',
    win[0] && win[0].r === 7 && (win[0].c === 2 || win[0].c === 7), win[0])
  check('该首选理由写明"连成五子"', /五子/.test(String(win[0] && win[0].reason)), win[0] && win[0].reason)

  c = blank()
  for (let col = 3; col <= 6; col++) c[7 * N + col] = 2 // 对方四连
  const block = H.rankMoves(c, N, 1, 3)
  check('对方四连 → 首选去挡',
    block[0] && block[0].r === 7 && (block[0].c === 2 || block[0].c === 7), block[0])
  check('挡点理由写明"必须挡"', /必须挡/.test(String(block[0] && block[0].reason)), block[0] && block[0].reason)

  c = blank()
  for (let col = 3; col <= 6; col++) { c[7 * N + col] = 1; c[9 * N + col] = 2 }
  const both = H.rankMoves(c, N, 1, 3)
  check('我方能成五、对方也能成五 → 先成五（赢棋优先于挡棋）', both[0].r === 7, both[0])

  const first = H.rankMoves(blank(), N, 1, 8)
  check('空盘也给出候选', first.length >= 1 && first.every((m) => m.r >= 0 && m.r < N && m.c >= 0 && m.c < N), first.length)

  c = blank(); c[7 * N + 7] = 1
  const after = H.rankMoves(c, N, 2, 8)
  check('候选里绝不含已占点', after.every((m) => c[m.r * N + m.c] === 0))
  check('候选按评分降序', after.length < 2 || after[0].score >= after[1].score)
  check('候选默认只取已有棋子附近（空盘除外）',
    after.every((m) => Math.abs(m.r - 7) <= 2 && Math.abs(m.c - 7) <= 2), after.map((m) => [m.r, m.c]))

  // 紧急度：模型不被信任的那几类局面（见 move 路由的"强制手否决"）
  c = blank()
  for (let col = 4; col <= 6; col++) c[7 * N + col] = 2   // 白方活三 .WWW.
  const vsOpen3 = H.rankMoves(c, N, 1, 3)
  check('对方活三 → 首选紧急度 ≥ 2（会被强制手否决接管）', vsOpen3[0].urgency >= 2,
    { move: [vsOpen3[0].r, vsOpen3[0].c], ur: vsOpen3[0].urgency, why: vsOpen3[0].reason })
  check('对方活三的堵点落在两端', vsOpen3[0].r === 7 && (vsOpen3[0].c === 3 || vsOpen3[0].c === 7), [vsOpen3[0].r, vsOpen3[0].c])
  check('对方活三的理由写明"活三/活四"', /活[三四]/.test(String(vsOpen3[0].reason)), vsOpen3[0].reason)

  c = blank()
  for (let col = 3; col <= 6; col++) c[7 * N + col] = 1
  check('我方四连的紧急度 = 5（最高）', H.rankMoves(c, N, 1, 1)[0].urgency === 5)
  c = blank(); c[7 * N + 7] = 1
  check('双方都无威胁时紧急度 < 2（正常局面交回模型）',
    H.rankMoves(c, N, 1, 3).every((m) => m.urgency < 2), H.rankMoves(c, N, 1, 3).map((m) => m.urgency))

  // 「强」档：多推一层对手回应
  c = blank()
  for (let col = 4; col <= 6; col++) c[7 * N + col] = 2
  const strong = H.rankMovesStrong(c, N, 1, 3)
  check('强档返回候选且带 replyThreat（对手回应的威胁值）',
    strong.length > 0 && strong.every((m) => typeof m.replyThreat === 'number'), strong.length)
  check('强档在"对方活三"局面同样先堵', strong[0].r === 7 && (strong[0].c === 3 || strong[0].c === 7), [strong[0].r, strong[0].c])
  check('强档按扣除对手回应后的评分降序', strong.length < 2 || strong[0].score >= strong[1].score)
}

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
