# Guided setup progress bar, and getting the macOS live smoke green

Date: 2026-09-02
Branch: `remediation/deep-review`
Commits: `d928c96`, `e707789`, `8e1c713`, `1aeadd5`

## What shipped

The onboarding step marker `1 OF 4` became four capsule segments, filled up to and including the
current step. The decision lives in `SetupOnboardingPresentation`, inside the
`check-swift-coverage.sh` manifest, not in the SwiftUI body. The accessibility label `Step 1 of 4` is
now the only place the count is spelled out.

## What the change exposed

Three defects, none of them in the bar.

1. **The live smoke's budget measured the wrong span.** `main()` runs `verifyLegacyMigration`
   between the first-run UI and the connector lifecycle, so 88s of legacy migration sat inside a
   window whose own comment says it covers preflight through the first verified agent. Excluded by
   subtraction through `budgetExcludedMilliseconds`, not by reordering, because the later scenarios
   build on the state it leaves.
2. **Artifact approval runs before the live smoke, not after.** The smoke's `readReleaseArtifact()`
   reads the `PimpampumMenuBar.artifact.json` that approval writes. Release checklist step 4 was not
   executable locally as written; it now names the approve step and its committed-tree requirement.
3. **`check-macos-evidence` cannot pass locally after a commit.** It asserts
   `evidence.gitCommit === HEAD`, and committing the regenerated evidence makes it stale by exactly
   one commit. Demonstrated in-session: exit 0 with HEAD matching, exit 1 immediately after the
   commit. `8ceb52d` already failed it, naming `95c53fb`, so this is not a regression.

## Measurements worth keeping

Phase instrumentation of the budget window, machine calm:

| Phase                                       | Cost  |
| ------------------------------------------- | ----- |
| Preflight and the 149 MB `ditto`            | 5.8s  |
| `verifyCleanSetup` (one full `setup apply`) | 44.7s |
| `verifyFirstRunUi`                          | 0.5s  |
| `verifyLegacyMigration`                     | 88.0s |
| To the first verified agent                 | 35.1s |

The 88s decomposes into an uninstall, a legacy `install --service-only`, and a second full
`setup apply`. One `setup apply` alone is 44.7s, so the figure is proportionate and excluding it
hides no performance defect.

Three samples of the corrected budget on Apple Silicon: 91333ms, 94849ms, 101126ms against 120000ms.
Load average at each start was 17.1, 37.5 and 9.2, and the slowest sample came from the least loaded
machine, so host load does not predict the figure.

## Open risk

The publish job runs on `macos-15`, a 3-vCPU runner, and the worst local sample leaves 15.7% margin.
`.github/workflows/release.yml` triggers only on `push: tags: ['v*']`, so the budget cannot be
measured on CI hardware without publishing a tag.

## Defect found and not yet fixed

`eventually` in `platforms/macos/Tests/PimpampumMenuBarTests/OverviewTestSupport.swift:225` polls 200
times at 2ms, so it gives a concurrent task 400ms to reach a condition. Under load,
`SetupStoreCoverageTests.swift:443` failed on `await eventually { await clock.hasSleeper }` with the
suite otherwise green. There are 33 call sites across 6 test files, and the macOS CI job runs
`npm run test:macos`. Raising the iteration count costs nothing, because the helper returns as soon
as the condition holds.

## Process lesson

Piping a long command through `tail` for readability makes the shell report `tail`'s exit code. A
crashed run then reads as a pass. This happened three times in one session, twice after the rule
against it was written down. Redirect to a file and echo `$?` immediately after the bare command.
