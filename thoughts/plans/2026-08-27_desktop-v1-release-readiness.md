# Implementation Plan: Desktop V1 Release Readiness

**Date**: 2026-08-27  
**Status**: Ready for execution  
**Scope**: Bring the Omarchy Quattro plugin and native macOS menu-bar application to one coherent,
tested, reproducible V1 release.

**Related specifications and plans**:

- [../specs/2026-08-25_desktop-status-integrations.md](../specs/2026-08-25_desktop-status-integrations.md)
- [../specs/2026-08-26_automatic-backup-settings.md](../specs/2026-08-26_automatic-backup-settings.md)
- [../specs/2026-08-26_shared-folder-sync.md](../specs/2026-08-26_shared-folder-sync.md)
- [2026-08-26_desktop-design-handoff-integration.md](2026-08-26_desktop-design-handoff-integration.md)
- [2026-08-26_automatic-backup-settings.md](2026-08-26_automatic-backup-settings.md)
- [2026-08-26_shared-folder-sync.md](2026-08-26_shared-folder-sync.md)

---

## Outcome

Ship a V1 in which both desktop integrations expose the same product capabilities and safety
contract while remaining native to their platforms. Omarchy uses Quickshell, systemd user services,
GTK folder selection, and in-popout navigation. macOS uses AppKit/SwiftUI windows, native folder
panels, Finder, and menu-bar conventions.

The release is complete only when its source, packaged artifacts, automated checks, and directly
observed live evidence all refer to the same Git commit. A locally green implementation without the
macOS and Quattro live gates is not a releasable V1.

## V1 Product Contract

Both platforms must provide:

- status, active work, projects, completed work, and safe workspace opening;
- synchronization configuration, explicit effective-folder confirmation, pause/resume, sync now,
  open folder, change folder, forget folder, health, pending work, last synchronization, and
  actionable conflict/unavailable states;
- automatic backup configuration, open/change/disable/retry actions, current status, and clear
  recovery-oriented copy that distinguishes backup from synchronization;
- product help covering the local-first model, projects/specs/tasks, agent access, active claims,
  workspace opening, synchronization, backup, and platform-specific lifecycle behavior;
- keyboard, screen-reader, focus, contrast, long-content, loading, empty, error, and destructive
  confirmation behavior appropriate to the platform.

Platform-specific controls such as macOS Login Items and Quit must not be copied into Omarchy.
Likewise, systemd service controls and Quickshell-specific behavior must not leak into macOS.

## Non-goals

- Do not change synchronization merge semantics, snapshot formats, or SQLite ownership.
- Do not add cloud-provider SDKs, remote database access, or direct filesystem access for agents.
- Do not add editing for projects, specs, tasks, or contexts to either desktop surface.
- Do not make the desktop clients reimplement rules owned by `PimpampumStore` or the daemon.
- Do not fabricate live evidence or approve an artifact that was not built from the release commit.

---

## Phase 0 — Establish a Reproducible Baseline

### Task 0.1: Inventory and classify the working tree

**Depends on**: none  
**Files**: Git index and working tree; no product changes

- Record staged, unstaged, untracked, ignored, and stashed changes.
- Attribute every change to the desktop V1, another intentional workstream, generated evidence, or
  disposable residue.
- Preserve unrelated user work; never discard or overwrite it to obtain a clean tree.
- Remove generated failure residue only after confirming it is disposable and excluded from useful
  debugging evidence.
- Confirm that every source file used by `npm pack` is tracked by Git.

### Task 0.2: Freeze the implementation baseline

**Depends on**: Task 0.1

- Consolidate the intended desktop changes into reviewable commits.
- Ensure the index and working tree are clean before calculating release hashes or live evidence.
- Record the baseline commit in the release notes/evidence workflow.
- Run the full repository quality command and a package dry run from that exact commit.

**Gate 0**:

- `git status --short` is empty.
- `git ls-files` contains every packaged source and helper.
- `npm pack --dry-run --json` contains no caches, failure residue, secrets, local receipts, or
  unexpected platform artifacts.

---

## Phase 1 — Freeze Shared Desktop Contracts with Tests

### Task 1.1: Add parity and invariant tests before implementation

**Depends on**: Gate 0  
**Files**: desktop acceptance manifests, Swift tests, Omarchy plugin tests, contract scripts

- Add failing tests for the V1 product contract shared by both clients.
- Cover synchronization response schema/envelope validation, absolute paths, valid device IDs,
  non-negative counts, and the relationship between enabled state and configured directory.
- Cover the effective `Pimpampum` child-folder preview and explicit confirmation before configure.
- Cover configured, paused, busy, pending, unavailable, invalid-state, conflict, and forgotten
  synchronization states.
- Cover backup disabled, configured, busy, failed, retry, changed, opened, and disabled states.
- Cover help-section completeness without forcing identical platform layout.
- Keep domain invariants in daemon/store tests; desktop tests assert presentation and client
  validation only.

### Task 1.2: Define release-evidence provenance

**Depends on**: Task 1.1  
**Files**: live-test scripts, evidence schemas/checkers, artifact metadata scripts

- Require every live evidence document to record the full Git commit, platform, architecture,
  build/artifact hash, test timestamp, and matrix version.
- Reject evidence whose commit or artifact hash does not match the release candidate.
- Make the macOS artifact checker reject a binary older than or unrelated to its tracked Swift and
  resource inputs; use deterministic source/input hashing rather than timestamps alone.
- Keep example evidence clearly distinct from passing evidence.

**Gate 1**:

- The new acceptance tests fail for the known missing behavior.
- Evidence and artifact checkers reject stale, mismatched, partial, or example evidence.

---

## Phase 2 — Complete and Harden macOS Settings

### Task 2.1: Create one native Settings architecture

**Depends on**: Gate 1  
**Files**: `App.swift`, settings window controller, synchronization and backup SwiftUI views

- Replace the current synchronization-only window with one Settings window exposing both
  Synchronization and Backup.
- Use a native macOS organization suitable for two categories, such as a Settings-style toolbar or
  sidebar, while preserving one focusable window instance.
- Preserve native keyboard navigation, VoiceOver labels, window restoration/focusing behavior,
  selectable paths, and resizing or content sizing for errors and long localized text.
- Remove or integrate obsolete standalone backup-window code so there is one authoritative route.

### Task 2.2: Bring the macOS synchronization client to contract parity

**Depends on**: Task 2.1  
**Files**: `SyncSettings.swift` and focused Swift tests

- Decode and validate the authenticated response envelope and synchronization schema strictly.
- Reject invalid paths, state combinations, device IDs, counts, and incompatible schema versions
  with sanitized actionable errors.
- Keep the device identity deterministic and document how hostname collisions are handled; expose a
  user override only if the daemon contract requires one.
- Do not expose tokens, raw response bodies, internal snapshot paths, or stderr.

### Task 2.3: Complete the macOS synchronization flow

**Depends on**: Task 2.2

- After native folder selection, show the effective child folder and consequences before enabling.
- Expose open shared folder, change, pause/resume, sync now, forget, pending snapshot count, last
  import/export or combined last sync, and conflict guidance.
- Disable or replace actions that are no-ops while paused or busy.
- Preserve local-work reassurance when the shared folder is unavailable.
- Add explicit destructive confirmation for forgetting the folder without implying remote data is
  deleted.

### Task 2.4: Restore and finish macOS backup settings

**Depends on**: Task 2.1

- Make the existing backup client/view reachable from the unified Settings window.
- Verify choose, confirm, open, change, retry, and disable flows with the native folder panel.
- Keep backup copy distinct from synchronization and explain recovery scope.
- Verify long paths, unavailable destinations, permissions, loading, and repeated actions.

### Task 2.5: Align macOS Help with the shipped product

**Depends on**: Tasks 2.3 and 2.4  
**Files**: `HelpDialog.swift` and tests

- Describe the local-first portfolio, projects/specs/tasks, active claims, agent interfaces,
  workspace opening, synchronization, and backup accurately.
- Point to the actual unified Settings destination.
- Remove statements that are false for the implemented build.

**Gate 2**:

- Swift unit and presentation tests pass with required coverage.
- Static and smoke harnesses show both settings categories and all boundary states.
- No macOS package is produced yet unless it is built on the target macOS toolchain from the
  candidate commit.

---

## Phase 3 — Finish Omarchy Interaction and Accessibility

### Task 3.1: Correct synchronization action semantics

**Depends on**: Gate 1  
**Files**: `StatusPopout.qml`, `SyncService.qml`, focused plugin tests

- Hide or disable `Sync now` while paused, or make Resume the sole primary action.
- Give busy actions direct progress labels and prevent duplicate requests.
- Keep status, last-sync information, pending work, and conflict guidance visible without exposing
  transport internals.
- Verify change and forget confirmations state the effective result precisely.

### Task 3.2: Make every action keyboard- and screen-reader-operable

**Depends on**: Task 3.1  
**Files**: `BarWidget.qml`, shared action/button QML, plugin tests

- Make the bar widget focusable and activatable with Enter and Space wherever Quickshell permits.
- Verify deterministic tab order through header, settings, help, cards, confirmations, and back
  navigation.
- Preserve visible focus, accessible roles/names, and minimum desktop hit areas.
- Return focus to the invoking control after confirmations and internal page navigation where the
  runtime supports it.

### Task 3.3: Make the primary button theme-safe

**Depends on**: Task 3.2  
**Files**: `PimpampumSettingsButton.qml`, related theme/static tests

- Prefer Quattro's semantic selected/action roles over assuming that `Color.accent` contrasts with
  the popup background.
- If a semantic foreground is unavailable, derive a contrast-safe foreground and test representative
  light, dark, low-chroma, and high-chroma accent themes.
- Preserve full-width sizing, hierarchy, hover, pressed, disabled, busy, and focus states.

### Task 3.4: Complete in-plugin Help

**Depends on**: Tasks 3.1–3.3  
**Files**: `StatusPopout.qml` or extracted Help component, plugin tests

- Keep Help inside Settings as requested.
- Add the general product model present on macOS, followed by synchronization and backup guidance.
- Keep copy concise, scrollable, selectable where useful, and accurate for Omarchy/systemd.
- Use a consistent icon treatment and accessible `Help` label; do not rely on an unlabeled glyph.

### Task 3.5: Reduce popout implementation risk

**Depends on**: Tasks 3.1–3.4

- Extract synchronization card, backup card, Help page, and shared confirmation/action components
  from the large popout only where doing so reduces duplicated state or test complexity.
- Keep service calls and navigation state explicit; do not create a general component framework.
- Preserve current layout, compact density, bounded scrolling, and user-visible behavior during the
  extraction.

**Gate 3**:

- Focused Omarchy tests cover all actions, page transitions, disabled/busy states, semantics, and
  helper argument safety.
- `omarchy plugin validate` passes.
- Keyboard-only static/smoke verification passes before the live visual matrix.

---

## Phase 4 — Documentation and Contract Cleanup

### Task 4.1: Rewrite desktop user documentation against the real UI

**Depends on**: Gates 2 and 3  
**Files**: root README, Omarchy plugin README, macOS documentation, relevant help text

- Remove accordion and manual-path instructions that no longer exist.
- Document internal Overview, Settings, and Help navigation accurately.
- Explain why synchronization selects a provider-managed parent folder and uses a `Pimpampum`
  child, and why backup requires a different recovery destination.
- Document pause versus forget, sync versus backup, conflict behavior, and local-work guarantees.
- Keep installation, update, uninstall, and service lifecycle commands current.

### Task 4.2: Remove stale implementation paths and artifacts

**Depends on**: Task 4.1

- Delete or integrate obsolete settings controllers/views only when they have no remaining callers.
- Remove checked-in or untracked live-failure residue from release inputs while preserving useful
  diagnostics outside the package if required.
- Ensure examples cannot satisfy live-evidence gates.
- Search for obsolete UI labels and flows across source, tests, docs, packaged binaries, and
  fixtures.

### Task 4.3: Approve the new desktop status contract deliberately

**Depends on**: Tasks 4.1 and 4.2

- Review the complete contract diff rather than copying the newly computed hash blindly.
- Update the frozen hash only after the accepted UI/API/test files match the intended V1 contract.
- Record why the contract changed in the release summary.

**Gate 4**:

- Documentation matches both real interfaces.
- Searches find no obsolete `Enter path manually`, accordion, synchronization-only macOS Settings,
  or backup-only packaged-app copy.
- `npm run check:desktop-contract` passes for the reviewed contract.

---

## Phase 5 — Automated Release Candidate Verification

### Task 5.1: Run the complete local quality matrix

**Depends on**: Gate 4

Run, at minimum:

```text
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:evals
npm run test:omarchy
npm run check:desktop-contract
npm run check:quattro-evidence
npm run check:macos-evidence
npm audit --omit=dev
npm pack --dry-run --json
git diff --check
omarchy plugin validate
```

- Run Swift tests/coverage on macOS with the supported Xcode/Swift toolchain.
- Run shell syntax checks and Python helper compilation without leaving cache files in release
  inputs.
- Verify executable modes, helper ownership, rollback, idempotent update/uninstall, and absence of
  token/path shell interpolation.
- Inspect package contents and hashes rather than relying only on exit codes.

### Task 5.2: Perform a security and failure-path audit

**Depends on**: Task 5.1

- Test malicious/invalid helper output, very long paths, quotes/newlines, missing GTK/runtime tools,
  daemon offline/authentication failures, read-only/unavailable folders, and repeated clicks.
- Verify errors never reveal bearer tokens, raw bodies, stderr, receipts, or internal snapshot data.
- Confirm external paths are always passed as process arguments and the live SQLite database remains
  local.
- Confirm cancellation and failed setup leave the previous valid configuration unchanged.

**Gate 5**:

- All automated checks pass from a clean release-candidate commit.
- The package manifest and artifact metadata point to that commit and contain only intended files.

---

## Phase 6 — Direct Live Validation on Both Platforms

### Task 6.1: Complete the Quattro live matrix

**Depends on**: Gate 5  
**Environment**: Real Omarchy/Quickshell session

- Install the plugin through the production installation path from the candidate commit.
- Observe horizontal and vertical bars, light and dark themes, custom accent extremes, compact count
  states, Overview/Settings/Help navigation, long content, keyboard operation, all sync/backup
  states, errors, confirmations, and update/uninstall rollback.
- Record only directly observed results in `thoughts/evidence/quattro-live.json`.
- Fail the matrix if any item is skipped, inferred, or represented only by fixture/static output.

### Task 6.2: Build and complete the macOS live matrix

**Depends on**: Gate 5  
**Environment**: Supported real macOS host

- Check out the exact candidate commit on macOS and build the `.app` with the supported toolchain.
- Run Swift tests/coverage and artifact checks before copying the app into `dist`.
- Observe menu-bar states, popover boundaries, unified Settings, both native pickers, Finder opening,
  Help, keyboard/VoiceOver, light/dark and accent appearances, errors, conflicts, long paths, relaunch,
  Login Item behavior where applicable, and Quit.
- Record the commit and final binary hash in `thoughts/evidence/macos-live.json`.
- Confirm the packaged binary contains the current synchronization and backup UI and no stale copy.

### Task 6.3: Re-run provenance gates after evidence capture

**Depends on**: Tasks 6.1 and 6.2

- Re-run both evidence checkers and the macOS artifact checker.
- Ensure recording evidence has not introduced unreviewed product changes.
- If any product code changes after live testing, invalidate both matrices and repeat affected gates
  from the new commit.

**Gate 6**:

- Both live evidence files pass and identify the same release commit.
- The packaged macOS binary hash is the observed binary hash.
- There are no unobserved or conditionally waived V1 matrix items.

---

## Phase 7 — Final Review and V1 Cut

### Task 7.1: Perform the post-review

**Depends on**: Gate 6

- Review architecture boundaries, requirements, security, accessibility, UI consistency, package
  contents, evidence provenance, and the complete Git diff.
- Compare Omarchy and macOS once more by capability, allowing only documented platform-specific
  differences.
- Fix all blocking and should-fix findings; any code change reopens the relevant automated and live
  gates.

### Task 7.2: Produce the release summary

**Depends on**: Task 7.1

- Document user-visible behavior, platform differences, migration/update instructions, known limits,
  exact verification commands, evidence paths, candidate commit, and artifact hashes.
- State explicitly that synchronization is not a recovery backup and backup is not multi-device
  synchronization.
- Record any truly deferred post-V1 work; no V1 contract item may be deferred silently.

### Task 7.3: Cut V1 reproducibly

**Depends on**: Task 7.2

- Confirm clean Git state and rerun the shortest deterministic release gate immediately before tag.
- Create the V1 tag from the reviewed commit.
- Generate the distributable/package from the tag, compare hashes/content with the approved release
  candidate, and publish only if they match.
- Smoke-install the published artifact through the normal user path on both supported platforms.

**Final Definition of Done**:

- Every V1 contract item is implemented and covered by automated tests.
- Omarchy and macOS expose synchronization, backup, and Help with documented native differences.
- Full repository quality, coverage, security, package, artifact, and contract gates pass.
- Quattro and macOS live evidence is complete, current, and tied to one clean Git commit.
- The published package is byte/content-equivalent to the reviewed candidate where reproducibility
  permits, with any unavoidable signing/notarization transformation recorded and verified.
- A fresh installation and an update from the previous build both work without losing configuration
  or user data.

## Dependency Summary

```text
clean baseline
  -> frozen tests and provenance
     -> macOS completion ---------+
     -> Omarchy completion -------+-> docs and contract approval
                                      -> automated RC verification
                                         -> Quattro live matrix --+
                                         -> macOS live matrix -----+-> post-review
                                                                       -> V1 tag
```

Phases 2 and 3 may be implemented independently after Gate 1. The live matrices may also be run in
parallel after Gate 5, but neither can substitute for the other. Phase 7 cannot begin until both are
complete.
