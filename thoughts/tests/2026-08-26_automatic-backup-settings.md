# Test Manifest: Automatic Backup Settings

**Date**: 2026-08-26  
**Spec**: `thoughts/specs/2026-08-26_automatic-backup-settings.md`  
**Status**: delivered

## Acceptance suites

| Contract                         | Executable evidence                                        |
| -------------------------------- | ---------------------------------------------------------- |
| Canonical persisted directory    | `automatic-backup.acceptance.test.ts` persistence workflow |
| Valid rolling SQLite snapshot    | Real database integrity and content assertions             |
| Every mutation schedules refresh | Workspace, project/PRD, task and subtask workflow          |
| Serialized and coalesced writes  | Controlled concurrent snapshotter test                     |
| Mutation survives backup failure | Injected failure and store readback                        |
| Visible recovery and disable     | Status/retry/disable workflow                              |
| macOS native settings UX         | Native Swift composition, picker, client, and store tests  |
| Quattro safe settings UX         | QML/helper safety contracts and full plugin validator      |
| HTTP and OpenAPI                 | Authenticated integration and exact schema tests           |
| Agent-first CLI                  | Injected CLI tests and nine compiled E2E workflows         |

## Frozen files

- `test/automatic-backup.acceptance.test.ts`
- `test/backup-settings-ui.acceptance.test.ts`

The acceptance intent must not be weakened during execution. Supplemental unit and integration tests may refine implementation details and close coverage branches.
