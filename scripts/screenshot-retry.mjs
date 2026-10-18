// Photograph the retry row in the real picker.
//
// The subject is a session that has failed: the host draws「本轮运行失败」in the
// transcript and this panel puts the retry right under it. No live shell can be
// made to fail on demand, and the shells this machine is running reject the
// screenshot's forged cookie, so the panel is mounted the way its own test
// mounts it — through the loader entry, in real Chromium, with the same fake
// seat and store the host provides — and then photographed.
//
// Two frames, because the rule has two halves that only read together:
//
//   live-retry.png         retry beside the failure, no fallback designated
//   live-retry-disarmed.png the moment after the press: the row stays, the
//                          button is disarmed, no second copy is queued
//
// Run: node scripts/screenshot-retry.mjs
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const HARNESS = '/Users/douba/Projects/deepseek-harness'
const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const reactDir = join(HARNESS, 'node_modules/.pnpm/react@18.3.1/node_modules/react')
const domDir = join(HARNESS, 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom')

// The frames are shot in this order on one page each. The fallback frame last:
// with a route designated the strip belongs to the switch, which is the other
// half of the rule.
const MOUNTS = [['live-retry.png', 'pending'], ['live-retry-disarmed.png', 'pressed'], ['live-retry-with-fallback.png', 'fallback']]

/**
 * The page. It is a script tag on a file:// origin, not a data: URL, so the UMD
 * builds can load from disk beside it.
 */
function pageHtml() {
  const umd = (p) => pathToFileURL(p).href
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0}
  body{background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:#1d1d1f}
  #stage{width:900px;padding:28px 32px 46px;box-sizing:border-box}
  .log{background:#fff;border-radius:16px;padding:20px 22px 104px;position:relative;min-height:0}
  .row{display:flex;align-items:flex-start;gap:10px;padding:10px 2px}
  .dot{flex:0 0 auto;width:7px;height:7px;margin-top:7px;border-radius:50%;background:#e5484d}
  .copy{display:flex;flex-direction:column;gap:2px;min-width:0}
  .title{color:#e5484d;font-size:14px;line-height:20px;font-weight:500}
  .msg{color:#5b5b60;font-size:13px;line-height:19px}
  .code{margin-left:auto;color:#8a8a8f;font-size:11px;letter-spacing:.04em}
  /* The composer stand-in: the strip is absolutely positioned above the model
     row, exactly where the real composer puts it. */
  /* The composer sits under the transcript and the strip floats above it, so
     the press target lands between the two, exactly as in the app. */
  #composer{position:relative;height:96px;margin-top:-96px;background:#fff;border:1px solid #e3e3e6;border-radius:16px;box-sizing:border-box}
  #composer .bar{position:absolute;left:16px;right:16px;bottom:14px;display:flex;align-items:center;justify-content:space-between;color:#3a3a3d;font-size:13px}
  #slot{position:absolute;right:16px;bottom:10px}
</style></head>
<body><div id="stage">
  <div class="log">
    <div class="row"><span class="dot"></span><div class="copy">
      <span class="title">本轮运行失败</span>
      <span class="msg" id="errmsg"></span></div><code class="code" id="errcode"></code></div>
  </div>
  <div id="app"><div id="composer"><div class="slot" id="slot"></div><div class="bar"><span>+　完全权限 ⌄</span></div></div></div>
</div>
<script src="${umd(join(reactDir, 'umd/react.development.js'))}"></script>
<script src="${umd(join(domDir, 'umd/react-dom.development.js'))}"></script>
<script>
  window.__LOADED__ = true
</script>
</body></html>`
}

/** The fake seat, mirroring the contract scripts/interaction.mjs enforces. */
function mountScript(mode, source) {
  return `(function () {
  const React = window.React
  const { createRoot } = window.ReactDOM
  let captured = null
  window.__ModuleLoader__ = { load({ id, factory }) { const module = { exports: {} }; const r = factory(() => React); captured = { exports: r === undefined ? module.exports : r } } }
  ${source}
  const plugin = captured.exports

  const FAILURE = { message: 'lobsterai: no usable credential; log in first', code: 'MISSING_CREDENTIAL' }
  document.getElementById('errmsg').textContent = FAILURE.message
  document.getElementById('errcode').textContent = FAILURE.code

  const groups = [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash' }] },
    { id: 'zhipu', name: '智谱 GLM', models: [{ id: 'glm-4.6', name: 'GLM-4.6' }] },
  ]
  const snapshot = { current: { provider: 'deepseek', model: 'deepseek-v4-1-flash', reasoningEffort: 'high' }, routable: null, status: 'ready', error: null, failures: [], groups }
  const listeners = new Set()
  const store = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot }
  const selections = []

  // The session: healthy on mount, then its turn dies — the order the Host
  // produces, which is what lets the strip appear.
  const tray = { promptError: null, lastAgentError: null, promptAttempted: true }
  const prompted = []
  const sessionListeners = new Set()
  const notify = () => { for (const fn of [...sessionListeners]) fn() }
  const session = {
    getSnapshot: () => tray,
    subscribe(fn) { sessionListeners.add(fn); return () => sessionListeners.delete(fn) },
    events: { getSnapshot: () => ({ events: [{ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '把 /api/sessions 那组路由都去掉' }] } } }] }) },
    // The admission round trip the real Host takes: the press is what makes the
    // disarmed state visible, so it must not resolve on the same frame.
    prompt(content, mode) { prompted.push({ content, mode }); return new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: { accepted: true } }), 4000)) },
  }

  const seats = {}
  const slots = {
    inject(_n, fn) { fn() },
    register(options, Component) { seats.component = Component; seats.options = options; return () => {} },
    entries: () => [],
  }
  const services = {
    slots,
    sessions: {
      subagentAddress: () => undefined,
      retain: () => ({ ready: Promise.resolve(), binding: { session }, release: () => {} }),
    },
    modelDirectories: { directoryFor: () => ({
      store,
      load: () => Promise.resolve(),
      select: (sel) => { selections.push(sel); snapshot.current = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort }; for (const fn of [...listeners]) fn(); return Promise.resolve() },
    }) },
    remote: { session: {} },
    shortcuts: { registry: { commands: new Map(), invoke: () => {} } },
  }
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(_names, fn) { const scope = {}; for (const k of plugin.inject) scope[k] = services[k]; fn(scope); return () => {} },
    get: (k) => services[k],
  }
  plugin.apply(ctx)

  if (${JSON.stringify(mode)} === 'fallback') {
    window.localStorage.setItem('dsh.modelPicker.fallback', JSON.stringify(['zhipu/glm-4.6']))
  }

  const seat = seats.options.inject('session-demo')
  const root = createRoot(document.getElementById('app'))
  // The plugin renders inside the composer box; the box is created by the
  // plugin's own root (position:relative), so mount into a child of it.
  const host = document.createElement('div')
  host.style.cssText = 'position:relative'
  document.getElementById('slot').appendChild(host)
  const inner = createRoot(host)
  inner.render(React.createElement(seats.component, Object.assign({ locked: false }, seat, { t: (k) => k })))

  window.__RETRIED_NOW__ = () => seat.repair?.retriedNow?.()
  // Park React's work queue until the shot has been taken. React 18's scheduler
  // goes through MessageChannel; replacing it holds every update back, so the
  // page can be photographed between "the press set its state" and "the
  // admission settled" instead of wherever the scheduler happened to be.
  const RealPort = window.MessageChannel
  window.__PARK__ = () => {
    window.MessageChannel = function () { return { port1: { onmessage: null, close() {} }, port2: { postMessage() {} } } }
  }
  window.__ARM__ = () => { setTimeout(() => { window.__READY__ = true }, 0) }
  window.__PRESS__ = () => {
    const btn = document.querySelector('.dsh-mp2-failoverBtn[data-kind="retry"]')
    if (btn === null) return { disabled: 'no button' }
    btn.click()
    return { clicked: true, disabledNowInDom: btn.disabled }
  }
  window.__UNPARK__ = () => { window.MessageChannel = RealPort }
  setTimeout(() => {
    tray.promptError = { op: 'send', error: FAILURE }
    notify()
    setTimeout(() => {
      window.__SHOT__ = { prompted: prompted.length, buttons: [...document.querySelectorAll('.dsh-mp2-failoverBtn')].map((b) => b.textContent) }
    }, 260)
  }, 160)
})()`
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'retry-shot-'))

for (const [file, mode] of MOUNTS) {
  const html = pageHtml().replace('</body>', `<script>${mountScript(mode, source)}</script></body>`)
  const target = join(dir, file.replace('.png', '.html'))
  writeFileSync(target, html)
  const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(pathToFileURL(target).href)
  await page.waitForTimeout(900)
  // The disarm frame is the moment after the press, taken while the prompt
  // admission is still in flight (the fake resolves on a timer below).
  // The disarm is driven inside the page while the press's React update is
  // parked, so the frame is deterministic: a frame rendered right after the
  // update, before the prompt admission settles. Reading it from Playwright
  // mid-flight would race the same update.
  if (mode === 'pressed') {
    // Park first, then press on the next task: the press's own state update has
    // to be the update the parked scheduler is holding, or the frame would be
    // the page as it stood before the click.
    await page.evaluate(() => { window.__PARK__(); window.__ARM__(); })
    await page.waitForFunction(() => window.__READY__ === true)
    console.log('  press :', await page.evaluate(() => window.__PRESS__()))
    // The press's own state has now been rendered while the scheduler is
    // parked, so the frame is the disarmed state, not whichever frame the
    // admission happened to leave behind.
  }
  const shot = await page.evaluate(() => window.__SHOT__ ?? null)
  const rect = await page.evaluate(() => {
    const btn = document.querySelector('.dsh-mp2-failoverBtn[data-kind="retry"]')
    if (btn === null) return null
    const r = btn.getBoundingClientRect()
    return { h: Math.round(r.height), disabled: btn.disabled, text: btn.textContent, retriedNow: String(window.__RETRIED_NOW__?.()) }
  })
  console.log(file, '| errors:', errors.length === 0 ? 'none' : errors.join(' | '))
  console.log('  shot  :', JSON.stringify(shot))
  console.log('  retry :', JSON.stringify(rect))
  await page.screenshot({ path: join(root, file) })
  if (mode === 'pressed') console.log('  parked:', JSON.stringify(await page.evaluate(() => window.__UNPARK__ && 'released')))
  await page.close()
}

await browser.close()
console.log('wrote', MOUNTS.map(([f]) => f).join(', '))
