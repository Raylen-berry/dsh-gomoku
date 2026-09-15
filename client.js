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
    var SELFTEST_PATH = '/gomoku/selftest'

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

    // 棋盘几何：棋子落在**线的交点**上（不是格子内）。放在模块级是为了让
    // tools/verify-gomoku.mjs 能离线取到它 —— 位置只有这一个来源，于是
    // 「网格线位置 = 落子热区中心 = 棋子圆心」三者恒等，不可能各算各的。
    //
    // 直径取 20 / 16（而不是 19 / 14）：这套环境的 devicePixelRatio = 1.25，
    // 19px 会落在 23.75 个设备像素上 —— **分数设备像素下 Chrome 会把
    // border-radius:50% 栅格成圆角方形**（实测填充率 0.830，正圆应 0.785；
    // 60px 的对照组是 0.781）。20×1.25 = 25、16×1.25 = 20 都是整数设备像素。
    var STARS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]

    function boardGeom(compact) {
      var step = compact ? 17 : 22
      var pad = compact ? 11 : 14
      return {
        step: step,
        pad: pad,
        span: (SIZE - 1) * step,
        size: (SIZE - 1) * step + pad * 2,
        stone: compact ? 16 : 20,
      }
    }

    // 棋子形状（纯函数）。**用 SVG <circle> 画，不用 border-radius**：
    // ① 真矢量圆，不受分数设备像素的栅格化怪癖影响；
    // ② r 与描边宽度一起算好，圆整体落在 d×d 之内，圆心永远在 d/2。
    function stoneShape(v, d, isLast) {
      var sw = isLast ? 2 : 1
      return {
        r: d / 2 - sw / 2,
        cx: d / 2,
        cy: d / 2,
        strokeWidth: sw,
        stroke: isLast ? '#e5534b' : (v === 2 ? 'rgba(0,0,0,.35)' : 'none'),
        fill: v === 1 ? '#1b1b1f' : '#f7f7fa',
      }
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

    // ---------------- 设置持久化 ----------------
    // 与同族插件（dsh-note-changes / dsh-browser-live）同口径：client 侧的开关记在
    // localStorage，host 半仍然不存任何对局/设置状态（见 index.js 文件头的单一职责）。
    // key 前缀 = 插件 id，避免与宿主/别的插件撞名。
    //
    // 为什么只有这一个开关落盘、而棋盘依旧不落盘：棋盘是"这一局"的数据，
    // 换局就作废；开关是"这台机器上你想怎么花额度"的偏好，重启后还得管用。
    var SETTINGS_PREFIX = 'dsh-gomoku:'
    var SAVE_QUOTA_KEY = SETTINGS_PREFIX + 'save-quota'

    function loadFlag(key, dflt) {
      try {
        var raw = window.localStorage.getItem(key)
        if (raw === '1') return true
        if (raw === '0') return false
      } catch (err) { /* localStorage 不可用（无痕/被禁）⇒ 回到默认值 */ }
      return dflt
    }

    function saveFlag(key, value) {
      try { window.localStorage.setItem(key, value ? '1' : '0') } catch (err) { /* 存不上就用内存值 */ }
    }

    // 落子来源的**前端兜底**（host 半有同名的 moveSourceOf，两边口径一致）：
    // host 的响应里已经带了 moveSource，正常情况直接用它的；这里只在老 host
    // （响应里还没有 moveSource）时按同一套规则补一个，免得界面上出现"来源空白"。
    // 顺序与 host 半一致：坐标是模型自己吐出来的（text/reasoning）就记在模型头上。
    function moveSourceOf(from, modelCalled, overridden) {
      if (from === 'engine') return 'engine-opponent'
      if (from === 'engine-direct') return 'engine-direct'
      if (from === 'engine-timeout') return 'engine-timeout'
      if (from === 'engine-forced') return 'engine-veto'
      if (from === 'text' || from === 'reasoning') return 'model'
      if (overridden) return 'engine-veto'
      if (from === 'fallback' || from === 'full') return 'model-fallback'
      return modelCalled ? 'model' : 'engine-direct'
    }

    // 来源标记 ⇒ 人话（界面上的"引擎直落"就是它）
    function sourceLabel(src) {
      if (src === 'engine-direct') return '⚙ 引擎直落（没花 token）'
      if (src === 'engine-opponent') return '⚙ 引擎对手（不花 token）'
      if (src === 'engine-timeout') return '⚙ 超时改由引擎代打'
      if (src === 'engine-veto') return '⚙ 模型想下的被引擎否决'
      if (src === 'model-fallback') return '模型没给出合法坐标，引擎兜底'
      if (src === 'model') return '模型'
      return ''
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
        engine: null, modelMove: null, check: null, checking: false,
        budget: 5000,
        // 省额度模式：初值取自 localStorage（默认关）。它只在**冷启动**读一次，
        // 之后由勾选框改；改一下就写盘，于是重启后还是这个值。
        saveQuota: loadFlag(SAVE_QUOTA_KEY, false),
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

      // 体检当前对手模型所属 provider 下的所有模型（哪个账号真能用，一目了然）。
      function runSelftest() {
        var m = S.p2 || S.p1
        if (!m) { patch({ err: '先选一个模型（体检按 provider 逐个试）' }); return Promise.resolve() }
        if (m.provider === 'engine') { patch({ err: '内置引擎不走网络，不需要体检' }); return Promise.resolve() }
        patch({ checking: true, check: null, err: '' })
        return api(SELFTEST_PATH + '?provider=' + encodeURIComponent(m.provider) + '&force=1')
          .then(function (r) { patch({ check: r, checking: false }) })
          .catch(function (e) { patch({ checking: false, err: '体检失败：' + String((e && e.message) || e) }) })
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
            timeoutMs: S.budget,
            // 省额度开关：true 时 host 在**强制手**上直接落引擎坐标、不发模型请求。
            // 内置引擎那几档（provider='engine'）host 根本不看这个字段，带上也无害。
            saveQuota: S.saveQuota === true,
          }),
        }).then(function (res) {
          if (gen !== S.gen) return
          var ok = place(res.r, res.c, side)
          patch({
            engine: res.engine || null,
            modelMove: {
              r: res.r, c: res.c, name: res.name || '模型',
              same: !!res.agreedWithEngine, fallback: !!res.fallback,
              timedOut: !!res.timedOut, timeoutMs: res.timeoutMs,
              overridden: !!res.overridden,
              modelR: res.modelChoice ? res.modelChoice.r : null,
              modelC: res.modelChoice ? res.modelChoice.c : null,
              reason: res.engine ? res.engine.reason : '',
              // 这一手是谁下的：host 给 moveSource 就用它；老 host（没这个字段）上
              // 仍然由 moveSourceOf 的同一套口径在前端兜底，界面上不会出现空白来源。
              source: res.moveSource || moveSourceOf(res.from, !!res.modelCalled, !!res.overridden),
            },
          })
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
          // 收闸这一步也必须按局号守门：S.busy 兼作自动走子的同步闸（见 useAutoPlay），
          // 旧局的请求落地时若把新局的闸清掉，新局那一手会被再放进一次请求。
          if (gen !== S.gen) return
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
      function stoneNode(v, d, isLast, left, top, key) {
        var sh = stoneShape(v, d, isLast)
        return h('svg', {
          key: key,
          width: d, height: d, viewBox: '0 0 ' + d + ' ' + d,
          shapeRendering: 'geometricPrecision',
          style: {
            position: 'absolute', left: left + 'px', top: top + 'px',
            width: d + 'px', height: d + 'px', display: 'block',
            pointerEvents: 'none',
          },
        }, h('circle', {
          cx: sh.cx, cy: sh.cy, r: sh.r,
          fill: sh.fill, stroke: sh.stroke, strokeWidth: sh.strokeWidth,
        }))
      }

      function Board(props) {
        var g = useGame()
        var gm = boardGeom(props.compact)
        var step = gm.step
        var pad = gm.pad
        var span = gm.span
        var size = gm.size
        var d = gm.stone
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
        var val = ''
        if (props.value) {
          if (props.value.provider === 'engine') {
            val = props.value.model === 'strong' ? 'ENGINE_STRONG' : (props.value.model === 'easy' ? 'ENGINE_EASY' : 'ENGINE')
          } else {
            val = props.value.provider + SEP + props.value.model
          }
        }
        var opts = [h('option', { key: '_', value: '' }, '选择模型…')]
        if (props.allowCurrent && g.current) opts.push(h('option', { key: '_cur', value: 'cur' }, '本会话模型（我）'))
        opts.push(h('option', { key: '_e3', value: 'ENGINE_STRONG' }, '⚙ 引擎·强（多推一层对手回应）'))
        opts.push(h('option', { key: '_e2', value: 'ENGINE' }, '⚙ 引擎·标准（不花 token）'))
        opts.push(h('option', { key: '_e1', value: 'ENGINE_EASY' }, '⚙ 引擎·轻（会失误，想赢就选它）'))
        var byKey = {}
        byKey.ENGINE_STRONG = { provider: 'engine', model: 'strong', name: '引擎·强' }
        byKey.ENGINE = { provider: 'engine', model: 'normal', name: '引擎·标准' }
        byKey.ENGINE_EASY = { provider: 'engine', model: 'easy', name: '引擎·轻' }
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
            if (v === 'ENGINE') { props.onPick(byKey.ENGINE); return }
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

      // 省额度模式开关（**默认关**）。用 label 包住受控 checkbox：点标签就等于点框，
      // 框只读 checked 由 React 管，不自己维护 DOM 状态。
      //   · 开 ⇒ host 在强制手（引擎判"这一手没得商量"）时直接落引擎坐标、不发模型请求；
      //   · 关 ⇒ 与没有这个开关时完全一样：每次都问模型，答完仍由引擎否决强制手。
      // 两个界面（会话页标签 + 右下角浮窗）渲染的是同一个 S.saveQuota。
      function saveQuotaToggle() {
        var g = useGame()
        return h('label', {
          style: {
            display: 'flex', alignItems: 'center', gap: '3px', fontSize: '11px', cursor: 'pointer',
            padding: '2px 6px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.35)',
            userSelect: 'none',
          },
        }, [
          h('input', {
            key: 'chk', type: 'checkbox', checked: g.saveQuota === true,
            style: { margin: 0, cursor: 'pointer' },
            title: '开：引擎判定为强制手（必胜/必挡）时直接落引擎坐标，不发模型请求，省 token；关：照旧每次都问模型',
            onChange: function (e) {
              var v = !!(e && e.target && e.target.checked)
              patch({ saveQuota: v })
              saveFlag(SAVE_QUOTA_KEY, v)      // 落盘：重启后还是这个值
            },
          }),
          h('span', { key: 'txt' }, '省额度'),
        ])
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
        // 时间预算：慢的根源是推理模型的思考（实测 2.6s / 8.9s / 12.1s），
        // 与其让棋盘干等，不如到点就让引擎接着下 —— 谁在拖后腿一眼可见。
        var budgetSel = h('select', {
          value: String(g.budget), style: selStyle,
          title: '模型的时间预算：到点未回就让引擎代打',
          onChange: function (e) { patch({ budget: Number(e.target.value) }) },
        }, [
          h('option', { key: 'b1', value: '2500' }, '⚡ 快 2.5s'),
          h('option', { key: 'b2', value: '5000' }, '标准 5s'),
          h('option', { key: 'b3', value: '15000' }, '耐心 15s'),
          h('option', { key: 'b4', value: '0' }, '不限时'),
        ])
        var row1 = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          modeSel,
          budgetSel,
          saveQuotaToggle(),
          btn('新局', reset),
          btn('悔棋', undo, !g.history.length || g.busy),
          btn('重载模型', function () { loadModels(true) }),
          props.compact ? null : btn(g.checking ? '体检中…' : '体检模型', function () { runSelftest() }, g.checking,
            '逐个调用该 provider 的所有模型，看哪个你账号真能用'),
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
        // 体检结果：只在大盘显示，避免浮窗里挤成一团
        var checkBox = null
        if (!props.compact && (g.check || g.checking)) {
          var rows = []
          if (g.checking) rows.push(h('div', { key: 'busy' }, '正在逐个试模型…（每个都要真调一次）'))
          if (g.check) {
            rows.push(h('div', { key: 'sum', style: { fontWeight: 600 } },
              '体检 ' + g.check.provider + '：可用 ' + g.check.usable + '/' + g.check.total))
            for (var ci = 0; ci < g.check.results.length; ci++) {
              var cr = g.check.results[ci]
              rows.push(h('div', {
                key: 'c' + ci,
                style: { color: cr.ok ? 'inherit' : 'var(--dsw-alias-label-warning, #b8860b)' },
              }, (cr.ok ? '✓ ' : '✗ ') + cr.model + '  ' + (cr.ok ? (cr.ms + 'ms') : String(cr.error || '').slice(0, 64))))
            }
          }
          checkBox = h('div', {
            style: {
              fontSize: '11px', lineHeight: 1.6, maxHeight: '160px', overflow: 'auto',
              borderTop: '1px solid rgba(127,127,127,.25)', paddingTop: '6px',
            },
          }, rows)
        }
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, row1, pickers, meta, checkBox)
      }

      // 让用户看见"模型下的那步 vs 引擎认为最好的一步"，弱模型弱在哪一目了然。
      // 顺带标出**这一手是谁下的**：省额度模式下强制手由引擎直落，界面上写"引擎直落"，
      // 与"模型下的一步"分开 —— 否则用户会以为模型每次都被问了。
      function EngineNote(props) {
        var g = useGame()
        if (!g.engine && !g.modelMove) return null
        var parts = []
        if (g.modelMove && g.modelMove.source) {
          var sl = sourceLabel(g.modelMove.source)
          if (sl) parts.push(sl)
        }
        if (g.modelMove) {
          if (g.modelMove.source === 'engine-direct') {
            parts.push('落 (' + g.modelMove.r + ',' + g.modelMove.c + ')'
              + (g.modelMove.reason ? '：' + g.modelMove.reason : ''))
          } else if (g.modelMove.timedOut) {
            parts.push(g.modelMove.name + ' 超时未回（预算 ' + Math.round((g.modelMove.timeoutMs || 0) / 1000) + 's）→ 引擎代打')
          } else if (g.modelMove.overridden) {
            parts.push('模型选了 (' + g.modelMove.modelR + ',' + g.modelMove.modelC + ')，但引擎判定必须先处理 ('
              + g.modelMove.r + ',' + g.modelMove.c + ')：' + g.modelMove.reason + ' → 已按引擎下')
          } else {
            parts.push(g.modelMove.name + ' 下 (' + g.modelMove.r + ',' + g.modelMove.c + ')' + (g.modelMove.fallback ? '［兜底］' : ''))
          }
          if (g.engine && !g.modelMove.timedOut && !g.modelMove.overridden) {
            parts.push(g.modelMove.same
              ? '与引擎首选一致 ✓'
              : '引擎首选 (' + g.engine.r + ',' + g.engine.c + ')：' + g.engine.reason)
          }
        }
        return h('div', {
          style: {
            fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #8a8a93)', lineHeight: 1.6,
            maxWidth: props.compact ? '280px' : '440px',
          },
        }, parts.join(' · '))
      }

      function GameView() {
        var g = useGame()
        useAutoPlay(g)
        React.useEffect(function () { if (!S.dir) loadModels(false) }, [])
        var left = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' } },
          h(Board, {}), h(StatusLine, {}), h(EngineNote, {}))
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
          h(EngineNote, { compact: true }),
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
          // order 必须严格大于账单页的 30：会话视图标签按 order 升序排，
          // 取 90 让「小游戏」排在全部已注册视图（chat=0 / trajectory=10 / 审批=20 / 账单=30）之后。
          { name: 'conversation.view', id: 'gomoku-mini-games', order: 90, label: '小游戏' },
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
