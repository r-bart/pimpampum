# Desktop design decisions

## Omarchy service controls

**Date**: 2026-08-27  
**Prototype**: `prototypes/stop-service` (removed after promotion)

- Chosen direction: **Service card** at the end of Settings.
- The card shows Running/Stopped, explains the background impact, and exposes Restart plus a
  confirmed Stop action.
- When stopped, the same card promotes a full-width Start Pimpampum action so recovery never
  requires a launcher entry or terminal.
- Rejected Quiet footer: visually restrained, but hid Restart and made lifecycle status easier to
  overlook.
- Rejected Action menu: compact, but buried the recovery model behind an overflow control.

## Marketing landing page

**Date**: 2026-08-28
**Prototype**: `site/src/proto/landing` (removed after promotion)

- Chosen direction: **Editorial**, with the **card treatment for the three beats** taken from the
  Terminal variant. Hierarchy comes from typography and rules; the only boxes on the page are the
  three beat cards and the copyable command snippets.
- The `pim / pam / pum` section is not a metaphor. It maps to the real contract:
  `work_list` → `work_start` → `work_complete`. Brand and API already agreed; the page just says so.
- Voice follows 37signals (Basecamp, HEY, ONCE/Campfire): section headers are the reader's own
  objection ("But I already have Linear", "Where does it all live?"), sentences are short and
  unhedged, and the omissions are presented as decisions rather than gaps.
- Scope is deliberately six sections: the promise, the loop, the objection, the model, agent-first
  plus hand-editable Markdown, folder-based sync, and where to get it. Nothing else.
- Rejected **Platform**: the metro spine read well but tied the whole page to one graphic device,
  so a brand revision would take the layout with it.
- Rejected **Terminal** as the whole page: credible to developers but it buried the identity and
  read as a well-set README. Its beat cards survived into the chosen page.
- Rejected a dark mode. The identity is ink on paper; the page declares `color-scheme: light` and
  paints every surface explicitly.

### Token corrections carried into the site

- `--ink-muted` is `oklch(0.54 0.011 87.5)`, not the brand kit's `#77746D`. The kit value reads
  4.20:1 on paper and fails WCAG AA for body text; only L moved.
- `--signal-text` is `oklch(0.55 0.213 28.9)` for red at body size. The brand red `#EE3F32` reads
  3.51:1 and stays for the mark, the beat discs, and display type.
- `--text-label` is 12px, not the kit's 11px, because it carries real uppercase labels.

## Desktop section on the landing page

**Date**: 2026-08-28
**Prototype**: `site/src/proto/os` (removed after promotion)

- Consolidated one section from all three explored directions rather than picking one:
  the platform is named inside the sentence (from **Inline**), the switch is a real tablist with
  arrow-key navigation and a visible selected state (from **Tabs**), and the option you are not on
  stays on screen as a live control (from **Both**) without paying for two panels of height.
- The default comes from `navigator.userAgentData.platform`, falling back to `navigator.platform`.
  Linux resolves to Omarchy; everything else resolves to macOS, which is where the signed app ships.
- Visibility is driven by `html[data-os]`, set by an inline script before first paint. Nothing is
  styled from `aria-selected`, so the first paint is already final and no layout shifts. The module
  script keeps `aria-selected` and the roving tabindex in sync for assistive technology.
- With no JavaScript the switch never renders and both panels show. A worse layout, but complete.
- The surfaces are **live HTML**, not screenshots: `MacPopover.astro` and `QuattroPopout.astro`,
  built from the approved handoff with its own macOS and Quattro token sets. The Completed and
  Backup groups are native `<details>`, so they open with a click, with Enter and with Space, need
  no JavaScript, and survive being cloned. Real captures of the shipped app can replace them later.
- Rejected reserving the width of the longer platform phrase to avoid reflow: it left a visible
  hole in the sentence. Switching reflows one line, and the user asked for it by clicking.

### Bugs found and fixed while building it

- `.tab::before` extended the hit area to 44px with `position: absolute`, but `.tab` was
  `position: static`. The pseudo-element resolved against the initial containing block and covered
  the whole page, so every click anywhere activated a tab. Confirmed with `elementFromPoint`.
  Every hit-area pseudo-element on the site now has a positioned parent.
- Grid items default to `min-width: auto`, so the scrollable code block inside the sync section
  pushed the track 94px past a 500px viewport. Fixed with `min-width: 0` on the section children.
