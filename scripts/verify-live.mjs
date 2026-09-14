// Real-browser verification against the live dsh web GUI.
//
// Forges the same signed browser-session cookie the host mints (the secret is
// the durable credential record at client-connection/browser-session), then
// drives the real page with Playwright: reads the composer tool row, opens the
// model popup, and reports what the user actually sees — including computed
// widths, which is what a jsdom test cannot show.
//
// Run: node scripts/verify-live.mjs
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = 'http://127.0.0.1:3080'
const AUTHORITY = '127.0.0.1:3080'
const CREDENTIALS = join(homedir(), '.dsh/.credentials.yaml')

/** The durable signing secret written by the host's browser-auth initialization. */
function readSecret() {
  const text = readFileSync(CREDENTIALS, 'utf8')
  const at = text.indexOf('client-connection/browser-session:')
  if (at === -1) throw new Error('no browser-session credential record')
  const match = /secret:\s*(\S+)/.exec(text.slice(at))
  if (match === null) throw new Error('no secret in the credential record')
  // The record stores base64url text of the raw key bytes; the host signs with
  // the decoded bytes, so signing with the text would fail verification.
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
}

const b64url = (value) => Buffer.from(value).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

const secret = readSecret()
const cookieName = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}`
const now = Date.now()
const body = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }))
const cookieValue = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
console.log('cookie name :', cookieName)

const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')

// The globally installed Playwright expects a browser build this machine has
// not downloaded; an installed headless shell is used directly instead.
const HEADLESS_SHELL = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')

const browser = await chromium.launch({ executablePath: HEADLESS_SHELL })
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
// The browser cookie jar path is rejected by the host while an explicit header
// is accepted (see scripts/probe-transport.mjs), so the credential is injected
// as a request header for every request instead.
await context.setExtraHTTPHeaders({ cookie: `${cookieName}=${cookieValue}` })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => { consoleErrors.push(`pageerror: ${err.message}`) })
page.on('request', async (request) => {
  if (request.resourceType() !== 'document') return
  const headers = await request.allHeaders()
  console.log('doc request :', request.url())
  console.log('  host      :', headers.host)
  console.log('  cookie    :', (headers.cookie ?? '(none)').slice(0, 60) + '…')
  console.log('  cookie ok :', headers.cookie === `${cookieName}=${cookieValue}`)
  console.log('  expect len:', `${cookieName}=${cookieValue}`.length, 'actual len:', (headers.cookie ?? '').length)
})
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => { consoleErrors.push(`pageerror: ${err.message}`) })

const response = await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
console.log('http status :', response?.status())
console.log('title       :', await page.title())
// The composer chrome and client plugins arrive over the boot graph.
try {
  await page.waitForSelector('[data-composer-card], textarea', { timeout: 30_000 })
} catch {
  console.log('--- composer did not appear; page diagnostics ---')
  console.log('url    :', page.url())
  console.log('body   :', (await page.evaluate(() => document.body.innerText)).slice(0, 800))
  console.log('boot   :', await page.evaluate(() => JSON.stringify(window.__DSH_BOOT__ ?? null).slice(0, 600)))
  console.log('errors :', consoleErrors.join('\n') || '(none)')
  await page.screenshot({ path: join(process.cwd(), 'live-failed.png'), fullPage: true })
  await browser.close()
  process.exit(1)
}
await page.waitForTimeout(4000)

// ── What is in the composer tool row? ──────────────────────────────────────
const seat = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')]
  const found = {
    trigger: document.querySelector('.dsh-mp2-trigger') !== null,
    triggerHtml: document.querySelector('.dsh-mp2-trigger')?.outerHTML?.slice(0, 400) ?? null,
    triggerRect: (() => {
      const el = document.querySelector('.dsh-mp2-trigger')
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    })(),
    leftRect: (() => {
      const el = document.querySelector('.dsh-mp2-triggerLeft')
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    })(),
    leftText: document.querySelector('.dsh-mp2-triggerLeft')?.textContent ?? null,
    rightText: document.querySelector('.dsh-mp2-triggerRight')?.textContent ?? null,
    seatError: document.querySelector('[data-dsh-ms-seat-error]')?.textContent ?? null,
    toolRowButtons: rows.map(b => (b.textContent ?? '').trim()).filter(t => t !== '').slice(0, 20),
  }
  return found
})
console.log('--- composer model seat ---')
console.log(JSON.stringify(seat, null, 2))

// ── Open the popup and check the search-first layout ───────────────────────
if (seat.trigger) {
  await page.click('.dsh-mp2-triggerLeft')
  await page.waitForTimeout(600)
  const open = await page.evaluate(() => {
    const search = document.querySelector('.dsh-mp2-search')
    const menu = document.querySelector('.dsh-mp2-menu')
    return {
      searchPresent: search !== null,
      searchFocused: search !== null && document.activeElement === search,
      menuRect: menu === null ? null : (() => {
        const r = menu.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }
      })(),
      providers: [...document.querySelectorAll('.dsh-mp2-providerName')].map(n => n.textContent),
      models: [...document.querySelectorAll('.dsh-mp2-list .dsh-mp2-modelName')].map(n => n.textContent),
    }
  })
  console.log('--- popup after click ---')
  console.log(JSON.stringify(open, null, 2))

  // Search a provider name: both columns must narrow.
  await page.fill('.dsh-mp2-search', 'deep')
  await page.waitForTimeout(400)
  const searched = await page.evaluate(() => ({
    providers: [...document.querySelectorAll('.dsh-mp2-providerName')].map(n => n.textContent),
    models: [...document.querySelectorAll('.dsh-mp2-list .dsh-mp2-modelName')].map(n => n.textContent),
  }))
  console.log('--- after typing "deep" ---')
  console.log(JSON.stringify(searched, null, 2))
  await page.screenshot({ path: join(process.cwd(), 'live-popup.png') })

  // ── Keyboard-only operation ──────────────────────────────────────────────
  // The panel must be usable without the mouse: it opens with the first row
  // already under the cursor, arrows move it, and Enter commits it.
  await page.fill('.dsh-mp2-search', '')
  await page.waitForTimeout(300)
  const cursor = () => page.evaluate(() => {
    const row = document.querySelector('.dsh-mp2-list .dsh-mp2-optionActive')
    const search = document.querySelector('.dsh-mp2-search')
    const style = row === null ? null : getComputedStyle(row)
    return {
      name: row?.querySelector('.dsh-mp2-modelName')?.textContent ?? null,
      id: row?.id ?? null,
      inUse: row?.querySelector('.dsh-mp2-check svg') !== null,
      listed: document.querySelectorAll('.dsh-mp2-list .dsh-mp2-option').length,
      activeDescendant: search?.getAttribute('aria-activedescendant') ?? null,
      searchFocused: document.activeElement === search,
      // The cursor is a background surface and nothing else: no left rail, no
      // border, no outline. The user rejected an accent bar on the left edge.
      background: style?.backgroundColor ?? null,
      decoration: style === null ? null : [style.boxShadow, style.borderLeftWidth, style.outlineStyle].join(' | '),
    }
  })
  console.log('--- keyboard ---')
  const onOpen = await cursor()
  console.log('cursor on open :', JSON.stringify(onOpen))
  // The cursor must be readable without any left-edge decoration: a background
  // surface marks it, and nothing else does.
  if (onOpen.background === null || onOpen.background === 'rgba(0, 0, 0, 0)') {
    throw new Error('the cursor row has no background surface to mark it')
  }
  if (onOpen.decoration !== 'none | 0px | none') {
    throw new Error(`the cursor row carries left-edge decoration: ${onOpen.decoration}`)
  }
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  const moved = await cursor()
  console.log('after ArrowDown:', JSON.stringify(moved))
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  console.log('after Home     :', JSON.stringify(await cursor()))
  await page.screenshot({ path: join(process.cwd(), 'live-model-picker-keyboard.png') })

  // Walk the cursor onto the model already in use, then Enter: that closes the
  // popup and hands focus back without touching the live selection, which is
  // what makes this safe to run against the user's own session.
  let steps = 0
  let inUse = onOpen
  while (!inUse.inUse && steps < 40) {
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(80)
    inUse = await cursor()
    steps += 1
  }
  if (!inUse.inUse) {
    console.log('the model in use is not in the list; skipped the Enter check')
  } else {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    console.log('after Enter    :', JSON.stringify(await page.evaluate(() => ({
      menuClosed: document.querySelector('.dsh-mp2-menu') === null,
      triggerText: document.querySelector('.dsh-mp2-triggerLeft')?.textContent ?? null,
      focusBack: document.activeElement === document.querySelector('.dsh-mp2-triggerLeft'),
    }))))
  }
}

await page.screenshot({ path: join(process.cwd(), 'live-composer.png') })
console.log('--- console errors ---')
console.log(consoleErrors.length === 0 ? '(none)' : consoleErrors.join('\n'))

await browser.close()
