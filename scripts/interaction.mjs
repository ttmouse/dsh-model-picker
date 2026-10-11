// Interaction test for the browser half of dsh-model-picker.
//
// Renders the registered component into jsdom with react-dom/client, then
// drives it the way a user does: open the model popup, type a provider name,
// click a provider facet. Asserts the search narrows BOTH columns.
//
// Run: node scripts/interaction.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const HARNESS = '/Users/douba/Projects/deepseek-harness'

const { JSDOM } = createRequire(join(HARNESS, 'index.js'))(
  join(HARNESS, 'node_modules/.pnpm/jsdom@29.1.1/node_modules/jsdom'),
)

// ── Browser globals ─────────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.requestAnimationFrame = (fn) => { fn(0); return 0 }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// The plugin reads `localStorage` bare, so the jsdom storage has to be visible
// as a global for favorites to persist the way they do in a browser.
globalThis.localStorage = dom.window.localStorage
dom.window.localStorage.clear()

// The host half's fact route: the client fetches it once per mount, so stub it
// with the shape the route returns instead of hitting a live server.
const FACTS = { ok: true, models: [
  { provider: 'deepseek', id: 'deepseek-reasoner', contextWindow: 128000, input: ['text', 'image'] },
  { provider: 'zhipu', id: 'glm-4.6', contextWindow: 200000, input: ['text'] },
] }
globalThis.fetch = async () => ({ ok: true, json: async () => FACTS })

// React and react-dom have to be ONE pair: the profile carries React 19 with no
// react-dom of its own, so `react-dom/client` resolves to the checkout's 18.3.1
// and 19's `Symbol(react.transitional.element)` is not a child react-dom 18 can
// reconcile ("Objects are not valid as a React child"). Render with the
// checkout's matched 18.3.1 pair instead of mixing roots.
const reactRequire = createRequire(join(HARNESS, 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js'))
const React = reactRequire('react')
const { createRoot } = reactRequire('react-dom/client')
const { act } = reactRequire('react')

// ── Load the plugin through its loader entry ───────────────────────────────
let captured = null
dom.window.__ModuleLoader__ = {
  load({ id, factory }) {
    const module = { exports: {} }
    const result = factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    })
    captured = { id, exports: result === undefined ? module.exports : result }
  },
}

const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
// eslint-disable-next-line no-eval
eval(source)
const plugin = captured.exports

// ── Stylesheet ownership ───────────────────────────────────────────────────
// The client module system re-tags every *untagged* <style> tag in the page with
// whichever package materializes next (`claimStyles`) and deletes everything a
// package owns when it reloads or is pruned (`removeOwnedStyles`). A tag
// inserted from apply() is untagged at that moment, so a foreign package claimed
// it and its next rebuild took the picker's stylesheet with it — the picker kept
// rendering, unstyled, until a manual page reload. The tag therefore has to be
// claimed from the module body, before any other package can see it untagged,
// and this plugin must never remove it itself.
const ownedStyle = () => document.getElementById('dsh-model-picker-style')
console.log('style at load    :', ownedStyle() !== null, '| owner:', ownedStyle()?.dataset.plugin, '| bytes:', ownedStyle()?.textContent.length)
if (ownedStyle() === null) throw new Error('the module body must inject the stylesheet')
if (ownedStyle().dataset.plugin !== 'dsh-model-picker') {
  throw new Error(`the stylesheet must be claimed by this plugin, got ${JSON.stringify(ownedStyle().dataset.plugin)}`)
}
// Exactly the selector the module system's claim pass uses for unowned tags.
if (document.querySelector('style:not([data-plugin])') !== null) {
  throw new Error('the stylesheet is untagged, so the next materializing package would claim it')
}
// A foreign package's reload/prune takes its own tags and nobody else's.
const foreignStyle = document.createElement('style')
foreignStyle.dataset.plugin = 'some-other-package'
document.head.appendChild(foreignStyle)
for (const el of [...document.querySelectorAll('style[data-plugin="some-other-package"]')]) el.remove()
if (ownedStyle() === null) throw new Error("a foreign package's reload removed the picker stylesheet")

// ── The search box must not wear a focus ring ──────────────────────────────
// It holds the caret for the whole life of the popup (the arrow keys drive the
// list from there), so an accent border would be lit from the moment the panel
// opens and read as a state the user has to clear. The caret is the cue. jsdom
// answers no `:focus` through getComputedStyle, so the stylesheet text is the
// subject here; scripts/verify-live.mjs reads the painted colours in a browser.
const pickerCss = ownedStyle().textContent
const searchBase = /\.dsh-mp2-search\{([^}]*)\}/.exec(pickerCss)
if (searchBase === null || !/border:1px solid var\(--dsw-alias-border-inverted\)/.test(searchBase[1])) {
  throw new Error('the search box must keep its resting 1px border')
}
const searchFocus = /\.dsh-mp2-search:focus\{([^}]*)\}/.exec(pickerCss)
if (searchFocus !== null && /border/.test(searchFocus[1])) {
  throw new Error(`the search box restyles its border on focus: ${searchFocus[1]}`)
}
console.log('search focus ring:', searchFocus === null ? 'none' : searchFocus[1])

// ── Fake slot service + model directory ────────────────────────────────────
const GROUPS = [
  { id: 'deepseek', name: 'DeepSeek', models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'general' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'thinking',
      reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
  ] },
  { id: 'zhipu', name: '智谱 GLM', models: [
    { id: 'glm-4.6', name: 'GLM-4.6', description: 'flagship' },
  ] },
  // A capability-suffixed sibling route, the way modlens registers vision.
  // modlens builds it by spreading the upstream `resolveModelInfo`, so the
  // twin inherits the base model's reasoning metadata verbatim.
  { id: 'deepseek-vision', name: 'DeepSeek (modlens vision)', models: [
    { id: 'deepseek-reasoner-vision', name: 'DeepSeek Reasoner (modlens vision)', description: 'vision route',
      reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
  ] },
  { id: '17an', name: '一起安', models: [
    { id: 'qwen3-max', name: 'Qwen3 Max', description: 'qwen flagship' },
  ] },
]

const snapshot = {
  current: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
  routable: null, status: 'ready', error: null, failures: [], groups: GROUPS,
}
// A real store. The component reads it through useSyncExternalStore, so a fake
// that never notifies would freeze the trigger on its first selection and hide
// whatever the trigger reports after a pick.
const listeners = new Set()
const store = {
  subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
  getSnapshot: () => snapshot,
}
const notify = () => { for (const fn of [...listeners]) fn() }
// The settings modal owns its open/active state, and publishes it through the
// store handle its `sidebar.settings` seat registers. The picker's footer writes
// to that handle; recording the writes here makes the hand-off assertable
// without a settings UI in the page.
const settingsCalls = []
const settingsSeat = {
  store: { create: () => ({ actions: { openSection: (id) => { settingsCalls.push(id) } } }) },
}
const shortcutCalls = []
const seats = {
  'sidebar.settings': [settingsSeat],
  'settings.section': [{ options: { id: 'models', label: () => 'Models' } }],
}
const registrations = []
const slots = {
  inject(_name, fn) { fn() },
  register(options, Component) { registrations.push({ options, Component }); return () => {} },
  entries(name) { return seats[name] ?? [] },
}
const sessions = { subagentAddress: () => undefined }
// cordis rebinds a service proxy's `this.ctx` to the CALLER, so every face of
// `ctx.modelDirectories` reads `remote.session` through THIS plugin's inject
// set. Declaring too little throws `cannot get property "…" without inject`
// inside the seat's inject factory, the shadowing entry abdicates, and the
// composer shows nothing. The fake ctx enforces the same rule so this
// regression cannot come back silently.
const declared = new Set(plugin.inject)
function service(name) {
  if (!declared.has(name)) throw new Error(`cannot get property "${name}" without inject`)
}
const selections = []
const directory = {
  directoryFor: () => {
    service('remote')
    service('remote.session')
    return {
      store,
      load: () => Promise.resolve(),
      select: (selection) => {
        selections.push(selection)
        snapshot.current = {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        }
        notify()
        return Promise.resolve()
      },
    }
  },
}
const services = {
  slots,
  modelDirectories: directory,
  sessions,
  remote: { session: {} },
  // The settings panel's own command registry, the footer's fallback route when
  // a carrier's seat carries no store.
  shortcuts: {
    registry: {
      commands: new Map([['settings.open', {}], ['sidebar.left.toggle', {}]]),
      invoke: (id, context) => { shortcutCalls.push({ id, context }) },
    },
  },
}
const ctx = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  // The plugin claims the seat through ctx.inject(['slots','modelDirectories']);
  // a derived scope also carries the fiber's own declared services.
  inject(names, fn) {
    const scope = {}
    for (const name of declared) scope[name] = services[name]
    for (const name of names) scope[name] = services[name]
    scope.get = (name) => services[name]
    const d = fn(scope)
    return typeof d === 'function' ? d : () => {}
  },
  get(name) { return services[name] },
}

plugin.apply(ctx)

// A reload of THIS package drops the tag before re-importing the module body.
// The body has to put it back, unchanged, or the picker comes back unstyled.
const cssBytes = ownedStyle().textContent.length
for (const el of [...document.querySelectorAll('style[data-plugin="dsh-model-picker"]')]) el.remove()
if (ownedStyle() !== null) throw new Error('the simulated reload sweep did not remove the tag')
// eslint-disable-next-line no-eval
eval(source)
const reloadedStyle = ownedStyle()
console.log('style after reload:', reloadedStyle !== null, '| bytes:', reloadedStyle?.textContent.length)
if (reloadedStyle === null) throw new Error('re-materializing the module must restore the stylesheet')
if (reloadedStyle.dataset.plugin !== 'dsh-model-picker') throw new Error('the restored stylesheet lost its owner')
if (reloadedStyle.textContent.length !== cssBytes) throw new Error('the restored stylesheet is not the one that was removed')

const { options, Component } = registrations[0]
const injected = options.inject('session-1')

const container = document.getElementById('app')
const reactRoot = createRoot(container)

function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

const providerNames = () => [...container.querySelectorAll('.dsh-mp2-provider .dsh-mp2-providerName')].map(n => n.textContent)
const modelNames = () => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-modelName')].map(n => n.textContent)

await act(async () => {
  reactRoot.render(React.createElement(Component, { locked: false, ...injected, t: (k) => k }))
})

// 1. Closed: trigger shows model + effort in two zones
const left = container.querySelector('.dsh-mp2-triggerLeft')
const right = container.querySelector('.dsh-mp2-triggerRight')
console.log('left  zone :', left?.textContent)
console.log('right zone :', right?.textContent)
if (left === null || right === null) throw new Error('two-zone trigger missing')

// Hovering the selector must name the supplier as well as the model: one model
// id is served by several providers, so the name alone does not say where it runs.
console.log('left  tip  :', left.title)
if (left.title !== 'DeepSeek · DeepSeek Reasoner') {
  throw new Error(`the trigger tooltip must read "provider · model", got "${left.title}"`)
}
if (left.getAttribute('aria-label') !== left.title) {
  throw new Error('the trigger tooltip and its accessible name must agree')
}

// The supplier chip rides on the closed trigger too, so the source is legible
// without opening the picker at all.
const triggerChip = () => {
  const chip = left.querySelector('.dsh-mp2-avatar')
  return chip === null ? null : { text: chip.textContent, bg: chip.style.getPropertyValue('--dsh-mp2-chip-bg') }
}
console.log('trigger chip:', JSON.stringify(triggerChip()))
if (triggerChip()?.text !== 'D') throw new Error(`the trigger chip must show the supplier initial, got ${JSON.stringify(triggerChip())}`)
// The tint is a curated OKLCH value: fixed chroma and lightness, hue only, so
// one supplier cannot shout louder than another. It used to be a hash of the
// route id, which put ten unrelated hues in one panel.
if (triggerChip()?.bg === '') throw new Error('the trigger chip carries no tint')
if (!/^oklch\(/.test(triggerChip()?.bg ?? '')) {
  throw new Error(`the trigger chip tint must be a curated OKLCH value, got ${JSON.stringify(triggerChip()?.bg)}`)
}
if (left.querySelector('.dsh-mp2-triggerLabel').textContent !== 'DeepSeek Reasoner') {
  throw new Error('the trigger chip displaced the model name')
}

// Every icon must be an SVG, never a text emoji or symbol character — in the
// trigger and in both popups.
const SYMBOL_GLYPHS = /[★☆✓▾]/
const assertVectorIcons = (root, where) => {
  const found = root.innerHTML.match(SYMBOL_GLYPHS)
  if (found !== null) {
    throw new Error(`symbol characters (not SVG icons) in ${where}: ${JSON.stringify(found)}`)
  }
}
assertVectorIcons(container.querySelector('.dsh-mp2-root'), 'the closed trigger')

// 1b. The effort popup marks its selection with the same vector check.
await act(async () => { right.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const effortMenu = container.querySelector('.dsh-mp2-menuEffort')
if (effortMenu === null) throw new Error('effort popup did not open')
console.log('effort rows        :', [...effortMenu.querySelectorAll('.dsh-mp2-modelName')].map(n => n.textContent))
assertVectorIcons(effortMenu, 'the effort popup')
if (effortMenu.querySelector('.dsh-mp2-selected .dsh-mp2-check svg') === null) {
  throw new Error('the selected effort row must mark itself with the SVG check')
}
await act(async () => { right.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
if (container.querySelector('.dsh-mp2-menuEffort') !== null) throw new Error('the effort popup did not close')

// 2. Open the model popup: search must be present and focused
await act(async () => { left.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const search = container.querySelector('.dsh-mp2-search')
if (search === null) throw new Error('search input missing')
console.log('search placeholder:', search.placeholder)
console.log('search focused    :', document.activeElement === search)
console.log('providers (all)   :', providerNames())
console.log('models (all)      :', modelNames())

// 2b. The grouped list puts 收藏 first (mirrored), then every supplier group.
// A heading is its label and nothing else. A folded route's model sits inside
// its base provider's group, not under its own heading.
const groupsShown = () => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-group')].map((g) => ({
  header: g.querySelector('.dsh-mp2-groupHeader')?.textContent,
  icon: g.querySelector('.dsh-mp2-groupHeader svg') !== null,
  models: [...g.querySelectorAll('.dsh-mp2-modelName')].map((n) => n.textContent),
}))
/** The group DOM node whose heading reads `header`. */
const groupEl = (header) => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-group')]
  .find((g) => g.querySelector('.dsh-mp2-groupHeader')?.textContent === header)
const grouped = groupsShown()
const groupByHeader = (header) => grouped.find((g) => g.header === header)
/** The same lookup against the CURRENT list — `grouped` is a snapshot. */
const liveGroup = (header) => groupsShown().find((g) => g.header === header)
console.log('groups            :', JSON.stringify(grouped))
if (grouped.length !== 5) throw new Error(`expected recent + favorites + 3 provider groups, got ${grouped.length}`)
if (grouped[0].header !== 'Recent') throw new Error('the history group must be pinned above the favorites')
if (grouped[1].header !== 'Favorites') throw new Error('the second group must be Favorites')
if (grouped.some((g) => g.icon)) throw new Error('a group heading carries an icon again')
if (!groupByHeader('DeepSeek')?.models.includes('DeepSeek Reasoner (modlens vision)')) {
  throw new Error('a folded model did not land in its base provider group')
}
if (groupByHeader('智谱 GLM')?.models.join() !== 'GLM-4.6') throw new Error('a group listed another provider\'s models')

// 2b-bis. History: the panel opens on what this session is already using, so
// the seat records the directory's own current route — not the rows clicked
// here — and the group is a mirror like 收藏, naming the route on every row.
console.log('history group     :', JSON.stringify(groupByHeader('Recent')))
if (groupByHeader('Recent').models.join() !== 'DeepSeek Reasoner') {
  throw new Error(`the history must open on the route in use, got ${JSON.stringify(groupByHeader('Recent').models)}`)
}
const storedRecent = () => JSON.parse(localStorage.getItem('dsh.modelPicker.recent') ?? 'null')
if (JSON.stringify(storedRecent()) !== '["deepseek/deepseek-reasoner"]') {
  throw new Error(`the route in use did not reach localStorage: ${JSON.stringify(storedRecent())}`)
}
if (groupEl('Recent').querySelector('.dsh-mp2-option .dsh-mp2-description')?.textContent !== 'DeepSeek · thinking') {
  throw new Error('a history row must name the route serving it')
}
// A heading is a label, not a pictogram. Every group used to wear one: a clock
// for the history and a single building glyph for the suppliers AND the
// favorites, neither of which told the reader anything.
const headingSvgs = () => container.querySelectorAll('.dsh-mp2-list .dsh-mp2-groupHeader svg').length
if (headingSvgs() !== 0) throw new Error(`a group heading rendered an icon again (${headingSvgs()} svg)`)

// 2c. Every row wears its supplier's leading character ahead of the model name,
// so the source is legible without reading the group heading back up the list.
const avatarEl = (name) => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-option')]
  .find((o) => o.querySelector('.dsh-mp2-modelName')?.textContent === name)
  ?.querySelector('.dsh-mp2-avatar')
const avatarOf = (name) => avatarEl(name)?.textContent
const hueOf = (name) => avatarEl(name)?.style.getPropertyValue('--dsh-mp2-chip-bg')
console.log('avatars           :', JSON.stringify({
  DeepSeek: avatarOf('DeepSeek Chat'),
  GLM: avatarOf('GLM-4.6'),
  qwen: avatarOf('Qwen3 Max'),
  folded: avatarOf('DeepSeek Reasoner (modlens vision)'),
}))
if (avatarOf('DeepSeek Chat') !== 'D') throw new Error(`latin initial wrong: ${avatarOf('DeepSeek Chat')}`)
if (avatarOf('GLM-4.6') !== '智') throw new Error(`CJK initial wrong: ${avatarOf('GLM-4.6')}`)
if (avatarOf('Qwen3 Max') !== '一') throw new Error(`CJK initial wrong: ${avatarOf('Qwen3 Max')}`)
// A folded route has no row of its own, so its models must wear the base
// supplier's chip — same hue, not a colour of their own.
if (hueOf('DeepSeek Reasoner (modlens vision)') !== hueOf('DeepSeek Chat')) {
  throw new Error('a folded route wore its own chip instead of its base supplier\'s')
}
// Suppliers are told apart by tint, so no two of them may share a hue.
const supplierHues = [hueOf('DeepSeek Chat'), hueOf('GLM-4.6'), hueOf('Qwen3 Max')]
if (new Set(supplierHues).size !== supplierHues.length) {
  throw new Error(`suppliers share a chip colour: ${JSON.stringify(supplierHues)}`)
}

// 2c. Host facts: the context chip and the image glyph must render on the
// rows the fact route describes, and nowhere else. Native and bridged vision
// are different capabilities, so they must not look alike.
const factsByModel = () => Object.fromEntries(
  [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-option')].map((option) => [
    option.querySelector('.dsh-mp2-modelName')?.textContent,
    {
      context: option.querySelector('.dsh-mp2-context')?.textContent ?? null,
      image: option.querySelector('.dsh-mp2-image') !== null,
      bridged: option.querySelector('.dsh-mp2-imageBridged') !== null,
    },
  ]),
)
const factsShown = factsByModel()
console.log('facts             :', factsShown)
if (factsShown['DeepSeek Reasoner']?.context !== '128K') throw new Error('context chip missing on DeepSeek Reasoner')
if (factsShown['DeepSeek Reasoner']?.image !== true) throw new Error('image glyph missing on DeepSeek Reasoner')
if (factsShown['DeepSeek Reasoner']?.bridged !== false) throw new Error('native vision marked as bridged')
if (factsShown['DeepSeek Reasoner (modlens vision)']?.bridged !== true) throw new Error('modlens route not marked as bridged')
if (factsShown['DeepSeek Chat']?.context !== null) throw new Error('facts leaked onto an unlisted model')

// 2c. Favorites: every row carries a toggle, the toggle never picks the
// model, the ~/收藏 scope lists exactly the favorited routes, and the set
// survives in localStorage.
const starOf = (modelName) => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-option')]
  .find((option) => option.querySelector('.dsh-mp2-modelName')?.textContent === modelName)
  ?.querySelector('.dsh-mp2-star')
const starState = (modelName) => {
  const star = starOf(modelName)
  if (star === undefined || star === null) throw new Error(`row "${modelName}" has no favorite toggle`)
  return {
    on: star.classList.contains('dsh-mp2-starOn'),
    // Icons are Lucide SVGs, never text glyphs: a filled star paints its path.
    svg: star.querySelector('svg') !== null,
    text: star.textContent,
    filled: star.querySelector('path[fill="currentColor"]') !== null,
  }
}
const providerRow = (name) => [...container.querySelectorAll('.dsh-mp2-provider')]
  .find((row) => row.querySelector('.dsh-mp2-providerName')?.textContent === name)
const providerCount = (name) => providerRow(name)?.querySelector('.dsh-mp2-providerCount')?.textContent
const storedFavorites = () => JSON.parse(localStorage.getItem('dsh.modelPicker.favorites') ?? 'null')

console.log('star (before)     :', starState('DeepSeek Chat'), 'favorites badge:', providerCount('Favorites'))
if (starState('DeepSeek Chat').on) throw new Error('a fresh row rendered as favorited')
if (starState('DeepSeek Chat').filled) throw new Error('a fresh star uses the filled glyph')
if (starState('DeepSeek Chat').svg !== true) throw new Error('the star is not an SVG')
if (starState('DeepSeek Reasoner').on) throw new Error('a fresh row rendered as favorited')

assertVectorIcons(container.querySelector('.dsh-mp2-menu'), 'the model popup')

const selectionsBefore = selections.length
await act(async () => { starOf('DeepSeek Chat').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('star (after)      :', starState('DeepSeek Chat'), 'favorites badge:', providerCount('Favorites'))
if (!starState('DeepSeek Chat').on) throw new Error('clicking the star did not favorite the row')
if (!starState('DeepSeek Chat').filled) throw new Error('a favorited star must paint its path')
if (starState('DeepSeek Chat').svg !== true) throw new Error('the filled star is not an SVG')
if (selections.length !== selectionsBefore) throw new Error('clicking the star also selected the model')
if (providerCount('Favorites') !== '1') throw new Error('favorites badge did not count the star')
if (JSON.stringify(storedFavorites()) !== '["deepseek/deepseek-chat"]') {
  throw new Error(`favorites did not reach localStorage: ${JSON.stringify(storedFavorites())}`)
}

// The 收藏 group mirrors the starred model, naming the route that serves it.
// The list keeps every provider — no scope change.
const favGroup = liveGroup('Favorites')
if (liveGroup('Recent') === undefined) throw new Error('the history group must survive a favorite edit')
if (JSON.stringify(favGroup.models) !== '["DeepSeek Chat"]') throw new Error('favorites group does not mirror the starred model')
const favDetail = () => groupEl('Favorites').querySelector('.dsh-mp2-option .dsh-mp2-description')?.textContent
console.log('favorites group   :', favGroup.models, '| detail:', favDetail())
if (favDetail() !== 'DeepSeek · general') {
  throw new Error('a favorites-group row must name its provider')
}
if (groupsShown().length !== 5) throw new Error('the favorites scope must not replace the full list')

// Un-starring removes it from the favorites group and updates the badge.
await act(async () => { starOf('DeepSeek Chat').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const favGroupAfter = liveGroup('Favorites')
console.log('after un-star     :', favGroupAfter.models, '| favorites badge:', providerCount('Favorites'))
if (favGroupAfter.models.length !== 0) throw new Error('un-starred model stayed in the favorites group')
if (providerCount('Favorites') !== '0') throw new Error('favorites badge did not drop the star')
if (JSON.stringify(storedFavorites()) !== '[]') throw new Error('un-starring did not persist')

// Leave the grouped list and an empty query for the search tests below.
await act(async () => { typeInto(search, 'reasoner') })
if (modelNames().length === 0) throw new Error('search showed nothing')
await act(async () => { typeInto(search, '') })
console.log('left column       :', providerNames())

// Every supplier wears its chip in the elevator too.
const elevatorChips = [...container.querySelectorAll('.dsh-mp2-providers .dsh-mp2-provider')].map((btn) => {
  const chip = btn.querySelector('.dsh-mp2-avatar')
  const name = btn.querySelector('.dsh-mp2-providerName')?.textContent
  return { name, chipText: chip?.textContent ?? null, chipHue: chip?.style.getPropertyValue('--dsh-mp2-hue') ?? null }
})
console.log('elevator chips    :', JSON.stringify(elevatorChips))
// The history and favorites floors are mirrors, not suppliers.
const MIRROR_FLOORS = ['Recent', 'Favorites']
const isMirrorFloor = (name) => MIRROR_FLOORS.includes(name)
for (const { name, chipText } of elevatorChips) {
  if (isMirrorFloor(name)) continue
  if (chipText === null) throw new Error(`supplier "${name}" is missing its chip in the elevator`)
  if (chipText.length === 0) throw new Error(`supplier "${name}" has an empty chip`)
}
// A mirror floor is not a supplier — it must not wear a chip, and it counts
// its own rows. The history floor is the lit one, because its heading is the
// one pinned at the list's top edge.
for (const name of MIRROR_FLOORS) {
  if (providerRow(name) === undefined) throw new Error(`the ${name} floor is missing from the elevator`)
  if (providerRow(name).querySelector('.dsh-mp2-avatar') !== null) {
    throw new Error(`the ${name} floor must not wear a supplier chip`)
  }
}
if (providerCount('Recent') !== '1') throw new Error(`the history floor must count its rows, got ${providerCount('Recent')}`)
if (!providerRow('Recent').classList.contains('dsh-mp2-providerActive')) {
  throw new Error('the history floor must be the lit one while its heading is pinned at the top')
}

// 3. Search a provider NAME: provider column must narrow too
await act(async () => { typeInto(search, '智谱') })
console.log('--- after typing 智谱 ---')
console.log('providers :', providerNames())
console.log('models    :', modelNames())

// 4. Search a model NAME that spans nothing else
await act(async () => { typeInto(search, 'qwen') })
console.log('--- after typing qwen ---')
console.log('providers :', providerNames())
console.log('models    :', modelNames())

// 5. Search by provider id substring
await act(async () => { typeInto(search, '17an') })
console.log('--- after typing 17an ---')
console.log('providers :', providerNames())
console.log('models    :', modelNames())

// 6. Click a provider facet mid-search: query must survive and narrow results
await act(async () => { typeInto(search, 'e') })
const beforeClick = providerNames()
const facetBtn = [...container.querySelectorAll('.dsh-mp2-provider')]
  .find(b => b.querySelector('.dsh-mp2-providerName')?.textContent === 'DeepSeek')
if (facetBtn === undefined) throw new Error('DeepSeek facet button missing')
await act(async () => { facetBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('--- after clicking DeepSeek facet (query "e") ---')
console.log('providers before click:', beforeClick)
console.log('providers after click :', providerNames())
console.log('search value kept     :', container.querySelector('.dsh-mp2-search')?.value)
console.log('models                :', modelNames())

// 7. Capability-suffixed providers fold into their base row for display, and a
//    pick still submits the route that actually serves the model.
await act(async () => { typeInto(search, '') })
const foldedProviders = providerNames()
const foldedModels = modelNames()
console.log('--- folded view ---')
console.log('providers :', foldedProviders)
console.log('models    :', foldedModels)
if (foldedProviders.includes('DeepSeek (modlens vision)')) throw new Error('vision route kept its own provider row')
if (!foldedProviders.includes('DeepSeek')) throw new Error('base provider row missing after folding')
if (!foldedModels.includes('DeepSeek Reasoner (modlens vision)')) throw new Error('folded model missing from the base row')

const visionOption = [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-option')]
  .find(option => option.querySelector('.dsh-mp2-modelName')?.textContent === 'DeepSeek Reasoner (modlens vision)')
if (visionOption === undefined) throw new Error('folded model row missing')
await act(async () => { visionOption.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const submitted = selections.at(-1)
console.log('submitted  :', JSON.stringify(submitted))
if (submitted?.provider !== 'deepseek-vision') {
  throw new Error(`a folded pick must submit its own route, submitted "${submitted?.provider}"`)
}

// The pick closed the popup, so the trigger now describes the new selection —
// and it must name the *display* supplier, not the folded route's own name.
const tipAfterVision = container.querySelector('.dsh-mp2-triggerLeft').title
console.log('tip after vision pick:', tipAfterVision)
if (tipAfterVision !== 'DeepSeek · DeepSeek Reasoner (modlens vision)') {
  throw new Error(`a folded route must name its base supplier, got "${tipAfterVision}"`)
}
// …and the trigger chip must follow the same rule: the base supplier's tint,
// not a colour of the folded route's own.
if (triggerChip()?.text !== 'D') {
  throw new Error(`the trigger chip must show the base supplier, got ${JSON.stringify(triggerChip())}`)
}

// 8. The elevator: with no query, a supplier row is a floor, not a filter —
//    clicking it must keep every group on screen and light that row. The
//    highlight then follows the list's own scroll position. Picking a model
//    closed the popup, so open it again first.
const activeProviderRow = () =>
  container.querySelector('.dsh-mp2-providerActive .dsh-mp2-providerName')?.textContent ?? null
await act(async () => { left.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const list = container.querySelector('.dsh-mp2-list')
if (list === null) throw new Error('model list did not reopen')
console.log('--- elevator ---')
console.log('lit before click  :', activeProviderRow(), '| groups:', groupsShown().length)
if (groupsShown().length !== 5) throw new Error('expected recent + favorites + 3 provider groups')

const zhipuRow = providerRow('智谱 GLM')
await act(async () => { zhipuRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('lit after click   :', activeProviderRow(), '| groups:', groupsShown().length)
if (activeProviderRow() !== '智谱 GLM') throw new Error('clicking a supplier row did not light it')
if (groupsShown().length !== 5) throw new Error('clicking a supplier row filtered the list instead of travelling')

// Scrolling the list moves the highlight, with no group removed. Groups are:
// Recent (offset 0), Favorites (120), DeepSeek (240), 智谱 GLM (360), 一起安 (480).
const groupEls = [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-group')]
groupEls.forEach((el, index) => {
  Object.defineProperty(el, 'offsetTop', { value: index * 120, configurable: true })
})
const scrollTo = async (top) => {
  Object.defineProperty(list, 'scrollTop', { value: top, writable: true, configurable: true })
  await act(async () => { list.dispatchEvent(new dom.window.Event('scroll')) })
}
await scrollTo(0)
console.log('lit at scrollTop 0   :', activeProviderRow())
if (activeProviderRow() !== 'Recent') throw new Error('the spy did not light the history group at the top')
await scrollTo(480)
console.log('lit at scrollTop 480 :', activeProviderRow(), '| groups:', groupsShown().length)
if (activeProviderRow() !== '一起安') throw new Error('the spy did not follow the scroll position')
if (groupsShown().length !== 5) throw new Error('scrolling dropped a group')
await scrollTo(360)
console.log('lit at scrollTop 360 :', activeProviderRow())
if (activeProviderRow() !== '智谱 GLM') throw new Error('the spy did not stop on the floor the list is standing on')
// Mid-group stays on the floor the list is standing on, not the next one.
await scrollTo(200)
console.log('lit at scrollTop 200 :', activeProviderRow())
if (activeProviderRow() !== 'Favorites') throw new Error('the spy switched floors too early')

// 9. Pure keyboard operation. The picker is search-first, so focus stays in the
//    search box and the cursor is reported through `aria-activedescendant`
//    instead of by moving DOM focus. The popup is still open from section 8,
//    with no query and no favorites.
const searchNow = () => container.querySelector('.dsh-mp2-search')
const activeEls = () => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-optionActive')]
const activeName = () => activeEls()[0]?.querySelector('.dsh-mp2-modelName')?.textContent ?? null
/** The group heading above the cursor row — which floor the cursor stands on. */
const activeGroup = () => activeEls()[0]?.closest('.dsh-mp2-group')
  ?.querySelector('.dsh-mp2-groupHeader')?.textContent ?? null
const keyPress = async (k, target) => {
  await act(async () => {
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}
const press = (k) => keyPress(k, searchNow())

console.log('--- keyboard ---')
console.log('focus in search  :', document.activeElement === searchNow())
if (document.activeElement !== searchNow()) throw new Error('the search box must hold focus while the popup is open')
console.log('cursor on open   :', activeName(), '| floor:', activeGroup())
// The cursor opens on the first row of the list, which is the most recent
// route: re-picking what you last used is `Enter` away from opening the panel.
if (activeName() !== 'DeepSeek Reasoner (modlens vision)' || activeGroup() !== 'Recent') {
  throw new Error(`the popup must open on the last used route, got "${activeName()}" on ${activeGroup()}`)
}
if (activeEls().length !== 1) throw new Error(`exactly one row may wear the cursor, got ${activeEls().length}`)
console.log('activedescendant :', searchNow().getAttribute('aria-activedescendant'), '| row id:', activeEls()[0].id)
if (searchNow().getAttribute('aria-activedescendant') !== activeEls()[0].id) {
  throw new Error('aria-activedescendant does not name the cursor row')
}

// ↓/↑ walk one row at a time and hold at both ends. Rows, in order: the two
// history rows, then DeepSeek's three, then GLM-4.6, then Qwen3 Max (收藏 is
// empty here, so it contributes no row).
await press('ArrowDown')
await press('ArrowDown')
console.log('after ↓↓         :', activeName(), '| floor:', activeGroup())
if (activeName() !== 'DeepSeek Chat') throw new Error('ArrowDown did not advance the cursor')
await press('ArrowUp')
console.log('after ↑          :', activeName())
if (activeName() !== 'DeepSeek Reasoner') throw new Error('ArrowUp did not retreat the cursor')
await press('End')
console.log('after End        :', activeName())
if (activeName() !== 'Qwen3 Max') throw new Error('End did not jump to the last row')
await press('ArrowDown')
if (activeName() !== 'Qwen3 Max') throw new Error('the cursor ran past the last row')
await press('Home')
console.log('after Home       :', activeName())
if (activeName() !== 'DeepSeek Reasoner (modlens vision)') throw new Error('Home did not jump to the first row')
await press('ArrowUp')
if (activeName() !== 'DeepSeek Reasoner (modlens vision)') throw new Error('the cursor ran past the first row')
await press('PageDown')
console.log('after PageDown   :', activeName())
if (activeName() !== 'Qwen3 Max') throw new Error('PageDown did not land on the last row')
await press('Home')
// Typing keeps working after arrow navigation: focus never left the input.
await act(async () => { typeInto(searchNow(), 'reasoner') })
console.log('cursor on query  :', activeName(), '| query:', searchNow().value)
if (activeName() !== 'DeepSeek Reasoner') throw new Error('a new result set must put the cursor back on the first match')

// Enter on a row commits the cursor — here the folded modlens route, which must
// still submit the route that serves it.
const beforeKeyboardPick = selections.length
await press('Enter')
console.log('keyboard pick    :', JSON.stringify(selections.at(-1)))
if (selections.length !== beforeKeyboardPick + 1) throw new Error('Enter did not pick the cursor row')
if (selections.at(-1)?.model !== 'deepseek-reasoner') throw new Error('Enter picked the wrong row')
if (container.querySelector('.dsh-mp2-menu') !== null) throw new Error('a keyboard pick must close the popup')
console.log('focus restored   :', document.activeElement === container.querySelector('.dsh-mp2-triggerLeft'))
if (document.activeElement !== container.querySelector('.dsh-mp2-triggerLeft')) {
  throw new Error('closing the popup must hand focus back to the trigger')
}

// 9b. Enter on a star toggles the favorite and must not also pick the model:
//     the star stops the key from reaching the menu's own Enter handler.
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
if (activeName() === null) throw new Error('the popup reopened with no cursor row')
const selectionsBeforeStarKey = selections.length
await keyPress('Enter', starOf('DeepSeek Chat'))
console.log('star by keyboard :', starState('DeepSeek Chat').on, '| picks:', selections.length - selectionsBeforeStarKey)
if (!starState('DeepSeek Chat').on) throw new Error('Enter on the star did not favorite the row')
if (selections.length !== selectionsBeforeStarKey) throw new Error('Enter on the star also picked the model')

// 9c. The 收藏 mirror is its own row: only one copy wears the cursor, and
//     committing it submits the route that really serves the model. The mirror
//     sits below the history group, so walk down onto it.
console.log('cursor after star:', activeName(), '| cursor rows:', activeEls().length)
await press('Home')
for (let step = 0; activeGroup() !== 'Favorites' && step < 10; step += 1) await press('ArrowDown')
console.log('cursor on mirror :', activeName(), '| floor:', activeGroup())
if (activeGroup() !== 'Favorites') throw new Error('the cursor never reached the favorites mirror')
if (activeName() !== 'DeepSeek Chat') throw new Error(`the floor holds the starred model, cursor landed on "${activeName()}"`)
if (activeEls().length !== 1) throw new Error('the mirrored favorites row lit up together with its supplier row')
const pickCount = selections.length
await press('Enter')
console.log('mirror pick      :', JSON.stringify(selections.at(-1)))
if (selections.length !== pickCount + 1) throw new Error('Enter did not commit the cursor row')
if (selections.at(-1)?.provider !== 'deepseek' || selections.at(-1)?.model !== 'deepseek-chat') {
  throw new Error(`the favorites mirror must submit its real route, got ${JSON.stringify(selections.at(-1))}`)
}
// The pick re-entered the history at the top, ahead of the routes it displaced.
console.log('history after pick:', JSON.stringify(storedRecent()))
if (storedRecent()[0] !== 'deepseek/deepseek-chat') {
  throw new Error(`a pick must move its route to the front of the history: ${JSON.stringify(storedRecent())}`)
}
if (new Set(storedRecent()).size !== storedRecent().length) {
  throw new Error(`the history kept a duplicate route: ${JSON.stringify(storedRecent())}`)
}

// 9d. Escape closes the popup from the keyboard and clears the query.
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
await act(async () => { typeInto(searchNow(), 'qwen') })
await act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
if (container.querySelector('.dsh-mp2-menu') !== null) throw new Error('Escape did not close the popup')
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('query after Esc  :', JSON.stringify(searchNow().value))
if (searchNow().value !== '') throw new Error('Escape left the query behind')

// 10. The history is a fixed-length shortcut, not an archive. Seeding more
//     routes than the cap and remounting must trim it back to the cap, keep the
//     route in use at the front, and leave a route that is no longer configured
//     in storage but out of the rendered group.
await act(async () => { reactRoot.unmount() })
localStorage.setItem('dsh.modelPicker.recent', JSON.stringify([
  'ghost/never-configured',
  'deepseek/deepseek-reasoner',
  'zhipu/glm-4.6',
  '17an/qwen3-max',
  'deepseek-vision/deepseek-reasoner-vision',
  'deepseek/deepseek-chat',
  'zhipu/glm-4.6',
  'deepseek/deepseek-chat',
]))
const remounted = createRoot(container)
await act(async () => {
  remounted.render(React.createElement(Component, { locked: false, ...injected, t: (k) => k }))
})
const trimmed = storedRecent()
console.log('--- history cap ---')
console.log('history trimmed  :', JSON.stringify(trimmed))
if (trimmed.length !== 6) throw new Error(`the history must be capped, got ${trimmed.length}`)
if (trimmed[0] !== 'deepseek/deepseek-chat') throw new Error('the route in use must lead the history after a remount')
if (new Set(trimmed).size !== trimmed.length) throw new Error(`a duplicate route survived the cap: ${JSON.stringify(trimmed)}`)

await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const recentAfter = liveGroup('Recent')
console.log('history group    :', JSON.stringify(recentAfter?.models))
if (recentAfter === undefined) throw new Error('the history group disappeared from the reopened popup')
if (recentAfter.models.join() !== 'DeepSeek Chat,DeepSeek Reasoner,GLM-4.6,Qwen3 Max,DeepSeek Reasoner (modlens vision)') {
  throw new Error(`the history group must list the stored routes in order, got ${JSON.stringify(recentAfter.models)}`)
}
if (providerCount('Recent') !== '5') throw new Error(`the history floor must count the rendered rows, got ${providerCount('Recent')}`)

// 10b. A history with nothing to show — every route gone, no route in use —
//      renders neither the group nor its floor. 收藏 keeps its place: it
//      teaches that starring exists, the history has nothing to teach.
await act(async () => { remounted.unmount() })
snapshot.current = null
localStorage.setItem('dsh.modelPicker.recent', JSON.stringify(['ghost/never-configured']))
const third = createRoot(container)
await act(async () => {
  third.render(React.createElement(Component, { locked: false, ...injected, t: (k) => k }))
})
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('--- unusable history ---')
console.log('history group    :', JSON.stringify(liveGroup('Recent')), '| floors:', providerNames())
if (liveGroup('Recent') !== undefined) throw new Error('an unusable history must not render a group')
if (providerRow('Recent') !== undefined) throw new Error('an unusable history must not render an elevator floor')
if (liveGroup('Favorites') === undefined) throw new Error('the favorites group must survive an unusable history')

// 11. The settings hand-off. The picker can only list what the configured
//     providers offer; when the official models are missing, the fix lives in
//     Settings → 模型, and the panel is exactly where that is noticed.
console.log('--- settings hand-off ---')
const footerRow = () => container.querySelector('.dsh-mp2-footer')
const footerAction = () => container.querySelector('.dsh-mp2-footerAction')
if (container.querySelector('.dsh-mp2-menu') === null) throw new Error('the popup must be open to test its footer')
const footerNode = footerRow()
if (footerNode === null) throw new Error('the model popup must carry the settings footer')
// A fixed row under the body, not a row inside the scroll area: one that scrolls
// away is one the user cannot find when the models are missing.
if (footerNode.closest('.dsh-mp2-list') !== null) throw new Error('the footer must sit outside the scrolling list')
if (footerNode.parentElement.className !== 'dsh-mp2-menu') throw new Error('the footer must be a direct child of the popup')
assertVectorIcons(footerNode, 'the settings footer')
const footerButton = footerAction()
console.log('footer label     :', footerButton.textContent, '| tag:', footerButton.tagName)
if (footerButton.tagName !== 'BUTTON' || footerButton.type !== 'button') throw new Error('the footer row must be a real button')
if (!footerButton.textContent.includes('Configure official models')) {
  throw new Error(`the footer must name what it configures, got ${JSON.stringify(footerButton.textContent)}`)
}
if (!footerButton.textContent.includes('Settings · Models')) {
  throw new Error('the footer must name the surface it leaves for')
}
if (footerButton.querySelectorAll('svg').length !== 2) {
  throw new Error('the footer wears a settings glyph and a leave-the-panel glyph')
}

// 11-bis. The footer's other control folds the panel's OWN provider column, the
//        table of contents, so the model list gets that width back. The fold is
//        a view preference and survives a reload; it must never reach into the
//        shell's layout, which owns a different sidebar entirely.
const folded = () => container.querySelector('.dsh-mp2-menu').className.includes('dsh-mp2-menuFolded')
const footerToggle = () => container.querySelector('.dsh-mp2-footerIcon')
if (footerToggle() === null) throw new Error('the footer must carry a provider-column toggle')
if (footerToggle().querySelector('svg') === null) throw new Error('the provider toggle must be a vector icon')
if (!footerToggle().getAttribute('aria-label')) throw new Error('the provider toggle must be named for screen readers')
if (folded()) throw new Error('the provider column must start visible')
const callsBeforeToggle = shortcutCalls.length
await act(async () => { footerToggle().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('providers folded :', folded(), '| stored:', localStorage.getItem('dsh.modelPicker.providersHidden'))
if (!folded()) throw new Error('the toggle must fold the provider column away')
if (shortcutCalls.length !== callsBeforeToggle) {
  throw new Error('the provider toggle must not touch the shell layout')
}
if (localStorage.getItem('dsh.modelPicker.providersHidden') !== '1') {
  throw new Error('the fold must be remembered as a view preference')
}
await act(async () => { footerToggle().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('providers back   :', !folded(), '| stored:', localStorage.getItem('dsh.modelPicker.providersHidden'))
if (folded()) throw new Error('the toggle must unfold the column again')
if (container.querySelector('.dsh-mp2-menu') === null) throw new Error('folding the column must not close the picker')

// Clicking it writes the 模型 section to the settings shell and closes the
// popup — and it must never double as a model pick.
const picksBeforeFooter = selections.length
await act(async () => { footerButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('openSection      :', JSON.stringify(settingsCalls), '| picks:', selections.length - picksBeforeFooter)
if (settingsCalls.at(-1) !== 'models') throw new Error(`the footer must open the models section, got ${JSON.stringify(settingsCalls)}`)
if (selections.length !== picksBeforeFooter) throw new Error('the footer click also picked a model')
if (container.querySelector('.dsh-mp2-menu') !== null) throw new Error('the footer must close the picker after handing off')

// 11b. A carrier whose settings seat carries no store falls back to the panel's
//      own `settings.open` command, then lights its 模型 row by the label the
//      ledger publishes — never by a hard-coded string.
seats['sidebar.settings'] = []
const navClicks = []
document.body.insertAdjacentHTML('beforeend',
  '<div data-shortcut-modal="settings"><nav><button>General</button><button>Models</button></nav></div>')
for (const row of document.querySelectorAll('[data-shortcut-modal="settings"] nav button')) {
  row.addEventListener('click', () => { navClicks.push(row.textContent) })
}
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
await act(async () => { footerAction().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('fallback command :', JSON.stringify(shortcutCalls.map((call) => call.id)), '| nav:', JSON.stringify(navClicks))
if (shortcutCalls.at(-1)?.id !== 'settings.open') throw new Error("the fallback must run the settings panel's own command")
if (shortcutCalls.at(-1)?.context?.modal !== null) throw new Error('the fallback must present itself as a page command, not a modal one')
if (navClicks.at(-1) !== 'Models') throw new Error(`the fallback must light the models row by its ledger label, got ${JSON.stringify(navClicks)}`)
if (container.querySelector('.dsh-mp2-menu') !== null) throw new Error('the fallback must close the picker too')

// 11c. With neither a store nor the command — a carrier that has no settings
//      panel at all — the row must do nothing rather than close the picker onto
//      an empty page.
seats['sidebar.settings'] = []
services.shortcuts = { registry: { commands: new Map(), invoke: () => { shortcutCalls.push({ id: 'unexpected' }) } } }
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
await act(async () => { footerAction().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('no settings UI   : popup open =', container.querySelector('.dsh-mp2-menu') !== null)
if (container.querySelector('.dsh-mp2-menu') === null) throw new Error('a footer that cannot open settings must leave the picker open')
if (shortcutCalls.at(-1)?.id === 'unexpected') throw new Error('the footer ran a command that is not registered')

// 12. The copy follows the APP's language, not the browser's.
//     DSH's UI language is a product preference (Settings → General → Language)
//     that the locale plugin mirrors onto `<html lang>`; a user who picked 中文
//     in the app must see 中文 here even with an en-US browser, and a switch must
//     reach an already-open panel without a reload.
console.log('--- language ---')
const openPopup = async () => {
  if (container.querySelector('.dsh-mp2-menu') === null) {
    await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  }
}
const menuCopy = () => ({
  search: container.querySelector('.dsh-mp2-search')?.placeholder ?? null,
  footer: container.querySelector('.dsh-mp2-footerLabel')?.textContent ?? null,
  where: container.querySelector('.dsh-mp2-footerWhere')?.textContent ?? null,
  panelCaption: container.querySelector('.dsh-mp2-paneCaption')?.textContent ?? null,
})
const setLang = async (tag) => {
  await act(async () => {
    document.documentElement.lang = tag
    // jsdom delivers MutationObserver callbacks on a macrotask, not a
    // microtask, so the switch needs a timer tick before the assertions run.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
// The navigator says en-US (jsdom's default and the browser this test runs in):
// the browser cannot be what decides.
console.log('navigator lang   :', navigator.language, '| html lang from the document:', JSON.stringify(document.documentElement.lang))
if (String(navigator.language).toLowerCase().startsWith('zh')) {
  throw new Error('this test assumes an English browser, or it proves nothing')
}
// 11c left the popup open with the default (English) copy; make it explicit.
if (container.querySelector('.dsh-mp2-search')?.placeholder === '搜索模型或提供商…') {
  throw new Error('the default language must be English on an en-US browser')
}
await setLang('en')
const english = menuCopy()
console.log('html lang en     :', JSON.stringify(english))
if (english.search !== 'Search model or provider…') throw new Error(`English copy did not follow <html lang="en">: ${english.search}`)
if (english.footer !== 'Configure official models') throw new Error(`English footer copy wrong: ${english.footer}`)

await setLang('zh-CN')
const chinese = menuCopy()
console.log('html lang zh-CN  :', JSON.stringify(chinese))
if (chinese.search !== '搜索模型或提供商…') {
  throw new Error(`an open popup must switch to Chinese with the app, got ${JSON.stringify(chinese.search)}`)
}
if (chinese.footer !== '配置官方模型') throw new Error(`Chinese footer copy wrong: ${chinese.footer}`)
if (chinese.where !== '设置 · 模型') throw new Error(`Chinese destination copy wrong: ${chinese.where}`)
if (chinese.panelCaption !== '全部提供商') throw new Error(`Chinese column caption wrong: ${chinese.panelCaption}`)

// A closed popup reads the attribute when it opens: no observer needed.
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
await setLang('en')
await openPopup()
await setLang('zh-CN')
console.log('reopened in zh   :', JSON.stringify(menuCopy()))
if (menuCopy().search !== '搜索模型或提供商…') throw new Error('reopening the popup must read the current language')

// 12b. The `locale` service — the preference the user actually picks in
//      Settings → General → Language — outranks the document attribute, and its
//      own subscription carries a switch with no attribute change at all. The
//      shipped shell has both; this proves the panel prefers the real setting.
await act(async () => { reactRoot.unmount() })
const localeListeners = new Set()
let localeActive = 'zh'
services.locale = {
  getSnapshot: () => ({ active: localeActive, locales: [], revision: 0 }),
  subscribe: (fn) => { localeListeners.add(fn); return () => { localeListeners.delete(fn) } },
}
document.documentElement.lang = 'en'
const localeRoot = createRoot(container)
await act(async () => {
  localeRoot.render(React.createElement(Component, { locked: false, ...injected, t: (k) => k }))
})
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('--- language: locale service ---')
console.log('service says zh, document says en:', JSON.stringify(menuCopy()))
if (menuCopy().search !== '搜索模型或提供商…') {
  throw new Error(`the locale service must outrank <html lang>, got ${JSON.stringify(menuCopy().search)}`)
}
localeActive = 'en'
await act(async () => {
  for (const fn of [...localeListeners]) fn()
  await Promise.resolve()
})
console.log('service switched to en           :', JSON.stringify(menuCopy()))
if (menuCopy().search !== 'Search model or provider…') {
  throw new Error(`the locale service subscription must re-render the panel, got ${JSON.stringify(menuCopy().search)}`)
}
if (localeListeners.size === 0) throw new Error('the panel never subscribed to the locale service')
await act(async () => { localeRoot.unmount() })
if (localeListeners.size !== 0) throw new Error('the locale subscription outlived the panel')

// 12c. A render that arrives with no locale source at all (an older carrier, or
//      the seat mounted by hand) still follows the document's declaration.
const bareRoot = createRoot(container)
await act(async () => {
  bareRoot.render(React.createElement(Component, { locked: false, ...injected, locale: undefined, t: (k) => k }))
})
await act(async () => { container.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
await setLang('zh-CN')
console.log('no locale source :', JSON.stringify(menuCopy()))
if (menuCopy().search !== '搜索模型或提供商…') {
  throw new Error('a panel without a locale source must still follow <html lang>')
}
await act(async () => { bareRoot.unmount() })

console.log('INTERACTION OK')
