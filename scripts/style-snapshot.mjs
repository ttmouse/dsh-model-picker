// Snapshot the picker's computed styles for a token-refactor diff: run before
// and after the change, then diff the JSON - the only allowed differences are
// the deliberate token collapses.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:60025'
const OUT = process.argv[3] ?? '/tmp/style-snapshot.json'
const AUTHORITY = new URL(ORIGIN).host
const text = readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8')
const at = text.indexOf('client-connection/browser-session:')
const secret = Buffer.from(/secret:\s*(\S+)/.exec(text.slice(at))[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
const b64url = (v) => Buffer.from(v).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = Date.now()
const body = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }))
const cookie = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`

const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')
const shell = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const browser = await chromium.launch({ executablePath: shell })
const context = await browser.newContext({ viewport: { width: 1000, height: 1100 } })
await context.setExtraHTTPHeaders({ cookie })

const NEW_CLIENT = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
import { pickerSegment, withCheckoutPicker } from './bundle-swap.mjs'
await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
  const response = await route.fetch()
  const html = await response.text()
  const served = pickerSegment(html)
  if (served === null) return route.fulfill({ response })
  return route.fulfill({ response, body: withCheckoutPicker(html, NEW_CLIENT) })
})

const page = await context.newPage()
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
await page.waitForTimeout(3000)
await page.evaluate(() => {
  document.querySelectorAll('[data-dam-theme="dialogs"], [data-dam-tour-head]').forEach((node) => node.remove())
  window.localStorage.setItem('dsh.modelPicker.fallback', JSON.stringify(['deepseek-official/deepseek-flash', 'deepseek-account/deepseek-flash']))
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
await page.evaluate(() => document.querySelector('.dsh-mp2-triggerLeft')?.click())
await page.waitForSelector('.dsh-mp2-list', { timeout: 5000 })
await page.waitForTimeout(300)

const PROPS = ['fontSize', 'lineHeight', 'fontWeight', 'borderRadius', 'gap', 'padding', 'height', 'letterSpacing']
const snap = (sel) => page.evaluate(({ sel, props }) => {
  const el = document.querySelector(sel)
  if (el === null) return null
  const s = getComputedStyle(el)
  const out = {}
  for (const p of props) out[p] = s[p]
  return out
}, { sel, props: PROPS })

const LIST_SELECTORS = [
  '.dsh-mp2-trigger', '.dsh-mp2-triggerRight', '.dsh-mp2-search',
  '.dsh-mp2-provider', '.dsh-mp2-providerCount', '.dsh-mp2-providerQuota',
  '.dsh-mp2-groupHeader', '.dsh-mp2-list .dsh-mp2-option',
  '.dsh-mp2-modelName', '.dsh-mp2-description', '.dsh-mp2-facts',
  '.dsh-mp2-context', '.dsh-mp2-footerAction', '.dsh-mp2-menu',
]
const FALLBACK_SELECTORS = [
  '.dsh-mp2-menuHeader', '.dsh-mp2-fallbackProbe', '.dsh-mp2-fallbackItem',
  '.dsh-mp2-modelName', '.dsh-mp2-description', '.dsh-mp2-fallbackTest',
  '.dsh-mp2-menuHeaderGroup',
]
const modelState = {}
for (const sel of LIST_SELECTORS) modelState[sel] = await snap(sel)
await page.evaluate(() => document.querySelector('.dsh-mp2-footerFallback')?.click())
await page.waitForSelector('.dsh-mp2-fallbackPage', { timeout: 5000 })
await page.waitForTimeout(300)
const fallbackState = {}
for (const sel of FALLBACK_SELECTORS) fallbackState[sel] = await snap(sel)
writeFileSync(OUT, JSON.stringify({ model: modelState, fallback: fallbackState }, null, 1))
console.log('wrote', OUT)
await browser.close()
