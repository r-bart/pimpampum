# Implementation Plan: Automatic Backup Settings

**Date**: 2026-08-26  
**Status**: complete  
**Specification**: [../specs/2026-08-26_automatic-backup-settings.md](../specs/2026-08-26_automatic-backup-settings.md)  
**Test contract**: [../tests/2026-08-26_automatic-backup-settings.md](../tests/2026-08-26_automatic-backup-settings.md)

## Outcome

Add one daemon-owned automatic backup destination, a serialized rolling SQLite snapshot after every committed mutation, agent-first API/CLI controls, and minimal settings surfaces in macOS and Omarchy Quattro.

## Architecture

Use a dedicated `AutomaticBackupController` composed beside `PimpampumStore`:

- The store remains the exclusive domain mutation boundary and invokes an injected post-commit callback.
- The controller owns private settings persistence, validation, dirty-generation coalescing, status, retry, and shutdown draining.
- The controller delegates SQLite copying to the existing backup module through a rolling-snapshot variant.
- HTTP and CLI depend on a narrow backup-settings contract.
- Swift and QML use the authenticated daemon contract; neither keeps its own configured path.

This avoids a schema migration for a machine-specific preference and keeps cloud filesystem I/O outside domain transactions.

## Phase 1 — Core backup engine and controller

### Task 1.1: Rolling snapshot primitive

**Files**: `src/backup.ts`, `test/core.test.ts` or focused new unit test  
**Depends on**: none

- Add integrity-checked `backupLatestDatabase` using sibling `.partial` plus atomic rename.
- Keep timestamped manual backup unchanged.
- Enforce owner-only permissions and deterministic filename.
- Cover replacement, cleanup, and failure branches.

### Task 1.2: Persistent controller

**Files**: `src/automaticBackup.ts`, focused controller tests  
**Depends on**: Task 1.1

- Atomically load/write private schema-v1 settings.
- Validate absolute existing writable directories.
- Implement status vocabulary, configure, retry, disable, dirty scheduling, coalescing, and close/drain.
- Sanitize reported failures.

### Task 1.3: Post-commit mutation hook

**Files**: `src/store.ts`, `test/store.test.ts`  
**Depends on**: Task 1.2

- Add optional mutation callback to the store constructor.
- Invoke it exactly once after each successful transaction.
- Refactor manual work transactions through the shared post-commit wrapper.
- Prove rejected mutations do not schedule backup.

## Phase 2 — Daemon, API, OpenAPI, and CLI

### Task 2.1: Runtime composition and shutdown

**Files**: `src/server.ts`, `test/server.test.ts`  
**Depends on**: Phase 1

- Construct controller from the private data-directory settings path.
- Schedule startup refresh when configured.
- Drain it before closing SQLite.
- Preserve lock cleanup across startup/shutdown failures.

### Task 2.2: Authenticated API and typed client

**Files**: `src/http.ts`, `src/client.ts`, `src/types.ts`, `src/schemas.ts`, `test/http.test.ts`, client tests  
**Depends on**: Task 2.1

- Add GET/PUT/POST retry/DELETE settings routes.
- Add typed client methods and response validation.
- Cover authentication, validation, idempotency, and error envelopes.

### Task 2.3: OpenAPI

**Files**: `src/openapi.ts`, `test/openapi.test.ts`  
**Depends on**: Task 2.2

- Document schemas, security, examples, operations, and error responses.
- Keep the generated contract valid OpenAPI 3.1.

### Task 2.4: Agent-first CLI

**Files**: `src/cliProgram.ts`, `test/cli-program.test.ts`, `test/e2e.test.ts`, `README.md`  
**Depends on**: Task 2.2

- Add `backup status|configure|retry|disable` while retaining `backup <directory>` compatibility.
- Resolve configuration input to an absolute path and emit JSON only.
- Add real daemon usage workflow tests.

## Phase 3 — macOS settings

### Task 3.1: Client and state model

**Files**: new `BackupSettingsModels.swift`, `BackupSettingsClient.swift`, `BackupSettingsStore.swift`; XCTest files  
**Depends on**: Task 2.2

- Reuse receipt/token configuration without exposing credentials.
- Decode strict schema, model asynchronous states, and surface sanitized errors.

### Task 3.2: Native picker and settings view

**Files**: `App.swift`, `StatusPopover.swift`, new `BackupDirectoryPicker.swift`, `BackupSettingsView.swift`; XCTest files  
**Depends on**: Task 3.1

- Add SwiftUI Settings scene and SettingsLink.
- Add directory-only NSOpenPanel adapter and Finder opening.
- Implement disabled/pending/healthy/error UI with change, retry, and disable.
- Maintain macOS core 100% coverage.

## Phase 4 — Omarchy Quattro settings

### Task 4.1: Safe installed helper

**Files**: `src/service/omarchy.ts`, plugin helper, service tests  
**Depends on**: Task 2.4

- Install a receipt-owned helper that delegates status/configure/retry/disable.
- Pass user paths as separate process arguments.
- Emit JSON and never expose the token to QML.

### Task 4.2: Backup section

**Files**: `BackupService.qml`, `StatusPopout.qml`, plugin README, validator and tests  
**Depends on**: Task 4.1

- Add the compact Backup disclosure.
- Use Qt FolderDialog and a manual absolute-path fallback.
- Add safe `xdg-open` behavior and status/error states.
- Preserve all existing widget status semantics and user layout.

## Phase 5 — Documentation and release gates

### Task 5.1: Documentation

**Files**: `README.md`, integration README, OpenAPI evidence  
**Depends on**: Phases 2–4

- Explain the live-local/synchronized-backup distinction.
- Document macOS, Quattro, agent CLI, API, recovery, and disable UX.

### Task 5.2: Full verification

**Depends on**: all implementation tasks

- Run formatting, lint, typecheck, TypeScript coverage, E2E, evals, Swift tests/coverage, QML validation, package verification, and production audit.
- Run strict post-review against the PRD and fix every finding.
- Record Quattro live validation as pending only if no target machine is reachable; do not fabricate evidence.

## Quality Gates

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:evals
npm run test:macos
npm run test:omarchy
npm pack --dry-run
npm audit --omit=dev
```

All acceptance tests must pass, TypeScript and Swift enforced coverage must remain 100%, and no secret or user-controlled path may be interpolated into a shell command.
