# Test Manifest: Domain Model v2

**Date**: 2026-08-26
**Spec**: `thoughts/specs/2026-08-26_domain-model-v2.md`
**Status**: generated, frozen, and green

## Traceability Matrix

| Spec area                | Acceptance behavior                                                           | Test file                                           | Final status |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| Domain hierarchy         | Workspace owns Projects; Projects own multiple Specs; Specs own Tasks         | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| Project lifecycle        | Draft/open readiness, pause/reopen, terminal states                           | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| Spec lifecycle           | Draft/ready readiness and terminal cancellation                               | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| Task hierarchy           | Tasks belong to Specs and permit one Subtask level                            | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| Claims and derived doing | Ready Specs and leaf Tasks are claimable; doing is claim-derived              | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| Context ownership        | Workspace and Project Context names are independently scoped                  | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| Cancellation             | Atomic cascade, claim release, immutable terminal state, preserved history    | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| MCP contract             | Canonical Spec vocabulary with no legacy PRD aliases                          | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| HTTP/OpenAPI contract    | Spec routes, v2 schemas, and `spec \| task` target types                      | `test/domain-model-v2.acceptance.test.ts`           | passing      |
| v1 migration             | IDs, revisions, bodies, ownership, claims, context, and history are preserved | `test/domain-model-v2.migration.acceptance.test.ts` | passing      |
| Migration safety         | Corrupt v1 data rolls back and newer database versions are rejected           | `test/domain-model-v2.migration.acceptance.test.ts` | passing      |

## Test Files

| File                                                | Tests | Todos | Layer                          | SHA-256                                                            |
| --------------------------------------------------- | ----: | ----: | ------------------------------ | ------------------------------------------------------------------ |
| `test/domain-model-v2.acceptance.test.ts`           |     8 |     0 | HTTP, MCP, OpenAPI integration | `cdc2522573fa65dbe8fdf4f734ee1971484486899f42f816b2fa20352512ce90` |
| `test/domain-model-v2.migration.acceptance.test.ts` |     3 |     0 | SQLite migration integration   | `733e19216ebdbe1ce9ee454e12a1d4b5d7175efd0306ffea768fc07cbcf735da` |

## Coverage Summary

- Total mapped spec groups: 11
- Tests generated: 11 failing as expected before implementation
- Tests as todo: 0
- Acceptance-criterion coverage: 100%
- TypeScript compilation: passing

## Initial Red-State Evidence

The focused suite was run immediately after generation. All 11 tests failed for missing v2
behavior: absent Spec and Workspace Context routes, old lifecycle validation, old MCP/OpenAPI
vocabulary, schema version `1`, and no v1-to-v2 database migration. There were no compilation or
test-harness failures.

## Final Green-State Evidence

The frozen files still match their recorded SHA-256 hashes. The final product run passes all 11
generated acceptance tests as part of 377 TypeScript tests, four compiled end-to-end workflows, and
100% statement, branch, function, and line coverage.

## Immutability

The two generated acceptance files above are frozen at the recorded hashes. They must not be
modified during implementation. Production code and non-generated regression/E2E tests must make
them pass as written. If an approved specification change makes either file invalid, update the
specification first and regenerate the affected acceptance test deliberately.
