# Summary: V1 Release Readiness

**Date**: 2026-08-27
**Type**: Bug Fix / Release Engineering
**Branch**: `develop`
**Scope**: 96 files in the final working tree, approximately +1841/-621 before this summary

## What Changed

### Product correctness

- Reindexed project/spec/task synchronization relationships before lifecycle validation, removing repeated whole-state scans for the maximum-size wire contract.
- Replaced unbounded descriptor reads with a size-bounded read that rejects files changed during the read boundary.
- Added macOS recovery guidance for conflicts, unavailable shared folders, and synchronization errors.
- Removed the unused backup-only window controller and kept the unified Settings controller as the single route.

### Version and documentation

- Advanced every current public runtime and fixture contract to `1.0.0`.
- Added complete npm author, repository, issue, homepage, public-access, and provenance metadata.
- Updated README claims for Apple Silicon support, Synchronization plus Backup Settings, the `Quit` label, source-build signing boundaries, npm installation, and GitHub Release assets.

### Artifact provenance and distribution

- `prepack` now builds TypeScript but only verifies the reviewed macOS app; it never rebuilds or approves the native artifact.
- Artifact approval rejects uncommitted canonical Swift/resource inputs and records their exact Git commit.
- Approval metadata moved outside the `.app`, allowing the final signed/notarized bundle to stay sealed.
- macOS live evidence must match the artifact source commit, source-input hash, and final executable hash.
- Added scripts to verify Developer ID/Gatekeeper/notarization and to create npm, macOS ZIP, and checksum release assets.
- Added CI for Linux and macOS plus a tag workflow that signs, live-tests, notarizes, publishes npm with provenance, and creates a GitHub Release.

## Why

V1 needs more than green unit tests: it needs bounded hostile-input behavior, one coherent native Settings architecture, honest platform documentation, immutable reviewed artifacts, real target-platform evidence, and a repeatable public distribution path.

## Decisions Made

| Decision                                    | Rationale                                                           | Alternative Considered                             |
| ------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| npm canonical, GitHub Releases supplemental | The `.app` alone lacks the daemon, token, and receipt               | Track every release binary directly in Git         |
| Apple Silicon-only V1                       | Matches the reviewed arm64 artifact and current checker             | Claim generic macOS or delay for a universal build |
| External artifact metadata                  | Signing must not invalidate a resource inside the app bundle        | Autoapprove during `prepack`                       |
| Block the tag on real gates                 | Quattro evidence and Apple credentials cannot be simulated honestly | Publish an unsigned or partially tested V1         |

## What's Pending

- [ ] Real Omarchy Quattro live evidence.
- [ ] Developer ID Application and notarization secrets in the GitHub `release` environment.
- [ ] npm trusted-publisher configuration and final repository visibility decision.
- [ ] `v1.0.0` tag and automated publication.

## Quality Status

| Check                            | Status                              |
| -------------------------------- | ----------------------------------- |
| TypeScript typecheck/lint/format | Pass                                |
| TypeScript tests                 | 410 pass, 100% coverage             |
| Compiled E2E/evals               | 6 pass                              |
| Swift tests                      | 97 pass, 100% core coverage         |
| Omarchy static/tests             | 31 pass                             |
| Desktop contract                 | Pass                                |
| macOS artifact/live evidence     | Pass for commit `3d00231`           |
| npm audit                        | 0 vulnerabilities                   |
| npm package dry run              | Pass, 1.34 MB compressed, 158 files |
| Quattro live evidence            | Blocked: requires Quattro host      |
| Developer ID/notarization        | Blocked: identity not installed     |
