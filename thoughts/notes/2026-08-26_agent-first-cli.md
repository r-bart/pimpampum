# Agent-first CLI — implementation and strict review notes

**Date**: 2026-08-26
**Plan**: `thoughts/plans/2026-08-26_agent-first-cli.md`
**Verdict**: Ready

## Delivered

- Offline, redacted `config` output with the effective token source and only an actual token path.
- Live MCP `tools/list` discovery without a duplicated CLI catalog.
- Arbitrary `call` execution using inline JSON, bounded streaming stdin, files, or `{}`.
- One success/error envelope shared by MCP and CLI with structured stderr and exit status 1.
- Short-lived authenticated MCP sessions with cleanup on success and failure.
- Source-checkout and future npm installation guidance for shell-only agents.

## Strict review corrections

- CLI input and MCP transport limits must be designed together; byte limits cannot be inferred from
  JavaScript character limits when Markdown may contain multibyte Unicode.
- Large stdin must be consumed asynchronously. Synchronous reads from a producer pipe can exit
  while the producer is still writing and cause `EPIPE`.
- UTF-8 decoding must be fatal so invalid bytes are never silently changed to U+FFFD before JSON
  parsing.
- A configured token path is truthful only when the effective token actually comes from that file.
- Textual SDK normalization is safe only while the complete MCP runtime stack is version-pinned and
  the exact and adversarial wording contracts are tested.
- Shared envelopes should centralize both success and failure producers, not only consumers.

## Verification evidence

- Immutable acceptance tests pass unchanged.
- TypeScript coverage: 100% statements, branches, functions, and lines.
- Compiled E2E includes a 1.2 MB multibyte stdin call, invalid UTF-8, oversize rejection, both token
  sources, live discovery, and real daemon writes.
- Typecheck, lint, formatting, macOS, Omarchy, package, diff, and no-marker gates pass.
