# Session Summary

**Date**: 2026-08-28 10:20
**Feature**: macOS named Spec progress parity
**Type**: Bug Fix / UI Refinement
**Branch**: `develop`

## What Was Done

- Added the missing `specs` contract to the native macOS overview model and bounded payload validation.
- Added deterministic in-progress and completed Spec groups matching the Omarchy lifecycle rules.
- Added “Specs in progress” rows with the Spec name, project name, completed/total task progress, and active-claim count.
- Added a collapsed “Completed specs” disclosure and kept project/Spec rows able to reveal their workspace.
- Removed decorative icons from Active work, Spec, and Project rows after live visual review.
- Extended Swift unit, presentation, contract, accessibility, and smoke coverage for named Spec progress.
- Extended the reversible macOS live-smoke assertions and approved the rebuilt arm64 app artifact.
- Started a disposable local demo with one project, one ready Spec, three tasks, one completed task, and one active claim without changing `~/.pimpampum`.

## Why

Omarchy already displayed standalone Spec names and progress, but the native macOS client discarded the `specs` field and therefore showed only projects and claimed work. The fix restores desktop parity while keeping the menu compact and read-only.

## Key Decisions

- Show only ready Specs whose project is open; show done Specs in collapsed history, matching Omarchy.
- Treat lease time as claim expiry, not an estimate of work duration.
- Keep the rows text-led and remove decorative status/action icons; preserve accessible labels and click targets.
- Use an isolated data directory and port for visual testing so the user’s real local store remains untouched.

## What's Pending

- User visual confirmation of the icon-free restarted demo.
- Push the four implementation/artifact commits when this local result is accepted.

## Files Modified

| Area                                          | Change                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `platforms/macos/Sources/PimpampumMenuBar`    | Spec model, validation, grouping, presentation, rows, and smoke snapshot |
| `platforms/macos/Tests/PimpampumMenuBarTests` | Contract, sorting, formatting, accessibility, layout, and smoke tests    |
| `scripts/test-macos-live.mjs`                 | Named/progress and completed-Spec live assertions                        |
| `platforms/macos/dist`                        | Approved arm64 menu-bar app artifact                                     |

## Quality Status

- TypeScript typecheck, lint, Prettier, 415 unit/acceptance tests, and 6 E2E tests passed.
- 103 Swift tests passed with 100% core region/function/line coverage.
- Frozen desktop contract passed.
- Approved packaged app hash: `04b67c066a8adbcfc80465b90655d99c41019e3bbb5284bb8ef27440cf45fbc9`.

## Next Steps

1. Confirm the restarted menu no longer contains row icons.
2. Push `develop` after approval.
3. Re-run the release gate from the resulting remote commit before tagging v1.0.0.
