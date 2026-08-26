# PRD: Automatic Backup Settings

**Date**: 2026-08-26  
**Status**: approved

## Summary

Pimpampum will let the user choose one backup directory from the macOS menu-bar app, the Omarchy Quattro widget, the CLI, or the authenticated HTTP API. The daemon persists that single canonical setting and atomically refreshes a rolling SQLite snapshot after every successful domain mutation.

The live database remains on a local filesystem. Only the verified snapshot is written to a user-selected directory, including folders synchronized by iCloud Drive, Dropbox, Google Drive, or similar tools.

## Goals

1. Keep one current, portable backup without unbounded snapshot growth.
2. Let users configure the same destination from macOS and Quattro.
3. Provide deterministic CLI and HTTP contracts usable by agents and scripts.
4. Never roll back a valid domain mutation because a backup destination is offline or unwritable.
5. Make backup health and the last successful refresh visible.

## Non-goals

- Moving the live SQLite database into a cloud-synchronized directory.
- Synchronizing multiple live Pimpampum instances.
- Backup history, retention policies, encryption, or remote-provider APIs.
- Project-specific backup destinations.
- Editing projects or tasks from either desktop status surface.

## Product Semantics

### Canonical setting

There is zero or one configured `backupDirectory`. It is stored by the daemon, not duplicated in macOS preferences or Quattro `shell.json`.

The directory must be an existing, absolute, writable directory when configured. It may later become unavailable; that condition is reported without deleting the setting.

### Automatic snapshot

- Filename: `pimpampum-latest.sqlite`.
- A successful project, PRD, context, task, subtask, or work-claim mutation marks the backup dirty.
- The mutation commits before backup I/O begins.
- Backup work is serialized and coalesced. A mutation arriving during a backup causes one additional refresh, not a parallel writer.
- A temporary local SQLite backup is integrity-checked, copied to a sibling partial file, permissioned to `0600`, and atomically renamed over the rolling snapshot.
- Configuration immediately schedules a snapshot so an empty or idle instance is backed up too.
- Disabling automatic backup stops future refreshes but does not delete existing backup files.
- Manual timestamped `pimpampum backup <directory>` snapshots remain unchanged.

### Failure behavior

- Domain mutations remain successful if automatic backup fails.
- Status exposes the most recent attempt, most recent success, snapshot path, and a sanitized actionable error.
- A later mutation or explicit retry attempts recovery.
- Shutdown waits for in-flight backup work before closing SQLite.

## User Stories

### Configure on macOS

As a macOS user, I can open Settings from the menu-bar popover, choose a folder with the native directory picker, see the effective path and health, retry, change it, open it in Finder, or disable automatic backup.

### Configure on Quattro

As an Omarchy Quattro user, I can open a compact Backup section in the widget popout, choose a directory through Qt's folder dialog when available, or enter an absolute path as a fallback. I can save, retry, open, change, or disable the same daemon setting.

### Configure as an agent

As an agent, I can inspect and configure backup using stable JSON CLI commands or the documented authenticated API, without editing config files or parsing prose.

## Functional Requirements

### Shared contract

Authenticated endpoints:

```http
GET /api/v1/settings/backup
PUT /api/v1/settings/backup
POST /api/v1/settings/backup/retry
DELETE /api/v1/settings/backup
```

The GET response contains:

```json
{
  "enabled": true,
  "directory": "/absolute/path",
  "snapshotPath": "/absolute/path/pimpampum-latest.sqlite",
  "state": "healthy",
  "lastAttemptAt": "2026-08-26T08:00:00.000Z",
  "lastSuccessAt": "2026-08-26T08:00:00.000Z",
  "error": null
}
```

`state` is one of `disabled`, `pending`, `healthy`, or `error`. Optional timestamps and paths are `null` when unavailable. PUT accepts only `{ "directory": "/absolute/path" }`.

Agent-first CLI:

```text
pimpampum backup status --json
pimpampum backup configure <absolute-directory> --json
pimpampum backup retry --json
pimpampum backup disable --json
```

Machine-readable output is written only to stdout; diagnostics go to stderr; exit codes are stable and non-zero on rejected configuration or retry failure.

### macOS settings

- Add a SwiftUI `Settings` scene and a `SettingsLink` from the existing popover.
- Use `NSOpenPanel` configured for one directory and no files.
- Use the installation receipt and private bearer token exactly as the overview client does.
- Save only through the HTTP API; do not store a second copy in defaults.
- Show loading, disabled, pending, healthy, and error states.
- Never reveal the bearer token in UI, logs, or errors.

### Quattro settings

- Keep the bar indicator unchanged.
- Add a Backup section to the existing popout.
- Prefer Qt `FolderDialog`; retain a validated absolute-path field as a portable fallback.
- Invoke a receipt-owned helper with separate process arguments. Never concatenate a user path into a shell command.
- The helper delegates to the canonical CLI contract and emits JSON.
- Preserve the user's arbitrary Quattro layout and inline widget settings.

## Security and Safety

- All HTTP endpoints remain bearer-authenticated and loopback-bound.
- Paths are data, never executable shell source.
- The daemon performs destination validation; UIs do not claim success before server confirmation.
- Automatic backup files and partial files use owner-only permissions.
- Errors never include tokens, database contents, PRD bodies, or task bodies.
- Existing files other than Pimpampum's named partial/current snapshot are never removed.

## Acceptance Criteria

- [x] One configured directory is visible consistently through API, CLI, macOS, and Quattro.
- [x] Every successful domain mutation eventually appears in `pimpampum-latest.sqlite`.
- [x] Concurrent mutations produce a valid latest snapshot without parallel backup writers.
- [x] A failed backup does not fail or undo the originating mutation.
- [x] Recovery refreshes the snapshot and clears the visible error.
- [x] Configure, retry, change, and disable behave idempotently.
- [x] macOS uses a native directory picker.
- [x] Quattro supports a folder dialog plus a safe manual-path fallback.
- [x] OpenAPI documents every schema, response, authentication rule, and error.
- [x] Existing manual backup behavior and desktop status behavior remain compatible.
- [x] TypeScript and Swift suites retain 100% enforced coverage; QML contracts and a real usage workflow are tested.

## Edge Cases

- Destination disappears or becomes read-only after configuration.
- Cloud-sync client creates temporary sibling files.
- Configure is called with a relative path, file, symlink-to-file, or non-writable directory.
- Destination already contains an older snapshot or stale partial.
- Mutations occur while a snapshot is being copied.
- Disable or change destination while a refresh is active.
- Daemon shuts down during a refresh.
- macOS app is running with a stale or missing installation receipt.
- Quattro lacks the optional folder-dialog module.
- Path contains spaces, Unicode, quotes, or shell metacharacters.

## Validation

- Store/coordinator unit tests with injected backup and time adapters.
- Real temporary SQLite integration tests that open the rolling snapshot and verify post-mutation data.
- HTTP/OpenAPI/CLI contract tests.
- Swift client, state-model, native picker adapter, and settings-view tests.
- QML/helper static safety tests and plugin validation.
- E2E workflow: configure → mutate multiple resource types → inspect snapshot → force failure → mutate successfully → restore → retry → disable.
