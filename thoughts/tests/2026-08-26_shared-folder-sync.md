# Spec-test Manifest: Shared-folder synchronization

**Date**: 2026-08-26  
**Status**: Frozen before production implementation

## Core serialization

- Complete snapshots include all durable Workspaces, Projects, Specs, Context, Tasks, completions,
  artifacts, and activity in deterministic order.
- Claims, tokens, settings, locks, logs, and absolute Workspace roots are absent.
- Canonical payload hashes are stable; changed content changes the hash.
- Invalid schema, digest, device sequence, ownership, hierarchy, bounds, or unexpected fields fail
  before import.

## Publication and controller

- Configure accepts one existing writable absolute parent, creates/reuses its `Pimpampum` child,
  persists private settings atomically, reconciles, and publishes.
- Relative, missing, non-directory, and non-writable destinations fail without changing settings.
- Snapshot publication uses an exclusive unique partial and atomic rename in the device namespace.
- Startup imports before healthy status; mutation bursts coalesce; close drains pending publication.
- Unavailable storage preserves committed work, reports an actionable error, and retries.
- Pause stops polling/publication without forgetting configuration; resume reconciles.
- Duplicate and out-of-order snapshots are idempotent.

## Merge and database

- Two databases starting from one snapshot and modifying different Projects converge on both
  changes.
- Independent entity creation converges without collision.
- Identical concurrent state is not a conflict.
- Same-base divergent entity changes create one durable idempotent conflict and preserve both
  candidates.
- A conflict blocks writes to that entity but not unrelated entities.
- Explicit local/remote resolution converges on a third device, including deletion candidates.
- Import is all-or-nothing and invokes the post-commit scheduler once.
- Workspace identity synchronizes while each machine preserves its own root mapping.
- Imported unresolved Workspaces remain listable and become resolvable after local registration.
- Activity UUIDs prevent duplicate imported history.

## Interfaces

- HTTP status/configure/reconcile/pause/resume/forget/conflict/resolve routes require authentication and
  return typed envelopes.
- OpenAPI matches every route and strict response.
- CLI validates arguments and returns structured errors.
- MCP publishes the four approved tools with correct read/destructive/idempotent annotations,
  bounded inputs, and explicit agent guidance.
- MCP does not expose shared-folder configuration or conflict resolution.

## End to end

- Compiled daemon A configures a shared directory, registers a Workspace, creates Project/Spec/Task
  state, and publishes an immutable snapshot.
- Compiled daemon B with an independent data directory imports that state, maps its local Workspace
  root, and reads it through CLI and MCP.
- B changes an unrelated entity and A converges after `sync now` without losing either side.
- A and B edit the same base entity; both expose a conflict while unrelated work remains writable.
- Restarting either daemon replays no snapshot twice and preserves convergence/status.

## Quality gates

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run test:coverage` with 100% statements, branches, functions, and lines
- `npm test`
- compiled CLI/MCP E2E
- macOS static/unit/package checks where the host supports them
- Omarchy static/package checks
- no production TODO, FIXME, or HACK markers
