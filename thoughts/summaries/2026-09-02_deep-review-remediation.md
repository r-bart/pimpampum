# Session Summary

**Date**: 2026-09-02
**Feature**: Remediation of the 2026-09-01 deep review, all ten phases
**Type**: Bug fix / Hardening / Refactor
**Branch**: `remediation/deep-review` (from `develop`)
**Release**: `v1.3.0`

## What Was Done

- Closed all 128 findings of `thoughts/reviews/2026-09-01_deep-review.md` in four commits. The
  report now carries a dated ledger in its section 1b that names every id against its wave.
- Fixed the five items that made a release unsafe: the packaged update channel, the Omarchy mirror
  outside the release pipeline, the file-size cap that broke Claude Code connect, the locale
  dependent sync ordering, and the 157 MB npm package.
- Rebuilt the install topology on macOS so an adopted user-owned bundle is never modified or
  deleted, and so an installed CLI with no build tree can still run `status` and `uninstall`.
- Made the test suite honest: source-text greps no longer count as acceptance coverage, the frozen
  hashes are limited to the four overview fixtures, every committed fixture is produced by a
  checked-in script, and the compiled E2E files no longer run inside the unit pass.
- Reduced the five largest units in the repository and removed the duplication groups the review
  named, without changing behaviour.

## The Four Waves

| Wave | Commit    | Phases | Subject                                                           | Ids |
| ---- | --------- | ------ | ----------------------------------------------------------------- | --- |
| 1    | `9677e18` | 0–4    | Release channel, sync integrity, macOS topology, Omarchy, runtime | 59  |
| 2    | `b132708` | 5–6    | Adapter contracts, CLI composition, service and connectors        | 45  |
| 3    | `3193d4a` | 7–8    | Documentation, site, process, test honesty                        | 24  |
| 4    | `711f43b` | 9      | Structure across store, runtime, CLI, service, scripts, native    | —   |

Wave 4 carries no id because section 6 of the review is not numbered in the coverage matrix.

## Wave 4 in Detail

Behaviour is unchanged except for three defects found while restructuring.

**Reductions.**

| File                                                     | Before | After |
| -------------------------------------------------------- | ------ | ----- |
| `src/store.ts`                                           | 2,298  | 260   |
| `integrations/omarchy/pimpampum-status/StatusPopout.qml` | 1,983  | 307   |
| `src/cliMain.ts`                                         | 1,937  | 77    |
| `scripts/test-omarchy-live.mjs`                          | 1,572  | 212   |
| `src/runtime/installer.ts`                               | 1,250  | 30    |

**Three defects fixed in passing.**

1. The runtime stage-marker write sat outside the `try`/`finally` that clears the staging
   directory. A failed write left an empty `.pimpampum-stage-*` that the next install rejected as
   not receipt-owned, so one transient error blocked every later installation.
2. `createAgentClient` threw synchronously although its signature returns a promise. A caller using
   `.catch()` never saw the failure.
3. The Omarchy connection service compared agent state against loose string literals instead of the
   generated vocabulary, in 21 places. Renaming one label would have broken agent detection, the
   button labels and the warning colour at once, with no error anywhere.

**One judgment recorded.** Two literals were left in place deliberately. The bar's own state table
mixes different concepts and matches a vocabulary label by coincidence of wording. Sixty-eight
contract names travel over the wire to the daemon, where a mismatch raises a loud validation error
rather than failing silently.

## Verification

Every gate was run on 2026-09-02 after the fourth commit, on this machine.

| Gate                                              | Result                                        |
| ------------------------------------------------- | --------------------------------------------- |
| `npm run typecheck && lint && format:check`       | Green                                         |
| `npm test`                                        | 112 files, 1,570 tests, 100% coverage         |
| Compiled E2E                                      | 4 files, 13 tests                             |
| `npm run test:macos`                              | 100% on the widened Swift manifest            |
| `npm run test:omarchy`                            | 68 tests                                      |
| `npm run check:desktop-contract`                  | 4 frozen artifacts verified                   |
| `node scripts/check-release-versions.mjs v1.2.11` | 5 version sources aligned                     |
| `npm run check:package-size`                      | 420 files, 2.4 MB unpacked, no app or runtime |
| `npm run check:omarchy-mirror`                    | Fails: the mirror is at 1.2.9                 |

A sample of twelve high-severity fixes was verified by reading the code, not by trusting the commit
message: H-01 (embedded key and redirect allow-list), H-02 (mirror job present), H-03 (`ulimit`
gone), H-04 (`compareCodeUnits`, the only `localeCompare` left is in the comment explaining its
absence), H-08 (systemd restart), H-09 (`inspect.ts` never imports `journal.ts`), H-10 (generated
OpenAPI components with a router test), H-11 (`slugSchema` in the sync contract and a separator
guard in `contextDocumentPath`), H-12, H-14 (no `@immutable` header remains), H-17
(`test/sync.e2e.test.ts` runs in the compiled pass), L-38.

## Two Defects the Release Preparation Found

Both were release blockers, and both were invisible until the version moved off `1.2.11`.

1. **The macOS bundle version was a manual step.** `platforms/macos/Resources/Info.plist` carried
   `CFBundleShortVersionString` as a literal, hand-bumped in a `chore: prepare` commit at every
   release, and `check-release-versions.mjs` did not cover it. Bumping to `1.3.0` made
   `check-macos-artifact.mjs` reject the app with "must use the package release version". The
   template now carries `__PIMPAMPUM_VERSION__`, `build-macos-app.sh` substitutes it and refuses a
   template without it, and the version check rejects a literal there.
2. **The macOS live smoke could not run.** Removing the app from the npm package left
   `scripts/test-macos-live.mjs` reading it back out of
   `node_modules/pimpampum/platforms/macos/dist`, which the same change deleted. The runner failed
   on its very first command with a null exit status. Only the release job runs it, so the breakage
   had been latent since wave 1. It now stages `platforms/macos/dist/Pimpampum.app` with `ditto`,
   which is where the release job's approval step leaves the signed bundle anyway.

Neither would have been caught by the suite: the first needs a version change, the second needs the
live runner. Running the release checklist is what found them.

## What Is Not Verified

1. **The Omarchy popout is unverified visually.** No machine here draws QML. Wave 4 split
   `StatusPopout.qml` into three pages behind a `Loader`. The states to inspect on the Omarchy
   machine are the popout frame, the three pages and their transitions, the portfolio content with
   its empty states, the two collapsible groups, the managed-folder cards in four states, row focus
   and highlight, and the Agents card.
2. **The macOS live smoke is unrun.** It needs a Mac with no user installation.
3. **The mirror is one release behind.** Published 1.2.9 against a local 1.2.11. The manifests did
   not change in wave 4, so the difference predates it and the release work closes it.
   Both of the structural gaps found while closing the paperwork were then fixed, so they are not on
   this list. Gate 9's numeric clause had never been measured; it now passes, the six offending units
   were split, and `npm run lint` enforces both limits on `src/**` with nine declarative factories
   exempted by name. The source-text criterion is now literally true: the Omarchy wiring contract moved
   into `test/source-contract.test.ts`, leaving exactly one test file that reads repository sources.

## The v1.3.0 Release

The plan mapped this work to five tags, `v1.2.12` to `v1.2.15` and then `v1.3.0`. It shipped as one
minor version. No wire contract changed. A database migrates forward to schema v3 and `v1.2.11`
cannot read it afterwards, which is the only one-way step in the release.

Two secrets have to exist before the tag, and they belong in different places. The `publish` job
declares `environment: release`, so `RELEASE_MANIFEST_SIGNING_KEY` belongs to that environment. The
`mirror` job declares no environment, so `OMARCHY_MIRROR_DEPLOY_KEY` belongs to the repository.
Setting both in the same place leaves one job reading an empty value.

The Omarchy runtime digests no longer need a second tag. A `node:24.19.0-bookworm` container whose
platform matches the target reproduces the CI archive byte for byte, verified against `v1.2.11`. The
recipe is in `thoughts/notes/2026-09-02_reproducing-runtime-digests.md`.

## Architecture

The remediation did not move a layer boundary; it made the existing ones hold. `PimpampumStore`
stays the only SQLite owner, now as a facade over sixteen aggregate modules that share one
`StoreContext`. The adapters above it keep the gateway contract and their typed error codes. Two
import slips the review named are resolved differently: `assertNoSymlinkTraversal` moved down into
`src/fsGuards.ts`, so `syncController.ts` no longer reaches into the installer layer, while
`service/manager.ts` still imports `launchd` and `systemd` as its default adapter selection. The
contract each wave had to keep was the wire: every public method set, error code, message and
envelope shape is preserved, which is why a pure refactor could ship under a suite at 100%.

## Implementation

Wave 4 split `src/store.ts` into `src/store/*` (sixteen modules), `src/runtime/installer.ts` into
`ownedFiles`, `receipt`, `journal`, `payload`, `install`, `removal` and `inspect`, and `cliMain.ts`
into nine `src/cliComposition/*` modules plus `src/service/packagedLifecycle.ts`. Shared primitives
landed in `src/fsAtomic.ts`, `src/fsGuards.ts`, `src/objects.ts`, `src/diagnostics.ts`,
`src/aggregateRollback.ts` and `src/syncValidation.ts`. Migration v3 makes `workspaces.root_path`
nullable. On the native side `StatusPopout.qml` became a `Loader` over `PortfolioPage`,
`SettingsPage` and `HelpPage` with a `PopoutController`, and one generated state vocabulary now
feeds both QML and Swift with a `--check` mode in both native gates. New tests cover the split
surfaces: `test/cli-composition.test.ts`, `test/cli-packaged-lifecycle.test.ts`,
`test/migrations-v3.test.ts`, `test/fs-atomic.test.ts`, `test/fs-guards.test.ts`,
`test/aggregate-rollback.test.ts` and `test/objects.test.ts`, among others. Not covered: the QML
rendering of the split popout, the macOS live smoke, and the six units that still exceed the
structural limits.
