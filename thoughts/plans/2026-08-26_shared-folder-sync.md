# Implementation Plan: Shared-folder synchronization

**Date**: 2026-08-26  
**Status**: Complete — released as `v1.0.0`  
**Scope**: Local-first synchronization of the complete Pimpampum portfolio between a user's
computers through an existing synchronized folder.

## Implemented simplifications

- Machine-local configuration and the applied-snapshot ledger share one atomically replaced
  `sync.json`; splitting two files added failure modes without adding a trust boundary.
- Activity uses a deterministic SHA-256 fingerprint of its immutable payload as transport identity,
  avoiding a database migration while remaining globally idempotent.
- Administration follows the existing settings family at `/api/v1/settings/sync` rather than adding
  a parallel `/admin` convention.
- The shared manifest is unnecessary in schema v1 because every strict snapshot envelope is
  self-describing; correctness depends only on immutable device files.

## Outcome

Let one person use independent local Pimpampum installations on macOS and Linux while keeping all
Workspace, Project, Spec, Task, Context, completion, artifact, and activity state convergent through
a folder already synchronized by Google Drive, Dropbox, iCloud Drive, Syncthing, rclone, or an
equivalent provider.

The live SQLite database remains local. Pimpampum never embeds a cloud-provider SDK and never opens
a live SQLite database from a synchronized folder. Once a user chooses a shared folder,
synchronization is automatic after every committed mutation and on daemon startup. Agents observe
sync health through MCP but never manipulate snapshot files directly.

## Requirements

- [x] Synchronization is unconfigured and disabled by default.
- [x] The user explicitly chooses one existing writable shared folder and names the current device.
- [x] Enabling synchronization automatically imports pending snapshots and publishes local state.
- [x] Every committed domain mutation schedules an export without delaying or rolling back the
      mutation.
- [x] All durable portfolio state is synchronized; local paths, settings, tokens, locks, and live
      Claims remain machine-local.
- [x] Each device writes only immutable files inside its own namespace.
- [x] Duplicate, delayed, and out-of-order snapshots are idempotent.
- [x] Changes to different entities merge automatically by stable ID and revision ancestry.
- [x] Concurrent changes derived from the same entity revision become explicit conflicts; no
      timestamp-based winner is selected.
- [x] A conflict blocks writes only to the affected entity or dependent transition, not the whole
      portfolio.
- [x] Workspace IDs synchronize, while each machine keeps its own absolute root-path mapping.
- [x] Missing or temporarily unavailable shared storage never blocks local work.
- [x] Invalid or partial snapshots are quarantined or reported and never partially imported.
- [x] Settings expose configure, pause/resume, sync-now, health, last import/export, pending work,
      and conflicts without exposing internal generations as primary UI.
- [x] MCP exposes sync status, manual reconciliation, and conflict discovery with actionable tool
      descriptions.
- [x] Agents check sync status at session start, do not edit transport files, and do not change
      synchronization settings without an explicit user request.
- [x] Existing manual SQLite backup and portable export remain recovery/inspection features rather
      than synchronization transports.

## Approach analysis

### Option A: One mutable `state.json`

Each installation imports one complete JSON document and overwrites it after local mutations.

**Pros**: Smallest file layout and simplest happy-path implementation.

**Cons**: Two devices can derive different successors from the same state. Cloud providers use
last-writer-wins or conflict copies and cannot merge Pimpampum entities. Even changes to unrelated
Projects can be lost.

**Complexity**: Low implementation, unacceptable data-loss risk.

### Option B: Immutable snapshots per device with deterministic reconciliation

Each device publishes immutable, uniquely named state snapshots under its own device namespace.
Every installation records which snapshots it has applied and reconciles entity changes using
stable IDs, revisions, and explicit base versions.

**Pros**: Writers never overwrite each other; delayed and duplicate delivery is safe; unrelated
changes merge; transport remains a plain folder; snapshots double as recovery history.

**Cons**: Requires an import ledger, deterministic merge rules, conflict representation, and later
retention/compaction.

**Complexity**: Medium initial, low operational complexity.

### Option C: One remotely hosted daemon

All clients connect to a single network-accessible Pimpampum instance.

**Pros**: Strongest real-time claims and concurrency; no offline merge.

**Cons**: Requires an always-on host, networking, availability, secrets, and remote-path handling.
It does not match the requested choose-a-folder experience.

**Complexity**: Medium infrastructure and user-operation complexity.

### Recommendation

Use **Option B**. It is the smallest design that supports the stated multi-machine behavior without
silently losing unrelated work. Option A may be offered only as an explicitly single-active-device
mode in the future; it must not be the default synchronization contract.

## Architecture

### Local and shared state

```text
Machine A                                      Machine B
~/.pimpampum/pimpampum.sqlite                  ~/.pimpampum/pimpampum.sqlite
~/.pimpampum/sync.json                         ~/.pimpampum/sync.json
~/.pimpampum/sync-ledger.json                  ~/.pimpampum/sync-ledger.json
                ↘                              ↙
                 synchronized/Pimpampum/
                   manifest.json
                   devices/
                     macbook/
                       <sequence>-<uuid>.json
                     linux-framework/
                       <sequence>-<uuid>.json
```

`sync.json` contains the machine-local shared-directory path, device ID, and paused state with mode
`0600`. `sync-ledger.json` records applied immutable snapshot IDs and local ancestry. Neither file is
itself synchronized.

The shared `manifest.json` declares only the transport schema and product identity. Correctness must
not depend on multiple writers safely replacing this manifest after initial creation.

### Snapshot envelope

```json
{
  "schemaVersion": 1,
  "snapshotId": "uuid",
  "deviceId": "linux-framework",
  "sequence": 42,
  "createdAt": "2026-08-26T18:30:00.000Z",
  "parentSnapshots": ["uuid"],
  "stateHash": "sha256:...",
  "state": {
    "workspaces": [],
    "projects": [],
    "specs": [],
    "contexts": [],
    "tasks": [],
    "activity": []
  }
}
```

Snapshots contain the complete durable portfolio in v1 because expected portfolio size is small and
complete documents maximize inspectability, recovery, and test simplicity. The importer still
computes an entity-level delta against known ancestry before mutating SQLite. Incremental snapshot
payloads are deferred until measurements justify them.

### Excluded state

- Workspace `rootPath`: replace with a synchronized logical Workspace ID and machine-local path map.
- Claims: leases are meaningful only to one live daemon and may arrive after expiry.
- Bearer token, service receipt, instance lock, logs, UI settings, and sync credentials.
- Derived overview state.

Activity events need globally stable UUIDs before synchronization. Add a migration from integer-only
transport identity while retaining local ordering separately.

### Mutation scheduling

Keep `PimpampumStore` as the only database writer. Replace its single post-commit callback with one
composed callback or a small post-commit coordinator:

```text
successful transaction
  → automatic SQLite backup markDirty()
  → shared-folder sync markDirty()
```

Both controllers coalesce generations and drain during graceful shutdown. Filesystem/cloud latency
never occurs inside the SQLite transaction. A failed export is visible in status and retried, but
does not invalidate committed local state.

### Import and merge

1. Discover immutable `*.json` snapshots not present in the local ledger.
2. Read with strict byte limits, parse with Zod, verify hash, IDs, ownership, revisions, and domain
   structure before opening a transaction.
3. Order snapshots by ancestry; device sequence and timestamp are diagnostics, never conflict
   winners.
4. Compute a three-way entity delta from the last common known snapshot.
5. Apply non-overlapping changes through a dedicated transactional import operation in
   `PimpampumStore`; adapters must not execute SQL.
6. Record applied snapshot IDs only after commit.
7. Represent same-base divergent edits as durable sync conflicts and preserve both candidates.
8. Trigger a local export after imports settle so each device eventually publishes a converged
   complete view.

No import may synthesize ordinary user activity events for every replicated row. Record one bounded
`sync.imported` event per imported batch, while preserving original activity UUIDs.

### Polling

- Reconcile synchronously during daemon startup before reporting sync `healthy`.
- Poll the configured folder at a conservative interval while running; do not depend solely on
  filesystem watchers because cloud mounts and network filesystems have inconsistent notification
  behavior.
- `sync now` performs an immediate reconcile/export cycle.
- Polling interval is an internal constant in v1, not a user setting.

## Settings UX

Synchronization is unconfigured by default. The primary action is **Choose shared folder…**. The
user chooses a parent directory and Pimpampum creates or reuses its `Pimpampum` child after explicit
confirmation.

After configuration, automatic synchronization is intrinsic and does not get a second "Automatic"
toggle. The top-level **Synchronization** toggle pauses/resumes processing without deleting files or
forgetting the path. **Forget shared folder…** is a separate secondary/destructive action.

Required states:

```text
Not configured
Up to date
Importing…
Exporting…
Changes pending
Shared folder unavailable
Invalid shared state
Conflict requires attention
Paused
```

The UI communicates that local changes remain safe while storage is unavailable. Folder validation
errors appear adjacent to the folder control. Buttons use explicit outcomes: **Choose shared
folder…**, **Sync now**, **Pause syncing**, **Resume syncing**, and **Forget shared folder…**.

## MCP and agent contract

Add these canonical tools:

```text
sync_status          read-only; first sync tool an agent should call
sync_now             reconcile pending snapshots and publish current state
sync_conflict_list   bounded conflict manifests without full Markdown candidates
sync_conflict_read   bounded candidate metadata/body pages when explicitly needed
```

Conflict resolution is deliberately deferred from the initial MCP surface unless the product spec
defines safe per-field/user-confirmed semantics. Agents must not choose a winner autonomously.

Tool descriptions and `docs/mcp-tools.md` must state:

- Agents call `sync_status` at session start before resolving work.
- `healthy`, `pending`, or temporarily `unavailable` does not invalidate local committed work.
- A conflict blocks only work involving the affected entity or dependent parent transition.
- Agents never read, edit, rename, or delete transport snapshots directly.
- Agents never configure, pause, resume, forget, or change the shared folder unless the user
  explicitly requests that administrative action.
- Normal domain tools schedule export automatically; agents never call `sync_now` after every write.

Do not add a general-purpose MCP `sync_configure` tool in v1. Configuration remains CLI/native UI
administration because arbitrary agent-selected filesystem destinations enlarge authority and create
poor consent semantics.

## Public contracts

### CLI

```text
pimpampum sync status [--json]
pimpampum sync configure <absolute-parent-directory> --device <device-id> [--json]
pimpampum sync now [--json]
pimpampum sync pause [--json]
pimpampum sync resume [--json]
pimpampum sync conflicts [--json]
pimpampum sync forget [--json]
```

### HTTP

Authenticated administration/status routes:

```text
GET    /api/v1/admin/sync
PUT    /api/v1/admin/sync
POST   /api/v1/admin/sync/reconcile
POST   /api/v1/admin/sync/pause
POST   /api/v1/admin/sync/resume
DELETE /api/v1/admin/sync
GET    /api/v1/admin/sync/conflicts
```

Read/reconcile methods needed by MCP belong on the shared gateway contract rather than reaching into
the controller from `src/mcp.ts`.

### Status shape

Expose stable machine-readable fields including:

```text
enabled, paused, state, directory, deviceId,
lastAttemptAt, lastImportAt, lastExportAt,
pendingSnapshotCount, conflictCount, error
```

Paths are appropriate in local administrative responses but must not appear in overview or normal
agent work-list payloads.

## Files to create or modify

| File                             | Action | Purpose                                                                   |
| -------------------------------- | ------ | ------------------------------------------------------------------------- |
| `src/syncContract.ts`            | Create | Status, snapshot, conflict schemas, bounds, and gateway contract          |
| `src/syncController.ts`          | Create | Settings, polling, dirty coalescing, ledger, import/export orchestration  |
| `src/syncState.ts`               | Create | Deterministic complete-state serialization, hashing, and merge planning   |
| `src/migrations.ts`              | Modify | Activity UUID and durable conflict/import metadata schema                 |
| `src/store.ts`                   | Modify | Transactional export source, validated merge application, conflict guards |
| `src/server.ts`                  | Modify | Compose, start, poll, drain, and close sync controller                    |
| `src/types.ts`                   | Modify | Gateway sync operations and synchronized path-neutral shapes              |
| `src/schemas.ts`                 | Modify | Device ID and sync administration validation                              |
| `src/http.ts`                    | Modify | Authenticated sync routes                                                 |
| `src/client.ts`                  | Modify | Typed sync client methods                                                 |
| `src/openapi.ts`                 | Modify | Sync schemas and administration paths                                     |
| `src/cliProgram.ts`              | Modify | Sync command parser and output                                            |
| `src/cli.ts`                     | Modify | Resolve local folder paths and compose commands                           |
| `src/mcp.ts`                     | Modify | Status/reconcile/conflict discovery tools and descriptions                |
| `docs/mcp-tools.md`              | Modify | Agent startup and conflict behavior                                       |
| `README.md`                      | Modify | Setup, provider-neutral sync, safety, recovery, and limitations           |
| `platforms/macos/...Settings...` | Modify | Shared-folder configuration and status surface                            |
| `integrations/omarchy/...`       | Modify | Equivalent Quattro settings/status controls                               |
| `test/sync-*.test.ts`            | Create | Pure, controller, persistence, acceptance, and adversarial tests          |
| `test/mcp.test.ts`               | Modify | MCP catalog, annotations, descriptions, and behavior                      |
| `test/e2e.test.ts`               | Modify | Two-daemon/two-folder compiled convergence workflow                       |

Exact native files must be resolved during the implementation preflight; do not create a second
settings window or duplicate platform status rules.

## Implementation phases

### Phase 0: Specification and immutable test contract

#### Task 0.1: Write the product specification

Define the single-user multi-device contract, excluded state, merge/conflict semantics, offline
behavior, retention boundary, UX copy, and MCP responsibilities. Resolve whether v1 exposes conflict
resolution or only discovery before production code.

#### Task 0.2: Create the spec-test manifest

Write `thoughts/tests/2026-08-26_shared-folder-sync.md` with immutable acceptance cases and expected
public contract. Add failing acceptance tests without weakening existing assertions.

### Phase 1: Portable state and merge model

#### Task 1.1: Define strict snapshot contracts

Create bounded schemas, canonical ordering, stable serialization, hashing, device/sequence validation,
and path/secret/Claim exclusions.

#### Task 1.2: Add globally stable activity identity and conflict persistence

Migrate existing databases transactionally, backfill deterministic activity UUIDs, and add the
minimum ledger/conflict state required for idempotent import.

#### Task 1.3: Implement deterministic merge planning

Produce pure merge plans for unchanged, local-only, remote-only, identical, and divergent entities.
Reject invalid ancestry and ownership before mutation. Do not use wall-clock time to select winners.

### Phase 2: Transactional import/export

#### Task 2.1: Export complete path-neutral state

Read one consistent portfolio snapshot from the Store, exclude machine-local fields, and serialize in
deterministic bounded order.

#### Task 2.2: Apply imports atomically

Validate the complete merge plan, apply all accepted entities and import metadata in one immediate
transaction, persist conflicts without overwriting either candidate, and invoke post-commit hooks
exactly once.

#### Task 2.3: Build the sync controller

Implement private settings and ledger files, immutable exclusive snapshot publication, discovery,
startup reconciliation, polling, coalesced post-mutation export, retry, and graceful drain.

### Phase 3: Interfaces and agent behavior

#### Task 3.1: Compose daemon lifecycle and HTTP contract

Wire the controller beside automatic backup, preserve startup/close compensation, and expose typed
authenticated status/configuration/reconcile routes.

#### Task 3.2: Add CLI administration

Implement configure/status/now/pause/resume/conflicts/forget with strict arguments and actionable
errors. Configuration validates the chosen parent before creating Pimpampum-owned children.

#### Task 3.3: Add MCP observability

Register status, reconcile, and conflict discovery/read tools. Ensure annotations, descriptions,
bounds, and error guidance teach agents the workflow without granting implicit configuration or
conflict-resolution authority.

### Phase 4: Native settings UX

#### Task 4.1: macOS settings

Replace backup-centric setup with the approved synchronization section while preserving advanced
manual backup/recovery access. Implement every status, accessible labels, loading/disabled states,
and explicit pause/forget semantics.

#### Task 4.2: Omarchy Quattro settings

Expose the same daemon-owned contract and user-facing vocabulary using existing theme primitives and
safe folder-selection/manual-path behavior.

### Phase 5: Verification and documentation

#### Task 5.1: Adversarial synchronization tests

Exercise two independent data directories and two simulated device namespaces: unrelated changes,
same-base conflicts, duplicate delivery, reordering, corrupted/truncated/oversized snapshots,
unavailable folders, crash leftovers, retry, restart, and shutdown drain.

#### Task 5.2: Interface and compiled E2E

Verify HTTP, CLI, MCP, OpenAPI, native static/live contracts, packaging, and a compiled Mac/Linux
round trip. Preserve 100% TypeScript coverage.

#### Task 5.3: Documentation and project notes

Document provider-neutral setup, Google Drive's lack of an official Linux client, rclone as one
possible folder provider, offline/conflict behavior, MCP agent rules, and recovery. Update project
summary, notes, and post-change summary.

## Task dependencies

```yaml
dependencies:
  0.1: []
  0.2: [0.1]
  1.1: [0.2]
  1.2: [0.2]
  1.3: [1.1, 1.2]
  2.1: [1.1, 1.2]
  2.2: [1.3, 2.1]
  2.3: [2.1, 2.2]
  3.1: [2.3]
  3.2: [3.1]
  3.3: [3.1]
  4.1: [3.1, 3.2]
  4.2: [3.1, 3.2]
  5.1: [2.3, 3.1]
  5.2: [3.2, 3.3, 4.1, 4.2, 5.1]
  5.3: [5.2]
```

## Risk analysis

- **False simplicity**: one mutable JSON loses unrelated concurrent work. Immutable device-owned
  snapshots are mandatory.
- **No common ancestor**: reject automatic entity resolution and persist a conflict rather than use
  timestamps.
- **Cloud delivery is eventually consistent**: polling and immutable IDs make delays/reordering safe;
  Claims remain local and do not promise cross-device mutual exclusion.
- **Path portability**: never import a remote absolute root path; require or infer a local mapping.
- **Snapshot growth**: retain all snapshots in v1, measure real usage, and design compaction as a
  later backward-compatible feature.
- **Import feedback loop**: coalesce imports and emit at most one converged snapshot after a batch.
- **Corrupt or hostile files**: strict size/schema/hash/ownership bounds precede transactions; never
  follow symlinks or accept paths from snapshot payloads.
- **Activity duplication**: stable UUID plus import ledger ensures idempotency.
- **UI overreach**: native clients remain thin; merge and conflict rules live in Store/controller.
- **MCP authority**: tools expose status and user-triggered reconciliation but not arbitrary path
  selection or autonomous conflict winners.

## Testing strategy

- Pure unit tests for canonical serialization, hashing, ancestry, and every merge decision.
- Controller tests with injected filesystem, clock, device ID, and snapshotter/importer boundaries.
- SQLite integration tests for atomic import, conflict guards, migration, and post-commit scheduling.
- Acceptance tests using two independent local databases and one temporary shared directory.
- Property-oriented permutations of duplicate and out-of-order snapshot delivery.
- HTTP/OpenAPI/client contract tests for every state and validation failure.
- MCP catalog tests for schemas, annotations, descriptions, bounded reads, and permission guidance.
- CLI tests for arguments, path validation, structured errors, and compatibility.
- Compiled E2E covering configure → mutate on A → import on B → mutate unrelated state on B →
  converge on A.
- Existing full quality suite and 100% coverage gate.

## Done criteria

- [x] A user chooses one shared parent directory per machine and synchronization becomes automatic.
- [x] Two devices modifying different Projects converge without manual action or lost state.
- [x] Two devices modifying the same entity from one base produce a visible durable conflict.
- [x] Duplicate, reordered, invalid, partial, and oversized snapshots cannot corrupt local state.
- [x] Live SQLite, Claims, secrets, and absolute remote paths never enter the synchronized folder.
- [x] Local work continues when the folder is unavailable and publishes after recovery.
- [x] Every committed mutation schedules export exactly once through the central post-commit path.
- [x] MCP agents can determine health and conflicts and receive explicit instructions not to touch
      files or configuration autonomously.
- [x] Native settings implement unconfigured, healthy, working, pending, unavailable, conflict, and
      paused states with accessible controls.
- [x] Existing backup/export behavior remains compatible.
- [x] `npm run typecheck && npm run lint && npm run format:check && npm test` passes.
- [x] `npm run test:coverage` remains at 100% statements, branches, functions, and lines.
- [x] Compiled CLI/MCP, two-daemon E2E, and platform packaging checks pass.
- [x] README, MCP docs, OpenAPI, project notes, and summary agree with the shipped behavior.

## Approval boundary

This plan does not authorize implementation by itself. Phase 0 must first turn the decisions above
into an approved product specification and immutable test contract. In particular, conflict
resolution UX and snapshot retention must be explicitly accepted or deferred before production
work begins.
