# Automatic backup settings summary

Pimpampum now keeps one daemon-owned automatic backup destination and refreshes a rolling,
integrity-checked SQLite snapshot after every committed domain mutation.

## What changed

- Added atomic settings persistence and serialized/coalesced `pimpampum-latest.sqlite` refreshes.
- Added authenticated backup settings API operations, strict client validation, OpenAPI 3.1
  documentation, and agent-oriented JSON CLI commands.
- Added a native macOS Settings scene with directory picker, status refresh, retry, Finder opening,
  change, and disable actions.
- Added a compact Quattro Backup section with optional folder dialog, absolute-path fallback,
  actionable bounded errors, file-manager opening, retry, change, and disable actions.
- Preserved timestamped manual backups and the local-only live database.

## Architecture

- `PimpampumStore` remains the only SQLite authority and emits one post-commit mutation signal.
- `AutomaticBackupController` owns the canonical private setting, health, coalescing, and shutdown
  drain through a narrow snapshot port.
- macOS and Quattro read and mutate the same daemon setting; neither persists a second copy.
- macOS clients share one authenticated receipt/token loader.

## Validation

- 358 instrumented TypeScript tests with 100% statements, branches, functions, and lines.
- 9 compiled E2E/eval workflows, including automatic backup failure and recovery.
- 78 native macOS tests with 100% enforced core coverage.
- Reversible live macOS install/render/interaction/recovery/uninstall smoke passed with fresh evidence.
- 27 Omarchy plugin/service tests plus the frozen-contract validator.
- Strict architecture review findings resolved, including exclusive unique partial files, semantic
  status validation, exact post-commit hook proof, UI status refresh, and bounded Quattro errors.
