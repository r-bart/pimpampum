# Agent workflow evals

Pimpampum keeps one small deterministic evaluation suite for the workflows that matter to agents.
It runs the compiled daemon, CLI, HTTP API, MCP HTTP transport, and MCP stdio bridge against real
temporary SQLite databases. The suite requires a full source checkout and is not part of the
published runtime tarball.

Run it with:

```bash
npm run test:evals
```

## Rubric

A release passes only when every workflow passes. There is no partial score and no retry that
quietly converts a first failure into a motivational anecdote.

| Evaluation         | Product behavior under evaluation                                                                    | Pass condition                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Hierarchy delivery | Workspace, scoped Context, Project, multiple Specs, Tasks, Subtasks, completion, and export          | Every compiled interface preserves ownership, revisions, and schema-v2 export  |
| Agent-first CLI    | Offline config, live discovery, JSON inputs, and every canonical MCP tool through the shell fallback | A shell-only agent uses the full 32-tool contract with stable envelopes        |
| MCP Markdown       | Spec, Task, and both Context scopes through the MCP bridge                                           | Exact bounded pages round-trip through the shared daemon                       |
| Competing agents   | Direct Spec work, Task leaves, Claim idempotency, expiry, renewal, release, and handoff              | Only eligible work is offered and concurrent ownership remains safe            |
| Lifecycle safety   | Project pause/reopen, terminal completion, cascade cancellation, and history                         | Invalid transitions fail; cancellation is atomic and releases Claims           |
| Contract safety    | Authentication, optimistic concurrency, payload bounds, canonical names, and no-delete boundary      | Unauthorized, stale, old-contract, and intentionally unsupported calls fail    |
| Process continuity | Daemon restart, v1 database migration, and single-instance ownership                                 | State survives upgrade/restart and a second daemon cannot own the same data    |
| Data recovery      | SQLite backup, restore, automatic snapshots, and portable export                                     | Restored state remains usable; backup failures never invalidate committed work |
| Local lifecycle    | Install, status, reconciliation, native integration, uninstall, and persistence                      | Per-user artifacts are exact; repeat install is idempotent; user data remains  |

The end-to-end scenarios include:

1. Register a Workspace and create same-named Workspace and Project Context documents.
2. Create one Project with multiple Specs.
3. Execute one Spec directly and another through Task and Subtask Claims.
4. Pause and reopen the Project while verifying work visibility.
5. Exercise competing Claims, idempotent restart, expiry, renewal, release, and handoff.
6. Cancel Task, Spec, and Project trees while verifying atomic history and Claim cleanup.
7. Complete the Project only after its Specs are terminal.
8. Restart the daemon and verify persistence.
9. Migrate a populated schema-v1 database and continue through the new HTTP, CLI, and MCP
   contracts.
10. Refresh automatic backup after each mutation, restore it, and export schema version 2.
11. Reject obsolete technical routes, tool names, Claim targets, and overview schemas.

## Evaluation boundaries

- Tests execute `dist/cli.js` and `dist/mcpStdio.js`, never TypeScript-only shortcuts.
- Network calls use an authenticated loopback daemon on an ephemeral port.
- MCP calls use the published live tool metadata and schemas.
- Persistent scenarios use real temporary files and SQLite databases.
- Portable export must declare `schemaVersion: 2` and reproduce
  `Workspace → Project → Spec → Task → Subtask` without Claims or bearer tokens.
- Every run starts from clean temporary state and removes it afterward.
- A PRD may appear only as example Spec content; it has no separate storage or API contract.

## Native status gates

The macOS menu-bar app and Omarchy Quattro widget consume the strict overview schema version 2.
Both must show Project grouping, current Spec/Task work, active Claim counts, terminal state, stale or
offline behavior, and filesystem opening without loading Markdown bodies.

The macOS build and Swift tests run locally with:

```bash
npm run build:macos
npm run test:macos
npm run test:e2e:macos
```

The Quattro live gate is opt-in and target-specific because it temporarily mutates the real
per-user shell and requires visual review:

```bash
npm run build
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
npm run test:e2e:omarchy
```

Schema-v2 evidence binds the exact candidate to lifecycle transcripts, baseline restoration, and
reviewed screenshots. The published package ships the non-mutating checker:

```bash
npm run check:quattro-evidence -- <evidence-path> <candidate-path>
```

These evals judge Pimpampum's coordination contract, not the literary merit of any model's plans.
Model-specific evals can be layered on later without weakening this deterministic release gate.
