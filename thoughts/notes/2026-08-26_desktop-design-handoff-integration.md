# Desktop Design Handoff Integration

**Date:** 2026-08-26  
**Status:** Implemented locally; external Quattro live gate remains open

## Final identity and UX

The approved compact identity is one fixed 16 × 16 circle containing a lowercase `p`. macOS uses
the packaged template PDF; Quattro uses the matching theme-tinted SVG. The silhouette never changes.
External badge shape/accent, semantic copy, tooltip, and optional count express loading, active,
available, draft, complete, empty, stale, offline, credentials, invalid, and incompatible states.
Zero is hidden, 1–99 render directly, and 100+ displays as `99+`; accessibility retains the full
count. Offline never substitutes a Wi-Fi or generic error glyph.

macOS uses a native `MenuBarExtra` with no Dock icon. Its 360 pt popover presents connection state,
Summary, Active work, Projects, and a session-local collapsed Completed group; project rows open the
exact workspace root in Finder. **Settings…** opens or focuses one 460 × 270 pt Backup window with
directory selection, refresh, open, retry, change, and disable. **Quit Pimpampum** exits only the UI
and leaves the daemon running.

Quattro places mark/count side by side or stacked according to bar orientation. Its bounded
380-unit `PopupCard` presents connection state, Active work, Projects, Completed, and collapsed
Backup. Project rows use separate-argument `xdg-open`. Backup uses `FolderDialog` when available and
retains the absolute-path + **Save** fallback, with serialized **Open**, **Back Up Now**, and
**Disable** actions against the single daemon-owned destination.

## Evidence and remaining gate

Real arm64 evidence at `thoughts/evidence/macos-live.json` was recorded at
`2026-08-26T10:35:53.622Z`. It binds app hash
`5aec08bb3f81b4a84f10868dc954a46506a22d87d04ea23afebbb72bc1112a92` and compact-mark hash
`5d9f558de031b9a3c4ed1052e093fb235f9a077d077c9a027286975d4a84f463`. It records the fixed mark,
external badges, capped display/uncapped accessibility count, semantic and recovery states, long
content, exact Finder reveal, Settings states/reuse/focus/size, no Dock icon, Quit leaving the
daemon running, repeat-install recovery, and uninstall cleanup. Folder-picker interaction,
appearance/accessibility variants, and the transient pending frame remain explicit manual or
focused-test boundaries.

## Strict-review lessons

- A Settings button must be exercised through its production window-opening path. An isolated
  controller smoke can pass while SwiftUI's actual Settings scene still does nothing.
- On macOS 14+, `OpenSettingsAction` is the reliable bridge from the menu content to the native
  Settings scene. The retained AppKit controller remains only as a focused test boundary; it is not
  a second production window owner.
- Window size assertions use `contentLayoutRect`, which measures the usable 460 × 270 pt settings
  content without native title/toolbar chrome.
- Refresh availability is distinct from mutation availability: a repaired receipt or token must be
  recoverable from an already-open error state.
- Shared QML action behavior belongs in one primitive so hover, focus, pointer, Enter/Space, and
  accessibility activation cannot drift between rows and disclosures.

No real Quattro evidence exists; `quattro-live.example.json` is only a pending schema example. The
only connection clue is the ambiguous SSH alias `factory`. Confirm the target before remote action,
then run on that machine from a full checkout:

```bash
omarchy --version
omarchy plugin validate ./integrations/omarchy/pimpampum-status
npm run build
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
npm run test:e2e:omarchy
```

Approval requires direct observation of the documented theme, orientation, state, `7`/`42`/`99+`,
workspace, focus, popout, and Backup matrix, followed by exact baseline restoration. Static checks,
fixtures, or inferred screenshots must never be presented as live proof.
