# PRD: Agent-first CLI

**Date**: 2026-08-26
**Status**: completed

## Executive Summary

Extend Pimpampum's existing non-interactive CLI into a complete shell fallback for agents. Agents
must be able to inspect local configuration, install and diagnose the service, discover the same
operations exposed by MCP, and invoke any operation with deterministic JSON without duplicating
domain or tool contracts.

## Problem Statement

### Current State

The CLI prints JSON for successful convenience commands and already supports service installation,
status, common work operations, backup, and export. MCP exposes the complete agent workflow with
described schemas and structured errors.

### Pain Points

- Shell-only agents cannot access the complete MCP tool surface through the CLI.
- CLI failures are plain text and discard error code, retryability, details, and guidance.
- Positional arguments are fragile for Markdown, structured artifacts, and optional fields.
- Agents cannot inspect the effective local connection and MCP configuration without reading code
  or exposing the bearer token.
- Adding one CLI command per MCP tool would create a second contract that can drift.

## Goals & Non-Goals

### Goals

1. Expose the live MCP tool catalog through a deterministic CLI command.
2. Invoke every MCP tool using JSON supplied inline, from a file, or through standard input.
3. Preserve the MCP success and structured error envelopes and return a non-zero exit status for
   failed calls.
4. Expose effective daemon and MCP configuration without printing secret token contents.
5. Keep installation, status, uninstall, backup, export, and existing human shortcuts compatible.
6. Document a complete install, configure, discover, call, and diagnose workflow for agents.

### Non-Goals

- Reimplementing MCP tool schemas or domain rules in the CLI.
- Interactive prompts or terminal UI.
- Remote daemon access or non-loopback configuration.
- Persisting a new configuration format; environment variables remain the canonical configuration
  mechanism in this iteration.
- Adding automatic cloud backup in this feature.

## User Stories

### US-1: Install and inspect

As a shell-capable agent, I want to install Pimpampum and inspect its effective configuration so I
can configure another agent without exposing secrets.

Acceptance criteria:

- US-1/AC-1: `pimpampum install`, `status`, and `uninstall` remain non-interactive JSON commands.
- US-1/AC-2: `pimpampum config` returns data directory, database path, base URL, redacted token
  source, an actual token-file path or `null`, MCP HTTP URL, and MCP stdio launch details without
  returning the token value.
- US-1/AC-3: `PIMPAMPUM_DATA_DIR`, `PIMPAMPUM_HOST`, `PIMPAMPUM_PORT`, and `PIMPAMPUM_TOKEN` remain
  usable for deterministic configuration.

### US-2: Discover operations

As an agent, I want to list the daemon's tools and their schemas so I can form valid calls without a
separate hard-coded CLI reference.

Acceptance criteria:

- US-2/AC-1: `pimpampum tools` returns the same names, descriptions, annotations, and input schemas
  as MCP `tools/list`.
- US-2/AC-2: The response is a single JSON envelope and contains no terminal decoration.

### US-3: Invoke operations

As an agent, I want to invoke any tool with structured input so I can use all project, PRD, context,
task, subtask, claim, and activity operations from a shell.

Acceptance criteria:

- US-3/AC-1: `pimpampum call <tool> --input '<json>'` invokes the named MCP tool.
- US-3/AC-2: `--stdin` accepts exactly one JSON value from standard input.
- US-3/AC-3: `--input-file <path>` reads UTF-8 JSON from a file.
- US-3/AC-4: Omitting an input source supplies `{}` for zero-argument tools.
- US-3/AC-5: Multiple input sources, trailing arguments, malformed JSON, non-object input, and an
  empty tool name are rejected deterministically.

### US-4: Recover from failures

As an agent, I want machine-readable errors so I can decide whether and how to retry.

Acceptance criteria:

- US-4/AC-1: MCP tool failures preserve `code`, `message`, `retryable`, `details`, and `suggestion`.
- US-4/AC-2: CLI parsing, configuration, transport, and invalid-response failures use the same
  structured error shape.
- US-4/AC-3: Successful calls exit 0; failed calls exit non-zero and write one JSON error envelope
  to stderr.
- US-4/AC-4: The MCP session closes after listing, successful calls, and failed calls.

## Functional Requirements

- FR-1: The agent call path must negotiate with the daemon's Streamable HTTP MCP endpoint rather
  than mapping tool names to HTTP client methods.
- FR-2: The CLI must authenticate internally using the configured local token.
- FR-3: Tool result content must be validated as one parseable Pimpampum JSON envelope before it is
  emitted.
- FR-4: Input files and standard input must be bounded to prevent unbounded memory consumption.
- FR-5: Existing CLI output and command behavior remain backward compatible.
- FR-6: Runtime packaging includes the MCP client dependency required by `tools` and `call`.

## Edge Cases

- EC-1: The daemon is offline or times out.
- EC-2: The token is rejected.
- EC-3: The MCP server returns non-text, multiple, malformed, or incorrectly shaped content.
- EC-4: Standard input or an input file exceeds the supported size.
- EC-5: A tool returns a schema validation error.
- EC-6: Markdown contains newlines, quotes, or Unicode.

## Success Metrics

- Every MCP tool can be discovered and invoked from the compiled CLI.
- Agent CLI acceptance tests cover inline, stdin, file, zero-input, structured-error, and offline
  behavior.
- Existing unit, integration, E2E, MCP, desktop, and coverage gates remain green.
- TypeScript coverage remains 100% for statements, branches, functions, and lines.

## Risks

| Risk                        | Impact | Mitigation                                       |
| --------------------------- | ------ | ------------------------------------------------ |
| MCP and CLI lifecycle leaks | Medium | Close clients in `finally` and test all paths    |
| Tool metadata drift         | High   | Obtain catalog and execution from MCP itself     |
| Secret disclosure           | High   | Return token path/presence, never token contents |
| Oversized input             | Medium | Enforce one explicit byte limit before parsing   |
| Breaking existing scripts   | High   | Preserve current commands and raw success JSON   |

## Open Questions

None. The user's explicit request approves implementation with MCP as the preferred interface and
the CLI as a complete shell fallback.
