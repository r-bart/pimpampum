# Implementation Plan: Agent-first CLI

**Date**: 2026-08-26
**Status**: completed

## Overview

Add a complete shell fallback for agents by negotiating with Pimpampum's existing MCP endpoint.
Keep current convenience commands compatible while making configuration, tool discovery, arbitrary
tool execution, and errors deterministic and machine-readable.

## Requirements

- [x] `config` exposes effective, redacted local and MCP configuration while offline.
- [x] `tools` returns the live MCP catalog.
- [x] `call` supports inline JSON, stdin, files, and empty-object defaults.
- [x] Calls preserve MCP envelopes and close their session on every outcome.
- [x] CLI-generated errors are structured and non-zero.
- [x] Current human/admin commands remain compatible.
- [x] Documentation and runtime packaging support the compiled workflow.

## Approach Analysis

### Option A: Duplicate MCP operations in the CLI

Map each tool name to `PimpampumHttpClient` methods and maintain separate argument parsing.

**Pros**: No runtime MCP client dependency; direct calls are marginally simpler.

**Cons**: Duplicates 24 schemas, descriptions, defaults, pagination behavior, projections, and error
guidance. It will drift whenever MCP changes.

**Complexity**: High ongoing maintenance.

### Option B: Use Pimpampum's MCP endpoint as the CLI backend

The CLI opens a short-lived authenticated Streamable HTTP MCP session for `tools` and `call`.

**Pros**: Exact catalog and behavior parity, complete operation coverage, minimal new command
surface, and no domain-rule duplication.

**Cons**: Requires the MCP client package at runtime and careful session cleanup.

**Complexity**: Medium initial, low ongoing maintenance.

### Recommendation

Use Option B. MCP remains canonical; the CLI becomes a transport adapter. Share only the generic
Pimpampum envelope/error helpers so locally generated failures match MCP without importing domain
rules into the CLI.

## Files to Create or Modify

| File                                | Action    | Purpose                                                        |
| ----------------------------------- | --------- | -------------------------------------------------------------- |
| `src/agentProtocol.ts`              | Create    | Shared success/error envelope validation and guidance          |
| `src/agentClient.ts`                | Create    | Short-lived authenticated MCP client adapter                   |
| `src/mcp.ts`                        | Modify    | Reuse shared error-envelope construction                       |
| `src/cliProgram.ts`                 | Modify    | Add config/tools/call, input parsing, structured failures      |
| `src/cli.ts`                        | Modify    | Compose MCP client, redacted config, stdin, and compiled paths |
| `test/agent-cli.acceptance.test.ts` | Make pass | Immutable specification tests                                  |
| `test/agent-client.test.ts`         | Create    | MCP transport, normalization, and lifecycle regressions        |
| `test/agent-protocol.test.ts`       | Create    | Shared envelope validation regressions                         |
| `test/cli-program.test.ts`          | Modify    | Parser, limits, and existing-command compatibility             |
| `test/e2e.test.ts`                  | Modify    | Exercise compiled tool discovery and calls against real daemon |
| `package.json` / lockfile           | Modify    | Ship MCP client as a runtime dependency                        |
| `README.md`                         | Modify    | Document install/configure/discover/call agent journey         |
| `docs/mcp-tools.md`                 | Modify    | Document CLI parity and examples                               |

## Implementation Phases

### Phase 1: Agent protocol and client

#### Task 1.1: Centralize agent envelopes

Create helpers that build actionable error envelopes and validate a single MCP text result as
either `{data: ...}` or `{error: ...}`. Reuse error guidance from MCP.

#### Task 1.2: Add short-lived MCP client

Connect to `<baseUrl>/mcp` using the configured bearer token, expose `listTools`, `callTool`, and
`close`, and close partially initialized clients after failed connection attempts.

### Phase 2: CLI command surface

#### Task 2.1: Add deterministic agent commands

Extend the injected runtime and command dispatcher with `config`, `tools`, and `call`. Parse one
bounded JSON object from inline input, stdin, or file; make `{}` the default.

#### Task 2.2: Structure all command failures

Convert CLI parsing and runtime failures to one JSON error on stderr with exit code 1 while
preserving existing successful outputs and service commands.

### Phase 3: Composition, packaging, and verification

#### Task 3.1: Compose runtime configuration

Wire the real MCP adapter, bounded standard input, token path, base URL, HTTP MCP endpoint, and
stdio launch command without exposing the token.

#### Task 3.2: Complete tests and E2E coverage

Make immutable tests pass, add lower-level edge cases, and exercise the compiled daemon/CLI flow.
Maintain 100% TypeScript coverage.

#### Task 3.3: Document the agent journey

Add copy-pasteable environment configuration, installation, inspection, discovery, inline/stdin/file
calls, error handling, and MCP-vs-CLI guidance.

## Task Dependencies

```yaml
dependencies:
  1.1: []
  1.2: []
  2.1: [1.1, 1.2]
  2.2: [1.1, 2.1]
  3.1: [1.2, 2.1, 2.2]
  3.2: [3.1]
  3.3: [3.1, 3.2]
```

## Risk Analysis

- MCP client connection failure must not leak token contents or an open transport.
- Agent input must reject arrays, primitives, conflicting sources, unknown flags, malformed JSON,
  and oversized values before calling MCP.
- CLI tests inject `exit`; structured failure handling must not recursively catch exit behavior.
- Runtime dependency packaging must include the MCP client after `npm pack`.
- Existing commands must retain their successful raw JSON shape.

## Testing Strategy

- Immutable acceptance tests for the user-facing contract.
- Unit tests for envelopes, input limits, malformed MCP content, and close behavior.
- Existing CLI command regression tests.
- Compiled E2E tests against a temporary real daemon and SQLite database.
- Full typecheck, lint, format, coverage, E2E, macOS, and Omarchy static gates.

## Done Criteria

- [x] Immutable agent CLI acceptance tests pass without modification.
- [x] `pimpampum config` works without a running daemon and never prints token contents.
- [x] `pimpampum tools` exactly reflects live MCP metadata.
- [x] Every MCP tool can be invoked by `pimpampum call` with an object from inline JSON, stdin, or
      file.
- [x] Failed tools and local CLI failures emit structured JSON to stderr and exit non-zero.
- [x] MCP clients close after list, success, tool error, malformed response, and transport failure.
- [x] Existing CLI tests and compiled E2E use cases remain green.
- [x] `npm run typecheck && npm run lint && npm run format:check && npm test` passes.
- [x] `npm run test:coverage` reports 100% statements, branches, functions, and lines.
- [x] `npm pack --dry-run` includes the runnable agent CLI and its runtime dependencies.
- [x] No new TODO, FIXME, or HACK markers.
- [x] README and MCP tool documentation describe the complete agent workflow.

## Approval

Approved by the user's explicit request to optimize the CLI so agents can install, configure, and
use Pimpampum. Execution may proceed without a separate confirmation round.
