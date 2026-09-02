# Architecture

One daemon owns the SQLite database. HTTP, MCP, and CLI are adapters around the same domain store.
These are the rules the deep review of 2026-09-01 probed and found holding; keep them holding.

## Invariants

- Only `PimpampumStore` (`src/store.ts`) accesses SQLite. API, MCP, and CLI use the gateway
  contract; never expose direct database access to agents or clients.
- Completion is a domain operation, never a freely writable state. Never create a project in
  `done`; call the completion operation so summary, artifacts, timestamps, revisions, and claims
  stay consistent. Never add subtasks while their parent task is claimed.
- Adapters keep typed error codes (`src/errors.ts`). Never flatten them; never map a transport
  failure to `internal_error` (use `unavailable`).
- MCP list and work tools return manifests and bounded reads, never PRDs, task bodies, context
  bodies, or artifact arrays.
- Loopback binding and the single-instance lock live in runtime composition, not only in
  environment parsing.
- No version literal anywhere; import `PIMPAMPUM_VERSION` from `src/version.ts`.
- Markdown is opaque content, JSON is the wire contract, SQLite is the canonical store. The live
  database stays on a local filesystem; backups and portable exports may target synced folders.

## Layer map

| Layer                | Modules                                                                                                              | Calls                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Entrypoints          | `src/daemon.ts`, `src/cli.ts` (bootstrap only, loads `src/cliMain.ts` dynamically), `src/mcpStdio.ts`                | Composition                                 |
| Composition          | `src/server.ts` (import-safe), `src/cliMain.ts`, `src/lifecycleLock.ts`, `src/config.ts`                             | Adapters, service, setup, runtime           |
| Adapters             | `src/http.ts` + `src/openapi.ts` (generated from Zod), `src/mcp.ts`, `src/cliProgram.ts` + `src/cliCommands.ts`, `src/client.ts`, `src/agentClient.ts` | Domain through the gateway contract         |
| Domain               | `src/store.ts`, `src/domainRules.ts`, `src/schemas.ts`, `src/types.ts`, `src/migrations.ts`, `src/db.ts`             | SQLite                                      |
| Portfolio and sync   | `src/overview.ts`, `src/syncController.ts`, `src/syncState.ts`, `src/syncContract.ts`, `src/backup.ts`, `src/automaticBackup.ts` | Store, filesystem                           |
| Service lifecycle    | `src/service/*` (`manager`, `launchd`, `systemd`, `omarchy`, `macosApp`, `receipt`, `health`, `logs`)                 | OS service managers through `RunCommand`    |
| Setup                | `src/setup/*` (`coordinator`, `state`) — journal, plan, apply, resume, compensation                                    | Service, connectors, runtime                |
| Runtime              | `src/runtime/*` (`layout`, `manifest`, `archive`, `installer`, `launchers`, `bootstrap`), `src/update.ts`             | Filesystem, signed release channel          |
| Connectors           | `src/connectors/*` (`core`, `codex`, `claudeCode`, `registry`, `verifier`, `receipt`, `process`)                      | Agent host configuration                    |
| Native surfaces      | `platforms/macos/` (SwiftUI menu-bar app), `integrations/omarchy/pimpampum-status/` (Quickshell plugin and helpers)   | The packaged CLI by absolute path, HTTP     |

Import direction goes down the table. Known slips to remove, not to copy: `syncController.ts`
imports `assertNoSymlinkTraversal` from the installer layer; `service/manager.ts` imports `launchd`
and `systemd` directly while the selection lives in `cliMain.ts`.

## Native surfaces

- Portfolio content is read-only. Bounded writes are workspace registration, agent connection,
  update, synchronization, backup, and service lifecycle.
- No bearer token enters Swift, QML, settings, or process arguments. Native code calls the
  receipt-owned launcher (`bin/pimpampum-control`, `bin/pimpampum-mcp`) by absolute path.
- macOS copy decisions live in a covered presentation type, never in a SwiftUI body.
  `scripts/check-swift-coverage.sh` enforces 100% on its `covered_sources` manifest only.
- Nothing writes inside the app bundle after signing. Markers live under
  `~/Library/Application Support/Pimpampum/`.

## Quality gates

Run after every change:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

- `npm test` builds from a clean `dist/`, enforces 100% coverage on the measured files
  (`vitest.config.ts` excludes the entrypoints and `src/cliMain.ts`), and runs the compiled E2E.
- `npm run test:macos` and `npm run test:omarchy` cover the native surfaces.
- No `any` without an explicit reason.
