// ============================================================================
// dsh-gomoku · 回合竞态离线自检（不开浏览器）
//   node tools/verify-race.mjs
//
// 覆盖的 bug：「思考中开新局」时，**旧局**（gen 已过期）的走子请求落地，会把
// 新局的 busy 清掉。S.busy 兼作「轮到 AI 就自动走子」的同步闸（client.js 里
// useAutoPlay 的注释），闸被旧局打开，同一回合就可能被放进**第二次请求** ——
// 模型被重复调用、一步棋落两次。
//
// 做法：把 client 半的真身跑起来，但不给浏览器：
//   · 假 window.__ModuleLoader__ 只负责收集 factory；
//   · 假 react：能跑 useState / useEffect 的最小渲染器（按路径认组件实例，
//     deps 变化才重跑 effect；patch → notify → setState 会驱动重渲染）；
//   · 假 fetch：走子请求交回「可手动落地」的句柄，于是
//     「起请求 → 换局（gen 自增）→ 让旧 promise 落地」这条时序能被确定性复现，
//     不必等真实模型、也不需要任何网络。
// 断言只看界面上看得见的东西（状态行文案 / 棋子数 / 请求次数），不碰内部变量 ——
// 与用户看到的现象同一口径。
// ============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CLIENT_URL = pathToFileURL(join(root, 'client.js')).href

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

function fakeRes(payload) {
  return {
    ok: true, status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  }
}

// ---- 最小 react：只为让 client.js 的 hooks 真跑起来 ----
function makeReact() {
  const instances = new Map()
  const roots = []
  let currentInst = null
  let armed = []
  let dirty = false

  function getInst(key) {
    let inst = instances.get(key)
    if (!inst) {
      inst = { key, states: [], effects: new Map(), pending: [], hookIdx: 0 }
      instances.set(key, inst)
    }
    return inst
  }

  const React = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type, props: props || {}, children }
    },
    useState(init) {
      const inst = currentInst
      const idx = inst.hookIdx++
      if (!(idx in inst.states)) inst.states[idx] = typeof init === 'function' ? init() : init
      return [inst.states[idx], function (v) {
        inst.states[idx] = typeof v === 'function' ? v(inst.states[idx]) : v
        dirty = true                    // patch() → notify() → 这里 → 下个 pass 重渲染
      }]
    },
    useEffect(fn, deps) {
      const inst = currentInst
      inst.pending.push({ idx: inst.hookIdx++, fn, deps: deps ? deps.slice() : null })
    },
  }

  function expand(el, path) {
    if (el === null || el === undefined || el === false || el === true) return null
    if (typeof el === 'string' || typeof el === 'number') return el
    if (Array.isArray(el)) return el.map((e, i) => expand(e, path + '/' + i))
    if (typeof el.type === 'function') {
      const key = path + '>' + (el.type.name || 'Anon')
      const inst = getInst(key)
      inst.hookIdx = 0
      inst.pending = []
      const prev = currentInst
      currentInst = inst
      let out
      try { out = el.type(el.props || {}) } finally { currentInst = prev }
      armed.push(inst)
      return { __comp: el.type.name || 'Anon', key, output: expand(out, key) }
    }
    return {
      type: el.type,
      props: el.props,
      children: el.children.map((c, i) => expand(c, path + '/' + i)),
    }
  }

  function sameDeps(a, b) {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }

  function runEffects() {
    let ran = false
    for (const inst of armed) {
      for (const pe of inst.pending) {
        const old = inst.effects.get(pe.idx)
        if (old && sameDeps(old.deps, pe.deps)) continue
        if (old && typeof old.cleanup === 'function') old.cleanup()
        const rec = { deps: pe.deps, cleanup: null }
        inst.effects.set(pe.idx, rec)
        const c = pe.fn()
        if (typeof c === 'function') rec.cleanup = c
        ran = true
      }
    }
    return ran
  }

  return {
    React,
    mount(viewFns) { for (const fn of viewFns) roots.push(fn) },
    // 一直渲染到不动：patch 引发的重渲染 + deps 变化引发的 effect 都会在这里跑完。
    flush() {
      let forest = null
      for (let i = 0; i < 40; i++) {
        dirty = false
        armed = []
        forest = roots.map((fn, i) => expand(fn(), 'root' + i))
        const ran = runEffects()
        if (!dirty && !ran) return forest
      }
      throw new Error('渲染没有收敛（疑似 effect 里反复 setState）')
    },
  }
}

// ---- 在假环境里把 client 半跑起来 ----
let bootSeq = 0
async function boot() {
  const env = { pending: [] }
  const react = makeReact()
  let captured = null

  globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m } } }
  globalThis.fetch = (url, opts) => {
    const u = String(url)
    if (u.indexOf('/gomoku/models') === 0) {
      return Promise.resolve(fakeRes({ providers: MODELS.providers, current: MODELS.current }))
    }
    if (u.indexOf('/gomoku/move') === 0) {
      let resolve, reject
      const p = new Promise((res, rej) => { resolve = res; reject = rej })
      env.pending.push({ resolve, reject, body: opts && opts.body ? JSON.parse(opts.body) : null })
      return p
    }
    return Promise.resolve(fakeRes({ ok: true }))
  }

  const realLog = console.log
  console.log = () => {}
  let mod
  try {
    mod = await import(CLIENT_URL + '?boot=' + (++bootSeq))
  } finally {
    console.log = realLog
  }
  if (!captured) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')

  const views = []
  const ctx = {
    slots: {
      inject: (name, cb) => { cb() },
      register: (cfg, fn) => { views.push({ id: cfg.id, name: cfg.name, fn }); return {} },
    },
    timeout: () => {},
  }
  console.log = () => {}
  try {
    captured.factory((name) => {
      if (name === 'react') return react.React
      throw new Error('未预期的 require：' + name)
    }).apply(ctx)
  } finally {
    console.log = realLog
  }
  if (views.length < 2) throw new Error('两个界面没有都注册上：' + views.length)

  // 两个界面都挂上：真实运行时 shell.overlay 一直挂着，会话页开着小游戏标签页时
  // conversation.view 也挂着 —— 两份 useAutoPlay 同时生效，S.busy 就是它俩的闸。
  react.mount(views.map((v) => v.fn))
  let forest = react.flush()

  function hosts(node, out) {
    out = out || []
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const n of node) hosts(n, out); return out }
    if (node.__comp) return hosts(node.output, out)
    if (node.type) out.push(node)
    for (const c of node.children || []) hosts(c, out)
    return out
  }
  function texts(node, out) {
    out = out || []
    if (node === null || node === undefined || node === false) return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
    if (node.__comp) return texts(node.output, out)
    for (const c of node.children || []) texts(c, out)
    return out
  }
  // 找「最内层」的那段文案：外层容器也包含同样的字符串，取最短命中的那个。
  function deepestText(re) {
    let best = null
    for (const hnode of hosts(forest)) {
      const t = texts(hnode).join('')
      if (re.test(t) && (best === null || t.length < best.length)) best = t
    }
    return best || ''
  }

  const api = {
    pending: env.pending,
    flush() { forest = react.flush() },
    async tick() { await new Promise((r) => setTimeout(r, 0)); api.flush() },
    async land(i, payload) { env.pending[i].resolve(fakeRes(payload)); await api.tick() },
    async boom(i, message) { env.pending[i].reject(new Error(message)); await api.tick() },
    stones() { return hosts(forest).filter((n) => n.type === 'svg').length },
    status() { return deepestText(/思考中|轮到|获胜|和棋/) },
    steps() { return deepestText(/步数/) },
    zone(r, c) {
      const key = 'z' + r + '_' + c
      const hit = hosts(forest).filter((n) => n.props && n.props.key === key)[0]
      return hit && hit.props.onClick
    },
    clickZone(r, c) {
      const onClick = api.zone(r, c)
      if (!onClick) throw new Error(`热区 (${r},${c}) 不可点（轮次/占用/busy 挡住了？）`)
      onClick()
      api.flush()
    },
    click(label) {
      const hit = hosts(forest).filter((n) => n.type === 'button' && texts(n).join('') === label)[0]
      if (!hit) throw new Error('找不到按钮：' + label)
      hit.props.onClick()
      api.flush()
    },
    // 模型下拉：换成内置引擎（走 onPick → patch({p2})）。这是用户真会做的操作：
    // 思考中改对手模型 ⇒ useAutoPlay 的 deps（p2.model）变化 ⇒ 重新判定该不该走子。
    pickEngine() {
      const sel = hosts(forest).filter((n) => n.type === 'select'
        && hosts(n).some((o) => o.type === 'option' && o.props.value === 'ENGINE'))[0]
      if (!sel) throw new Error('找不到模型下拉')
      sel.props.onChange({ target: { value: 'ENGINE' } })
      api.flush()
    },
  }
  return api
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
