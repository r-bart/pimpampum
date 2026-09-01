# Test Manifest: Real Development Session Evals

**Date**: 2026-08-27
**Spec**: `thoughts/specs/2026-08-27_real-development-session-evals.md`
**Plan**: `thoughts/plans/2026-08-27_real-development-session-evals.md`
**Status**: all passing — amended 2026-09-01 (see the amendment note at the end)

---

## Traceability Matrix

Status is the observed result on 2026-09-01 (`npx vitest run test/development-sessions.e2e.test.ts`
against a fresh `dist/`).

| Spec Item | Description                                                   | Test File                                    | Test Name                              | Status   |
| --------- | ------------------------------------------------------------- | -------------------------------------------- | -------------------------------------- | -------- |
| US-1/AC-1 | Session A claims through compiled CLI and MCP HTTP            | `test/development-sessions.e2e.test.ts`      | US-1 handoff                           | Passing  |
| US-1/AC-2 | Competing session is rejected                                 | `test/development-sessions.e2e.test.ts`      | US-1 handoff                           | Passing  |
| US-1/AC-3 | Owner edits and commits before release with note              | `test/development-sessions.e2e.test.ts`      | US-1 handoff                           | Passing  |
| US-1/AC-4 | Second agent tests, commits, and completes                    | `test/development-sessions.e2e.test.ts`      | US-1 handoff                           | Passing  |
| US-1/AC-5 | Git artifacts and final repository are verified               | `test/development-sessions.e2e.test.ts`      | US-1 handoff                           | Passing  |
| US-2/AC-1 | Session claims and records a tested change                    | `test/development-sessions.e2e.test.ts`      | US-2 restart                           | Passing  |
| US-2/AC-2 | Compiled daemon restarts on the same SQLite data              | `test/development-sessions.e2e.test.ts`      | US-2 restart                           | Passing  |
| US-2/AC-3 | New process with same agent resumes idempotently              | `test/development-sessions.e2e.test.ts`      | US-2 restart                           | Passing  |
| US-2/AC-4 | Different session remains excluded after restart              | `test/development-sessions.e2e.test.ts`      | US-2 restart                           | Passing  |
| FR-1      | Disposable synthetic Git repository                           | `test/development-sessions.e2e.test.ts`      | Suite setup and both scenarios         | Passing  |
| FR-2      | Independent bounded session runner                            | `test/development-sessions.e2e.test.ts`      | PID and structured evidence assertions | Passing  |
| FR-3      | Claim competition and explicit handoff                        | `test/development-sessions.e2e.test.ts`      | US-1 handoff                           | Passing  |
| FR-4      | Claim continuity over restart                                 | `test/development-sessions.e2e.test.ts`      | US-2 restart                           | Passing  |
| FR-5      | Test, source, Git object, completion, and clean-tree evidence | `test/development-sessions.e2e.test.ts`      | Both scenarios                         | Passing  |
| FR-6      | Exact eval command/documentation alignment                    | `package.json` `test:evals`, `docs/evals.md` | Manual review; no executable test      | Reviewed |

FR-6 has no executable test. `package.json` defines `test:evals` as `npm run test:e2e`, and
`docs/evals.md` documents that command and the six E2E tests it runs. The deep review of 2026-09-01
confirmed the count.

---

## Test Files

| File                                    | Tests | Todos | Layer                           | Status  |
| --------------------------------------- | ----: | ----: | ------------------------------- | ------- |
| `test/development-sessions.e2e.test.ts` |     2 |     0 | Compiled process/repository E2E | Passing |

`npm run test:evals` runs six E2E tests in total: the two above plus the four in
`test/e2e.test.ts`. Earlier documents that said "7 compiled workflow evals" were wrong; see D-07 in
the deep review.

---

## Coverage Summary

- **Testable spec items**: 15
- **Generated E2E scenarios**: 2, passing
- **Todos**: 0
- **Acceptance/functional coverage**: 14 of 15 items executable; FR-6 is a documentation review
- **Typecheck**: passing

---

## History

### Failing baseline (2026-08-27)

Command:

```bash
npx vitest run test/development-sessions.e2e.test.ts
```

Observed result at generation time:

- 1 test file failed.
- 2 tests failed.
- Both failed because `test/fixtures/development-session/session.mjs` had not been implemented.
- Failure was behavioral, not a TypeScript compilation error.

The test was regenerated once during post-review after the PRD added isolated Git configuration and
exact final-source verification. No implementation assertion changed outside that reviewed spec
update.

---

## Amendment 2026-09-01

Source: `thoughts/reviews/2026-09-01_deep-review.md`, finding H-14, and Task 0.1 of
`thoughts/plans/2026-09-01_deep-review-remediation.md`.

- The "Frozen SHA-256" section was removed. The recorded hash
  (`0ef2b34949d12a829f1f9f202de0127b75487630be206e8b4efc1bb1ff00749a`) no longer matched the file
  and no script verified it, so it documented nothing.
- `test/development-sessions.e2e.test.ts` is no longer frozen. Its `@immutable` header will be
  removed in a later phase of the remediation plan. The `@generated-from` reference and the
  US-1/US-2 test titles remain the contract: the file changes only together with the spec item it
  names.
- The "Baseline" column was replaced by the observed status.
