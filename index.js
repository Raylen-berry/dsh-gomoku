// ============================================================================
// dsh-gomoku · Host half (v1.0.0)
// 职责只有两件：① 列出你配置的所有 provider 与模型 ② 让指定模型走一步棋。
// 棋盘状态全在客户端，这里不存棋局，保持单一职责。
//
// 两条 HTTP 路由（客户端 fetch 调用，与 dsh-bg-atelier 同套路）：
//   GET  /gomoku/models        模型目录（60 秒内复用；?reload=1 强制刷新）
//   POST /gomoku/move          让指定模型走一步棋，返回 {r,c,fallback,from,...}
//                              另含可核查的花费标记：modelCalled（这次到底调没调模型）
//                              与 moveSource（这一手是谁下的，界面据此显示来源）。
//
// 省额度开关（POST body 的 saveQuota，默认关）：开着时若本地引擎判定这一手是
// **强制手**（第一候选 urgency ≥ 2：必胜 / 必挡），就直接落引擎的坐标、**不发模型请求**。
// 判据与文末「引擎否决」完全同一个 —— 那种局面模型答什么都会被改回来，那一次
// 调用纯属白花 token。关着（= 模型评测模式）行为与加这个开关之前逐字段一致。
// 开关本身存在客户端（localStorage），host 半仍然不存任何对局/设置状态。
//
// 模型输出解析（这里踩过的坑，别退回去）：
//   StreamChunk 除了 text-delta 还有 **reasoning-delta**。推理模型会先把
//   maxTokens 花在思考块上 —— 只读 text-delta 会拿到空串，被误判成"模型不
//   听话"。所以两者都收，并且把全文里的候选坐标逐个试到第一个合法空点。
// ============================================================================

export const name = 'dsh-gomoku'
export const inject = ['webServer', 'llm']

const MODELS_PATH = '/gomoku/models'
const MOVE_PATH = '/gomoku/move'
const SELFTEST_PATH = '/gomoku/selftest'
const CACHE_MS = 60000
// 推理模型给少了会被思考块吃光（64 就吃过一次），512 仍是很便宜的一步棋。
const MAX_TOKENS = 512
// 默认时间预算（毫秒）：到点就让引擎接着下，别让棋盘干等十几秒。客户端可覆盖，
// 传 0 = 不限时（愿意等慢模型时用）。
const DEFAULT_TIMEOUT_MS = 5000

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

// 在任意文本里扫「行,列」，返回第一个落在棋盘内且为空的点。
function scanCoords(text, size, cells) {
  const re = /(\d{1,2})\s*[,，、;；\s]\s*(\d{1,2})/g
  let m
  while ((m = re.exec(String(text || ''))) !== null) {
    const r = Number(m[1]), c = Number(m[2])
    if (r >= 0 && r < size && c >= 0 && c < size && cells[r * size + c] === 0) return { r, c }
  }
  return null
}

// 正文优先，其次思考块；都没有就贴着已有棋子兜底，绝不把整局卡死。
// ---------------------------------------------------------------------------
// 战术引擎：先算出「值得考虑的候选点」，再让模型在候选里选。
//
// 为什么必须这么做：让 flash 级小模型自己在 225 个空点里找战术，结果基本是
// 随机的（用户原话："你们几个模型怎么都这么弱"）。而「成五 / 挡五 / 活四 /
// 挡活四 / 活三」这些是确定性的事，交给引擎算最可靠 —— 模型只负责在几个
// 好点里挑一个，弱模型的棋力立刻从"乱下"变成"不失手"。
// ---------------------------------------------------------------------------

// 假设 side 落在 (r,c)，这条线能连几个、两端是否还开放。
function lineStats(cells, size, r, c, dr, dc, side) {
  let count = 1
  let open = 0
  for (const sign of [1, -1]) {
    for (let k = 1; k < 5; k++) {
      const rr = r + dr * k * sign
      const cc = c + dc * k * sign
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) break
      const v = cells[rr * size + cc]
      if (v === side) { count++; continue }
      if (v === 0) open++
      break
    }
  }
  return { count, open }
}

// 一条线的价值：五连 >> 活四 > 冲四 > 活三 > 眠三 > 活二 …
export function lineValue(st) {
  if (st.count >= 5) return 1000000
  if (st.count === 4) return st.open >= 1 ? 120000 : 12000
  if (st.count === 3) return st.open === 2 ? 9000 : (st.open === 1 ? 900 : 0)
  if (st.count === 2) return st.open === 2 ? 500 : (st.open === 1 ? 50 : 0)
  return st.open === 2 ? 20 : 2
}

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]]

function pointValue(cells, size, r, c, side) {
  let total = 0
  for (const d of DIRS) total += lineValue(lineStats(cells, size, r, c, d[0], d[1], side))
  return total
}

function reasonFor(atk, def) {
  if (atk >= 1000000) return '你下这里直接连成五子'
  if (def >= 1000000) return '对方下这里就连成五子，必须挡'
  if (atk >= 120000) return '你成活四（两头都能成五）'
  if (def >= 120000) return '挡住对方的活四'
  if (atk >= 12000) return '你成冲四'
  if (def >= 12000) return '挡住对方的冲四'
  if (atk >= 9000) return '你成活三'
  if (def >= 9000) return '挡住对方的活三'
  if (atk >= 500) return '你成活二'
  if (def >= 500) return '限制对方的活二'
  return '贴身扩张'
}

// 只考虑已有棋子附近（空盘则全盘），按「进攻 vs 该点对对方的威胁」排序。
export function rankMoves(cells, size, side, limit) {
  const n = limit || 8
  const foe = side === 1 ? 2 : 1
  let anyStone = false
  for (let i = 0; i < size * size; i++) if (cells[i] !== 0) { anyStone = true; break }
  const cands = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r * size + c] !== 0) continue
      if (anyStone) {
        let near = false
        for (let dr = -2; dr <= 2 && !near; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const rr = r + dr, cc = c + dc
            if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
            if (cells[rr * size + cc] !== 0) { near = true; break }
          }
        }
        if (!near) continue
      }
      const atk = pointValue(cells, size, r, c, side)
      const def = pointValue(cells, size, r, c, foe)
      // max 保证「我的五连」压过一切；对方五连按 0.95 折算 ⇒ 只输给我自己的五连。
      // 剩下的部分给"双向价值"加成，避免只盯一头。
      const hi = Math.max(atk, def * 0.95)
      const lo = Math.min(atk, def * 0.95)
      // 紧急度：≥2 表示"必须先处理这里，否则局面直接崩"——对方的活三/冲四/活四，
      // 以及双方的五连。move 路由据此让引擎在强制手上**压过模型的选择**。
      let urgency = 0
      if (atk >= 1000000) urgency = 5
      else if (def >= 1000000) urgency = 4
      else if (atk >= 120000) urgency = 3
      else if (def >= 120000) urgency = 3
      else if (def >= 9000) urgency = 2
      cands.push({ r, c, score: hi + lo * 0.35, atk, def, urgency, reason: reasonFor(atk, def) })
    }
  }
  cands.sort((a, b) => b.score - a.score)
  return cands.slice(0, n)
}

// 「强」档：在 top 候选上再推一层 —— 我下这里之后，对手最好的一手有多凶？
// 只有一层（不是完整搜索），但足以避免"只顾自己连、把对方活四放出来"这类失手。
export function rankMovesStrong(cells, size, side, limit) {
  const base = rankMoves(cells, size, side, 12)
  const foe = side === 1 ? 2 : 1
  const scored = base.map((m) => {
    const next = cells.slice()
    next[m.r * size + m.c] = side
    const reply = rankMoves(next, size, foe, 1)[0]
    const replyThreat = reply ? Math.max(reply.atk, reply.def * 0.95) : 0
    return { ...m, replyThreat, score: m.score - replyThreat * 0.9 }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

export function pickMove(text, reasoning, size, cells, side) {
  const byText = scanCoords(text, size, cells)
  if (byText) return { r: byText.r, c: byText.c, fallback: false, from: 'text' }
  const byThink = scanCoords(reasoning, size, cells)
  if (byThink) return { r: byThink.r, c: byThink.c, fallback: false, from: 'reasoning' }
  // 模型完全没给出合法坐标时，兜底也用引擎的第一候选（比"就近且靠中心"强得多）。
  const ranked = rankMoves(cells, size, Number(side) === 2 ? 2 : 1, 1)
  if (ranked.length) {
    return { r: ranked[0].r, c: ranked[0].c, fallback: true, from: 'fallback', reason: ranked[0].reason }
  }
  return { r: -1, c: -1, fallback: true, from: 'full' }
}

// ---------------------------------------------------------------------------
// 「强制手」判据（唯一来源，两条路共用它，别让判据各写一遍）：
// rankMoves 的第一候选 urgency ≥ 2 ⇒ 这一手没有讨论余地。按 urgency 的赋值
// （见 rankMoves 里那段），实际覆盖：我先成五（5）、挡对方成五（4）、成活四 /
// 挡对方活四（3）、挡对方活三（2），以及"我的三价值 ≥ 120000"那种成活四形态（3）。
//   ① 省额度模式：开局前先问它，是强制手就**根本不发模型请求**（直接落 engine 的坐标）；
//   ② 评测模式：模型答完之后再问它，是强制手就**否决模型的选择**。
// 同一条判据 ⇒ 省额度模式省掉的每一次调用，都确实是"花了钱也会被改回来"的那一次。
// 注意它**只看第一候选**（既有口径，不是完美强制手识别）：有的局面里"挡对方活三"
// 存在但排在第二，这里就返回 null。评测模式本来也不否决这种局面，两边口径一致。
// ---------------------------------------------------------------------------
const FORCED_URGENCY = 2

export function forcedMove(ranked) {
  const top = ranked && ranked[0]
  return top && Number(top.urgency) >= FORCED_URGENCY ? top : null
}

// 落子来源标记（客户端据此显示「引擎直落 / 模型」）。它是 `from` 的**对外口径**：
// from 说的是"坐标怎么来的"，moveSource 说的是"这一手该记在谁头上、有没有花 token"。
// 顺序要紧：`text`/`reasoning` 先判 —— 只要坐标是模型自己吐出来的，就记在模型头上，
// 绝不因为 modelCalled 的取值把模型下的一步写成"引擎直落"（宁可少标，不可错标）。
export function moveSourceOf(from, modelCalled, overridden) {
  if (from === 'engine') return 'engine-opponent'
  if (from === 'engine-direct') return 'engine-direct'
  if (from === 'engine-timeout') return 'engine-timeout'
  if (from === 'engine-forced') return 'engine-veto'
  if (from === 'text' || from === 'reasoning') return 'model'
  if (overridden) return 'engine-veto'
  if (from === 'fallback' || from === 'full') return 'model-fallback'
  return modelCalled ? 'model' : 'engine-direct'
}

export async function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-gomoku] webServer 服务不存在，路由无法注册')
    return
  }
  const llm = ctx.get('llm')
  if (llm === undefined) {
    console.error('[dsh-gomoku] llm 服务不存在，模型走棋不可用')
  }

  let cache = { at: 0, data: null }

  async function modelDirectory(force) {
    if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data
    if (llm === undefined) return { providers: [], current: null }
    let infos = []
    try { infos = llm.listProviders() || [] } catch (err) { infos = [] }
    const providers = []
    for (const p of infos) {
      let models = []
      try {
        const ms = (await llm.listModels(p.id)) || []
        models = ms.map((m) => ({ id: String(m.id), name: String(m.name || m.id) }))
      } catch (err) { models = [] }
      providers.push({ id: String(p.id), name: String(p.name || p.id), models })
    }
    // 「我 vs 模型」的默认对手 = 本会话当前模型
    let current = null
    try {
      const svc = ctx.get('agentDefaultModel')
      if (svc && typeof svc.currentSelection === 'function') {
        const sel = svc.currentSelection()
        if (sel && sel.provider && sel.model) current = { provider: String(sel.provider), model: String(sel.model) }
      }
    } catch (err) { current = null }
    cache = { at: Date.now(), data: { providers, current } }
    return cache.data
  }

  // ---- 模型体检：逐个模型做一次最小调用，回答"这个模型我的账号到底能不能用" ----
  // 实测价值：moonshotai 目录里列了 10 个模型，其中 5 个是 404（账号无权限），
  // 而 kimi-k2.5 会用 400「temperature」把 404 盖住 —— 不探一次根本看不出来。
  // 探针一律不传 temperature（见 move 路由的注释），maxTokens 给 16 足够回坐标。
  let selftestCache = { at: 0, key: '', data: null }

  async function probeModel(provider, model) {
    if (llm === undefined) return { ok: false, error: 'llm 服务不可用' }
    const t0 = Date.now()
    try {
      let finishKind = null
      for await (const chunk of llm.stream({
        provider,
        model,
        maxTokens: 16,
        messages: [{
          id: 'gomoku-probe',
          role: 'user',
          content: [{ type: 'text', text: '只回两个数字：7,8' }],
          source: { kind: 'plugin', plugin: 'dsh-gomoku' },
        }],
      })) {
        if (chunk.type === 'finish') {
          finishKind = chunk.reason && chunk.reason.kind
          if (finishKind === 'error' || finishKind === 'aborted') {
            const fail = chunk.reason && chunk.reason.failure
            throw new Error((fail && fail.message) || '未知原因')
          }
        }
      }
      return { ok: true, ms: Date.now() - t0, finish: finishKind }
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: String((err && err.message) || err).slice(0, 200) }
    }
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SELFTEST_PATH,
    handler: async (req, res) => {
      try {
        const url = String(req.url || '')
        const provider = decodeURIComponent((url.match(/provider=([^&]+)/) || [])[1] || '')
        if (!provider) { sendJson(res, 400, { ok: false, error: '需要 ?provider=<provider id>' }); return }
        const force = url.includes('force=1')
        if (!force && selftestCache.data && selftestCache.key === provider && Date.now() - selftestCache.at < CACHE_MS) {
          sendJson(res, 200, selftestCache.data)
          return
        }
        const dir = await modelDirectory(false)
        const row = (dir.providers || []).find((p) => p.id === provider)
        if (!row) { sendJson(res, 404, { ok: false, error: '未知 provider：' + provider }); return }
        const results = []
        for (const m of row.models) {
          const r = await probeModel(provider, m.id)
          results.push({ model: m.id, name: m.name, ok: r.ok, ms: r.ms, error: r.error || null })
        }
        const data = {
          provider,
          usable: results.filter((r) => r.ok).length,
          total: results.length,
          results,
        }
        selftestCache = { at: Date.now(), key: provider, data }
        sendJson(res, 200, data)
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-gomoku: selftest route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: MODELS_PATH,
    handler: async (req, res) => {
      try {
        const force = String(req.url || '').includes('reload=1')
        sendJson(res, 200, await modelDirectory(force))
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-gomoku: models route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: MOVE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'use POST' }); return }
      try {
        if (llm === undefined) throw new Error('llm 服务不可用')
        const a = JSON.parse((await readBody(req)) || '{}')
        const size = Math.max(5, Math.min(19, Number(a.size) || 15))
        const cells = Array.isArray(a.cells) ? a.cells : []
        const side = Number(a.side) === 2 ? 2 : 1
        const provider = String(a.provider || '')
        const model = String(a.model || '')
        // 省额度开关：**只认字面 true**（缺省 / 旧客户端不带这个字段 / 任何假值 ⇒ 评测模式）。
        // 这样默认行为与加开关之前完全一样，老客户端也不会被意外改变棋路。
        const saveQuota = a.saveQuota === true
        if (!provider || !model) throw new Error('没有指定模型（provider/model 为空）')
        if (cells.length !== size * size) throw new Error('棋盘数据不完整')

        // 内置引擎对手：不调用任何模型，直接用战术引擎的候选 —— 不花 token、
        // 也不会"乱下"。三档：strong=多推一层对手回应，normal=单层战术，
        // easy=前几手随机（故意会失误，给想赢的人留一档）。
        if (provider === 'engine') {
          const level = (model === 'strong' || model === 'easy') ? model : 'normal'
          const rankedEngine = level === 'strong'
            ? rankMovesStrong(cells, size, side, 3)
            : rankMoves(cells, size, side, 4)
          if (!rankedEngine.length) throw new Error('没有可落子的位置（棋盘已满？）')
          const pickIdx = level === 'easy' ? Math.floor(Math.random() * Math.min(4, rankedEngine.length)) : 0
          const mv = rankedEngine[pickIdx]
          const label = level === 'strong' ? '引擎·强' : (level === 'easy' ? '引擎·轻' : '引擎·标准')
          sendJson(res, 200, {
            r: mv.r, c: mv.c, fallback: false, from: 'engine',
            moveSource: 'engine-opponent', modelCalled: false, saveQuota: saveQuota,
            engine: { r: mv.r, c: mv.c, reason: mv.reason },
            agreedWithEngine: pickIdx === 0, candidates: rankedEngine.slice(0, 3),
            text: '', reasoning: '', finishKind: 'engine', usage: null, ms: 0, name: label,
          })
          return
        }

        const me = side === 1 ? 'X（黑，先手）' : 'O（白，后手）'
        const lines = []
        for (let r = 0; r < size; r++) {
          let s = ''
          for (let c = 0; c < size; c++) {
            const v = cells[r * size + c]
            s += v === 1 ? 'X' : (v === 2 ? 'O' : '.')
          }
          lines.push(s)
        }
        const hist = Array.isArray(a.history) ? a.history.slice(-30) : []
        const histTxt = hist.length
          ? hist.map((mv) => `(${mv.r},${mv.c})${Number(mv.side) === 1 ? 'X' : 'O'}`).join(' ')
          : '无'

        const sys = `你正在下一盘 ${size}×${size} 的五子棋，你执 ${me}。`
          + `棋盘以 ${size} 行文本表示：X=黑子 O=白子 .=空点，第 0 行在最上面，每行第 0 列在最左边。`
          + `下面还会给你一份「引擎已经算过的候选点」清单（按战术价值排序并写了理由）：`
          + `优先直接采用清单里第 1 个点；只有在你有更充分的理由时才自己另给坐标。`
          + `你只能输出一个坐标，格式严格为「行,列」两个整数（从 0 开始，逗号分隔，行在前），`
          + `不要输出解释、标点、代码块或任何多余文字。必须是空点。`

        const ranked = rankMoves(cells, size, side, 8)
        // 引擎当前认为的「最好一手」= 提示词里的第 1 候选 = 强制手时真正落下的点。
        // 原来这行在模型答完之后就还算一遍；提到模型调用**之前**是为了让省额度模式
        // 能先判断、再决定要不要花钱（评测模式取值与原来逐字节相同，ranked 不随模型输出变）。
        const engine = ranked.length ? { r: ranked[0].r, c: ranked[0].c, reason: ranked[0].reason } : null
        // 强制手：与文末「引擎否决」共用同一个判据 forcedMove()，两处不可能跑偏。
        const forced = forcedMove(ranked)
        // 时间预算：慢的原因不是网络，是**推理模型的思考**（实测 deepseek-v4-flash 2.6s /
        // v4-pro 8.9s / kimi-k3 12.1s，且前两者把 512 个 maxTokens 全烧在思考块上）。
        // 与其让棋盘干等十几秒，不如给个预算：超时就用引擎当前的第一候选接着下，
        // 并在响应里如实标 timedOut —— 模型下得慢是模型的事，不该让对局卡住。
        const timeoutMs = a.timeoutMs === 0 ? 0 : Math.max(300, Math.min(60000, Number(a.timeoutMs) || DEFAULT_TIMEOUT_MS))

        // ---- 省额度模式：引擎已经决定的一手，直接落，不发模型请求 ----------------
        // 这一支只在 saveQuota === true 且这一手是强制手时才走；落点与评测模式
        // （问完模型再否决）完全同一个坐标 —— 省的是 token，不是棋力。
        // 见 tools/verify-quota.mjs 的断言：ON/OFF 两档在同一局面上落点必须相同。
        if (saveQuota && forced) {
          sendJson(res, 200, {
            r: forced.r, c: forced.c, fallback: false, from: 'engine-direct',
            moveSource: 'engine-direct', modelCalled: false, saveQuota: true,
            timedOut: false, timeoutMs: timeoutMs,
            overridden: false, modelChoice: null,
            engine: engine,
            agreedWithEngine: true,
            candidates: ranked.slice(0, 3),
            text: '', reasoning: '', finishKind: 'engine-direct', usage: null, ms: 0,
            name: String(a.name || model),
          })
          return
        }

        const candTxt = ranked.length
          ? ranked.map((m, i) => `${i + 1}. [${m.r},${m.c}] ${m.reason}`).join('\n')
          : '（棋盘还是空的，下中心附近即可）'

        const user = `当前棋盘：\n${lines.join('\n')}\n\n最近落子（旧→新）：${histTxt}\n\n`
          + `引擎候选点（越靠前越好）：\n${candTxt}\n\n请给出你执 ${me} 的落子坐标（只回「行,列」）。`

        let text = ''
        let reasoning = ''
        let usage = null
        let finishKind = null
        // 时间预算到点就 abort（timeoutMs 的判据见上面与省额度早退共用的那一行）。
        const t0 = Date.now()
        const ac = new AbortController()
        let timedOut = false
        const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; try { ac.abort() } catch (e) {} }, timeoutMs) : null
        try {
          for await (const chunk of llm.stream({
            provider,
            model,
            system: sys,
            // 不传 temperature：Kimi 系列只接受它们各自规定的值（k2.6/k2.5 要 0.6，
            // k2.7/k3 要 1），传 0.3 会被 400 直接拒掉。不传则用服务端默认值，
            // 三个 provider 全部可用。
            maxTokens: MAX_TOKENS,
            signal: ac.signal,
            messages: [{
              id: 'gomoku-ask',
              role: 'user',
              content: [{ type: 'text', text: user }],
              source: { kind: 'plugin', plugin: 'dsh-gomoku' },
            }],
          })) {
            if (chunk.type === 'text-delta') text += chunk.text
            else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
            else if (chunk.type === 'usage') {
              usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens, reasoningTokens: chunk.usage.reasoningTokens }
            } else if (chunk.type === 'finish') {
              finishKind = chunk.reason && chunk.reason.kind
              if (finishKind === 'error' || finishKind === 'aborted') {
                const fail = chunk.reason && chunk.reason.failure
                throw new Error((finishKind === 'aborted' ? '调用被中断：' : '模型调用失败：') + ((fail && fail.message) || '未知原因'))
              }
            }
          }
        } catch (err) {
          // 只有"预算到点"才吞掉这次异常；真出错照旧抛给客户端
          if (!timedOut) throw err
          finishKind = 'timeout'
        } finally {
          if (timer) clearTimeout(timer)
        }

        let picked
        if (timedOut) {
          picked = engine
            ? { r: engine.r, c: engine.c, fallback: false, from: 'engine-timeout', reason: engine.reason }
            : { r: -1, c: -1, fallback: true, from: 'full' }
        } else {
          picked = pickMove(text, reasoning, size, cells, side)
        }
        const modelPick = { r: picked.r, c: picked.c }
        // 强制手否决：引擎判定"必须先处理这里"时（对方活三/冲四/活四、双方五连），
        // 不让模型的选择改变结论 —— 用户实测反馈过"我明显有活三它却不堵"，
        // 这种局面不是该信任模型的地方。
        // 判据与上面省额度早退用的**是同一个** forced（ranked[0].urgency ≥ 2）：
        // 评测模式在这里"答完再改"，省额度模式在那里"根本不问"，落点必然相同。
        let overridden = false
        if (!timedOut && forced) {
          const same = picked.r === engine.r && picked.c === engine.c
          if (!same) {
            overridden = true
            picked = { r: engine.r, c: engine.c, fallback: false, from: 'engine-forced', reason: engine.reason }
          }
        }
        if (picked.r < 0) throw new Error('没有可落子的位置（棋盘已满？）')
        const modelCalled = true
        sendJson(res, 200, {
          r: picked.r, c: picked.c, fallback: picked.fallback, from: picked.from,
          moveSource: moveSourceOf(picked.from, modelCalled, overridden),
          modelCalled: modelCalled, saveQuota: saveQuota,
          timedOut, timeoutMs: timeoutMs,
          overridden, modelChoice: overridden ? modelPick : null,
          engine: engine,
          agreedWithEngine: !!(engine && engine.r === picked.r && engine.c === picked.c),
          candidates: ranked.slice(0, 3),
          text: String(text || '').slice(0, 200),
          reasoning: String(reasoning || '').slice(0, 200),
          finishKind, usage, ms: Date.now() - t0,
          name: String(a.name || model),
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-gomoku: move route')

  console.log('[dsh-gomoku] host up (v1.0.0)')
}
