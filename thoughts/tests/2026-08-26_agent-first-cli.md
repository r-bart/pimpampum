# Test Manifest: Agent-first CLI

**Date**: 2026-08-26
**Spec**: `thoughts/specs/2026-08-26_agent-first-cli.md`
**Status**: passing — amended 2026-09-02 (see the note at the end)

## Traceability Matrix

| Spec item   | Description                                 | Test file                                           | Status  |
| ----------- | ------------------------------------------- | --------------------------------------------------- | ------- |
| US-1/AC-2–3 | Redacted effective configuration            | `test/agent-cli.acceptance.test.ts`                 | passing |
| US-2/AC-1–2 | Live MCP catalog and deterministic envelope | `test/agent-cli.acceptance.test.ts`                 | passing |
| US-3/AC-1   | Inline JSON calls                           | `test/agent-cli.acceptance.test.ts`                 | passing |
| US-3/AC-2   | JSON stdin with Markdown and Unicode        | `test/agent-cli.acceptance.test.ts` (`spec_update`) | passing |
| US-3/AC-3   | JSON input file                             | `test/agent-cli.acceptance.test.ts`                 | passing |
| US-3/AC-4   | Empty-object default                        | `test/agent-cli.acceptance.test.ts`                 | passing |
| US-3/AC-5   | Deterministic parser rejection              | `test/agent-cli.acceptance.test.ts`                 | passing |
| US-4/AC-1–4 | Structured MCP errors and lifecycle         | `test/agent-cli.acceptance.test.ts`                 | passing |
| FR-3 / EC-3 | Invalid MCP response rejection              | `test/agent-cli.acceptance.test.ts`                 | passing |

## Test Files

| File                                | Tests | Todos | Layer           |
| ----------------------------------- | ----: | ----: | --------------- |
| `test/agent-cli.acceptance.test.ts` |    14 |     0 | CLI integration |

## Coverage Summary

- Total mapped spec groups: 9
- Tests generated: 14 passing
- Tests as todo: 0
- Acceptance-criterion coverage: 100%

## Amendment 2026-09-02

Source: `thoughts/reviews/2026-09-01_deep-review.md`, finding H-14, and Task 8.2 of
`thoughts/plans/2026-09-01_deep-review-remediation.md`.

- The file is not frozen; its `@immutable` header was removed. The `@generated-from` reference and
  the spec-id test titles remain the contract.
- US-3/AC-2 called `project_update_prd`, a tool removed from the product, behind a mock that echoed
  any name. It now calls `spec_update` with a Markdown `body`.
- Every tool name the file passes to `call` is typed against `test/helpers/canonicalTools.ts`, the
  mock rejects a non-canonical name, and one test compares that helper with the live `tools/list` of
  the MCP handler.
