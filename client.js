// ============================================================================
// dsh-gomoku · Client half (v1.0.0)
// 会话页「小游戏」标签页 + 右下角可收起浮窗，两个界面共享同一盘棋。
//
// 玩法：
//   我 vs 模型       —— 你执黑先手，选任意已配置模型执白
//   模型 vs 模型     —— 黑白双方各选一个模型，自动对局
//   我 vs 我（双人） —— 同机两人轮流
//
// 模型走棋的真身（host 半）：把棋盘转成 15 行文本发给模型，只要它回一个
// 「行,列」。模型不听话时贴着已有棋子兜底落一个，并提示原因，不会卡死整局。
//
// 跨机迁移提醒（详见 README）：
//   本插件的 client 半在 **DSH 启动时** 与其它插件一起 compose ⇒ 装完必须
//   重启 DSH Desktop 才会出现「小游戏」标签页；不需要任何浏览器扩展。
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-gomoku',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var SIZE = 15
    var MODELS_PATH = '/gomoku/models'
    var MOVE_PATH = '/gomoku/move'

    function emptyCells() {
      var a = []
      for (var i = 0; i < SIZE * SIZE; i++) a.push(0)
      return a
    }

    // 五子在四方向上连成即胜。
    function winnerAt(cells, r, c, side) {
      var dirs = [[0, 1], [1, 0], [1, 1], [1, -1]]
      for (var d = 0; d < dirs.length; d++) {
        var n = 1
        for (var k = 1; k < 5; k++) {
          var rr = r + dirs[d][0] * k, cc = c + dirs[d][1] * k
          if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE || cells[rr * SIZE + cc] !== side) break
          n++
        }
        for (var k2 = 1; k2 < 5; k2++) {
          var rr2 = r - dirs[d][0] * k2, cc2 = c - dirs[d][1] * k2
          if (rr2 < 0 || cc2 < 0 || rr2 >= SIZE || cc2 >= SIZE || cells[rr2 * SIZE + cc2] !== side) break
          n++
        }
        if (n >= 5) return true
      }
      return false
    }

    // host 路由往返：非 2xx 一律抛出带响应片段的错误，界面上能看到原因。
    function api(path, options) {
      return fetch(path, options).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            throw new Error('HTTP ' + r.status + '：' + String(t || '').slice(0, 160))
          })
        }
        return r.json()
      })
    }

    function apply(ctx) {
      var slots = ctx.slots
      var SEP = '\u0000'

      // ---------------- 共享状态（模块级，页内两个界面同源） ----------------
      var S = {
        cells: emptyCells(), turn: 1, status: 'playing', winner: 0,
        history: [], mode: 'human-model',
        p1: null, p2: null,
        dir: null, current: null,
        busy: false, thinking: '', err: '', last: null,
        open: false, collapsed: false,
        gen: 0,
      }
      var subs = []
      function notify() { for (var i = 0; i < subs.length; i++) { try { subs[i]() } catch (e) {} } }
      function patch(p) { for (var k in p) S[k] = p[k]; notify() }

      function useGame() {
        var pair = React.useState(0)
        var force = pair[1]
        React.useEffect(function () {
          var fn = function () { force(function (x) { return x + 1 }) }
          subs.push(fn)
          return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1) }
        }, [])
        return S
      }

      function labelOf(side) {
        if (S.mode === 'human-model' && side === 1) return '我'
        if (S.mode === 'human-human') return side === 1 ? '黑方' : '白方'
        var m = side === 1 ? S.p1 : S.p2
        if (!m) return side === 1 ? '黑方（未选模型）' : '白方（未选模型）'
        return m.name || (m.provider + '/' + m.model)
      }

      function isAI(side) {
        if (S.mode === 'model-model') return true
        if (S.mode === 'human-human') return false
        return side === 2
      }

      function reset() {
        patch({
          cells: emptyCells(), turn: 1, status: 'playing', winner: 0, history: [],
          busy: false, thinking: '', err: '', last: null, gen: S.gen + 1,
        })
      }

      function place(r, c, side) {
        if (S.status !== 'playing') return false
        if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return false
        if (S.cells[r * SIZE + c] !== 0) return false
        var cells = S.cells.slice()
        cells[r * SIZE + c] = side
        var win = winnerAt(cells, r, c, side)
        var full = true
        for (var i = 0; i < cells.length; i++) if (cells[i] === 0) { full = false; break }
        var hist = S.history.concat([{ r: r, c: c, side: side }])
        patch({
          cells: cells, history: hist, last: { r: r, c: c },
          status: win ? 'won' : (full ? 'draw' : 'playing'),
          winner: win ? side : 0,
          turn: (win || full) ? S.turn : (side === 1 ? 2 : 1),
        })
        return true
      }

      // 「我 vs 模型」撤销就退两步（你和它各一步），双人/机机只退一步。
      function undo() {
        if (S.busy || !S.history.length) return
        var hist = S.history.slice()
        var steps = S.mode === 'human-model' ? Math.min(2, hist.length) : 1
        var cells = S.cells.slice()
        for (var i = 0; i < steps; i++) {
          var mv = hist.pop()
          if (mv) cells[mv.r * SIZE + mv.c] = 0
        }
        var last = hist.length ? hist[hist.length - 1] : null
        patch({
          cells: cells, history: hist, last: last, winner: 0, status: 'playing', err: '',
          turn: hist.length ? (hist[hist.length - 1].side === 1 ? 2 : 1) : 1,
          gen: S.gen + 1,
        })
      }

      function loadModels(reload) {
        var url = reload ? MODELS_PATH + '?reload=1' : MODELS_PATH
        return api(url).then(function (r) {
          var dir = (r && r.providers) || []
          var first = null
          for (var i = 0; i < dir.length; i++) {
            var ms = dir[i].models || []
            if (ms.length) { first = { provider: dir[i].id, model: ms[0].id, name: ms[0].name || ms[0].id }; break }
          }
          var cur = (r && r.current) ? { provider: r.current.provider, model: r.current.model, name: '本会话模型（我）' } : null
          patch({ dir: dir, current: cur, p1: S.p1 || cur || first, p2: S.p2 || first, err: '' })
        }).catch(function (e) {
          patch({ err: '取模型列表失败：' + String((e && e.message) || e) })
        })
      }

      function aiMove(side, gen) {
        var m = side === 1 ? S.p1 : S.p2
        if (!m) { patch({ err: '请先为该方选一个模型' }); return Promise.resolve() }
        S.busy = true
        patch({ busy: true, thinking: labelOf(side) + ' 思考中…', err: '' })
        var hist = []
        for (var i = 0; i < S.history.length; i++) hist.push({ r: S.history[i].r, c: S.history[i].c, side: S.history[i].side })
        return api(MOVE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: m.provider, model: m.model, name: m.name || m.model,
            side: side, size: SIZE, cells: S.cells, history: hist,
          }),
        }).then(function (res) {
          if (gen !== S.gen) return
          var ok = place(res.r, res.c, side)
          if (!ok) {
            patch({ err: '模型给的位置不可落子：(' + res.r + ',' + res.c + ')' })
          } else if (res.fallback) {
            var raw = String(res.text || '').trim() || String(res.reasoning || '').trim()
            var why = res.finishKind === 'max-tokens' ? '令牌被思考吃完了' : (raw ? '输出里没有合法坐标' : '模型没输出内容')
            patch({ err: (res.name || '模型') + '：' + why + (raw ? '（' + raw.slice(0, 20) + '…）' : '') + '，已兜底落子' })
          }
        }).catch(function (e) {
          if (gen === S.gen) patch({ err: String((e && e.message) || e) })
        }).then(function () {
          S.busy = false
          patch({ busy: false, thinking: '' })
        })
      }

      // 轮到 AI 就自动走子；S.busy 兼作同步闸，两个界面同开也不会抢着走。
      function useAutoPlay(g) {
        React.useEffect(function () {
          if (g.status !== 'playing' || S.busy) return
          if (!isAI(g.turn)) return
          var gen = g.gen
          var side = g.turn
          aiMove(side, gen).then(function () {
            if (S.mode === 'model-model' && gen === S.gen) return ctx.timeout(function () {}, 450)
          })
        }, [g.turn, g.status, g.gen, g.mode, g.p1 && g.p1.model, g.p2 && g.p2.model])
      }

      // ---------------- 组件 ----------------
      // 棋盘几何：棋子落在**线的交点**上（不是格子内）。
      // step = 相邻交点间距，pad = 边距（让最外圈棋子的边缘不被裁掉）。
      var STARS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]

      function stoneNode(v, d, isLast, left, top, key) {
        var st = {
          position: 'absolute', left: left + 'px', top: top + 'px',
          width: d + 'px', height: d + 'px', borderRadius: '50%',
          background: v === 1 ? '#1b1b1f' : '#f7f7fa',
          boxShadow: isLast ? '0 0 0 2px #e5534b' : '0 1px 2px rgba(0,0,0,.35)',
          pointerEvents: 'none',
        }
        if (v === 2) st.border = '1px solid rgba(0,0,0,.35)'
        return h('div', { key: key, style: st })
      }

      function Board(props) {
        var g = useGame()
        var step = props.compact ? 17 : 22
        var pad = props.compact ? 11 : 14
        var span = (SIZE - 1) * step
        var size = span + pad * 2
        var d = step - 3
        var layers = []
        var i, r, c, v

        // 15 条横线 + 15 条竖线（最外圈略粗，像木盘的边线）
        for (i = 0; i < SIZE; i++) {
          var edge = (i === 0 || i === SIZE - 1)
          var pos = pad + i * step
          layers.push(h('div', {
            key: 'h' + i,
            style: {
              position: 'absolute', left: pad + 'px', top: pos + 'px',
              width: span + 'px', height: edge ? '1.5px' : '1px',
              background: edge ? 'rgba(72,46,16,.78)' : 'rgba(90,60,20,.5)',
              pointerEvents: 'none',
            },
          }))
          layers.push(h('div', {
            key: 'v' + i,
            style: {
              position: 'absolute', left: pos + 'px', top: pad + 'px',
              height: span + 'px', width: edge ? '1.5px' : '1px',
              background: edge ? 'rgba(72,46,16,.78)' : 'rgba(90,60,20,.5)',
              pointerEvents: 'none',
            },
          }))
        }
        // 星位（含天元）
        for (i = 0; i < STARS.length; i++) {
          layers.push(h('div', {
            key: 's' + i,
            style: {
              position: 'absolute',
              left: (pad + STARS[i][1] * step - 2) + 'px',
              top: (pad + STARS[i][0] * step - 2) + 'px',
              width: '4px', height: '4px', borderRadius: '50%',
              background: 'rgba(72,46,16,.85)', pointerEvents: 'none',
            },
          }))
        }
        // 落子热区：step×step 的方块，方块中心正好压在交点上
        for (r = 0; r < SIZE; r++) {
          for (c = 0; c < SIZE; c++) {
            v = g.cells[r * SIZE + c]
            var canPlay = g.status === 'playing' && !isAI(g.turn) && v === 0 && !g.busy
            var onClick = null
            if (canPlay) onClick = (function (rr, cc, turn) { return function () { place(rr, cc, turn) } })(r, c, g.turn)
            layers.push(h('div', {
              key: 'z' + r + '_' + c,
              onClick: onClick,
              style: {
                position: 'absolute',
                left: (pad + c * step - step / 2) + 'px',
                top: (pad + r * step - step / 2) + 'px',
                width: step + 'px', height: step + 'px',
                cursor: canPlay ? 'pointer' : 'default',
              },
            }))
          }
        }
        // 棋子：圆心 = 交点
        for (r = 0; r < SIZE; r++) {
          for (c = 0; c < SIZE; c++) {
            v = g.cells[r * SIZE + c]
            if (v === 0) continue
            var last = !!(g.last && g.last.r === r && g.last.c === c)
            layers.push(stoneNode(v, d, last,
              pad + c * step - d / 2, pad + r * step - d / 2, 'p' + r + '_' + c))
          }
        }
        return h('div', {
          style: {
            position: 'relative', width: size + 'px', height: size + 'px', flex: 'none',
            background: '#e8c88f', borderRadius: '6px',
            boxShadow: '0 2px 10px rgba(0,0,0,.35)', userSelect: 'none',
          },
        }, layers)
      }

      function ModelPick(props) {
        var g = useGame()
        var dir = g.dir || []
        var val = props.value ? props.value.provider + SEP + props.value.model : ''
        var opts = [h('option', { key: '_', value: '' }, '选择模型…')]
        if (props.allowCurrent && g.current) opts.push(h('option', { key: '_cur', value: 'cur' }, '本会话模型（我）'))
        var byKey = {}
        for (var i = 0; i < dir.length; i++) {
          var p = dir[i]
          var ms = p.models || []
          for (var j = 0; j < ms.length; j++) {
            var key = p.id + SEP + ms[j].id
            byKey[key] = { provider: p.id, model: ms[j].id, name: ms[j].name || ms[j].id }
            opts.push(h('option', { key: key, value: key }, p.name + ' · ' + (ms[j].name || ms[j].id)))
          }
        }
        var style = {
          maxWidth: '196px', fontSize: '11px', padding: '2px 4px', borderRadius: '5px',
          border: '1px solid rgba(127,127,127,.35)',
          background: 'var(--dsw-alias-bg-layer-1, #26262b)', color: 'inherit',
        }
        return h('select', {
          value: val, style: style,
          onChange: function (e) {
            var v = e.target.value
            if (v === 'cur') { props.onPick(g.current || null); return }
            if (!v) { props.onPick(null); return }
            props.onPick(byKey[v] || null)
          },
        }, opts)
      }

      function StatusLine(props) {
        var g = useGame()
        var txt
        if (g.status === 'won') txt = '🏆 ' + labelOf(g.winner) + ' 获胜'
        else if (g.status === 'draw') txt = '和棋（棋盘已满）'
        else if (g.busy) txt = '⏳ ' + (g.thinking || '思考中…')
        else txt = '轮到 ' + labelOf(g.turn) + (isAI(g.turn) ? '' : '（点棋盘落子）')
        var style = { fontSize: props.compact ? '11px' : '12px', color: 'var(--dsw-alias-label-secondary, #a9a9b3)', lineHeight: 1.6 }
        return h('div', { style: style }, txt,
          g.err ? h('div', { style: { color: 'var(--dsw-alias-label-warning, #b8860b)' } }, g.err) : null)
      }

      function btnStyle(disabled) {
        return {
          fontSize: '11px', padding: '3px 8px', borderRadius: '6px', cursor: disabled ? 'default' : 'pointer',
          border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
          opacity: disabled ? 0.5 : 1,
        }
      }

      function Controls(props) {
        var g = useGame()
        function btn(label, onClick, disabled, title) {
          return h('button', { onClick: onClick, disabled: !!disabled, title: title || '', style: btnStyle(!!disabled) }, label)
        }
        var selStyle = {
          fontSize: '11px', padding: '2px 4px', borderRadius: '5px',
          border: '1px solid rgba(127,127,127,.35)',
          background: 'var(--dsw-alias-bg-layer-1, #26262b)', color: 'inherit',
        }
        var modeSel = h('select', {
          value: g.mode, style: selStyle,
          onChange: function (e) { patch({ mode: e.target.value }); reset() },
        }, [
          h('option', { key: 'a', value: 'human-model' }, '我 vs 模型'),
          h('option', { key: 'b', value: 'model-model' }, '模型 vs 模型'),
          h('option', { key: 'c', value: 'human-human' }, '我 vs 我（双人）'),
        ])
        var row1 = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          modeSel,
          btn('新局', reset),
          btn('悔棋', undo, !g.history.length || g.busy),
          btn('重载模型', function () { loadModels(true) }),
          props.compact
            ? btn('收起', function () { patch({ collapsed: true }) })
            : btn(g.open ? '收起浮窗' : '弹出小窗', function () { patch({ open: !S.open, collapsed: false }) }))
        var pickers = null
        if (!props.compact && g.mode !== 'human-human') {
          var isMM = g.mode === 'model-model'
          var firstLabel = isMM ? '黑方：' : '我执黑 · 对手：'
          var firstPick = isMM
            ? h(ModelPick, { value: g.p1, allowCurrent: true, onPick: function (v) { patch({ p1: v }) } })
            : h(ModelPick, { value: g.p2, allowCurrent: true, onPick: function (v) { patch({ p2: v || g.current }) } })
          var second = null
          if (isMM) {
            second = h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              h('span', { style: { color: 'var(--dsw-alias-label-secondary, #a9a9b3)' } }, '白方：'),
              h(ModelPick, { value: g.p2, allowCurrent: true, onPick: function (v) { patch({ p2: v }) } }))
          }
          pickers = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', fontSize: '11px' } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary, #a9a9b3)' } }, firstLabel),
            firstPick,
            second)
        }
        var meta = h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #8a8a93)' } },
          '步数 ' + g.history.length + ' · ' + (g.dir ? g.dir.length + ' 个 provider' : '模型列表未加载'))
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, row1, pickers, meta)
      }

      function GameView() {
        var g = useGame()
        useAutoPlay(g)
        React.useEffect(function () { if (!S.dir) loadModels(false) }, [])
        var left = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' } },
          h(Board, {}), h(StatusLine, {}))
        var hint = h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #8a8a93)', lineHeight: 1.7 } },
          '模型走棋 = 用你已配置的模型直接调一次 LLM：把棋盘当文本发过去，只回一个「行,列」。',
          h('div', null, '模型不听话时贴着已有棋子兜底落一个，并说明原因，不会卡死整局。'),
          g.open ? null : h('div', null, '想让棋盘跟着你走，点「弹出小窗」；浮窗标题栏点一下可收起。'))
        var right = h('div', { style: { width: '270px', display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: { fontSize: '13px', fontWeight: 600 } }, '五子棋 · 小游戏'),
          h(Controls, {}), hint)
        return h('div', {
          style: { padding: '16px 18px', display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'center' },
        }, left, right)
      }

      function FloatingGame() {
        var g = useGame()
        useAutoPlay(g)
        React.useEffect(function () { if (S.open && !S.dir) loadModels(false) }, [g.open])
        if (!g.open) return null
        // shell.overlay 整层是 click-through 的，浮窗自己要把指针事件收回来。
        var head = h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
            padding: '4px 8px', background: 'rgba(127,127,127,.14)', fontSize: '11.5px',
            pointerEvents: 'auto',
          },
          onClick: function () { patch({ collapsed: !S.collapsed }) },
        },
          h('span', null, '♟ 五子棋'),
          h('span', { style: { flex: 1 } }),
          h('span', { title: '收起/展开' }, g.collapsed ? '▴' : '▾'),
          h('span', {
            title: '关闭浮窗', style: { padding: '0 4px' },
            onClick: function (e) { e.stopPropagation(); patch({ open: false }) },
          }, '×'))
        var body = h('div', { style: { padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'auto' } },
          h(StatusLine, { compact: true }),
          h('div', { style: { display: 'flex', justifyContent: 'center' } }, h(Board, { compact: true })),
          h(Controls, { compact: true }))
        return h('div', {
          style: {
            position: 'fixed', right: '14px', bottom: '14px', zIndex: 2147483000,
            width: 'min(330px, 92vw)', maxHeight: '82vh', overflow: 'auto',
            background: 'var(--dsw-alias-bg-layer-2, #1f1f25)', color: 'var(--dsw-alias-label-primary, #e8e8ee)',
            border: '1px solid rgba(127,127,127,.35)', borderRadius: '10px',
            boxShadow: '0 10px 30px rgba(0,0,0,.45)', pointerEvents: 'auto',
          },
        }, head, g.collapsed ? null : body)
      }

      slots.inject('conversation.view', function () {
        return slots.register(
          { name: 'conversation.view', id: 'gomoku-mini-games', order: 25, label: '小游戏' },
          function () { return h(GameView) })
      })
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'gomoku-float', order: 40, label: '五子棋浮窗' },
          function () { return h(FloatingGame) })
      })

      console.log('[dsh-gomoku] client up (v1.0.0)')
    }

    var inject = ['slots', 'timer']

    exports.apply = apply
    exports.inject = inject
    // 测试缝：tools/ 下的离线脚本用它验证胜负判定与坐标解析，不必开浏览器。
    exports.internals = {
      SIZE: SIZE,
      winnerAt: winnerAt,
      emptyCells: emptyCells,
    }
    return module.exports
  },
})
