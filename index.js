// ============================================================================
// dsh-gomoku · Host half (v1.0.0)
// 职责只有两件：① 列出你配置的所有 provider 与模型 ② 让指定模型走一步棋。
// 棋盘状态全在客户端，这里不存棋局，保持单一职责。
//
// 两条 HTTP 路由（客户端 fetch 调用，与 dsh-bg-atelier 同套路）：
//   GET  /gomoku/models        模型目录（60 秒内复用；?reload=1 强制刷新）
//   POST /gomoku/move          让某个模型落子，返回 {r,c,fallback,from,...}
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
const CACHE_MS = 60000
// 推理模型给少了会被思考块吃光（64 就吃过一次），512 仍是很便宜的一步棋。
const MAX_TOKENS = 512

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
export function pickMove(text, reasoning, size, cells) {
  const byText = scanCoords(text, size, cells)
  if (byText) return { r: byText.r, c: byText.c, fallback: false, from: 'text' }
  const byThink = scanCoords(reasoning, size, cells)
  if (byThink) return { r: byThink.r, c: byThink.c, fallback: false, from: 'reasoning' }
  let best = null
  for (let i = 0; i < size * size; i++) {
    if (cells[i] !== 0) continue
    const rr = Math.floor(i / size), cc = i % size
    let near = 0
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue
      const nr = rr + dr, nc = cc + dc
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue
      if (cells[nr * size + nc] !== 0) near++
    }
    const mid = size / 2
    const score = near * 10 - (Math.abs(rr - mid) + Math.abs(cc - mid))
    if (!best || score > best.score) best = { r: rr, c: cc, score }
  }
  if (best) return { r: best.r, c: best.c, fallback: true, from: 'fallback' }
  return { r: -1, c: -1, fallback: true, from: 'full' }
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
        if (!provider || !model) throw new Error('没有指定模型（provider/model 为空）')
        if (cells.length !== size * size) throw new Error('棋盘数据不完整')

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
          + `你只能输出一个坐标，格式严格为「行,列」两个整数（从 0 开始，逗号分隔，行在前），`
          + `不要输出解释、标点、代码块或任何多余文字。必须是空点；优先连成五子，其次拦住对方即将成五的点。`

        const user = `当前棋盘：\n${lines.join('\n')}\n\n最近落子（旧→新）：${histTxt}\n请给出你执 ${me} 的落子坐标。`

        let text = ''
        let reasoning = ''
        let usage = null
        let finishKind = null
        const t0 = Date.now()
        const stream = llm.stream({
          provider,
          model,
          system: sys,
          temperature: 0.3,
          maxTokens: MAX_TOKENS,
          messages: [{
            id: 'gomoku-ask',
            role: 'user',
            content: [{ type: 'text', text: user }],
            source: { kind: 'plugin', plugin: 'dsh-gomoku' },
          }],
        })
        for await (const chunk of stream) {
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
        const picked = pickMove(text, reasoning, size, cells)
        if (picked.r < 0) throw new Error('没有可落子的位置（棋盘已满？）')
        sendJson(res, 200, {
          r: picked.r, c: picked.c, fallback: picked.fallback, from: picked.from,
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
