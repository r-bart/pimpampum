# Summary: Quiet macOS npm onboarding

**Date**: 2026-08-27
**Type**: Feature / Bug Fix
**Branch**: `develop`
**Scope**: 19 files changed, +511/-76 lines relative to `origin/develop`

---

## What Changed

### macOS onboarding

- Added a native Quiet setup view for installations with a missing or unreadable receipt.
- Shows `npm install --global pimpampum && pimpampum install --service-only` as a copyable command.
- The primary action copies the command, opens Terminal, and registers the downloaded app with Login Items.
- The secondary action rechecks installation state and now uses the same size, radius, and interaction language as the primary action with a subdued surface.
- Added actionable Login Items recovery guidance to the normal status view.

### CLI and service installation

- Added the `--service-only` install mode and separated daemon/receipt handling from app bundle installation.
- Added CLI and launchd coverage for the new contract.
- Changed the generated LaunchAgent from `ProcessType=Background` to `ProcessType=Interactive`.

### Packaging and documentation

- Updated the README with the npm-to-macOS onboarding contract.
- Added a decision note covering the Quiet approach and explicit Terminal boundary.
- Rebuilt the approved macOS bundle; the final executable SHA-256 is `6a49e5727c17ce10dde4944e8d253cc35fd2222ecfb6db49890d9bbbfd7ebabb`.

## Why

The standalone macOS download does not itself provide the CLI and MCP service distributed through npm. The onboarding makes that dependency understandable and recoverable without silently executing shell commands. During the full live flow, launchd's background scheduling caused V8 startup to take over a minute; the interactive process class restores predictable UI readiness.

## Decisions Made

| Decision                                          | Rationale                                                 | Alternative Considered                                    |
| ------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| Show onboarding only for invalid/missing receipts | Existing users should go directly to status               | Show setup on every launch                                |
| Copy command and open Terminal                    | Preserves an explicit security and consent boundary       | Execute the install command from the app                  |
| Install only the daemon from npm onboarding       | Avoids overwriting or duplicating the downloaded app      | Run the full platform installer                           |
| Use launchd `Interactive` process type            | The menu-bar UI directly needs low-latency HTTP responses | Keep `Background`, which produced minute-long cold starts |
| Keep npm as canonical CLI/MCP channel             | One package serves macOS and Omarchy consistently         | Bundle Node and the service inside the app                |

## What's Pending

- [ ] Publish `pimpampum@1.0.0` to npm and repeat the exact registry install command.
- [ ] Capture Omarchy Quattro live release evidence.
- [ ] Finish Developer ID signing/notarization setup and create `v1.0.0` after all gates pass.

## Quality Status

| Check                         | Status                                         |
| ----------------------------- | ---------------------------------------------- |
| typecheck                     | ✅                                             |
| lint                          | ✅                                             |
| format check                  | ✅                                             |
| TypeScript tests              | ✅ — 413 tests, 100% coverage                  |
| E2E tests                     | ✅ — 6 tests                                   |
| macOS tests                   | ✅ — 100 tests, core coverage 100%             |
| Local onboarding/install flow | ✅ — app, receipt, daemon, health, and restart |
| npm registry install          | Blocked — package is not published (`E404`)    |
