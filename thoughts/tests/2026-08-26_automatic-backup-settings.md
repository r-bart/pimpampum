# Test Manifest: Automatic Backup Settings

**Date**: 2026-08-26  
**Spec**: `thoughts/specs/2026-08-26_automatic-backup-settings.md`  
**Status**: delivered

## Acceptance suites

| Contract                         | Executable evidence                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical persisted directory    | `automatic-backup.acceptance.test.ts` persistence workflow                                                                                        |
| Valid rolling SQLite snapshot    | Real database integrity and content assertions                                                                                                    |
| Every mutation schedules refresh | Workspace, project/PRD, task and subtask workflow                                                                                                 |
| Serialized and coalesced writes  | Controlled concurrent snapshotter test                                                                                                            |
| Mutation survives backup failure | Injected failure and store readback                                                                                                               |
| Visible recovery and disable     | Status/retry/disable workflow                                                                                                                     |
| macOS native settings UX         | Native Swift composition, picker, client, and store tests                                                                                         |
| Quattro safe settings UX         | `scripts/validate-omarchy-plugin.mjs` through `test/omarchy-plugin.test.ts`; helper negatives in `test/source-contract.test.ts` (source contract) |
| HTTP and OpenAPI                 | Authenticated integration and exact schema tests                                                                                                  |
| Agent-first CLI                  | Injected CLI tests and nine compiled E2E workflows                                                                                                |

## Acceptance files

- `test/automatic-backup.acceptance.test.ts`

The acceptance intent must not be weakened during execution. Supplemental unit and integration tests may refine implementation details and close coverage branches. No test file is frozen (amendment 2026-09-01, H-14).

## Amendment 2026-09-02

`test/backup-settings-ui.acceptance.test.ts` was removed 2026-09-02, no behaviour
(`thoughts/reviews/2026-09-01_deep-review.md`, H-13): it asserted Swift and QML copy strings only.
The macOS settings behaviour is covered by `SyncSettingsTests.swift`, `BackupSettingsStoreTests.swift`,
`BackupDirectoryPickerTests.swift` and `SettingsWindowOpenerTests.swift`; the Quattro card by the
plugin validator and, for the negative helper checks, `test/source-contract.test.ts`.
