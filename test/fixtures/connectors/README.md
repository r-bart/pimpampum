# Connector fixtures

These fixtures record the connector surface of the two supported agent CLIs and drive
`test/connectors-codex.test.ts` and `test/connectors-claude-code.test.ts` through
`test/fixtures/connectors/load.ts`. Consumers select fixtures through each host's
`scenarios.json` and `capabilities.json`; filenames are not a wire contract.

## Recorded output (real, re-observed 2026-09-02)

Captured read-only from Codex CLI `0.151.0` and Claude Code `2.1.257` on this machine:

- `<host>/version.txt` — `<host> --version`.
- `<host>/help-mcp-*.txt` — the `--help` text of every subcommand the connector feature-probes.
  The connector reads these for `--json` and `--scope`; the tests reuse the recorded text as the
  probe answers.
- `claude-code/unsupported-json-flag.txt` — stderr of `claude mcp list --json` (exit 1).
- `<host>/get-absent.txt` — stderr of `<host> mcp get pimpampum [--json]` when no entry exists
  (exit 1). Claude Code lists the configured server names in this message; the recorded names are
  synthetic.

## Synthetic shapes (observed for Codex `0.151.0` and Claude Code `2.1.251`, 2026-08-31)

- `codex/get-*.json`, `codex/list-*.json` — the JSON `codex mcp get/list --json` emit, with
  synthetic paths, commands and project names.
- `codex/unsupported-json-flag.txt` — what an older Codex prints when `--json` is not accepted.
  Version `0.151.0` accepts the flag; the `unsupportedFlags` scenario is therefore a defensive one.
- `claude-code/entry-*.json` — only the `mcpServers.pimpampum` entry of a synthetic
  `~/.claude.json`; `claude-code/get-owned-current.txt` the text `claude mcp get pimpampum`
  prints for it; `claude-code/scope-collision.json` the three-scope collision.
- `shared/` — deterministic process and revision failures for fault injection.

Every path, command, project name and configuration document is synthetic and contains no host
credentials or developer configuration. Text fixtures keep host punctuation; volatile temporary
paths and terminal control sequences are redacted.
