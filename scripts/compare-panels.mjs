// Put the model popup and the fallback page on the same scale and measure both:
// panel height, list height, row heights, row pitch, row padding/line boxes.
// The two surfaces are cropped from the same viewport in one run, so a
// difference in the pictures is a difference in the plugin, not in the camera.
//
// Run: DSH_LIVE_ORIGIN=http://127.0.0.1:60025 node scripts/compare-panels.mjs
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
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
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
await context.setExtraHTTPHeaders({ cookie })
await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
  const response = await route.fetch()
  const html = await response.text()
  const served = pickerSegment(html)
  if (served === null) return route.fulfill({ response })
  return route.fulfill({ response, body: withCheckoutPicker(html, NEW_CLIENT) })
})
const page = await context.newPage()

// The test route is stubbed: the shot is about where the answer sits, not
// about what a channel says, and a real probe would spend a request.
await page.addInitScript(() => {
  const realFetch = window.fetch.bind(window)
  let seen = 0
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? '')
    if (!url.includes('/api/model-picker/test')) return realFetch(input, init)
    seen += 1
    const first = seen === 1
    return new Promise((resolve) => setTimeout(() => resolve({
      ok: true,
      json: async () => (first ? { ok: true, ms: 1500 } : { ok: false, state: 'quota', error: 'insufficient balance' }),
    }), 80))
  }
})


// A queue with content, so the fallback page has rows to measure.
await page.addInitScript(() => {
  window.localStorage.setItem('dsh.modelPicker.fallback', JSON.stringify(['deepseek-official/deepseek-flash','deepseek-account/deepseek-flash','opencode-go1/deepseek-v4-pro','commandcode/deepseek/deepseek-v4-pro','magpie/deepseek-v4.1-flash','17an/qwen3-max','magpie/glm-5.3-flash','zai-coding-cn/glm-5.3-flash','minimax-code/m3.1-flash-preview','clim/deepseek-v4.1-flash','lobsterai/deepseek-v4.1-flash','opencode-go1/deepseek-v4-flash']))
})

const mount = async () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(attempt === 0 ? 9000 : 5000)
    const ok = await page.evaluate(() => {
      const r = document.querySelector('.dsh-mp2-root')?.getBoundingClientRect()
      return !!r && r.width > 0 && r.height > 0
    })
    if (ok) return true
  }
  return false
}
if (!(await mount())) throw new Error('the picker never mounted — is the plugin enabled?')
await page.evaluate(() => {
  document.querySelectorAll('[data-dam-theme="dialogs"], [data-dam-tour-head]').forEach((node) => node.remove())
})

const MEASURE = () => {
  const menu = document.querySelector('.dsh-mp2-menu')
  const list = document.querySelector('.dsh-mp2-list, .dsh-mp2-fallbackList')
  const rows = [...document.querySelectorAll('.dsh-mp2-option')].filter((el) => el.getBoundingClientRect().height > 0)
  const rowInfo = rows.slice(0, 6).map((el) => {
    const r = el.getBoundingClientRect()
    const name = el.querySelector('.dsh-mp2-modelName')
    const desc = el.querySelector('.dsh-mp2-description')
    const s = getComputedStyle(el)
    return {
      h: +r.height.toFixed(1),
      nameH: name ? +name.getBoundingClientRect().height.toFixed(1) : null,
      descH: desc ? +desc.getBoundingClientRect().height.toFixed(1) : null,
      desc: desc ? desc.textContent.slice(0, 18) : null,
      pad: s.padding, gap: s.gap, minH: s.minHeight, lh: s.lineHeight, fs: s.fontSize,
    }
  })
  const pitches = []
  for (let i = 1; i < rowInfo.length; i++) {
    const a = rows[i - 1].getBoundingClientRect()
    const b = rows[i].getBoundingClientRect()
    pitches.push(+(b.top - a.top).toFixed(1))
  }
  const menuR = menu?.getBoundingClientRect()
  const listR = list?.getBoundingClientRect()
  return {
    menu: menuR ? { x: Math.round(menuR.x), y: Math.round(menuR.y), w: Math.round(menuR.width), h: Math.round(menuR.height) } : null,
    list: listR ? { x: Math.round(listR.x), y: Math.round(listR.y), w: Math.round(listR.width), h: Math.round(listR.height) } : null,
    rows: rowInfo,
    pitches,
    detail: (() => {
      const row = rows.find((el) => el.querySelector('.dsh-mp2-fallbackMark'))
      if (!row) return null
      const desc = row.querySelector('.dsh-mp2-description')
      const mark = row.querySelector('.dsh-mp2-fallbackMark')
      const name = row.querySelector('.dsh-mp2-modelName')
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), mid: Math.round(b.y + b.height / 2) } }
      return { name: r(name), desc: desc ? r(desc) : null, mark: r(mark),
        markFollowsDesc: desc ? r(mark).x > r(desc).x : null,
        sameLineAsDesc: desc ? Math.abs(r(mark).mid - r(desc).mid) <= 2 : null,
        sameLineAsName: Math.abs(r(mark).mid - r(name).mid) <= 2 }
    })(),
  }
}

await page.evaluate(() => document.querySelector('.dsh-mp2-triggerLeft')?.click())
await page.waitForSelector('.dsh-mp2-list', { timeout: 8000 })
await page.waitForTimeout(400)
const model = await page.evaluate(MEASURE)
await page.screenshot({ path: 'live-panel-model.png' })

await page.evaluate(() => document.querySelector('.dsh-mp2-footerFallback')?.click())
await page.waitForSelector('.dsh-mp2-fallbackPage', { timeout: 8000 })
await page.waitForTimeout(300)
// probeFirstRows: two rows get an answer so the detail line has a mark on it.
const probeFirstRows = await page.$$('.dsh-mp2-fallbackItem .dsh-mp2-fallbackTest')
for (const button of probeFirstRows.slice(0, 2)) await button.evaluate((node) => node.click())
await page.waitForTimeout(600)
const fallback = await page.evaluate(MEASURE)
await page.screenshot({ path: 'live-panel-fallback.png' })

console.log('MODEL    :', JSON.stringify(model, null, 1))
console.log('FALLBACK :', JSON.stringify(fallback, null, 1))
writeFileSync('/tmp/panels.json', JSON.stringify({ model, fallback }, null, 1))
await browser.close()
