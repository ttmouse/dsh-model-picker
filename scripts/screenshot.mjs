// Capture the README screenshot from the running GUI.
//
// The picker is shot with two models favourited: the 收藏 group is the feature a
// still image has to show, and it is empty on a fresh browser profile.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const URL = 'http://127.0.0.1:3080/'
const OUT = process.env.SHOT_OUT ?? 'screenshot.png'

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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
await context.addCookies(cookies)
const page = await context.newPage()

// Favourites live in localStorage, so a stale profile would leak into the shot.
await page.addInitScript(() => { window.localStorage.removeItem('dsh.modelPicker.favorites') })
await page.goto(URL, { waitUntil: 'domcontentloaded' })
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

// Let the favourites group, the badges and the star paints settle.
await page.waitForTimeout(500)
const favourites = await page.$$eval('.dsh-mp2-group', (groups) => {
  const first = groups[0]
  return {
    header: first?.querySelector('.dsh-mp2-groupHeader')?.textContent ?? null,
    models: [...(first?.querySelectorAll('.dsh-mp2-modelName') ?? [])].map((n) => n.textContent),
  }
})
if (favourites.models.length === 0) throw new Error('the 收藏 group is empty — the shot would not show the feature')
console.log('favorites group:', JSON.stringify(favourites))

await page.screenshot({ path: OUT })
console.log('wrote', OUT)
await browser.close()
