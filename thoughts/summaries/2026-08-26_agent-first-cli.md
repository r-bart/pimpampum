# Agent-first CLI summary

Pimpampum now provides a complete non-interactive shell fallback for agents while keeping MCP as
the canonical operation contract.

## What changed

- Added `pimpampum config`, `pimpampum tools`, and generic `pimpampum call` commands.
- Added an authenticated Streamable HTTP MCP client and shared Pimpampum envelopes.
- Added deterministic inline, stdin, file, zero-input, error, lifecycle, and size handling.
- Added truthful redacted token-source configuration and compiled stdio connection details.
- Added immutable acceptance tests, focused client/protocol tests, and real compiled E2E coverage.
- Updated the README and MCP tool documentation for install-to-first-call agent usage.

## Validation

- 337 instrumented TypeScript tests at 100% coverage.
- 8 compiled product E2E scenarios.
- 51 macOS Swift tests at 100% core coverage.
- 26 Omarchy tests.
- Typecheck, lint, format, package inspection, and strict review gates.
