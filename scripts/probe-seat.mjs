// Report only what the composer model seat looks like in the live GUI.
// Used for A/B checks against the real host (see scripts/ab-registration.mjs).
//
// Run: node scripts/probe-seat.mjs
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = 'http://127.0.0.1:3080'
const AUTHORITY = '127.0.0.1:3080'
const HEADLESS_SHELL = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')

const text = readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8')
const at = text.indexOf('client-connection/browser-session:')
const secret = Buffer.from(/secret:\s*(\S+)/.exec(text.slice(at))[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
const b64url = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const now = Date.now()
const body = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }))
const cookie = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`

const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')
const browser = await chromium.launch({ executablePath: HEADLESS_SHELL })
const context = await browser.newContext()
await context.setExtraHTTPHeaders({ cookie })
const page = await context.newPage()
const errors = []
page.on('pageerror', (err) => errors.push(err.message))
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)

const seat = await page.evaluate(() => {
  const trigger = document.querySelector('.dsh-mp2-trigger')
  const left = document.querySelector('.dsh-mp2-triggerLeft')
  const builtin = document.querySelector('[data-dsh-ms-seat-error]')
  const rect = (el) => {
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  return {
    pluginTrigger: trigger !== null,
    triggerSize: rect(trigger),
    triggerText: left?.textContent ?? null,
    modelSwitchSeatText: builtin?.textContent ?? null,
  }
})
console.log(JSON.stringify(seat))
console.log('pageerrors:', errors.length === 0 ? '(none)' : errors.join(' | '))
await browser.close()
