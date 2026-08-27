# Summary: Post-pull macOS and Shared-Sync Hardening

**Date**: 2026-08-27
**Type**: Bug Fix
**Branch**: `develop`
**Scope**: 41 tracked files changed (+808/-224 before this summary), plus new Swift tests, brand source, app-icon sources, and packaged icon resources

---

## What Changed

### Repository integration

- Preserved all existing local changes in `stash@{0}`.
- Fast-forwarded `develop` from `d3de6bb` to `origin/master` at `f6ddab5`.
- Resolved the two overlap conflicts in macOS artifact and settings acceptance tests, then reapplied the complete local worktree unstaged.

### macOS settings and identity

- Corrected the invalid SwiftUI frame call in `SyncSettings.swift`.
- Added typed configuration, transport, authentication, server, schema, payload, and cancellation errors; server messages are bounded and token-redacted.
- Added focused `SyncSettingsTests.swift` coverage for authenticated methods, payload validation, semantic validation, error preservation, and cancellation.
- Extracted `PimpampumBrand` from status presentation into a neutral source file.
- Kept the physical bundle as `PimpampumMenuBar.app`; Finder-facing and in-app identity remains “pim • pam • pum”.
- Changed the footer action to the concise native label “Quit”.
- Dismissed the transient menu-bar popover before opening the retained Settings window, avoiding overlapping surfaces without terminating the app or daemon.
- Made upgrades accept receipt-owned historical bundle roots, migrate their artifacts to the stable bundle, clean up only empty legacy directories, and preserve unrelated user files.

### Shared-folder integrity and security

- Reused canonical schemas for imported IDs, states, slugs, Markdown, artifacts, and bounded collections.
- Extended `PimpampumStore.validateSyncState` to reject imported states that violate project/spec/task lifecycle, descendant, Markdown, or completion invariants before starting a database transaction.
- Canonicalized configured roots with `realpath`, rejected symlinked device/snapshot paths, and verified every directory stays beneath its trusted root.
- Read snapshots through one `O_NOFOLLOW` descriptor, using `fstat` and a hard byte limit before parsing.
- Bound filename `deviceId`, sequence, and UUID to the parsed payload and rejected duplicate snapshot IDs.
- Added hostile regression tests while restoring the global 100% TypeScript coverage gate.

### Bounded APIs and contract parity

- Paginated sync-conflict manifests in HTTP and MCP, including `hasMore`/offset metadata.
- Added direct conflict lookup so reading one conflict never scans an unbounded list.
- Updated the client and OpenAPI response contract for paginated conflicts.
- Unified the no-leading/trailing-hyphen device-ID grammar in TypeScript, HTTP, OpenAPI, QML, and Swift.
- Canonicalized the macOS `/var` acceptance expectation through `realpath`.

### macOS artifact and release checks

- Added Icon Composer sources, `Assets.car`, and `Pimpampum.icns` to the packaged app.
- Included the app-icon source tree in the reproducible macOS source-input hash.
- Rebuilt the arm64 binary and approved schema-2 metadata containing current source, binary, plist, compact-mark, icon, and asset-catalog hashes.
- Corrected every package/install/live-smoke technical path to `PimpampumMenuBar.app` and fixed the branding README.
- Changed the live-evidence gate to use source/binary hashes as the exact binding while retaining the tested commit as traceability metadata.
- Made the live runner wait for `launchd` to finish unloading before reinstalling, retained diagnostics on failure, and generated current schema-2 evidence after a fully successful native smoke.
- Migrated the existing legacy-named installation to `PimpampumMenuBar.app`, ran the complete live smoke against the rebuilt binary, and restored a healthy installed daemon, LaunchAgent, and menu-bar app afterward.

## Why

The latest upstream sync/settings release introduced a Swift compile error, allowed imported snapshots to bypass store invariants, trusted mutable shared-folder paths too broadly, returned unbounded conflict collections, diverged on device IDs, and conflicted with an in-progress branding change that renamed the physical app bundle. The fixes preserve the existing architecture: SQLite stays canonical, Markdown stays opaque, all domain invariants remain in `PimpampumStore`, and client surfaces only consume JSON APIs.

## Decisions Made

| Decision                                   | Rationale                                                                           | Alternative Considered                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Stable `PimpampumMenuBar.app` path         | Preserves receipts, upgrades, uninstall, login-item control, and packaged consumers | Keeping historical physical bundle names indefinitely                    |
| Validate final imported state in the store | Keeps invariants at the canonical transaction boundary                              | Reimplementing rules in the sync controller                              |
| Descriptor-based snapshot reads            | Closes pathname replacement between validation and reading                          | Separate `lstat` followed by path-based `readFile`                       |
| Source-input hash as live evidence binding | Exact and non-self-referential across an evidence commit                            | Requiring evidence to contain its own final Git commit hash              |
| Preserve data during live reinstall        | Exercises the real install lifecycle without touching the canonical user database   | Testing only an isolated bundle without validating the installed upgrade |

## What's Pending

- [ ] Review and commit the unstaged working tree.
- [ ] Drop `stash@{0}` only after the work is committed or otherwise durably backed up.

## Quality Status

| Check                    | Status                                                |
| ------------------------ | ----------------------------------------------------- |
| `npm run typecheck`      | ✅                                                    |
| `npm run lint`           | ✅                                                    |
| `npm run format:check`   | ✅                                                    |
| `npm test`               | ✅ — 410 focused tests, 100% coverage, 6 compiled E2E |
| `npm run test:macos`     | ✅ — 98 tests, 100% core coverage                     |
| macOS artifact checker   | ✅ — arm64 binary and schema-2 metadata verified      |
| desktop contract checker | ✅                                                    |
| Omarchy validator        | ✅                                                    |
| macOS live evidence      | ✅ schema 2; exact source and binary hashes verified  |
