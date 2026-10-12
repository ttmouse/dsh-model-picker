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
    // The id shapes a real reseller serves, one per way a brand has to be
    // found: from the id alone, from the name alone, from the segment after a
    // `vendor/` prefix (17an-mumiao ships exactly this id), from a family
    // abbreviation with no lab in it, and from a row that names no lab at all.
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash', description: 'id names the lab' },
    { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision', description: 'vendor-prefixed id' },
    { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3', description: 'lab in the vendor segment' },
    { id: 'hy3', name: 'Hy3', description: 'family abbreviation' },
    // Hosts, the second rule. `Composer` names no lab, so the only brand in the
    // label is the host; `Auto · Cursor` names no model at all.
    { id: 'composer-2.5', name: 'Composer 2.5 · Cursor', description: 'host names the mark' },
    { id: 'auto', name: 'Auto · Cursor', description: 'host only' },
    // …and the trap the two rules exist to avoid: Grok's model RESOLD through
    // Cursor. The lab has to win, or the row would claim the wrong maker. Its
    // reference is `grok-4.5`, the same lab without a host in the label.
    { id: 'grok-4.5', name: 'Grok 4.5', description: 'lab reference' },
    { id: 'grok-4.7@500k', name: 'Grok 4.7 @ 500k · Cursor', description: 'lab wins over host' },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash · Trae CN', description: 'lab wins over host again' },
    // A row whose id and name name no lab the brand table knows: it must keep the
    // supplier's tinted initial rather than borrow a mark it cannot back up.
    // Kept last, because the keyboard tests walk to the end of the list.
    { id: 'default-model', name: '一起安 Auto', description: 'routed, no brand' },
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
// ── Switch-to-repair: the session the seat follows ──────────────────────────
// The repair port retains the session through `sessions.retain`, then holds the
// Session's own `subscribe`/`getSnapshot` pair as a store — that pair is what
// lets the failover button appear when a failure is reported and vanish when it
// clears. The fake implements the same contract and records both the retention
// count and every submitted prompt, so the tests can assert what the button did.
//
// `repairState` is what the fake reports; tests mutate it and call `fail()` /
// `heal()` to drive the session's change notifications the way the real Host
// does (both happen inside the real `prompt()`/error handlers).
const repairState = {
  snapshot: { promptError: null, lastAgentError: null, promptAttempted: true },
  interrupted: undefined,
  originalText: null,
  reachable: true,
  promptResult: { ok: true, value: { accepted: true } },
}
const repairCalls = { retained: 0, released: 0, prompts: [], subscribed: 0 }
const sessionListeners = new Set()
/** Notify the seat the way the real Session's notifier does after a state change. */
const sessionNotify = () => { for (const fn of [...sessionListeners]) fn() }
const fakeSession = {
  getSnapshot: () => repairState.snapshot,
  subscribe: (listener) => {
    repairCalls.subscribed += 1
    sessionListeners.add(listener)
    return () => { sessionListeners.delete(listener) }
  },
  events: {
    getSnapshot: () => ({
      events: [
        ...(repairState.originalText === null ? [] : [{
          type: 'user/message',
          data: { message: { role: 'user', content: [{ type: 'text', text: repairState.originalText }] } },
        }]),
        ...(repairState.interrupted === undefined ? [] : [{
          type: 'assistant/message',
          data: { interrupted: repairState.interrupted },
        }]),
      ],
    }),
  },
  prompt: (content, mode) => {
    repairCalls.prompts.push({ content, mode })
    return Promise.resolve(repairState.promptResult)
  },
}
sessions.retain = (_sessionId, _options) => {
  if (!repairState.reachable) throw new Error('unknown session')
  repairCalls.retained += 1
  return {
    ready: Promise.resolve(),
    binding: { session: fakeSession },
    release: () => {
      repairCalls.released += 1
      sessionListeners.clear()
    },
  }
}
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

// The avatar rides on the closed trigger too, so which model is in use — and
// whose it is — is legible without opening the picker at all. The model here is
// a DeepSeek one, so it wears DeepSeek's own mark, not a letter.
const triggerChip = () => {
  const chip = left.querySelector('.dsh-mp2-avatar')
  return chip === null ? null : {
    text: chip.textContent,
    bg: chip.style.getPropertyValue('--dsh-mp2-chip-bg'),
    brand: chip.classList.contains('dsh-mp2-avatarBrand'),
    paths: chip.querySelectorAll('svg path').length,
  }
}
console.log('trigger chip:', JSON.stringify(triggerChip()))
if (triggerChip()?.brand !== true) {
  throw new Error(`a branded model must wear its mark on the trigger, got ${JSON.stringify(triggerChip())}`)
}
if (triggerChip()?.paths === 0) throw new Error('the trigger brand mark carries no path')
// A mark is not a letter on a chip: it takes no tint, because the tint is what
// turns a bare letter into a legible marker, and a logo needs no such help.
if (triggerChip()?.bg !== '') {
  throw new Error(`a brand mark must not wear the chip tint, got ${JSON.stringify(triggerChip()?.bg)}`)
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
// its base provider's group, not under its own heading. Nothing is starred yet,
// so the favorites group is absent rather than rendered empty.
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
if (grouped.length !== 4) throw new Error(`expected recent + 3 provider groups, got ${grouped.length}`)
if (grouped[0].header !== 'Recent') throw new Error('the history group must be pinned at the top')
// An empty favorites group teaches nothing and would be a heading with nothing
// under it, so it is not rendered at all — and neither is its left-column
// floor, which would otherwise scroll to a section that does not exist.
if (groupByHeader('Favorites') !== undefined) throw new Error('an empty favorites group must not be rendered')
const leftFloors = () => [...container.querySelectorAll('.dsh-mp2-providers .dsh-mp2-providerName')].map((n) => n.textContent)
if (leftFloors().includes('Favorites')) throw new Error('an empty favorites group must not leave a floor behind')
if (grouped[1].header !== 'DeepSeek') throw new Error(`the suppliers must follow the history, got ${grouped[1].header}`)
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

// 2c. Every row wears its maker's mark ahead of the model name. The model list
// names LABS (one model id is routinely resold by several suppliers), so three
// models from three labs must wear three different marks — and a model whose
// maker the picker cannot name keeps the supplier's tinted initial, because a
// mark it cannot name honestly is worse than a letter it can.
const avatarEl = (name) => [...container.querySelectorAll('.dsh-mp2-list .dsh-mp2-option')]
  .find((o) => o.querySelector('.dsh-mp2-modelName')?.textContent === name)
  ?.querySelector('.dsh-mp2-avatar')
const avatarOf = (name) => {
  const el = avatarEl(name)
  if (el === undefined) return null
  return {
    brand: el.classList.contains('dsh-mp2-avatarBrand'),
    text: el.textContent,
    paths: [...el.querySelectorAll('svg path')].map((p) => p.getAttribute('d')),
    hue: el.style.getPropertyValue('--dsh-mp2-chip-bg'),
  }
}
const marks = {
  DeepSeek: avatarOf('DeepSeek Chat'),
  GLM: avatarOf('GLM-4.6'),
  qwen: avatarOf('Qwen3 Max'),
  namesIdOnly: avatarOf('glm-5.3-flash'),
  vendorPrefix: avatarOf('DeepSeek V4 Flash Vision'),
  vendorLab: avatarOf('MiniMax M3'),
  familyAbbrev: avatarOf('Hy3'),
  hostOnly: avatarOf('Composer 2.5 · Cursor'),
  hostBare: avatarOf('Auto · Cursor'),
  labBeatsHost: avatarOf('Grok 4.7 @ 500k · Cursor'),
  labBeatsHost2: avatarOf('DeepSeek-V4.1-Flash · Trae CN'),
  grokRef: avatarOf('Grok 4.5'),
  unnamed: avatarOf('一起安 Auto'),
  folded: avatarOf('DeepSeek Reasoner (modlens vision)'),
}
console.log('avatars           :', JSON.stringify(Object.fromEntries(
  Object.entries(marks).map(([name, mark]) => [name, mark === null ? null
    : { brand: mark.brand, text: mark.text, paths: mark.paths.length, hue: mark.hue }]),
)))
const BRANDED = [
  'DeepSeek', 'GLM', 'qwen', 'namesIdOnly', 'vendorPrefix', 'vendorLab',
  'familyAbbrev', 'hostOnly', 'hostBare', 'labBeatsHost', 'labBeatsHost2',
]
for (const name of BRANDED) {
  if (marks[name]?.brand !== true) throw new Error(`"${name}" does not wear a brand mark: ${JSON.stringify(marks[name])}`)
  if (marks[name].paths === 0) throw new Error(`the "${name}" mark carries no path`)
  if (marks[name].text !== '') throw new Error(`a brand mark must not also render a letter: ${JSON.stringify(marks[name].text)}`)
}
// The lab is found wherever the id puts it: in the id itself, after a `vendor/`
// prefix, in the vendor segment, or from a family abbreviation with no lab in
// it. A rule that only read the first token would pass the first two and fail
// the rest.
// One lab, one shape — and different labs, different shapes. A table that
// resolved every row to the same mark would pass a per-row spot check and be
// useless in the list, which is exactly the failure a mark is meant to prevent.
const shapeOf = (name) => marks[name].paths.join('|')
const sameLab = [['DeepSeek', 'vendorPrefix'], ['GLM', 'namesIdOnly']]
for (const [a, b] of sameLab) {
  if (shapeOf(a) !== shapeOf(b)) throw new Error(`"${a}" and "${b}" are the same lab but wear different marks`)
}
const distinctLabs = ['DeepSeek', 'GLM', 'qwen', 'vendorLab', 'familyAbbrev', 'hostOnly', 'grokRef']
const distinctShapes = new Set(distinctLabs.map(shapeOf))
if (distinctShapes.size !== distinctLabs.length) {
  throw new Error(`two different marks collided: ${JSON.stringify(distinctLabs.map(shapeOf))}`)
}
console.log('labs resolved     :', JSON.stringify({
  deepseek: shapeOf('DeepSeek').length,
  zhipu: shapeOf('GLM').length,
  qwen: shapeOf('qwen').length,
  minimax: shapeOf('vendorLab').length,
  hunyuan: shapeOf('familyAbbrev').length,
  cursor: shapeOf('hostOnly').length,
}))

// The lab beats the host, which is the entire reason there are two rules. Both
// of these rows name Cursor or Trae in the label and neither is their model:
// `grok-4.7@500k` is Grok's, `deepseek-v4.1-flash` is DeepSeek's. A host-first
// scan would hand both of them the wrong maker — the exact mistake a mark is
// supposed to prevent, and one a spot check on `Composer · Cursor` cannot see.
const beatsHost = [
  ['labBeatsHost', 'grokRef'], // Grok's mark, not Cursor's
  ['labBeatsHost2', 'DeepSeek'], // DeepSeek's mark, not Trae's
]
for (const [row, lab] of beatsHost) {
  if (shapeOf(row) !== shapeOf(lab)) {
    throw new Error(`"${row}" wore the host's mark instead of the lab's (${lab})`)
  }
}
if (shapeOf('labBeatsHost') === shapeOf('hostOnly')) {
  throw new Error('a resold Grok row wore Cursor\'s mark because the label says Cursor')
}
console.log('host fallback     :', JSON.stringify({
  hostOnly: shapeOf('hostOnly').length,
  hostBare: shapeOf('hostBare').length,
  labWinsOverHost: shapeOf('labBeatsHost') === shapeOf('grokRef'),
}))
// The table and the rules have to agree in both directions, or the data block
// rots silently: a mark no rule can reach is a mark nobody can see, and a rule
// pointing at a mark the table does not carry would render an empty box. Neither
// is visible to a spot check on any single row.
const brandTable = (() => {
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const slice = (from, to) => {
    const at = source.indexOf(from)
    if (at === -1) throw new Error(`lib/client.js no longer declares ${JSON.stringify(from)}`)
    return source.slice(at, source.indexOf(to, at) + to.length)
  }
  const targets = (block) => [...block.matchAll(/\['([^']*)', '([^']*)'\]/gu)]
    .map((m) => ({ name: m[1], mark: m[2] }))
  return {
    marks: [...slice('const BRAND_PATHS = {', '\n  }\n').matchAll(/^    ([a-z0-9]+):/gmu)].map((m) => m[1]),
    rules: [...targets(slice('const BRAND_PREFIXES = [', '\n  ]\n'))],
    hosts: [...targets(slice('const BRAND_HOSTS = [', '\n  ]\n'))],
  }
})()
const reachable = [...brandTable.rules, ...brandTable.hosts].map((rule) => rule.mark)
const unreachable = brandTable.marks.filter((mark) => !reachable.includes(mark))
if (unreachable.length > 0) {
  throw new Error(`the brand table carries marks no rule can reach: ${JSON.stringify(unreachable)}`)
}
const dangling = [...new Set(reachable)].filter((mark) => !brandTable.marks.includes(mark))
if (dangling.length > 0) {
  throw new Error(`a rule points at a mark the table does not carry: ${JSON.stringify(dangling)}`)
}
// The order of the two rules is load-bearing, so the tables have to stay split.
// What may not overlap is the NAME a rule matches on — `cursor` is legitimately
// in both blocks as a target (Composer is Cursor's model, and Cursor is also a
// host), but a name in both MATCH lists would be decided by table order alone,
// and moving a host into the lab table would relabel `cursor/grok-4.7`.
const bothBlocks = brandTable.rules
  .map((rule) => rule.name)
  .filter((name) => brandTable.hosts.some((host) => host.name === name))
if (bothBlocks.length > 0) {
  throw new Error(`a name is matched as both a lab and a host: ${JSON.stringify(bothBlocks)}`)
}
console.log('brand table       :', JSON.stringify({
  marks: brandTable.marks.length,
  labRules: brandTable.rules.length,
  hostRules: brandTable.hosts.length,
  unreachable: unreachable.length,
}))

// The fallback half: an id and a name that name no lab the table knows.
if (marks.unnamed?.brand !== false) {
  throw new Error(`an unnamed family must fall back to the supplier initial, got ${JSON.stringify(marks.unnamed)}`)
}
if (marks.unnamed.text !== '一') throw new Error(`the fallback initial is wrong: ${JSON.stringify(marks.unnamed.text)}`)
// The tint is a curated OKLCH value: fixed chroma and lightness, hue only, so
// one supplier cannot shout louder than another. It used to be a hash of the
// route id, which put ten unrelated hues in one panel.
if (!/^oklch\(/.test(marks.unnamed.hue)) {
  throw new Error(`the fallback chip tint must be a curated OKLCH value, got ${JSON.stringify(marks.unnamed.hue)}`)
}
// A folded route has no row of its own, so its models must wear the mark of the
// base supplier's model — the same model, after all, not a mark of their own.
if (marks.folded?.paths.join('|') !== marks.DeepSeek.paths.join('|')) {
  throw new Error('a folded route wore its own mark instead of its base model\'s')
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
const favFloorAfter = providerCount('Favorites')
console.log('after un-star     :', favGroupAfter?.models ?? '(group gone)', '| favorites badge:', favFloorAfter ?? '(floor gone)')
// Removing the last favorite takes the whole group with it, and its floor too:
// an empty group is not rendered, so there is nothing to scroll to.
if (favGroupAfter !== undefined) throw new Error('the favorites group must disappear once nothing is starred')
if (favFloorAfter !== undefined) throw new Error('the favorites floor must disappear with its group')
if (JSON.stringify(storedFavorites()) !== '[]') throw new Error('un-starring did not persist')

// Leave the grouped list and an empty query for the search tests below.
await act(async () => { typeInto(search, 'reasoner') })
if (modelNames().length === 0) throw new Error('search showed nothing')
await act(async () => { typeInto(search, '') })
console.log('left column       :', providerNames())

// Every supplier floor wears its tinted initial in the elevator. The floors keep
// the letter even where the models beside them wear a mark: a floor names a
// SUPPLIER, and the three `17an` floors would otherwise be indistinguishable,
// while the model list names labs, which have marks of their own.
const elevatorChips = [...container.querySelectorAll('.dsh-mp2-providers .dsh-mp2-provider')].map((btn) => {
  const chip = btn.querySelector('.dsh-mp2-avatar')
  const name = btn.querySelector('.dsh-mp2-providerName')?.textContent
  return {
    name,
    chipText: chip?.textContent ?? null,
    brand: chip?.classList.contains('dsh-mp2-avatarBrand') ?? false,
    chipHue: chip?.style.getPropertyValue('--dsh-mp2-chip-bg') ?? null,
  }
})
console.log('elevator chips    :', JSON.stringify(elevatorChips))
// The history and favorites floors are mirrors, not suppliers. A mirror that
// has no rows has no floor either — and no group to jump to — so only the
// floors actually present are checked here. Nothing is starred at this point.
const MIRROR_FLOORS = ['Recent', 'Favorites'].filter((name) => providerRow(name) !== undefined)
if (!MIRROR_FLOORS.includes('Recent')) throw new Error('the history floor is missing from the elevator')
if (MIRROR_FLOORS.includes('Favorites')) throw new Error('a favorites floor with no rows must not be rendered')
const isMirrorFloor = (name) => MIRROR_FLOORS.includes(name)
for (const { name, chipText, brand, chipHue } of elevatorChips) {
  if (isMirrorFloor(name)) continue
  if (brand) throw new Error(`supplier floor "${name}" wears a model's brand mark`)
  if (chipText === null) throw new Error(`supplier "${name}" is missing its chip in the elevator`)
  if (chipText.length === 0) throw new Error(`supplier "${name}" has an empty chip`)
  // The tint is a curated OKLCH value: fixed chroma and lightness, hue only, so
  // one supplier cannot shout louder than another. It used to be a hash of the
  // route id, which put ten unrelated hues in one panel.
  if (!/^oklch\(/.test(chipHue ?? '')) {
    throw new Error(`supplier "${name}" wears a tint that is not a curated OKLCH value: ${JSON.stringify(chipHue)}`)
  }
}
// Suppliers are told apart by tint, so no two of them may share a hue.
const floorHues = elevatorChips.filter(({ name }) => !isMirrorFloor(name)).map(({ chipHue }) => chipHue)
if (new Set(floorHues).size !== floorHues.length) {
  throw new Error(`suppliers share a chip colour: ${JSON.stringify(floorHues)}`)
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
// …and the trigger avatar must follow the same rule: the mark of the base
// supplier's model, not a mark of the folded route's own.
if (triggerChip()?.brand !== true || triggerChip()?.paths === 0) {
  throw new Error(`the trigger must wear the base model's mark, got ${JSON.stringify(triggerChip())}`)
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
// Nothing is starred here, so there is no favorites group: history + 3 suppliers.
if (groupsShown().length !== 4) throw new Error('expected recent + 3 provider groups')

const zhipuRow = providerRow('智谱 GLM')
await act(async () => { zhipuRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
console.log('lit after click   :', activeProviderRow(), '| groups:', groupsShown().length)
if (activeProviderRow() !== '智谱 GLM') throw new Error('clicking a supplier row did not light it')
if (groupsShown().length !== 4) throw new Error('clicking a supplier row filtered the list instead of travelling')

// Scrolling the list moves the highlight, with no group removed. Nothing is
// starred, so there is no favorites group. Groups are: Recent (offset 0),
// DeepSeek (120), 智谱 GLM (240), 一起安 (360).
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
await scrollTo(360)
console.log('lit at scrollTop 360 :', activeProviderRow(), '| groups:', groupsShown().length)
if (activeProviderRow() !== '一起安') throw new Error('the spy did not follow the scroll position')
if (groupsShown().length !== 4) throw new Error('scrolling dropped a group')
await scrollTo(240)
console.log('lit at scrollTop 240 :', activeProviderRow())
if (activeProviderRow() !== '智谱 GLM') throw new Error('the spy did not stop on the floor the list is standing on')
// Mid-group stays on the floor the list is standing on, not the next one.
await scrollTo(200)
console.log('lit at scrollTop 200 :', activeProviderRow())
if (activeProviderRow() !== 'DeepSeek') throw new Error('the spy switched floors too early')

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
// history rows, then DeepSeek's three, then GLM-4.6, then 一起安's five (收藏 is
// empty here, so it contributes no row). The last row is read from the DOM
// rather than named, so adding a fixture row does not make this a false alarm.
const lastModel = () => modelNames().at(-1)
await press('ArrowDown')
await press('ArrowDown')
console.log('after ↓↓         :', activeName(), '| floor:', activeGroup())
if (activeName() !== 'DeepSeek Chat') throw new Error('ArrowDown did not advance the cursor')
await press('ArrowUp')
console.log('after ↑          :', activeName())
if (activeName() !== 'DeepSeek Reasoner') throw new Error('ArrowUp did not retreat the cursor')
await press('End')
console.log('after End        :', activeName(), '| last row:', lastModel())
if (activeName() !== lastModel()) throw new Error('End did not jump to the last row')
await press('ArrowDown')
if (activeName() !== lastModel()) throw new Error('the cursor ran past the last row')
await press('Home')
console.log('after Home       :', activeName())
if (activeName() !== 'DeepSeek Reasoner (modlens vision)') throw new Error('Home did not jump to the first row')
await press('ArrowUp')
if (activeName() !== 'DeepSeek Reasoner (modlens vision)') throw new Error('the cursor ran past the first row')
// PageDown is a page, not the end of the list: from the first row it steps down
// by the page size (ten) and clamps, so on a list this short it lands on the
// last row — and further pages then hold there.
const pageSize = 10
const rowCount = modelNames().length
const expectedAfterPage = modelNames()[Math.min(pageSize, rowCount - 1)]
await press('PageDown')
console.log('after PageDown   :', activeName(), `| rows: ${rowCount}`)
if (activeName() !== expectedAfterPage) {
  throw new Error(`PageDown must step ${pageSize} rows, expected "${expectedAfterPage}"`)
}
for (let extra = 0; extra < 3; extra += 1) await press('PageDown')
if (activeName() !== lastModel()) throw new Error('PageDown did not hold on the last row')
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
const footerAction = () => container.querySelector('.dsh-mp2-footerSettings')
if (container.querySelector('.dsh-mp2-menu') === null) throw new Error('the popup must be open to test its footer')
const footerNode = footerRow()
if (footerNode === null) throw new Error('the model popup must carry the settings footer')
// A fixed row under the body, not a row inside the scroll area: one that scrolls
// away is one the user cannot find when the models are missing.
if (footerNode.closest('.dsh-mp2-list') !== null) throw new Error('the footer must sit outside the scrolling list')
if (footerNode.parentElement.className !== 'dsh-mp2-menu') throw new Error('the footer must be a direct child of the popup')
assertVectorIcons(footerNode, 'the settings footer')

// 11a. The two settings entries sit together at the trailing edge, and each one
//      names its subject. A bare glyph makes the reader recognise two shapes to
//      find two settings pages, in a row that is otherwise empty — the label is
//      what makes the pair readable, and grouping is what makes it one decision.
const footerCluster = footerNode.querySelector('.dsh-mp2-footerCluster')
if (footerCluster === null) throw new Error('the two settings entries must share one cluster')
if (footerCluster.parentElement !== footerNode) throw new Error('the cluster must be a direct child of the footer row')
const clusterButtons = [...footerCluster.querySelectorAll('button')]
console.log('footer cluster  :', clusterButtons.map((b) => b.textContent))
if (clusterButtons.length !== 2) {
  throw new Error(`the cluster must hold exactly the two settings entries, got ${clusterButtons.length}`)
}
// Auto margin distributes free space, so two separately-margined buttons would
// be pushed apart by the emptiness between them. One margin on the wrapper is
// what holds them together, and it must sit on the trailing edge.
if (footerCluster.getAttribute('style') !== null) throw new Error('the cluster must not be positioned from script')
const clusterGap = dom.window.getComputedStyle(footerCluster).marginLeft
if (clusterGap !== 'auto') throw new Error(`the settings cluster must take the free space at the trailing edge, got ${clusterGap}`)
// Order: fallback first, then the settings page. It matches the row the entries
// replaced and keeps the more-used entry closest to the panel's fold toggle.
const [fallbackButton, settingsButton] = clusterButtons
// Neither child carries a margin of its own: the gap must come from the cluster,
// or the pair drifts apart when one of the two labels is a different length.
for (const entry of clusterButtons) {
  const own = dom.window.getComputedStyle(entry).marginLeft
  if (own === 'auto' || Number.parseFloat(own) !== 0) {
    throw new Error(`the cluster's own children must not carry margins, got ${own}`)
  }
}
if (!fallbackButton.className.includes('dsh-mp2-footerFallback')) {
  throw new Error('the fallback entry leads the cluster')
}
if (!fallbackButton.textContent.includes('Fallback')) {
  throw new Error(`the fallback entry must name its subject, got ${JSON.stringify(fallbackButton.textContent)}`)
}
if (fallbackButton.title !== 'Fallback models') {
  throw new Error(`the fallback tooltip must name the page it opens, got ${JSON.stringify(fallbackButton.title)}`)
}
for (const [entry, subject] of [[fallbackButton, 'Fallback'], [settingsButton, 'Models']]) {
  if (entry.querySelectorAll('svg').length !== 1) throw new Error(`${subject}: one glyph and one label`)
  if (!entry.querySelector('.dsh-mp2-footerLabel')) throw new Error(`${subject}: the label must be its own element`)
  // The visible copy is short; the full sentence belongs in the tooltip.
  if (entry.textContent.length > 12) {
    throw new Error(`${subject}: the row label must stay short, got ${JSON.stringify(entry.textContent)}`)
  }
  if (!entry.getAttribute('aria-label')) throw new Error(`${subject}: must be named for screen readers`)
  if (entry.getAttribute('aria-label').length <= entry.textContent.length) {
    throw new Error(`${subject}: the accessible name must carry the full sentence`)
  }
}
// The destination is not printed in the row: a full-width bar with a label on its
// far right read as the panel's second row of content. The row keeps the short
// subject and the tooltip keeps the whole sentence, so the full wording is still
// there when it is asked for and silent when it is not.
if (!settingsButton.title.includes('Settings · Models')) {
  throw new Error(`the footer tooltip must still name the surface it leaves for, got ${JSON.stringify(settingsButton.title)}`)
}
if (settingsButton.textContent.includes('Settings · Models')) {
  throw new Error('the destination must not be printed in the row again')
}
// …and the hand-off itself is unchanged by the label: one click still writes the
// 模型 section and closes the picker, and never doubles as a model pick.
const footerButton = settingsButton

// 11-bis. The footer's other control folds the panel's OWN provider column, the
//        table of contents, so the model list gets that width back. The fold is
//        a view preference and survives a reload; it must never reach into the
//        shell's layout, which owns a different sidebar entirely.
const folded = () => container.querySelector('.dsh-mp2-menu').className.includes('dsh-mp2-menuFolded')
const footerToggle = () => container.querySelector('.dsh-mp2-footerIcon')
if (footerToggle() === null) throw new Error('the footer must carry a provider-column toggle')
if (footerToggle().querySelector('svg') === null) throw new Error('the provider toggle must be a vector icon')
if (!footerToggle().getAttribute('aria-label')) throw new Error('the provider toggle must be named for screen readers')
// It stays a bare glyph: it folds the panel in front of the user, not a setting
// elsewhere, so it wears no label and is not part of the settings cluster.
if (footerNode.querySelector('.dsh-mp2-footerCluster').contains(footerToggle())) {
  throw new Error('the provider toggle is not a settings entry')
}
if (footerToggle().textContent.trim() !== '') {
  throw new Error(`the provider toggle must stay a bare glyph, got ${JSON.stringify(footerToggle().textContent)}`)
}
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
  footer: container.querySelector('.dsh-mp2-footerSettings .dsh-mp2-footerLabel')?.textContent ?? null,
  footerFallback: container.querySelector('.dsh-mp2-footerFallback .dsh-mp2-footerLabel')?.textContent ?? null,
  // The destination is printed in the tooltip now, not in the row itself.
  where: (() => {
    const tip = container.querySelector('.dsh-mp2-footerSettings')?.title ?? ''
    const at = tip.indexOf(': ')
    return at === -1 ? null : tip.slice(at + 2)
  })(),
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
if (english.footer !== 'Models') throw new Error(`English footer copy wrong: ${english.footer}`)
if (english.footerFallback !== 'Fallback') throw new Error(`English fallback-footer copy wrong: ${english.footerFallback}`)

await setLang('zh-CN')
const chinese = menuCopy()
console.log('html lang zh-CN  :', JSON.stringify(chinese))
if (chinese.search !== '搜索模型或提供商…') {
  throw new Error(`an open popup must switch to Chinese with the app, got ${JSON.stringify(chinese.search)}`)
}
if (chinese.footer !== '官方模型') throw new Error(`Chinese footer copy wrong: ${chinese.footer}`)
if (chinese.footerFallback !== '兜底模型') throw new Error(`Chinese fallback-footer copy wrong: ${chinese.footerFallback}`)
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

// 13. Failover: the repair button that appears only when something broke.
//
// The design rule under test is visibility. On a healthy session the control must
// not exist at all — that is the whole point of gating on the failure rather than
// on a standing toggle — and when a failure is live with a fallback designated it
// must appear and do both halves of the repair in one click (switch, then send).
// The negative cases therefore carry the same weight as the positive ones.
console.log('--- failover ---')

const FALLBACK_ROUTE = 'zhipu/glm-4.6'
const seedFallback = { 'dsh.modelPicker.fallback': JSON.stringify({ route: FALLBACK_ROUTE }) }

/** Mount a fresh picker with storage seeded, and the session staged as given. */
async function failoverMount(storage, stage) {
  dom.window.localStorage.clear()
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value)
  sessionListeners.clear()
  repairCalls.prompts.length = 0
  repairCalls.retained = 0
  repairCalls.released = 0
  // The fake directory is shared across mounts, so reset the current model or a
  // later case could click an already-selected row and never reach the action.
  snapshot.current = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }
  repairState.reachable = true
  repairState.promptResult = { ok: true, value: { accepted: true } }
  if (stage !== undefined) {
    repairState.snapshot = stage.snapshot
    repairState.interrupted = stage.interrupted
    repairState.originalText = stage.originalText ?? null
    if (stage.promptResult !== undefined) repairState.promptResult = stage.promptResult
  }
  notify()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  // A fresh seat per mount, exactly as the host does: `inject` is called once for
  // the seat and owns that seat's repair port. Sharing one port across mounts
  // would interleave their subscribe/unsubscribe pairs into a single listener
  // set, so `attach` would never see the transition to one listener.
  const seat = options.inject('session-1')
  await act(async () => {
    root.render(React.createElement(Component, { locked: false, ...seat, t: (k) => k }))
  })
  // Let the port's deferred first read settle (it awaits `reference.ready`).
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  if (process.env.DBG) {
    console.log('   DBG: retained=%d released=%d listeners=%d', repairCalls.retained, repairCalls.released, sessionListeners.size)
  }
  return { host, root }
}

const SEND_FAILURE = {
  snapshot: { promptError: { op: 'send', error: { message: 'quota exhausted' } }, lastAgentError: null, promptAttempted: true },
  interrupted: undefined,
  originalText: '把这份报告的重点整理成三条',
}
const AGENT_FAILURE = {
  snapshot: { promptError: null, lastAgentError: 'stream ended unexpectedly', promptAttempted: true },
  interrupted: undefined,
  originalText: '把这份报告的重点整理成三条',
}
const CLEAN = {
  snapshot: { promptError: null, lastAgentError: null, promptAttempted: true },
  interrupted: undefined,
  originalText: null,
}
const buttonOf = (host) => host.querySelector('.dsh-mp2-failoverBtn')
/** The send-failure button label, captured in 13c and compared in 13d. */
let sendLabel = null

// 13a. The rule that matters most: a healthy session shows NOTHING. This is what
//      keeps a rare event from touching ordinary model switching.
for (const [label, storage, stage] of [
  ['clean + fallback set', seedFallback, CLEAN],
  ['clean + no fallback', {}, CLEAN],
]) {
  const { host, root } = await failoverMount(storage, stage)
  console.log('absent        : %s → %s', label, buttonOf(host) === null ? 'no button' : 'BUTTON PRESENT')
  if (buttonOf(host) !== null) throw new Error(`${label} must not render the failover button`)
  await act(async () => { root.unmount() })
}

// 13b. A failure with NO fallback designated also shows nothing — "not set" means
//      no button, never a button that cannot act.
{
  const { host, root } = await failoverMount({}, SEND_FAILURE)
  console.log('absent        : failure + no fallback → %s', buttonOf(host) === null ? 'no button' : 'BUTTON PRESENT')
  if (buttonOf(host) !== null) throw new Error('a failure with no fallback must not render the button')
  await act(async () => { root.unmount() })
}

// 13c. A live failure WITH a fallback: the button appears, names the target, and
//      one click switches the model and sends the repair — in that order.
{
  const { host, root } = await failoverMount(seedFallback, SEND_FAILURE)
  const button = buttonOf(host)
  if (button === null) throw new Error('a failure with a fallback must offer the button')
  console.log('appears       : text=%s', JSON.stringify(button.textContent))
  if (!/GLM-4.6/.test(button.textContent)) {
    throw new Error(`the button must name the fallback it will use, got ${JSON.stringify(button.textContent)}`)
  }
  // Remembered for 13d: the two failure shapes must not share one label.
  sendLabel = button.textContent.replace('GLM-4.6', '')
  const before = selections.length
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const picked = selections.slice(before)
  const sent = repairCalls.prompts
  console.log('one click     : switched=%s prompts=%d mode=%s', JSON.stringify(picked.at(-1)), sent.length, sent[0]?.mode)
  if (picked.length !== 1 || picked[0].provider !== 'zhipu' || picked[0].model !== 'glm-4.6') {
    throw new Error(`the click must switch to the fallback, got ${JSON.stringify(picked)}`)
  }
  if (sent.length !== 1) throw new Error(`the click must send exactly one repair, got ${sent.length}`)
  if (sent[0].mode !== 'queue') throw new Error(`the repair must queue, got mode ${sent[0].mode}`)
  // A send failure never reached the Host, so the exact words are replayed.
  if (sent[0].content[0].text !== '把这份报告的重点整理成三条') {
    throw new Error(`a send failure must replay the original words, got ${JSON.stringify(sent[0].content[0].text)}`)
  }
  await act(async () => { root.unmount() })
}

// 13d. An agent failure sends the resumption instruction instead — the work may
//      be half-done, so replaying the request would read as a fresh start. The
//      button also labels itself differently, since the action differs.
{
  const { host, root } = await failoverMount(seedFallback, AGENT_FAILURE)
  const button = buttonOf(host)
  if (button === null) throw new Error('an agent failure must offer the button')
  const agentLabel = button.textContent.replace('GLM-4.6', '')
  console.log('appears       : label=%s', JSON.stringify(button.textContent))
  // A resumed turn is a different action from a plain retry and must say so. The
  // panel resolves its own locale, so this compares the two labels rather than
  // pinning either one's wording.
  if (agentLabel === 'Retry with the fallback') {
    throw new Error(`an agent failure must not be labelled as a plain retry, got ${JSON.stringify(agentLabel)}`)
  }
  if (agentLabel === sendLabel) {
    throw new Error('the resume action must be labelled differently from the retry action')
  }
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const sent = repairCalls.prompts
  if (sent.length !== 1) throw new Error(`an agent failure must send one repair, got ${sent.length}`)
  const text = sent[0].content[0].text
  if (text === '把这份报告的重点整理成三条') {
    throw new Error('an agent failure must not replay the original words — the work may be half-done')
  }
  const zh = /核实.*进度.*继续/s
  const en = /check what actually completed.*resume/s
  if (!zh.test(text) && !en.test(text)) {
    throw new Error(`the resumption instruction must ask to check progress, got ${JSON.stringify(text)}`)
  }
  console.log('agent repair  : %s', JSON.stringify(text.slice(0, 48)) + '…')
  await act(async () => { root.unmount() })
}

// 13e. An interrupted final assistant message is the third failure shape: no
//      promptError, no lastAgentError, but the turn visibly stopped.
{
  const { host, root } = await failoverMount(seedFallback, {
    snapshot: { promptError: null, lastAgentError: null, promptAttempted: true },
    interrupted: true,
    originalText: null,
  })
  console.log('interrupted   : %s', buttonOf(host) === null ? 'no button' : 'button shown')
  if (buttonOf(host) === null) throw new Error('an interrupted turn must offer the button')
  await act(async () => { root.unmount() })
}

// 13f. The button disappears when the failure clears. This is the same code path
//      the real Host takes: `prompt()` nulls both error fields, so a successful
//      repair makes the control retire itself with no extra bookkeeping.
{
  const { host, root } = await failoverMount(seedFallback, SEND_FAILURE)
  if (buttonOf(host) === null) throw new Error('precondition: the button must be shown')
  await act(async () => {
    // What the Host does on an accepted prompt.
    repairState.snapshot = { promptError: null, lastAgentError: null, promptAttempted: true }
    repairState.interrupted = undefined
    sessionNotify()
  })
  console.log('self-clearing : %s', buttonOf(host) === null ? 'button gone' : 'STILL PRESENT')
  if (buttonOf(host) !== null) {
    throw new Error('the button must disappear once the failure clears')
  }
  await act(async () => { root.unmount() })
}

// 13g. A stale route is omitted from actionable failover choices.
{
  const storage = { 'dsh.modelPicker.fallback': JSON.stringify({ route: 'ghost/never-configured' }) }
  const { host, root } = await failoverMount(storage, SEND_FAILURE)
  console.log('stale route   : button=%s', buttonOf(host) === null ? 'hidden' : 'shown')
  if (buttonOf(host) !== null) throw new Error('a stale fallback must not offer an unusable action')
  await act(async () => { root.unmount() })
}

// 13h. A rejected submission reports instead of failing silently, and the guard
//      does not latch: clicking again retries rather than pretending success.
{
  const { host, root } = await failoverMount(seedFallback, { ...SEND_FAILURE, promptResult: { ok: false, error: { message: 'rejected' } } })
  await act(async () => { buttonOf(host).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  const shown = host.querySelector('.dsh-mp2-failoverError')?.textContent ?? null
  console.log('rejected      : error=%s prompts=%d', JSON.stringify(shown), repairCalls.prompts.length)
  if (shown === null) throw new Error('a rejected repair must not be silent')
  const firstAttempts = repairCalls.prompts.length
  await act(async () => { buttonOf(host).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  console.log('retryable     : attempts %d → %d', firstAttempts, repairCalls.prompts.length)
  if (repairCalls.prompts.length <= firstAttempts) {
    throw new Error('a rejected repair must be retryable, not latched as done')
  }
  await act(async () => { root.unmount() })
}

// 13i. Retention is tied to the subscription: once the seat unmounts, the Session
//      must be released, or the controller could never retire it.
{
  const { root } = await failoverMount(seedFallback, CLEAN)
  const retained = repairCalls.retained
  const released = repairCalls.released
  console.log('retention     : retained=%d released=%d subscribed=%d', retained, released, repairCalls.subscribed)
  if (retained < 1) throw new Error('the seat must retain the session to follow it')
  await act(async () => { root.unmount() })
  console.log('after unmount : retained=%d released=%d', repairCalls.retained, repairCalls.released)
  if (repairCalls.released !== repairCalls.retained) {
    throw new Error(`unmount must release every retention (${repairCalls.retained} vs ${repairCalls.released})`)
  }
}

// 13j. An unreachable session leaves the picker fully working — no button, no
//      throw. The repair is best-effort and must never break the panel around it.
{
  const { host, root } = await failoverMount(seedFallback, SEND_FAILURE)
  const before = buttonOf(host)
  repairState.reachable = false
  console.log('unreachable   : button=%s (mount survived)', before === null ? 'absent' : 'present')
  // The composer still opens and lists models.
  await act(async () => {
    host.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const rows = host.querySelectorAll('.dsh-mp2-option').length
  console.log('unreachable   : popup rows=%d', rows)
  if (rows === 0) throw new Error('an unreachable session must not stop the picker from listing models')
  await act(async () => { root.unmount() })
}

// 13k. Designating the fallback from a row. This is the only way a user sets it,
//      so it must persist, show its state, and clear again.
{
  const { host, root } = await failoverMount({}, CLEAN)
  await act(async () => {
    host.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const rowNamed = (name) => [...host.querySelectorAll('.dsh-mp2-option')]
    .find((node) => node.querySelector('.dsh-mp2-modelName')?.textContent === name)
  const pinOf = (name) => rowNamed(name)?.querySelector('.dsh-mp2-pin')
  if (pinOf('GLM-4.6') === null || pinOf('GLM-4.6') === undefined) {
    throw new Error('every row must offer the fallback pin')
  }
  await act(async () => { pinOf('GLM-4.6').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const stored = JSON.parse(dom.window.localStorage.getItem('dsh.modelPicker.fallback'))
  console.log('designate     : stored=%s pressed=%s', JSON.stringify(stored), pinOf('GLM-4.6').getAttribute('aria-pressed'))
  if (!Array.isArray(stored) || stored[0] !== 'zhipu/glm-4.6') {
    throw new Error(`clicking the pin must append the route to the ordered queue, got ${JSON.stringify(stored)}`)
  }
  if (pinOf('GLM-4.6').getAttribute('aria-pressed') !== 'true') {
    throw new Error('a queued fallback must show its pin as pressed')
  }
  await act(async () => { pinOf('GLM-4.6').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const cleared = JSON.parse(dom.window.localStorage.getItem('dsh.modelPicker.fallback'))
  console.log('remove        : stored=%s', JSON.stringify(cleared))
  if (!Array.isArray(cleared) || cleared.includes('zhipu/glm-4.6')) throw new Error(`removing a route must leave it out of the queue, got ${JSON.stringify(cleared)}`)
  await act(async () => { root.unmount() })
}

// 13k.1. Search the dedicated page, add multiple candidates, and reorder priority.
{
  const { host, root } = await failoverMount({}, CLEAN)
  await act(async () => { host.querySelector('.dsh-mp2-triggerLeft').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { host.querySelector('.dsh-mp2-footerFallback').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const search = host.querySelector('.dsh-mp2-fallbackPage input[type="search"]')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(search, 'GLM-4.6')
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    search.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  const glm = [...host.querySelectorAll('.dsh-mp2-fallbackCandidate')].find((node) => node.textContent.includes('GLM-4.6'))
  if (glm === undefined) throw new Error('fallback search must find GLM-4.6')
  await act(async () => { glm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const queryInput = host.querySelector('.dsh-mp2-fallbackPage input[type="search"]')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(queryInput, 'Qwen3 Max')
    queryInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    queryInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  const qwen = [...host.querySelectorAll('.dsh-mp2-fallbackCandidate')].find((node) => node.textContent.includes('Qwen3 Max'))
  if (qwen === undefined) throw new Error('fallback search must find Qwen3 Max')
  await act(async () => { qwen.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const firstDown = host.querySelector('.dsh-mp2-fallbackRow button[title="Move down"]')
  await act(async () => { firstDown.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const ordered = JSON.parse(dom.window.localStorage.getItem('dsh.modelPicker.fallback'))
  console.log('manage page   : ordered=%s', JSON.stringify(ordered))
  if (JSON.stringify(ordered) !== JSON.stringify(['17an/qwen3-max', 'zhipu/glm-4.6'])) {
    throw new Error(`search, add, and reorder must persist priority order, got ${JSON.stringify(ordered)}`)
  }
  await act(async () => { root.unmount() })
}

// 13l. The earlier `{route, enabled}` record still yields its route, so a choice
//      made before the flag was removed is not lost on this revision.
{
  const storage = { 'dsh.modelPicker.fallback': JSON.stringify({ route: FALLBACK_ROUTE, enabled: false }) }
  const { host, root } = await failoverMount(storage, SEND_FAILURE)
  console.log('legacy record : %s', buttonOf(host) === null ? 'no button' : 'button shown')
  if (buttonOf(host) === null) {
    throw new Error('a legacy {route, enabled} record must still designate the fallback')
  }
  await act(async () => { root.unmount() })
}

// ── The automatic path ──────────────────────────────────────────────────────
//
// The Host retries a failed request five times on the SAME model and only then
// throws. `lastAgentError` is raised by that throw and never during the retries,
// so the failure store reporting an `error` IS the signal that the budget is
// spent — no separate retry accounting exists or is needed. These cases drive
// that moment and check what the panel does without being asked.

/**
 * Mount onto a healthy session, then report a failure the way the Host does
 * mid-turn. This is the only shape the automatic path is allowed to act on: the
 * seat has to have read the session as healthy first, which is what separates a
 * turn that just broke from a failure found already in the log.
 */
async function liveMount(storage, stage) {
  const { host, root } = await failoverMount(storage, CLEAN)
  repairState.snapshot = stage.snapshot
  repairState.interrupted = stage.interrupted
  repairState.originalText = stage.originalText ?? null
  await act(async () => { sessionNotify(); await Promise.resolve() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return { host, root }
}

/** Report the same shape of failure again, after the session has healed. */
async function healThen(stage) {
  repairState.snapshot = { promptError: null, lastAgentError: null, promptAttempted: true }
  repairState.interrupted = undefined
  await act(async () => { sessionNotify(); await Promise.resolve() })
  repairState.snapshot = stage.snapshot
  repairState.interrupted = stage.interrupted
  repairState.originalText = stage.originalText ?? null
  await act(async () => { sessionNotify(); await Promise.resolve() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const noteOf = (host) => host.querySelector('.dsh-mp2-autoNote')

// 13m. The case this feature exists for: the Host's retries are spent, a fallback
//      is designated, and the turn resumes on the new model with no user action.
//      The switch is announced, because the next prompt runs on a model the user
//      never chose, and the announcement REPLACES the button — offering the same
//      repair again right after performing it would be asking twice.
{
  const before = selections.length
  const { host, root } = await liveMount(seedFallback, AGENT_FAILURE)
  const note = noteOf(host)
  const picked = selections.slice(before)
  console.log('auto switch   : note=%s switched=%s prompts=%d',
    note === null ? 'NONE' : JSON.stringify(note.textContent),
    JSON.stringify(picked.at(-1) ?? null), repairCalls.prompts.length)
  if (note === null) {
    throw new Error('an exhausted turn with a fallback designated must announce the automatic switch')
  }
  if (!/GLM-4.6/.test(note.textContent)) {
    throw new Error(`the announcement must name the model now in use, got ${JSON.stringify(note.textContent)}`)
  }
  if (picked.length !== 1 || picked[0].provider !== 'zhipu' || picked[0].model !== 'glm-4.6') {
    throw new Error(`the automatic path must switch to the fallback, got ${JSON.stringify(picked)}`)
  }
  if (repairCalls.prompts.length !== 1) {
    throw new Error(`the automatic path must send exactly one repair, got ${repairCalls.prompts.length}`)
  }
  if (repairCalls.prompts[0].mode !== 'queue') {
    throw new Error(`the automatic repair must queue, got mode ${repairCalls.prompts[0].mode}`)
  }
  if (buttonOf(host) !== null) {
    throw new Error('the announcement must replace the repair button, not sit beside it')
  }
  if (note.querySelector('button') !== null) {
    throw new Error('the announcement is a report, not a control — it must hold no interactive element')
  }
  await act(async () => { root.unmount() })
}

// 13n. A failure already in the log when the seat attaches is NOT a turn that
//      just broke: it is history being opened, or a page reloaded mid-failure.
//      Escalating there would swap the model and inject a prompt into a
//      conversation nobody had just run. The manual button still appears, since
//      a person looking at the failure can decide for themselves.
{
  const before = selections.length
  const { host, root } = await failoverMount(seedFallback, AGENT_FAILURE)
  console.log('pre-existing  : note=%s button=%s switched=%d',
    noteOf(host) === null ? 'none' : 'SHOWN',
    buttonOf(host) === null ? 'none' : 'shown',
    selections.length - before)
  if (noteOf(host) !== null) throw new Error('a failure found at attach must not auto-escalate')
  if (selections.length !== before) throw new Error('a failure found at attach must not switch the model')
  if (repairCalls.prompts.length !== 0) throw new Error('a failure found at attach must not send anything')
  if (buttonOf(host) === null) throw new Error('a failure found at attach must still offer the manual repair')
  await act(async () => { root.unmount() })
}

// 13o. A user pressing stop is not a failure. The turn is marked interrupted with
//      no error, and re-sending it would fight the person who asked it to stop.
{
  const before = selections.length
  const { host, root } = await liveMount(seedFallback, {
    snapshot: { promptError: null, lastAgentError: null, promptAttempted: true },
    interrupted: true,
    originalText: null,
  })
  console.log('user stop     : note=%s switched=%d prompts=%d',
    noteOf(host) === null ? 'none' : 'SHOWN', selections.length - before, repairCalls.prompts.length)
  if (noteOf(host) !== null) throw new Error('a user stop must never auto-escalate')
  if (selections.length !== before) throw new Error('a user stop must never switch the model')
  if (repairCalls.prompts.length !== 0) throw new Error('a user stop must never send anything')
  if (buttonOf(host) === null) throw new Error('a user stop must still offer the manual repair')
  await act(async () => { root.unmount() })
}

// 13p. Already on the fallback: escalating would switch a model to itself and
//      then re-trigger on the same failure. This is what stops a fallback that
//      is itself failing from looping.
{
  const before = selections.length
  const { host, root } = await failoverMount(seedFallback, CLEAN)
  await act(async () => {
    snapshot.current = { provider: 'zhipu', model: 'glm-4.6', reasoningEffort: 'high' }
    notify()
    await Promise.resolve()
  })
  repairState.snapshot = AGENT_FAILURE.snapshot
  repairState.interrupted = AGENT_FAILURE.interrupted
  repairState.originalText = AGENT_FAILURE.originalText
  await act(async () => { sessionNotify(); await Promise.resolve() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  console.log('on fallback   : note=%s switched=%d', noteOf(host) === null ? 'none' : 'SHOWN', selections.length - before)
  if (noteOf(host) !== null) throw new Error('a failure on the fallback itself must not escalate')
  if (selections.length !== before) throw new Error('a failure on the fallback itself must not switch')
  await act(async () => { root.unmount() })
}

// 13q. No fallback designated: the panel stays completely passive. An install
//      that never opted in must not have a model chosen for it.
{
  const before = selections.length
  const { host, root } = await liveMount({}, AGENT_FAILURE)
  console.log('no fallback   : note=%s switched=%d prompts=%d',
    noteOf(host) === null ? 'none' : 'SHOWN', selections.length - before, repairCalls.prompts.length)
  if (noteOf(host) !== null) throw new Error('without a designated fallback nothing may escalate')
  if (selections.length !== before) throw new Error('without a designated fallback nothing may switch')
  if (repairCalls.prompts.length !== 0) throw new Error('without a designated fallback nothing may be sent')
  await act(async () => { root.unmount() })
}

// 13r. The loop breaker is per-failure, not per-session. A failure that clears
//      must reopen the automatic path, or the first failure of a session would
//      be the only one ever rescued.
{
  const before = selections.length
  const { host, root } = await liveMount(seedFallback, AGENT_FAILURE)
  const afterFirst = selections.length
  if (afterFirst - before !== 1) throw new Error('precondition: the first failure must escalate')
  await act(async () => {
    snapshot.current = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }
    notify()
    await Promise.resolve()
  })
  await healThen({ snapshot: { promptError: null, lastAgentError: 'stream ended unexpectedly', promptAttempted: true }, interrupted: undefined, originalText: '再看一遍' })
  console.log('second failure: switched=%d prompts=%d', selections.length - before, repairCalls.prompts.length)
  if (selections.length - before !== 2) {
    throw new Error(`a failure after the session healed must escalate again, got ${selections.length - before} switches`)
  }
  if (repairCalls.prompts.length !== 2) {
    throw new Error(`the second failure must send its own repair, got ${repairCalls.prompts.length}`)
  }
  await act(async () => { root.unmount() })
}


console.log('INTERACTION OK')
