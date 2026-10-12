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
const context = await browser.newContext({ viewport: { width: 1000, height: 780 } })
await context.setExtraHTTPHeaders({ cookie: sessionCookie() })
const page = await context.newPage()

// The five routes and the class each one answers with. The model ids are real
// ones this profile has wired; the stub only replaces the answer.
const ROWS = [
  ['group/auto-glm-5-3-flash', { ok: false, state: 'quota', error: 'insufficient balance' }, ''],
  ['group/auto-deepseek-v4-1-flash', { ok: false, state: 'rate', error: 'Rate limit reached for requests' }, ''],
  ['group/auto-gpt-5', { ok: false, state: 'auth', error: 'invalid api key provided' }, ''],
  ['group/auto-grok-4', { ok: false, state: 'timeout', error: 'timeout' }, ''],
  ['group/auto-qwen3-max', { ok: false, state: 'error', error: 'stream ended unexpectedly' }, ''],
]

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

await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)

const root = await page.$('.dsh-mp2-root')
if (root === null) throw new Error('the picker never mounted — is the plugin loaded?')

// Open the popup, then the fallback manager.
await page.click('.dsh-mp2-triggerLeft')
await page.waitForSelector('.dsh-mp2-list', { timeout: 5000 })
await page.click('.dsh-mp2-footerFallback')
await page.waitForSelector('.dsh-mp2-fallbackPage', { timeout: 5000 })
await page.waitForTimeout(300)

const rows = await page.$$('.dsh-mp2-fallbackItem')
if (rows.length === 0) throw new Error('the manager has no rows to probe')
console.log('rows           :', rows.length)

// Probe every row and wait for the labels to settle. The actions are revealed
// by hovering the row (they are hidden at rest so the list stays readable), so
// each probe has to be preceded by its own hover.
for (const row of rows) {
  await row.hover()
  await page.waitForTimeout(120)
  const button = await row.$('.dsh-mp2-fallbackTest')
  if (button !== null) await button.click()
}
await page.waitForTimeout(1200)

// Hover the first state so its tooltip is on screen in the shot: the label is
// the routing decision, the tooltip is the evidence.
await rows[0].hover()
await page.waitForTimeout(600)

const painted = await page.$$eval('.dsh-mp2-fallbackItem', (items) => items.map((item) => ({
  label: item.querySelector('.dsh-mp2-fallbackTest')?.textContent ?? null,
  color: getComputedStyle(item.querySelector('.dsh-mp2-fallbackTest')).color,
  title: item.querySelector('.dsh-mp2-fallbackTest')?.getAttribute('title') ?? null,
})))
console.log('--- painted states ---')
for (const state of painted) console.log(JSON.stringify(state))

await page.screenshot({ path: OUT })
console.log('wrote', OUT)
await browser.close()
