# Product Specification: Shared-folder synchronization

**Date**: 2026-08-26  
**Status**: Approved by the user's request to execute the implementation plan

## Problem

One person uses Pimpampum from multiple computers. Each computer must remain useful offline and
must keep its live SQLite database on local storage, while durable project-management state moves
through a user-selected folder synchronized by an external provider.

## Product contract

- Synchronization is optional and unconfigured by default.
- The user selects a shared parent directory and a stable device name once per computer.
- Pimpampum creates a `Pimpampum` child and thereafter imports on startup/poll/manual sync and
  exports automatically after every committed domain mutation.
- The complete durable portfolio is represented in every immutable device snapshot.
- Devices never overwrite another device's files.
- Delivery may be delayed, duplicated, or reordered without changing the result.
- Non-overlapping changes merge automatically. Same-base divergent changes become conflicts.
- A conflict never silently chooses a winner and blocks only the affected entity/dependent work.
- SQLite, tokens, locks, service settings, Claims, and machine paths never synchronize.
- A Workspace imported without a local root remains visible but cannot resolve a working directory
  until the user registers its local root.
- Missing shared storage degrades status but never rolls back or blocks local commits.
- Snapshot parse/hash/schema/ownership validation completes before a database transaction begins.

## UX

Settings begins with one primary action, **Choose shared folder…**. Selecting a valid parent enables
automatic synchronization. There is no separate automatic-mode toggle. The top-level
**Synchronization** toggle pauses/resumes an existing configuration without deleting it.

Required states are: not configured, up to date, importing, exporting, pending, folder unavailable,
invalid shared state, conflict requires attention, and paused. Errors explain that local changes are
safe and provide **Try again** or **Choose another folder…** as appropriate.

## Agent behavior

MCP exposes `sync_status`, `sync_now`, `sync_conflict_list`, and bounded
`sync_conflict_read`. Agents call status during session orientation, but ordinary successful domain
writes already schedule export. Agents never manipulate snapshot files, configure paths, pause
sync, or resolve conflicts without explicit user authority.

## Conflict policy

The initial release discovers and preserves conflicts and exposes explicit user/admin resolution
through the authenticated HTTP API and CLI. The resolution travels as causal snapshot metadata and
converges on every device. MCP remains read-only for conflict candidates and never chooses a winner
autonomously. A user can continue unrelated work while a conflict is unresolved.

## Retention

The initial release retains immutable snapshots. Automated compaction is deferred until measured
storage warrants it. Complete snapshots are expected to remain small for a personal portfolio.

## Non-goals

- Real-time cross-device Claims.
- A hosted Pimpampum service.
- Direct Google Drive/Dropbox/iCloud APIs.
- Provider upload-progress detection.
- General CRDT or field-level collaborative text editing.
- Automatic conflict winner selection.
