// Capture the fallback manager with every probe state on screen at once.
//
// A screenshot of one state proves one state. The question this feature
// answers — "quota spent, or just throttled?" — is only visible when the
// labels sit side by side, so the shot drives a probe per class and leaves
// all five rows wearing different answers.
//
// The states come from a stubbed probe route, because no live channel can be
// made to fail on demand: real channels answer, or fail for reasons of their
// own. The stub is installed at the browser's fetch, so everything else in the
// panel (the route list, the avatars, the layout) is the real thing.
//
// Run: node scripts/screenshot-states.mjs
//      DSH_LIVE_ORIGIN=http://127.0.0.1:19387 node scripts/screenshot-states.mjs
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = process.env.DSH_LIVE_ORIGIN ?? 'http://127.0.0.1:19387'
const AUTHORITY = new URL(ORIGIN).host
const OUT = process.env.SHOT_OUT ?? 'live-fallback-states.png'

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

// Swap the picker's segment of the served bundle for the checkout's file —
// the app serves an immutable snapshot from process start, so a fresh edit
// needs this to be what a live page runs (see screenshot-fallback-probe.mjs).
import { readFileSync as _rf } from 'node:fs'
const NEW_CLIENT = _rf(new URL('../lib/client.js', import.meta.url), 'utf8')
await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
  const response = await route.fetch()
  const body = await response.text()
  if (!body.includes("load({ id: 'dsh-model-picker'") || body.includes('--dsh-mp2-font-xs')) {
    return route.fulfill({ response })
  }
  const MARK = "window.__ModuleLoader__.load({ id: '"
  const start = body.indexOf(MARK + "dsh-model-picker'")
  const next = body.indexOf(MARK, start + MARK.length)
  return route.fulfill({ response, body: body.slice(0, start) + NEW_CLIENT + (next === -1 ? '' : body.slice(next)) })
})

const page = await context.newPage()

// The queue must name models this session's directory actually has, or the
// rows fall back to raw route ids: first pass asks the host for the real
// directory and picks one route per provider, then reload installs the stub.
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
const ROUTES = await page.evaluate(async () => {
  const body = await (await fetch('/api/model-picker/models')).json()
  const rows = body.models ?? body.rows ?? body
  const picked = []
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.provider)) continue
    seen.add(row.provider)
    picked.push(row.provider + '/' + row.id)
    if (picked.length === 5) break
  }
  return picked
})
if (ROUTES.length < 5) throw new Error(`the directory offered only ${ROUTES.length} routes`)

// The five routes and the class each one answers with.
const STATES = ['quota', 'rate', 'auth', 'timeout', 'error']
const ERRORS = {
  quota: 'insufficient balance',
  rate: 'Rate limit reached for requests',
  auth: 'invalid api key provided',
  timeout: 'timeout',
  error: 'stream ended unexpectedly',
}
const ROWS = ROUTES.map((route, index) => {
  const state = STATES[index]
  return [route, { ok: false, state, error: ERRORS[state] }]
})

await page.addInitScript((rows) => {
  // One route per provider so every row resolves to a real model row, and a
  // scripted answer per route so each state lands on its own line.
  window.localStorage.setItem('dsh.modelPicker.fallback', JSON.stringify(rows.map(([route]) => route)))
  window.localStorage.removeItem('dsh.modelPicker.failures')
  const answers = new Map()
  for (const [route, body] of rows) answers.set(route, body)
  const realFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? '')
    if (!url.includes('/api/model-picker/test')) return realFetch(input, init)
    const route = JSON.parse(init?.body ?? '{}')
    const key = `${route.provider}/${route.model}`
    const body = answers.get(key)
    // Every probe answers with a fixed delay so the shot can catch a row
    // mid-flight if it wants one, and never races the screenshot.
    return new Promise((resolve) => setTimeout(() => resolve({
      ok: true, json: async () => body ?? { ok: true, ms: 1200 },
    }), 120))
  }
}, ROWS)

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)

const root = await page.$('.dsh-mp2-root')
if (root === null) throw new Error('the picker never mounted — is the plugin loaded?')

// The shell's onboarding overlays swallow pointer events; this is a disposable
// headless profile, so they go away, and every press is a DOM click.
await page.evaluate(() => {
  document.querySelectorAll('[data-dam-theme="dialogs"], [data-dam-tour-head]').forEach((node) => node.remove())
})
const domClick = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel)

// Open the popup, then the fallback manager.
await domClick('.dsh-mp2-triggerLeft')
await page.waitForSelector('.dsh-mp2-list', { timeout: 5000 })
await domClick('.dsh-mp2-footerFallback')
await page.waitForSelector('.dsh-mp2-fallbackPage', { timeout: 5000 })
await page.waitForTimeout(300)

const rows = await page.$$('.dsh-mp2-fallbackItem')
if (rows.length === 0) throw new Error('the manager has no rows to probe')
console.log('rows           :', rows.length)

// Probe every row and wait for the labels to settle. The presses are DOM
// clicks (the actions are hover-revealed, and a pointer click can miss a row
// the hover just scrolled).
const rowButtons = await page.$$('.dsh-mp2-fallbackItem .dsh-mp2-fallbackTest')
for (const button of rowButtons) {
  await button.evaluate((node) => node.click())
}
await page.waitForTimeout(1200)

// Hover the first state so its tooltip is on screen in the shot: the label is
// the routing decision, the tooltip is the evidence.
await rows[0].hover()
await page.waitForTimeout(600)

const painted = await page.$$eval('.dsh-mp2-fallbackItem', (items) => items.map((item) => ({
  label: item.querySelector('.dsh-mp2-fallbackMark')?.textContent ?? null,
  color: item.querySelector('.dsh-mp2-fallbackMark') === null ? null : getComputedStyle(item.querySelector('.dsh-mp2-fallbackMark')).color,
  title: item.querySelector('.dsh-mp2-fallbackMark')?.getAttribute('title') ?? null,
})))
console.log('--- painted states ---')
for (const state of painted) console.log(JSON.stringify(state))

await page.screenshot({ path: OUT })
console.log('wrote', OUT)
await browser.close()
