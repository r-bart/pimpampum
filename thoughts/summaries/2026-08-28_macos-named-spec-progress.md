# Summary: macOS Named Spec Progress

**Date**: 2026-08-28
**Type**: Bug Fix / UI Refinement
**Branch**: `develop`
**Scope**: 18 implementation/documentation/artifact files, +562/-125 lines

---

## What Changed

### Native overview contract

- Added `OverviewSpec` and `SpecLifecycleState` to the Swift models.
- Decoded `specs` and `specsTruncated` from schema-v2 overview responses.
- Rejected oversized, duplicate, empty, or negatively counted Spec payloads.

### Menu-bar presentation

- Grouped ready Specs belonging to open projects as in progress.
- Grouped done Specs into collapsed completed history.
- Rendered Spec title, project title, completed/total tasks, and active claims.
- Kept Spec and Project rows clickable so Finder can reveal the registered workspace.
- Removed decorative icons from Active work, Spec, and Project rows after visual review.
- Made in-progress Specs and Projects collapsible and open by default; Active work remains permanently visible.
- Replaced the unreliable `DisclosureGroup` hit target with full-width section buttons and explicit expanded/collapsed accessibility state.
- Kept the entire content area inside the existing 480px scroll boundary.
- Kept global app controls and branding unchanged.

### Verification and demo

- Extended Swift fixtures and tests for decoding, validation, grouping, ordering, formatting, accessibility, and bounded layout.
- Added Spec rows to native smoke snapshots and real macOS smoke assertions.
- Built and approved the packaged arm64 app.
- Created a disposable live portfolio on port 7449 showing “Menu bar parity” and “Named Spec progress on macOS” at 1/3 tasks with one active claim.
- Rendered 20 ready Specs and 20 projects in the native layout test to verify the expanded lists remain scrollable and bounded.
- Used the packaged native smoke harness to locate and press the `Specs in progress (9)` accessibility button successfully.

## Why

The TypeScript overview API and Omarchy widget already exposed standalone Spec progress. The macOS model omitted the field, so valid Spec data was silently lost before presentation. This targeted fix makes both desktop surfaces tell the same story without changing domain rules or the server contract.

## Decisions Made

| Decision                                     | Rationale                                                     | Alternative Considered                                             |
| -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Match Omarchy lifecycle filters              | Ensures cross-platform semantic parity                        | Show every non-terminal Spec, including drafts and paused projects |
| Collapse completed Specs                     | Preserves useful history without overwhelming a 360px popover | Hide completed Specs entirely                                      |
| Display `completed/total` plus active claims | Provides durable progress even when no task is claimed        | Show only Active work claims                                       |
| Remove row icons                             | Text already conveys state; icons added visual noise          | Keep colored project/Spec status glyphs                            |
| Collapse long resource sections              | Users can reduce density without hiding urgent Active work    | Make every section, including Active work, collapsible             |
| Use full-width section buttons               | Makes the whole header reliably clickable on macOS            | Keep the native `DisclosureGroup` label hit target                 |
| Keep lease countdown                         | It accurately communicates claim availability                 | Present it as an ETA or remove claim expiry information            |
| Use a disposable data directory              | Makes the demo reversible and protects real local data        | Seed `~/.pimpampum` directly                                       |

## What's Pending

- [ ] User visual confirmation of the restarted icon-free, collapsible menu.
- [ ] Push the local implementation, documentation, and artifact commits after acceptance.
- [ ] Run final remote release gates before any v1.0.0 tag is authorized.

## Quality Status

| Check                   | Status                           |
| ----------------------- | -------------------------------- |
| TypeScript typecheck    | ✅                               |
| TypeScript lint         | ✅                               |
| Prettier                | ✅                               |
| Unit/acceptance tests   | ✅ 415 tests, 100% coverage      |
| E2E tests               | ✅ 6 tests                       |
| Swift tests             | ✅ 103 tests, 100% core coverage |
| Frozen desktop contract | ✅ 8 artifacts                   |
| Packaged arm64 artifact | ✅ approved                      |
