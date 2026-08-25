# Pimpampum v1 — Definition of Done

**Date**: 2026-08-25  
**Status**: Implemented and automated

## Product contract

- One loopback-only daemon owns one local SQLite data directory.
- Workspaces resolve external repository paths to one shared instance.
- Projects contain a Markdown PRD, contextual Markdown documents, tasks and one level of subtasks.
- Projects use `draft → ready → done`; tasks use `open → done`.
- Agents discover work, atomically claim it, renew or release it, and complete it with optimistic revisions.
- HTTP and MCP expose the same domain invariants; the stdio bridge holds no state.
- Agent listings and work bundles use manifests. Large Markdown is read through bounded pages.
- SQLite backup is integrity checked; portable export is JSON/Markdown and requires no active claims.

## Automated acceptance

- `npm run typecheck` succeeds.
- `npm run lint` succeeds with warnings denied.
- `npm run format:check` succeeds.
- `npm run test:coverage` reports 100% statements, branches, functions and lines for runtime code.
- `npm run test:e2e` builds and exercises six compiled product scenarios across daemon, CLI, authenticated HTTP and MCP stdio, including restart and backup restore.
- `npm audit --omit=dev` reports no production vulnerabilities.
- `npm pack --dry-run` contains compiled binaries, README and MIT license.

## Explicit exclusions

- No web UI, sprints, estimates, labels, priorities, comments or configurable workflows.
- No users or roles; one private machine-local bearer token is the trust boundary.
- No live SQLite database inside Dropbox, Drive or iCloud; only completed backups and exports may be synchronized.
