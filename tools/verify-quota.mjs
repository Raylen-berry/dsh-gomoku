// ============================================================================
// dsh-gomoku · 省额度模式离线自检（不开浏览器、不联网、不调模型）
//   node tools/verify-quota.mjs
//
// 被测的行为（README「省额度模式」一节）：
//   省额度开关开 ⇒ 本地引擎判定这一手是**强制手**时，直接落引擎坐标、**不发模型
//   请求**（省掉的那次调用，在评测模式下本来也一定会被引擎否决回来，纯属白花）；
//   非强制手仍照旧问模型；开关关（= 评测模式）行为与加开关之前**逐字段一致**。
//
// 三件事必须同时成立，缺一个就不算对：
//   ① 强制手时模型请求数为 0 —— 否则根本没省；
//   ② 非强制手仍调模型     —— 否则是"修过头把棋力也省了"；
//   ③ 评测模式逐字段不变   —— 否则是"修过头把评测也省了"，历史数据不再可比。
//
// 做法：把 host 半的**真身**挂到假 cordis 上跑（假 webServer 收路由、假 llm 计数并
// 按局面回坐标），于是"模型请求数"是真数出来的，不是从源码里猜的。client 半则用
// tools/lib-client-fake.mjs 跑真身，验开关默认关 + 落盘 + 重启后还在。
//
// 反向验证（断言确实指向新实现）：
//   DEEPSEEK_GOMOKU_OLD_TREE=<改动前的仓库树> node tools/verify-quota.mjs
//   会改用那棵树里的 index.js / client.js 跑同一套断言 —— 新断言必须失败。
//   见 README 与本次提交说明里的失败数。
// ============================================================================

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { bootClient } from './lib-client-fake.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const OLD_TREE = process.env.DEEPSEEK_GOMOKU_OLD_TREE || ''
const TREE = OLD_TREE || ROOT                       // 断言对象所在的那棵树

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}

// 每段装在一个块里跑，块里**抛异常**（assert/取值失败）只算这一段的失败，不让整个
// 套件半路死掉 —— 反向验证时（拿改动前的树跑同一套）必须看到**完整的失败数**，
// 而不是"跑到第 20 项就崩了"。
async function runBlock(label, fn) {
  console.log(label)
  try {
    await fn()
  } catch (err) {
    fail++
    console.log('  ✗ 这一段的断言中途抛异常（该段其余断言没跑完）：' + String((err && err.message) || err))
  }
}

// ---- 从 host 源码里取纯函数（剥掉 export 再求值，与 verify-gomoku.mjs 同套路） ----
// forcedMove / moveSourceOf 是本次新增的：拿**改动前的树**跑（反向验证）时它们根本
// 不存在 —— 这时退化成"缺失"桩，让断言去失败，而不是在取函数这一步就把整个套件
// 炸掉（那样就看不到完整失败数了，反向验证也就没有数字可报）。
function pureFns(tree) {
  const src = readFileSync(join(tree, 'index.js'), 'utf8')
  const has = (name) => new RegExp('(^|\\n)\\s*(export\\s+)?function\\s+' + name + '\\b').test(src)
  const stub = (name) => 'function ' + name + '() { return MISSING("' + name + '") }'
  const body = `(function(){
    function MISSING(n) { throw new Error('这棵树里没有 ' + n + '（它是本次改动新增的）') }
    ${src.slice(src.indexOf('function readBody'), src.indexOf('export async function apply')).replace(/^export /gm, '')}
    ${has('forcedMove') ? '' : stub('forcedMove')}
    ${has('moveSourceOf') ? '' : stub('moveSourceOf')}
    return { rankMoves: rankMoves, forcedMove: forcedMove, moveSourceOf: moveSourceOf, lineValue: lineValue }
  })()`
  return eval(body)
}
const H = pureFns(TREE)

// 反向验证用：改动前的树没有这两个函数，桩会抛。包一层，让 it 变成"断言失败"
// 而不是"整段炸掉" —— 反向验证要的是一份完整的失败清单。
function probe(fn, ...args) {
  try { return fn(...args) } catch (err) { return undefined }
}
const forcedMove = (ranked) => probe(H.forcedMove, ranked)
const moveSourceOf = (from, called, over) => probe(H.moveSourceOf, from, called, over)

// ---- 假 cordis：假 webServer 收路由 + 假 llm 计数 ----
function makeReq(bodyStr) {
  const ls = { data: [], end: [], error: [] }
  return {
    method: 'POST', url: '/gomoku/move',
    on(ev, fn) { (ls[ev] || (ls[ev] = [])).push(fn); return this },
    fire() { for (const f of ls.data) f(Buffer.from(bodyStr, 'utf8')); for (const f of ls.end) f() },
  }
}

// ask: (body) => 'r,c' | null（null = 模型不吐合法坐标 ⇒ 走兜底）
async function bootHost(opts) {
  const options = opts || {}
  const ask = options.ask || (() => '1,1')
  const mod = await import(pathToFileURL(join(options.tree || TREE, 'index.js')).href + '?boot=' + Math.random())
  const routes = new Map()
  const llm = {
    calls: 0,
    seen: [],
    listProviders: () => [{ id: 'alpha', name: 'Alpha' }],
    listModels: async () => [{ id: 'a-1', name: 'A1' }],
    // 一次「模型调用」= 一次真实计费点。这里只数次数、只回坐标，绝不联网。
    stream: (arg) => (async function* () {
      callCount++
      const text = ask(arg && arg.messages && arg.messages[0] ? String(arg.messages[0].content[0].text) : '', arg)
      if (text === null) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', text: text }
      yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 8, reasoningTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  let callCount = 0
  const webServer = {
    register(route) { routes.set(route.path, route.handler); return { dispose() {} } },
  }
  const services = { webServer, llm }
  const ctx = {
    get: (n) => services[n],
    effect: (fn) => fn(),
  }
  const realLog = console.log
  console.log = () => {}
  try { await mod.apply(ctx) } finally { console.log = realLog }

  const handler = routes.get('/gomoku/move')
  if (!handler) throw new Error('move 路由没有注册上')
  return {
    calls: () => callCount,
    // 真发一次 POST /gomoku/move，返回解析后的 JSON（与 client.js 走的是同一条路）
    post(body) {
      const req = makeReq(JSON.stringify(body))
      let out = null
      const res = {
        writeHead(status) { out = out || { status }; out.status = status },
        end(text) { out = out || {}; out.body = text },
      }
      const done = new Promise((resolve) => { const orig = res.end; res.end = (t) => { orig(t); resolve() } })
      handler(req, res)
      req.fire()
      return done.then(() => JSON.parse(out.body))
    },
  }
}

const SIZE = 15
const empty = () => new Array(SIZE * SIZE).fill(0)
const put = (cells, r, c, v) => { cells[r * SIZE + c] = v }
const row = (cells, r, from, to, v) => { for (let c = from; c <= to; c++) put(cells, r, c, v) }

const MV = (r, c, name) => ({
  r, c, fallback: false, from: 'text', name: name || 'Stub',
  engine: { r, c, reason: 'stub' }, agreedWithEngine: true,
  timedOut: false, timeoutMs: 5000, overridden: false, modelChoice: null,
  text: r + ',' + c, reasoning: '', finishKind: 'stop', ms: 12,
})

// ---- 局面 ----
// 我的四连（urgency 5）：这一手直接成五，模型答什么都不该改变结论
function boardMyFive() { const c = empty(); row(c, 7, 3, 6, 1); return c }
// 对方四连（urgency 4）：不挡就输
function boardFoeFive() { const c = empty(); row(c, 7, 3, 6, 2); return c }
// 对方活三 .WWW.（urgency 2）：挡点必须处理
function boardFoeOpen3() { const c = empty(); row(c, 7, 4, 6, 2); return c }
// 我的活三（atk ≥ 9000 ⇒ urgency 3）：本方可成活四
function boardMyOpen3() { const c = empty(); row(c, 7, 4, 6, 1); return c }
// 安静局面：只有一颗子，双方都无威胁 ⇒ 没有强制手，必须交回模型
function boardQuiet() { const c = empty(); put(c, 7, 7, 1); return c }
// 空盘：也没有强制手（引擎候选的 urgency 全 0，实测）
function boardBlank() { return empty() }

const SIDE = 1
const base = (cells, extra) => Object.assign({
  provider: 'alpha', model: 'a-1', name: 'A1', side: SIDE, size: SIZE, cells: cells,
  history: [], timeoutMs: 5000,
}, extra || {})

// ============================================================================
console.log('[0] 引擎「强制手」判据（唯一来源：ranked[0].urgency ≥ 2）')
{
  check('自己四连 ⇒ 强制手（urgency 5）', forcedMove(H.rankMoves(boardMyFive(), SIZE, SIDE, 8)) !== null)
  check('自己四连的 urgency 恰为 5', H.rankMoves(boardMyFive(), SIZE, SIDE, 8)[0].urgency === 5)
  check('对方四连 ⇒ 强制手（urgency 4）', forcedMove(H.rankMoves(boardFoeFive(), SIZE, SIDE, 8)) !== null)
  check('对方活三 ⇒ 强制手（urgency 2）', forcedMove(H.rankMoves(boardFoeOpen3(), SIZE, SIDE, 8)) !== null)
  check('自己活三 ⇒ 强制手（urgency 3，本方可成活四）', H.rankMoves(boardMyOpen3(), SIZE, SIDE, 8)[0].urgency === 3)
  check('安静局面（一颗子）⇒ 不是强制手', forcedMove(H.rankMoves(boardQuiet(), SIZE, SIDE, 8)) === null)
  check('空盘 ⇒ 不是强制手', forcedMove(H.rankMoves(boardBlank(), SIZE, SIDE, 8)) === null)
  check('空 ranked ⇒ forcedMove 返回 null（不抛）', forcedMove([]) === null && forcedMove(null) === null)
  check('棋盘已满 ⇒ 候选为空、不是强制手', forcedMove(H.rankMoves(new Array(SIZE * SIZE).fill(1), SIZE, SIDE, 8)) === null)

  // 判据只看**第一候选**：这是与评测模式「引擎否决」逐字相同的口径。
  // 下面这个局面里"挡对方活三"确实存在（urgency 2），但它排在第二——
  // 双方都是同一个口径，所以省额度省掉的调用恰好就是评测模式会否决的那些。
  const both = empty(); row(both, 7, 3, 6, 1); row(both, 9, 3, 6, 2)
  const ranked = H.rankMoves(both, SIZE, SIDE, 8)
  check('双方都能成五 ⇒ 首选是自己的五连（先赢再挡）', ranked[0].urgency === 5)
  check('该局面里存在 urgency≥2 的候选，但判据取第一候选', ranked.some((m) => m.urgency >= 2))

  // 来源标记：moveSource 是 from 的对外口径
  check('moveSource：from=engine-direct ⇒ engine-direct', moveSourceOf('engine-direct', false, false) === 'engine-direct')
  check('moveSource：from=engine ⇒ engine-opponent', moveSourceOf('engine', false, false) === 'engine-opponent')
  check('moveSource：被引擎否决 ⇒ engine-veto', moveSourceOf('engine-forced', true, true) === 'engine-veto')
  check('moveSource：from=text ⇒ model', moveSourceOf('text', true, false) === 'model')
  check('moveSource：from=reasoning ⇒ model', moveSourceOf('reasoning', true, false) === 'model')
  check('moveSource：模型自己吐的坐标，绝不因为 modelCalled 假值被写成"引擎直落"',
    moveSourceOf('text', false, false) === 'model', moveSourceOf('text', false, false))
  check('moveSource：兜底 ⇒ model-fallback', moveSourceOf('fallback', true, false) === 'model-fallback')
  check('moveSource：超时 ⇒ engine-timeout', moveSourceOf('engine-timeout', true, false) === 'engine-timeout')
  check('moveSource：engine-forced（哪怕 overridden 标记丢了）⇒ engine-veto',
    moveSourceOf('engine-forced', true, false) === 'engine-veto')
}

await runBlock('\n[1] 默认关：不带 saveQuota 的请求 = 评测模式（修不修都得一样）', async () => { 
  const host = await bootHost({ tree: TREE, ask: () => '3,3' })
  const r = await host.post(base(boardQuiet()))
  check('不带 saveQuota ⇒ 仍然调模型（1 次）', host.calls() === 1, host.calls())
  check('响应里 saveQuota 明确回 false（默认关）', r.saveQuota === false, r.saveQuota)
  check('响应里 modelCalled = true', r.modelCalled === true, r.modelCalled)
  check('安静局面落模型给的坐标', r.r === 3 && r.c === 3, [r.r, r.c])
  check('来源标为 model', r.moveSource === 'model', r.moveSource)
  check('没有被否决', r.overridden === false && r.modelChoice === null, { o: r.overridden, m: r.modelChoice })
})

await runBlock('\n[2] 非强制手：开着省额度也仍要走模型（防"修过头把棋力也省了"）', async () => { 
  for (const [tag, cells] of [['安静局面（一颗子）', boardQuiet()], ['空盘', boardBlank()]]) {
    const host = await bootHost({ tree: TREE, ask: () => '2,4' })
    const r = await host.post(base(cells, { saveQuota: true }))
    check(`${tag}：saveQuota=on 仍调模型 1 次`, host.calls() === 1, host.calls())
    check(`${tag}：落模型给的坐标`, r.r === 2 && r.c === 4, [r.r, r.c])
    check(`${tag}：来源标为 model`, r.moveSource === 'model', r.moveSource)
    check(`${tag}：saveQuota 原样回传 true`, r.saveQuota === true, r.saveQuota)
  }
  // 模型给不出合法坐标 ⇒ 兜底仍发生在模型路径里（不是省额度路径）
  const host = await bootHost({ tree: TREE, ask: () => null })
  const r = await host.post(base(boardQuiet(), { saveQuota: true }))
  check('模型吐不出坐标：照旧调了一次模型', host.calls() === 1, host.calls())
  check('兜底落子（fallback=true / from=fallback）', r.fallback === true && r.from === 'fallback', { f: r.fallback, from: r.from })
  check('兜底来源标为 model-fallback', r.moveSource === 'model-fallback', r.moveSource)
})

await runBlock('\n[3] 强制手 + 省额度开：模型请求数必须是 0（本条是省额度的全部意义）', async () => { 
  const cases = [
    ['我的四连（必胜）', boardMyFive(), [[7, 2], [7, 7]]],
    ['对方四连（必挡）', boardFoeFive(), [[7, 2], [7, 7]]],
    ['对方活三（必须处理）', boardFoeOpen3(), [[7, 3], [7, 7]]],
    ['我的活三（成活四）', boardMyOpen3(), [[7, 3], [7, 7]]],
  ]
  for (const [tag, cells, okPts] of cases) {
    const host = await bootHost({ tree: TREE, ask: () => '1,1' })
    const r = await host.post(base(cells, { saveQuota: true }))
    check(`${tag}：模型请求数 = 0`, host.calls() === 0, host.calls())
    check(`${tag}：落点 = 引擎坐标`, okPts.some((p) => r.r === p[0] && r.c === p[1]), [r.r, r.c])
    check(`${tag}：响应标明来源为引擎直落`, r.moveSource === 'engine-direct' && r.from === 'engine-direct', { s: r.moveSource, f: r.from })
    check(`${tag}：modelCalled = false（前端据此显示"引擎直落"）`, r.modelCalled === false, r.modelCalled)
    check(`${tag}：没有模型输出可回放（text/reasoning 为空）`, r.text === '' && r.reasoning === '', { t: r.text, g: r.reasoning })
    check(`${tag}：agreedWithEngine = true（落点就是引擎首选）`, r.agreedWithEngine === true, r.agreedWithEngine)
    check(`${tag}：overridden = false（没问过模型，谈不上否决）`, r.overridden === false && r.modelChoice === null, { o: r.overridden })
    check(`${tag}：没有借超时的名义省（timedOut=false、ms=0）`, r.timedOut === false && r.ms === 0, { t: r.timedOut, ms: r.ms })
    check(`${tag}：引擎理由随响应回去（界面要显示）`, !!(r.engine && r.engine.reason), r.engine)
  }
})

await runBlock('\n[4] 同一个强制手局面：省额度 = 评测模式的落点（省的是 token，不是棋力）', async () => { 
  for (const [tag, cells] of [['我的四连', boardMyFive()], ['对方四连', boardFoeFive()], ['对方活三', boardFoeOpen3()]]) {
    const on = await bootHost({ tree: TREE, ask: () => '1,1' })
    const rOn = await on.post(base(cells, { saveQuota: true }))
    const off = await bootHost({ tree: TREE, ask: () => '1,1' })
    const rOff = await off.post(base(cells))            // 模型故意不听话
    check(`${tag}：评测模式确实调了模型`, off.calls() === 1, off.calls())
    check(`${tag}：评测模式被引擎否决（overridden=true）`, rOff.overridden === true, rOff.overridden)
    check(`${tag}：省额度开/关落点完全相同`, rOn.r === rOff.r && rOn.c === rOff.c, { on: [rOn.r, rOn.c], off: [rOff.r, rOff.c] })
    check(`${tag}：省额度省掉的正是会被否决的那一次调用`, on.calls() === 0 && off.calls() === 1, { on: on.calls(), off: off.calls() })
  }
  // 模型恰好也选引擎首选 ⇒ 评测模式没必要否决，落点同样一致
  const cells = boardMyFive()
  const engineTop = H.rankMoves(cells, SIZE, SIDE, 8)[0]
  const off = await bootHost({ tree: TREE, ask: () => engineTop.r + ',' + engineTop.c })
  const rOff = await off.post(base(cells))
  const on = await bootHost({ tree: TREE, ask: () => '1,1' })
  const rOn = await on.post(base(cells, { saveQuota: true }))
  check('模型听话时评测模式不否决', rOff.overridden === false, rOff.overridden)
  check('模型听话时两档落点仍一致', rOn.r === rOff.r && rOn.c === rOff.c, { on: [rOn.r, rOn.c], off: [rOff.r, rOff.c] })
})

await runBlock('\n[5] 内置引擎对手这条支路：从不为它调模型、来源标为 engine-opponent', async () => { 
  const host = await bootHost({ tree: TREE, ask: () => '1,1' })
  const r = await host.post({ provider: 'engine', model: 'normal', name: '引擎·标准', side: 1, size: SIZE, cells: boardMyFive() })
  check('引擎对手：模型请求数 = 0', host.calls() === 0, host.calls())
  check('引擎对手：来源标记 engine-opponent', r.moveSource === 'engine-opponent', r.moveSource)
  check('引擎对手：modelCalled = false', r.modelCalled === false, r.modelCalled)
  check('引擎对手：落点 = 引擎首选', r.agreedWithEngine === true && Math.abs(r.r - 7) <= 1, [r.r, r.c])
})

await runBlock('\n[6] 评测模式逐字段一致（有基准树时与改动前逐字段对拍）', async () => { 
  const NEW_FIELDS = ['moveSource', 'modelCalled', 'saveQuota']
  const NONDET = ['ms']                    // 唯一按定义不确定的字段（耗时）

  // 对比用局面：强制手 / 强制手（模型听话）/ 非强制手 / 兜底 / 引擎对手，五种响应形状都覆盖
  const scenarios = [
    ['我的四连（强制手，模型不听话）', 'model', boardMyFive(), () => '1,1'],
    ['对方四连（强制手，模型听话）', 'model', boardFoeFive(), () => '7,7'],
    ['安静局面（非强制手）', 'model', boardQuiet(), () => '3,3'],
    ['模型吐不出坐标（兜底）', 'model', boardQuiet(), () => null],
    ['引擎对手', 'engine', boardFoeOpen3(), () => '1,1'],
  ]

  function strip(r) {
    const out = {}
    const extras = []
    for (const k of Object.keys(r)) {
      if (NONDET.indexOf(k) >= 0) continue
      if (NEW_FIELDS.indexOf(k) >= 0) { extras.push(k); continue }
      out[k] = r[k]
    }
    return { out, extras }
  }
  function diff(a, b) {
    const bad = []
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        bad.push(k + ': 旧=' + JSON.stringify(a[k]) + ' 新=' + JSON.stringify(b[k]))
      }
    }
    return bad
  }

  if (!OLD_TREE) {
    console.log('  （未设置 DEEPSEEK_GOMOKU_OLD_TREE —— 跳过与改动前树的对拍，只锁字段面）')
  }
  for (const [tag, kind, cells, ans] of scenarios) {
    const body = kind === 'engine'
      ? { provider: 'engine', model: 'normal', name: '引擎·标准', side: SIDE, size: SIZE, cells: cells }
      : base(cells)
    const newHost = await bootHost({ tree: TREE, ask: ans })
    const rNew = await newHost.post(body)
    const s = strip(rNew)
    check(`${tag}：新增字段恰好是 ${NEW_FIELDS.join('/')}（不多不少）`,
      s.extras.length === NEW_FIELDS.length && NEW_FIELDS.every((k) => s.extras.indexOf(k) >= 0), s.extras)
    if (kind === 'engine') check(`${tag}：模型请求数 = 0`, newHost.calls() === 0, newHost.calls())
    if (!OLD_TREE) continue
    const oldHost = await bootHost({ tree: OLD_TREE, ask: ans })
    const rOld = await oldHost.post(body)
    check(`${tag}：与改动前逐字段一致（ms 除外）`, diff(strip(rOld).out, s.out).length === 0, diff(strip(rOld).out, s.out))
    check(`${tag}：模型请求次数与改动前相同`, oldHost.calls() === newHost.calls(), { old: oldHost.calls(), new: newHost.calls() })
    check(`${tag}：改动前的响应里没有这三个新字段`,
      NEW_FIELDS.every((k) => !(k in rOld)), Object.keys(rOld).filter((k) => NEW_FIELDS.indexOf(k) >= 0))
  }
})

await runBlock('\n[7] 省额度模式的收益：一盘 20 手的棋谱，强制手占比多少', async () => { 
  // 假模型 = 引擎第 2 候选（次优），于是必然出现"模型不堵活三"这种局面，
  // 强制手否决与省额度早退都会被触发 —— 这正是省额度模式想省掉的那部分。
  // 全程用假 llm 计数，绝不真的调用模型。
  const engineOf = (cells, side) => H.rankMoves(cells, SIZE, side, 8)
  const askSecond = (promptTxt, arg) => {
    const cells = cellsOfPrompt(arg)
    const side = sideOfPrompt(arg)
    const ranked = engineOf(cells, side)
    const pick = ranked.length > 1 ? ranked[1] : ranked[0]
    return pick ? pick.r + ',' + pick.c : '0,0'
  }
  const cellsOfPrompt = (arg) => {
    const t = String(arg.messages[0].content[0].text)
    const m = t.match(/当前棋盘：\n([\s\S]*?)\n\n/)
    const cells = empty()
    if (!m) return cells
    m[1].split('\n').forEach((line, r) => {
      for (let c = 0; c < line.length; c++) put(cells, r, c, line[c] === 'X' ? 1 : (line[c] === 'O' ? 2 : 0))
    })
    return cells
  }
  const sideOfPrompt = (arg) => (/你执 X/.test(String(arg.system || '')) ? 1 : 2)

  function fiveInRow(cells, r, c, side) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let n = 1
      for (const sgn of [1, -1]) {
        for (let k = 1; k < 5; k++) {
          const rr = r + dr * k * sgn, cc = c + dc * k * sgn
          if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE || cells[rr * SIZE + cc] !== side) break
          n++
        }
      }
      if (n >= 5) return true
    }
    return false
  }

  async function replay(saveQuota) {
    const host = await bootHost({ tree: TREE, ask: askSecond })
    const cells = empty()
    const log = []
    let modelCalls = 0
    let plies = 0
    for (let i = 0; i < 20; i++) {
      const side = (i % 2) + 1
      const forcedHere = !!forcedMove(engineOf(cells, side))
      const before = host.calls()
      const r = await host.post(base(cells, { side: side, saveQuota: saveQuota }))
      const calledNow = host.calls() - before
      modelCalls += calledNow
      log.push({ ply: i + 1, side, forced: forcedHere, modelCalled: r.modelCalled, calledNow, r, c: [r.r, r.c] })
      put(cells, r.r, r.c, side)
      plies++
      if (fiveInRow(cells, r.r, r.c, side)) break
    }
    return { log, modelCalls, plies, calls: host.calls(), cells }
  }

  const evalRun = await replay(false)
  const quotaRun = await replay(true)

  check(`棋谱走完 ${evalRun.plies} 手（15×15）且未分胜负之前不中断`, evalRun.plies === 20, evalRun.plies)
  const forcedCount = evalRun.log.filter((x) => x.forced).length
  check('棋谱里存在强制手（否则省额度无从谈起）', forcedCount > 0, forcedCount)
  check('★ 同一棋谱两档的坐标轨迹逐手相同（省的是 token，不是棋力）',
    JSON.stringify(evalRun.log.map((x) => x.c)) === JSON.stringify(quotaRun.log.map((x) => x.c)),
    { eval: evalRun.log.map((x) => x.c), quota: quotaRun.log.map((x) => x.c) })
  check('★ 评测模式：每一步都调了模型（含被否决的那些）', evalRun.modelCalls === evalRun.plies, evalRun.modelCalls)
  check('★ 省额度模式：强制手那几步一次都没调',
    quotaRun.modelCalls === quotaRun.plies - forcedCount, { calls: quotaRun.modelCalls, plies: quotaRun.plies, forced: forcedCount })
  check('★ 省下的调用次数 = 强制手步数', evalRun.modelCalls - quotaRun.modelCalls === forcedCount,
    { saved: evalRun.modelCalls - quotaRun.modelCalls, forced: forcedCount })

  const pct = Math.round((forcedCount / evalRun.plies) * 1000) / 10
  console.log('  ── 棋谱（手数 编号·执子·是否强制手·本手是否调模型）：')
  for (const x of evalRun.log) {
    console.log(`     ${String(x.ply).padStart(2)}  ${x.side === 1 ? 'X(黑)' : 'O(白)'}  ${x.forced ? '强制手' : '常规手'}  `
      + `${x.calledNow ? '调模型 1 次' : '调模型 0 次'}  落点(${x.c[0]},${x.c[1]})`)
  }
  console.log(`  ── 强制手 ${forcedCount} / ${evalRun.plies} 手 = ${pct}%；`
    + `评测模式共调模型 ${evalRun.modelCalls} 次，省额度模式 ${quotaRun.modelCalls} 次，省下 ${evalRun.modelCalls - quotaRun.modelCalls} 次`)
  console.log('     （假 llm 计数，全程没有真实模型调用）')

  check('强制手占比在合理区间（>0 且 <100%）', forcedCount > 0 && forcedCount < evalRun.plies, pct)
  check('省下的调用次数 = 该棋谱里"会被引擎否决"的步数',
    evalRun.log.filter((x) => x.forced && x.calledNow).length === forcedCount,
    evalRun.log.filter((x) => x.forced && x.calledNow).length)
})

await runBlock('\n[8] client 半：开关默认关、落盘、重启后保留、且真的随请求发出去', async () => { 
  // 客户端走的是**真** client.js（假 DOM + 假 localStorage）；走子请求由假 fetch 收下，
  // 断言看的是真发出去的那个请求体，而不是从源码里猜"应该会带"。
  const store = new Map()
  const auto = () => MV(7, 8, 'Stub')

  // ① 冷启动（本机没有任何历史设置）⇒ 默认关
  const A = await bootClient({ root: TREE, store, resolveMove: auto })
  await A.tick()
  const box = A.checkbox()
  check('界面上有省额度模式的勾选框', !!box, box)
  check('冷启动默认关（勾选框未选）', !!box && box.checked === false, box && box.checked)
  check('冷启动时盘里还没有这个键（默认值不写盘）', !store.has('dsh-gomoku:save-quota'), [...store.keys()])

  // ② 默认关时走子请求带 false —— 评测模式（老客户端不带这个字段，host 也按 false 处理）
  A.clickZone(7, 7)
  await A.tick()
  check('走子请求发出 1 次', A.pending.length === 1, A.pending.length)
  check('请求体带 saveQuota=false（默认关 = 评测模式）', A.pending[0].body.saveQuota === false, A.pending[0].body)

  // ③ 打开开关 ⇒ 落盘 + 之后的请求都带 true
  A.toggleCheckbox(true)
  check('打开后勾选框选中', !!A.checkbox() && A.checkbox().checked === true, A.checkbox())
  check('打开后写进 localStorage（=1）', store.get('dsh-gomoku:save-quota') === '1', store.get('dsh-gomoku:save-quota'))
  A.clickZone(6, 6)
  await A.tick()
  check('第二个走子请求发出', A.pending.length === 2, A.pending.length)
  check('请求体带 saveQuota=true', A.pending[1].body.saveQuota === true, A.pending[1].body)

  // ④ 重启（浏览器 localStorage 还在）⇒ 开关保留
  const B = await bootClient({ root: TREE, store, resolveMove: auto })
  await B.tick()
  check('★ 重启后开关仍是开的（持久化往返同值）', !!B.checkbox() && B.checkbox().checked === true, B.checkbox())
  B.clickZone(7, 7)
  await B.tick()
  check('★ 重启后请求体仍带 saveQuota=true', B.pending[0].body.saveQuota === true, B.pending[0].body)

  // ⑤ 关掉也要落盘（否则"关"这件事活不过重启）
  B.toggleCheckbox(false)
  check('关闭后写盘为 0', store.get('dsh-gomoku:save-quota') === '0', store.get('dsh-gomoku:save-quota'))
  const C = await bootClient({ root: TREE, store, resolveMove: auto })
  await C.tick()
  check('★ 再重启：关状态也保留（往返同值）', !!C.checkbox() && C.checkbox().checked === false, C.checkbox())
  C.clickZone(7, 7)
  await C.tick()
  check('★ 再重启后请求体回到 saveQuota=false', C.pending[0].body.saveQuota === false, C.pending[0].body)

  // ⑥ 界面要能看出这一手是谁下的：引擎直落 vs 模型
  const D = await bootClient({ root: TREE, store: new Map(), resolveMove: () => ({
    r: 7, c: 3, fallback: false, from: 'engine-direct', moveSource: 'engine-direct',
    modelCalled: false, saveQuota: true, timedOut: false, timeoutMs: 5000,
    overridden: false, modelChoice: null, agreedWithEngine: true,
    engine: { r: 7, c: 3, reason: '挡住对方的冲四' }, candidates: [], text: '', reasoning: '',
    finishKind: 'engine-direct', usage: null, ms: 0, name: 'A1',
  }) })
  await D.tick()
  D.toggleCheckbox(true)
  D.clickZone(7, 7)
  await D.tick()
  check('引擎直落的请求确实带上了 saveQuota=true', D.pending[0].body.saveQuota === true, D.pending[0].body)
  check('引擎直落的棋子落在引擎给的坐标上', D.stones() === 2, D.stones())
  check('★ 界面标出这一手来源是"引擎直落"', /引擎直落/.test(D.note()), D.note())
  check('界面不再把它写成"模型下的一步"', !/A1 下 \(/.test(D.allText()), D.note())

  const E = await bootClient({ root: TREE, store: new Map(), resolveMove: () => MV(3, 3, '模型甲') })
  await E.tick()
  E.clickZone(7, 7)
  await E.tick()
  check('模型的走子照旧标注模型名与坐标', /模型甲 下 \(3,3\)/.test(E.note()), E.note())
  check('模型的走子不被标成引擎直落', !/引擎直落/.test(E.allText()), E.note())
})

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`)
if (OLD_TREE) console.log(`（断言对象：改动前的树 ${OLD_TREE} —— 上面的失败数就是"新断言确实指向新实现"的证据）`)
process.exit(fail === 0 ? 0 : 1)
