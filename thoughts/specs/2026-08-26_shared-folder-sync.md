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
The 2026-09-01 amendment below replaces this paragraph with an explicit retention rule.

## Non-goals

- Real-time cross-device Claims.
- A hosted Pimpampum service.
- Direct Google Drive/Dropbox/iCloud APIs.
- Provider upload-progress detection.
- General CRDT or field-level collaborative text editing.
- Automatic conflict winner selection.

## Amendments

### 2026-09-01 — Canonical form, blocked snapshots, retention (deep review H-04, M-S4–M-S7)

**Canonical form.** The canonical JSON and the entity order inside a state sort by UTF-16 code
units, never by the process locale. Snapshots carry `schemaVersion: 2`. A reader accepts version 1
when the recorded hash matches the code-unit order, which holds for every snapshot produced under
the C or English locales. A version 1 snapshot whose hash does not match, and any snapshot with a
version above 2, is reported as blocked and is never imported.

**Blocked snapshots.** A snapshot file that fails validation is reported in
`SyncStatus.blockedSnapshot` as `{ path, reason }`, where `path` is relative to the shared
`Pimpampum` directory. The status `error` names the same path. The device keeps importing every
other snapshot and keeps publishing its own state. Descendants of a blocked snapshot count as
blocked, not as pending, so one bad file never silences the device. `pendingSnapshotCount`
includes blocked files.

**Duplicate device IDs.** A file inside a device's own directory that the device did not write,
and that was not present when the device was configured, means another computer publishes under
the same device ID. The device reports the conflict in `error` and stops importing and publishing.
Recovery is `forget` followed by `configure` on each computer, giving one of them a distinct
device ID; the files already in the folder are imported as history. Two files with the same
`(deviceId, sequence)` from another device are siblings, imported in snapshot-ID order.

**Publish only after a commit.** The store counts committed writes. The poll imports on every
tick but exports only when the counter moved since the last publish. A manual reconcile follows
the same rule; a conflict resolution always publishes.

**Ledger compaction.** Each device keeps `appliedSnapshotIds` only for snapshots whose files are
still present in the shared folder plus the current heads. Compaction runs after an import cycle
that left nothing pending or blocked, so a pending child can never lose the record of its parent.
`deviceSequences` (newest applied sequence per device) and `deviceHeads` (newest applied snapshot
ID per device) remain unbounded only in the number of devices. `baseState` is no longer written;
the settings reader accepts it for one release and ignores it.

**Acknowledgements.** Every version 2 snapshot carries `appliedHeads`: a map from device ID to the
newest snapshot ID of that device the publisher had applied, including its own previous
snapshot. A device D therefore learns which of its snapshots device K has acknowledged by reading
`appliedHeads[D]` from K's newest snapshot and mapping that ID to a sequence through D's own
directory listing.

**Retention rule (design; deletion not yet implemented).** A device may delete its own snapshot
with sequence `s` when every other device directory present in the folder has published a
snapshot whose `appliedHeads[D]` maps to a sequence `>= s`, and `s` is not the newest own
snapshot. Deletion is blocked today by one dependency: importing a snapshot computes its merge
base from the states of its parents, read from their files. A deleted parent would leave every
later snapshot of that device unimportable for a device that joins afterwards. Before deletion
ships, the import path must either fall back to `base = empty` for a fresh device (local state
empty, so the merge reduces to "remote wins") or persist the base state per head locally. Until
then the folder grows by one full snapshot per committed change and the ledger stays bounded by
compaction.

**`cancelledAt`.** Projects, Specs and Tasks synchronize `cancelledAt` as an optional key that is
present only when the row is cancelled. Omitting the key when it is `null` keeps the canonical
form of an unchanged entity identical to what version 1 devices produced, so a mixed fleet does
not see spurious conflicts during the upgrade. The public HTTP and MCP types do not expose the
field yet; that exposure is a Phase 9 follow-up together with a nullable Workspace root.
