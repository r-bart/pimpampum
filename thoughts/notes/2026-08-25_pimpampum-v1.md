# Pimpampum v1 — implementation and review notes

**Date**: 2026-08-25
**Plan**: `thoughts/plans/2026-08-25_pimpampum-v1.md`
**Verdict**: Ready as a local v0.1

## Delivered

- One loopback-only daemon and local SQLite source of truth.
- One-instance ownership lock, private ASCII bearer token and `synchronous=FULL` durability.
- Workspaces, Markdown PRDs, contextual Markdown, tasks and one-level subtasks.
- Versioned authenticated HTTP, Streamable HTTP MCP, stateless stdio MCP bridge and thin CLI.
- Atomic claims, renewals, releases, completions, revisions and activity events.
- Integrity-checked SQLite backup and portable JSON/Markdown export using partial-to-final publication.
- Globally ordered work discovery plus project listing in every lifecycle state.
- Lightweight agent manifests, deterministic pagination and bounded Markdown reads.

## Verification evidence

- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run format:check`: pass.
- `npm test`: 56/56 instrumented tests plus 6/6 compiled subprocess E2E scenarios.
- Coverage thresholds: 100% statements, branches, functions and lines across runtime modules.
- Compiled E2E: daemon, CLI, bearer HTTP, persistent SQLite, portable export and MCP stdio bridge.
- `npm audit --omit=dev`: no known production vulnerabilities.

## Corrections learned during review

- Completion must be a domain operation; writable state schemas must never accept `done` directly.
- Filesystem paths sent by a remote CLI process must be absolute, because relative paths resolve in the daemon.
- A mutation and its activity event belong in the same immediate transaction.
- Renewal and release must verify ownership, expiry and affected-row count under the write lock.
- Work discovery must merge projects and tasks by one global ordering to avoid starvation.
- A clean-checkout E2E must build ignored compiled output before starting subprocesses.
- Runtime scripts must target the daemon entrypoint after separating import-safe server composition.
- Agent list and work responses must never silently transport unbounded PRDs, task bodies or context.
- A retry of `work_start` by the same agent must be idempotent and must not renew the lease implicitly.
- Portable export is safe as a synchronous maintenance operation only when no active claims exist.

## Deliberate v0.1 boundaries

- One local bearer token; no users, roles or separate admin credential yet.
- Portable export requires an idle maintenance window; it rejects active claims and blocks the daemon while writing.
- No web UI, sprints, labels, priorities, comments or multi-machine concurrent database writes.
