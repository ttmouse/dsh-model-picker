![The model picker, with two models favourited](screenshot.png)

[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-model-picker

Enhanced model picker for the dsh web GUI — replaces the composer's model seat
(`conversation.input.model`).

## Design

A **two-zone trigger button** splits model selection and reasoning-effort
selection into separate popups:

| Zone | Click | Popup content |
|------|-------|---------------|
| **Left** (model name) | Opens the model picker | Search box at top (auto-focused), provider column on the left, model list on the right |
| **Right** (effort) | Opens the effort picker | List of available reasoning-effort levels |

Hovering a zone names what it will act on. The model zone reads
`provider · model`: one model id is routinely served by several providers, so
the name alone does not say where the model runs. The supplier named is the
**display** one, so a selection on a folded `(modlens vision)` route still reads
as its base provider — the same name the user clicked in the column.

## Supplier chip

The supplier's leading character rides ahead of the model name — `D` for
DeepSeek, `智` for 智谱 GLM — on the **closed trigger** as well as on every row in
the list, so a model's source is legible before the picker is ever opened.

- The trigger's `max-width` (300px) leaves room for the chip's footprint (16px
  plus its gap) on top of the name budget, so wearing the chip costs the model
  name no characters. The effort zone is the part that yields when the composer
  row runs short: it shrinks and then ellipsises its label, because the model
  name is the primary information and the effort level is the secondary one.
- The chip names the **display** supplier, so a row served by a folded
  `(modlens vision)` route wears its base provider's chip rather than one of its
  own.
- Each supplier also gets a tint. Without it `17an-db`, `17an-anbot` and
  `17an-mumiao` would all show a bare `1` and read as one supplier.
- The tint is **chosen, not hashed**. A hue derived from the route id produced
  ten unrelated colours in one panel, gave neighbouring suppliers near-identical
  chips, and let the palette drift as providers were added. Each supplier now
  takes a hue from a fixed set by its position in the configured provider order,
  so a hue belongs to a supplier rather than to a moment in time.
- Every chip is held at the **same lightness and chroma** (OKLCH, hue varies
  only). No supplier shouts louder than another, and no supplier's chip can
  vanish into the panel the way a mid-blue one did under a fixed saturation.
  Only the chip carries the hue; the panel's one accent stays the check mark on
  the model in use.

## Provider folding

A provider whose name is another provider's name plus a trailing parenthesized
capability suffix folds into that base provider's row. modlens registers vision
as its own provider route (`DeepSeek (modlens vision)`), which would otherwise
put a near-duplicate row per provider in the column.

- Folding is **display-only**: every row keeps its models paired with the group
  that serves them, so picking a folded model still submits that model's own
  provider id.
- The suffix stays on the model name, and a folded model whose route differs
  from its row is labelled with that route, so the two are never confused.
- A suffixed provider whose base is absent keeps its own row.

## Model facts (context window / image input)

The browser catalog the seat reads (`ModelCatalogModel`) carries only
`id / name / description / reasoning` — **no** context window and **no** input
modalities. Both exist on the Host's `llm` service, so the host half
(`lib/host.js`) republishes them over one loopback route:

```
GET /api/model-picker/models
→ { ok: true, models: [{ provider, id, contextWindow?, input? }] }
```

- `resolveModel()` is the only source of `context: { contextWindow }`;
  `listModels()` is the cheaper source of `inputModalities`.
- One row per provider/model is isolated: a provider or model that throws is
  dropped, and a row carrying neither fact is omitted entirely.
- The snapshot is cached for 30s — the route never fans out per keystroke.
- The popup badges each row with a context chip (`1M`, `384K`) and an image
  glyph, joined on `provider/modelId`.
- **Vision.** A plain glyph means the model reads pixels itself. A glyph with a
  slash across it means the route accepts images only because modlens bridges
  them: the model still cannot see — modlens transcribes the image to text
  first. The `(modlens vision)` suffix is what tells the two apart.
- The slash, rather than a dimmed glyph, is deliberate. Fading the glyph to
  carry "this model cannot see" put it under the 3:1 floor for non-text
  graphics and erased the distinction entirely in greyscale. A shape difference
  survives low vision, greyscale and both themes; a lighter grey does not.
- The modlens suffix is *not* the general vision signal: modlens declines to
  wrap a model whose id already carries a vision marker, whose catalog
  declares image input, or that falls outside its configured families. A row
  with no suffix can therefore be natively vision-capable; the glyph, not the
  name, is the answer. With modlens disabled the folding and the bridge glyph
  are simply dormant — nothing is suffixed.
- Before the host half has been restarted the route 404s, so the context chip
  and native-vision glyph are missing until then.

## Grouped list (elevator)

The right column is always one grouped list: **Recent** (`最近使用` in a Chinese UI — the route history, pinned at the top once it has entries), **Favorites** (`收藏` — the starred models, another mirrored copy), then every provider's group. The left column is a table of contents to this list.

- Scrolling the right column highlights the left row for the section pinned at the list's top edge (scroll spy / elevator). The group headers are `position: sticky`, so the left row always matches the header you see.
- Clicking a left-column supplier jumps the list straight to that group — an instant landing, not an animated ride: the elevator is a table of contents, and the time spent travelling is time nobody asked for. During a search, clicking a supplier **narrows** the results instead (search facet).

## Recent

The panel opens on the models used lately, with **the route in use at the front** — so switching back to the previous model is one `Enter` away from opening the popup. Every history row names the provider serving it, because the group spans suppliers.

- What is recorded is **the current route the directory reports**, not the rows clicked in this popup: a switch made in this list, in the shipped `/model` popup, or by a session reopening on its own model all count as "used" — the history answers "what have I been using", not "what did I click in this panel".
- Keyed on the **route** (`provider/modelId`), deduplicated and fixed-length (6 entries): reusing a route only moves it to the front instead of taking a second slot.
- It lives in `localStorage` under `dsh.modelPicker.recent`, with the same conventions as the favorites. A route that is no longer configured (provider uninstalled, model retired) stays in storage but is **not rendered**: the record comes back with the provider, and the list never shows a model that is not there.
- An empty history shows neither the group nor its floor — a favorites group teaches that starring exists, a history has nothing to teach, so a first run looks exactly like the picker without one.

## Favorites

Every model row carries a `☆` / `★` toggle between the name and the fact strip. The row is itself a `<button>`, so the star stops its click from reaching it — favoriting a model must never also pick it — and it handles `Enter` / `Space` on its own.

- Favorited models appear **twice** in the list: once in their provider's group, and once in the favorites group pinned at the top of the list. A favorites row always names the provider serving it.
- Favorites are keyed on the **route** (`provider/modelId`), not the bare model id: one model id is routinely served by several configured providers, and favoriting one route says nothing about the others.
- They live in `localStorage` under `dsh.modelPicker.favorites`, the same place the shipped conversation plugin keeps its own view and width preferences. A storage refusal (private mode, full quota) is swallowed: the in-memory set still tracks the page.

## Configure official models

The popup carries one fixed row under its body: **Configure official models →
Settings · Models**. The picker can only list what the configured providers
offer — it cannot add the official DeepSeek route, sign the account in, or store
an API key — and the moment that page is needed is exactly when this panel is
open, so the panel is where the way to it belongs.

- The row is a direct child of the popup, **outside the scrolling list**: a row
  that scrolls away is a row the user cannot find when the models are missing.
  The body gives up its ~36px, never the row.
- It opens Settings **on the 模型 / Models section in one step**, not on whatever
  section was open last. The settings modal owns its open/active state, and
  publishes it through the store handle its `sidebar.settings` seat registers;
  the picker writes `openSection('models')` to that handle — the same state
  change a click on that nav row makes.
- A carrier whose settings seat carries no store falls back to running the
  panel's own `settings.open` command and then lighting its 模型 row, named by
  the label the `settings.section` ledger publishes (so the fallback follows the
  UI's locale instead of hard-coding a string).
- With neither — no settings UI in this deployment — the row does nothing rather
  than closing the picker onto an empty page. The picker closes only once the
  panel has actually opened.
- The hand-off is read through *this* plugin's own inject set (`slots`, plus the
  optional `shortcuts` service via `ctx.get`), never the caller's, and it can
  never throw into a click handler.

## Language

The panel is written in the **app's** language — the one the user picked in
Settings → General → Language — never in the browser's. A user who chose 中文
inside DSH gets 中文 here even when the browser reports `en-US`, and the reverse
holds too.

- The source chain is: the `locale` service (the actual preference, and the
  value every other surface reads) → `document.documentElement.lang` (the
  shell's own declaration of the language it is rendering, which the locale
  plugin rewrites on every switch) → `navigator.language` (the pre-boot default
  only). Each step is guarded, so a carrier missing one still gets a language.
- Switching the language re-renders the panel **while it is open**: the copy is
  read through a subscription to that source, so nothing waits for a reload or
  for the next open.
- The dictionary is deliberately small — two languages, one flat key set — so
  the panel never depends on a locale namespace being registered before it
  renders, and it cannot break the composer seat when one is missing.

## Search semantics

The query is a facet over **both** columns, not just the model list:

- A provider matches by its display name, its route id, or by having at least one matching model. The provider column narrows to the matching providers and each badge shows that provider's match count.
- With no provider selected, the model list spans every matching provider and labels each row with its provider.
- Clicking a provider during a search narrows the list to that provider without clearing the query. Typing a new query clears the previous provider facet.

Model and effort data ride the same per-session `ModelDirectory` as the `/model`
popup, so a switch in either surface is what the other shows next.

## Keyboard

The picker is search-first, so focus never leaves the search box: the popup is
drivable end to end without tabbing through rows. The caret is the whole focus
cue — the box keeps its resting border in every state, because it holds focus
for the panel's entire life and a lit border would read as a state to clear.

- The popup opens with the **cursor** already on the first row — the route used
  last; an empty group (no history yet, nothing starred) contributes no row, so
  it is skipped rather than stood on. The cursor is not the current model: the
  check mark reports what is in use, the cursor reports where the next `Enter`
  lands.
- `↑` / `↓` move one row, `PageUp` / `PageDown` ten, `Home` / `End` jump to the
  ends. The cursor holds at both ends instead of wrapping.
- `Enter` commits the cursor row and closes the popup, handing focus back to the
  trigger. Typing a new query puts the cursor back on the first match.
- The cursor is the hover surface and nothing else — no rail, no border. The
  list scrolls it into view, and `scroll-margin-top` keeps the sticky group
  header from covering the row it scrolled to.
- The search box names the cursor row in `aria-activedescendant`, so the
  position is announced even though DOM focus never moves.
- Favorites stay reachable: `Tab` to a row's star and press `Enter` / `Space` to
  toggle it without picking the model.

## Contrast and hierarchy

Every text element in the panel clears WCAG AA (4.5:1) **measured on painted
pixels**, not on declared colour values. The panel does not carry a second,
quieter grey: it uses the host's own `label-secondary` for metadata and separates
tiers by form instead (14px/500 for a model name, 12px/400 for a row detail,
11px/600 with `.06em` tracking for a group heading).

Three cheaper ways to get a "dimmer than body" ink were tried and rejected, all
of them measurable:

| Approach | Measured | Why it fails |
|---|---|---|
| `opacity: .6` on the element | 2.63:1, and 2.25:1 over a hover row | Composites against whatever is behind it, so one value yields several ratios; it also fades a glyph's anti-aliased edge as much as its body |
| `color-mix(… , transparent)` | 2.58:1 | Keeps an **alpha** channel instead of darkening, so every painted pixel is lighter than the ink it names |
| `color-mix(… , <panel surface>)` | 4.14:1 on a light hover row | The mix is relative to a surface, and in the light theme the hover row is *darker* than the panel, so the direction inverts |

`label-secondary` clears the floor on all four surfaces this panel can put text
on: 6.37:1 and 5.04:1 in the dark theme, 5.50:1 and 4.94:1 in the light one.

Two further decisions follow the same rule, that a state should be carried by
something other than a slight change in brightness:

- The checked image glyph is struck through, not dimmed (see **Vision** above).
- The selected provider row and the list's keyboard cursor use the same neutral
  surface. The panel's single accent is the check mark on the model in use; an
  accent-filled provider row made `--dsw-alias-brand-primary` (which resolves to
  near-white here) fight the glyph for the eye.

Motion is one chevron turn at 160ms on a strong ease-out curve, plus colour lifts
on press and hover. The turn is dropped under `prefers-reduced-motion`; the
colour changes stay, because they aid comprehension rather than being motion.

## Test

`npm test` runs both halves:

- `scripts/interaction.mjs` drives the browser half in jsdom through its real
  loader entry: opens the model popup, types provider and model names, asserts
  that both columns filter, that a provider facet keeps the query, that the
  popup opens with the keyboard cursor on the first row and walks it with
  `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End` until `Enter` commits it, and that the
  fact badges land on the rows the fact route describes. The history is asserted
  row by row as well: it records the route in use, moves a reused route to the
  front without duplicating it, stops at its cap, and leaves an unconfigured
  route in storage but out of the list. The fake context enforces cordis's
  `without inject` rule, so a missing service declaration fails the test instead
  of the live seat. It also asserts every icon is an **SVG**, never a text emoji
  or symbol character, in the closed trigger and in both popups, and that the
  search box declares no focus border — jsdom answers no `:focus` through
  `getComputedStyle`, so the stylesheet text is what this half can check. The settings
  hand-off is covered the same way: the footer sits outside the scroll area,
  clicking it writes `models` to the settings seat and closes the popup without
  picking a model, the no-store carrier falls back to the `settings.open` command
  plus the ledger's own nav label, and a carrier with no settings UI leaves the
  picker open. The language is asserted against an **English browser**: the copy
  must follow the app's declaration, an open panel must re-render when it
  changes, the `locale` service must outrank the document attribute, and a render
  that arrives with no locale source at all must still follow the document.
- `scripts/host-route.mjs` drives the real route handler with a stub `llm`:
  asserts the row shape, that a throwing provider/model is isolated, and that
  the 30s cache answers without re-listing.

**Icon alignment.** An inline `<svg>` sits on the text baseline, so the font's
descender space below it lifts the glyph above the centre of its own line box —
which is what knocks a chevron or a check mark off the text's horizontal line.
`.dsh-mp2-root svg{display:block}` removes that space, and each icon wrapper
centres its contents, so an icon's centre lands on the text's centre line.

`node scripts/probe.mjs` checks the real thing: it opens the running GUI
(`DSH_COOKIE_JAR`, default `/tmp/dsh-cj.txt`, holds an authenticated session
cookie), asserts the component mounted into the seat, opens the popup, measures
that the panel does not resize while the query narrows, and writes
`live-model-picker.png`.

`node scripts/verify-live.mjs` drives the running Web GUI with Playwright — it
forges the same signed browser-session cookie the host mints — and checks what
jsdom cannot: the cursor row's computed background, that the search box paints
its resting border rather than the accent one while it holds focus, that a
supplier click lands instead of animating, and that the footer's hand-off really
opens Settings on the Models section. It closes the panel again, so a run leaves
the session as it found it. It targets the `web` profile on `:3080` by default;
`DSH_LIVE_ORIGIN=http://127.0.0.1:19387` points it at the desktop app instead,
which serves its own installed copy of `lib/client.js` — a change has to be
carried into that profile before the run can see it.

`node scripts/screenshot.mjs` regenerates the README image. It stars two models
from different suppliers first — the favorites group is the feature a still image
has to show, and it is empty on a fresh browser profile — and refuses to write a
shot whose favorites group came out empty. Override the output with `SHOT_OUT`,
and the shell it photographs with `DSH_LIVE_ORIGIN` (same default and same reason
as `verify-live.mjs` above). It mints its own session cookie rather than reading
one from a file, and it shoots at a viewport tall enough to fit the whole popup:
the panel's height is clamped against the window, so a short window crops its
last rows mid-word.

## Slot

Injects into `conversation.input.model` (declared by
`@deepseek-ai/dsh-client-ui-conversation`).

## Inject contract

The seat is a **single** slot, so this entry shadows the shipped
`ModelSelect` — a registration that crashes leaves the composer with no model
control at all. cordis rebinds a service proxy's `this.ctx` to the **caller**,
so every face of `ctx.modelDirectories` (`directoryFor`, `load`, `select`) reads
`remote.session` through *this* plugin's inject set. The declaration is
therefore:

```js
const inject = ['slots', 'sessions', 'modelDirectories', 'remote', 'remote.session']
```

Dropping `remote` / `remote.session` throws
`cannot get property "remote.session" without inject` inside the seat's inject
factory; the entry abdicates and the enhanced picker never appears.
