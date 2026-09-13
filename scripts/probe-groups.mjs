// Dump the live provider → model grouping from the running GUI.
//
// Opens the model popup and walks every provider entry, recording the models
// each one lists, then reports duplicate model names across providers and the
// current selection shown on the trigger. Answers "is this model filed under
// the wrong provider?" with the same DOM the user sees.
//
// Run: node scripts/probe-groups.mjs
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
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await context.setExtraHTTPHeaders({ cookie })
const page = await context.newPage()
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)

const trigger = await page.evaluate(() => ({
  model: document.querySelector('.dsh-mp2-triggerLeft .dsh-mp2-triggerLabel')?.textContent ?? null,
  effort: document.querySelector('.dsh-mp2-triggerRight span')?.textContent ?? null,
}))
console.log('current selection on trigger:', JSON.stringify(trigger))

await page.click('.dsh-mp2-triggerLeft')
await page.waitForTimeout(800)

/** Model names listed for the currently active provider column. */
const modelsOfActiveProvider = () => page.evaluate(() =>
  [...document.querySelectorAll('.dsh-mp2-list .dsh-mp2-modelName')].map(n => n.textContent))

const providerNames = await page.evaluate(() =>
  [...document.querySelectorAll('.dsh-mp2-provider .dsh-mp2-providerName')].map(n => n.textContent))

const mapping = []
for (const name of providerNames) {
  await page.evaluate((target) => {
    const button = [...document.querySelectorAll('.dsh-mp2-provider')]
      .find(b => b.querySelector('.dsh-mp2-providerName')?.textContent === target)
    if (button !== undefined) button.click()
  }, name)
  await page.waitForTimeout(250)
  const models = await modelsOfActiveProvider()
  mapping.push({ provider: name, models })
}

console.log('\n--- provider → models ---')
for (const row of mapping) {
  console.log(`\n[${row.provider}]  (${row.models.length})`)
  for (const model of row.models) console.log(`   ${model}`)
}

// A model name listed by several providers is normal (different routes serve
// the same model). Report it so a genuine mis-filing is distinguishable.
const byModel = new Map()
for (const row of mapping) {
  for (const model of row.models) {
    if (!byModel.has(model)) byModel.set(model, [])
    byModel.get(model).push(row.provider)
  }
}
console.log('\n--- model names listed by more than one provider ---')
let any = false
for (const [model, providers] of byModel) {
  if (providers.length < 2) continue
  any = true
  console.log(`${model}\n    ${providers.join('\n    ')}`)
}
if (!any) console.log('(none)')

// How the search facet treats these names: a query that only the vision twins
// carry must narrow BOTH columns to them, and a base-provider query must keep
// the twins out unless they actually match.
for (const query of ['vision', '17an-db']) {
  await page.fill('.dsh-mp2-search', query)
  await page.waitForTimeout(400)
  const result = await page.evaluate(() => ({
    providers: [...document.querySelectorAll('.dsh-mp2-provider .dsh-mp2-providerName')].map(n => n.textContent),
    models: [...document.querySelectorAll('.dsh-mp2-list .dsh-mp2-modelName')].map(n => n.textContent),
  }))
  console.log(`\n--- search "${query}" ---`)
  console.log('providers:', result.providers.join(' | '))
  console.log('models   :', result.models.join(' | '))
}

await browser.close()
