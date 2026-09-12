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
  return { winnerAt: winnerAt, emptyCells: emptyCells, SIZE: SIZE }
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
  ${hostSrc.slice(start, end).replace(/export function pickMove/, 'function pickMove')}
  return { pickMove: pickMove, scanCoords: scanCoords }
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

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
