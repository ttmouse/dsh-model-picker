// Photograph what Enter does while a pinyin candidate is still open.
//
// The reported bug (`-18`): typing `flash` through an IME and pressing Enter to
// commit the candidate closed the whole panel. That path is IME state, so the
// shot is taken in real Chromium against the live shell, driving the composition
// through CDP (`Input.imeSetComposition` leaves `isComposing` true on the
// confirming keydown, exactly as an OS IME does) instead of faking a
// KeyboardEvent the panel could never see.
//
// Two frames, one crop, same viewport:
//   before  HEAD's client: Enter commits the candidate *and* picks the
//           highlighted model, so the panel is gone
//   after   the checkout's client: Enter only commits the candidate, the panel
//           stays open with the query in its search box
//
// Run: node scripts/screenshot-ime.mjs
//      DSH_LIVE_ORIGIN=http://127.0.0.1:60025 DSH_IME_BEFORE=HEAD node scripts/screenshot-ime.mjs
import { createHash, createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pickerSegment, withCheckoutPicker } from './bundle-swap.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const ORIGIN = process.env.DSH_LIVE_ORIGIN ?? 'http://127.0.0.1:60025'
const BEFORE_REF = process.env.DSH_IME_BEFORE ?? 'HEAD'
const AUTHORITY = new URL(ORIGIN).host

// The host mints a signed browser-session cookie; forging the same one is more
// reliable than reading a jar that goes stale between runs.
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
  return `${name}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
}

const { chromium } = createRequire(join(homedir(), '.npm-global/lib/node_modules/playwright/index.js'))('playwright')
const shell = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell')

// 1000px tall, not 900: below that the shell's session title row overlaps the
// panel's top edge and hides the search box — the one thing this shot is about.
const VIEWPORT = { width: 1600, height: 1000 }

const NOW = readFileSync(join(root, 'lib/client.js'), 'utf8')
const BEFORE = execFileSync('git', ['show', `${BEFORE_REF}:lib/client.js`], { cwd: root, encoding: 'utf8' })

/**
 * One frame: open the picker in the live shell with `source` as the picker
 * segment, type `flash` through the IME, press Enter, then photograph the
 * viewport. Cropping happens later, on the same rectangle for both frames.
 */
async function frame(browser, source, name) {
  const context = await browser.newContext({ viewport: VIEWPORT })
  await context.setExtraHTTPHeaders({ cookie: sessionCookie() })
  await context.route((url) => url.href.includes('/plugins/??'), async (route) => {
    const response = await route.fetch()
    const html = await response.text()
    if (pickerSegment(html) === null) return route.fulfill({ response })
    return route.fulfill({ response, body: withCheckoutPicker(html, source) })
  })
  const page = await context.newPage()
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dsh-mp2-root', { timeout: 30_000 })
  await page.waitForTimeout(2500)
  await page.evaluate(() => {
    document.querySelectorAll('[data-dam-theme="dialogs"], [data-dam-tour-head]').forEach((node) => node.remove())
  })
  await page.evaluate(() => document.querySelector('.dsh-mp2-triggerLeft')?.click())
  await page.waitForSelector('.dsh-mp2-search', { timeout: 5000 })
  await page.evaluate(() => {
    const input = document.querySelector('.dsh-mp2-search')
    input.focus()
    window.__KEYS__ = []
    input.addEventListener('keydown', (event) => {
      window.__KEYS__.push({ key: event.key, isComposing: event.isComposing })
    }, true)
  })
  // An OS IME composes first, then takes Enter to commit the candidate. CDP is
  // the honest way to produce that state in headless Chromium: the confirming
  // keydown really carries `isComposing: true`.
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'flash', selectionStart: 5, selectionEnd: 5 })
  await page.waitForTimeout(120)
  const composed = await page.evaluate(() => ({
    value: document.querySelector('.dsh-mp2-search')?.value ?? null,
    open: document.querySelector('.dsh-mp2-menu') !== null,
  }))
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => {
    const rect = (el) => {
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    return {
      open: document.querySelector('.dsh-mp2-menu') !== null,
      query: document.querySelector('.dsh-mp2-search')?.value ?? null,
      keys: window.__KEYS__,
      trigger: document.querySelector('.dsh-mp2-triggerLeft')?.textContent ?? null,
      menu: rect(document.querySelector('.dsh-mp2-menu')),
      root: rect(document.querySelector('.dsh-mp2-root')),
    }
  })
  const file = `live-ime-full-${name}.png`
  await page.screenshot({ path: join(root, file) })
  await page.close()
  await context.close()
  return { file, composed, after }
}

/** The panel plus the composer row it hangs off, padded, in viewport pixels. */
function cropRegion(after) {
  const rootRect = after.root
  const menu = after.menu
  const left = Math.min(rootRect.x, menu?.x ?? rootRect.x) - 24
  const right = Math.max(rootRect.x + rootRect.w, menu === null ? 0 : menu.x + menu.w) + 24
  const top = (menu?.y ?? rootRect.y - 520) - 10
  const bottom = rootRect.y + rootRect.h + 34
  return { x: Math.max(0, Math.round(left)), y: Math.max(0, Math.round(top)), w: Math.round(right - left), h: Math.round(bottom - top) }
}

const browser = await chromium.launch({ executablePath: shell })
const after = await frame(browser, NOW, 'after')
const before = await frame(browser, BEFORE, 'before')
await browser.close()

for (const shot of [before, after]) {
  console.log(shot.file, '| composed:', JSON.stringify(shot.composed), '| after Enter:', JSON.stringify({
    open: shot.after.open, query: shot.after.query, keys: shot.after.keys, trigger: shot.after.trigger,
  }))
}
if (after.after.open !== true) throw new Error('the fixed panel closed on the IME commit')
if (after.after.query !== 'flash') throw new Error('the query lost the committed candidate')
if (before.after.open !== false) throw new Error(`HEAD is expected to close the panel on the IME commit — is the fix already committed at ${BEFORE_REF}?`)

const region = cropRegion(after.after)
// The crop is applied by the composite page, not by Playwright's `clip`: the
// panel hangs out of the shell's scroll body, and a clipped screenshot of a
// partially overlapped element disagrees with itself about where it starts.
const crop = (file) => `<div class="shot" style="width:${region.w}px;height:${region.h}px">
      <img src="${pathToFileURL(join(root, file)).href}" width="${VIEWPORT.width}" height="${VIEWPORT.height}"
           style="left:${-region.x}px;top:${-region.y}px">
    </div>`
const compare = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
  .stack{display:flex;flex-direction:column;gap:16px;padding:20px}
  .frame{background:#fff;border-radius:14px;padding:14px 16px 16px}
  .cap{font-size:15px;line-height:22px;color:#1d1d1f;margin:0 0 10px;display:flex;gap:10px;align-items:baseline}
  .cap b{font-weight:600}
  .cap span{color:#6b6b70;font-size:13px}
  .shot{position:relative;overflow:hidden;border-radius:10px;background:#fbfbfc}
  .shot img{position:absolute;display:block;max-width:none}
  .bad{color:#b42318}
  .ok{color:#067647}
</style></head><body><div class="stack">
  <div class="frame">
    <p class="cap"><b class="bad">改动前（HEAD）</b><span>拼音候选还没提交就按回车：候选被提交，高亮行也被选中，面板整个关掉</span></p>
    ${crop(before.file)}
  </div>
  <div class="frame">
    <p class="cap"><b class="ok">改动后（本分支）</b><span>同一个回车只把候选提交进搜索框，面板留在原地</span></p>
    ${crop(after.file)}
  </div>
</div></body></html>`
// The composite page is scaffolding, not a deliverable: keep it out of the repo.
const comparePath = join(tmpdir(), 'dsh-model-picker-ime-compare.html')
writeFileSync(comparePath, compare)

const composeBrowser = await chromium.launch({ executablePath: shell })
const page = await composeBrowser.newPage({
  viewport: { width: region.w + 72, height: 400 },
  deviceScaleFactor: 2,
})
await page.goto(pathToFileURL(comparePath).href)
await page.waitForTimeout(300)
await page.screenshot({ path: join(root, 'live-ime-compare.png'), fullPage: true })
await composeBrowser.close()
console.log('crop:', JSON.stringify(region))
console.log('wrote live-ime-full-before.png, live-ime-full-after.png, live-ime-compare.png')
