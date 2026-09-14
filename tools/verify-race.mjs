// ============================================================================
// dsh-gomoku · 回合竞态离线自检（不开浏览器）
//   node tools/verify-race.mjs
//
// 覆盖的 bug：「思考中开新局」时，**旧局**（gen 已过期）的走子请求落地，会把
// 新局的 busy 清掉。S.busy 兼作「轮到 AI 就自动走子」的同步闸（client.js 里
// useAutoPlay 的注释），闸被旧局打开，同一回合就可能被放进**第二次请求** ——
// 模型被重复调用、一步棋落两次。
//
// 做法：把 client 半的真身跑起来，但不给浏览器。假运行时（假 window.__ModuleLoader__
// / 假 react / 假 fetch / 假 localStorage）都在 tools/lib-client-fake.mjs 里，与
// tools/verify-quota.mjs **共用同一份** —— 假 DOM 的行为只能有一个来源，否则两套
// 结论迟早打架。本套只负责**时序**：不传 resolveMove ⇒ 走子请求一律挂着不落地，
// 由 land()/boom() 手动放行，于是「起请求 → 换局（gen 自增）→ 让旧 promise 落地」
// 这条时序能被确定性复现，不必等真实模型、也不需要任何网络。
// 断言只看界面上看得见的东西（状态行文案 / 棋子数 / 请求次数），不碰内部变量 ——
// 与用户看到的现象同一口径。
// ============================================================================

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { bootClient } from './lib-client-fake.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}

// ---- 假模型目录：current 非空 ⇒ 对手默认「本会话模型」 ----
const MODELS = {
  providers: [
    { id: 'alpha', name: 'Alpha', models: [{ id: 'a-1', name: 'A1' }] },
    { id: 'beta', name: 'Beta', models: [{ id: 'b-1', name: 'B1' }] },
  ],
  current: { provider: 'cur', model: 'm-cur' },
}

// 本套要的是时序控制：不传 resolveMove ⇒ 走子请求一律挂着，等 land()/boom() 放行。
async function boot() {
  return bootClient({ root, modelCatalog: MODELS })
}

const MV = (r, c, name) => ({
  r, c, fallback: false, from: 'text', name: name || 'Stub',
  engine: { r: r, c: c, reason: 'stub' }, agreedWithEngine: true,
  timedOut: false, timeoutMs: 5000, overridden: false, modelChoice: null,
  text: r + ',' + c, reasoning: '', finishKind: 'stop', ms: 12,
})

// ============================================================================
console.log('[1] 旧局请求落地 ⇒ 不得动新局的闸与思考中文案（①③）')
{
  const G = await boot()
  await G.tick()                                   // 模型目录落地：对手 = 本会话模型
  check('起手轮到人（黑）', /轮到 我/.test(G.status()), G.status())

  G.clickZone(7, 7)                                // 人落子 → 轮到 AI → 自动走子（旧局请求 A）
  check('人落子后进入思考中', /思考中/.test(G.status()), G.status())
  check('走子请求只发了 1 次', G.pending.length === 1, G.pending.length)

  G.click('新局')                                  // ←「思考中开新局」：gen 自增，A 就此过期
  check('新局：棋盘清空', G.stones() === 0, G.stones())
  check('新局：轮到人，不自动走子', /轮到 我/.test(G.status()), G.status())

  G.clickZone(3, 3)                                // 新局人落子 → 新局请求 B
  check('新局轮到 AI：第 2 次请求', G.pending.length === 2, G.pending.length)
  check('新局也在思考中', /思考中/.test(G.status()), G.status())

  await G.land(0, MV(7, 7, '旧局模型'))              // 旧局（gen 已过期）此刻才落地
  check('① 旧局落地后新局仍在思考中（busy 没被清）', /思考中/.test(G.status()), G.status())
  check('① 旧局落地后思考中文案没被清空', /思考中…/.test(G.status()), G.status())
  check('① 旧局落地后闸没被打开（同回合仍不会重复走子）', G.pending.length === 2, G.pending.length)
  check('③ 旧局落子没写进新局棋盘（仍 1 子）', G.stones() === 1, G.stones())
  check('③ 新局步数仍为 1', /步数 1/.test(G.steps()), G.steps())

  await G.land(1, MV(0, 0, '新局模型'))              // 新局自己的请求正常落地
  check('② 新局请求落地后正常收闸（轮到人）', /轮到 我/.test(G.status()), G.status())
  check('② 新局自己的落子生效（2 子）', G.stones() === 2, G.stones())
}

console.log('[2] 正常单局：请求结束仍要清闸（防"修过头"）')
{
  const G = await boot()
  await G.tick()
  G.clickZone(7, 7)
  check('单局：思考中', /思考中/.test(G.status()), G.status())
  check('单局：请求 1 次', G.pending.length === 1, G.pending.length)
  await G.land(0, MV(7, 8))
  check('② 单局请求落地 ⇒ busy 清掉（轮到人）', /轮到 我/.test(G.status()), G.status())
  check('② 思考中文案清空', !/思考中/.test(G.status()), G.status())
  check('② 落子生效（2 子）', G.stones() === 2, G.stones())
  check('② 落地后不再补发请求', G.pending.length === 1, G.pending.length)
}

console.log('[3] 旧局落地后，同一回合不得被放进第二次请求（真凶）')
{
  const G = await boot()
  await G.tick()
  G.clickZone(7, 7)                                // 请求 A（旧局）
  G.click('新局')                                  // gen 自增，A 过期
  G.clickZone(3, 3)                                // 请求 B（新局，仍在飞）
  check('换局后共 2 次请求', G.pending.length === 2, G.pending.length)

  await G.land(0, MV(7, 7))                        // 旧局落地
  check('旧局落地后仍在思考中', /思考中/.test(G.status()), G.status())

  G.pickEngine()                                   // 思考中改对手模型 → deps 变化 → 重新判定
  check('③ 同回合没有被放进第二次请求（请求数仍 2）', G.pending.length === 2, G.pending.length)

  await G.land(1, MV(0, 0))
  check('③ 新局照常收到自己的那步（2 子）', G.stones() === 2, G.stones())
  check('③ 轮到人', /轮到 我/.test(G.status()), G.status())
}

console.log('[4] 旧局报错不得污染新局提示（错误分支也要守门）')
{
  const G = await boot()
  await G.tick()
  G.clickZone(7, 7)                                // 旧局请求
  G.click('新局')
  G.clickZone(3, 3)                                // 新局请求
  await G.boom(0, '旧局炸了')                        // 旧局以失败收场
  check('④ 旧局的错误信息没写进新局', !/旧局炸了/.test(G.status()), G.status())
  check('④ 新局仍在思考中', /思考中/.test(G.status()), G.status())
  await G.boom(1, '新局炸了')                        // 新局自己失败 ⇒ 该提示的要提示
  check('④ 新局自己的错误照旧显示', /新局炸了/.test(G.status()), G.status())
  check('④ 出错后闸也要收（不算思考中）', !/思考中/.test(G.status()), G.status())
}

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
