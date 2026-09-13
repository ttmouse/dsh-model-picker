// Diagnostic probe: open the running DSH web GUI, capture console/errors, and
// report whether the dsh-model-picker component mounted into the composer.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const URL = 'http://127.0.0.1:3080/'

// Reuse the auth cookie curl already exchanged for the one-time token.
const jar = readFileSync(process.env.DSH_COOKIE_JAR ?? '/tmp/dsh-cj.txt', 'utf8')
const cookies = jar
  .split('\n')
  .map((line) => (line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line))
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [domain, , path, , , name, value] = line.split('\t')
    return { domain, path, name, value, httpOnly: true, secure: false }
  })
  .filter((c) => c.name)

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
await context.addCookies(cookies)
const page = await context.newPage()
const logs = []
const clip = (s) => s.replace(/\/plugins\/\?\?[^\s)]+/g, '<combo>').slice(0, 400)
page.on('console', (m) => logs.push(`[${m.type()}] ${clip(m.text())}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${clip(e.message)}`))
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`))
page.on('response', (r) => {
  if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`)
})

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)

const report = await page.evaluate(() => {
  const el = document.querySelector('.dsh-mp2-root')
  const seat = document.querySelector('[data-slot="conversation.input.model"]')
  const bar = document.querySelector('[data-slot="conversation.composer.bar"]')
  return {
    hasRoot: el !== null,
    rootHtml: el === null ? null : el.outerHTML.slice(0, 300),
    hasStyle: document.getElementById('dsh-model-picker-style') !== null,
    seatHtml: seat === null ? null : seat.outerHTML.slice(0, 400),
    slotErrors: [...document.querySelectorAll('[data-slot-error]')].map((n) => n.getAttribute('data-slot-error')),
    barHtml: bar === null ? null : bar.outerHTML.slice(0, 1200),
  }
})

console.log(JSON.stringify(report, null, 2))

// Open the popup and capture what the user actually sees.
if (report.hasRoot) {
  await page.click('.dsh-mp2-triggerLeft')
  await page.waitForTimeout(800)
  const popup = await page.evaluate(() => ({
    searchPresent: document.querySelector('.dsh-mp2-search') !== null,
    searchFocused: document.activeElement === document.querySelector('.dsh-mp2-search'),
    providers: [...document.querySelectorAll('.dsh-mp2-provider')].map((n) =>
      `${n.querySelector('.dsh-mp2-providerName').textContent}:${n.querySelector('.dsh-mp2-providerCount').textContent}`),
    groups: [...document.querySelectorAll('.dsh-mp2-group')].map((g) => ({
      header: g.querySelector('.dsh-mp2-groupHeader')?.textContent ?? null,
      icon: g.querySelector('.dsh-mp2-groupHeader svg') !== null,
      models: [...g.querySelectorAll('.dsh-mp2-modelName')].map((n) => n.textContent),
    })),
    models: [...document.querySelectorAll('.dsh-mp2-option')].map((option) => ({
      name: option.querySelector('.dsh-mp2-modelName').textContent,
      desc: option.querySelector('.dsh-mp2-description')?.textContent ?? null,
    })),
  }))
  console.log('--- popup ---')
  console.log(JSON.stringify(popup, null, 2))
  await page.screenshot({ path: 'live-model-picker.png' })

  // The panel must not resize while the query narrows the result set.
  const box = () => page.evaluate(() => {
    const menu = document.querySelector('.dsh-mp2-menu')
    if (menu === null) return null
    const r = menu.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }
  })
  const open = await box()
  await page.fill('.dsh-mp2-search', 'deep')
  await page.waitForTimeout(300)
  const narrowed = await box()
  await page.screenshot({ path: 'live-model-picker-search.png' })
  await page.fill('.dsh-mp2-search', 'zzz-no-such-model')
  await page.waitForTimeout(300)
  const empty = await box()
  console.log('--- popup box (w/h/top) ---')
  console.log(JSON.stringify({ open, narrowed, empty, viewportTopOverflow: empty.top < 0 }, null, 2))
  await page.fill('.dsh-mp2-search', '')
}

console.log('--- logs ---')
for (const l of logs) console.log(l)

await browser.close()
