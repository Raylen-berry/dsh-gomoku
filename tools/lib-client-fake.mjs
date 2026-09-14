// ============================================================================
// dsh-gomoku · 离线测试用的「假客户端运行时」（不是测试套件，是套件之间的公共件）
//
// 谁在用：tools/verify-race.mjs（回合竞态）与 tools/verify-quota.mjs（省额度模式）。
// 为什么抽出来：两套都必须在**不开浏览器、不联网、不调模型**的前提下把 client.js
// 真身跑起来。这份最小运行时原来只长在 verify-race.mjs 里，第二套再抄一遍就等于
// 让"假 DOM 的行为"有了两个来源 —— 迟早两套结论打架。这里只有一份。
//
// 文件名故意不匹配 run-all.mjs 的 DISCOVERY（/^(verify|test|probe)-.*\.mjs$/），
// 因此不需要登记进 SUITES；但真要删它之前，先确认上面两套都还在用。
//
// 提供的假件：
//   · 假 window.__ModuleLoader__：只负责把 factory 收上来；
//   · 假 react：能跑 useState / useEffect 的最小渲染器（patch → notify → 重渲染）；
//   · 假 fetch：走子请求交回「可手动落地」的句柄，模型请求数于是可数、可复现；
//   · 假 localStorage：验证"开关落盘、重启后保留"。
// ============================================================================

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

let bootSeq = 0

// ---- 假 react：只为让 client.js 的 hooks 真跑起来 ----
export function makeReact() {
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
// opts.root        : 仓库根（默认由调用方给）
// opts.store       : localStorage 后备对象（**跨 boot 复用**才能验"重启后还在"）
// opts.modelCatalog: /gomoku/models 的返回
// opts.resolveMove : (body, callsThisBoot, store) => payload | { __error: msg }，
//                    默认永远挂着等 land() 手动落地（竞态套件要的时序）。
export async function bootClient(opts) {
  const options = opts || {}
  const root = options.root
  if (!root) throw new Error('bootClient 需要 root')
  const CLIENT_URL = pathToFileURL(join(root, 'client.js')).href
  const store = options.store || new Map()
  const catalog = options.modelCatalog || {
    providers: [
      { id: 'alpha', name: 'Alpha', models: [{ id: 'a-1', name: 'A1' }] },
      { id: 'beta', name: 'Beta', models: [{ id: 'b-1', name: 'B1' }] },
    ],
    current: { provider: 'cur', model: 'm-cur' },
  }

  const env = { pending: [], calls: 0, bodies: [] }
  const react = makeReact()
  let captured = null

  globalThis.window = {
    __ModuleLoader__: { load: (m) => { captured = m } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
      removeItem: (k) => { store.delete(k) },
    },
  }
  globalThis.fetch = (url, opt) => {
    const u = String(url)
    if (u.indexOf('/gomoku/models') === 0) {
      return Promise.resolve(fakeRes({ providers: catalog.providers, current: catalog.current }))
    }
    if (u.indexOf('/gomoku/move') === 0) {
      const body = opt && opt.body ? JSON.parse(opt.body) : null
      env.calls++
      env.bodies.push(body)
      let resolve, reject
      const p = new Promise((res, rej) => { resolve = res; reject = rej })
      // 每一次走子请求都登记下来（**含自动落地的那些**）：请求体是断言对象
      // （saveQuota 有没有带出去），请求次数就是"调了几次模型"。
      env.pending.push({ resolve, reject, body })
      if (options.resolveMove) {
        const auto = options.resolveMove(body, env.calls, store)
        if (auto) resolve(fakeRes(auto))
      }
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
  // 界面上看得见的东西（按钮/勾选框/全部文字），断言只依赖它们
  function allText() {
    return hosts(forest).map((n) => texts(n).join('')).filter(Boolean).join(' | ')
  }
  function byKey(reKey, type) {
    return hosts(forest).filter((n) => (!type || n.type === type)
      && n.props && typeof n.props.key === 'string' && reKey.test(n.props.key))
  }
  function byText(label, type) {
    return hosts(forest).filter((n) => (!type || n.type === type) && texts(n).join('') === label)
  }
  function checkbox() {
    return hosts(forest).filter((n) => n.type === 'input' && n.props && n.props.type === 'checkbox')[0] || null
  }

  const api = {
    store,
    pending: env.pending,
    bodies: env.bodies,
    calls: () => env.calls,
    flush() { forest = react.flush() },
    async tick() { await new Promise((r) => setTimeout(r, 0)); api.flush() },
    async land(i, payload) { env.pending[i].resolve(fakeRes(payload)); await api.tick() },
    async boom(i, message) { env.pending[i].reject(new Error(message)); await api.tick() },
    stones() { return hosts(forest).filter((n) => n.type === 'svg').length },
    status() { return deepestText(/思考中|轮到|获胜|和棋/) },
    steps() { return deepestText(/步数/) },
    // 「这一手是谁下的」那段说明（EngineNote）。用**它自己的**标记词定位，别用「引擎」
    // 这种到处都有的词 —— 否则最短命中会落到"重载模型"按钮上（踩过）。
    note() { return deepestText(/引擎直落|引擎对手|引擎代打|引擎检测|引擎首选|被引擎否决|一致 ✓|兜底］/) },
    allText,
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
      const hit = byText(label, 'button')[0]
      if (!hit) throw new Error('找不到按钮：' + label)
      hit.props.onClick()
      api.flush()
    },
    clickByKey(reKey, type) {
      const hit = byKey(reKey, type)[0]
      if (!hit) throw new Error('找不到元素（key 匹配 ' + reKey + '）')
      hit.props.onClick ? hit.props.onClick({ target: {} }) : hit.props.onChange({ target: {} })
      api.flush()
    },
    // 设置勾选框（省额度开关）：真用户点的是它
    checkbox() {
      const box = checkbox()
      return box ? { checked: !!box.props.checked, title: String(box.props.title || ''), onChange: box.props.onChange } : null
    },
    toggleCheckbox(next) {
      const box = checkbox()
      if (!box) throw new Error('界面上没有勾选框')
      box.props.onChange({ target: { checked: next === undefined ? !box.props.checked : !!next } })
      api.flush()
    },
    // 模型下拉：换成内置引擎（走 onPick → patch({p2})）
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

export function fakeRes(payload) {
  return {
    ok: true, status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  }
}
