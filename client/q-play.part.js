function QPlay() {
  var [round, setRound] = React.useState(null),
    [info, setInfo] = React.useState(null),
    [choosing, setChoosing] = React.useState(true),
    [text, setText] = React.useState(''),
    [intent, setIntent] = React.useState('ask'),
    [busy, setBusy] = React.useState('loading'),
    [error, setError] = React.useState(''),
    [retry, setRetry] = React.useState(null),
    log = React.useRef(null),
    alive = React.useRef(true),
    pending = React.useRef(false)
  var STORAGE = 'dsh-gomoku:q-play-round'
  function request(options, id) {
    return fetch('/wx/play' + (id ? '?id=' + encodeURIComponent(id) : ''), options)
      .then(async function (response) {
        if (response.status === 404)
          throw new Error('需要更新并启用 Q 插件，再完全重启 Desktop。五子棋仍可使用。')
        var result
        try {
          result = await response.json()
        } catch (_) {
          throw new Error('需要更新并启用 Q 插件，再完全重启 Desktop。五子棋仍可使用。')
        }
        if (!result.ok) throw new Error(result.error || 'Q 暂时没有接上，再试一次。')
        return result
      })
      .catch(function (error) {
        if (error instanceof TypeError)
          throw new Error('连接断开了，可以重试；已经完成的这一步会从本机恢复。')
        throw error
      })
  }
  function accept(next) {
    setRound(next)
    setChoosing(false)
    setRetry(null)
    try {
      localStorage.setItem(STORAGE, next.id)
    } catch (_) {}
  }
  async function restore() {
    if (pending.current) return
    pending.current = true
    setBusy('loading')
    setError('')
    try {
      var available = await request()
      if (!alive.current) return
      setInfo(available)
      var id = ''
      try {
        id = localStorage.getItem(STORAGE) || ''
      } catch (_) {}
      if (id) {
        var restored = await request(undefined, id)
        if (alive.current) accept(restored.round)
      }
    } catch (e) {
      if (alive.current) setError(e.message)
    } finally {
      pending.current = false
      if (alive.current) setBusy('')
    }
  }
  React.useEffect(function () {
    alive.current = true
    restore()
    return () => {
      alive.current = false
    }
  }, [])
  React.useEffect(
    function () {
      if (log.current) log.current.scrollTop = log.current.scrollHeight
    },
    [round, busy, choosing],
  )
  async function act(action, kind, repeated) {
    if (pending.current) return
    var input = repeated || {
      action,
      kind,
      id: round?.id,
      version: round?.version,
      text: text.trim(),
      requestId: crypto.randomUUID(),
    }
    pending.current = true
    setBusy(input.action)
    setError('')
    try {
      var result = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-q-play': '1' },
        body: JSON.stringify(input),
      })
      try {
        localStorage.setItem(STORAGE, result.round.id)
      } catch (_) {}
      if (alive.current) {
        accept(result.round)
        if (['ask', 'guess'].includes(input.action)) setText('')
      }
    } catch (e) {
      if (alive.current) {
        setError(e.message)
        setRetry(input)
      }
    } finally {
      pending.current = false
      if (alive.current) setBusy('')
    }
  }
  function button(label, onClick, extra) {
    return h('button', { type: 'button', disabled: !!busy, onClick, ...extra }, label)
  }
  var name = round?.persona || info?.persona || 'Q',
    playing = round?.phase === 'playing'
  return h(
    'div',
    { className: 'qplay', 'data-q-play': true },
    h(
      'header',
      { className: 'qplay-head' },
      h('div', { className: 'qplay-avatar', 'aria-hidden': true }, 'Q'),
      h(
        'div',
        null,
        h('strong', null, '陪我玩一会儿'),
        h('small', null, name + ' · 自然生长 · 不计分'),
      ),
      h(
        'div',
        { className: 'qplay-head-actions' },
        button('恢复本局', restore),
        round && !choosing ? button('换个玩法', () => setChoosing(true)) : null,
      ),
    ),
    error
      ? h(
          'div',
          { className: 'qplay-error', role: 'alert' },
          error,
          retry ? button('重试这次', () => act('', '', retry)) : button('重新连接', restore),
        )
      : null,
    choosing
      ? h(
          'div',
          { className: 'qplay-lobby' },
          h(
            'div',
            { className: 'qplay-intro' },
            h('span', null, '和 ' + name + ' 的一点闲暇'),
            h('h2', null, '谜底很小。', h('br'), '岔开的话，可以很多。'),
            h('p', null, '你可以认真猜，也可以先逗她一句。她会接你的话，谜底留在她那里。'),
          ),
          h(
            'div',
            { className: 'qplay-cards' },
            h(
              'article',
              { className: 'qplay-card' },
              h('span', { className: 'qplay-card-mark', 'aria-hidden': true }, '？'),
              h('small', null, '01 / 藏一个词'),
              h('h3', null, '她藏了个词'),
              h('p', null, '普通东西，被她说得很不对劲。问她、猜它，或者让她再漏一点口风。'),
              button(
                busy === 'start' ? '她正在想开场…' : '让她藏一个',
                () => {
                  setIntent('guess')
                  act('start', 'word')
                },
                { className: 'qplay-primary', disabled: !!busy || !info },
              ),
            ),
            h(
              'article',
              { className: 'qplay-card qplay-story' },
              h('span', { className: 'qplay-card-mark', 'aria-hidden': true }, '…'),
              h('small', null, '02 / 半句故事'),
              h('h3', null, '半句怪故事'),
              h('p', null, '一个哪里不对的小场景。你慢慢问，她一边接梗，一边把线索露出来。'),
              button(
                busy === 'start' ? '她正在想开场…' : '听她讲半句',
                () => {
                  setIntent('ask')
                  act('start', 'story')
                },
                { className: 'qplay-primary', disabled: !!busy || !info },
              ),
            ),
          ),
          round
            ? button('继续刚才那局', () => setChoosing(false), { className: 'qplay-resume' })
            : null,
        )
      : h(
          'div',
          { className: 'qplay-table' },
          h(
            'aside',
            { className: 'qplay-side' },
            h('small', null, round.title),
            h(
              'h2',
              null,
              playing ? '谜底已封存' : round.phase === 'solved' ? '被你猜中了' : '拆开看看',
            ),
            h('div', { className: 'qplay-envelope', 'aria-hidden': true }, playing ? '？' : '✓'),
            h('p', null, playing ? '她可以绕弯，答案不会临时变。' : round.solution),
            !playing ? h('strong', { className: 'qplay-answer' }, round.answer) : null,
            h(
              'div',
              { className: 'qplay-side-actions' },
              playing
                ? h(
                    React.Fragment,
                    null,
                    button('漏一点口风 · ' + round.hints + '/3', () => act('hint'), {
                      disabled: !!busy || round.hints >= 3,
                    }),
                    button('好吧，揭晓', () => act('reveal')),
                  )
                : button('再来一局', () => act('start', round.kind), {
                    className: 'qplay-primary',
                  }),
            ),
            h('small', { className: 'qplay-model' }, round.model?.model || '跟随 Q 的模型'),
          ),
          h(
            'section',
            { className: 'qplay-chat', 'aria-label': '和 Q 玩猜谜' },
            h(
              'div',
              { className: 'qplay-log', ref: log, role: 'log', 'aria-live': 'polite' },
              round.messages.map((m, i) =>
                h(
                  'div',
                  { key: i, className: 'qplay-message qplay-' + m.s },
                  h('small', null, m.s === 'q' ? name : m.s === 'me' ? '你' : '谜底'),
                  h('div', null, m.text),
                ),
              ),
              busy
                ? h(
                    'p',
                    { className: 'qplay-thinking', role: 'status' },
                    busy === 'reveal' ? '正在拆开…' : '她正在接你的话…',
                  )
                : null,
            ),
            playing
              ? h(
                  'form',
                  {
                    className: 'qplay-compose',
                    onSubmit: (e) => {
                      e.preventDefault()
                      if (text.trim()) act(intent)
                    },
                  },
                  h(
                    'div',
                    { className: 'qplay-intent', role: 'group', 'aria-label': '这句怎么说' },
                    ['ask', 'guess'].map((value) =>
                      button(value === 'ask' ? '问一句' : '猜答案', () => setIntent(value), {
                        'aria-pressed': intent === value,
                        key: value,
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'qplay-input-row' },
                    h('textarea', {
                      value: text,
                      maxLength: 600,
                      rows: 2,
                      disabled: !!busy,
                      'aria-label': '给 Q 的问题或答案',
                      placeholder:
                        intent === 'guess' ? '我猜，是不是…' : '先问她一句，也可以说点别的。',
                      onChange: (e) => setText(e.target.value),
                      onKeyDown: (e) => {
                        if (
                          e.key === 'Enter' &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing &&
                          e.keyCode !== 229
                        ) {
                          e.preventDefault()
                          if (text.trim()) act(intent)
                        }
                      },
                    }),
                    h(
                      'button',
                      {
                        type: 'submit',
                        className: 'qplay-primary',
                        disabled: !!busy || !text.trim(),
                      },
                      intent === 'guess' ? '我猜' : '问她',
                    ),
                  ),
                )
              : h('div', { className: 'qplay-ended' }, '这一小段先收好。下一局，换个念头。'),
          ),
        ),
    h(
      'footer',
      { className: 'qplay-foot' },
      '开局、问答和提示会调用 Q 的模型；揭晓不调用模型。游戏故事不写入长期记忆。',
    ),
  )
}

function GamesHome() {
  var [mode, setMode] = React.useState('gomoku')
  return h(
    'div',
    { className: 'mini-games-home' },
    h(
      'nav',
      { className: 'mini-games-tabs', 'aria-label': '小游戏玩法' },
      h(
        'button',
        { type: 'button', 'aria-pressed': mode === 'gomoku', onClick: () => setMode('gomoku') },
        '五子棋',
      ),
      h(
        'button',
        { type: 'button', 'aria-pressed': mode === 'q', onClick: () => setMode('q') },
        '和 Q 玩',
      ),
    ),
    mode === 'q' ? h(QPlay) : h('div', { className: 'mini-games-board' }, h(GameView)),
  )
}
