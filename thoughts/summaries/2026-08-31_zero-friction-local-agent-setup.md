# Summary: Zero-Friction Local Agent Setup

**Date**: 2026-08-31
**Type**: Feature / Release
**Branch**: `develop`
**Scope**: 139 files changed, +28,768/-951 from the pre-implementation baseline through `v1.2.9`

---

## What Changed

### Private runtime and service lifecycle

- Added deterministic, bounded runtime bundles for `darwin-arm64`, `linux-arm64`, and `linux-x64`.
  Each bundle carries pinned Node, compiled Pimpampum, production dependencies, the native SQLite
  addon, a complete manifest/inventory, an SPDX SBOM, and an archive descriptor.
- Added safe archive extraction, target validation, hash/mode verification, versioned installation,
  stable launchers, receipts, health verification, atomic promotion, rollback, and garbage collection.
- Reworked macOS and Omarchy service management so `launchd` or `systemd --user` owns the daemon.
  Native surfaces install and control it but are not its process parent.
- Added verified migration from legacy npm-based services and transaction-safe update/removal paths
  that preserve databases, backups, synchronization snapshots, credentials, and unknown user state.

### Agent connectors and MCP

- Added a shared connector contract with Codex and Claude Code implementations, capability discovery,
  ownership receipts, conflict detection, atomic changes, disconnect, verification, and redaction.
- Hardened disconnect semantics after post-review: Codex verifies absence and restores owned state on
  failure, while the Omarchy lifecycle treats a still-present entry as a failed disconnect even when
  the host command exits zero.
- Added a bounded MCP verifier with timeouts, cancellation, malformed-output handling, and guaranteed
  child-process cleanup.
- Installed a stable `pimpampum-mcp` launcher that resolves the private receipt-selected Node and
  `mcpStdio` entrypoint. Host configuration contains no bearer token and does not depend on a global
  Node/npm installation.

### Durable setup and native surfaces

- Added a single-lock setup coordinator with a durable journal, resumable per-component progress,
  idempotent retries, stale repair, partial success, explicit conflict handling, and reverse-order
  compensation.
- Kept aggregate compensation failures durable in the setup journal so a failed rollback cannot be
  reported as a clean state and can be repaired deterministically.
- Added a quiet three-step macOS onboarding flow, bounded native progress stream, first-agent timing,
  completion/session-restart guidance, partial-failure repair, and a persistent Agents settings page.
- Added equivalent Omarchy bootstrap, service/connector helpers, bounded QML parsing, Agents settings,
  installation reconciliation, and removal rollback without external Node/npm.

### Release qualification

- Added generated acceptance suites for runtime, connectors, setup, lifecycle security, CLI, platform
  surfaces, and Swift onboarding; their source hashes remained frozen throughout implementation.
- Expanded fault-injection, hostile filesystem/configuration, race, secret-leak, archive traversal,
  packaged-update, and live lifecycle coverage.
- Added native target runtime jobs, nested macOS signing, notarization/stapling, exact-artifact smoke,
  npm provenance, GitHub assets, SBOMs, and SHA-256 release evidence.
- Added `scripts/check-reviewed-runtime-manifest.mjs` and the `runtime-manifest` quality job so exact
  native Linux archive hashes must match reviewed Omarchy pins before a tag is created.

### Documentation and delivery

- Updated the README, agent contract, MCP catalog, plugin README, website, and native help surfaces in
  English to explain that the app/plugin ships its own runtime and provides the stable MCP launcher.
- Released `v1.2.9` from merge `7bdf625`, published `pimpampum@1.2.9` as npm `latest`, and uploaded
  14 public GitHub assets including signed/notarized macOS, Linux runtimes, manifests, inventories,
  SBOMs, descriptors, and checksums.
- Fast-forwarded `r-bart/pimpampum-omarchy/main` to subtree commit `5f76ac1`; its checkout is
  byte-for-byte equal to the released monorepo plugin and passes the packaged delivery validator.

## Why

The previous desktop path still depended on a separately installed Node/npm toolchain and manual MCP
configuration. This feature makes the product own its complete runtime, daemon, MCP bridge, host
connections, migration, update, recovery, and removal lifecycle while retaining local-first storage
and explicit control over unknown host configuration.

## Decisions Made

| Decision                                        | Rationale                                                                          | Alternative Considered                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Versioned private Node runtime                  | Preserves native addon loading, target evidence, and one TypeScript implementation | SEA; rejected after spike complexity around `better-sqlite3` and signing |
| OS-managed daemon                               | Keeps MCP and automation alive when the native UI closes                           | App/widget child process                                                 |
| Receipt-selected stable launcher                | Gives hosts a durable command without leaking tokens or global runtime paths       | Direct Node path or bearer token in host config                          |
| Ownership-aware connectors                      | Supports safe idempotency, repair, and removal                                     | Blind config replacement                                                 |
| Durable setup journal plus compensation         | Makes interruption and partial failure recoverable                                 | One in-memory install script                                             |
| Native CI hashes are authoritative              | Matches the exact archives users download                                          | Cross-target macOS precomputation                                        |
| First verified agent owns the two-minute budget | Measures the promised usable outcome                                               | Timing the later exhaustive smoke                                        |

## What's Pending

- [x] Nothing — feature and delivery are complete.

## Quality Status

| Check                                | Status                                          |
| ------------------------------------ | ----------------------------------------------- |
| Typecheck / lint / format            | Passed                                          |
| TypeScript tests                     | 1,017 passed, 5 intentional todo, 100% coverage |
| Evals                                | 6 passed                                        |
| Swift/macOS                          | 172 passed, 100% enforced core coverage         |
| Omarchy                              | 36 passed; validator passed                     |
| Frozen desktop contracts             | 8 passed                                        |
| Production audit                     | 0 vulnerabilities                               |
| PR quality                           | 6/6 jobs passed                                 |
| `master` quality                     | 6/6 jobs passed                                 |
| Signed/notarized exact release smoke | Passed                                          |
| npm / GitHub / Omarchy publication   | Verified public and current                     |

## Release Evidence

- Plan: `thoughts/plans/2026-08-31_zero-friction-local-agent-setup.md`
- PR: <https://github.com/r-bart/pimpampum/pull/28>
- `master` quality: <https://github.com/r-bart/pimpampum/actions/runs/33422350260>
- Release: <https://github.com/r-bart/pimpampum/releases/tag/v1.2.9>
- Release run: <https://github.com/r-bart/pimpampum/actions/runs/33422952056>
- npm: <https://www.npmjs.com/package/pimpampum/v/1.2.9>
- Omarchy plugin: <https://github.com/r-bart/pimpampum-omarchy/commit/5f76ac1ade071e301e74757096340fc32051b376>
