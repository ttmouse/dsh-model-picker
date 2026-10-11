// Capture the README screenshot from the running GUI.
//
// The picker is shot with two models favourited: the 收藏 group that a still
// image has to show is empty on a fresh browser profile, and the 最近使用 group
// above it only exists once this run has recorded a route.
//
// Run: node scripts/screenshot.mjs
//      DSH_LIVE_ORIGIN=http://127.0.0.1:19387 node scripts/screenshot.mjs
//
// The origin is selectable for the same reason `verify-live.mjs` selects it:
// 3080 is the `web` profile, which links this repo, while the desktop app's
// 19387 serves its own installed copy of the plugin. Whichever shell is running
// is the one worth photographing, and the auth below works for either.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = process.env.DSH_LIVE_ORIGIN ?? 'http://127.0.0.1:3080'
const AUTHORITY = new URL(ORIGIN).host
const OUT = process.env.SHOT_OUT ?? 'screenshot.png'

/**
 * Mint the same signed browser-session cookie the host mints, rather than
 * reading a cookie jar. The jar was a by-product of some earlier curl exchange,
 * so it goes stale and disappears, and the shot then fails for a reason that
 * has nothing to do with the UI.
 */
function sessionCookie() {
  const text = readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8')
  const at = text.indexOf('client-connection/browser-session:')
  if (at === -1) throw new Error('no browser-session credential record')
  const match = /secret:\s*(\S+)/.exec(text.slice(at))
  if (match === null) throw new Error('no secret in the credential record')
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
  const b64url = (value) => Buffer.from(value).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  const name = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}`
  const now = Date.now()
  const body = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }))
  const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
  return `${name}=${value}`
}

// The globally installed Playwright expects a browser build this machine has not
// downloaded; an installed headless shell is used directly instead.
const HEADLESS_SHELL = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')

const browser = await chromium.launch({ executablePath: HEADLESS_SHELL })
// The popup is anchored above the composer and carries a fixed height
// (clamp(220px, 100vh - 340px, 400px)), so a 720px-tall window crops its last
// rows mid-word. The shot is taken at a height that fits the whole panel: a
// storefront image whose subject is half cut off advertises the wrong thing.
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
// The browser cookie jar path is rejected by the host while an explicit header
// is accepted, so the credential rides as a request header for every request.
await context.setExtraHTTPHeaders({ cookie: sessionCookie() })
const page = await context.newPage()

// Both mirrors live in localStorage, so a stale profile would leak into the
// shot: the favorites would be someone else's, and the history would be a list
// of routes this run never used.
await page.addInitScript(() => {
  window.localStorage.removeItem('dsh.modelPicker.favorites')
  window.localStorage.removeItem('dsh.modelPicker.recent')
})
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)

const root = await page.$('.dsh-mp2-root')
if (root === null) throw new Error('the picker never mounted — is the plugin loaded?')

await page.click('.dsh-mp2-triggerLeft')
await page.waitForSelector('.dsh-mp2-list', { timeout: 5000 })
await page.waitForTimeout(400)

// Star two rows from different suppliers, so 收藏 shows a cross-provider list.
for (const name of ['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro']) {
  const star = page.locator('.dsh-mp2-option', { hasText: name }).first().locator('.dsh-mp2-star')
  await star.click()
  await page.waitForTimeout(120)
}

// Let the mirror groups, the badges and the star paints settle.
await page.waitForTimeout(500)
/**
 * Read one group by its heading — the history group above 收藏 shifts the
 * indices, so the mirrors are found by name. The GUI's locale decides which
 * language that name is in, so both are accepted.
 */
const namedGroup = (headers) => page.$$eval('.dsh-mp2-group', (groups, wanted) => {
  const group = groups.find((g) => wanted.includes(g.querySelector('.dsh-mp2-groupHeader')?.textContent ?? ''))
  return group === undefined ? null : {
    header: group.querySelector('.dsh-mp2-groupHeader')?.textContent ?? null,
    models: [...group.querySelectorAll('.dsh-mp2-modelName')].map((n) => n.textContent),
  }
}, headers)
const favourites = await namedGroup(['Favorites', '收藏'])
if (favourites === null || favourites.models.length === 0) {
  throw new Error('the 收藏 group is empty — the shot would not show the feature')
}
console.log('favorites group:', JSON.stringify(favourites))
// The history group is the other feature a still image has to show, and the
// panel records the route in use the moment it mounts.
const history = await namedGroup(['Recent', '最近使用'])
if (history === null || history.models.length === 0) {
  throw new Error('the 最近使用 group is empty — the shot would not show the feature')
}
console.log('history group  :', JSON.stringify(history))

await page.screenshot({ path: OUT })
console.log('wrote', OUT)
await browser.close()
