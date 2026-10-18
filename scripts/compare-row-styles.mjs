// Compare one model-list row and one fallback-list row: computed styles and
// geometry, side by side, so "样式共用" is a measurement and not a claim.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:60025'
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
await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
  const response = await route.fetch()
  const html = await response.text()
  if (!html.includes("load({ id: 'dsh-model-picker'") || html.includes('--dsh-mp2-font-xs')) return route.fulfill({ response })
  const MARK = "window.__ModuleLoader__.load({ id: '"
  const start = html.indexOf(MARK + "dsh-model-picker'")
  const next = html.indexOf(MARK, start + MARK.length)
  return route.fulfill({ response, body: html.slice(0, start) + NEW_CLIENT + (next === -1 ? '' : html.slice(next)) })
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

const probe = () => page.evaluate(() => {
  const pick = (row) => {
    if (row === null) return null
    const cs = (el) => {
      const s = getComputedStyle(el)
      return { fs: s.fontSize, lh: s.lineHeight, fw: s.fontWeight, pad: s.padding, mh: s.minHeight, gap: s.gap, radius: s.borderRadius, bg: s.backgroundColor }
    }
    return {
      row: cs(row),
      rowH: +row.getBoundingClientRect().height.toFixed(1),
      name: cs(row.querySelector('.dsh-mp2-modelName')),
      desc: cs(row.querySelector('.dsh-mp2-description')),
    }
  }
  const out = { model: pick(document.querySelector('.dsh-mp2-list .dsh-mp2-option')) }
  document.querySelector('.dsh-mp2-footerFallback')?.click()
  return out
})
const modelRow = await probe()
await page.waitForSelector('.dsh-mp2-fallbackPage', { timeout: 5000 })
await page.waitForTimeout(200)
const fallbackRow = await page.evaluate(() => {
  const row = document.querySelector('.dsh-mp2-fallbackItem')
  if (row === null) return null
  const cs = (el) => {
    const s = getComputedStyle(el)
    return { fs: s.fontSize, lh: s.lineHeight, fw: s.fontWeight, pad: s.padding, mh: s.minHeight, gap: s.gap, radius: s.borderRadius, bg: s.backgroundColor }
  }
  return {
    row: cs(row),
    rowH: +row.getBoundingClientRect().height.toFixed(1),
    name: cs(row.querySelector('.dsh-mp2-modelName')),
    desc: cs(row.querySelector('.dsh-mp2-description')),
  }
})
console.log('MODEL    :', JSON.stringify(modelRow))
console.log('FALLBACK :', JSON.stringify(fallbackRow))
await browser.close()
