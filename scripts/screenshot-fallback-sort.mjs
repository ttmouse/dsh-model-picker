// The two orders, side by side: the drag order as the reader left it, and the
// automatic order the answers produce (connected first, quickest first).
//
// Run: DSH_LIVE_ORIGIN=http://127.0.0.1:60025 node scripts/screenshot-fallback-sort.mjs
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pickerSegment, withCheckoutPicker } from './bundle-swap.mjs'

const ORIGIN = process.env.DSH_LIVE_ORIGIN ?? 'http://127.0.0.1:60025'
const AUTHORITY = new URL(ORIGIN).host
const text = readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8')
const at = text.indexOf('client-connection/browser-session:')
const secret = Buffer.from(/secret:\s*(\S+)/.exec(text.slice(at))[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
const b64url = (v) => Buffer.from(v).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = Date.now()
const payload = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }))
const cookie = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}=v1.${payload}.${b64url(createHmac('sha256', secret).update(payload).digest())}`

const NEW_CLIENT = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')
const shell = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const browser = await chromium.launch({ executablePath: shell })
const context = await browser.newContext({ viewport: { width: 1000, height: 900 } })
await context.setExtraHTTPHeaders({ cookie })
await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
  const response = await route.fetch()
  const html = await response.text()
  if (pickerSegment(html) === null) return route.fulfill({ response })
  return route.fulfill({ response, body: withCheckoutPicker(html, NEW_CLIENT) })
})
const page = await context.newPage()

// Four routes in a deliberately non-speed order; the stub answers with round
// trips that do not follow it, so the automatic order has something to show.
const ROUTES = [
  'deepseek-official/deepseek-flash',
  'deepseek-account/deepseek-flash',
  'opencode-go1/deepseek-v4-pro',
  'commandcode/deepseek/deepseek-v4-pro',
]
const TRIPS = [1650, 420, 900, 310]

await page.addInitScript(({ routes, trips }) => {
  window.localStorage.setItem('dsh.modelPicker.fallback', JSON.stringify(routes))
  window.localStorage.setItem('dsh.modelPicker.fallbackSort', 'manual')
  window.localStorage.removeItem('dsh.modelPicker.probes')
  window.localStorage.removeItem('dsh.modelPicker.failures')
  let i = 0
  const realFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? '')
    if (!url.includes('/api/model-picker/test')) return realFetch(input, init)
    const ms = trips[i % trips.length]
    i += 1
    return new Promise((resolve) => setTimeout(() => resolve({
      ok: true, json: async () => ({ ok: true, ms }),
    }), 60))
  }
}, { routes: ROUTES, trips: TRIPS })

await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
await page.evaluate(() => {
  document.querySelectorAll('[data-dam-theme="dialogs"], [data-dam-tour-head]').forEach((node) => node.remove())
  document.querySelector('.dsh-mp2-triggerLeft')?.click()
})
await page.waitForSelector('.dsh-mp2-list', { timeout: 8000 })
await page.evaluate(() => document.querySelector('.dsh-mp2-footerFallback')?.click())
await page.waitForSelector('.dsh-mp2-fallbackPage', { timeout: 8000 })
await page.waitForTimeout(300)

// Probe all four, then shoot the manual order.
for (const button of await page.$$('.dsh-mp2-fallbackItem .dsh-mp2-fallbackTest')) {
  await button.evaluate((node) => node.click())
}
await page.waitForTimeout(900)
const orderOf = () => page.$$eval('.dsh-mp2-fallbackItem .dsh-mp2-modelName', (nodes) => nodes.map((node) => node.textContent))
const marksOf = () => page.$$eval('.dsh-mp2-fallbackItem .dsh-mp2-fallbackMark', (nodes) => nodes.map((node) => node.textContent))
console.log('manual:', JSON.stringify(await orderOf()), JSON.stringify(await marksOf()))
await page.screenshot({ path: 'live-sort-manual.png' })

// Flip to automatic and shoot again.
await page.evaluate(() => document.querySelector('.dsh-mp2-fallbackSort')?.click())
await page.waitForTimeout(400)
console.log('auto  :', JSON.stringify(await orderOf()), JSON.stringify(await marksOf()))
await page.screenshot({ path: 'live-sort-auto.png' })
await browser.close()
