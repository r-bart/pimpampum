# Test Manifest: Real Development Session Evals

**Date**: 2026-08-27
**Spec**: `thoughts/specs/2026-08-27_real-development-session-evals.md`
**Plan**: `thoughts/plans/2026-08-27_real-development-session-evals.md`
**Status**: all-passing

---

## Traceability Matrix

| Spec Item | Description                                                   | Test File                                                   | Test Name                              | Baseline |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- | -------- |
| US-1/AC-1 | Session A claims through compiled CLI and MCP HTTP            | `test/development-sessions.e2e.test.ts`                     | US-1 handoff                           | Failing  |
| US-1/AC-2 | Competing session is rejected                                 | `test/development-sessions.e2e.test.ts`                     | US-1 handoff                           | Failing  |
| US-1/AC-3 | Owner edits and commits before release with note              | `test/development-sessions.e2e.test.ts`                     | US-1 handoff                           | Failing  |
| US-1/AC-4 | Second agent tests, commits, and completes                    | `test/development-sessions.e2e.test.ts`                     | US-1 handoff                           | Failing  |
| US-1/AC-5 | Git artifacts and final repository are verified               | `test/development-sessions.e2e.test.ts`                     | US-1 handoff                           | Failing  |
| US-2/AC-1 | Session claims and records a tested change                    | `test/development-sessions.e2e.test.ts`                     | US-2 restart                           | Failing  |
| US-2/AC-2 | Compiled daemon restarts on the same SQLite data              | `test/development-sessions.e2e.test.ts`                     | US-2 restart                           | Failing  |
| US-2/AC-3 | New process with same agent resumes idempotently              | `test/development-sessions.e2e.test.ts`                     | US-2 restart                           | Failing  |
| US-2/AC-4 | Different session remains excluded after restart              | `test/development-sessions.e2e.test.ts`                     | US-2 restart                           | Failing  |
| FR-1      | Disposable synthetic Git repository                           | `test/development-sessions.e2e.test.ts`                     | Suite setup and both scenarios         | Failing  |
| FR-2      | Independent bounded session runner                            | `test/development-sessions.e2e.test.ts`                     | PID and structured evidence assertions | Failing  |
| FR-3      | Claim competition and explicit handoff                        | `test/development-sessions.e2e.test.ts`                     | US-1 handoff                           | Failing  |
| FR-4      | Claim continuity over restart                                 | `test/development-sessions.e2e.test.ts`                     | US-2 restart                           | Failing  |
| FR-5      | Test, source, Git object, completion, and clean-tree evidence | `test/development-sessions.e2e.test.ts`                     | Both scenarios                         | Failing  |
| FR-6      | Exact eval command/documentation alignment                    | `package.json`, `docs/evals.md` review and project commands | Phase 4 verification                   | Pending  |

---

## Test Files

| File                                    | Tests | Todos | Layer                           |
| --------------------------------------- | ----: | ----: | ------------------------------- |
| `test/development-sessions.e2e.test.ts` |     2 |     0 | Compiled process/repository E2E |

### Frozen SHA-256

`0ef2b34949d12a829f1f9f202de0127b75487630be206e8b4efc1bb1ff00749a`

Implementation must not modify `test/development-sessions.e2e.test.ts`. If the specification is
wrong, update the PRD and regenerate the tests and manifest together.

The test was regenerated once during post-review after the PRD added isolated Git configuration and
exact final-source verification. No implementation assertion changed outside that reviewed spec
update.

---

## Coverage Summary

- **Testable spec items**: 15
- **Generated E2E scenarios**: 2 passing (initially failing as recorded below)
- **Todos**: 0
- **Acceptance/functional coverage**: 100%
- **Typecheck**: passing

---

## Failing Baseline

Command:

```bash
npx vitest run test/development-sessions.e2e.test.ts
```

Observed result:

- 1 test file failed.
- 2 tests failed.
- Both fail because `test/fixtures/development-session/session.mjs` has not been implemented.
- Failure is behavioral, not a TypeScript compilation error.

---

## Next Steps

Execute `thoughts/plans/2026-08-27_real-development-session-evals.md` and make the frozen E2E tests
pass without modifying their assertions. Verify the SHA-256 before final review.
