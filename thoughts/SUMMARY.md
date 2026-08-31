# Session Summary

**Date**: 2026-08-31 20:15 CEST
**Feature**: Zero-friction local agent setup
**Type**: Feature / Release
**Branch**: `develop`

## What Was Done

- Shipped self-contained private runtimes for macOS arm64 and Omarchy Linux arm64/x64, including
  pinned Node, Pimpampum, `better-sqlite3`, inventories, SBOMs, and deterministic archives.
- Added durable, rollback-safe setup, migration, update, removal, service, receipt, and launcher
  flows. The daemon remains OS-managed and independent of the macOS app or Quickshell lifecycle.
- Connected Codex and Claude Code through ownership-aware connectors and a receipt-selected stable
  `pimpampum-mcp` launcher without exposing the bearer token to host configuration.
- Added quiet native macOS onboarding, resumable progress, partial-failure recovery, and ongoing
  Agents settings. Added equivalent bounded Omarchy setup and agent-management surfaces.
- Preserved legacy npm installations through verified native promotion and left unknown host
  configuration untouched unless the user explicitly chooses replacement.
- Added extensive acceptance, hostile-state, rollback, filesystem-fault, concurrency, secret-leak,
  packaging, and platform coverage while keeping the generated spec tests frozen at their original
  hashes.
- Added a pre-tag CI gate that compares the reviewed Omarchy runtime manifest with the exact native
  Linux archives produced by the runners.
- Closed the post-review disconnect and compensation gaps: Codex and Omarchy now verify the
  disconnected postcondition, Codex restores owned state on failure, and setup persists aggregate
  rollback failures for repair.
- Published signed and notarized `v1.2.9` to GitHub and npm with provenance, then synchronized
  `r-bart/pimpampum-omarchy` to the exact released plugin subtree.

## Why

Installing the desktop app or Omarchy plugin now provides the daemon and MCP bridge itself. A user
does not need to install Node/npm, open Terminal, paste tokens, or hand-edit Codex or Claude Code
configuration during the normal path. The complete implementation follows
[`thoughts/plans/2026-08-31_zero-friction-local-agent-setup.md`](plans/2026-08-31_zero-friction-local-agent-setup.md).

## Key Decisions

- Ship a signed/versioned private Node runtime instead of a SEA: it preserves native-addon behavior,
  makes inventories explicit, and supports the same TypeScript implementation on all targets.
- Keep the daemon under `launchd`/`systemd --user`; closing the app or restarting Quickshell must not
  interrupt agents, MCP, backup, or synchronization.
- Give hosts only a stable launcher. The launcher resolves the receipt-selected private Node and
  stdio bridge, while the local token remains inside the receipt-owned runtime boundary.
- Treat connectors as ownership-aware adapters and stop on unknown collisions rather than rewriting
  user configuration optimistically.
- Measure the under-two-minute promise at the first verified agent; the exhaustive lifecycle smoke
  continues separately and may take longer.
- Compare exact native Linux artifacts before tagging. Cross-target bundles built on macOS are useful
  locally but are not authoritative release hashes.

## What's Pending

Nothing — the feature, release, public assets, npm package, and Omarchy subtree are complete.

## Files Modified

| Area                                     | Change                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/runtime/`                           | Added private runtime archive, manifest, installer, bootstrap, and layout contracts            |
| `src/connectors/`                        | Added Codex and Claude Code discovery, mutation, verification, ownership, and redaction        |
| `src/setup/`                             | Added durable setup state and rollback-safe coordinator                                        |
| `src/service/`                           | Added native packaged-service receipts, launchers, health, migration, and platform adapters    |
| `platforms/macos/`                       | Added embedded runtime bootstrap, guided setup, Agents settings, tests, and approved artifact  |
| `integrations/omarchy/pimpampum-status/` | Added verified bootstrap, lifecycle helpers, Agents UI, and exact runtime pins                 |
| `.github/workflows/` and `scripts/`      | Added reproducible build, signing, notarization, live-smoke, release, and exact-manifest gates |
| `test/`                                  | Added generated acceptance tests and adversarial coverage for every new boundary               |
| `README.md`, `docs/`, and `site/`        | Documented the app-bundled runtime, stable MCP launcher, Omarchy parity, and recovery paths    |

## Quality Status

- TypeScript: 1,017 passing, 5 intentional todo, 100% statements/branches/functions/lines.
- Evals: 6 passing.
- Swift: 172 passing across 24 suites, 100% enforced core regions/functions/lines.
- Omarchy: 36 passing; 8 frozen desktop contracts passing.
- Production audit: 0 vulnerabilities.
- PR and `master` quality: all six jobs green, including native runtime hashes and full macOS lifecycle.
- Release: signed, notarized, stapled, exact-artifact smoke green; npm provenance and GitHub Release
  published successfully.

## Next Steps

1. Use the published `v1.2.9` app or Omarchy plugin as the supported zero-friction installation.
2. Treat any future runtime-pin drift as a pre-tag failure through the `runtime-manifest` quality job.
