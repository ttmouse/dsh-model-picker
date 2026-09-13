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
const PROFILE = '/Users/douba/.dsh/profiles/web'
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

const profileRequire = createRequire(join(PROFILE, 'index.js'))
const React = profileRequire('react')
const { createRoot } = profileRequire('react-dom/client')
const { act } = profileRequire('react')

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
const registrations = []
const slots = {
  inject(_name, fn) { fn() },
  register(options, Component) { registrations.push({ options, Component }); return () => {} },
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
const services = { slots, modelDirectories: directory, sessions, remote: { session: {} } }
const ctx = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  // The plugin claims the seat through ctx.inject(['slots','modelDirectories']);
  // a derived scope also carries the fiber's own declared services.
  inject(names, fn) {
    const scope = {}
    for (const name of declared) scope[name] = services[name]
    for (const name of names) scope[name] = services[name]
    const d = fn(scope)
    return typeof d === 'function' ? d : () => {}
  },
  get(name) { return services[name] },
}

plugin.apply(ctx)
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
  return chip === null ? null : { text: chip.textContent, hue: chip.style.getPropertyValue('--dsh-mp2-hue') }
}
console.log('trigger chip:', JSON.stringify(triggerChip()))
if (triggerChip()?.text !== 'D') throw new Error(`the trigger chip must show the supplier initial, got ${JSON.stringify(triggerChip())}`)
if (triggerChip()?.hue === '') throw new Error('the trigger chip carries no tint')
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
// Every group heading carries its icon. A folded route's model sits inside its
// base provider's group, not under its own heading.
const groupsShown = () => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-group')].map((g) => ({
  header: g.querySelector('.dsh-mp2-groupHeaderIcon')?.parentElement?.textContent,
  icon: g.querySelector('.dsh-mp2-groupHeaderIcon svg') !== null,
  models: [...g.querySelectorAll('.dsh-mp2-modelName')].map((n) => n.textContent),
}))
const grouped = groupsShown()
console.log('groups            :', JSON.stringify(grouped))
if (grouped.length !== 4) throw new Error(`expected favorites + 3 provider groups, got ${grouped.length}`)
if (grouped[0].header !== 'Favorites') throw new Error('the first group must be Favorites')
if (grouped.some((g) => !g.icon)) throw new Error('a group heading is missing its supplier icon')
if (!grouped[1].models.includes('DeepSeek Reasoner (modlens vision)')) {
  throw new Error('a folded model did not land in its base provider group')
}
if (grouped[2].models.join() !== 'GLM-4.6') throw new Error('a group listed another provider\'s models')

// 2c. Every row wears its supplier's leading character ahead of the model name,
// so the source is legible without reading the group heading back up the list.
const avatarEl = (name) => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-option')]
  .find((o) => o.querySelector('.dsh-mp2-modelName')?.textContent === name)
  ?.querySelector('.dsh-mp2-avatar')
const avatarOf = (name) => avatarEl(name)?.textContent
const hueOf = (name) => avatarEl(name)?.style.getPropertyValue('--dsh-mp2-hue')
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

// The 收藏 group is the first group in the list and mirrors the starred model,
// naming the route that serves it. The list keeps every provider — no scope
// change.
const favGroup = groupsShown()[0]
if (favGroup.header !== 'Favorites') throw new Error('favorites group must be first')
if (JSON.stringify(favGroup.models) !== '["DeepSeek Chat"]') throw new Error('favorites group does not mirror the starred model')
console.log('favorites group   :', favGroup.models, '| detail:',
  container.querySelector('.dsh-mp2-group:first-child .dsh-mp2-option .dsh-mp2-description')?.textContent)
if (container.querySelector('.dsh-mp2-group:first-child .dsh-mp2-option .dsh-mp2-description')?.textContent !== 'DeepSeek · general') {
  throw new Error('a favorites-group row must name its provider')
}
if (groupsShown().length !== 4) throw new Error('the favorites scope must not replace the full list')

// Un-starring removes it from the favorites group and updates the badge.
await act(async () => { starOf('DeepSeek Chat').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
const favGroupAfter = groupsShown()[0]
console.log('after un-star     :', favGroupAfter.models, '| favorites badge:', providerCount('Favorites'))
if (favGroupAfter.models.length !== 0) throw new Error('un-starred model stayed in the favorites group')
if (providerCount('Favorites') !== '0') throw new Error('favorites badge did not drop the star')
if (JSON.stringify(storedFavorites()) !== '[]') throw new Error('un-starring did not persist')

// Leave the grouped list and an empty query for the search tests below.
await act(async () => { typeInto(search, 'reasoner') })
if (modelNames().length === 0) throw new Error('search showed nothing')
await act(async () => { typeInto(search, '') })
console.log('left column       :', providerNames())

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
if (groupsShown().length !== 4) throw new Error('expected favorites + 3 provider groups')

const zhipuRow = providerRow('智谱 GLM')
await act(async () => { zhipuRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('lit after click   :', activeProviderRow(), '| groups:', groupsShown().length)
if (activeProviderRow() !== '智谱 GLM') throw new Error('clicking a supplier row did not light it')
if (groupsShown().length !== 4) throw new Error('clicking a supplier row filtered the list instead of travelling')

// Scrolling the list moves the highlight, with no group removed. Groups are:
// Favorites (offset 0), DeepSeek (120), 智谱 GLM (240), 一起安 (360).
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
if (activeProviderRow() !== 'Favorites') throw new Error('the spy did not light the favorites group at the top')
await scrollTo(360)
console.log('lit at scrollTop 360 :', activeProviderRow(), '| groups:', groupsShown().length)
if (activeProviderRow() !== '一起安') throw new Error('the spy did not follow the scroll position')
if (groupsShown().length !== 4) throw new Error('scrolling dropped a group')
// Mid-group stays on the floor the list is standing on, not the next one.
await scrollTo(200)
console.log('lit at scrollTop 200 :', activeProviderRow())
if (activeProviderRow() !== 'DeepSeek') throw new Error('the spy switched floors too early')

console.log('INTERACTION OK')
