// Capture the fallback page's batch probe: one press walks every route on the
// list, the button counts itself, and the receipt reports the tally.
//
// The app serves its plugin bundle as an immutable snapshot from process start
// (that is issue -12's "bundle lags one beat"), so a freshly edited client.js
// is not what a live page runs. The shot therefore swaps the picker's own
// segment of the served bundle for the checkout's file at the network layer —
// everything else on the page (the shell, the session, the model directory) is
// the real thing, and the answers come from a stubbed probe route, because no
// live channel can be made to fail on demand.
//
// Run: DSH_LIVE_ORIGIN=http://127.0.0.1:60025 node scripts/screenshot-fallback-probe.mjs
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const NEW_CLIENT = readFileSync(join(here, '..', 'lib/client.js'), 'utf8')

const ORIGIN = process.env.DSH_LIVE_ORIGIN ?? 'http://127.0.0.1:19387'
const AUTHORITY = new URL(ORIGIN).host
const OUT_MID = process.env.SHOT_OUT_MID ?? 'live-fallback-probe-mid.png'
const OUT_DONE = process.env.SHOT_OUT_DONE ?? 'live-fallback-probe-done.png'

function sessionCookie() {
  const text = readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8')
  const at = text.indexOf('client-connection/browser-session:')
  if (at === -1) throw new Error('no browser-session credential record')
  const secret = Buffer.from(/secret:\s*(\S+)/.exec(text.slice(at))[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
  const b64url = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  const name = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}`
  const now = Date.now()
  const body = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }))
  return `${name}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
}

const HEADLESS_SHELL = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')

const browser = await chromium.launch({ executablePath: HEADLESS_SHELL })
const context = await browser.newContext({ viewport: { width: 1000, height: 1100 } })
await context.setExtraHTTPHeaders({ cookie: sessionCookie() })

// Swap the picker's segment of every served plugin bundle for the checkout's
// file. Bundles concatenate `__ModuleLoader__.load({ id: … })` calls, so the
// segment runs from the picker's load call to the next plugin's.
await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
  const response = await route.fetch()
  const body = await response.text()
  if (!body.includes("load({ id: 'dsh-model-picker'") || body.includes('dsh-mp2-fallbackMark')) {
    return route.fulfill({ response })
  }
  const MARK = "window.__ModuleLoader__.load({ id: '"
  const start = body.indexOf(MARK + "dsh-model-picker'")
  const next = body.indexOf(MARK, start + MARK.length)
  const swapped = body.slice(0, start) + NEW_CLIENT + (next === -1 ? '' : body.slice(next))
  return route.fulfill({ response, body: swapped })
})

const page = await context.newPage()

// The queue must name models this session's directory actually has, or the
// rows fall back to raw route ids. So first pass: load the page, ask the host
// for the real directory, and pick one route per provider until four are in —
// then reload with the seed and the stubbed answers installed.
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
const chosen = await page.evaluate(async () => {
  const response = await fetch('/api/model-picker/models')
  const body = await response.json()
  const rows = body.models ?? body.rows ?? body
  const picked = []
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.provider)) continue
    seen.add(row.provider)
    picked.push(row.provider + '/' + row.id)
    if (picked.length === 4) break
  }
  return picked
})
console.log('routes        :', JSON.stringify(chosen))
if (chosen.length < 4) throw new Error(`the directory offered only ${chosen.length} routes`)

// Four curated routes, mixed answers: two answer, one is out of quota, one
// times out — a run worth reading has both sides on the page at once.
const ROWS = [
  [chosen[0], { ok: true, ms: 420 }],
  [chosen[1], { ok: false, state: 'quota', error: 'insufficient balance' }],
  [chosen[2], { ok: true, ms: 1650 }],
  [chosen[3], { ok: false, state: 'timeout', error: 'timeout' }],
]

await page.addInitScript((rows) => {
  window.localStorage.setItem('dsh.modelPicker.fallback', JSON.stringify(rows.map(([route]) => route)))
  window.localStorage.removeItem('dsh.modelPicker.failures')
  const answers = new Map()
  for (const [route, body] of rows) answers.set(route, body)
  const realFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? '')
    if (!url.includes('/api/model-picker/test')) return realFetch(input, init)
    const route = JSON.parse(init?.body ?? '{}')
    const body = answers.get(`${route.provider}/${route.model}`)
    // A fixed 300ms delay per answer: three probes run concurrently, so by the
    // time the mid frame is taken some rows are answered and some are not.
    return new Promise((resolve) => setTimeout(() => resolve({
      ok: true, json: async () => body ?? { ok: true, ms: 900 },
    }), 300))
  }
}, ROWS)

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)

const root = await page.$('.dsh-mp2-root')
if (root === null) throw new Error('the picker never mounted — is the plugin loaded?')

// The shell's onboarding overlays swallow pointer events and photobomb every
// shot; this page is a disposable headless profile, so they just go away.
await page.evaluate(() => {
  document.querySelectorAll('[data-dam-theme="dialogs"], [data-dam-tour-head]').forEach((node) => node.remove())
})

// The live shell sometimes carries an onboarding overlay that swallows pointer
// events, so every press here is a DOM click, not a hit-tested one.
const domClick = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel)

await domClick('.dsh-mp2-triggerLeft')
await page.waitForSelector('.dsh-mp2-list', { timeout: 5000 })
await domClick('.dsh-mp2-footerFallback')
await page.waitForSelector('.dsh-mp2-fallbackPage', { timeout: 5000 })
await page.waitForTimeout(300)

const batch = await page.$('.dsh-mp2-fallbackProbe')
if (batch === null) throw new Error('the fallback page has no batch probe button')
console.log('idle label    :', await batch.textContent())
await domClick('.dsh-mp2-fallbackProbe')

// Mid frame: the run is in flight — the button counts, early rows answered.
await page.waitForTimeout(500)
console.log('mid label     :', await page.$eval('.dsh-mp2-fallbackProbe', (node) => node.textContent))
console.log('mid marks     :', JSON.stringify(await page.$$eval('.dsh-mp2-fallbackMark', (nodes) => nodes.map((node) => node.textContent))))
await page.screenshot({ path: OUT_MID })

// Finished: the button handed back, the receipt beside the title.
await page.waitForTimeout(2500)
const done = await page.$eval('.dsh-mp2-fallbackProbe', (node) => node.textContent)
const note = await page.$eval('.dsh-mp2-menuHeaderGroup .dsh-mp2-probeNote', (node) => node.textContent).catch(() => null)
const labels = await page.$$eval('.dsh-mp2-fallbackItem .dsh-mp2-fallbackMark', (nodes) => nodes.map((node) => node.textContent))
console.log('done label    :', done)
console.log('receipt       :', note)
console.log('row labels    :', JSON.stringify(labels))

// Geometric audit: every element sharing a horizontal line must agree on its
// vertical midline (container alignment, not margin compensation).
const geo = await page.evaluate(() => {
  const mid = (el) => { const r = el.getBoundingClientRect(); return +(r.top + r.height / 2).toFixed(1) }
  const header = document.querySelector('.dsh-mp2-menuHeader')
  const [back, group, close] = [...header.children]
  const title = group.querySelector('strong')
  const probe = group.querySelector('.dsh-mp2-fallbackProbe')
  const row = document.querySelector('.dsh-mp2-fallbackItem')
  const name = row?.querySelector('.dsh-mp2-modelName')
  const mark = row?.querySelector('.dsh-mp2-fallbackMark')
  const action = row?.querySelector('.dsh-mp2-fallbackTest')
  return {
    header: { back: mid(back), title: mid(title), batch: mid(probe), close: mid(close) },
    row: row === null ? null : { name: mid(name), mark: mark === null ? null : mid(mark), action: mid(action) },
  }
})
console.log('geometry      :', JSON.stringify(geo))

await page.screenshot({ path: OUT_DONE })
console.log('wrote', OUT_MID, 'and', OUT_DONE)
await browser.close()
