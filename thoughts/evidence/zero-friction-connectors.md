# Zero-friction connector compatibility evidence

**Date:** 2026-08-31  
**Scope:** Plan Task 0.3  
**Evidence policy:** CLI help/version and isolated synthetic homes only. No real Codex or Claude
configuration was read or copied.

## Observed hosts

| Host        | Observed version        | Safe inspection route                                                          | Mutation scope                                                                       |
| ----------- | ----------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Codex       | `codex-cli 0.151.0`     | `codex mcp list --json`, `codex mcp get pimpampum --json`                      | `mcp add/remove` use Codex's global per-user configuration; no scope flag is exposed |
| Claude Code | `2.1.251 (Claude Code)` | Bounded `mcp get/list` text plus only `mcpServers.pimpampum` from bounded JSON | `mcp add/remove --scope user`; the CLI reports availability in all projects          |

Codex's JSON `get` and `list` shapes differ: `get` includes tool allow/deny fields, while `list`
includes `auth_status`. Both expose stdio as `transport.type`, `transport.command`, and
`transport.args`. An absent list is `[]`; an absent `get` exits with a named-server error.

Claude Code `mcp get/list` has no `--json` option in the observed version and performs a health
check, so its prose is evidence and diagnostics, not the canonical parser contract. The bounded
fallback reads a regular, non-symlink user config with revision checking and selects only
`mcpServers.pimpampum`. The synthetic user entry written by the CLI is:

```json
{
  "type": "stdio",
  "command": "/Users/example/.local/share/pimpampum/bin/pimpampum-mcp",
  "args": [],
  "env": {}
}
```

The `--scope user` probe printed `to user config`; `mcp get pimpampum` described it as available in
all projects. Synthetic local/project/user duplicates produced a conflicting-scopes diagnostic.
With all three present, local was the active entry; therefore any different local or project entry
must be surfaced as a conflict instead of silently replacing the user entry. Project entries can
also be pending approval, so their presence must be inspected independently of the active result.

## Feature-probe rules

1. Detect only bounded executable candidates and run `--version` with an argument array, timeout,
   output cap, and sanitized environment.
2. Probe the exact subcommand help before selecting an inspection or mutation route. Do not infer
   capabilities solely from a version string.
3. Prefer Codex's JSON commands. Treat an unsupported `--json` flag as a capability miss, not an
   absent connector.
4. For Claude Code, mutate only through `mcp add/remove --scope user`. If bounded text cannot be
   classified safely, read only the target entry from the bounded JSON file; never return or log
   sibling keys.
5. Treat non-zero exit, timeout, oversized output, read-only config, or revision drift as
   `unavailable` and commit no mutation. Reinspect after every successful host CLI mutation.

## Frozen scenario matrix

Both connector catalogs cover missing host, unsupported flags, absent entry, exact owned entry,
receipt-proven legacy `npx pimpampum mcp`, unknown conflict, read-only configuration, concurrent
revision, and host CLI failure. Claude additionally freezes higher-precedence scope collision.

The fixtures live under `test/fixtures/connectors/`. All paths use `example`, `synthetic`, or
redaction markers; no bearer token, environment secret, real project path, or unrelated host entry
is present.
