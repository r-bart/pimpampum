# Session Summary

**Date**: 2026-09-01 16:34 CEST
**Feature**: macOS first-run reliability and the v1.2.11 release
**Type**: Bug fix / Release
**Branch**: `develop` → `master` (PR #30)

## What Was Done

- Fixed fourteen defects in the macOS first-run experience, almost all of them reachable only on a
  clean install. The published `v1.2.10` could not complete setup at all on a fresh machine.
- Rewrote the guided setup: four steps instead of three, a welcome step, and copy with "private
  service" removed from every user-facing string.
- Made the confirmation screen list the plan the daemon will execute, with the real path of every
  change, implementing a functional requirement that had been specified and never built.
- Widened the Swift coverage manifest to include `SetupModels.swift`, and recorded the measured
  coverage of the files still outside it.
- Published `v1.2.11` to npm and GitHub with provenance, after four failed release attempts.

## The Defects

Grouped by what made them possible:

**Contract mismatches between the CLI and the app**

1. `SetupNDJSONDecoder` split stdout on newlines while `setup plan` and `setup status` leave the CLI
   as one indented `{ "data": ... }` envelope. Every clean first run failed.
2. `manager.status()` and `uninstall` planned artifacts from the app bundle, which an installed CLI
   does not have. `pimpampum-control status` and `uninstall` were unusable.

**State machine**

3. `resume()` announced a mutation before reading the journal, so the onboarding jumped to its final
   step and never came back.
4. `canReview` required a selected agent, so a Mac with none detected could never confirm setup —
   contradicting the success metric that requires exactly that case to work.
5. Agent detection rejected symlinks, and both CLIs install as links into `~/.local/bin`.
6. Applying relaunched the app inside `apply()`, so `onFinished` never ran and the popover stayed on
   a half-finished setup.
7. `OverviewStore` reported "offline" on the first failed poll, which lands right after setup while
   the daemon is still coming up.

**Install topology**

8. Installation copied the app to `~/Applications` even when the user had already placed it in an
   Applications folder. Registering the login item then started that second copy: two menu-bar icons.
9. `open -W` waited on the wrong process once the adopted app and the unregistration helper were the
   same bundle.
10. The installed CLI did not know where the app was, so uninstall launched a helper that was not
    there.
11. A second instance still started, because macOS starts the app when the login item is registered.

**Presentation**

12. Every step sized itself to its own content, so the popover resized between steps and the primary
    button slid out from under the pointer.
13. `.sheet` from a menu-bar popover closes the popover: a sheet is a real window and the popover
    closes on losing key focus. Both help dialogs used one.
14. The confirmation block rendered a hand-written constant while `SetupChange.path` existed and was
    always null.

## Why

Six of these were specified correctly and implemented differently. Two were introduced while fixing
the others. Every gate stayed green throughout: the tests asserted the implementation rather than
the spec, and the Swift coverage gate reported 100% while measuring none of the files where the
defects lived.

## Key Decisions

- Adopt an app the user already placed in an Applications folder instead of copying it. Writing into
  `/Applications` was never an option — service artifacts must stay inside the home directory — so
  setup owns no file inside an adopted bundle, and uninstall leaves the app for the user to remove.
- Keep the confirmation disclosure but move it behind a help sheet. The step shows five plain lines;
  the paths stay one click away, because the spec requires them to be inspectable before confirming.
- Cover `SetupModels.swift` and add it to the coverage manifest rather than covering everything
  outside it. `SetupStore.swift` (56%) and `SetupCommandRunner.swift` (64%) are their own work.
- Mark the embedded-runtime rollback branch `v8 ignore` with a justification, following the existing
  pattern, and prove the behaviour in a test that mocks the filesystem.

## The Release: Four Failures

All four were caused by this session's own changes, and all four were only reachable in the release
job. Nothing published on any of them: the live smoke runs before signing, npm, and the release.

1. The smoke asserted the accessibility label `Continue to detected agents`, which moved to step 2
   when the welcome step was added.
2. The smoke read the frame immediately after tearing down the daemon, which is now "loading" while
   the cold-start grace runs.
3. The fix for 2 was wrong: waiting between snapshots cannot work, because each snapshot launches a
   fresh process that restarts the grace at zero. The state has to settle inside the harness.
4. The Omarchy runtime digests were generated from a macOS build. `build-runtime-bundle.mjs` is
   deterministic per host, not across hosts. Two CI runs printed identical digests, confirming the
   real ones.

Running `PIMPAMPUM_RUN_LIVE_MACOS=1 npm run test:e2e:macos` locally before the first tag would have
caught the first three. It was run before the fourth attempt and passed first time.

## Files Modified

| Area                                        | Change                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `platforms/macos/Sources/PimpampumMenuBar/` | Decoder, store, onboarding, help dialogs, single-instance guard, smoke harness                          |
| `src/service/`                              | `ServiceArtifactRef`, `canPlanArtifacts`, receipt-based status, app adoption, recorded application path |
| `src/setup/coordinator.ts`                  | Plan names the real path of every change, plus a `data` change                                          |
| `scripts/`                                  | Live smoke expectations, coverage manifest                                                              |
| `integrations/omarchy/`                     | Runtime pins regenerated from the digests CI produces                                                   |
| `thoughts/specs/`                           | Amended for four steps, the approved copy, and the planned-path requirement                             |

## Quality Status

1025 TypeScript tests, 211 Swift, 100% coverage on both, Omarchy validation, the frozen
desktop-status contract, and the macOS flow walked end to end on a clean machine by the user.

## What's Pending

- **Omarchy has not been verified live.** The changes to `src/service/manager.ts` also affect that
  adapter. Tests and validation pass; a real install on the Omarchy machine does not exist yet.
- `SetupStore.swift` and `SetupCommandRunner.swift` remain outside the coverage manifest.
- No test crosses real CLI output with the real Swift decoder; the new fixtures are captured from a
  real invocation but are still fixtures.
