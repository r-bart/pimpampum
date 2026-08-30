# Session Summary

**Date**: 2026-08-30
**Feature**: Omarchy popout contrast and recoverable setup states
**Type**: Bug Fix / UI Refinement
**Branch**: `develop`

## What Was Done

- Switched the Omarchy popout from bar-derived colors to the popup card's native text and
  background tokens, fixing invisible content on light wallpapers with a dark theme.
- Reworked the no-workspaces and no-projects states into concise first-run guidance.
- Reworked rejected credentials into a recoverable authentication state with the repair command
  on its own surface.
- Added validator and unit coverage for popup colors, empty-state copy, repair commands, and
  portfolio ordering.
- Bumped the package to `1.1.0` and removed hardcoded version expectations from HTTP/server tests.
- Aligned the CLI service receipt, macOS bundle, Omarchy manifest, MCP registry metadata, README,
  and website with `1.1.0`; Node release validation now derives the version from `package.json`.
- Reinstalled the local service and plugin, synchronized credentials, restarted the daemon and
  Omarchy shell, and verified the installed overview helper returns an authenticated response.
- Added `update:check` and `update`: the first is read-only, while the second installs the latest
  npm release and reconciles the service and desktop integration through the newly installed CLI.
- Added update guidance to the Omarchy and macOS help surfaces and documented the in-place flow.
- Added an Omarchy Settings update card with explicit check/install actions, stable loading/error/
  current/available states, and a receipt-bound helper that cannot drift to a different CLI.
- Added the macOS Settings > Updates panel and brought it to Omarchy parity: it surfaces the CLI's
  typed failure envelope, names the running operation, and asks for a relaunch after an install.
- Split `UpdateSettings.swift` into a covered store, a thin `Process` adapter, and a declarative
  view, then added `UpdateSettingsStore.swift` to the Swift coverage manifest.
- Rebuilt and re-approved the checked-in macOS artifact from macOS, so the local gate matches the
  reviewed sources instead of the `1.0.0` bundle.
- Sent the update runner's stderr to `FileHandle.nullDevice`. An unread `Pipe` blocks npm once its
  warnings fill the pipe buffer, and stdout then never reaches EOF.
- Bounded the npm version quoted in `npm returned an invalid Pimpampum version`, and clamped what
  the macOS panel renders. `runServiceCommand` accepts 1 MB of stdout and that text is now shown.
- Quoted npm's own reason in `Update check failed` and `Pimpampum update failed`. A registry
  policy, a permission error, and an offline machine used to be one indistinguishable failure.
- Mapped a `bad_request` reply to the reinstall notice. Only an app newer than the CLI beside it
  can produce one, and "Unknown command: update:check" is not something a user can act on.
- Added `UpdateCommandRunnerTests`: real processes that prove the exit code and stdout survive a
  failing run and that a child flooding stderr cannot deadlock the read.
- Bumped the release to `1.1.1` and aligned the macOS bundle, Omarchy manifest, MCP registry
  metadata, README, and website with it, then re-approved the checked-in macOS artifact.
- Fixed the defect `1.1.1` shipped with: the CLI writes its typed error envelope to stderr, but
  both desktop adapters parsed stdout, which a failing run leaves empty. Every npm refusal was
  reported as "Check your connection and retry", so the bounded npm reason reached nobody.
- The macOS adapter now drains stdout and stderr concurrently on two dispatch queues instead of
  discarding stderr, which is what the earlier deadlock fix had done.
- `UpdateService.qml` gained `actionableFailure`, the bounded stderr reader `BackupService.qml`
  already used, and an install-specific fallback.
- Bumped the release to `1.1.2`.
- Measured the fix against the installed CLI on macOS with the shipped adapter logic. A failing
  `pimpampum update` returns exit 1 with 0 bytes on stdout and 383 on stderr, and the new reader
  produces "Pimpampum update failed: notarget No matching version found for pimpampum@1.1.2 with
  a date before 8/23/2026, 3:00:24 PM." The empty stdout is exactly why 1.1.1 showed a generic
  message. The panel itself still has to be exercised against the shipped 1.1.2 artifact.

## Key Decisions

- Popout content uses `Color.popups.text` and `Color.popups.background`; bar foreground tokens are
  only appropriate for content painted directly on the bar.
- Setup states use a headline, one explanatory sentence, and a separate command surface when one
  bounded command resolves the condition.
- Commands wrap instead of eliding because a truncated repair command is unusable.
- Project creation is not suggested in the no-projects state because it requires arguments the
  popout does not own.
- The macOS update runner returns the exit code and stdout unchanged. Collapsing a non-zero exit
  into one message would report a failed service reconciliation as a connection problem.
- Every Updates copy decision lives in `UpdateSettingsPresentation`, so the wording is enforced by
  tests rather than by reading a SwiftUI body.
- An install marks the app for relaunch. `afterInstall` only activates the already-running
  instance, so the new menu app appears after the user quits and reopens this one.

## Quality Status

- Typecheck, lint, and formatting pass.
- 478 unit/acceptance tests pass with 100% statement, branch, function, and line coverage.
- 6 E2E tests pass.
- 34 Omarchy plugin/service tests and the plugin validator pass.
- All 8 frozen desktop-status contract artifacts pass.
- 122 Swift tests pass across nineteen suites, at 100% region, function, and line coverage for the
  enforced core.
- The macOS artifact gate passes against a `1.1.0` bundle rebuilt and approved from macOS.
- `pimpampum update:check` was exercised against the live npm registry on macOS and returned
  `updateAvailable: false` for `1.1.0`.
- `pimpampum update` was exercised end to end on macOS against a stub npm on a copied Node, and
  returned `updated: true` with `serviceReconciled: true`. The real npm was never invoked.
- The deadlock fix was verified by reintroducing `Pipe()`: the runner test hangs past 90 seconds
  and passes in 0.2 seconds once stderr goes to `nullDevice`.
- The panel was exercised in the installed app on macOS. The `1.1.0` tarball was installed
  globally and reconciled to the `launchd-macos-app` adapter with `loginItem: enabled`. Settings >
  Updates reported the idle copy, the `Checking…` state, and `1.1.0` installed and latest.
- The install path stayed unreachable: `1.1.0` is the newest published release, so no run could
  produce `Install update` or the relaunch notice against the real registry.

The npm tarball is still produced only by the release workflow, which rebuilds, signs, notarizes,
and re-approves the macOS app before publishing.

## Review Result

Strict post-review found no remaining correctness, security, architecture, accessibility, or
requirements issues. The changes are ready to commit and push.

## Known Gaps

- `SyncSettings.swift` holds `SyncSettingsStore` next to its view and appears in neither the Swift
  coverage manifest nor the reviewed exclusions. It predates this work.
- No automated live smoke covers the macOS Updates panel; `scripts/test-macos-live.mjs` still
  exercises only the popover and the Settings window. The panel was verified by hand instead.
- Nothing has ever run `Install update` against the real registry, on either platform. The next
  published release is the first chance to exercise it end to end.
- `thoughts/evidence/macos-live.json` is bound to the previous binary. Only `release.yml` runs
  `check:macos-evidence`, and it regenerates the evidence first, so the release is unaffected.
- `pimpampum update` cannot succeed on this machine: `minimum-release-age` in the user's `.npmrc`
  makes `npm install --global pimpampum@1.1.0` fail with `ETARGET`. The panel now quotes that
  reason. It is a local npm policy, not a defect.
- The `unavailable` suggestion still names `pimpampum status` and `pimpampum install`, which does
  not fit an npm failure. The desktop panels render `message` only, so no user sees it today.
- Neither platform bounds how long an update command may run. A hung `npm view` leaves the control
  disabled until the app restarts. A timeout would have to cover `check` only, because killing a
  half-finished `update` is worse than waiting.
- `UpdateSettingsStore` does not check `Task.isCancelled`, unlike `OverviewStore` and
  `BackupSettingsStore`. Nothing cancels it: the button owns an unowned `Task` and the runner uses
  `Task.detached`, which does not inherit cancellation.
