# Implementation Plan: Pimpampum v1

**Date**: 2026-08-25
**Status**: Complete — released as `v1.0.0`

## Overview

Build the first usable local Pimpampum daemon: SQLite-backed project coordination, a versioned HTTP API, an agent-native MCP endpoint, a thin CLI, backups and automated verification.

## Requirements

- [x] Run one local daemon for all registered workspaces.
- [x] Manage workspaces, PRDs, contextual documents, tasks and one-level subtasks.
- [x] Coordinate agents through expiring atomic claims.
- [x] Expose the same domain rules through HTTP and MCP.
- [x] Support consistent backups and portable exports.
- [x] Verify domain invariants through integration tests.

## Approach analysis

### Option A: Files and Markdown as canonical storage

Store JSON and Markdown under each managed workspace and let the daemon index them.

**Pros**: Human-readable storage; trivial manual export.
**Cons**: Distributed state, fragile locking, difficult queries and conflicts across agents.
**Complexity**: Medium.

### Option B: One local daemon with SQLite

Keep operational state and Markdown bodies in one local SQLite database. Expose JSON/Markdown through HTTP and MCP and export portable bundles on demand.

**Pros**: Atomic claims, deterministic queries, one source of truth, simple migrations and backup.
**Cons**: Requires the daemon for writes; exported files are not the live store.
**Complexity**: Low to medium.

### Recommendation

Use Option B. The product requirement is one machine-local instance shared by many agents, which is exactly SQLite's strongest deployment shape. A small modular backend avoids both file-lock orchestration and premature distributed infrastructure.

## Technical choices

- Node.js 22+ and TypeScript.
- Express for the HTTP daemon.
- `better-sqlite3` with WAL, foreign keys and explicit transactions.
- Zod for boundary validation.
- MCP TypeScript SDK v2 with Streamable HTTP.
- Vitest and Supertest for domain/API integration tests.
- Feature-oriented modules with a shared application service; no ORM or dependency injection framework.

## Files to create

| File                 | Purpose                                           |
| -------------------- | ------------------------------------------------- |
| `package.json`       | Scripts, binaries and dependencies                |
| `src/config.ts`      | Runtime paths, host, port and token configuration |
| `src/db.ts`          | SQLite connection, pragmas and migrations         |
| `src/errors.ts`      | Typed application errors                          |
| `src/schemas.ts`     | Shared Zod input schemas                          |
| `src/store.ts`       | Transactional domain operations and invariants    |
| `src/http.ts`        | HTTP API and error mapping                        |
| `src/mcp.ts`         | Agent-oriented MCP tools                          |
| `src/server.ts`      | Daemon composition and startup                    |
| `src/cli.ts`         | Thin HTTP CLI                                     |
| `src/backup.ts`      | Snapshot and portable export operations           |
| `test/store.test.ts` | Domain and concurrency tests                      |
| `test/http.test.ts`  | API integration tests                             |
| `README.md`          | Setup, API, MCP and workflow documentation        |

## Implementation phases

### Phase 1: Scaffold and persistence

#### Task 1.1: Bootstrap the backend

Create the TypeScript package, scripts, formatting rules and modular source layout.

#### Task 1.2: Create the SQLite schema

Add schema migrations for workspaces, projects, context documents, tasks, claims and activity events. Configure WAL, foreign keys and busy timeout.

### Phase 2: Domain service

#### Task 2.1: Workspace and project operations

Implement registration, path resolution, project CRUD, PRD revisions and state transitions.

#### Task 2.2: Context and task operations

Implement Markdown context documents, tasks, subtasks and hierarchy/completion invariants.

#### Task 2.3: Work claims

Implement atomic start, renewal, release and completion for projects and tasks. Expired claims are treated as available.

### Phase 3: Interfaces

#### Task 3.1: HTTP API

Expose versioned JSON routes, bearer authentication, typed errors, pagination and a health endpoint.

#### Task 3.2: MCP interface

Expose workflow-oriented tools: workspace resolution, work listing, work start/renew/release/complete, project operations, task operations and context operations.

#### Task 3.3: CLI

Provide health, workspace registration, work listing, show, claim, release and complete commands as a thin API client.

### Phase 4: Durability and verification

#### Task 4.1: Backup and export

Create consistent SQLite snapshots and JSON/Markdown portable exports without placing the live database in a synchronized directory.

#### Task 4.2: Tests and documentation

Cover hierarchy, revisions, claims, project completion, HTTP behavior and a complete agent workflow. Document local setup and MCP configuration.

#### Task 4.3: Total coverage and runnable E2E

Enforce 100% automated coverage for statements, branches, functions and lines. Exercise the complete daemon through its compiled CLI and HTTP API, including lifecycle, validation and failure paths.

## Task dependencies

```yaml
dependencies:
  1.1: []
  1.2: [1.1]
  2.1: [1.2]
  2.2: [2.1]
  2.3: [2.1, 2.2]
  3.1: [2.1, 2.2, 2.3]
  3.2: [2.1, 2.2, 2.3]
  3.3: [3.1]
  4.1: [1.2, 2.1, 2.2]
  4.2: [3.1, 3.2, 3.3, 4.1]
  4.3: [4.2]
```

## Risks

- MCP SDK v2 is new: isolate SDK-specific code in `src/mcp.ts` and test the handler directly.
- A crashed agent can strand work: every claim has an expiry and can be reclaimed afterward.
- Paths can escape authorized roots: resolve real paths and restrict workspace registration to administrative HTTP/CLI calls.
- Cloud folders can corrupt live databases: only completed snapshots and exports may target those folders.
- Large Markdown context can exhaust model windows: context listing returns metadata first and reads support bounded ranges.

## Testing strategy

- Unit/integration tests against a temporary SQLite database.
- API tests against the Express app without opening a network port.
- MCP smoke test against the handler factory.
- Manual end-to-end flow: register workspace, create PRD, create task/subtask, claim, complete and export.

## Done criteria

- [x] `npm run typecheck` succeeds with zero errors.
- [x] `npm test` succeeds with all domain and API tests.
- [x] `npm run build` emits runnable ESM output.
- [x] Health endpoint responds on loopback.
- [x] Two agents cannot claim the same work concurrently.
- [x] Subtasks cannot exceed one nesting level.
- [x] Projects and tasks cannot complete while children remain open.
- [x] HTTP and MCP call the same store operations.
- [x] Backup produces a valid SQLite snapshot.
- [x] Export produces JSON metadata and Markdown documents.
- [x] README documents daemon, API, CLI and MCP setup.
- [x] No TODO, FIXME or HACK markers remain in production code.
- [x] Coverage reports 100% statements, branches, functions and lines.
- [x] Compiled daemon, CLI and MCP stdio bridge pass a complete network E2E workflow.
