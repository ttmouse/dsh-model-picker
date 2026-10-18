// Photograph what a two-word query does before and after the phrase rule (-19).
//
// The reported want: `flash 4.1` should narrow the model list to the rows that
// carry both terms. HEAD matched the whole string as ONE substring, so a query
// with a space in it matched nothing at all — the list went empty and the panel
// said「没有匹配的模型」. The fix splits the box on whitespace and keeps the rows
// that carry every term.
//
// Both frames are taken on the live shell. The app serves its plugin bundle as a
// process-start snapshot (issue -12) and the web profile is a symlink to this
// checkout, so neither a plain refresh nor the installed copy can show the old
// build: the picker's own segment is swapped per frame instead — HEAD's
// `lib/client.js` for the "before" frame, the working tree's for the "after" —
// and everything around it (the real catalog, the real panel chrome) stays real.
//
// Two frames, same viewport, same query, so the only difference on screen is
// the rule:
//
//   live-search-terms-before.png   HEAD: "flash 4.1" → no matching models
//   live-search-terms-after.png    this branch: the rows carrying both terms
//
// Run: DSH_LIVE_ORIGIN=http://127.0.0.1:60025 node scripts/screenshot-search-terms.mjs
//      DSH_SEARCH_BEFORE=<ref> node scripts/screenshot-search-terms.mjs
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
// The ref whose client counts as "before". It has to predate the phrase rule,
// and the script asserts that HEAD really returns nothing for the query, so a
// later ref cannot turn the "before" frame into a copy of the "after" one.
const BEFORE_REF = process.env.DSH_SEARCH_BEFORE ?? '66c8f29'
const AUTHORITY = new URL(ORIGIN).host
const QUERY = process.env.DSH_SEARCH_QUERY ?? 'flash 4.1'

/** The signed browser-session cookie the host mints, forged the same way. */
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

// 1000px tall: below that the shell's session title row overlaps the panel's
// top edge and clips the search box, which is the subject of the shot.
const VIEWPORT = { width: 1600, height: 1000 }

const NOW = readFileSync(join(root, 'lib/client.js'), 'utf8')
const BEFORE = execFileSync('git', ['show', `${BEFORE_REF}:lib/client.js`], { cwd: root, encoding: 'utf8' })

/**
 * One frame: open the picker in the live shell with `source` as the picker
 * segment, type QUERY, then read what the panel actually drew.
 */
async function frame(browser, source, name, query) {
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
  // The shell's own on-first-run dialogs sit over the panel and would be the
  // thing the picture is of.
  await page.evaluate(() => {
    document.querySelectorAll('[data-dam-theme="dialogs"], [data-dam-tour-head]').forEach((node) => node.remove())
  })
  await page.evaluate(() => document.querySelector('.dsh-mp2-triggerLeft')?.click())
  await page.waitForSelector('.dsh-mp2-search', { timeout: 5000 })
  // Typed through the input the way a person types, so the panel's own change
  // handler (not a React state poke) is what narrows the list.
  await page.click('.dsh-mp2-search')
  await page.keyboard.type(query, { delay: 40 })
  await page.waitForTimeout(500)

  const seen = await page.evaluate(() => {
    const menu = document.querySelector('.dsh-mp2-menu')
    return {
      query: document.querySelector('.dsh-mp2-search')?.value ?? null,
      open: menu !== null,
      models: [...document.querySelectorAll('.dsh-mp2-list .dsh-mp2-modelName')].map((node) => node.textContent),
      providers: [...document.querySelectorAll('.dsh-mp2-provider .dsh-mp2-providerName')].map((node) => node.textContent),
      empty: document.querySelector('.dsh-mp2-empty')?.textContent ?? null,
      rect: menu === null ? null : (() => {
        const r = menu.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })(),
    }
  })
  const file = `live-search-terms-${name}.png`
  await page.screenshot({ path: join(root, file) })
  await page.close()
  await context.close()
  return { file, seen }
}

const FIRST_WORD = QUERY.trim().split(/\s+/u)[0]
const browser = await chromium.launch({ executablePath: shell })
const after = await frame(browser, NOW, 'after', QUERY)
const before = await frame(browser, BEFORE, 'before', QUERY)
// The control: the same branch with only the first word, so the second word's
// work is measured as a narrowing rather than asserted from the display name.
const oneWord = await frame(browser, NOW, 'one-word', FIRST_WORD)
await browser.close()

for (const shot of [before, after]) {
  console.log(shot.file, '| query:', JSON.stringify(shot.seen.query),
    '| models:', JSON.stringify(shot.seen.models),
    '| empty:', JSON.stringify(shot.seen.empty))
}

// The frames only mean something if they disagree, and disagree in the right
// direction: the old rule must find nothing for a two-word query, the new one
// must find rows. A "before" frame that already matched is a self-congratulating
// picture, not evidence.
if (before.seen.query !== QUERY || after.seen.query !== QUERY) {
  throw new Error(`the query did not reach the box (before=${JSON.stringify(before.seen.query)}, after=${JSON.stringify(after.seen.query)})`)
}
if (before.seen.models.length !== 0) {
  throw new Error(`${BEFORE_REF} is expected to match nothing for "${QUERY}" — is the fix already committed there? got ${JSON.stringify(before.seen.models)}`)
}
if (after.seen.models.length === 0) {
  throw new Error(`the fixed panel found nothing for "${QUERY}" — the fix is not in the working tree's client`)
}
// The panel only draws a row's display name, so this script cannot re-check the
// id or description a term may also have been answered by — rows like
// `Deepseek V4 1 Flash Free` are labelled without their dot while their route id
// really is `deepseek-v4.1-flash-free`. The per-field rule is pinned where the
// fields are visible instead: the `split fields` and `description` cases in
// scripts/interaction.mjs.
if (oneWord.seen.models.length <= after.seen.models.length) {
  throw new Error(`the second word must narrow the list: "${FIRST_WORD}" gave ${oneWord.seen.models.length}, "${QUERY}" gave ${after.seen.models.length}`)
}
// Every row the phrase kept must also have been found by the word alone: the
// phrase is a subset, which is what AND means on screen.
const wordSet = new Set(oneWord.seen.models)
for (const model of after.seen.models) {
  if (!wordSet.has(model)) throw new Error(`"${model}" survived "${QUERY}" but not "${FIRST_WORD}" — the phrase is not a narrowing of its own first word`)
}
console.log('narrowing:', JSON.stringify(FIRST_WORD), '->', oneWord.seen.models.length, '|', JSON.stringify(QUERY), '->', after.seen.models.length)

// The composite: the panel, cropped to its own bounds, before over after.
// Cropping happens in the page rather than through Playwright's `clip`, which
// would disagree with itself about where a fixed-position panel starts.
const pad = 28
const region = {
  x: Math.max(0, Math.round((after.seen.rect?.x ?? 0) - pad)),
  y: Math.max(0, Math.round((after.seen.rect?.y ?? 0) - pad)),
}
region.w = Math.round(Math.min(VIEWPORT.width - region.x, (after.seen.rect?.w ?? 600) + pad * 2))
region.h = Math.round(Math.min(VIEWPORT.height - region.y, (after.seen.rect?.h ?? 420) + pad * 2))

const shot = (file) => `<div class="shot" style="width:${region.w}px;height:${region.h}px">
    <img src="${pathToFileURL(join(root, file)).href}" width="${VIEWPORT.width}" height="${VIEWPORT.height}"
         style="left:${-region.x}px;top:${-region.y}px">
  </div>`

const describe = (seen) => seen.models.length === 0
  ? `搜索框里是 <code>${QUERY}</code>，列表一条不剩：<span class="bad">${seen.empty ?? '没有匹配的模型'}</span>`
  : `同一个查询，列表收窄到 ${seen.models.length} 条，每条都同时带着这两个词：` +
    seen.models.map((model) => `<code>${model}</code>`).join('、')

const compare = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
  .stack{display:flex;flex-direction:column;gap:16px;padding:20px}
  .frame{background:#fff;border-radius:14px;padding:14px 16px 16px}
  .cap{font-size:15px;line-height:23px;color:#1d1d1f;margin:0 0 10px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
  .cap b{font-weight:600;white-space:nowrap}
  .cap span{color:#5b5b60;font-size:13px}
  .cap code{background:#f0f0f2;border-radius:4px;padding:1px 5px;font-size:12px;color:#1d1d1f}
  code{background:#f0f0f2;border-radius:4px;padding:1px 5px;font-size:12px}
  .shot{position:relative;overflow:hidden;border-radius:10px;background:#fbfbfc}
  .shot img{position:absolute;display:block;max-width:none}
  .bad{color:#b42318;font-weight:500}
  .ok{color:#067647}
</style></head><body><div class="stack">
  <div class="frame">
    <p class="cap"><b>改动前（${BEFORE_REF}）</b><span>${describe(before.seen)}</span></p>
    ${shot(before.file)}
  </div>
  <div class="frame">
    <p class="cap"><b class="ok">改动后（本分支）</b><span>${describe(after.seen)}</span></p>
    ${shot(after.file)}
  </div>
</div></body></html>`

// The composite page is scaffolding, not a deliverable: keep it out of the repo.
const comparePath = join(tmpdir(), 'dsh-model-picker-search-terms-compare.html')
writeFileSync(comparePath, compare)

const composeBrowser = await chromium.launch({ executablePath: shell })
const page = await composeBrowser.newPage({
  viewport: { width: region.w + 72, height: 400 },
  deviceScaleFactor: 2,
})
await page.goto(pathToFileURL(comparePath).href)
await page.waitForTimeout(300)
await page.screenshot({ path: join(root, 'live-search-terms-compare.png'), fullPage: true })
await composeBrowser.close()
console.log('crop:', JSON.stringify(region))
console.log('wrote live-search-terms-before.png, live-search-terms-after.png, live-search-terms-compare.png')
