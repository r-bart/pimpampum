# Implementation Plan: Desktop Design Handoff Integration

**Date**: 2026-08-26
**Status**: Complete — released as `v1.0.0`; the Quattro live gate was retired on 2026-08-28 (`../notes/2026-08-28_quattro-gate-removed.md`)
**Source design specification**: [../design/spec.md](../design/spec.md)
**Source handoff**: [../design/handoff-pimpampum-escritorio/LEEME.md](../design/handoff-pimpampum-escritorio/LEEME.md)
**Related product specifications**:

- [../specs/2026-08-25_desktop-status-integrations.md](../specs/2026-08-25_desktop-status-integrations.md)
- [../specs/2026-08-26_automatic-backup-settings.md](../specs/2026-08-26_automatic-backup-settings.md)

**Related immutable test manifests**:

- [../tests/2026-08-26_desktop-status-integrations.md](../tests/2026-08-26_desktop-status-integrations.md)
- [../tests/2026-08-26_automatic-backup-settings.md](../tests/2026-08-26_automatic-backup-settings.md)

---

## Overview

Integrate the approved desktop design handoff into the existing native macOS menu-bar application
and Omarchy Quattro plugin. The work is presentation-only: the daemon, overview API, backup API,
domain semantics, polling, and installation architecture remain authoritative and unchanged.

The official compact product mark is now **variant C: a circle containing a lowercase `p`**. The
same silhouette must remain visible in every status on both platforms. State is expressed outside
the mark through a badge/accent, semantic color, count, tooltip, and detailed copy; offline must
never replace the mark with a Wi-Fi symbol.

## Preflight Findings

- The repository uses npm from `package-lock.json` and Node.js 22+.
- The desktop integrations already exist and consume the shared authenticated overview contract.
- The macOS surface is native SwiftUI/AppKit and the Quattro surface is native QML/Quickshell.
- Backup settings are already implemented on both platforms and have frozen acceptance tests.
- The current macOS indicator swaps among SF Symbols, including `wifi.slash`; this conflicts with
  the approved fixed-identity rule.
- The current Quattro widget swaps text glyphs (`●`, `✓`, `×`, and others); this also conflicts with
  the approved fixed-identity rule.
- Both compact counters currently render the raw integer and need a visual `99+` cap.
- The existing macOS popover already has the required 360 pt width, bounded body, Settings action,
  Quit action, project opening, stale behavior, and completed disclosure.
- The existing settings window already uses the required 460 × 270 pt frame and native folder
  picker; it needs visual alignment and long-path verification, not a new settings architecture.
- The existing Quattro popout already uses the required native `PopupCard`, bounded scrolling,
  workspace opening, completed disclosure, and inline Backup section.
- The working tree contains unrelated in-progress automatic-backup and settings changes. Execution
  must preserve them and avoid replacing whole files when a scoped edit is possible.
- TypeScript and deterministic Swift presentation logic are held to 100% coverage.
- Live Quattro verification can only be completed on the target Quattro machine; fixture or static
  output must never be presented as live evidence.

## Requirements

### Shared identity

- [ ] Use one fixed circle-with-lowercase-`p` silhouette in macOS and Quattro.
- [ ] Keep the base mark unchanged for loading, active, available, draft, complete, empty, stale,
      offline, authentication, invalid-payload, and incompatible-version states.
- [ ] Express state with an external 5-unit/pt badge or accent and semantic treatment.
- [ ] Never use Wi-Fi, cloud, database, backup, or generic error glyphs as the product identity.
- [ ] Hide the active-claim count at zero, render one and two digits directly, and cap larger values
      at `99+`.
- [ ] Treat mark and count as one accessible control with singular/plural active-claim copy.
- [ ] Preserve legibility in light and dark appearances at the actual 14–16 pt/bar size.

### macOS

- [ ] Replace the changing SF Symbol menu-bar identity with the official template mark.
- [ ] Preserve native `MenuBarExtra`, no Dock icon, 360 pt popover, fixed header/footer, and bounded
      scrolling body.
- [ ] Match the approved header, connection notices, Summary, Active work, Projects, Completed,
      reveal errors, Settings, and Quit hierarchy and copy.
- [ ] Keep project rows as full-width Finder-opening controls with hover, keyboard, and VoiceOver
      affordances.
- [ ] Match the approved 460 × 270 pt single Backup Settings window and all loading, disabled,
      healthy, pending, backup-error, and installation/authentication-error states.
- [ ] Keep long backup paths selectable and limited to two lines without arbitrary character breaks.
- [ ] Repeated Settings actions must focus one real window; Quit stops only the menu application.

### Omarchy Quattro

- [ ] Replace status text glyphs with the official fixed mark plus external state treatment.
- [ ] Support horizontal and vertical bar geometry and inherit the live bar's size, font, foreground,
      background, urgent color, and popout behavior.
- [ ] Match the approved 380-unit bounded status popout and its information order.
- [ ] Preserve clickable workspace rows, completed disclosure, and inline Backup disclosure.
- [ ] Match the approved backup field/actions/states, including optional `FolderDialog` and manual
      absolute-path fallback.
- [ ] Add visible hover/focus feedback wherever Quickshell permits keyboard interaction.
- [ ] Verify compact mark, badges, `42`, and `99+` against real light and dark Quattro themes.

### Documentation and scope

- [ ] Close the handoff's pending icon decision in favor of variant C.
- [ ] Make canonical design documentation and annotations English, consistent with the repository.
- [ ] Do not add project, PRD, context-document, task, or subtask editing.
- [ ] Do not add daemon lifecycle controls, notifications, logs, tabs, navigation, search, or new
      settings categories.
- [ ] Do not change overview/backup contracts or duplicate status rules in the clients.

---

## Approach Analysis

### Option A: Exported native vector assets with platform-native presentation

**Description**: Export the approved 16 × 16 circle-`p` master as a macOS template-vector asset and
a Quattro SVG. Keep state derivation in the existing Swift/QML presentation layers, rendering the
same fixed mark with external badges and counts. Validate both exported assets and their packaged
copies in existing artifact gates.

**Pros**:

- Preserves the exact approved silhouette rather than relying on platform font rendering.
- Keeps both applications native and dependency-free.
- Supports a true macOS monochrome template icon and a theme-tinted Quattro image.
- Makes packaging failures detectable.
- Requires no API, database, daemon, or domain changes.

**Cons**:

- Requires two platform export formats from one approved master.
- Asset packaging and visual parity need explicit checks.

**Complexity**: Medium.

### Option B: Draw a circle and text `p` independently in SwiftUI and QML

**Description**: Build the mark from a platform-native circle plus a lowercase text glyph in each
UI runtime.

**Pros**:

- No binary/vector resource packaging.
- Quick to prototype and resize.

**Cons**:

- Font metrics differ between macOS and Quattro themes.
- The `p` baseline, weight, counter, and optical centering will drift.
- A font update or user theme can silently change the brand mark.
- Producing a transparent knockout/template treatment is less predictable.

**Complexity**: Low initially, medium to keep visually consistent.

### Option C: Replace both desktop integrations with one cross-platform UI shell

**Description**: Use Electron, Tauri, or a shared web renderer for the menu/tray surfaces.

**Pros**:

- One UI implementation language.
- Shared visual components.

**Cons**:

- Adds substantial runtime and packaging weight.
- Loses native Quattro plugin behavior and macOS menu-extra behavior.
- Violates the product's minimal, local, zero-bloat posture.
- Reopens already-solved installation, security, and accessibility boundaries.

**Complexity**: High.

### Recommendation

Use **Option A**. It integrates the approved design with the smallest architectural change and the
highest visual determinism. The daemon remains the single source of truth, while SwiftUI/AppKit and
QML/Quickshell continue as thin platform adapters. Exported platform vectors are preferable to
font-built marks because the chosen circle-`p` is product identity, not ordinary interface text.

## Architecture Decisions

### 1. Presentation-only change

No TypeScript domain, SQLite, HTTP, MCP, OpenAPI, CLI, overview contract, or backup contract changes
are expected. If implementation discovers missing data, stop and amend this plan rather than
deriving new business rules in Swift or QML.

### 2. Fixed identity, separate status presentation

Define presentation metadata separately from the mark:

```text
Fixed identity: circle containing lowercase p
Dynamic status: badge shape + semantic accent + label
Dynamic activity: active-claim count, hidden at 0 and capped at 99+
```

The mark asset path/name must not depend on status. Tests and validators should make accidental
status-specific product icons difficult to introduce.

### 3. One approved master, two native exports

The approved design master is represented in the branding directory. macOS receives a monochrome
template-vector export; Quattro receives an SVG export. Both are reviewed at 1× actual size and an
8× inspection size. Build and validation scripts verify that the correct assets are present in the
final `.app` and plugin package.

Do not introduce a runtime SVG/PDF conversion library or a general asset pipeline for one icon.

### 4. Deterministic presentation helpers

Count formatting, status-to-treatment mapping, stale-count behavior, and accessibility copy remain
pure deterministic helpers. Swift helpers stay inside the 100% core coverage manifest. Quattro
helpers remain simple QML properties/functions covered by static validator assertions and live
evidence.

### 5. Native tokens remain authoritative

- macOS: semantic SwiftUI typography, colors, materials, controls, focus rings, and accessibility.
- Quattro: `bar.*`, `Style.font.*`, `Style.space(*)`, `PopupCard`, and the installed theme.

The brand asset defines only geometry. It must not introduce a parallel color, typography, spacing,
or component system.

### 6. Existing safety boundaries remain frozen

- Workspace paths are opened as separate process/API arguments, never shell-interpolated.
- Tokens, raw stderr, and bodies remain absent from the UI.
- Backup mutation remains the only writable desktop exception.
- Frozen acceptance tests must not be modified to make this work pass.

---

## Files to Create or Modify

### Canonical design and brand assets

| File                                                                                  | Action | Purpose                                                                              |
| ------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `thoughts/design/spec.md`                                                             | Modify | Record variant C as the final compact mark and mark the handoff implementation-ready |
| `thoughts/design/handoff-pimpampum-escritorio/LEEME.md`                               | Modify | Remove the pending decision and describe the final mark in English                   |
| `thoughts/design/handoff-pimpampum-escritorio/Superficies escritorio.dc.html`         | Modify | Apply the circle-`p` to every compact state and normalize annotations to English     |
| `thoughts/design/handoff-pimpampum-escritorio/Handoff superficies escritorio.dc.html` | Modify | Close the icon decision and normalize implementation notes to English                |
| `branding/assets/pimpampum-compact-master.svg`                                        | Create | Canonical reviewed vector geometry for the circle-`p` mark                           |
| `platforms/macos/Resources/PimpampumCompact.pdf`                                      | Create | macOS monochrome/template vector export                                              |
| `integrations/omarchy/pimpampum-status/assets/pimpampum-compact.svg`                  | Create | Quattro theme-tintable vector export                                                 |

### macOS

| File                                                                            | Action           | Purpose                                                                                        |
| ------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `platforms/macos/Sources/PimpampumMenuBar/PimpampumMark.swift`                  | Create           | Load and render the fixed template mark with external state badge and capped count             |
| `platforms/macos/Sources/PimpampumMenuBar/StatusPresentation.swift`             | Modify           | Add deterministic badge/count/accessibility presentation without changing status semantics     |
| `platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift`                  | Modify           | Apply approved indicator, hierarchy, density, row, notice, footer, and long-content treatments |
| `platforms/macos/Sources/PimpampumMenuBar/BackupSettingsView.swift`             | Modify           | Match approved settings states, spacing, controls, and long-path behavior                      |
| `platforms/macos/Sources/PimpampumMenuBar/BackupSettingsWindowController.swift` | Modify if needed | Preserve one correctly sized/focused Settings window                                           |
| `platforms/macos/Sources/PimpampumMenuBar/DesktopSmokeHarness.swift`            | Modify           | Render/inspect the approved indicator and visual boundary states                               |
| `platforms/macos/Tests/PimpampumMenuBarTests/PimpampumMarkTests.swift`          | Create           | Test mark identity metadata, badge mapping, count cap, and accessible copy                     |
| `platforms/macos/Tests/PimpampumMenuBarTests/StatusPopoverTests.swift`          | Modify           | Cover approved state metadata, stale behavior, hierarchy helpers, and long content             |
| `platforms/macos/Tests/PimpampumMenuBarTests/BackupDirectoryPickerTests.swift`  | Modify           | Cover composed settings states and two-line selectable path behavior where testable            |
| `scripts/build-macos-app.sh`                                                    | Modify           | Copy the template asset into the final app resources                                           |
| `scripts/check-macos-artifact.mjs`                                              | Modify           | Assert the packaged app contains the final mark and no obsolete identity asset                 |
| `scripts/test-macos-live.mjs`                                                   | Modify           | Capture active, complete, offline/stale, and settings visual evidence                          |
| `scripts/check-swift-coverage.sh`                                               | Modify           | Add new deterministic presentation source to the 100% Swift core gate                          |

### Omarchy Quattro

| File                                                      | Action           | Purpose                                                                                               |
| --------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `integrations/omarchy/pimpampum-status/PimpampumMark.qml` | Create           | Render the fixed SVG mark, external badge, count, and accessible state                                |
| `integrations/omarchy/pimpampum-status/BarWidget.qml`     | Modify           | Use the fixed mark in horizontal/vertical layouts with theme inheritance and `99+` cap                |
| `integrations/omarchy/pimpampum-status/StatusPopout.qml`  | Modify           | Match the approved hierarchy, density, content bounds, interactions, focus, and Backup treatment      |
| `integrations/omarchy/pimpampum-status/manifest.json`     | Modify if needed | Keep packaging metadata synchronized without changing plugin kind or multiplicity                     |
| `integrations/omarchy/pimpampum-status/README.md`         | Modify           | Document final UI behavior and live visual verification flow in English                               |
| `scripts/validate-omarchy-plugin.mjs`                     | Modify           | Assert fixed identity, asset presence, count cap, geometry variants, theme use, and safety invariants |
| `test/omarchy-plugin.test.ts`                             | Modify           | Add focused asset, status-treatment, accessibility, and long-content contracts                        |
| `scripts/test-omarchy-live.mjs`                           | Modify           | Record actual horizontal/vertical, light/dark, state, count, and popout evidence                      |

### Cross-platform documentation and gates

| File                                                              | Action | Purpose                                                                               |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `README.md`                                                       | Modify | Show the final desktop UX and circle-`p` identity without expanding product scope     |
| `package.json`                                                    | Modify | Add an asset validation command only if existing desktop checks cannot own it cleanly |
| `thoughts/notes/2026-08-26_desktop-design-handoff-integration.md` | Create | Record implementation decisions, visual deviations, and verification evidence         |

### Frozen files: make pass, do not modify

| File                                               | Action    | Purpose                                       |
| -------------------------------------------------- | --------- | --------------------------------------------- |
| `test/desktop-status.acceptance.test.ts`           | Make pass | Preserve cross-layer desktop behavior         |
| `test/desktop-status.safety.acceptance.test.ts`    | Make pass | Preserve path, token, and read-only safety    |
| `test/desktop-status.lifecycle.acceptance.test.ts` | Make pass | Preserve service lifecycle behavior           |
| `test/quattro-live-evidence.acceptance.test.ts`    | Make pass | Preserve real Quattro evidence integrity      |
| `test/automatic-backup.acceptance.test.ts`         | Make pass | Preserve daemon-owned rolling backup behavior |
| `test/backup-settings-ui.acceptance.test.ts`       | Make pass | Preserve native settings UI boundary          |
| `test/fixtures/overview/*.json`                    | Make pass | Preserve shared overview fixture contract     |

---

## Implementation Phases

### Phase 1: Freeze the approved design decision and assets

#### Task 1.1: Canonicalize the handoff

**Files**: `thoughts/design/spec.md`, handoff `LEEME.md`, both handoff HTML documents

- Replace the previous A/B pending decision with final variant C.
- Define the exact final form as a circle containing a lowercase `p`.
- Keep the mark fixed across every semantic state.
- Update every compact state example in the interactive mockup and printable handoff.
- Normalize canonical annotations and instructions to English while keeping UI copy unchanged.
- Mark the design handoff as approved/implementation-ready.
- Remove contradictory instructions such as “tell me whether to change everything to B.”

#### Task 1.2: Export and validate the platform vectors

**Files**: canonical SVG master, macOS PDF resource, Quattro SVG resource, artifact validators

- Export from one reviewed 16 × 16 geometry with a lowercase `p` optically centered in the circle.
- Keep the product shape monochrome; status colors and badges remain presentation-layer concerns.
- Verify clean rendering at 14, 16, and 32 units and at 8× inspection scale.
- Verify the counter and badges remain outside the logo geometry.
- Add packaging checks for both native resources.
- Avoid runtime vector conversion, remote assets, system-font construction, or icon fallbacks that
  silently change identity.

### Phase 2: Integrate the macOS design

#### Task 2.1: Build the fixed indicator presentation

**Files**: `PimpampumMark.swift`, `StatusPresentation.swift`, focused Swift tests

- Load the packaged vector as a native monochrome template image.
- Render it for every state without changing asset name or geometry.
- Map each state to the approved external badge/accent treatment.
- Add a pure display-count helper:

```swift
0       -> nil
1...99  -> String(count)
100...  -> "99+"
```

- Keep stale cached counts only when explicitly allowed by current overview visibility rules.
- Generate `Pimpampum: {status}, {N active claim(s)}` as one accessibility element.
- Ensure loading and error treatments remain understandable without color.

#### Task 2.2: Apply the approved popover hierarchy and visual treatment

**Files**: `StatusPopover.swift`, `StatusPresentation.swift`, `StatusPopoverTests.swift`

- Replace status-specific identity symbols in the header with the shared fixed indicator.
- Preserve the 360 pt container, 480 pt body maximum, fixed dividers/header/footer, and regular
  material.
- Align connection/login notices, Summary, Active work, project rows, completed disclosure,
  truncation messages, and reveal errors with the handoff.
- Keep titles at two lines where specified and workspace/slug metadata to one end-elided line.
- Add or preserve full-row hover, Enter/Space activation, Finder affordance, and accessibility
  labels/hints.
- Keep completed projects collapsed on launch and expansion session-local.
- Keep `Quit Pimpampum` and `Settings…` as plain native actions in the fixed footer.
- Do not add backup controls to the status popover.

#### Task 2.3: Apply the approved Backup Settings treatment

**Files**: `BackupSettingsView.swift`, window controller and focused tests

- Preserve one 460 × 270 pt titled window and focus/reuse behavior.
- Match loading, disabled, healthy, pending/busy, backup-error, and installation/authentication-error
  variants from the handoff.
- Keep the explanatory copy and current rolling-snapshot semantics.
- Render configured paths in a selectable monospaced two-line area, wrapping at meaningful path
  boundaries when possible rather than using arbitrary character breaks.
- Keep native folder-only selection, Finder opening, retry/back-up-now, change, and disable actions.
- Disable competing controls while an operation is in flight and keep errors inline/actionable.

#### Task 2.4: Package and exercise the real macOS app

**Files**: macOS build/artifact/live-smoke scripts and smoke harness

- Copy the template resource into `Contents/Resources` and fail packaging if it is absent.
- Extend smoke snapshots to identify the fixed mark and capped counter presentation.
- Exercise active, complete, empty, offline-without-cache, stale-with-cache, authentication, and
  long-content states.
- Exercise Settings open/focus, folder-picker cancellation, long synchronized path, pending,
  backup error, and Quit behavior.
- Validate no Dock icon, no duplicate settings window, and no daemon termination on app Quit.
- Inspect light/dark, increased contrast, and increased text size manually at actual menu-bar size.

### Phase 3: Integrate the Omarchy Quattro design

#### Task 3.1: Build the fixed Quattro mark and bar layouts

**Files**: `PimpampumMark.qml`, `BarWidget.qml`, SVG resource, validator and focused tests

- Render the same circle-`p` SVG for every semantic state.
- Use an adjacent/overlaid badge or accent that stays outside the product mark.
- Keep error/offline states from swapping in `×`, `!`, Wi-Fi, or another product icon.
- Cap the compact active count at `99+` and hide it at zero.
- Center mark/count horizontally or stack vertically based on `bar.vertical`.
- Preserve the widget-sized click target, pointer cursor, tooltip, and popout lifecycle.
- Inherit all Quattro theme/bar tokens and verify the mark is tintable on light and dark themes.
- Expose combined accessible status/count text where Quickshell supports it.

#### Task 3.2: Apply the approved Quattro popout treatment

**Files**: `StatusPopout.qml`, `test/omarchy-plugin.test.ts`, validator

- Preserve native `PopupCard`, 380-unit target width, 520-unit maximum height, clipped scrolling,
  and bar-owned popout switching.
- Match the approved header, connection/error, empty state, Active work, Projects, Completed, and
  Backup order.
- Keep compact long-title elision and workspace/slug disambiguation.
- Add subtle inherited hover/focus treatment to clickable project, completed, disclosure, and
  action controls.
- Preserve safe separate-argument `xdg-open` usage and bounded sanitized errors.
- Keep Backup collapsed by default and retain FolderDialog/manual absolute-path behavior.
- Preserve busy serialization and disable all competing backup controls while updating.

#### Task 3.3: Validate on the real Quattro machine

**Files**: live runner, integration README, live evidence generated by the existing workflow

- Install through the supported Pimpampum lifecycle without editing shell configuration directly.
- Validate hot reload leaves one widget/popout and preserves existing user layout.
- Capture horizontal and vertical bar states for active count `7`, `42`, and visual cap `99+`.
- Validate complete, available, draft, empty, offline, stale, and credentials states.
- Amended 2026-08-28: `incompatible`, `importing`, and `exporting` are excluded from live
  observation. A healthy daemon pins overview `schemaVersion` 2 and the two sync states are
  transient within one local operation, so no reviewer can honestly attest to them. They remain
  covered by automated tests; the runner prints and hashes the exclusion into the approval binding.
- Validate active mixed work, completed-expanded long content, and all five Backup variants.
- Repeat compact indicator checks in one light and one dark Quattro theme.
- Exercise mouse, scroll, keyboard focus/activation where supported, folder opening, workspace
  opening, backup configure/retry/disable, and FolderDialog fallback.
- Record only evidence produced on the actual target; keep the release gate open if unavailable.

### Phase 4: Documentation, regression, and release review

#### Task 4.1: Update user-facing documentation

**Files**: root README, Quattro README, implementation note

- Describe the final circle-`p` indicator and status grammar.
- Explain the macOS popover, Quattro popout, project-folder interaction, backup settings, and Quit
  behavior using English UI names.
- Keep installation and agent-facing material unchanged except where screenshots/labels changed.
- Record any intentional visual deviation from the handoff with its platform reason.

#### Task 4.2: Run complete verification and strict review

**Files**: no production changes unless a failing gate identifies a defect

- Run formatting, lint, typecheck, TypeScript coverage/E2E, Swift coverage, artifact validation,
  Quattro validation, package dry-run, and production dependency audit.
- Verify every frozen acceptance file and fixture hash is unchanged.
- Compare live screenshots/renderings against the approved handoff at actual size.
- Run `devtronic:post-review --strict` and fix all in-scope findings.
- Re-run the complete gate after the last fix.

---

## Task Dependencies

```yaml
dependencies:
  1.1: []
  1.2: [1.1]
  2.1: [1.2]
  2.2: [2.1]
  2.3: [1.1]
  2.4: [2.2, 2.3]
  3.1: [1.2]
  3.2: [3.1]
  3.3: [3.2]
  4.1: [2.4, 3.3]
  4.2: [4.1]
```

Parallel execution notes:

- Tasks 2.1 and 3.1 may run in parallel after the assets are frozen.
- Task 2.3 may run alongside 2.1/2.2 because it does not depend on indicator implementation.
- macOS Task 2.4 and Quattro Tasks 3.2/3.3 may run independently.
- Task 4.1 must use verified behavior and screenshots, not pre-implementation assumptions.

---

## Risk Analysis

### Edge cases

- [ ] `activeClaims` is 0, 1, 9, 42, 99, 100, or a much larger valid integer.
- [ ] Stale cached data retains a previously non-zero count while the connection is offline.
- [ ] The template mark is shown on light, dark, tinted, and increased-contrast menu bars.
- [ ] Quattro uses a very small bar size or vertical geometry.
- [ ] Quattro theme foreground and urgent colors have insufficient contrast against its background.
- [ ] Project titles, workspace names, slugs, agent IDs, paths, and errors contain long Unicode text.
- [ ] Two projects share the same title.
- [ ] The project/work lists are truncated by the daemon contract.
- [ ] A workspace or backup directory disappears between render and click.
- [ ] Settings is opened repeatedly while the menu app has no Dock presence.
- [ ] Folder selection is cancelled or Qt FolderDialog is unavailable.
- [ ] Backup status changes while a popover/settings window is open.
- [ ] The app/plugin package omits its vector asset.
- [ ] The icon asset loads but is not treated/tinted as a monochrome template.

### Technical risks

- [ ] PDF and SVG exports can drift visually unless reviewed from the same approved master.
- [ ] SwiftUI menu-bar template tinting may differ from popover rendering; test both contexts.
- [ ] QML SVG tint behavior may vary by Quickshell/Qt version; verify on the pinned target runtime.
- [ ] Enlarged text can exceed the fixed popover/settings dimensions; keep scroll and semantic
      wrapping rather than widening the surfaces.
- [ ] Static QML validation cannot prove real hover, focus, or theme integration.
- [ ] Editing generated handoff HTML directly can create future drift; retain the approved master
      asset and document the final decision in the canonical Markdown specification.
- [ ] In-progress backup/settings changes overlap presentation files; execution must patch around
      them and review diffs before each commit.

### Mitigations

- Use platform-native exported vectors from one approved master.
- Add package-level asset assertions and fail closed when resources are missing.
- Keep status/count/accessibility mapping pure and fully tested.
- Use actual-size light/dark visual review, not enlarged mockups alone.
- Preserve and hash-check frozen acceptance files.
- Require real Quattro evidence before declaring the cross-platform release gate complete.

---

## Testing Strategy

### Unit tests

- Swift status-to-badge mapping covers every connection/global state.
- Swift compact-count formatting covers 0, 1, 42, 99, 100, and large values.
- Swift accessibility copy covers zero, singular, plural, stale, authentication, and incompatible.
- Existing summary, lease, project-state, and long-content helpers remain covered.
- Existing Backup Settings store/client/model tests remain green.
- QML static contracts prove one fixed asset path, no status-dependent product glyph, `99+` cap,
  horizontal/vertical branching, theme inheritance, and accessible labels.

### Integration tests

- macOS build produces a runnable LSUIElement app with the packaged template resource.
- macOS smoke renders real SwiftUI states and activates Finder/Settings/Quit boundaries safely.
- Quattro validator accepts the manifest, QML, helper scripts, fixtures, and vector asset.
- Quattro plugin tests preserve safe process argument boundaries and read-only project behavior.
- Existing overview and backup acceptance suites remain unchanged and pass.

### Visual and accessibility verification

- Compare macOS active, complete, empty, stale, unavailable, and Settings states to the handoff.
- Inspect menu icon and counts at actual 1× size in light/dark and increased-contrast appearances.
- Use VoiceOver/AX evidence for the combined mark/count control and interactive project rows.
- Compare real Quattro horizontal/vertical indicators and popouts in light/dark themes.
- Exercise keyboard focus and activation on both platforms where the native runtime supports it.
- Verify no information is communicated by red/green alone.

### Regression commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:evals
npm run test:macos
npm run test:omarchy
npm run build:macos
npm run check:macos-evidence
npm run check:quattro-evidence
npm pack --dry-run
npm audit --omit=dev
```

Real platform commands:

```bash
PIMPAMPUM_RUN_LIVE_MACOS=1 npm run test:e2e:macos
npm run test:e2e:omarchy:live
```

The Quattro live command must be run on the target machine with its workflow-required environment
and must not be replaced by fixture-only output.

---

## Done Criteria

### Phase 1: Canonical design and assets

- [ ] The canonical spec states that variant C, a circle with lowercase `p`, is final: inspect
      `thoughts/design/spec.md`.
- [ ] Neither handoff document contains a pending A/B icon decision: `rg -n "pending|variant A|variant B|decisión pendiente" thoughts/design` returns no unresolved icon decision.
- [ ] Canonical design annotations are English and UI copy remains unchanged.
- [ ] The master, macOS, and Quattro vectors render the same approved silhouette at actual size.
- [ ] Asset validation fails when either packaged platform asset is absent.

### Phase 2: macOS

- [ ] Every macOS compact state uses the fixed circle-`p`; no connection state replaces it with
      `wifi.slash` or another identity glyph.
- [ ] Compact count output is hidden at zero and capped at `99+`: Swift unit tests pass.
- [ ] Popover width, maximum body height, fixed footer, section order, project interactions, and
      completed disclosure match the handoff: Swift tests and live screenshot inspection pass.
- [ ] `Quit Pimpampum` exits only the UI app and `Settings…` focuses one real 460 × 270 pt window:
      live smoke passes.
- [ ] Loading, disabled, healthy, pending, backup-error, and installation/authentication-error
      settings states render with actionable English copy.
- [ ] Long backup paths remain selectable, legible, and bounded to two lines.
- [ ] Packaged `.app` contains the template vector and remains background-only/LSUIElement.
- [ ] Swift deterministic core coverage remains 100%: `npm run test:macos`.

### Phase 3: Quattro

- [ ] Every Quattro compact state uses one fixed circle-`p` SVG with an external state treatment.
- [ ] Widget hides zero and displays `7`, `42`, and `99+` correctly in horizontal and vertical bars.
- [ ] Widget/popout inherit the active Quattro theme and remain legible in one light and one dark
      real theme.
- [ ] Popout is native, bounded, scrollable, and ordered Header → errors → empty → Active work →
      Projects → Completed → Backup.
- [ ] Project and backup directory actions preserve separate process arguments and bounded errors.
- [ ] Backup covers FolderDialog available/unavailable, disabled, healthy, pending, and error.
- [ ] Static plugin and focused tests pass: `npm run test:omarchy`.
- [ ] Real target-machine evidence passes: `npm run test:e2e:omarchy:live` and
      `npm run check:quattro-evidence`.

### Frozen specification tests

- [ ] All desktop status acceptance tests pass without editing frozen files.
- [ ] All automatic backup acceptance tests pass without editing frozen files.
- [ ] No frozen spec test file or shared fixture was modified; verify hashes from both test
      manifests.

### Overall

- [ ] No domain, API, MCP, OpenAPI, CLI, database, or persisted status semantics changed.
- [ ] No editing, daemon control, notification, log, navigation, or extra-settings scope was added.
- [ ] All repository quality commands pass with zero warnings/errors.
- [ ] TypeScript and deterministic Swift coverage gates remain 100%.
- [ ] macOS live evidence is real and current.
- [ ] Quattro live evidence is real and current; if the target is unreachable, status remains
      incomplete rather than inferred.
- [ ] `npm pack --dry-run` includes both desktop assets and all required runtime files.
- [ ] `npm audit --omit=dev` reports no production vulnerabilities.
- [ ] No new `TODO`, `FIXME`, or `HACK` remains in production code.
- [ ] `devtronic:post-review --strict` reports no unresolved in-scope findings.

---

## Execution Result

Tasks 1.1–3.2 and 4.1–4.2 are implemented. Task 2.4 passes against the final packaged arm64 app,
including the production SwiftUI Settings scene. Task 3.3's runner, validation matrix, cleanup
proof, and documentation are implemented, but the target-machine capture itself remains open
because this host has no confirmed Quattro destination; the lone SSH alias `factory` is ambiguous.

Verified on 26 Aug 2026:

- TypeScript: 359/359 contract/unit/integration tests with 100% statements, branches, functions,
  and lines; 9/9 real use-case E2E tests.
- macOS: 90/90 Swift tests with 100% deterministic-core regions, functions, and lines; final live
  smoke passed all 25 checks for app hash
  `5aec08bb3f81b4a84f10868dc954a46506a22d87d04ea23afebbb72bc1112a92`.
- Omarchy: 28/28 plugin/service tests and static package validation; live Quattro evidence remains
  intentionally absent rather than inferred.
- Formatting, lint, typecheck, frozen-contract hashes, package dry-run, artifact/evidence checks,
  and production audit (0 vulnerabilities) pass.
- `devtronic:post-review --strict` passes after resolving all five findings: Settings refresh and
  recovery, one real production Settings owner, capability-based backup HTTP routes, and shared QML
  action behavior.

The cross-platform release status remains incomplete only until the documented interactive runner
is executed and approved on the real Quattro machine.

---

## Execution Boundary

Execution preserved the existing dirty working tree and reviewed overlap with the in-progress
backup/settings files. Cross-platform release completion still requires both native surfaces to
match the approved handoff and the real Quattro gate to pass; static validation alone is not
sufficient.
