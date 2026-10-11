// Browser half of dsh-model-picker v2. Loaded through the web plugin loader
// (window.__ModuleLoader__); React comes from the platform module table.
//
// Two-zone trigger button:
//   LEFT  (model label) → model picker popup (search-first)
//   RIGHT (effort label) → effort picker popup (standalone)
//
// Data rides the SAME per-session ModelDirectory as the /model popup
// (ctx.modelDirectories), so a switch made in either surface is what the
// other shows next.
window.__ModuleLoader__.load({ id: 'dsh-model-picker', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  const React = require('react')
  const { useState, useEffect, useRef, useMemo, useSyncExternalStore, Fragment } = React
  const h = React.createElement

  // --- Locale ---
  // The UI language is a *product* preference (Settings → General → Language),
  // not a browser fact: a user who picked 中文 inside DSH expects 中文 here even
  // when the browser reports en-US, and vice versa. The host pushes the choice
  // to the browser, so `document.documentElement.lang` — the attribute the
  // locale plugin keeps in step with the active language — is the one source
  // that is right by construction. `navigator.language` survives only as the
  // pre-boot fallback: before the shell sets `<html lang>`, the attribute is
  // whatever the served document carried.
  const STRINGS = {
    zh: {
      triggerFallback: '选择模型',
      search: '搜索模型或提供商…',
      loading: '加载中…',
      retry: '重试',
      noModels: '暂无可用的模型',
      providerEmpty: '该提供商暂无模型',
      noMatch: '没有匹配的模型',
      effortHeading: '推理层级',
      providerDefault: '提供方默认',
      selectFailed: '选择失败，请重试',
      selectFailedMsg: '选择失败：',
      providers: '提供商',
      allProviders: '全部提供商',
      contextWindow: '上下文窗口',
      favorites: '收藏',
      recent: '最近使用',
      favoritesEmpty: '还没有收藏的模型',
      favoriteAdd: '加入收藏',
      favoriteRemove: '取消收藏',
      imageNative: '支持图片输入（模型原生视觉）',
      imageBridged: '支持图片输入（modlens 桥接：模型看到的是转写文本，不是原图）',
      configureModels: '配置官方模型',
      configureModelsWhere: '设置 · 模型',
    },
    en: {
      triggerFallback: 'Select model',
      search: 'Search model or provider…',
      loading: 'Loading…',
      retry: 'Retry',
      noModels: 'No models available',
      providerEmpty: 'No models for this provider',
      noMatch: 'No matching models',
      effortHeading: 'Reasoning Effort',
      providerDefault: 'Provider default',
      selectFailed: 'Selection failed, retry',
      selectFailedMsg: 'Selection failed: ',
      providers: 'Providers',
      allProviders: 'All providers',
      contextWindow: 'Context window',
      favorites: 'Favorites',
      recent: 'Recent',
      favoritesEmpty: 'No favorite models yet',
      favoriteAdd: 'Add to favorites',
      favoriteRemove: 'Remove from favorites',
      imageNative: 'Accepts images (native vision)',
      imageBridged: 'Accepts images (modlens bridge: the model sees transcribed text, not the picture)',
      configureModels: 'Configure official models',
      configureModelsWhere: 'Settings · Models',
    },
  }

  /**
   * Resolve a language tag to one of this panel's dictionaries. Chinese
   * variants (`zh-CN`, `zh-Hans`, `zh-Hant`) all read the same copy; anything
   * else is English, matching the locale plugin's own `zh`/`en` catalog.
   * @param tag - a BCP 47-style tag, or anything else a carrier may report.
   * @returns the dictionary key.
   */
  function resolveLocale(tag) {
    return String(tag ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }

  /**
   * The UI language in force right now, as a raw tag.
   *
   * Three sources, in descending authority:
   *   1. the `locale` service — the preference the user picked in Settings →
   *      General → Language, and the value every other surface reads;
   *   2. `document.documentElement.lang` — the shell's own declaration of the
   *      language it is rendering, which the locale plugin keeps in step
   *      (including its `zh` → `zh-CN` spelling);
   *   3. the browser's language list — the pre-boot default only.
   *
   * `ctx` may be absent (module load) and either channel may be missing on a
   * carrier that is not the shipped shell, so every step is guarded.
   * @param ctx - a context that can reach the `locale` service, when there is one.
   * @returns the tag, or `undefined` when nothing can answer.
   */
  function localeTag(ctx) {
    try {
      const active = ctx?.get?.('locale')?.getSnapshot?.().active
      if (typeof active === 'string' && active !== '') return active
    } catch {
      // No locale service on this carrier: the document still declares one.
    }
    try {
      if (typeof document !== 'undefined' && document.documentElement?.lang) {
        return document.documentElement.lang
      }
    } catch {
      // A carrier without a document: fall through to the navigator.
    }
    try {
      return navigator.language || navigator.userLanguage
    } catch {
      return undefined
    }
  }

  // The dictionary every `t()` reads. Kept as module state because the copy is
  // read by small presentational components (ModelRow, EffortPopup, ModelFacts)
  // that take no locale prop; the picker sets it from the live source at the top
  // of each render, so the whole tree paints in one language.
  let APP_LOCALE = resolveLocale(localeTag())
  const t = (key) => STRINGS[APP_LOCALE][key] ?? STRINGS.en[key]

  /**
   * Watch the app's language. The `locale` service publishes a snapshot on every
   * switch; without one, the shell's `<html lang>` is the only observable, so
   * that attribute is watched instead.
   * @param ctx - a context that can reach the `locale` service, when there is one.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  function subscribeLocale(ctx, fn) {
    try {
      const locale = ctx?.get?.('locale')
      if (typeof locale?.subscribe === 'function') return locale.subscribe(fn)
    } catch {
      // Fall through to the document channel.
    }
    if (typeof document === 'undefined') return () => {}
    const Observer = document.defaultView?.MutationObserver ?? globalThis.MutationObserver
    if (typeof Observer !== 'function') return () => {}
    const observer = new Observer(fn)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    return () => { observer.disconnect() }
  }

  /**
   * The locale source a picker instance reads through. One stable object per
   * plugin activation, so `useSyncExternalStore` never churns its subscription.
   * @param ctx - the plugin's own context.
   * @returns the source pair.
   */
  function localeSource(ctx) {
    return {
      subscribe: (fn) => subscribeLocale(ctx, fn),
      getSnapshot: () => resolveLocale(localeTag(ctx)),
    }
  }

  /** The document-only source, for a render that arrives without one. */
  const FALLBACK_LOCALE = localeSource(undefined)

  // --- Styles ---
  const CSS = `
/* ───────── design tokens (this panel's own) ─────────
   Hierarchy in this panel is carried by SIZE, WEIGHT and TRACKING. Colour is not
   asked to do the work, and the reason is measured rather than stylistic.

   The obvious move is a "dimmer than body" ink. Every cheap way to get one was
   tried and rejected, on real painted pixels:

   - \`opacity:.6\` on the element. It composites against whatever is behind, so one
     value gave 3.19:1 on the panel and less on a hover row.
   - \`color-mix(in srgb, <ink> N%, transparent)\`. This keeps an ALPHA channel
     instead of darkening the colour, so every pixel paints lighter than the ink
     it names. Measured 2.58:1, worse than the opacity it replaced.
   - \`color-mix(in srgb, <ink> N%, <panel surface>)\`. Correct in the dark theme,
     but the mix is relative to the surface, and in the LIGHT theme the hover row
     is DARKER than the panel. That value measured 4.14:1 on a light hover row.

   So the metadata ink is the host's own \`label-secondary\`, which is theme-aware
   by construction and clears 4.5:1 everywhere this panel can put text:

     dark  panel 6.47:1   dark hover 5.04:1
     light panel 5.50:1   light hover 4.94:1

   With colour taken out of the hierarchy, the tiers are told apart by form:
   14px/500 primary for a model name, 12px/400 for a row's detail line, 11px/600
   with .06em tracking and uppercase for a group heading. */
.dsh-mp2-root{
  /* The panel surface, resolved once: --dsw-specific-menu is translucent
     (#43454a73) and every surface in here must be opaque. Declaring it on the
     root means the sticky headers and the ink below all resolve against the
     same colour, so no seam can appear where a header meets the list. */
  --dsh-mp2-surface:rgb(from var(--dsw-specific-menu) r g b / 1);
  --dsh-mp2-ink-dim:var(--dsw-alias-label-secondary);
  --dsh-mp2-ease-out:cubic-bezier(0.23,1,0.32,1);
  --dsh-mp2-radius-control:8px;
  --dsh-mp2-radius-row:10px;
  --dsh-mp2-radius-panel:12px;
}

/* ───────── root + trigger (two-zone) ───────── */
/* The label zone is sized by its content and shrinks only when the composer
   row runs out of space, so the model name stays readable. */
.dsh-mp2-root{position:relative;min-width:0;display:inline-flex}
/* max-width leaves room for the supplier chip (16px + 4px gap) on top of the
   model name budget, so wearing the chip never costs the name a character.
   240px was measured to clip the name to "DeepSeek …" while the effort zone
   kept its full label: the primary information lost to the secondary one. The
   budget is 300px, and the effort zone yields first (see below). */
.dsh-mp2-trigger{display:flex;align-items:stretch;min-width:0;max-width:300px;height:30px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;cursor:pointer;overflow:hidden;padding:0}
.dsh-mp2-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mp2-trigger:focus-within{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-mp2-triggerLocked{color:var(--dsw-alias-label-dimmed)}
.dsh-mp2-triggerLeft{display:flex;align-items:center;gap:4px;min-width:0;flex:0 1 auto;padding:0 2px 0 8px;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;overflow:hidden;transition:background-color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-triggerLeft:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dsh-mp2-triggerLeft:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-radius:24px 0 0 24px}
.dsh-mp2-triggerLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mp2-triggerDivider{width:1px;flex:0 0 auto;background:var(--dsw-alias-border-l3)}
/* The effort zone is the one part of the trigger that may be sacrificed: it is
   secondary to the model name, so it shrinks and then clips its label, while
   the name keeps the room it needs. */
.dsh-mp2-triggerRight{display:flex;align-items:center;gap:2px;flex:0 1 auto;min-width:0;padding:0 6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:20px;cursor:pointer;transition:background-color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-triggerRight>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mp2-triggerRight:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-radius:0 24px 24px 0}
.dsh-mp2-triggerRight:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
/* Icons are block-level inside their wrapper. An inline <svg> sits on the text
   baseline, so the font's descender space below it pushes the glyph above the
   centre of its own line box — which is what knocked the trigger chevron and
   the row check marks off the text's horizontal line. */
.dsh-mp2-root svg{display:block}
/* The chevron is the only thing in this panel that turns; it reports which of
   the two zones is open, so it is feedback, not decoration. 120ms on the
   browser's built-in \`ease\` reads as a snap with no legible middle; 160ms on a
   strong ease-out curve lands. */
.dsh-mp2-chevron{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-caption);transition:transform 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-chevronOpen{transform:rotate(180deg)}

/* ───────── menu containers ───────── */
/* A fixed height, not a max-height: the popup is anchored above the composer,
   so a content-sized box makes the whole panel jump every keystroke as the
   result set narrows. The body scrolls instead. The clamp keeps it inside the
   space above the composer (the tool row sits ~340px up in the hero layout)
   and never lets a short window collapse it to nothing. */
/* \`--dsw-specific-menu\` is a translucent token (#43454a73). The panel must be
   opaque, and the app's own menus reach opacity by declaring the token as a
   solid at the point of use. Both the panel and its sticky headers therefore
   resolve it against the base layer once, into a local token, instead of each
   writing \`rgb(from … / 1)\`: a sticky header that resolved it separately from
   the list it covers would show a seam where they meet. */
.dsh-mp2-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:20;display:flex;flex-direction:column;width:min(540px,calc(100vw - 32px));height:clamp(220px,calc(100vh - 340px),400px);overflow:hidden;padding:4px;border:1px solid var(--dsw-alias-border-inverted);border-radius:var(--dsh-mp2-radius-panel);background:var(--dsh-mp2-surface);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
/* The effort list is short and has no search box, so it stays content-sized. */
.dsh-mp2-menuEffort{width:min(280px,calc(100vw - 32px));height:auto;max-height:min(260px,calc(100vh - 340px))}

/* ───────── search ───────── */
/* No focus ring. The panel opens with the caret already in this box and keeps
   it there while the arrow keys drive the list, so an accent border would be
   lit for the whole life of the popup — it reads as a state to clear rather
   than as focus. The caret is the cue; the field keeps its resting border.

   The field sits one layer *below* the panel rather than above it: it was
   drawn in \`bg-layer-2\` at a taller weight than any row, so it read as the
   panel's subject and the list as its footnote. Recessed and the same weight
   as the rows, the list becomes the subject again. */
.dsh-mp2-search{flex:0 0 auto;margin:4px 4px 6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-inverted);border-radius:var(--dsh-mp2-radius-control);outline:none;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;transition:border-color 160ms var(--dsh-mp2-ease-out)}
/* The caret is the focus cue, but a pointer user needs the field to answer a
   hover: the border lifts one step, nothing else moves. */
.dsh-mp2-search:hover{border-color:var(--dsw-alias-border-l3)}
.dsh-mp2-search::placeholder{color:var(--dsw-alias-label-tertiary)}

/* ───────── body (provider tabs + model list) ───────── */
.dsh-mp2-body{display:flex;flex:1;min-height:0;gap:4px}
/* 150px clipped five of nine supplier names ("OpenCode Go (常用)",
   "qwen-token-plan-cn") while spending width on the count badge. 168px plus a
   tighter badge puts the longest configured name on one line. */
.dsh-mp2-providers{flex:0 0 178px;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:2px 4px 2px 2px}
/* 30px was measured out of step with the 38px rows facing it: the two columns
   read as two lists rather than one table. 34px puts eight floors on the same
   vertical pitch as eight rows. */
.dsh-mp2-provider{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:0 8px;border:none;border-radius:var(--dsh-mp2-radius-control);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:left;cursor:pointer;transition:background-color 160ms var(--dsh-mp2-ease-out),color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-provider:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* The active floor is named by weight and ink, not by an accent fill: the
   panel's only accent is the check mark that reports the live model, and a
   second loud surface here would compete with it. */
.dsh-mp2-providerActive{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
/* Both columns' headings take the same 11px/600/tracked uppercase cut, so the
   left floor list and the right group headers read as one system. */
.dsh-mp2-paneCaption{padding:10px 8px 6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsh-mp2-ink-dim)}
.dsh-mp2-providerName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The count yields to the name: it shrinks, and clips, before the label it
   annotates loses a character. The name always wins the row. */
.dsh-mp2-providerCount{flex:0 1 auto;min-width:0;overflow:hidden;padding:0 4px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsh-mp2-ink-dim);font-size:11px;line-height:16px;text-align:right;font-variant-numeric:tabular-nums}
/* Supplier group in the model list. The header is a section label, deliberately
   unlike a model row (14px/500 on a rounded hover surface): tracked-out
   uppercase, dimmed, and pinned to the top of the list while its group scrolls. */
/* Rows are separated by a hairline gap rather than by their hover surface
   alone. The surfaces are filled rounded rects that touch edge to edge, so two
   adjacent highlighted rows used to fuse into a single block and read as one
   control. */
.dsh-mp2-group{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-mp2-group:first-child{border-top:none}
.dsh-mp2-groupHeader{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:5px;padding:10px 8px 4px;background:var(--dsh-mp2-surface);color:var(--dsh-mp2-ink-dim);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.dsh-mp2-groupHeaderIcon{flex:0 0 auto;display:inline-flex}

/* ───────── model list ───────── */
.dsh-mp2-list{position:relative;flex:1;min-width:0;min-height:0;overflow-y:auto;border-left:1px solid var(--dsw-alias-border-l1);padding:0 2px 2px 4px}
.dsh-mp2-status,.dsh-mp2-empty{padding:10px 8px;color:var(--dsh-mp2-ink-dim);font-size:13px;line-height:20px}
.dsh-mp2-error,.dsh-mp2-warning{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin:4px 2px;padding:7px 8px;border-radius:var(--dsh-mp2-radius-control);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsh-mp2-warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}
.dsh-mp2-retry{flex:0 0 auto;padding:0;border:none;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
/* The heading's height plus a beat: \`scroll-margin-top\` has to clear the
   sticky header or the cursor lands under it. The header is nowrap, but a long
   provider name in the Chinese locale can still wrap, so the margin is set
   from the measured worst case rather than the common one. */
.dsh-mp2-option{--dsh-mp2-chip-size:16px;--dsh-mp2-chip-gap:4px;display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:6px 8px;border:none;border-radius:var(--dsh-mp2-radius-row);outline:none;background:transparent;color:inherit;text-align:left;cursor:pointer;scroll-margin-top:38px;scroll-margin-bottom:4px;transition:background-color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-option:hover:not(:disabled),.dsh-mp2-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
/* The keyboard cursor. Focus stays in the search box, so the row the arrow
   keys stand on has to say so by itself — the hover surface marks it, and
   nothing else does. It is deliberately separate from the check mark, which
   reports the model actually in use. */
.dsh-mp2-optionActive:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mp2-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
/* Press feedback. Rows and floors are the two things a pointer hits fastest,
   and neither had an \`:active\` state: the panel took the press silently. */
.dsh-mp2-option:not(:disabled):active,.dsh-mp2-provider:active,.dsh-mp2-footerAction:active{transform:scale(0.985)}
.dsh-mp2-option,.dsh-mp2-provider,.dsh-mp2-footerAction{transform-origin:center}
.dsh-mp2-optionCopy{display:flex;flex:1;flex-direction:column;min-width:0}
.dsh-mp2-modelName{overflow:hidden;color:inherit;font-size:14px;line-height:20px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
/* The detail line lines up with the model name, not with the chip: the chip is
   a marker ahead of the name, so the two text lines share one left edge. The
   indent is derived from the chip's own size, so it cannot drift from it. */
.dsh-mp2-description{overflow:hidden;padding-left:calc(var(--dsh-mp2-chip-size,16px) + var(--dsh-mp2-chip-gap,4px));color:var(--dsh-mp2-ink-dim);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
/* The check column exists only on the row that is actually in use. Reserving its
   18px on every row took the space a long model name needed before the name had
   used it; an unselected row now gives that width back to the label. */
.dsh-mp2-check{flex:0 0 18px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}
.dsh-mp2-option:not(.dsh-mp2-selected) .dsh-mp2-check{flex-basis:0;width:0}

/* ───────── per-row facts (context window / image input) ───────── */
.dsh-mp2-facts{display:flex;flex:0 0 auto;align-items:center;gap:5px;color:var(--dsh-mp2-ink-dim);font-size:11px;line-height:16px}
.dsh-mp2-context{flex:0 0 auto;padding:0 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mp2-image{display:inline-flex;flex:0 0 auto;align-items:center;color:var(--dsh-mp2-ink-dim)}
/* Bridged vision: the route accepts images, but the model reads a transcript.
   The dimming *is* the meaning — "this model cannot see" — so it cannot be
   carried by an opacity that drops the glyph under the 3:1 floor for
   non-text graphics. The glyph is drawn at full ink and struck through
   instead: the difference survives low vision, greyscale and both themes,
   where a lighter grey does not. */
.dsh-mp2-imageBridged{color:var(--dsh-mp2-ink-dim)}
.dsh-mp2-imageBridged svg{position:relative}
/* The favorite toggle sits between the name and the fact strip. It is an
   affordance on every row, not decoration, so it rests at legible ink and
   answers hover by *raising contrast* rather than by being dim until hovered:
   an undiscoverable control is worse than a quiet one. */
/* The star draws at its text size but carries a 24px hit area, marked by a
   ::before overlay rather than by the element's own box. Widening the box itself
   cost the row 6px of name width and clipped "DeepSeek V4.1 Flash · routing
   group"; an overlay enlarges the target without taking layout space. */
.dsh-mp2-star{position:relative;flex:0 0 auto;display:inline-flex;align-items:center;font-size:13px;line-height:1;padding:0 2px;color:var(--dsh-mp2-ink-dim);cursor:pointer;transition:color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-star::before{content:'';position:absolute;top:50%;left:50%;width:24px;height:24px;transform:translate(-50%,-50%)}
.dsh-mp2-star:hover{color:var(--dsw-alias-label-primary)}
.dsh-mp2-starOn{color:var(--dsw-alias-state-warn-primary,currentColor)}
/* Name + star share one flex row so the toggle sits right after the label. */
.dsh-mp2-nameRow{display:inline-flex;align-items:center;gap:var(--dsh-mp2-chip-gap,4px)}
/* The supplier's leading character, ahead of the model name.

   The tint is NOT a rainbow. It used to be \`hsl(hash(id) % 360 55% 50% / .18)\`,
   which put ten unrelated hues in one panel and, worse, made hue carry meaning
   it cannot carry: \`17an-db\`, \`17an-anbot\` and \`17an-mumiao\` all render the
   glyph \`1\`, so the hue was the only thing telling them apart, and it was
   assigned by a string hash. A supplier's hue is chosen deliberately (below)
   and held far enough down that the chip reads as a muted label, not a swatch:
   the panel has one accent, and it is the check mark on the live model. */
/* Only the tint carries the supplier's hue; the glyph takes the surrounding
   ink, so it is dark on a light theme and light on a dark one. A per-hue glyph
   colour was tried and removed: a light tint of the hue is legible on the dark
   theme and invisible on the light one, which is exactly the theme nobody
   checks. Spacing comes from the row's gap, not from a margin here. */
.dsh-mp2-avatar{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:var(--dsh-mp2-chip-size,16px);height:var(--dsh-mp2-chip-size,16px);border-radius:5px;background:var(--dsh-mp2-chip-bg,color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent));color:inherit;font-size:10px;line-height:1;font-weight:600;text-transform:uppercase}
/* A locked trigger dims as a whole, tint included. */
.dsh-mp2-triggerLocked .dsh-mp2-avatar{opacity:.5}

/* ───────── effort popup ───────── */
.dsh-mp2-effortList{padding:2px;overflow-y:auto;flex:1}
/* The effort popup and the model popup open from the same trigger, so they
   cannot each wear their own heading: this takes the model panel's group-header
   cut (11px/600/tracked uppercase) verbatim. */
.dsh-mp2-effortHeader{padding:10px 8px 4px;color:var(--dsh-mp2-ink-dim);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;flex:0 0 auto}

/* ───────── footer: the way out to Settings → Models ───────── */
/* One fixed row under the scrolling body, not inside it: the picker can only
   list what the configured providers offer, and the moment the official models
   are missing is exactly when the panel is open and the user is looking for
   them. The body gives up these ~36px, never the row. */
.dsh-mp2-footer{flex:0 0 auto;display:flex;margin:4px 2px 0;padding-top:5px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-mp2-footerAction{display:flex;align-items:center;gap:6px;width:100%;min-height:32px;padding:0 8px;border:none;border-radius:var(--dsh-mp2-radius-control);outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;transition:background-color 160ms var(--dsh-mp2-ease-out),color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-footerAction:hover,.dsh-mp2-footerAction:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mp2-footerLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Names the surface this row leaves for, so the label alone never has to. */
.dsh-mp2-footerWhere{flex:0 0 auto;color:var(--dsh-mp2-ink-dim);font-size:11px;line-height:16px}

/* ───────── reduced motion ─────────
   The panel's motion is one chevron turn and a set of colour/border lifts.
   Under a reduced-motion preference the turn is dropped; the colour lifts
   stay, because they aid comprehension and are not motion. */
@media (prefers-reduced-motion: reduce){
  .dsh-mp2-chevron{transition:none}
  .dsh-mp2-option,.dsh-mp2-provider,.dsh-mp2-footerAction{transition:none}
  .dsh-mp2-option:not(:disabled):active,.dsh-mp2-provider:active,.dsh-mp2-footerAction:active{transform:none}
}
`

  // ─── Runtime model facts ───
  // The catalog this seat reads carries id / name / description / reasoning
  // only — no context window and no input modalities. The host half
  // republishes both from the Host `llm` service at this loopback route, so
  // the popup badges each row without a round trip per model. One fetch per
  // page load, shared by every popup instance; a missing route (older host
  // half, non-web carrier) simply yields no badges.
  const FACTS_ROUTE = '/api/model-picker/models'

  let factsPromise = null
  function loadFacts() {
    if (factsPromise !== null) return factsPromise
    factsPromise = fetch(FACTS_ROUTE, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const map = new Map()
        for (const row of body?.models ?? []) map.set(row.provider + '/' + row.id, row)
        return map
      })
      .catch(() => new Map())
    return factsPromise
  }

  // ─── Favorites ───
  // Favorites are a browser-local UI preference, so they live in localStorage
  // under a `dsh.`-prefixed key — the same place the shipped conversation
  // plugin keeps its own view and width preferences. They are keyed on the
  // route (`provider/modelId`), not the bare model id, because one model id is
  // routinely served by several configured providers and favoriting one route
  // says nothing about the others.
  const FAVORITES_KEY = 'dsh.modelPicker.favorites'
  // The route history, same storage and the same `provider/modelId` keying as
  // the favorites, so one model served by several providers keeps one entry per
  // route. Most recent first, capped: the group is a shortcut, not an archive.
  const RECENT_KEY = 'dsh.modelPicker.recent'
  /** How many routes the history keeps. */
  const RECENT_LIMIT = 6
  /** Left-column row ids that are not providers. */
  const ALL_TAB = '__all__'
  const FAVORITES_TAB = '__favorites__'
  const RECENT_TAB = '__recent__'

  /** @returns the favorited `provider/modelId` keys; empty when storage is unusable. */
  function readFavorites() {
    if (typeof localStorage === 'undefined') return new Set()
    try {
      const raw = localStorage.getItem(FAVORITES_KEY)
      if (raw === null) return new Set()
      const stored = JSON.parse(raw)
      if (!Array.isArray(stored)) return new Set()
      return new Set(stored.filter((key) => typeof key === 'string'))
    } catch {
      return new Set()
    }
  }

  /** Persist the favorites. A storage refusal must not break the picker. */
  function writeFavorites(favorites) {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]))
    } catch {
      // Private mode or a full quota: the in-memory set still tracks this page.
    }
  }

  /**
   * The route history, most recent first.
   *
   * Entries whose route is no longer configured stay in storage — a provider
   * that comes back brings its rows back — but they are filtered out of the
   * rendered group, so a stale key can never show a model that is not there.
   * @returns the stored keys; empty when storage is unusable.
   */
  function readRecent() {
    if (typeof localStorage === 'undefined') return []
    try {
      const raw = localStorage.getItem(RECENT_KEY)
      if (raw === null) return []
      const stored = JSON.parse(raw)
      if (!Array.isArray(stored)) return []
      return stored.filter((key) => typeof key === 'string').slice(0, RECENT_LIMIT)
    } catch {
      return []
    }
  }

  /** Persist the history. A storage refusal must not break the picker. */
  function writeRecent(recent) {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
    } catch {
      // Private mode or a full quota: the in-memory list still tracks this page.
    }
  }

  /** Compact token count: 1000000 → "1M", 384000 → "384K". */
  function formatContext(tokens) {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
    if (tokens >= 1000000) return String(Number((tokens / 1000000).toFixed(1))) + 'M'
    return Math.round(tokens / 1000) + 'K'
  }

  // ─── Icons ───
  // Lucide (https://lucide.dev, ISC licence), inlined as paths on its 24×24
  // grid and stroked with `currentColor`. No icon font, no emoji, no runtime
  // dependency: the glyphs stay crisp at 13px and follow the theme tokens.
  const ICONS = {
    // Lucide `star`.
    star: [['path', { d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z' }]],
    // The same outline, filled — a favorited row.
    starFilled: [['path', { d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z', fill: 'currentColor', strokeWidth: 1 }]],
    // Lucide `check`.
    check: [['path', { d: 'M20 6 9 17l-5-5' }]],
    // Lucide `chevron-down`.
    chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
    // Lucide `clock` — the history group's heading, so it does not wear the
    // supplier glyph its `building` neighbours use.
    clock: [
      ['circle', { cx: 12, cy: 12, r: 10 }],
      ['polyline', { points: '12 6 12 12 16 14' }],
    ],
    // Lucide `building`.
    building: [
      ['rect', { x: 4, y: 2, width: 16, height: 20, rx: 2 }],
      ['path', { d: 'M9 22v-4h6v4' }],
      ['path', { d: 'M8 6h.01' }],
      ['path', { d: 'M16 6h.01' }],
      ['path', { d: 'M12 6h.01' }],
      ['path', { d: 'M12 10h.01' }],
      ['path', { d: 'M12 14h.01' }],
      ['path', { d: 'M16 10h.01' }],
      ['path', { d: 'M16 14h.01' }],
      ['path', { d: 'M8 10h.01' }],
      ['path', { d: 'M8 14h.01' }],
    ],
    // Lucide `image`.
    image: [
      ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
      ['circle', { cx: 9, cy: 9, r: 2 }],
      ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }],
    ],
    // Lucide `settings` — the footer row leaves for the configuration surface.
    settings: [
      ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
      ['circle', { cx: 12, cy: 12, r: 3 }],
    ],
    // Lucide `arrow-up-right` — the row hands the user to another surface.
    external: [
      ['path', { d: 'M7 7h10v10' }],
      ['path', { d: 'M7 17 17 7' }],
    ],
  }

  /** Render one {@link ICONS} entry at `size` px, inheriting the current colour. */
  function icon(name, size) {
    return h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
      strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false',
    }, ICONS[name].map(([tag, props], index) => h(tag, { key: index, ...props })))
  }

  const IMAGE_GLYPH = icon('image', 13)

  /**
   * The bridged-vision glyph: the same image icon with a slash across it.
   *
   * The two vision states are a real capability difference (see `imageBridged`),
   * and the old design carried it with `opacity:.5` alone, which dropped the
   * glyph under the 3:1 floor for non-text graphics and vanished in greyscale.
   * Drawing the slash makes the state a shape, so it reads at any contrast. */
  const IMAGE_GLYPH_BRIDGED = h('svg', {
    width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false',
  },
    ICONS.image.map(([tag, props], index) => h(tag, { key: index, ...props })),
    h('line', { key: 'slash', x1: 3, y1: 3, x2: 21, y2: 21 }),
  )

  /**
   * The tint for a supplier's chip.
   *
   * Two providers whose leading characters collide — `17an-db`, `17an-anbot`
   * and `17an-mumiao` all start with `1` — need a second signal, so the chip
   * stays. What does NOT work is deriving that signal from a hash of the id:
   * that put ten unrelated hues in one panel, gave neighbouring suppliers
   * near-identical chips, and let the hue wander as providers were added.
   *
   * Instead a supplier gets a hue from a fixed, hand-picked set, assigned by
   * its position in the configured provider order. Chroma and lightness are
   * held equal (OKLCH at L .55 / C .09), so no supplier shouts louder than
   * another and every chip sits at the same distance from the panel. The set
   * is kept small and evenly spaced, so no two adjacent suppliers look alike.
   *
   * @param id - the supplier's route id, stable across sessions.
   * @param order - the configured provider ids, which fixes each id's slot.
   */
  const CHIP_HUES = [212, 160, 32, 292, 258, 96, 340, 190]

  function providerHue(id, order) {
    const at = order.indexOf(id)
    // An unlisted supplier (a route that arrived after this render) gets the
    // neutral chip rather than a hue that would move the next time it renders.
    if (at === -1) return null
    return CHIP_HUES[at % CHIP_HUES.length]
  }

  /**
   * The supplier's leading character, for the row's avatar chip. Taken by code
   * point so a name starting outside the BMP is not cut in half.
   */
  function providerInitial(name) {
    const [first] = name.trim()
    return first === undefined ? '?' : first.toUpperCase()
  }

  /**
   * The supplier chip: its leading character on its own tint. Rendered both
   * ahead of a model name in the list and on the closed trigger, so the source
   * is legible before the picker is opened. The glyph carries no meaning to a
   * screen reader — the supplier is already named in the tooltip and the row
   * detail — so it is hidden from the accessibility tree.
   */
  function supplierChip(provider, order) {
    const hue = providerHue(provider.id, order)
    // Fixed L and C, hue only: every chip sits at the same distance from the
    // panel, so the set reads as one family rather than as ten colours. The
    // glyph colour is left to CSS (`color:inherit`), because a per-hue ink has
    // to be light for the dark theme and dark for the light one.
    const style = hue === null
      ? undefined
      : {
        '--dsh-mp2-chip-bg': `oklch(0.55 0.12 ${hue} / 0.22)`,
      }
    return h('span', {
      className: 'dsh-mp2-avatar',
      style,
      'aria-hidden': true,
    }, providerInitial(provider.name))
  }

  /**
   * The row's fact strip: vision glyph + context-window chip.
   *
   * Vision has two states that are NOT the same capability: a route whose
   * model reads pixels itself (native), and a modlens bridge route, where the
   * model still cannot see — modlens transcribes the image to text first.
   * `bridged` marks the second, so the glyph can say which.
   */
  function ModelFacts({ facts, bridged }) {
    const context = formatContext(facts?.contextWindow)
    const image = bridged || (Array.isArray(facts?.input) && facts.input.includes('image'))
    if (!image && context === null) return null
    return h('span', { className: 'dsh-mp2-facts' },
      image && h('span', {
        className: 'dsh-mp2-image' + (bridged ? ' dsh-mp2-imageBridged' : ''),
        title: bridged ? t('imageBridged') : t('imageNative'),
      }, bridged ? IMAGE_GLYPH_BRIDGED : IMAGE_GLYPH),
      context !== null && h('span', { className: 'dsh-mp2-context', title: t('contextWindow') }, context),
    )
  }

  /**
   * One selectable model row: name, favorite toggle, fact strip, check mark.
   *
   * The row is a `<button>`, so the star is a focusable span that stops the
   * click from reaching it — clicking a star must never also pick the model.
   */
  function ModelRow({ id, group, provider, model, detail, selected, active, busy, favorite, facts, bridged, order, onToggle, onChoose }) {
    const label = favorite ? t('favoriteRemove') : t('favoriteAdd')
    // The chip names the *display* supplier, so a folded `(modlens vision)` row
    // wears the same chip as its siblings under the base provider's heading.
    const chip = provider ?? group
    return h('button', {
      id,
      type: 'button',
      role: 'menuitemradio',
      'aria-checked': selected,
      className: 'dsh-mp2-option' + (selected ? ' dsh-mp2-selected' : '') + (active ? ' dsh-mp2-optionActive' : ''),
      disabled: busy,
      onClick: onChoose,
    },
      h('span', { className: 'dsh-mp2-optionCopy' },
        h('span', { className: 'dsh-mp2-nameRow' },
          supplierChip(chip, order),
          h('span', { className: 'dsh-mp2-modelName' }, model.name),
          h('span', {
            className: 'dsh-mp2-star' + (favorite ? ' dsh-mp2-starOn' : ''),
            role: 'button',
            tabIndex: 0,
            'aria-pressed': favorite,
            'aria-label': label + '：' + model.name,
            title: label,
            onClick: (event) => { event.stopPropagation(); onToggle() },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              onToggle()
            },
          }, icon(favorite ? 'starFilled' : 'star', 14)),
        ),
        detail !== undefined && detail !== '' && h('span', { className: 'dsh-mp2-description' }, detail),
      ),
      h(ModelFacts, { facts, bridged, reasoning: model.reasoning }),
      h('span', { className: 'dsh-mp2-check' }, selected && icon('check', 14)),
    )
  }

  // ─── Helper: render one effort list popup ───
  function EffortPopup({ reasoning, effectiveEffort, effortChoices, busy, chooseEffort, close }) {
    if (reasoning === undefined || effortChoices.length === 0) {
      return h('div', { className: 'dsh-mp2-menu dsh-mp2-menuEffort', role: 'menu', tabIndex: -1,
        onMouseDown: (e) => { e.preventDefault() } },
        h('div', { className: 'dsh-mp2-empty' }, t('providerDefault')),
      )
    }
    return h('div', { className: 'dsh-mp2-menu dsh-mp2-menuEffort', role: 'menu', tabIndex: -1,
      onMouseDown: (e) => { e.preventDefault() } },
      h('div', { className: 'dsh-mp2-effortHeader' }, t('effortHeading')),
      h('div', { className: 'dsh-mp2-effortList' },
        effortChoices.map((level) => h('button', {
          key: level.key,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': effectiveEffort === level.effort,
          className: 'dsh-mp2-option' + (effectiveEffort === level.effort ? ' dsh-mp2-selected' : ''),
          disabled: busy,
          title: level.description,
          onClick: () => { chooseEffort(level.effort) },
        },
          h('span', { className: 'dsh-mp2-optionCopy' },
            h('span', { className: 'dsh-mp2-modelName' }, level.label),
            level.description !== undefined && h('span', { className: 'dsh-mp2-description' }, level.description),
          ),
          h('span', { className: 'dsh-mp2-check' }, effectiveEffort === level.effort ? icon('check', 14) : ''),
        )),
      ),
    )
  }

  /** A provider name that is another provider's name plus a "(…)" capability suffix. */
  const CAPABILITY_SUFFIX = /^(.*?)\s*\([^()]*\)$/
  /** A provider route modlens mints to bridge images to a text-only model. */
  const VISION_ROUTE = /\(modlens vision\)/i

  /**
   * Fold capability-suffixed providers into their base provider for display.
   * Each entry keeps `{ group, model }` pairs so a pick still submits the group
   * that serves the model; only the column rows are merged.
   * @param groups - the directory's provider groups, in host order.
   * @returns display rows, ordered by each base provider's first appearance.
   */
  function mergeProviders(groups) {
    const byName = new Map(groups.map((group) => [group.name, group]))
    const rowIdOfGroup = new Map()
    for (const group of groups) {
      const suffix = CAPABILITY_SUFFIX.exec(group.name)
      const base = suffix === null ? undefined : byName.get(suffix[1])
      rowIdOfGroup.set(group.id, base !== undefined && base !== group ? base.id : group.id)
    }
    const rows = []
    const byId = new Map()
    for (const group of groups) {
      const id = rowIdOfGroup.get(group.id)
      let row = byId.get(id)
      if (row === undefined) {
        const base = groups.find((candidate) => candidate.id === id) ?? group
        row = { id, name: base.name, models: [] }
        byId.set(id, row)
        rows.push(row)
      }
      for (const model of group.models) row.models.push({ group, model })
    }
    return rows
  }

  /**
   * The section owning a scroll offset — the last one whose top edge has
   * passed the list's own top edge. With sticky headers that is exactly the
   * heading currently pinned, so it is the floor the list is standing on.
   * @param floors - `{ id, top }` per section, in list order.
   * @param scrollTop - the list's current scroll offset.
   * @returns the owning section id, or null for an empty list.
   */
  function floorAt(floors, scrollTop) {
    let current = null
    for (const floor of floors) {
      if (floor.top > scrollTop + 1) break
      current = floor.id
    }
    return current
  }

  // ─── The way out to the models configuration ───
  // The picker lists what the configured providers offer; it cannot add the
  // official DeepSeek route, sign the account in, or store an API key. The one
  // surface that can is Settings → 模型, and the moment that page is needed is
  // exactly when this panel is open, so its footer hands the user over.
  //
  // The settings modal owns its own open/active state: the seat it registers
  // into `sidebar.settings` carries the store handle whose `create()` returns
  // the very instance the panel renders from. Writing `openSection('models')`
  // to it is the same state change a click on that nav row makes, and it is the
  // only route that lands on the section in one step.
  const SETTINGS_SEAT = 'sidebar.settings'
  const SETTINGS_SECTION_SLOT = 'settings.section'
  const SETTINGS_OPEN_COMMAND = 'settings.open'
  const MODELS_SECTION_ID = 'models'

  /**
   * The settings shell's live store instance, or undefined when this carrier has
   * no settings UI (a headless profile, or a shell that predates the seat).
   * @param ctx - a context that can read the `slots` service.
   */
  function settingsShell(ctx) {
    try {
      const seat = ctx.slots.entries(SETTINGS_SEAT)[0]
      const instance = typeof seat?.store?.create === 'function' ? seat.store.create() : undefined
      return typeof instance?.actions?.openSection === 'function' ? instance : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The 模型 section's own nav label, read from the ledger rather than guessed:
   * the registrant owns the copy, so this follows the user's locale for free.
   * @param ctx - a context that can read the `slots` service.
   */
  function modelsSectionLabel(ctx) {
    try {
      const section = ctx.slots.entries(SETTINGS_SECTION_SLOT)
        .find((entry) => entry.options.id === MODELS_SECTION_ID)
      const label = section?.options.label
      const text = typeof label === 'function' ? label() : label
      return typeof text === 'string' && text !== '' ? text : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Click the 模型 row of an already-open settings panel.
   * @param label - the section's nav label; undefined accepts the first row.
   * @returns whether a row was found and clicked.
   */
  function clickModelsNav(label) {
    if (typeof document === 'undefined') return false
    const panel = document.querySelector('[data-shortcut-modal="settings"]')
    if (panel === null) return false
    for (const row of panel.querySelectorAll('nav button')) {
      if (label === undefined || row.textContent.trim() === label) {
        row.click()
        return true
      }
    }
    return false
  }

  /**
   * Open Settings on the 模型 section.
   *
   * Preferred route: write to the settings shell's store (one step, no DOM).
   * Fallback, for a shell whose seat carries no store: run the panel's own
   * `settings.open` command and then light its 模型 row by the label the ledger
   * publishes — the panel mounts asynchronously, so the click is retried a few
   * frames before giving up.
   *
   * @param ctx - the picker's own context, so both services are read through
   *   this plugin's inject set.
   * @returns whether the settings panel was actually opened, so the footer
   *   never closes the picker onto nothing.
   */
  function openModelsSettings(ctx) {
    try {
      const shell = settingsShell(ctx)
      if (shell !== undefined) {
        shell.actions.openSection(MODELS_SECTION_ID)
        return true
      }
      const registry = ctx.get?.('shortcuts')?.registry
      if (typeof registry?.invoke !== 'function') return false
      // A shell without the command has no settings panel to open at all.
      if (registry.commands !== undefined && !registry.commands.has(SETTINGS_OPEN_COMMAND)) return false
      registry.invoke(SETTINGS_OPEN_COMMAND, {
        target: typeof document === 'undefined' ? undefined : document.activeElement,
        region: 'page',
        modal: null,
      })
      const label = modelsSectionLabel(ctx)
      let tries = 0
      const attempt = () => {
        if (clickModelsNav(label)) return
        tries += 1
        if (tries < 5) setTimeout(attempt, 60)
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(attempt)
      else attempt()
      return true
    } catch {
      return false
    }
  }

  // ─── Main component ───
  function ModelPicker(props) {
    const locked = props.locked
    const available = props.available
    const directory = props.directory
    const load = props.load
    const select = props.select
    // Hand-off to Settings → 模型, owned by the plugin half (see
    // openModelsSettings): the component only asks for it and reports whether
    // the panel actually opened.
    const configureModels = props.configureModels
    // The app's language, as a source the component can subscribe to. Falls back
    // to a standalone source (document + navigator) if a carrier hands none in.
    const locale = props.locale ?? FALLBACK_LOCALE

    const EMPTY_STATE = { current: null, routable: null, groups: [], failures: [], status: 'idle', error: null }

    const state = useSyncExternalStore(
      (fn) => directory === null ? (() => {}) : directory.subscribe(fn),
      () => directory === null ? EMPTY_STATE : directory.getSnapshot(),
    )

    // Which popup is open: null | 'model' | 'effort'
    const [openKind, setOpenKind] = useState(null)
    const [query, setQuery] = useState('')
    // Provider row used to narrow an active query; null keeps every provider.
    const [facetId, setFacetId] = useState(null)
    // The group under the list's top edge — the elevator's current floor.
    const [spyId, setSpyId] = useState(null)
    // The keyboard cursor: which row the arrow keys are standing on. It is not
    // `current` (the model actually in use) — the cursor only travels, and
    // Enter commits it. The picker is search-first, so focus never leaves the
    // search box; the cursor is what the keyboard drives instead.
    const [activeIndex, setActiveIndex] = useState(0)
    const [notice, setNotice] = useState(null)
    // Favorited `provider/modelId` keys, mirrored to localStorage on every edit.
    const [favorites, setFavorites] = useState(readFavorites)
    // The route history, most recent first, mirrored to localStorage the same way.
    const [recent, setRecent] = useState(readRecent)
    // Runtime facts keyed `provider/modelId`; null until the one fetch lands.
    const [facts, setFacts] = useState(null)
    const lastActionRef = useRef('load')
    const rootRef = useRef(null)
    const triggerLeftRef = useRef(null)
    const triggerRightRef = useRef(null)
    const searchRef = useRef(null)
    const listRef = useRef(null)
    const groupRefs = useRef(new Map())

    const q = query.trim().toLowerCase()
    const current = state.current

    const currentChoice = useMemo(() => {
      if (current === null) return null
      for (const group of state.groups) {
        if (group.id !== current.provider) continue
        for (const model of group.models) {
          if (model.id === current.model) return { group, model }
        }
      }
      return null
    }, [state.groups, current])

    // Reasoning / effort
    const reasoning = currentChoice === null ? undefined : currentChoice.model.reasoning
    const effectiveEffort = current === null ? undefined : (current.reasoningEffort ?? reasoning?.defaultEffort)
    const effortLabel = reasoning === undefined ? undefined
      : effectiveEffort === undefined ? t('providerDefault')
        : (reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? String(effectiveEffort))
    const effortChoices = useMemo(() => {
      if (reasoning === undefined) return []
      const rows = []
      if (reasoning.defaultEffort === undefined) {
        rows.push({ key: 'provider-default', effort: undefined, label: t('providerDefault') })
      }
      for (const level of reasoning.efforts) {
        rows.push({ key: level.id, effort: level.id, label: level.name, description: level.description })
      }
      return rows
    }, [reasoning])

    // Providers differing only by a trailing capability suffix in parentheses
    // fold into their base provider: modlens registers vision as its own
    // provider route, which would otherwise put a near-duplicate row per
    // provider in the column. Folding is display-only — every row keeps its
    // models paired with the group that actually serves them, so a pick still
    // submits the original provider id and the suffix stays on the model name.
    const providers = useMemo(() => mergeProviders(state.groups), [state.groups])

    // The chip palette is assigned by a supplier's slot in the configured
    // order, so a hue belongs to a supplier and not to a moment in time.
    const providerOrder = useMemo(() => providers.map((provider) => provider.id), [providers])

    // Search narrows BOTH columns: the query is a facet over providers as
    // well as models, so a provider matches by its own name/id or by having
    // at least one matching model.
    const searching = q !== ''
    const favoriteKey = (group, model) => group.id + '/' + model.id
    const isFavorite = (group, model) => favorites.has(favoriteKey(group, model))
    const toggleFavorite = (group, model) => {
      const key = favoriteKey(group, model)
      const next = new Set(favorites)
      if (!next.delete(key)) next.add(key)
      writeFavorites(next)
      setFavorites(next)
    }
    const matches = useMemo(() => {
      if (!searching) return []
      const out = []
      for (const provider of providers) {
        const providerMatch = provider.name.toLowerCase().includes(q) || provider.id.toLowerCase().includes(q)
        const models = providerMatch
          ? provider.models
          : provider.models.filter(({ model }) => model.name.toLowerCase().includes(q)
              || (model.description !== undefined && model.description.toLowerCase().includes(q)))
        if (providerMatch || models.length > 0) out.push({ provider, models })
      }
      return out
    }, [searching, q, providers])

    // A clicked provider narrows the search to that provider; NULL keeps the
    // cross-provider result list.
    const facet = searching && facetId !== null && matches.some((item) => item.provider.id === facetId)
      ? facetId
      : null

    // Every model across every provider, paired with the route that serves it.
    const allModels = useMemo(() => providers.flatMap((row) => row.models), [providers])
    const favoriteRows = useMemo(
      () => allModels.filter(({ group, model }) => favorites.has(group.id + '/' + model.id)),
      [allModels, favorites],
    )
    // The history group, in history order — not catalog order — so re-picking
    // the last model is one row away from where the panel opens. A key whose
    // route is gone (provider uninstalled, model retired) drops out here.
    const recentRows = useMemo(() => {
      const byKey = new Map(allModels.map((entry) => [entry.group.id + '/' + entry.model.id, entry]))
      const rows = []
      for (const key of recent) {
        const entry = byKey.get(key)
        if (entry !== undefined) rows.push(entry)
      }
      return rows
    }, [allModels, recent])

    const searchAll = useMemo(() => matches.flatMap((item) => item.models), [matches])

    const results = useMemo(() => {
      if (!searching) return []
      if (facet === null) return searchAll
      const item = matches.find((entry) => entry.provider.id === facet)
      return item === undefined ? [] : item.models
    }, [searching, searchAll, matches, facet])
    const matchCounts = useMemo(() => new Map(matches.map((item) => [item.provider.id, item.models.length])), [matches])

    // Provider column: filtered while searching, complete otherwise.
    const visibleProviders = searching ? matches.map((item) => item.provider) : providers

    // The right column is one list: the 最近使用 group (a history mirror at the
    // top), then the 收藏 group (another mirror), then every provider group.
    // Searching replaces it with flat results. An empty history is left out
    // entirely — unlike 收藏, it teaches nothing, so a first run looks exactly
    // like the picker without a history at all.
    const grouped = searching ? null : [
      ...(recentRows.length === 0 ? [] : [{ id: RECENT_TAB, name: t('recent'), models: recentRows }]),
      { id: FAVORITES_TAB, name: t('favorites'), models: favoriteRows },
      ...providers,
    ]
    const rows = searching ? results : []

    // The same list, flattened in render order. The keyboard cursor is an index
    // into this, so an empty 收藏 group is simply skipped rather than standing
    // in the way of the first model.
    const flatRows = grouped === null ? rows : grouped.flatMap((group) => group.models)
    const activeAt = flatRows.length === 0 ? -1 : Math.min(activeIndex, flatRows.length - 1)
    const activeRow = activeAt === -1 ? null : flatRows[activeAt]
    /** The DOM id the search box points `aria-activedescendant` at. */
    const optionId = (index) => 'dsh-mp2-opt-' + index

    // Which left-column row is lit: the query facet while searching, otherwise
    // the section pinned at the list's top edge. At scrollTop 0 the spy lands
    // on the first group of the list — 最近使用 when it is there, else 收藏 —
    // so the lit row is the one whose heading is pinned above the list.
    const highlighted = searching
      ? (facet === null ? ALL_TAB : facet)
      : (spyId ?? grouped[0].id)

    // Search results span providers, so their rows always name the serving route.
    const rowDetail = (group, model) =>
      model.description === undefined ? group.name : group.name + ' · ' + model.description

    // The display supplier a route belongs to. A folded `(modlens vision)` route
    // has no row of its own, so its models must wear their base provider's chip
    // rather than one of their own.
    const displayProviderOf = (group) =>
      providers.find((row) => row.models.some((entry) => entry.group.id === group.id)) ?? group

    const busy = state.status === 'selecting'
    const modelLabel = currentChoice === null ? t('triggerFallback') : currentChoice.model.name
    // The supplier behind the current selection, for the chip the trigger wears
    // and the tooltip it shows. Both name the *display* supplier, so a selection
    // on a folded `(modlens vision)` route reads as its base provider — matching
    // the column the user picked from.
    const currentProvider = currentChoice === null ? null : displayProviderOf(currentChoice.group)
    // One model id is routinely served by several providers, so the model name
    // alone does not say where the model runs.
    const modelTip = currentChoice === null ? modelLabel
      : currentProvider.name + ' · ' + currentChoice.model.name
    const factsOf = (group, model) => (facts === null ? undefined : facts.get(group.id + '/' + model.id))

    const reload = () => {
      lastActionRef.current = 'load'
      load()
    }

    // ── Elevator ──
    // The grouped list is a table of contents with 收藏 as its first floor,
    // followed by every provider. Scrolling the list lights the left column
    // row for the section pinned at the list's top edge.
    const floors = () =>
      (grouped ?? []).map((g) => ({
        id: g.id,
        top: groupRefs.current.get(g.id)?.offsetTop ?? 0,
      }))

    /**
     * Jump the list to a floor. The left column is a table of contents, not a
     * ride: a supplier click has to land on its group at once, so the scroll is
     * instant rather than animated. jsdom and older carriers have no `scrollTo`
     * at all, hence the plain-offset fallback.
     */
    const scrollList = (list, top) => {
      if (list === null) return
      if (typeof list.scrollTo === 'function') list.scrollTo({ top, behavior: 'auto' })
      else list.scrollTop = top
    }

    const scrollToFloor = (id) => {
      const node = groupRefs.current.get(id)
      if (node === undefined) return
      scrollList(listRef.current, node.offsetTop)
      setSpyId(id)
    }

    /** Click on a supplier row: a facet while a query is active, else a floor. */
    const pickProvider = (id) => {
      if (searching) {
        setFacetId(facetId === id ? null : id)
        return
      }
      scrollToFloor(id)
    }

    const onListScroll = (event) => {
      if (searching) return
      setSpyId(floorAt(floors(), event.currentTarget.scrollTop))
    }

    useEffect(() => {
      if (!available) return
      lastActionRef.current = 'load'
      load()
    }, [available, load])

    // Model facts are host-wide, not per session: fetch once while mounted.
    useEffect(() => {
      if (!available) return
      let live = true
      loadFacts().then((map) => { if (live) setFacts(map) })
      return () => { live = false }
    }, [available])

    // ── History ──
    // Record the route the directory reports as current, not the rows clicked
    // here: a switch made anywhere — this popup, the shipped `/model` popup, or
    // the model a session reopens with — is a model that was in use, and the
    // history is meant to answer "what did I use lately", not "what did I click
    // in this panel". Re-recording the head is a no-op, so the effect settles
    // after one pass per switch instead of looping on its own write.
    useEffect(() => {
      if (current === null) return
      const key = current.provider + '/' + current.model
      if (recent[0] === key) return
      const next = [key, ...recent.filter((entry) => entry !== key)].slice(0, RECENT_LIMIT)
      writeRecent(next)
      setRecent(next)
    }, [current?.provider, current?.model, recent])

    // Auto-focus search when model popup opens
    useEffect(() => {
      if (openKind === 'model') {
        requestAnimationFrame(() => { searchRef.current?.focus() })
      }
    }, [openKind])

    // Every new popup and every new result set starts on the first row, so the
    // arrow keys work the moment the panel is open.
    useEffect(() => { setActiveIndex(0) }, [openKind, query, facetId])

    // Follow the app's language. The copy comes from module state (`t`), so the
    // panel has to (a) re-render when the language changes and (b) publish the
    // new value before its children render — the parent renders first, so
    // assigning here covers the whole tree in the same pass.
    const lang = useSyncExternalStore(
      locale.subscribe,
      locale.getSnapshot,
      locale.getSnapshot,
    )
    APP_LOCALE = lang

    // Keep the cursor on screen. `scroll-margin-top` in the stylesheet keeps the
    // sticky group header from covering the row it scrolled to.
    useEffect(() => {
      if (openKind !== 'model' || listRef.current === null) return
      const node = listRef.current.querySelector('.dsh-mp2-optionActive')
      if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
    }, [openKind, activeIndex, query, facetId, flatRows.length])

    // A new query starts broad: the previous provider facet no longer applies.
    useEffect(() => { setFacetId(null) }, [query])

    // Close on Escape
    useEffect(() => {
      if (openKind === null) return
      const handler = (event) => {
        if (event.key === 'Escape') {
          setOpenKind(null)
          setNotice(null)
          setFacetId(null)
          setSpyId(null)
          setQuery('')
        }
      }
      document.addEventListener('keydown', handler)
      return () => document.removeEventListener('keydown', handler)
    }, [openKind])

    // Close on outside click
    useEffect(() => {
      if (openKind === null) return
      const handler = (event) => {
        if (rootRef.current && !rootRef.current.contains(event.target)) {
          setOpenKind(null)
          setNotice(null)
          setFacetId(null)
          setSpyId(null)
          setQuery('')
        }
      }
      // Use mousedown to catch clicks before the menu loses focus
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }, [openKind])

    // Blur handling for model menu
    const onModelBlur = (event) => {
      const related = event.relatedTarget
      if (related !== null && rootRef.current !== null && rootRef.current.contains(related)) return
      // Clicking the effort trigger button is fine
      if (related === triggerRightRef.current) return
      setOpenKind(null)
      setNotice(null)
      setFacetId(null)
      setSpyId(null)
      setQuery('')
    }

    const close = (restoreFocus) => {
      setOpenKind(null)
      setNotice(null)
      setFacetId(null)
      setSpyId(null)
      setQuery('')
      if (restoreFocus && triggerLeftRef.current !== null) triggerLeftRef.current.focus()
    }

    const settle = (accepted) => {
      if (accepted) {
        close(true)
        return
      }
      const message = directory === null ? null : directory.getSnapshot().error
      setNotice(message === null ? t('selectFailed') : t('selectFailedMsg') + message)
    }

    // --- Select a model ---
    const choose = (group, model) => {
      if (current !== null && current.provider === group.id && current.model === model.id) {
        close(true)
        return
      }
      lastActionRef.current = 'select'
      const effort = (current !== null && current.provider === group.id)
        ? current.reasoningEffort
        : model.reasoning?.defaultEffort
      const selection = {
        provider: group.id,
        model: model.id,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      }
      void select(selection).then(settle)
    }

    // --- Select reasoning effort independently ---
    const chooseEffort = (effort) => {
      if (current === null) return
      if (effectiveEffort === effort) return
      lastActionRef.current = 'select'
      const selection = {
        provider: current.provider,
        model: current.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      }
      void select(selection).then(settle)
    }

    // --- Keyboard ---
    // The whole popup is drivable from the search box: ↑/↓ walk the list, Enter
    // commits the row the cursor is on. Focus stays in the input, so the cursor
    // is reported to assistive tech through `aria-activedescendant` rather than
    // by moving DOM focus — typing keeps filtering after every arrow press.
    const moveCursor = (delta) => {
      const count = flatRows.length
      if (count === 0) return
      const from = activeAt === -1 ? 0 : activeAt
      setActiveIndex(Math.min(Math.max(from + delta, 0), count - 1))
    }

    const onMenuKeyDown = (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      switch (event.key) {
        case 'ArrowDown': event.preventDefault(); moveCursor(1); break
        case 'ArrowUp': event.preventDefault(); moveCursor(-1); break
        case 'Home': event.preventDefault(); setActiveIndex(0); break
        case 'End': event.preventDefault(); setActiveIndex(flatRows.length - 1); break
        case 'PageDown': event.preventDefault(); moveCursor(10); break
        case 'PageUp': event.preventDefault(); moveCursor(-10); break
        case 'Enter':
          // Enter belongs to the search box alone. On a focused row or star the
          // button's own activation must win, or Enter on a star would both
          // favorite and pick a model.
          if (event.target !== searchRef.current) return
          event.preventDefault()
          if (activeRow !== null) choose(activeRow.group, activeRow.model)
          break
        default: break
      }
    }

    if (!available || directory === null) return null

    // Rows are numbered in render order, which is exactly `flatRows` order, so
    // the cursor can address one by index and the search box can name it in
    // `aria-activedescendant`. Numbering by position rather than by route keeps
    // the two copies of a favorited model — the 收藏 mirror and the row under
    // its supplier — from lighting up together.
    let rowCursor = -1
    const takeRowIndex = () => { rowCursor += 1; return rowCursor }

    // ─── Render ───
    return h('div', { ref: rootRef, className: 'dsh-mp2-root' },

      // ─── Two-zone trigger ───
      h('div', { className: 'dsh-mp2-trigger' + (locked ? ' dsh-mp2-triggerLocked' : '') },

        // LEFT zone: model name (click opens model picker)
        h('button', {
          ref: triggerLeftRef,
          type: 'button',
          className: 'dsh-mp2-triggerLeft',
          title: modelTip,
          'aria-label': modelTip,
          'aria-haspopup': 'menu',
          'aria-expanded': openKind === 'model',
          disabled: locked,
          onClick: () => {
            if (openKind === 'model') { close() } else {
              setOpenKind('model')
              setNotice(null)
              setQuery('')
              lastActionRef.current = 'load'
              reload()
            }
          },
        },
          currentProvider !== null && supplierChip(currentProvider, providerOrder),
          h('span', { className: 'dsh-mp2-triggerLabel' }, modelLabel),
          h('span', { className: 'dsh-mp2-chevron' + (openKind === 'model' ? ' dsh-mp2-chevronOpen' : '') }, icon('chevron', 12)),
        ),

        // Divider
        effortLabel !== undefined && h('span', { className: 'dsh-mp2-triggerDivider' }),

        // RIGHT zone: effort label (click opens effort picker)
        effortLabel !== undefined && h('button', {
          ref: triggerRightRef,
          type: 'button',
          className: 'dsh-mp2-triggerRight',
          title: t('effortHeading') + ': ' + effortLabel,
          'aria-label': t('effortHeading') + ': ' + effortLabel,
          'aria-haspopup': 'menu',
          'aria-expanded': openKind === 'effort',
          disabled: locked,
          onClick: () => {
            if (openKind === 'effort') { setOpenKind(null) } else {
              setOpenKind('effort')
            }
          },
        },
          h('span', null, effortLabel),
          h('span', { className: 'dsh-mp2-chevron' + (openKind === 'effort' ? ' dsh-mp2-chevronOpen' : '') }, icon('chevron', 12)),
        ),
      ),

      // ─── Model picker popup ───
      openKind === 'model' && h('div', {
        className: 'dsh-mp2-menu',
        role: 'menu',
        tabIndex: -1,
        onBlur: onModelBlur,
        onKeyDown: onMenuKeyDown,
        onMouseDown: (event) => { event.preventDefault() },
        'aria-busy': state.status === 'loading' || busy,
      },
        // Search input — always at the top, auto-focused
        h('input', {
          ref: searchRef,
          type: 'text',
          className: 'dsh-mp2-search',
          placeholder: t('search'),
          value: query,
          onChange: (event) => { setQuery(event.target.value) },
          // Focus never leaves the search box, so this is what tells a screen
          // reader which row the arrow keys are standing on.
          'aria-activedescendant': activeAt === -1 ? undefined : optionId(activeAt),
        }),

        // Body: providers (left) + model list (right)
        h('div', { className: 'dsh-mp2-body' },
          // Provider sidebar — caption then the floors.
          h('div', { className: 'dsh-mp2-providers', role: 'tablist', 'aria-label': t('providers') },
            // Column caption: the list itself is "全部供应商", always.
            h('div', { className: 'dsh-mp2-paneCaption' }, t('allProviders')),
            // 最近使用 floor — the history mirror, above 收藏. It is not a
            // supplier, so it wears no chip; an empty history has no floor.
            recentRows.length > 0 && h('button', {
              key: RECENT_TAB,
              type: 'button',
              role: 'tab',
              'aria-selected': highlighted === RECENT_TAB,
              className: 'dsh-mp2-provider' + (highlighted === RECENT_TAB ? ' dsh-mp2-providerActive' : ''),
              onClick: () => { scrollToFloor(RECENT_TAB) },
            },
              h('span', { className: 'dsh-mp2-providerName' }, t('recent')),
              h('span', { className: 'dsh-mp2-providerCount' }, String(recentRows.length)),
            ),
            // 收藏 floor — a mirrored copy at the top of the model list.
            h('button', {
              key: FAVORITES_TAB,
              type: 'button',
              role: 'tab',
              'aria-selected': highlighted === FAVORITES_TAB,
              className: 'dsh-mp2-provider' + (highlighted === FAVORITES_TAB ? ' dsh-mp2-providerActive' : ''),
              onClick: () => { scrollToFloor(FAVORITES_TAB) },
            },
              h('span', { className: 'dsh-mp2-providerName' }, t('favorites')),
              h('span', { className: 'dsh-mp2-providerCount' }, String(favoriteRows.length)),
            ),
            // The supplier floors.
            visibleProviders.map((provider) => {
              const active = highlighted === provider.id
              const count = searching ? (matchCounts.get(provider.id) ?? 0) : provider.models.length
              return h('button', {
                key: provider.id,
                type: 'button',
                role: 'tab',
                'aria-selected': active,
                className: 'dsh-mp2-provider' + (active ? ' dsh-mp2-providerActive' : ''),
                onClick: () => { pickProvider(provider.id) },
              },
                supplierChip(provider, providerOrder),
                h('span', { className: 'dsh-mp2-providerName' }, provider.name),
                h('span', { className: 'dsh-mp2-providerCount' }, String(count)),
              )
            }),
          ),

          // Model list
          h('div', { className: 'dsh-mp2-list', ref: listRef, onScroll: onListScroll },
            state.status === 'loading'
              ? h('div', { className: 'dsh-mp2-status' }, t('loading'))
              : h(Fragment, null,
                  state.error !== null && lastActionRef.current === 'load'
                    && h('div', { className: 'dsh-mp2-error' },
                        h('span', null, String(state.error)),
                        h('button', { type: 'button', className: 'dsh-mp2-retry', onClick: reload }, t('retry')),
                      ),
                  notice !== null
                    && h('div', { className: 'dsh-mp2-error' },
                        h('span', null, notice),
                      ),
                  !searching && state.failures.map((failure) =>
                    h('div', { className: 'dsh-mp2-warning', key: failure.id },
                      h('span', null, failure.name + ' 加载失败：' + failure.message),
                      h('button', { type: 'button', className: 'dsh-mp2-retry', onClick: reload }, t('retry')),
                    ),
                  ),
                  (grouped === null ? rows.length === 0 : providers.length === 0)
                    ? h('div', { className: 'dsh-mp2-empty' },
                        searching ? t('noMatch') : t('noModels'))
                    : grouped === null
                      ? rows.map(({ group, model }) => {
                          const index = takeRowIndex()
                          const selected = current !== null && current.provider === group.id && current.model === model.id
                          return h(ModelRow, {
                            key: group.id + '/' + model.id,
                            id: optionId(index),
                            group,
                            provider: displayProviderOf(group),
                            model,
                            detail: rowDetail(group, model),
                            selected,
                            active: index === activeAt,
                            busy,
                            favorite: isFavorite(group, model),
                            facts: factsOf(group, model),
                            bridged: VISION_ROUTE.test(group.name),
                            order: providerOrder,
                            onToggle: () => { toggleFavorite(group, model) },
                            onChoose: () => { choose(group, model) },
                          })
                        })
                      : grouped.map((g) =>
                          h('div', {
                            key: g.id,
                            className: 'dsh-mp2-group',
                            ref: (node) => {
                              if (node === null) groupRefs.current.delete(g.id)
                              else groupRefs.current.set(g.id, node)
                            },
                          },
                            h('div', { className: 'dsh-mp2-groupHeader' },
                              h('span', { className: 'dsh-mp2-groupHeaderIcon' },
                                icon(g.id === RECENT_TAB ? 'clock' : 'building', 14)),
                              h('span', null, g.name),
                            ),
                            g.models.length === 0
                              ? h('div', { className: 'dsh-mp2-empty' },
                                  g.id === FAVORITES_TAB ? t('favoritesEmpty') : t('providerEmpty'))
                              : g.models.map(({ group, model }) => {
                                  const index = takeRowIndex()
                                  const selected = current !== null && current.provider === group.id && current.model === model.id
                                  return h(ModelRow, {
                                    key: group.id + '/' + model.id,
                                    id: optionId(index),
                                    group,
                                    provider: displayProviderOf(group),
                                    model,
                                    // The mirror groups span suppliers, so their
                                    // rows name the route serving them; inside a
                                    // supplier's own group the description says
                                    // more than the heading would.
                                    detail: (g.id === FAVORITES_TAB || g.id === RECENT_TAB)
                                      ? rowDetail(group, model)
                                      : model.description,
                                    selected,
                                    active: index === activeAt,
                                    busy,
                                    favorite: isFavorite(group, model),
                                    facts: factsOf(group, model),
                                    bridged: VISION_ROUTE.test(group.name),
                                    order: providerOrder,
                                    onToggle: () => { toggleFavorite(group, model) },
                                    onChoose: () => { choose(group, model) },
                                  })
                                }),
                          ),
                        ),
                ),
          ),
        ),

        // Footer: one fixed row under the body, outside the scroll area. The
        // list can only show what the configured providers offer, so the panel
        // is where "the official models are missing" is noticed — and this is
        // the one row that leaves for the page that fixes it.
        h('div', { className: 'dsh-mp2-footer' },
          h('button', {
            type: 'button',
            className: 'dsh-mp2-footerAction',
            title: t('configureModels') + ': ' + t('configureModelsWhere'),
            onClick: () => {
              if (typeof configureModels === 'function' && configureModels()) close(false)
            },
          },
            icon('settings', 13),
            h('span', { className: 'dsh-mp2-footerLabel' }, t('configureModels')),
            h('span', { className: 'dsh-mp2-footerWhere' }, t('configureModelsWhere')),
            icon('external', 12),
          ),
        ),
      ),

      // ─── Effort picker popup (SEPARATE, standalone) ───
      openKind === 'effort' && EffortPopup({
        reasoning,
        effectiveEffort,
        effortChoices,
        busy,
        chooseEffort,
      }),
    )
  }

  // ─── Stylesheet ownership ───
  // The client module system re-tags every *untagged* <style> tag in the page
  // with the package being materialized (`claimStyles`) and deletes everything
  // a package owns when it reloads or is pruned (`removeOwnedStyles`). A tag
  // created from apply() is untagged at insert time — apply() runs after this
  // package's own materialization — so the NEXT package that materializes
  // claims it, and that unrelated package's next rebuild deletes the
  // stylesheet. The picker keeps rendering, unstyled, until a manual reload:
  // this is the "sometimes the styles never load" report.
  //
  // Injecting from the module body and claiming the tag up front is the
  // platform's own client-plugin contract (see dsh-client-ui-model-selection),
  // and it is what keeps the tag out of `style:not([data-plugin])`.
  const STYLE_ID = 'dsh-model-picker-style'
  const PLUGIN_ID = 'dsh-model-picker'

  /**
   * Insert the stylesheet, or re-claim a tag an older revision left untagged.
   * Idempotent, and it never removes the tag: on reload the module system owns
   * removal and this module body runs again to put the tag back.
   */
  function ensureStyle() {
    if (typeof document === 'undefined') return
    const existing = document.getElementById(STYLE_ID)
    if (existing !== null) {
      if (existing.dataset.plugin !== PLUGIN_ID) existing.dataset.plugin = PLUGIN_ID
      return
    }
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.dataset.plugin = PLUGIN_ID
    style.dataset.pluginCss = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  ensureStyle()

  // ─── Plugin registration ───
  // The seat is claimed only once the services it reads are live: an
  // unserviceable occupant would win the single seat and render nothing,
  // hiding the working picker underneath it.
  //
  // `remote` / `remote.session` are required by every face of
  // `modelDirectories`: a cordis service proxy rebinds `this.ctx` to the
  // caller, so `directoryFor()` / `load()` / `select()` read `remote.session`
  // through THIS plugin's inject set. Without them the seat entry throws
  // (`cannot get property "remote.session" without inject`), the shadowing
  // entry abdicates, and the enhanced picker never appears.
  const pluginInject = ['slots', 'sessions', 'modelDirectories', 'remote', 'remote.session']

  function apply(ctx) {
    // The stylesheet rides the module body (see ensureStyle); re-assert it here
    // for a page whose tag was dropped by an older revision's bookkeeping. This
    // never removes the tag — the module system owns removal on reload.
    ensureStyle()

    // Register into the composer model seat
    ctx.inject(['slots', 'modelDirectories'], (scope) => {
      const slots = scope.slots
      const models = scope.modelDirectories
      const sessions = scope.sessions
      const pickerLocale = localeSource(scope)
      slots.inject('conversation.input.model', () => slots.register({
        name: 'conversation.input.model',
        priority: -20,
        registrant: 'dsh-model-picker',
        inject: (sessionId) => {
          const directory = models.directoryFor(sessionId)
          const available = sessions.subagentAddress(sessionId) === undefined
          return {
            available,
            directory: directory.store,
            load: () => { if (available) directory.load().catch(() => { /* surfaced on the store */ }) },
            select: (selection) => available
              ? directory.select(selection).then(() => true, () => false)
              : Promise.resolve(false),
            // Read through THIS scope, not the caller's: the settings seat and
            // the shortcut registry are reached with the services this plugin
            // declared, and the hand-off must never throw into a click handler.
            configureModels: () => openModelsSettings(scope),
            // The UI language is the app's preference, so the source is built
            // once per activation and handed to every instance of the seat.
            locale: pickerLocale,
          }
        },
      }, ModelPicker))
    })
  }

  module.exports = { inject: pluginInject, apply }
  return module.exports;
} })