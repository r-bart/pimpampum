# Synthetic connector fixtures

These fixtures freeze the connector surface observed for Codex CLI `0.151.0` and Claude Code
`2.1.251`. Every path, command, project name, error, and configuration document is synthetic and
contains no host credentials or developer configuration.

- `codex/` contains the raw JSON shapes emitted by `codex mcp get/list --json` plus a scenario
  catalog.
- `claude-code/` contains bounded text output and only the `pimpampum` entry extracted from a
  synthetic `~/.claude.json`.
- `shared/` contains deterministic process and revision failures intended for fault injection.

Consumers should select fixtures through each host's `scenarios.json`; filenames are not a wire
contract. Text fixtures intentionally retain host punctuation, while volatile temporary paths and
terminal control sequences are redacted.
