import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { preview } from './browser-preview.mjs'
const { chromium } = await import(
  pathToFileURL(
    process.env.DNC_PLAYWRIGHT_MODULE ||
      'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs',
  )
)
const out = process.env.DNC_SCREENSHOTS || 'D:/ChatGPT/_runs/q-play-ui-20260929'
await fs.mkdir(out, { recursive: true })
const f = await preview(),
  browser = await chromium.launch({ headless: true, channel: process.env.DNC_BROWSER || 'msedge' }),
  page = await browser.newPage({ viewport: { width: 1200, height: 940 } }),
  errors = []
page.on('pageerror', (e) => errors.push(e.message))
let count = 0
const check = (label, yes) => {
  assert.ok(yes, label)
  console.log('PASS ' + label)
  count++
}
try {
  await page.goto(f.origin)
  await page.getByRole('button', { name: '让她藏一个', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.qplay-card button').disabled)
  check(
    '小游戏默认显示两个 Q 玩法，浏览不调用模型',
    f.calls() === 0 &&
      (await page.getByRole('heading', { name: '半句怪故事', exact: true }).isVisible()),
  )
  await page.screenshot({ path: path.join(out, 'q-play-lobby.png') })
  await page.getByRole('button', { name: '让她藏一个', exact: true }).click()
  await page.getByRole('heading', { name: '谜底已封存', exact: true }).waitFor()
  const firstId = await page.evaluate(() => localStorage.getItem('dsh-gomoku:q-play-round'))
  check(
    '开局只调用一次模型，并显示聊天和封存状态',
    f.calls() === 1 && (await page.locator('.qplay-message').count()) >= 2,
  )
  check(
    '界面没有思考块或原始 JSON',
    !(await page.locator('.qplay-log').innerText()).includes('不得出现在界面里的思考'),
  )
  await page.getByRole('button', { name: '问一句', exact: true }).click()
  await page.getByRole('textbox', { name: '给 Q 的问题或答案' }).fill('你是不是在故意逗我')
  await page.getByRole('button', { name: '问她', exact: true }).click()
  await page.getByText('你这个问题有点意思', { exact: true }).waitFor()
  check(
    '问题和 Q 的回应进入同一局',
    f.calls() === 2 && (await page.getByText('你是不是在故意逗我', { exact: true }).isVisible()),
  )
  await page.screenshot({ path: path.join(out, 'q-play-chat.png') })
  await page.reload()
  await page.getByText('你是不是在故意逗我', { exact: true }).waitFor()
  check(
    '页面刷新恢复局与历史，不自动再调模型',
    f.calls() === 2 &&
      (await page.evaluate(() => localStorage.getItem('dsh-gomoku:q-play-round'))) === firstId,
  )
  // Let the host finish, then lose the response. Retrying must reuse its receipt.
  let lost = true
  await page.route('**/wx/play', async (route) => {
    if (route.request().method() === 'POST' && lost) {
      lost = false
      await route.fetch()
      await route.abort('failed')
    } else await route.continue()
  })
  await page.getByRole('button', { name: '漏一点口风 · 0/3', exact: true }).click()
  await page.getByRole('button', { name: '重试这次', exact: true }).waitFor()
  const afterLost = f.calls()
  await page.getByRole('button', { name: '重试这次', exact: true }).click()
  await page.getByRole('button', { name: '漏一点口风 · 1/3', exact: true }).waitFor()
  check('响应丢失后重试不会重复调用模型或扣提示', f.calls() === afterLost)
  await page.unroute('**/wx/play')
  await page.getByRole('button', { name: '猜答案', exact: true }).click()
  await page.getByRole('textbox', { name: '给 Q 的问题或答案' }).fill(await f.secret(firstId))
  await page.getByRole('button', { name: '我猜', exact: true }).click()
  await page.getByRole('heading', { name: '被你猜中了', exact: true }).waitFor()
  check(
    '猜中后揭晓固定谜底且关闭输入',
    (await page.locator('.qplay-answer').isVisible()) &&
      (await page.getByRole('textbox', { name: '给 Q 的问题或答案' }).count()) === 0,
  )
  await page.screenshot({ path: path.join(out, 'q-play-solved.png') })
  await page.getByRole('button', { name: '换个玩法', exact: true }).click()
  await page.getByRole('button', { name: '听她讲半句', exact: true }).click()
  await page.getByRole('heading', { name: '谜底已封存', exact: true }).waitFor()
  const beforeReveal = f.calls()
  await page.getByRole('button', { name: '好吧，揭晓', exact: true }).click()
  await page.getByRole('heading', { name: '拆开看看', exact: true }).waitFor()
  check('故事可以主动揭晓，不多调一次模型', f.calls() === beforeReveal)
  await page.getByRole('button', { name: '五子棋', exact: true }).click()
  await page.getByText('五子棋 · 小游戏', { exact: true }).waitFor()
  check(
    '原五子棋仍然可打开',
    await page.getByRole('button', { name: '新局', exact: true }).isVisible(),
  )
  await page.getByRole('button', { name: '和 Q 玩', exact: true }).click()
  await page.getByRole('heading', { name: '拆开看看', exact: true }).waitFor()
  check('玩法切换恢复 Q 的游戏', f.calls() === beforeReveal)
  await page.evaluate(
    () =>
      (document.documentElement.style.cssText =
        '--dsw-alias-bg-base:#202722;--dsw-alias-bg-layer-1:#29302a;--dsw-alias-label-primary:#e6eae6;--dsw-alias-label-secondary:#a6b4a9;--dsw-alias-border-l1:#3f4a42'),
  )
  await page.screenshot({ path: path.join(out, 'q-play-dark.png') })
  await page.setViewportSize({ width: 390, height: 820 })
  check(
    '窄屏布局不横向溢出',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  )
  await page.screenshot({ path: path.join(out, 'q-play-mobile.png') })
  await page.route('**/wx/play*', (route) => route.fulfill({status:404,body:'not found'}))
  await page.reload()
  await page.getByRole('alert').filter({hasText:'需要更新并启用 Q 插件'}).waitFor()
  check('缺少 Q 插件时明确说明依赖，不触发空白游戏', await page.getByRole('button',{name:'让她藏一个',exact:true}).isDisabled())
  await page.getByRole('button',{name:'五子棋',exact:true}).click()
  await page.getByText('五子棋 · 小游戏',{exact:true}).waitFor()
  check('缺少 Q 也不影响原五子棋', await page.getByRole('button',{name:'新局',exact:true}).isVisible())
  check('游戏页面没有浏览器运行错误', errors.length === 0)
  console.log(count + ' 组 Q 游戏浏览器检查通过')
} finally {
  await browser.close()
  await f.close()
}
