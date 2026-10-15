// Is the picker I just edited actually the one the desktop app will hand the
// browser?
//
// The desktop app does not read `lib/client.js` per request. It concatenates
// every client plugin into one bundle (`/plugins/??…&rev=<hash>`) and serves
// that snapshot with `cache-control: public, max-age=31536000, immutable`; the
// `rev` stays put for as long as the process does, so an edited file keeps the
// same URL and the same bytes. A page refresh therefore shows the OLD build —
// not "sometimes", but always, until the host rebuilds.
//
// So a delivery has two gates, and this checks both:
//   1. the installed copy matches the checkout it came from;
//   2. the bundle the host actually serves contains a string only the new build has.
// When gate 2 fails, the answer is "restart the app", never "hit refresh".
//
// Run: node scripts/verify-served.mjs [marker …]
//      DSH_LIVE_ORIGIN=http://127.0.0.1:19387 (default)
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const ORIGIN = process.env.DSH_LIVE_ORIGIN ?? 'http://127.0.0.1:19387'
const AUTHORITY = new URL(ORIGIN).host
const INSTALLED = process.env.DSH_INSTALLED_CLIENT
  ?? join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-model-picker/lib/client.js')

const markers = process.argv.slice(2)
if (markers.length === 0) markers.push('dsh-mp2-footerProbe')

/** The same forged browser-session cookie the live scripts use. */
function sessionCookie() {
  const text = readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8')
  const at = text.indexOf('client-connection/browser-session:')
  if (at === -1) throw new Error('no browser-session credential record to forge a cookie from')
  const secret = Buffer.from(/secret:\s*(\S+)/.exec(text.slice(at))[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
  const b64 = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  const name = 'dsh-auth-' + b64(createHash('sha256').update(AUTHORITY).digest())
  const now = Date.now()
  const body = b64(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }))
  return name + '=v1.' + body + '.' + b64(createHmac('sha256', secret).update(body).digest())
}

// ── Gate 1: is the checkout's build the one installed? ──
const local = readFileSync(join(root, 'lib/client.js'), 'utf8')
let installed = null
try {
  installed = readFileSync(INSTALLED, 'utf8')
} catch {
  throw new Error(`the profile has no client half installed at ${INSTALLED}`)
}
const installedMatches = installed === local
console.log('install : %s (%d vs %d bytes)', installedMatches ? 'matches the checkout' : 'DIFFERS from the checkout', installed.length, local.length)
for (const marker of markers) {
  const inLocal = local.includes(marker)
  if (!inLocal) throw new Error(`marker ${JSON.stringify(marker)} is not in the checkout's client.js — pick one the new build adds`)
  console.log('checkout: %s %s', marker, inLocal ? 'present' : 'missing')
}

// ── Gate 2: does the served bundle carry it? ──
const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')
const shell = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const browser = await chromium.launch({ executablePath: shell })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.setExtraHTTPHeaders({ cookie: sessionCookie() })
const page = await context.newPage()
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.dsh-mp2-trigger', { timeout: 30_000 })
await page.waitForTimeout(1000)
const urls = await page.evaluate(() => performance.getEntriesByType('resource')
  .map((entry) => entry.name).filter((name) => name.includes('/plugins/??')))
await browser.close()
if (urls.length === 0) throw new Error('the app served no plugin bundle at all')

// The host splits the plugins across more than one `??` bundle (the shipped
// ones, the third-party ones), so every candidate is checked and the verdict is
// "served by any of them" — looking at the first one only reports the official
// bundle and calls a perfectly good deploy missing.
const cookie = sessionCookie()
let served = null
let allPresent = false
for (const url of [...new Set(urls)]) {
  const response = await fetch(url, { headers: { cookie, 'cache-control': 'no-cache' } })
  const text = await response.text()
  const present = markers.filter((marker) => text.includes(marker))
  console.log('served  : rev=%s %d bytes %s [%s]',
    /rev=([a-f0-9]+)/.exec(url)?.[1] ?? '(none)', text.length, response.headers.get('cache-control'), present.join(',') || 'none of the markers')
  if (present.length === markers.length && served === null) {
    served = text
    allPresent = true
  }
}
console.log('---')
if (allPresent && installedMatches) {
  console.log('the app is serving this build: a page refresh shows it.')
} else if (allPresent) {
  console.log('the app is serving this build, but the installed copy drifted from the checkout.')
} else {
  console.log('the app is NOT serving this build. A refresh cannot help — restart the app (the bundle is a snapshot from process start).')
  process.exitCode = 1
}
