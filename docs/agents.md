# Using Pimpampum from an agent

This document is for an agent that wants to **use** Pimpampum as shared project
memory. If you are an agent working **on** the Pimpampum codebase, read
[`AGENTS.md`](../AGENTS.md) instead.

## The brief

Give this to the agent verbatim. It is the whole contract.

```text
Use Pimpampum as the shared project memory.
Resolve the current Workspace, list available work, and claim exactly one Spec or Task before editing.
Read only the relevant Spec, Task, and explicitly scoped Context documents.
When finished, complete or release the Claim with a concise summary and artifact references.
```

## Install

No prompts, no root, no interactive steps. Safe to run unattended.

```bash
npm install --global pimpampum
pimpampum install
```

`pimpampum install` creates one per-user background service and starts the local
daemon at login. Verify it with `pimpampum status`.

## Connect over MCP

The stdio bridge resolves its own credentials from the local data directory, so
the agent never handles a token.

```json
{
  "mcpServers": {
    "pimpampum": {
      "command": "pimpampum-mcp"
    }
  }
}
```

`pimpampum mcp` starts the same bridge through the main binary. That is the route MCP registry
clients use (`npx pimpampum mcp`), because `npx pimpampum` alone resolves to the CLI. Both routes
resolve the local token themselves.

For hosts that speak streamable HTTP instead:

```text
POST http://127.0.0.1:7337/mcp
Authorization: Bearer <local-token>
```

The token lives at `<data-directory>/token` with mode `0600`. Read the effective
paths with `pimpampum config`, which works offline and never prints the token
itself.

## Or use the CLI, with no MCP at all

A shell-only agent gets the identical contract without hard-coding HTTP routes.

```bash
pimpampum commands               # every CLI verb, with arguments, options and effects
pimpampum config                 # data directory, base URL, MCP URL, stdio command
pimpampum tools                  # the canonical tool catalog
pimpampum call work_list --input '{"limit":20}'
```

### The output contract

Every command writes one `{ "data": ... }` envelope to stdout and exits 0, or one
`{ "error": ... }` envelope to stderr and exits non-zero. There is one exception:
`help` prints a text banner, because it is the human affordance. Use `commands`
to get the same catalog as JSON.

`--help`, `-h`, `--version`, and `-v` are accepted and exit 0.

Tool input comes from exactly one of `--input`, `--stdin`, or `--input-file`, up
to 2,000,000 UTF-8 bytes.

### Errors

Every error carries a stable `code`, a `retryable` boolean, and a `suggestion`
naming the next action.

| Code                | Meaning                       | What to do                                                                              |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `unavailable`       | The daemon did not answer.    | Run `pimpampum status`, then `pimpampum install` if it is not installed or not running. |
| `unauthorized`      | The token was rejected.       | Re-read `pimpampum config`.                                                             |
| `revision_conflict` | Someone else wrote first.     | Re-read the manifest, retry with its revision.                                          |
| `conflict`          | A Claim blocks the operation. | Inspect the current Claim.                                                              |
| `invalid_state`     | A lifecycle rule refused.     | Inspect the Project, Spec, Task states.                                                 |
| `not_found`         | Unknown resource.             | Resolve the workspace again.                                                            |
| `bad_request`       | Bad arguments.                | Read `details.usage` or the tool schema.                                                |
| `payload_too_large` | Input over 2,000,000 bytes.   | Split the write.                                                                        |
| `internal_error`    | The daemon faulted.           | Inspect the daemon logs.                                                                |

### Self-description

`pimpampum commands` returns every verb with its positional arguments, its
options, a rendered usage line, and effect annotations that mirror the MCP tool
annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
`requiresDaemon`. Plan against it rather than parsing the text banner.

### Named commands versus `call`

`call` is the complete domain surface and the route to prefer. The named verbs
(`work:start`, `project:complete`, and so on) are convenience wrappers over the
same tools. They accept flags for everything the tools accept, so nothing is
silently dropped:

```bash
pimpampum work:start spec SPEC_ID agent-7 --lease-seconds 600
pimpampum work:complete spec SPEC_ID agent-7 4 "Shipped" \
  --artifact https://github.com/owner/repo/pull/42 \
  --artifact /absolute/path/report.md
pimpampum project:create storefront auth "Authentication" --actor codex-thread-123
```

Use `--artifacts '[{"label":"PR","uri":"https://..."}]'` when a reference needs a
label. Every write accepts `--actor` to record who made the change.

## The loop

Three calls. There is no fourth step.

| Beat | Tool            | What it does                                                   |
| ---- | --------------- | -------------------------------------------------------------- |
| pim  | `work_list`     | Returns only work that can be started right now.               |
| pam  | `work_start`    | Takes an expiring lease on exactly one Spec or leaf Task.      |
| pum  | `work_complete` | Records a summary and artifact references, releases the claim. |

Renew a long-running claim with `work_renew`. Give it back untouched with
`work_release`.

Recommended full flow:

```text
workspace_resolve
  → work_list
  → work_start
  → spec_read and/or task_read
  → context_list / context_read for the explicit scope needed
  → work_complete or work_release
```

## The model

Five entities and one optional level of subtasks.

```text
Workspace          a product, anchored to one filesystem root
└── Project        a bounded initiative
    └── Spec       the executable Markdown description of one deliverable
        └── Task   work derived from the Spec
            └── Subtask   one level, and no more
```

A ready Spec with no open Tasks is claimable directly. Once open Tasks exist,
only leaf Tasks are claimable. `doing` is derived from a live Claim and is never
persisted.

## Rules an agent must respect

- Claim before editing. A claim is an expiring lease, not a status field.
- Read only the Spec, Task, and Context explicitly in scope. List tools return
  manifests and bounded reads, never whole bodies.
- Never create a project directly in `done`; call the completion operation.
- Never add subtasks while the parent task is claimed.
- Sync conflicts are preserved as visible conflicts. Explain the candidates;
  never resolve one autonomously.
- Errors carry stable codes. Do not flatten them.

## Reference

- Tool catalog with schemas: [`docs/mcp-tools.md`](mcp-tools.md), and the live
  `tools/list` result, which is authoritative.
- HTTP surface: OpenAPI description served by the daemon.
- Full documentation: [`README.md`](../README.md).
