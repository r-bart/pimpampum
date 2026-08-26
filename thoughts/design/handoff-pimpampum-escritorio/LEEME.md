# Pimpampum · Desktop surfaces · Handoff v1

macOS menu-bar app and Omarchy Quattro widget. 26 Aug 2026.

## What to open

Open any of these files directly in a browser (double-click).

| File                                     | Contents                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Handoff superficies escritorio.dc.html` | Printable implementation handoff: rules, dimensions, exact English UI copy, accessibility, acceptance checklist, and scope.                                       |
| `Superficies escritorio.dc.html`         | Interactive mockup covering every state. Section chips switch states; the top control changes macOS light/dark appearance, and Quattro has its own theme control. |
| `pimpampum - brand kit.dc.html`          | Source brand kit: wordmark, symbol, avatars, favicon, palette, and typography.                                                                                    |
| `support.js`, `doc-page.js`              | Runtime files. Keep them beside the HTML files.                                                                                                                   |

## States included in the mockup

- **macOS menu bar** — loading, active with count, work available, drafts only, all complete, no projects, offline/stale, and authentication error at actual size.
- **macOS popover (360 pt)** — mixed load, offline stale, unavailable with login notice, and loading. The `Completed` group is interactive.
- **macOS Settings (460 × 270 pt)** — loading, disabled, healthy with a long path, pending, backup error, and installation error.
- **Quattro widget** — horizontal and vertical bars, semantic states, and the `99+` cap.
- **Quattro popout (380 units)** — mixed load, completed content with long-text truncation, and offline/credential stale states. The expandable Backup section covers five states, including the fallback without `FolderDialog`.
- **Content limits** — two-line long titles, duplicate-title disambiguation, both long-path treatments, 7 / 42 / 99+ counters, and a three-line error.
- **Provenance matrix** — which values come from the system, the Quattro theme, or Pimpampum.

## Approved compact mark

Variant C is final: one exact 16 × 16 pt circle containing a lowercase `p`. The same silhouette is used in every compact state on macOS and Quattro. State remains external to the mark through a badge/accent, semantic color, count, tooltip, and detailed copy. Offline never replaces the mark with a Wi-Fi symbol.
