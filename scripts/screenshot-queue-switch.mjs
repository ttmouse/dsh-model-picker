// Photograph the fallback queue as a switching surface (issue -20).
//
// The subject is the fallback page with a model already running: the row of
// that model says「当前正在使用」, and every other row is a press that commits
// its model. The frames are taken on the live shell, because the point is what
// a person sees when they open the page — the app serves its plugin bundle as a
// process-start snapshot (issue -12), so the picker's own segment is swapped for
// the checkout's file at the network layer and everything else stays real.
//
// Two frames, because the rule has two halves that only read together:
//
//   live-queue-switch.png         the page: the running row is marked and names
//                                 no switch, every other row names both the
//                                 press that switches and the drag that reorders
//   live-queue-switch-after.png   the moment after pressing another row: the
//                                 press was a switch, so the page closed and the
//                                 trigger now names the model that was pressed
//
// There is no "before" frame: the web profile is a symlink to this checkout, so
// the app already runs this build and no page on this machine can show the old
// one inside this round.
//
// Run: DSH_LIVE_ORIGIN=http://127.0.0.1:60025 node scripts/screenshot-queue-switch.mjs
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickerSegment, withCheckoutPicker } from './bundle-swap.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const NEW_CLIENT = readFileSync(join(here, '..', 'lib/client.js'), 'utf8')

const ORIGIN = process.env.DSH_LIVE_ORIGIN ?? 'http://127.0.0.1:60025'
const AUTHORITY = new URL(ORIGIN).host
const OUT_NOW = 'live-queue-switch.png'
const OUT_AFTER = 'live-queue-switch-after.png'

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

const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')
// The npm-global Playwright and its downloaded builds can disagree on the
// revision; the headless shell that is actually installed is named here.
const HEADLESS_SHELL = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')

const browser = await chromium.launch({ executablePath: HEADLESS_SHELL })
const context = await browser.newContext({ viewport: { width: 1000, height: 1100 } })
await context.setExtraHTTPHeaders({ cookie: sessionCookie() })

// The picker's segment of every served plugin bundle, swapped for the checkout's
// file: the app serves its plugin bundle as a process-start snapshot (issue
// -12), which on this machine can lag the checkout by a revision.
await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
  const response = await route.fetch()
  const body = await response.text()
  if (pickerSegment(body) === null) return route.fulfill({ response })
  return route.fulfill({ response, body: withCheckoutPicker(body, NEW_CLIENT) })
})

const page = await context.newPage()

// Learn the real directory first: the queue must name models this session has,
// or its rows fall back to raw route ids and the frame shows nothing useful.
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
const { routes } = await page.evaluate(async () => {
  const response = await fetch('/api/model-picker/models')
  const body = await response.json()
  const rows = body.models ?? body.rows ?? body
  const picked = []
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.provider)) continue
    seen.add(row.provider)
    picked.push(row.provider + '/' + row.id)
    if (picked.length === 6) break
  }
  // The session's own idea of its model, read off the trigger the composer
  // draws — the directory route does not carry it.
  return { routes: picked }
})
if (routes.length < 4) throw new Error(`the directory offered only ${routes.length} routes`)

// The running model is discovered by asking the picker itself: open it, read
// the row it draws as selected (the composer trigger's label is a name, and
// names repeat across providers), then close and seed the queue with that
// route first — so the frame has the one row that proves the mark.
await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
await page.evaluate(() => document.querySelector('.dsh-mp2-triggerLeft')?.click())
await page.waitForSelector('.dsh-mp2-list', { timeout: 5000 }).catch(() => {})
const current = await page.evaluate(() => {
  const row = document.querySelector('.dsh-mp2-option[aria-checked="true"]')
  if (row === null) return null
  // The option carries no route attribute; the id is its index, and the
  // directory order is what the list renders, so the name is the handle.
  return { name: row.querySelector('.dsh-mp2-modelName')?.textContent ?? null }
})
console.log('routes        :', JSON.stringify(routes), '| current row:', JSON.stringify(current))

// The route behind the selected row: same name in the directory, which is
// unique enough for a frame whose subject is the mark, not the routing.
const currentRoute = current === null ? null : await page.evaluate(async (name) => {
  const body = await (await fetch('/api/model-picker/models')).json()
  const rows = body.models ?? body.rows ?? body
  const hit = rows.find((row) => row.name === name)
  return hit === undefined ? null : hit.provider + '/' + hit.id
}, current.name)
console.log('current route :', JSON.stringify(currentRoute))

// The queue is seeded with four routes, the running model first so the first
// frame has a row to mark.
const seed = [currentRoute, ...routes]
  .filter((route) => route !== null)
  .filter((route, index, all) => all.indexOf(route) === index)
  .slice(0, 4)

await page.addInitScript((rows) => {
  window.localStorage.setItem('dsh.modelPicker.fallback', JSON.stringify(rows))
  window.localStorage.removeItem('dsh.modelPicker.failures')
}, seed)

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)

const clearOverlays = () => page.evaluate(() => {
  document.querySelectorAll('[data-dam-theme="dialogs"], [data-dam-tour-head]').forEach((node) => node.remove())
})
await clearOverlays()

// Every press is a DOM click: the shell's onboarding overlays swallow pointer
// events on a disposable profile, and a hit-tested click would miss.
const domClick = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel)

const openQueue = async () => {
  await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
  await domClick('.dsh-mp2-triggerLeft')
  // The first press can land before hydration has wired the handler; a second
  // press on an already-open (or freshly opened) trigger is a no-op that closes
  // nothing, so the page state is checked rather than assumed.
  const opened = await page.waitForSelector('.dsh-mp2-list', { timeout: 5000 }).then(() => true, () => false)
  if (!opened) {
    const debug = await page.evaluate(() => ({
      root: document.querySelector('.dsh-mp2-root') !== null,
      trigger: document.querySelector('.dsh-mp2-triggerLeft') !== null,
      menus: document.querySelectorAll('.dsh-mp2-menu').length,
      text: document.querySelector('.dsh-mp2-triggerLabel')?.textContent ?? null,
    }))
    throw new Error('the model popup did not open: ' + JSON.stringify(debug))
  }
  await domClick('.dsh-mp2-footerFallback')
  await page.waitForSelector('.dsh-mp2-fallbackPage', { timeout: 5000 })
  await page.waitForTimeout(350)
}

// ── The two frames: the page, and the switch its rows answer ──
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
await page.waitForTimeout(2000)
await clearOverlays()
await openQueue()

const now = await page.$$eval('.dsh-mp2-fallbackItem', (nodes) => nodes.map((node) => ({
  name: node.querySelector('.dsh-mp2-modelName')?.textContent ?? null,
  role: node.getAttribute('role'),
  checked: node.getAttribute('aria-checked'),
  mark: node.querySelector('.dsh-mp2-fallbackCurrent')?.textContent ?? null,
  title: node.getAttribute('title'),
})))
console.log('now           :', JSON.stringify(now, null, 0))
const marked = now.filter((row) => row.mark !== null)
if (marked.length > 1) throw new Error('more than one row claims to be in use')
if (now.some((row) => row.role !== 'button')) throw new Error('a queued row is not pressable')

// Geometric audit: the in-use mark shares its midline with the model name on
// the same row (container `align-items`, not a margin nudge), and every row's
// copy column starts at the same left edge.
const geo = await page.evaluate(() => {
  const mid = (el) => { const r = el.getBoundingClientRect(); return +(r.top + r.height / 2).toFixed(1) }
  const rows = [...document.querySelectorAll('.dsh-mp2-fallbackItem')]
  const marks = rows.map((row) => {
    const mark = row.querySelector('.dsh-mp2-fallbackCurrent')
    const name = row.querySelector('.dsh-mp2-modelName')
    return mark === null ? null : { name: mid(name), mark: mid(mark), delta: +(mid(mark) - mid(name)).toFixed(1) }
  })
  return { marks, lefts: rows.map((row) => +row.getBoundingClientRect().left.toFixed(1)) }
})
console.log('geometry      :', JSON.stringify(geo))

await page.screenshot({ path: OUT_NOW })

// Frame 3: press a row that is not the running model. The press is the pointer
// gesture the panel now answers — down and up in one spot — so the frame after
// it shows the switch it committed.
const pressIndex = now.findIndex((row) => row.mark === null)
if (pressIndex === -1) throw new Error('the seed left no other row to press')
const target = now[pressIndex].name
const rowBox = await page.$$eval('.dsh-mp2-fallbackItem', (nodes, index) => {
  const rect = nodes[index].getBoundingClientRect()
  return { x: rect.left + 40, y: rect.top + rect.height / 2 }
}, pressIndex)
await page.mouse.move(rowBox.x, rowBox.y)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(1200)
await clearOverlays()
const closed = await page.evaluate(() => document.querySelector('.dsh-mp2-fallbackPage') === null)
const trigger = await page.evaluate(() => document.querySelector('.dsh-mp2-triggerLabel')?.textContent ?? null)
console.log('after press   : target=%s closed=%s trigger=%s', JSON.stringify(target), closed, JSON.stringify(trigger))
if (!closed) throw new Error('a press on a queued row must commit and close the page')
await page.screenshot({ path: OUT_AFTER })

console.log('wrote', OUT_NOW, ',', OUT_AFTER)
await browser.close()
