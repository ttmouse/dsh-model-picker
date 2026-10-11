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
      favoriteAdd: '加入收藏',
      favoriteRemove: '取消收藏',
      imageNative: '支持图片输入（模型原生视觉）',
      imageBridged: '支持图片输入（modlens 桥接：模型看到的是转写文本，不是原图）',
      configureModels: '配置官方模型',
      configureModelsWhere: '设置 · 模型',
      hideProviders: '折叠供应商列表',
      showProviders: '展开供应商列表',
      // Failover. The repair is a button that appears only while a failure is
      // live, so the copy here is what the user reads at that moment.
      repairFallbackSet: '设为兜底模型',
      repairFallbackClear: '取消兜底模型',
      repairAction: '用兜底模型重试',
      repairActionAgent: '续跑',
      repairActionFailed: '重试失败：',
      repairStaleFallback: '兜底模型已不在可用列表里，请在模型列表里重新指定。',
      repairResume: '上一轮执行到一半中断了，请先用工具核实当前实际进度（已完成的不要重做），再从中断处继续把剩下的做完。',
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
      favoriteAdd: 'Add to favorites',
      favoriteRemove: 'Remove from favorites',
      imageNative: 'Accepts images (native vision)',
      imageBridged: 'Accepts images (modlens bridge: the model sees transcribed text, not the picture)',
      configureModels: 'Configure official models',
      configureModelsWhere: 'Settings · Models',
      hideProviders: 'Hide provider list',
      showProviders: 'Show provider list',
      // Failover, mirroring the zh table above.
      repairFallbackSet: 'Set as fallback',
      repairFallbackClear: 'Clear fallback',
      repairAction: 'Retry with the fallback',
      repairActionAgent: 'Resume',
      repairActionFailed: 'Retry failed: ',
      repairStaleFallback: 'The fallback model is no longer available — pick a new one in the list.',
      repairResume: 'The previous turn was interrupted partway through. First use your tools to check what actually completed (do not redo finished work), then resume from where it stopped and finish the rest.',
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
  /* A third, fainter step, for NON-TEXT state glyphs only. A mark that reports
     "this model takes images" is a graphic, so its floor is the 3:1 for
     non-text content, not the 4.5:1 for body text. It must never be used for
     text: on the panel this value measures 4.49:1 in the dark theme, which is
     fine for a glyph and under the bar for a word. */
  --dsh-mp2-ink-faint:var(--dsw-alias-label-tertiary);
  --dsh-mp2-ease-out:cubic-bezier(0.23,1,0.32,1);
  --dsh-mp2-radius-control:8px;
  --dsh-mp2-radius-row:10px;
  --dsh-mp2-radius-panel:12px;
  /* Folding the provider column takes the COLUMN's width out of the panel
     rather than handing it to the model list: a column that folds should remove
     space, not stretch what is left. 352px is 540px minus the column's outer
     footprint (178px basis plus its 6px of padding) and the 4px gap between the
     two columns, so the model list keeps the width it had before the fold. */
  --dsh-mp2-menu-width:540px;
  --dsh-mp2-menu-width-folded:352px;
  /* The panel's height budget. It is clamped against the window instead of
     fixed, so a short window keeps the whole popup on screen.

     The middle term is measured, not guessed. The panel is anchored above the
     composer, which sits near the middle of the window in the hero layout, so
     the space above the trigger measures 50vh + 61px (checked at 640, 700,
     800, 900, 1000 and 1100px). The clamp asks for that space minus the panel's
     own chrome and a small margin, which is 50vh + 40px. The previous
     100vh - 340px overestimated the room by ~120px at 900px and left the
     popup's top edge 1px from the top of the window. */
  --dsh-mp2-menu-height:500px;
}

/* ───────── root + trigger (two-zone) ───────── */
/* The label zone is sized by its content and shrinks only when the composer
   row runs out of space, so the model name stays readable. */
.dsh-mp2-root{position:relative;min-width:0;display:inline-flex}
/* max-width leaves room for the supplier chip (16px + 4px gap) on top of the
   model name budget, so wearing the chip never costs the name a character.
   240px clipped the name to "DeepSeek …"; 300px then squeezed the effort zone
   instead, which turned the selected level into "Hi…". Both were the same
   mistake: a fixed budget spent on the wrong text. 324px is the measured width
   at which this row's contents fit: chip + the longest configured model name +
   both chevrons + the effort label. Below it the name truncates; the effort
   label never does. */
.dsh-mp2-trigger{display:flex;align-items:stretch;min-width:0;max-width:324px;height:30px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;cursor:pointer;overflow:hidden;padding:0}
.dsh-mp2-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mp2-trigger:focus-within{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-mp2-triggerLocked{color:var(--dsw-alias-label-dimmed)}
.dsh-mp2-triggerLeft{display:flex;align-items:center;gap:4px;min-width:0;flex:0 1 auto;padding:0 2px 0 8px;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;overflow:hidden;transition:background-color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-triggerLeft:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dsh-mp2-triggerLeft:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-radius:24px 0 0 24px}
.dsh-mp2-triggerLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mp2-triggerDivider{width:1px;flex:0 0 auto;background:var(--dsw-alias-border-l3)}
/* The effort zone never shrinks and never clips. It reports a STATE the user
   just set, in one short word, and a clipped state word is worse than useless:
   "Hi…" is not a truncation of "High", it is a different string. When the row
   runs short it is the model NAME that yields, because a name is free-form, it
   truncates readably, and the tooltip carries it in full. */
.dsh-mp2-triggerRight{display:flex;align-items:center;gap:2px;flex:0 0 auto;padding:0 6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:20px;cursor:pointer;transition:background-color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-triggerRight>span:first-child{white-space:nowrap}
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
.dsh-mp2-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:20;display:flex;flex-direction:column;width:min(var(--dsh-mp2-menu-width),calc(100vw - 32px));height:clamp(220px,calc(50vh + 40px),var(--dsh-mp2-menu-height));overflow:hidden;padding:4px;border:1px solid var(--dsw-alias-border-inverted);border-radius:var(--dsh-mp2-radius-panel);background:var(--dsh-mp2-surface);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
/* The effort list is short and has no search box, so it stays content-sized. */
.dsh-mp2-menuEffort{width:min(280px,calc(100vw - 32px));height:auto;max-height:min(260px,calc(50vh + 40px))}

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
/* Folded away: the panel narrows by the column it gave up, and the divider that
   separated the two columns leaves with the column it belonged to. */
.dsh-mp2-menuFolded{width:min(var(--dsh-mp2-menu-width-folded),calc(100vw - 32px))}
.dsh-mp2-menuFolded .dsh-mp2-providers{display:none}
.dsh-mp2-menuFolded .dsh-mp2-list{border-left:none}
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
/* No rule between groups. The sticky heading already separates them, and a
   hairline per group drew a line across the list every few rows for no gain. */
.dsh-mp2-group{display:flex;flex-direction:column;gap:2px}
.dsh-mp2-groupHeader{position:sticky;top:0;z-index:1;padding:10px 8px 4px;background:var(--dsh-mp2-surface);color:var(--dsh-mp2-ink-dim);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}

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
.dsh-mp2-option:not(:disabled):active,.dsh-mp2-provider:active,.dsh-mp2-footerAction:active,.dsh-mp2-footerIcon:active{transform:scale(0.985)}
.dsh-mp2-option,.dsh-mp2-provider,.dsh-mp2-footerAction,.dsh-mp2-footerIcon{transform-origin:center}
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
.dsh-mp2-image{display:inline-flex;flex:0 0 auto;align-items:center;color:var(--dsh-mp2-ink-faint)}
/* Bridged vision: the route accepts images, but the model reads a transcript.
   The dimming *is* the meaning — "this model cannot see" — so it cannot be
   carried by an opacity that drops the glyph under the 3:1 floor for
   non-text graphics. The glyph is drawn at full ink and struck through
   instead: the difference survives low vision, greyscale and both themes,
   where a lighter grey does not. */
.dsh-mp2-imageBridged{color:var(--dsh-mp2-ink-faint)}
.dsh-mp2-imageBridged svg{position:relative}
/* The favorite toggle follows the model name (and the vision mark, when there
   is one) and is REVEALED, not always present. Favoriting is something you do
   to a row, not part of what a row says, so the star stays out of the way until
   the row is hovered or has keyboard focus.

   Two things keep that honest:
   - The reserved box keeps its place whether or not the star is painted, so
     revealing it never shifts the row under the pointer.
   - Only a pointer that can actually hover hides it. On a touch screen the star
     would be permanently unreachable, so there it stays visible.
   - A FAVORITED row always shows its star. That star is state, not an
     invitation; hiding it would hide the answer. */
.dsh-mp2-star{position:relative;flex:0 0 auto;display:inline-flex;align-items:center;font-size:13px;line-height:1;padding:0 2px;color:var(--dsh-mp2-ink-dim);cursor:pointer;transition:color 160ms var(--dsh-mp2-ease-out),opacity 120ms var(--dsh-mp2-ease-out)}
/* The star draws at its text size but carries a 24px hit area, marked by a
   ::before overlay rather than by the element's own box. Widening the box itself
   cost the row 6px of name width and clipped "DeepSeek V4.1 Flash · routing
   group"; an overlay enlarges the target without taking layout space. */
.dsh-mp2-star::before{content:'';position:absolute;top:50%;left:50%;width:24px;height:24px;transform:translate(-50%,-50%)}
@media (hover: hover) and (pointer: fine){
  .dsh-mp2-star{opacity:0}
}
.dsh-mp2-option:hover .dsh-mp2-star,
.dsh-mp2-option:focus-within .dsh-mp2-star,
.dsh-mp2-star:focus-visible{opacity:1}
.dsh-mp2-star:hover{color:var(--dsw-alias-label-primary)}
/* Last, so a favorited star wins over the hidden-at-rest rule above. */
.dsh-mp2-starOn{opacity:1;color:var(--dsw-alias-state-warn-primary,currentColor)}
/* The failover mark, sharing the star's slot and rules: reserved space, hidden
   at rest, shown whenever it is on, and always focusable. */
.dsh-mp2-pin{position:relative;flex:0 0 auto;display:inline-flex;align-items:center;font-size:13px;line-height:1;padding:0 2px;color:var(--dsh-mp2-ink-dim);cursor:pointer;transition:color 160ms var(--dsh-mp2-ease-out),opacity 120ms var(--dsh-mp2-ease-out)}
.dsh-mp2-pin::before{content:'';position:absolute;top:50%;left:50%;width:24px;height:24px;transform:translate(-50%,-50%)}
@media (hover:hover){
  .dsh-mp2-pin{opacity:0}
}
.dsh-mp2-option:hover .dsh-mp2-pin,
.dsh-mp2-option:focus-within .dsh-mp2-pin,
.dsh-mp2-pin:focus-visible{opacity:1}
.dsh-mp2-pin:hover{color:var(--dsw-alias-label-primary)}
.dsh-mp2-pinOn{opacity:1;color:var(--dsw-alias-label-primary)}
/* Chip + name + vision mark + star share one flex row, so the marks sit in a
   row after the name rather than being scattered around it. */
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
/* A brand mark is not a letter on a chip: the mark IS the shape, so it takes no
   tint and no letter-spacing treatment. Drawing it at the same 16px box keeps
   the row's rhythm and the description indent (both derived from
   \`--dsh-mp2-chip-size\`) unchanged, and the glyph is drawn one step in from
   that box so a full-bleed mark (StepFun's, for one) does not touch the text
   beside it. It inherits the row's ink like every other mark in the panel —
   a per-brand ink was never an option, and a fixed light or dark ink would
   only survive one of the two themes. */
.dsh-mp2-avatarBrand{background:none}
.dsh-mp2-avatarBrand svg{width:14px;height:14px}
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
.dsh-mp2-footer{display:flex;flex:0 0 auto;align-items:center;gap:2px;margin:4px 2px 0;padding-top:5px;border-top:1px solid var(--dsw-alias-border-l2)}
/* The settings entry is a pointer to somewhere else, not the panel's subject.
   It used to be a full-width bar with a destination label on its far right,
   which read as the panel's second row of content and competed with the list
   above it. It is now a quiet text button at the trailing edge: one glyph and
   one label, dimmed ink at rest, and the destination it leaves for moved into
   the tooltip where it is there when asked for and silent when not. */
.dsh-mp2-footerAction{display:inline-flex;align-items:center;gap:5px;margin-left:auto;min-height:28px;padding:0 8px;border:none;border-radius:var(--dsh-mp2-radius-control);outline:none;background:transparent;color:var(--dsh-mp2-ink-dim);font:inherit;font-size:12px;line-height:18px;text-align:right;cursor:pointer;transition:background-color 160ms var(--dsh-mp2-ease-out),color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-footerAction:hover,.dsh-mp2-footerAction:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mp2-footerLabel{white-space:nowrap}
/* The provider-column toggle. It sits in this row because the row is the
   panel's one strip of fixed controls, and the column it folds is the panel's
   own table of contents. */
.dsh-mp2-footerIcon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:32px;min-height:32px;padding:0;border:none;border-radius:var(--dsh-mp2-radius-control);outline:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 160ms var(--dsh-mp2-ease-out),color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-footerIcon:hover,.dsh-mp2-footerIcon:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* ───────── failover prompt ─────────
   Offered only while a turn has failed and a fallback is designated, so it is
   absent on every healthy session and cannot disturb an ordinary model switch.
   It sits above the composer's model row — the shape a suggested action takes —
   rather than inside the popup, which is closed at the moment a failure shows.
   Colour is the only lift: no motion, no layout shift for the rows below. */
.dsh-mp2-failover{position:absolute;bottom:calc(100% + 6px);left:0;z-index:2;display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-width:min(420px,80vw)}
.dsh-mp2-failoverBtn{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;outline:none;background:var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;transition:background-color 160ms var(--dsh-mp2-ease-out),border-color 160ms var(--dsh-mp2-ease-out)}
.dsh-mp2-failoverBtn:hover,.dsh-mp2-failoverBtn:focus-visible{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-inverted)}
.dsh-mp2-failoverBtn svg{flex:0 0 auto}
/* The target model is the button's qualifier, so it reads one step quieter than
   the action itself; the tone comes from the host's own secondary token. */
.dsh-mp2-failoverTarget{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dsh-mp2-failoverError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}

/* ───────── reduced motion ─────────
   The panel's motion is one chevron turn and a set of colour/border lifts.
   Under a reduced-motion preference the turn is dropped; the colour lifts
   stay, because they aid comprehension and are not motion. */
@media (prefers-reduced-motion: reduce){
  .dsh-mp2-chevron{transition:none}
  .dsh-mp2-option,.dsh-mp2-provider,.dsh-mp2-footerAction,.dsh-mp2-footerIcon{transition:none}
  .dsh-mp2-option:not(:disabled):active,.dsh-mp2-provider:active,.dsh-mp2-footerAction:active,.dsh-mp2-footerIcon:active{transform:none}
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
  // The provider column is a table of contents, so folding it away is a view
  // preference like the favorites, kept in the same browser-local storage.
  const PROVIDERS_HIDDEN_KEY = 'dsh.modelPicker.providersHidden'
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

  /** Whether the provider column is folded away, as a view preference. */
  function readProvidersHidden() {
    if (typeof localStorage === 'undefined') return false
    try {
      return localStorage.getItem(PROVIDERS_HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  }

  /** Persist the fold. A storage refusal must not break the picker. */
  function writeProvidersHidden(hidden) {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(PROVIDERS_HIDDEN_KEY, hidden ? '1' : '0')
    } catch {
      // Private mode or a full quota: the in-memory flag still tracks this page.
    }
  }

  // ─── Fallback model / switch-to-repair ───
  //
  // The scenario this serves: a turn dies (the route ran out of quota, rate
  // limited, or the Agent failed partway through), the user switches to a model
  // that still works, and then has to retype "continue". The switch itself is
  // the moment that repair can happen without the retype.
  //
  // Two failure shapes need two different repairs, so they are told apart
  // rather than collapsed into one "continue":
  //
  //   send  — the prompt never left the client (`promptError.op === 'send'`).
  //           Nothing ran, so re-sending the same words is the exact repair.
  //   agent — the prompt was accepted and the Agent failed mid-turn, or the
  //           turn was interrupted (`lastAgentError`, or an interrupted
  //           assistant message). Work may sit half-done on disk, so the repair
  //           must name that and ask for resumption, never a bare "continue"
  //           that would re-read the request as a fresh instruction.
  //
  // The fallback route is a user-picked setting, not a computed downgrade
  // chain: the picker stays predictable, and choosing which model to trust with
  // a rescue stays the user's call.
  //
  // There is deliberately no on/off flag. A standing toggle would have to be
  // found and armed *before* the failure it exists for, which is both a decision
  // made at the wrong moment and a switch that looks broken whenever it is left
  // off. The failure itself is the gate instead: nothing is designated until the
  // route is picked, and nothing is repaired unless the session has actually
  // failed. Storage holds one route and nothing else.
  const FALLBACK_KEY = 'dsh.modelPicker.fallback'

  /**
   * The stored fallback route.
   *
   * Tolerates the earlier `{route, enabled}` shape: the flag is gone, but a
   * record written by that revision still yields its route, so an existing
   * choice is not lost when this revision loads.
   * @returns a `provider/modelId` key, or null when none is designated.
   */
  function readFallbackRoute() {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(FALLBACK_KEY)
      if (raw === null) return null
      const stored = JSON.parse(raw)
      // The bare-string shape is accepted too, for a hand-written value.
      if (typeof stored === 'string') return stored === '' ? null : stored
      if (stored === null || typeof stored !== 'object') return null
      return typeof stored.route === 'string' && stored.route !== '' ? stored.route : null
    } catch {
      return null
    }
  }

  /** Persist the fallback route. A storage refusal must not break the picker. */
  function writeFallbackRoute(route) {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify({ route: route ?? null }))
    } catch {
      // Private mode or a full quota: the in-memory value still tracks this page.
    }
  }

  /**
   * Classify what a session's failure state calls for.
   *
   * Reads only the public session snapshot (`promptError`, `lastAgentError`,
   * `promptAttempted`) plus the last assistant message's interrupted flag. The
   * `attempted` gate is what keeps a brand-new session from looking failed: a
   * session nobody has prompted has no error and no prior work to resume.
   *
   * The interrupted flag arrives as a probe rather than a value because reading
   * it means walking the folded event list, and this runs on every session
   * notification — the two cheap snapshot fields answer the common cases first,
   * so the walk happens only when they say nothing.
   *
   * @param snapshot - a session snapshot, or null/undefined when unavailable.
   * @param interruptedProbe - returns whether the newest assistant message was
   *   interrupted; a boolean is also accepted.
   * @returns `{kind, detail}` where kind is 'none' | 'send' | 'agent'.
   */
  function classifyFailure(snapshot, interruptedProbe) {
    if (snapshot === null || snapshot === undefined) return { kind: 'none', detail: null }
    const sendFailure = snapshot.promptError
    if (sendFailure !== null && sendFailure !== undefined && sendFailure.op === 'send') {
      return { kind: 'send', detail: errorText(sendFailure.error) }
    }
    const agentFailure = snapshot.lastAgentError
    if (typeof agentFailure === 'string' && agentFailure !== '') {
      return { kind: 'agent', detail: agentFailure }
    }
    const interrupted = typeof interruptedProbe === 'function' ? interruptedProbe() : interruptedProbe
    if (interrupted === true) return { kind: 'agent', detail: null }
    return { kind: 'none', detail: null }
  }

  /** One-line rendering of an error value that may be a string, Error, or RPC envelope. */
  function errorText(error) {
    if (error === null || error === undefined) return null
    if (typeof error === 'string') return error === '' ? null : error
    const message = typeof error.message === 'string' ? error.message : null
    if (message !== null && message !== '') return message
    try {
      return JSON.stringify(error).slice(0, 200)
    } catch {
      return null
    }
  }

  /**
   * The words that repair a failed turn.
   *
   * A `send` failure never reached the Host, so the original prompt is replayed
   * verbatim — that is the same request, not a paraphrase of it. An `agent`
   * failure may have left tools half-run, so the instruction states that
   * explicitly: the model is told to inspect the current state first and resume
   * from there, which is the difference between finishing the work and redoing
   * it. A bare "continue" is deliberately not used — it reads as new input.
   *
   * @param kind - 'send' or 'agent'.
   * @param t - the locale's string table.
   * @param original - the original prompt text for a send failure, when known.
   * @returns the text to submit.
   */
  function repairPrompt(kind, t, original) {
    if (kind === 'send' && typeof original === 'string' && original !== '') return original
    return t('repairResume')
  }

  // ─── Storage helpers end ───

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
    // Lucide `panel-left` — the footer's sidebar toggle. An outlined panel
    // with the sidebar edge drawn in is the one glyph that says "this side
    // collapses" without a word.
    panelLeft: [
      ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
      ['path', { d: 'M9 3v18' }],
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
    // Lucide `wrench` — the failover button's glyph and the per-row fallback
    // designation mark.
    repair: [
      ['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }],
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
   * The failure store's resting value. A frozen singleton, not a fresh object:
   * `useSyncExternalStore` compares snapshots by identity, so returning a new
   * `{kind:'none'}` on every read would re-render forever.
   */
  const EMPTY_FAILURE = Object.freeze({ kind: 'none', detail: null })

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

  // ─── Brand marks ───
  // The model makers' own logos, so a row says which lab built the model
  // rather than only which letter its supplier happens to start with. These
  // are the published mono cuts — one `currentColor` fill on the 24×24 grid,
  // not redrawn marks — because a full-colour set would put a dozen unrelated
  // brand palettes in a panel whose one accent is the check on the live model.
  //
  // Source: @lobehub/icons-static-svg (MIT), https://github.com/lobehub/lobe-icons.
  // Only the marks a configured route can resolve to are carried; anything
  // else falls back to the supplier initial (see `brandMark`).
  const BRAND_PATHS = {
    deepseek: ['M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z'],
    claude: ['M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z'],
    openai: ['M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z'],
    gemini: ['M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z'],
    grok: ['M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815'],
    qwen: ['M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z'],
    zhipu: ['M11.991 23.503a.24.24 0 00-.244.248.24.24 0 00.244.249.24.24 0 00.245-.249.24.24 0 00-.22-.247l-.025-.001zM9.671 5.365a1.697 1.697 0 011.099 2.132l-.071.172-.016.04-.018.054c-.07.16-.104.32-.104.498-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368 0 .124.018.23.053.337.209.373.54.658.96.8.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711.854.284 1.378 1.226 1.099 2.167a1.661 1.661 0 01-2.077 1.102 1.711 1.711 0 01-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 00-1.954.746 1.66 1.66 0 01-1.065.764 1.677 1.677 0 01-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.51 1.51 0 01.296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.307 1.307 0 00-.227-.693 2.515 2.515 0 01-.366-1.403 2.39 2.39 0 01.366-1.208c.14-.195.21-.444.227-.693.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.43 1.43 0 01-.299-.07l-.05-.019a1.7 1.7 0 01-1.047-2.114 1.68 1.68 0 012.094-1.101zm-5.575 10.11c.26-.264.639-.367.994-.27.355.096.633.379.728.74.095.362-.007.748-.267 1.013-.402.41-1.053.41-1.455 0a1.062 1.062 0 010-1.482zm14.845-.294c.359-.09.738.024.992.297.254.274.344.665.237 1.025-.107.36-.396.634-.756.718-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 01.757-1.26zm-.064-4.39c.314.32.49.753.49 1.206 0 .452-.176.886-.49 1.206-.315.32-.74.5-1.185.5-.444 0-.87-.18-1.184-.5a1.727 1.727 0 010-2.412 1.654 1.654 0 012.369 0zm-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 01-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 011.33-1.038c.593-.08 1.183.169 1.547.652zm11.545-4.221c.368 0 .708.2.892.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.892.524c-.568 0-1.03-.47-1.03-1.048 0-.579.462-1.048 1.03-1.048zm-14.358 0c.368 0 .707.2.891.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.891.524c-.569 0-1.03-.47-1.03-1.048 0-.579.461-1.048 1.03-1.048zm10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705-1.674-.763-1.674-1.705c0-.942.75-1.706 1.674-1.706zm-2.626-.684c.362-.082.653-.356.761-.718a1.062 1.062 0 00-.238-1.028 1.017 1.017 0 00-.996-.294c-.547.14-.881.7-.752 1.257.13.558.675.907 1.225.783zm0 16.876c.359-.087.644-.36.75-.72a1.062 1.062 0 00-.237-1.019 1.018 1.018 0 00-.985-.301 1.037 1.037 0 00-.762.717c-.108.361-.017.754.239 1.028.245.263.606.377.953.305l.043-.01zM17.19 3.5a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64a.631.631 0 00-.628.64c0 .355.28.64.628.64zm-10.38 0a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64a.631.631 0 00-.628.64c0 .355.279.64.628.64zm-5.182 7.852a.631.631 0 00-.628.64c0 .354.28.639.628.639a.63.63 0 00.627-.606l.001-.034a.62.62 0 00-.628-.64zm5.182 9.13a.631.631 0 00-.628.64c0 .355.279.64.628.64a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm10.38.018a.631.631 0 00-.628.64c0 .355.28.64.628.64a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64zm5.182-9.148a.631.631 0 00-.628.64c0 .354.279.639.628.639a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 00.244-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249c0 .142.122.249.244.249zM11.991.497a.24.24 0 00.245-.248A.24.24 0 0011.99 0a.24.24 0 00-.244.249c0 .133.108.236.223.247l.021.001zM2.011 6.36a.24.24 0 00.245-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249.24.24 0 00.244.249zm0 11.263a.24.24 0 00-.243.248.24.24 0 00.244.249.24.24 0 00.244-.249.252.252 0 00-.244-.248zm19.995-.018a.24.24 0 00-.245.248.24.24 0 00.245.25.24.24 0 00.244-.25.252.252 0 00-.244-.248z'],
    kimi: ['M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z', 'M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z'],
    minimax: ['M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z'],
    mimo: ['M.958 15.936a.459.459 0 01.459.44v2.729a.46.46 0 01-.918 0v-2.729a.459.459 0 01.459-.44zm4.814-2.035a.46.46 0 01.553.45v4.754a.458.458 0 11-.918 0V15.48L3.74 17.202a.462.462 0 01-.655.016.462.462 0 01-.065-.082L.628 14.67a.459.459 0 01.658-.637l2.124 2.187 2.127-2.188a.46.46 0 01.235-.13zm2.068.004a.46.46 0 01.458.445v4.755a.46.46 0 01-.458.458.459.459 0 01-.458-.458V14.35a.459.459 0 01.458-.445zm1.973 2.014a.46.46 0 01.46.457v2.729a.46.46 0 01-.784.324.46.46 0 01-.134-.324v-2.729a.46.46 0 01.458-.458zm.002-2.045a.458.458 0 01.328.157l2.127 2.19 2.125-2.19a.459.459 0 01.784.318v4.756a.46.46 0 01-.455.458.46.46 0 01-.458-.458V15.48l-1.667 1.723a.46.46 0 01-.65.008l-.005-.005c0-.002-.002-.002-.004-.003l-2.455-2.534a.46.46 0 01-.008-.667.461.461 0 01.338-.128zm6.797 1.206a.46.46 0 01.53.651A1.966 1.966 0 0019.81 18.4a.462.462 0 01.623.18.46.46 0 01-.181.624 2.863 2.863 0 01-1.38.353l-.142-.004a2.88 2.88 0 01-2.393-4.263.461.461 0 01.274-.21zm.864-.931a2.884 2.884 0 013.915 3.914.46.46 0 01-.402.24l-.057-.004a.458.458 0 01-.164-.055.46.46 0 01-.182-.622 1.967 1.967 0 00-2.669-2.67.459.459 0 11-.441-.803zM9.59 6.368c1.481 0 1.696 1.202 1.696 1.654v2.648h-.917v-.432c-.26.346-.792.535-1.36.535-.133 0-1.289-.03-1.384-1.136-.082-.932.675-1.61 2.053-1.61h.691c0-.563-.367-.886-.983-.886-.44.013-.864.174-1.2.458l-.36-.664c.484-.379 1.012-.567 1.764-.567zm4.427.1c1.263 0 2.082.97 2.083 2.15 0 1.181-.824 2.154-2.083 2.154-1.26 0-2.084-.972-2.084-2.152 0-1.18.82-2.153 2.084-2.153zm6.801.015c.68 0 1.202.465 1.197 1.548v2.642H21.1V8.29c0-.312-.002-.98-.63-.98s-.628.667-.628.838v2.524h-.89V8.148c0-.17-.001-.838-.63-.838-.628 0-.628.668-.628.98v2.383h-.917v-4.03h.917V7a1.22 1.22 0 01.947-.516c.398 0 .76.193.982.686a1.321 1.321 0 011.195-.686zm-18.093.872l1.457-1.772H5.32L3.311 8.07l2.14 2.602H4.24L2.725 8.796 1.21 10.672H0L2.138 8.07.13 5.583h1.138l1.458 1.772zm4.149 3.317h-.916V6.644h.916v4.028zm16.99 0h-.916V6.644h.916v4.028zM9.925 8.71c-1.055 0-1.359.412-1.326.742.032.329.324.537.757.537a1.013 1.013 0 001.014-.968l.002-.31h-.447zM14.018 7.3c-.663 0-1.184.487-1.184 1.32 0 .832.52 1.32 1.184 1.32.662 0 1.182-.49 1.182-1.32 0-.832-.52-1.32-1.182-1.32zM6.417 5.001a.568.568 0 01.587.582.588.588 0 01-1.175 0A.57.57 0 016.417 5zm16.991 0a.57.57 0 01.592.582.588.588 0 01-1.174 0 .57.57 0 01.357-.542.572.572 0 01.225-.04z'],
    hunyuan: ['M12 0c6.627 0 12 5.373 12 12s-5.373 12-12 12S0 18.627 0 12 5.373 0 12 0zm1.652 1.123l-.01-.001c.533.097 1.023.233 1.41.404 6.084 2.683 7.396 9.214 1.601 14.338a3.781 3.781 0 01-5.337-.328 3.654 3.654 0 01-.884-3.044c-1.934.6-3.295 2.305-3.524 4.45-.204 1.912.324 4.044 2.056 5.634l.245.067C10.1 22.876 11.036 23 12 23c6.075 0 11-4.925 11-11 0-5.513-4.056-10.08-9.348-10.877zM2.748 6.21c-.178.269-.348.536-.51.803l-.235.394.078-.167A10.957 10.957 0 001 12c0 4.919 3.228 9.083 7.682 10.49l.214.065C3.523 18.528 2.84 14.149 6.47 8.68A2.234 2.234 0 102.748 6.21zm10.157-5.172c4.408 1.33 3.61 5.41 2.447 6.924-.86 1.117-2.922 1.46-3.708 2.238-.666.657-1.077 1.462-1.212 2.291A5.303 5.303 0 0112 12.258a5.672 5.672 0 001.404-11.169 10.51 10.51 0 00-.5-.052z'],
    longcat: [{ d: 'M.507 19.883a.507.507 0 01-.489-.642L4.29 3.745a1.013 1.013 0 011.533-.578l5.622 3.687a1.013 1.013 0 001.11 0L18.2 3.165a1.013 1.013 0 011.532.58l4.25 15.497a.506.506 0 01-.49.64H18.07a6.297 6.297 0 001.53-4.115v-.177a6.09 6.09 0 00-1.513-4.017l-.697-3.495a.438.438 0 00-.694-.266L14.07 9.781a.748.748 0 01-.654.121 5.156 5.156 0 00-2.833 0 .746.746 0 01-.653-.121L7.302 7.81a.435.435 0 00-.688.269l-.675 3.652a5.36 5.36 0 00-1.539 3.76v.333c0 1.474.527 2.9 1.488 4.02l.032.038H.507z', clipRule: 'evenodd' }, 'M9.213 16.843h1.52v-3.546h-1.29l-.23 3.546zm5.573 0h-1.52v-3.546h1.29l.23 3.546z'],
    stepfun: ['M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM8.762 19.614H4.376v-4.386h4.386v4.386zm5.423 0H9.798v-4.386h4.387v4.386zm0-5.42H9.798V9.81h4.387v4.386zm0-5.418H9.798V4.39h4.387v4.386zm5.422-.004h-4.386V4.386h4.386v4.386z'],
    mistral: [{ d: 'M3.428 3.4h3.429v3.428h3.429v3.429h-.002 3.431V6.828h3.427V3.4h3.43v13.714H24v3.429H13.714v-3.428h-3.428v-3.429h-3.43v3.428h3.43v3.429H0v-3.429h3.428V3.4zm10.286 13.715h3.428v-3.429h-3.427v3.429z', clipRule: 'evenodd' }],
    meta: ['M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z'],
    nvidia: ['M10.212 8.976V7.62c.127-.01.256-.017.388-.021 3.596-.117 5.957 3.184 5.957 3.184s-2.548 3.647-5.282 3.647a3.227 3.227 0 01-1.063-.175v-4.109c1.4.174 1.681.812 2.523 2.258l1.873-1.627a4.905 4.905 0 00-3.67-1.846 6.594 6.594 0 00-.729.044m0-4.476v2.025c.13-.01.259-.019.388-.024 5.002-.174 8.261 4.226 8.261 4.226s-3.743 4.69-7.643 4.69c-.338 0-.675-.031-1.007-.092v1.25c.278.038.558.057.838.057 3.629 0 6.253-1.91 8.794-4.169.421.347 2.146 1.193 2.501 1.564-2.416 2.083-8.048 3.763-11.24 3.763-.308 0-.603-.02-.894-.048V19.5H24v-15H10.21zm0 9.756v1.068c-3.356-.616-4.287-4.21-4.287-4.21a7.173 7.173 0 014.287-2.138v1.172h-.005a3.182 3.182 0 00-2.502 1.178s.615 2.276 2.507 2.931m-5.961-3.3c1.436-1.935 3.604-3.148 5.961-3.336V6.523C5.81 6.887 2 10.723 2 10.723s2.158 6.427 8.21 7.015v-1.166C5.77 16 4.25 10.958 4.25 10.958h-.002z'],
    cursor: ['M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z'],
    qoder: ['M23.376 14.458v-4.056c0-2.304-1.003-4.154-2.748-5.075L11.612.574l-.046.086-.045.086c1.68.886 2.644 2.673 2.644 4.902v4.056a7.928 7.928 0 01-.014.454l-.005.061c-.005.081-.01.164-.018.245a4.897 4.897 0 01-.011.1l-.01.076c-.008.068-.015.135-.025.203l-.018.113-.01.058a9.99 9.99 0 01-.098.513l-.007.03a7.209 7.209 0 01-.074.294l-.024.086c-.027.099-.056.197-.087.296l-.027.085a9.592 9.592 0 01-.111.323l-.033.085-.018.046c-.032.082-.064.166-.098.248-.019.048-.04.096-.061.145l-.007.017a6 6 0 01-.084.187c-.024.056-.05.11-.077.165-.03.061-.058.122-.089.182a9.423 9.423 0 01-.176.332c-.03.056-.062.111-.094.167-.031.053-.062.108-.095.16-.033.055-.066.11-.101.164-.033.053-.065.104-.1.155-.034.055-.07.107-.111.169l-.099.144a15.193 15.193 0 01-.34.457c-.04.05-.08.102-.121.151l-.107.128-.007.008a6.987 6.987 0 01-.262.298l-.149.16-.116.12a9.562 9.562 0 01-.204.198l-.03.03-.072.069a9.05 9.05 0 01-.263.235l-.025.022-.029.026-.042.035a11.7 11.7 0 01-.22.18l-.07.055-.018.013a8.904 8.904 0 01-.194.146c-.029.02-.057.042-.086.063a7.7 7.7 0 01-.22.152l-.057.04a8.865 8.865 0 01-.293.185l-.062.037a10.424 10.424 0 01-.307.173l-.037.02-.196.103-.108.052-.012.006a6.196 6.196 0 01-.315.143c-.065.028-.13.054-.196.08l-.035.014-.086.034c-.07.026-.143.05-.215.075l-.039.014-.064.023a8.056 8.056 0 01-.323.097l-.63.173a7.285 7.285 0 01-.33.08l-.07.015c-.053.012-.104.023-.157.032l-.065.011-.085.015a2.332 2.332 0 01-.194.027l-.085.01a4.715 4.715 0 01-.16.018l-.034.003a4.861 4.861 0 01-.246.016h-.033a2.714 2.714 0 01-.155.005h-.106a3.384 3.384 0 01-.225-.007H4.86l-.15-.012-.066-.006a5.586 5.586 0 01-.187-.02l-.04-.005a5.14 5.14 0 01-.219-.035l-.054-.01a6.943 6.943 0 01-.347-.082l-.03-.008-.038-.01a5.034 5.034 0 01-.269-.086l-.063-.023a4.216 4.216 0 01-.188-.073l-.071-.031-.016-.007a4.959 4.959 0 01-.16-.074l-.026-.013a.164.164 0 00-.014-.007l-.671-.351.486.486h.016l8.995 4.742.093.048.03.014.02.01c.056.026.111.052.169.076l.016.008.073.032.195.076.022.008a.718.718 0 01.03.012l.014.004a4.693 4.693 0 00.323.1l.027.007c.073.02.147.038.22.055l.018.004.027.006.066.013.088.016c.075.014.15.026.226.038l.042.004c.064.009.128.016.193.022l.126.012.06.003.05.002.098.005c.046.002.094.002.14.003h.12c.05 0 .1-.002.161-.005h.033l.07-.004a6.17 6.17 0 00.184-.014l.033-.003a.753.753 0 00.058-.005l.108-.012.081-.01.08-.01.129-.021.082-.014.071-.012c.054-.01.107-.021.16-.033l.066-.013.059-.013c.096-.022.192-.046.287-.073l.63-.172a7.354 7.354 0 00.397-.122l.04-.015c.075-.025.149-.051.222-.078.032-.011.062-.024.093-.037l.03-.012c.067-.027.135-.054.2-.082l.128-.056.195-.09.021-.01.102-.05c.068-.034.135-.069.202-.105l.037-.02.073-.038c.08-.044.16-.092.24-.139l.026-.015a8.086 8.086 0 00.322-.2l.065-.045 1.98.902a1.748 1.748 0 002.472-1.59v-7.33l.004.004z', 'M11.617.576a3.904 3.904 0 00-.093-.047c-.016-.009-.033-.016-.05-.024a5.854 5.854 0 00-.166-.077l-.09-.04a4.094 4.094 0 00-.194-.074c-.017-.006-.035-.015-.053-.02l-.013-.005a5.18 5.18 0 00-.277-.088l-.07-.019a4.034 4.034 0 00-.219-.053c-.015-.003-.03-.008-.044-.012L10.253.1l-.057-.011a5.177 5.177 0 00-.225-.036L9.928.047a5.972 5.972 0 00-.191-.022L9.669.02a1.33 1.33 0 00-.058-.005L9.515.009a4.058 4.058 0 00-.111-.005C9.354 0 9.304 0 9.254 0h-.109c-.052 0-.106.004-.16.004L8.884.01A5.32 5.32 0 008.7.022l-.083.006h-.008c-.05.005-.1.013-.15.019l-.12.014c-.056.008-.112.018-.169.028-.037.006-.074.011-.11.018a7.054 7.054 0 00-.572.133l-.63.172c-.111.031-.22.064-.33.1-.037.011-.072.025-.108.037a12.91 12.91 0 00-.345.126c-.067.027-.133.054-.2.083l-.128.055a11.916 11.916 0 00-.318.15 7.376 7.376 0 00-.311.163c-.082.045-.16.092-.24.14a9.424 9.424 0 00-.35.218l-.016.01-.06.04a9.242 9.242 0 00-.51.37 12.54 12.54 0 00-.315.254l-.043.034-.01.007-.045.041c-.09.078-.18.158-.268.24l-.106.101c-.07.067-.139.135-.207.204l-.056.054-.063.067-.153.164-.12.133-.148.17c-.024.03-.049.057-.073.086l-.043.053a5.96 5.96 0 00-.123.155l-.118.151c-.04.053-.08.106-.118.16l-.075.101-.038.056-.107.155-.11.164a9.91 9.91 0 00-.168.265c-.012.02-.023.043-.037.063a12.43 12.43 0 00-.192.335l-.09.168c-.019.034-.04.07-.057.105-.011.022-.02.043-.032.065l-.092.188-.08.167a19.15 19.15 0 00-.083.192c-.017.038-.035.076-.05.115-.008.016-.014.034-.021.051-.035.083-.067.167-.1.253l-.051.134c-.04.11-.077.22-.113.33l-.02.057c0 .002 0 .005-.002.007l-.008.026c-.032.1-.06.2-.09.301l-.023.089c-.027.1-.052.2-.075.301l-.007.03a7.63 7.63 0 00-.057.267l-.008.048c-.015.074-.026.148-.038.223L.082 8.4c-.011.078-.02.156-.029.234-.006.051-.013.103-.017.154a6.57 6.57 0 00-.02.26c-.003.044-.007.086-.009.13-.004.128-.007.257-.007.386v4.056c0 1.478.42 2.741 1.138 3.692A4.75 4.75 0 002.73 18.67l9.015 4.753c-1.656-.874-2.728-2.685-2.73-5.051v-4.056c0-.13.004-.26.01-.39.002-.043.006-.085.01-.128.005-.088.01-.174.019-.261l.017-.155c.01-.077.018-.155.029-.234l.026-.164c.013-.074.025-.15.039-.223.02-.105.04-.21.064-.313l.008-.031c.023-.1.048-.201.075-.301l.023-.088c.028-.1.058-.202.09-.302l.008-.025.021-.063c.036-.11.073-.22.113-.33l.052-.134c.031-.085.065-.169.1-.253.022-.056.047-.111.07-.166a13.856 13.856 0 01.164-.358c.03-.063.06-.126.092-.188l.088-.172a9.22 9.22 0 01.187-.338l.096-.164c.034-.057.069-.112.104-.168l.1-.159a10.49 10.49 0 01.567-.786l.123-.155.116-.139c.05-.057.098-.115.148-.171a14.092 14.092 0 01.272-.297 9.706 9.706 0 01.432-.425c.088-.083.177-.163.268-.241l.054-.048a10.08 10.08 0 01.553-.435l.092-.068c.075-.053.15-.105.226-.156.019-.013.038-.028.06-.04a9.18 9.18 0 01.362-.227c.08-.047.16-.094.241-.139l.11-.058a7.643 7.643 0 01.521-.256l.126-.056a7.509 7.509 0 01.546-.208l.107-.037c.11-.036.22-.069.33-.1l.63-.172c.095-.026.191-.05.287-.072l.097-.02c.062-.014.125-.029.187-.04l.114-.018c.055-.01.11-.02.166-.028.04-.006.08-.01.12-.014.053-.007.105-.014.157-.019l.083-.006c.061-.005.123-.01.184-.013.034-.003.067-.003.101-.004l.16-.006h.11a3.187 3.187 0 01.261.008l.153.01.067.007c.064.006.128.013.192.022l.043.005a5.232 5.232 0 01.281.047l.141.03c.073.016.146.035.218.053l.07.019c.094.026.187.055.278.087l.067.025a4.326 4.326 0 01.449.19l.143.072L11.617.576z'],
    trae: ['M24 20.541H3.428v-3.426H0V3.4h24V20.54zM3.428 17.115h17.144V6.827H3.428v10.288zm8.573-5.196l-2.425 2.424-2.424-2.424 2.424-2.424 2.425 2.424zm6.857-.001l-2.424 2.423-2.425-2.423 2.425-2.425 2.424 2.425z'],
    opencode: ['M16 6H8v12h8V6zm4 16H4V2h16v20z'],
    zai: ['M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z'],
  }

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
   * Which maker a row should wear, as a {@link BRAND_PATHS} key, or null when
   * no mark can be named honestly.
   *
   * The mark belongs to the MODEL's maker, not to the supplier: `17an-mumiao`
   * and `qwen-token-plan-cn` both serve `deepseek-v4-flash`, and the question a
   * row answers is "what am I picking" — a per-supplier mark would answer "who
   * resells it" and, worse, could only ever be a letter for the three `17an`
   * floors. The model id is the authoritative field (it is what the route sends
   * upstream); the display name is the fallback, because some providers ship
   * rows with no `name` at all.
   *
   * The match is deliberately a fixed prefix list rather than a generic "first
   * word": `mimo` and `hy3` are real model families whose ids carry no lab in
   * them, and a rule loose enough to guess those would also hand `auto` and
   * `default-model` a logo they have not earned. An unnamed family keeps the
   * supplier initial, which is a claim the panel can always back up.
   *
   * @param model - the catalog model row (`id` and optional `name`).
   */
  const BRAND_PREFIXES = [
    ['deepseek', 'deepseek'],
    ['claude', 'claude'],
    ['opus', 'claude'],
    ['sonnet', 'claude'],
    ['haiku', 'claude'],
    ['fable', 'claude'],
    ['gpt', 'openai'],
    ['codex', 'openai'],
    ['gemini', 'gemini'],
    ['grok', 'grok'],
    ['qwen', 'qwen'],
    ['glm', 'zhipu'],
    ['chatglm', 'zhipu'],
    // `hy3` is Hunyuan 3 and nothing else in this catalog starts with it, so the
    // family abbreviation is the whole rule (Tencent-Hunyuan/Hy3). It is spelled
    // `hy3`/`hy4` rather than a bare `hy` so that an unrelated `hyper…` model
    // added later cannot silently inherit Tencent's mark.
    ['hy3', 'hunyuan'],
    ['hy4', 'hunyuan'],
    ['hunyuan', 'hunyuan'],
    ['kimi', 'kimi'],
    ['moonshot', 'kimi'],
    ['minimax', 'minimax'],
    ['mimo', 'mimo'],
    ['longcat', 'longcat'],
    ['step', 'stepfun'],
    ['nemotron', 'nvidia'],
    ['mistral', 'mistral'],
    ['composer', 'cursor'],
    // `llama` is Meta's family rather than a chat-tuned name, so the mark goes
    // on the family. It is carried because the table would otherwise hold a mark
    // no prefix can reach — a mark nobody can see is worse than no mark.
    ['llama', 'meta'],
  ]

  /**
   * The HOSTS whose name can ride in a label, and the mark that name earns.
   *
   * This is the second rule, and it exists because a row like `Composer 2.5 ·
   * Cursor` names no lab in its model segment — the only brand in the label is
   * the host serving it. So the whole label is scanned, not just the leading
   * token.
   *
   * The order between the two rules is the whole design: LAB FIRST, host only
   * as a fallback. `cursor/grok-4.7` is Grok's model resold through Cursor, and
   * `trae-cn/deepseek-v4.1-flash` is DeepSeek's through Trae — reading the host
   * first would relabel both of them, which is exactly the mistake a mark is
   * meant to prevent. A host mark therefore only ever appears on a row whose
   * model segment named no lab at all.
   *
   * Host names are matched as WHOLE WORDS (`\bcursor\b`), not prefixes: `trae`
   * must not fire on a hypothetical `traefik`, and a host is a token in the
   * label rather than the beginning of a model family.
   */
  const BRAND_HOSTS = [
    ['cursor', 'cursor'],
    ['qoder', 'qoder'],
    ['trae', 'trae'],
    ['opencode', 'opencode'],
    ['z.ai', 'zai'],
  ]

  /** The lowercased label as word/slash/colon/dash-separated tokens. */
  function labelTokens(field) {
    return field.trim().toLowerCase().split(/[^a-z0-9.]+/u).filter((token) => token !== '')
  }

  function brandOf(model) {
    // The id first, then the name: an id is machine-written and stable, a name
    // is free text a provider may localise or decorate.
    const fields = [model?.id, model?.name].filter((field) => typeof field === 'string')
    if (fields.length === 0) return null

    // Rule 1 — the lab, read from the leading token of any segment. `vendor/…`,
    // `vendor:…` and `vendor_…` all occur, so every segment is tried: the token
    // after the separator is the one naming the model, and `17an-db/deepseek-…`
    // (a supplier, a slash, then a model) must still resolve.
    for (const field of fields) {
      for (const token of field.trim().toLowerCase().split(/[/:_]/u)) {
        const bare = token.replace(/^[^a-z0-9]+/u, '')
        for (const [prefix, brand] of BRAND_PREFIXES) {
          if (bare.startsWith(prefix)) return brand
        }
      }
    }

    // Rule 2 — the host, read from anywhere in the label as a whole word, and
    // only once rule 1 has found no lab of its own.
    for (const field of fields) {
      const tokens = labelTokens(field)
      for (const [host, brand] of BRAND_HOSTS) {
        if (tokens.includes(host)) return brand
      }
    }
    return null
  }

  /**
   * One brand mark, or null when the model's maker cannot be named. Drawn on
   * the 24×24 grid the package publishes, with the two presentation attributes
   * its mono cuts rely on: `fillRule="evenodd"` (every mark in the set declares
   * it, and dropping it would fill the counters of an outline like Qwen's) and
   * a per-path `clipRule` for the two marks that carry one. Filled with
   * `currentColor`, so the mark takes the surrounding ink — dark on a light
   * theme, light on a dark one — exactly like the glyphs beside it.
   */
  function brandMark(brand, size) {
    const paths = brand === null ? undefined : BRAND_PATHS[brand]
    if (paths === undefined) return null
    return h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor',
      fillRule: 'evenodd', 'aria-hidden': true, focusable: 'false',
    }, paths.map((path, index) => h('path', typeof path === 'string'
      ? { key: index, d: path }
      : { key: index, d: path.d, clipRule: path.clipRule })))
  }

  /**
   * The supplier's leading character on its own curated tint: the floor mark in
   * the provider column, and the fallback for a model whose maker cannot be
   * named. The floors keep the letter because a floor names a SUPPLIER — and
   * the three `17an` floors differ by nothing else — while the model list next
   * to it names makers, which have marks of their own.
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
   * The model row's avatar: the model maker's own mark when one is known, and
   * the supplier's tinted initial when it is not. Rendered both ahead of a model
   * name in the list and on the closed trigger, so which model is in use — and
   * whose it is — reads before the picker is opened. Either way it carries no
   * meaning to a screen reader (the supplier and model are already named in the
   * tooltip and the row detail), so it is hidden from the accessibility tree.
   *
   * The two shapes are deliberately different: a mark is a lab, a tinted
   * uppercase letter is "the picker cannot name this row's maker", which is the
   * honest answer for a routing group, a reseller's own model, or a family this
   * table has never heard of.
   */
  function modelAvatar(provider, model, order) {
    const mark = brandMark(brandOf(model), 14)
    if (mark !== null) {
      // No `title` here, deliberately: the mark sits inside a button that
      // already names its supplier and model, and a nested title would win the
      // hover and replace that fuller answer with the bare brand.
      return h('span', { className: 'dsh-mp2-avatar dsh-mp2-avatarBrand', 'aria-hidden': true }, mark)
    }
    return supplierChip(provider, order)
  }

  /**
   * The row's fact strip: vision glyph + context-window chip.
   *
   * Vision has two states that are NOT the same capability: a route whose
   * model reads pixels itself (native), and a modlens bridge route, where the
   * model still cannot see — modlens transcribes the image to text first.
   * `bridged` marks the second, so the glyph can say which.
   */
  /**
   * The vision mark on its own, because it does not belong with the trailing
   * facts: image input is a property OF the model, so it rides after the model
   * name, while the context window is a number you compare down the column.
   */
  function ModelVision({ facts, bridged }) {
    const image = bridged || (Array.isArray(facts?.input) && facts.input.includes('image'))
    if (!image) return null
    return h('span', {
      className: 'dsh-mp2-image' + (bridged ? ' dsh-mp2-imageBridged' : ''),
      title: bridged ? t('imageBridged') : t('imageNative'),
    }, bridged ? IMAGE_GLYPH_BRIDGED : IMAGE_GLYPH)
  }

  /** The row's trailing fact: the context-window chip, one comparable column. */
  function ModelFacts({ facts }) {
    const context = formatContext(facts?.contextWindow)
    if (context === null) return null
    return h('span', { className: 'dsh-mp2-facts' },
      h('span', { className: 'dsh-mp2-context', title: t('contextWindow') }, context),
    )
  }

  /**
   * One selectable model row: name, favorite toggle, fact strip, check mark.
   *
   * The row is a `<button>`, so the star is a focusable span that stops the
   * click from reaching it — clicking a star must never also pick the model.
   */
  function ModelRow({ id, group, provider, model, detail, selected, active, busy, favorite, facts, bridged, order, onToggle, onChoose, isFallback, onSetFallback }) {
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
          modelAvatar(chip, model, order),
          h('span', { className: 'dsh-mp2-modelName' }, model.name),
          // The row then reads as a name followed by its marks: what the model
          // accepts first, then the actions you can take on it. So the vision
          // mark comes first, then the failover mark, then the star.
          h(ModelVision, { facts, bridged }),
          // The failover mark says "this route is the one switch-to-repair
          // lands on". It is a second toggle in the same slot as the star and
          // follows the same rules: reserved space, shown at rest only when it
          // is on, and reachable by keyboard.
          onSetFallback !== undefined && h('span', {
            className: 'dsh-mp2-pin' + (isFallback ? ' dsh-mp2-pinOn' : ''),
            role: 'button',
            tabIndex: 0,
            'aria-pressed': isFallback === true,
            'aria-label': (isFallback ? t('repairFallbackClear') : t('repairFallbackSet')) + '：' + model.name,
            title: isFallback ? t('repairFallbackClear') : t('repairFallbackSet'),
            onClick: (event) => { event.stopPropagation(); onSetFallback() },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              onSetFallback()
            },
          }, icon('repair', 13)),
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
      h(ModelFacts, { facts }),
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

  /**
   * The switch-to-repair port for one session seat.
   *
   * The component is presentational about this: it reads the session's failure
   * state as a subscribable store, and asks for the repair to be submitted.
   * Everything that touches the session controller — retention, subscription,
   * snapshot reads, prompt submission and the release — stays in this closure,
   * so a controller change is one edit here rather than one in every call site.
   *
   * The store is the reason the UI can be absent when nothing is wrong. It holds
   * the Session's own `subscribe`/`getSnapshot` pair, so a failure raises the
   * repair control the moment the Host reports it and the control disappears the
   * moment `prompt()` clears the error — no polling, and nothing rendered on a
   * healthy session.
   *
   * Retention is reference-counted and tied to the listener count: the Session is
   * retained when the component subscribes and released when it unmounts, so a
   * seat that never renders never retains anything and no scope is leaked.
   *
   * @param ctx - the plugin's inject scope, which carries `sessions`.
   * @param sessionId - the Session this seat renders for.
   * @returns `{failureStore, readOriginalPrompt, submitRepair}`, all safe to call
   *   when the controller is absent or the session has gone away.
   */
  function makeRepairPort(ctx, sessionId) {
    const NONE = { kind: 'none', detail: null }
    /** Listeners on the failure store; retained while non-empty. */
    const listeners = new Set()
    /** The retained reference, or undefined while nobody is listening. */
    let reference
    /** The last classification, cached so `getSnapshot` stays referentially stable. */
    let cached = NONE
    /** The Session's unsubscribe, once subscribed. */
    let detach
    /** A failure already submitted for, so a re-notification cannot resend it. */
    let submitted = null

    /** Read the live classification, treating any controller fault as "no failure". */
    const classifyNow = () => {
      try {
        const session = reference?.binding?.session
        if (session === undefined) return NONE
        return classifyFailure(session.getSnapshot(), () => lastMessageInterrupted(session))
      } catch {
        return NONE
      }
    }

    /** Re-read and, when it changed, wake the component. */
    const refresh = () => {
      const next = classifyNow()
      if (next.kind === cached.kind && next.detail === cached.detail) return
      cached = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // A listener fault must not stop the others from being told.
        }
      }
    }

    /** Retain the Session and start following its notifications. */
    const attach = () => {
      if (reference !== undefined) return
      try {
        reference = ctx.sessions.retain(sessionId, { source: 'dsh-model-picker' })
      } catch {
        reference = undefined
        return
      }
      try {
        const session = reference.binding?.session
        if (typeof session?.subscribe === 'function') detach = session.subscribe(refresh)
      } catch {
        // Without a subscription the store still answers once, on demand.
        detach = undefined
      }
      // The first read is deferred until `ready` settles: before the Session has
      // opened, its snapshot legitimately reports no failure.
      Promise.resolve(reference.ready)
        .then(refresh, () => { /* an unopened Session simply reports none */ })
    }

    /** Drop the subscription and the retained reference. */
    const detachAll = () => {
      try {
        detach?.()
      } catch {
        // Already torn down by the controller.
      }
      detach = undefined
      try {
        reference?.release()
      } catch {
        // Already released by the controller's own teardown.
      }
      reference = undefined
    }

    return {
      /**
       * The failure state as a `useSyncExternalStore` store. Subscribing is what
       * retains the Session; the last unsubscribe releases it.
       */
      failureStore: {
        subscribe: (listener) => {
          listeners.add(listener)
          if (listeners.size === 1) attach()
          else refresh()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) {
              detachAll()
              cached = NONE
            }
          }
        },
        getSnapshot: () => cached,
      },

      /**
       * The text of the newest user message, for replaying a turn that never
       * left the client. Read from the session's own log rather than scraped
       * from the composer: the log is what the Host actually received, and it
       * still holds the words after the composer has been cleared.
       * @returns the text, or null when it cannot be recovered.
       */
      readOriginalPrompt: () => {
        try {
          return lastUserText(reference?.binding?.session)
        } catch {
          return null
        }
      },

      /**
       * Submit the repair for the current failure, once.
       *
       * The one-shot guard is keyed on the failure itself rather than on the
       * switch, so a burst of session notifications cannot submit the same repair
       * twice; a rejected submission clears the guard so a later attempt works.
       *
       * @param kind - 'send' or 'agent'.
       * @param text - the words to submit.
       * @returns whether the Host accepted the prompt.
       */
      submitRepair: async (kind, text) => {
        const stamp = kind + ':' + (cached.detail ?? '')
        if (submitted === stamp) return false
        submitted = stamp
        try {
          const session = reference?.binding?.session
          if (session === undefined) return false
          // `queue` appends behind anything still finishing; it never interrupts
          // a live turn, which is what makes a repair safe here.
          const result = await session.prompt([{ type: 'text', text }], 'queue')
          const ok = result !== null && result !== undefined && result.ok === true
          if (!ok) submitted = null
          return ok
        } catch {
          submitted = null
          return false
        }
      },
    }
  }

  /**
   * The text of the newest user message in a session's folded log.
   *
   * A `send` failure never reached the Host, so the words to replay are the
   * ones the client last tried to submit. They are read from the log rather
   * than from the composer because the composer is cleared on submit, and the
   * log is the record of what was actually sent.
   *
   * @param session - a live Session.
   * @returns the concatenated text blocks, or null when nothing is recoverable.
   */
  function lastUserText(session) {
    try {
      const list = foldedEvents(session)
      if (list === undefined) return null
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const event = list[i]?.event ?? list[i]
        if (event?.type !== 'user/message') continue
        const message = event.data?.message ?? event.data
        const content = message?.content
        if (!Array.isArray(content)) return null
        const text = content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim()
        return text === '' ? null : text
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * A session's folded event list, however its store spells it.
   * @param session - a live Session.
   * @returns the array, or undefined when the log is not readable.
   */
  function foldedEvents(session) {
    const events = session?.events
    if (events === undefined || events === null) return undefined
    const snapshot = typeof events.getSnapshot === 'function' ? events.getSnapshot() : undefined
    const list = snapshot?.events ?? snapshot
    return Array.isArray(list) ? list : undefined
  }

  /**
   * Whether the newest assistant message in a session's folded log was
   * interrupted, which is how a mid-turn stop presents when the Agent never
   * raised an error of its own.
   * @param session - a live Session.
   * @returns true, false, or undefined when the log cannot be read.
   */
  function lastMessageInterrupted(session) {
    try {
      const list = foldedEvents(session)
      if (list === undefined) return undefined
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const event = list[i]?.event ?? list[i]
        if (event?.type !== 'assistant/message') continue
        return event.data?.interrupted === true
      }
      return undefined
    } catch {
      return undefined
    }
  }

  // ─── Main component ───
  function ModelPicker(props) {
    const locked = props.locked
    const available = props.available
    const directory = props.directory
    const load = props.load
    const select = props.select
    // Switch-to-repair: the failure reader and repair submitter for this seat.
    // Absent on a carrier that does not supply one, in which case the switch
    // simply stays a plain switch.
    const repairPort = props.repair
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
    // Folded away by default? No: the column is the panel's map, and a map the
    // user never asked to lose should be there on the first open.
    const [providersHidden, setProvidersHidden] = useState(readProvidersHidden)
    // Runtime facts keyed `provider/modelId`; null until the one fetch lands.
    const [facts, setFacts] = useState(null)
    // Switch-to-repair. The designated fallback route is the whole setting —
    // there is no on/off flag, because the failure itself is the switch. Read at
    // mount like the other browser-local preferences, then written on every edit.
    const [fallbackRoute, setFallbackRoute] = useState(readFallbackRoute)
    // The live failure, subscribed from the session. `none` on a healthy session,
    // which is what keeps the repair button out of the way entirely.
    const failure = useSyncExternalStore(
      repairPort?.failureStore?.subscribe ?? (() => () => {}),
      repairPort?.failureStore?.getSnapshot ?? (() => EMPTY_FAILURE),
    )
    // The last failed attempt's message, so a rejected repair is not silent.
    const [repairError, setRepairError] = useState(null)
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
      // An empty favorites group is not rendered, exactly like an empty
      // history: a heading with nothing under it is a promise the panel cannot
      // keep, and the group reappears the moment a model is starred.
      ...(favoriteRows.length === 0 ? [] : [{ id: FAVORITES_TAB, name: t('favorites'), models: favoriteRows }]),
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

    // --- Failover designation ---
    // One route at a time: picking a new fallback replaces the old, and
    // clicking the marked route clears it. Stored as `provider/modelId`, the
    // same keying as the favorites, so one model id served by two providers
    // designates exactly the route the user pointed at.
    const toggleFallback = (group, model) => {
      const route = group.id + '/' + model.id
      setFallbackRoute((previous) => {
        const next = previous === route ? null : route
        writeFallbackRoute(next)
        return next
      })
    }
    /** Whether this row is the designated fallback. */
    const isFallback = (group, model) => fallbackRoute === group.id + '/' + model.id

    // --- Failover: one click switches the model AND sends the repair ---
    //
    // This is the whole feature in one action. The button only exists while the
    // failure store reports a live failure and a fallback route is designated, so
    // reaching this function already means the user asked for it by clicking.
    //
    // The order matters: the switch is committed first and awaited, because
    // sending the repair onto the old model would repair in exactly the place
    // that just failed. If the switch does not take, nothing is sent.
    /**
     * Commit the fallback model, then submit the repair for the live failure.
     * @returns whether the repair was accepted by the Host.
     */
    const runFailover = async () => {
      const repair = repairPort
      if (repair === null || repair === undefined) return false
      if (fallbackRoute === null) return false
      if (failure.kind === 'none') return false
      setRepairError(null)
      // The fallback may name a route this session no longer lists (provider
      // uninstalled, model retired). Switching to it would fail, so say so
      // instead of sending the work nowhere.
      const target = fallbackTarget()
      if (target === null) {
        setRepairError(t('repairStaleFallback'))
        return false
      }
      lastActionRef.current = 'select'
      const accepted = await select({
        provider: target.group.id,
        model: target.model.id,
        ...(target.effort === undefined ? {} : { reasoningEffort: target.effort }),
      })
      if (!accepted) {
        setRepairError(t('selectFailed'))
        return false
      }
      // A send failure never reached the Host, so the exact words are replayed
      // from the log; an agent failure may have left work half-done, so the
      // instruction names that and asks for resumption instead.
      try {
        const original = failure.kind === 'send' ? await repair.readOriginalPrompt() : null
        const ok = await repair.submitRepair(failure.kind, repairPrompt(failure.kind, t, original))
        if (!ok) setRepairError(t('repairActionFailed') + (failure.detail ?? t('selectFailed')))
        return ok
      } catch {
        setRepairError(t('repairActionFailed') + (failure.detail ?? ''))
        return false
      }
    }

    /**
     * Resolve the designated fallback route against the models this session
     * currently lists, carrying the reasoning effort of the model being left so
     * the rescue keeps the user's setting where the two share an effort scale.
     * @returns `{group, model, effort}`, or null when the route is not listed.
     */
    const fallbackTarget = () => {
      if (fallbackRoute === null) return null
      const slash = fallbackRoute.indexOf('/')
      if (slash <= 0) return null
      const providerId = fallbackRoute.slice(0, slash)
      const modelId = fallbackRoute.slice(slash + 1)
      for (const group of state.groups) {
        if (group.id !== providerId) continue
        for (const model of group.models) {
          if (model.id !== modelId) continue
          const effort = (current !== null && current.provider === group.id)
            ? current.reasoningEffort
            : model.reasoning?.defaultEffort
          return { group, model, effort }
        }
      }
      return null
    }

    /**
     * The fallback's display name, resolved from the session's own model list so
     * the button names the model it will switch to rather than showing a raw
     * route. Null when the route is not currently listed.
     */
    const fallbackLabel = (() => {
      const target = fallbackTarget()
      if (target === null) return null
      return target.model.name ?? target.model.id
    })()

    /**
     * Whether the failover button is offered at all. Both halves are required: a
     * live failure to repair, and a model designated to repair it with. With
     * either missing the control is absent — which is what keeps this out of the
     * way for the ordinary case, and what makes "no fallback set" mean no button
     * rather than a button that cannot act.
     */
    const showFailover = failure.kind !== 'none' && fallbackRoute !== null

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
              // A stale failure message would describe an older attempt than the
              // one the panel is about to make; the live failure itself still
              // drives the failover button.
              setRepairError(null)
              setQuery('')
              lastActionRef.current = 'load'
              reload()
            }
          },
        },
          currentChoice !== null && modelAvatar(currentProvider, currentChoice.model, providerOrder),
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

      // ─── Failover prompt ───
      //
      // The whole visibility rule: this exists only while a failure is live AND
      // a fallback route is designated. On a healthy session nothing renders at
      // all, so ordinary model switching never sees it. It sits outside the popup
      // (the popup is not open at failure time) and above the composer row, the
      // way a suggested action does.
      //
      // One click does both halves — switch to the fallback, then send the repair
      // — because that pair is what the user actually wants and splitting it into
      // two steps is the retyping this feature exists to remove.
      showFailover && h('div', { className: 'dsh-mp2-failover' },
        h('button', {
          type: 'button',
          className: 'dsh-mp2-failoverBtn',
          title: t('repairAction') + '：' + fallbackLabel,
          onClick: () => { void runFailover() },
        },
          icon('repair', 13),
          h('span', null, failure.kind === 'agent' ? t('repairActionAgent') : t('repairAction')),
          fallbackLabel !== null && h('span', { className: 'dsh-mp2-failoverTarget' }, fallbackLabel),
        ),
        // The message is the live region, not the button's box: a status role
        // around interactive content is invalid and reads badly.
        repairError !== null && h('span', { className: 'dsh-mp2-failoverError', role: 'status' }, repairError),
      ),

      // ─── Model picker popup ───
      openKind === 'model' && h('div', {
        className: 'dsh-mp2-menu' + (providersHidden ? ' dsh-mp2-menuFolded' : ''),
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
            // 收藏 floor — a mirrored copy at the top of the model list. It
            // goes with its group: a floor whose group is not rendered would
            // scroll the list to a section that does not exist.
            favoriteRows.length > 0 && h('button', {
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
                            isFallback: isFallback(group, model),
                            onSetFallback: () => { toggleFallback(group, model) },
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
                            // The heading is the label alone. It used to wear an
                            // icon (a clock for the history, one building glyph
                            // for every supplier and the favorites alike) which
                            // told the reader nothing: a building does not mean
                            // "supplier", and the favorites group wore it too.
                            h('div', { className: 'dsh-mp2-groupHeader' }, g.name),
                            g.models.length === 0
                              ? h('div', { className: 'dsh-mp2-empty' },
                                  t('providerEmpty'))
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
                                    isFallback: isFallback(group, model),
                                    onSetFallback: () => { toggleFallback(group, model) },
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
          // The fold control leads the row: it belongs to the column it folds,
          // and that column is on the left, so the button is too.
          h('button', {
            type: 'button',
            className: 'dsh-mp2-footerIcon',
            title: providersHidden ? t('showProviders') : t('hideProviders'),
            'aria-label': providersHidden ? t('showProviders') : t('hideProviders'),
            'aria-expanded': !providersHidden,
            onClick: () => {
              setProvidersHidden((hidden) => {
                const next = !hidden
                writeProvidersHidden(next)
                return next
              })
            },
          }, icon('panelLeft', 14)),
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
            // Switch-to-repair: the seat hands the component a way to read what
            // this session last failed at, and a way to submit the repair. Both
            // are closures over the scope so the component never reaches the
            // session controller directly.
            repair: makeRepairPort(scope, sessionId),
          }
        },
      }, ModelPicker))
    })
  }

  module.exports = { inject: pluginInject, apply }
  return module.exports;
} })