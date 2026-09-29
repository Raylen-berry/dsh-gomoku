import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
export async function preview(options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'q-play-preview-')),
    previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await fs.mkdir(path.join(home, 'dsh-wechat-chat'))
  await fs.writeFile(
    path.join(home, 'dsh-wechat-chat/settings.json'),
    JSON.stringify({ provider: 'fixture', model: '离线预览', personaMode: 'expressive' }),
  )
  const qRoot =
    process.env.Q_PLAY_ROOT || path.resolve(import.meta.dirname, '../../dsh-wechat-chat')
  const { apply } = await import(pathToFileURL(path.join(qRoot, 'index.js')))
  const routes = new Map()
  let calls = 0
  const llm = {
    stream: async function* (req) {
      calls++
      if (options.generate) {
        yield { type: 'text-delta', text: JSON.stringify(await options.generate(req)) }
        return
      }
      const t = req.messages.at(-1).content[0].text
      const messages = t.includes('开局：')
        ? ['来，给你藏了个小东西', '先别急着翻答案。']
        : t.includes('本机已确认')
          ? ['行，算你抓到我话里的尾巴了。']
          : t.includes('个提示')
            ? ['那我只漏一点点，你往日常用的东西想。']
            : ['你这个问题有点意思', '我可没说它是坏东西，你别先替它喊冤。']
      yield { type: 'reasoning-delta', text: '不得出现在界面里的思考' }
      yield {
        type: 'text-delta',
        text: JSON.stringify({ messages, solved: t.includes('本机已确认') }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  await apply({
    get: (n) =>
      n === 'llm'
        ? llm
        : n === 'webServer'
          ? {
              register(r) {
                routes.set(r.path, r.handler)
              },
            }
          : undefined,
    effect: (f) => f(),
    on() {},
  })
  const reactRoot =
    process.env.DNC_REACT_ROOT || 'D:/DeepSeek/dsh-plugins/dsh-cache-control/node_modules'
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>和 Q 玩 · 小游戏预览</title><style>html,body,#app{height:100%;margin:0}body{font-family:system-ui}#app{display:flex;flex-direction:column}.native-header{padding:15px 24px;border-bottom:1px solid #ddd;color:#647067;font-size:12px;background:#f4f5f2;flex:none}.native-header nav{margin-top:10px;display:flex;gap:24px}.native-header b{color:#42745a}#main{flex:1;min-height:0;display:flex;flex-direction:column}</style><div id="app"><header class="native-header">Desktop / 我的会话<nav>对话 <span>轨迹</span><span>费用</span><span>笔记</span><b>小游戏</b><span>Q</span></nav></header><div id="main"></div></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>var entries={};window.__ModuleLoader__={load:function(def){var plugin=def.factory(function(n){if(n==='react')return React;throw Error(n)});var slots={inject:function(n,f){return f()},register:function(o,c){entries[o.name+':'+o.id]=c;return function(){}}};plugin.apply({slots:slots,get:function(n){if(n==='slots')return slots},effect:function(f){return f()},timeout:function(f,t){return setTimeout(f,t)}});window.root=ReactDOM.createRoot(document.getElementById('main'));root.render(React.createElement(entries['conversation.view:gomoku-mini-games']));}};</script><script src="/client.js"></script></html>`
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (routes.has(url.pathname)) return await routes.get(url.pathname)(req, res)
      if (url.pathname === '/gomoku/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ providers: [], current: null }))
        return
      }
      const file =
        url.pathname === '/client.js'
          ? new URL('../client.js', import.meta.url)
          : url.pathname === '/react.js'
            ? reactRoot + '/react/umd/react.development.js'
            : url.pathname === '/react-dom.js'
              ? reactRoot + '/react-dom/umd/react-dom.development.js'
              : null
      res.setHeader(
        'content-type',
        file ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      )
      res.end(file ? await fs.readFile(file) : html)
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: e.message }))
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    home,
    calls: () => calls,
    origin: 'http://127.0.0.1:' + server.address().port,
    secret: async (id) =>
      JSON.parse(
        await fs.readFile(path.join(home, 'dsh-wechat-chat/play.json'), 'utf8'),
      ).rounds.find((r) => r.id === id).puzzle.answer,
    close: async () => {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}
if (process.argv.includes('--serve')) {
  const p = await preview()
  console.log(p.origin)
  process.on('SIGINT', async () => {
    await p.close()
    process.exit()
  })
}
