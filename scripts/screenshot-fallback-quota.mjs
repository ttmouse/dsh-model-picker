// Capture the fallback queue's quota line: every queued row names what the
// account behind it has left, in the same place on every row.
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
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const NEW_CLIENT = readFileSync(join(here, '..', 'lib/client.js'), 'utf8')
import { pickerSegment, withCheckoutPicker } from './bundle-swap.mjs'

const ORIGIN = process.env.DSH_LIVE_ORIGIN ?? 'http://127.0.0.1:60738'
const AUTHORITY = new URL(ORIGIN).host
const OUT_DONE = process.env.SHOT_OUT_DONE ?? 'live-fallback-quota.png'

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

// The headless shell the other shot scripts expect is not installed on every
// machine; the system Chrome is, and the swap below is network-level, so the
// browser identity changes nothing about what the shot proves.
const executablePath = existsSync(HEADLESS_SHELL) ? HEADLESS_SHELL : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch(existsSync(HEADLESS_SHELL) ? { executablePath } : { executablePath, channel: undefined, args: ['--headless=new'] })
const context = await browser.newContext({ viewport: { width: 1000, height: 1100 } })
await context.setExtraHTTPHeaders({ cookie: sessionCookie() })

// Swap the picker's segment of every served plugin bundle for the checkout's
// file. Bundles concatenate `__ModuleLoader__.load({ id: … })` calls, so the
// segment runs from the picker's load call to the next plugin's.
await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
  const response = await route.fetch()
  const body = await response.text()
  const served = pickerSegment(body)
  if (served === null) return route.fulfill({ response })
  return route.fulfill({ response, body: withCheckoutPicker(body, NEW_CLIENT) })
})

const page = await context.newPage()

// The queue must name models this session's directory actually has, or the
// rows fall back to raw route ids. So first pass: load the page, ask the host
// for the real directory, and pick one route per provider until four are in —
// then reload with the seed and the stubbed answers installed.
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
// Prefer the floors the local gateway actually bills (magpie, qoder, cline,
// our-free-model), because those are the ones carrying a quota; fall back to
// whatever the directory offers if a gateway floor is not configured here.
const chosen = await page.evaluate(async (accountList) => {
  const response = await fetch('/api/model-picker/models')
  const body = await response.json()
  const rows = body.models ?? body.rows ?? body
  // The floor that routes one model per account: its model ids NAME the
  // account (`trae-cn/deepseek-v4.1-flash`), so those are the routes that
  // carry a quota. A routing group is a pool of accounts and carries none.
  const accounts = new Set(accountList)
  const picked = []
  for (const row of rows) {
    if (row.provider !== 'magpie') continue
    const head = row.id.includes('/') ? row.id.slice(0, row.id.indexOf('/')) : ''
    if (!accounts.has(head)) continue
    picked.push('magpie/' + row.id)
    if (picked.length === 4) break
  }
  for (const row of rows) {
    if (picked.length === 4) break
    const route = row.provider + '/' + row.id
    if (!picked.includes(route)) picked.push(route)
  }
  return picked
}, ['trae-cn', 'workbuddy', 'zcode', 'qoder', 'cursor', 'grok', 'codex', 'cline', 'openrouter', 'zhipu'])
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

// The gateway's snapshot is the one thing this shot must not leave to chance:
// the code under test reads it from the host, and the host's answer is real.
//
// The host process on this machine predates the owner's map and the balance
// passthrough (a plugin change reaches the App's route table only after a
// restart), so the shot answers the quota route with the NEW host half run
// in-process against the real gateway. Both halves under test are therefore
// the checkout's own files, and the only thing faked is the transport.
const GATEWAY = process.env.MAGPIE_GATEWAY ?? 'http://127.0.0.1:3425'
const host = await import('../lib/host.js')
const routes = new Map()
host.apply({
  get: () => ({ listProviders: () => [], listModels: async () => [], resolveModel: async () => ({}) }),
  webServer: { register: (route) => routes.set(route.path, route) },
})
const quotaBody = await new Promise((resolve) => {
  let out = ''
  routes.get('/api/model-picker/quotas').handler({ method: 'GET' }, {
    setHeader() {},
    set statusCode(_value) {},
    end(body) { out = body },
  })
  setTimeout(() => resolve(out), 1_500)
})
const quotaPayload = JSON.parse(quotaBody)
console.log('host snapshot : %s quota rows, %s owners', quotaPayload.quotas?.length, Object.keys(quotaPayload.owners ?? {}).length)
await page.route((url) => url.href.includes('/api/model-picker/quotas'), async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quotaPayload) })
})

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
// Let the quota snapshot land (it is fetched once per page load) and give the
// rows a frame to paint with it.
await page.waitForSelector('.dsh-mp2-fallbackQuota', { timeout: 8000 }).catch(() => null)
await page.waitForTimeout(400)

const lines = await page.$$eval('.dsh-mp2-fallbackItem', (rows) => rows.map((row) => {
  const quota = row.querySelector('.dsh-mp2-fallbackQuota')
  return {
    name: row.querySelector('.dsh-mp2-modelName')?.textContent ?? null,
    supplier: row.querySelector('.dsh-mp2-description')?.textContent ?? null,
    quota: quota?.textContent ?? null,
    risk: quota === null ? null : quota.className.includes('QuotaRisk'),
    title: quota?.getAttribute('title') ?? null,
  }
}))
console.log('queue lines   :', JSON.stringify(lines, null, 1))
if (lines.some((line) => line.quota === null)) {
  console.log('NOTE          : a queued route whose supplier the gateway does not know has no quota line')
}

// The line must sit on the row's own detail line, under the model name, so the
// number reads in the same left-to-right sweep as the name above it.
const geo = await page.evaluate(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: +r.left.toFixed(1), top: +r.top.toFixed(1), width: +r.width.toFixed(1) } }
  const row = document.querySelector('.dsh-mp2-fallbackItem')
  const name = row?.querySelector('.dsh-mp2-modelName')
  const quota = row?.querySelector('.dsh-mp2-fallbackQuota')
  const supplier = row?.querySelector('.dsh-mp2-description')
  return {
    name: name === undefined || name === null ? null : box(name),
    quota: quota === undefined || quota === null ? null : box(quota),
    supplier: supplier === undefined || supplier === null ? null : box(supplier),
  }
})
console.log('geometry      :', JSON.stringify(geo))
if (geo.name !== null && geo.quota !== null && geo.quota.top <= geo.name.top) {
  throw new Error('the quota line must sit BELOW the model name, not beside it')
}

await page.screenshot({ path: OUT_DONE })
console.log('wrote', OUT_DONE)
await browser.close()
