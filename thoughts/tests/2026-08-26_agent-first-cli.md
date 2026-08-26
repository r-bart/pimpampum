# Test Manifest: Agent-first CLI

**Date**: 2026-08-26
**Spec**: `thoughts/specs/2026-08-26_agent-first-cli.md`
**Status**: passing

## Traceability Matrix

| Spec item   | Description                                 | Test file                           | Status  |
| ----------- | ------------------------------------------- | ----------------------------------- | ------- |
| US-1/AC-2–3 | Redacted effective configuration            | `test/agent-cli.acceptance.test.ts` | passing |
| US-2/AC-1–2 | Live MCP catalog and deterministic envelope | `test/agent-cli.acceptance.test.ts` | passing |
| US-3/AC-1   | Inline JSON calls                           | `test/agent-cli.acceptance.test.ts` | passing |
| US-3/AC-2   | JSON stdin with Markdown and Unicode        | `test/agent-cli.acceptance.test.ts` | passing |
| US-3/AC-3   | JSON input file                             | `test/agent-cli.acceptance.test.ts` | passing |
| US-3/AC-4   | Empty-object default                        | `test/agent-cli.acceptance.test.ts` | passing |
| US-3/AC-5   | Deterministic parser rejection              | `test/agent-cli.acceptance.test.ts` | passing |
| US-4/AC-1–4 | Structured MCP errors and lifecycle         | `test/agent-cli.acceptance.test.ts` | passing |
| FR-3 / EC-3 | Invalid MCP response rejection              | `test/agent-cli.acceptance.test.ts` | passing |

## Test Files

| File                                | Tests | Todos | Layer           |
| ----------------------------------- | ----: | ----: | --------------- |
| `test/agent-cli.acceptance.test.ts` |    13 |     0 | CLI integration |

## Coverage Summary

- Total mapped spec groups: 9
- Tests generated: 13 passing
- Tests as todo: 0
- Acceptance-criterion coverage: 100%

## Immutability

The generated acceptance file must not be modified during implementation. Production code and
non-generated regression/E2E tests must make it pass as written.
