# Using Pimpampum from an agent

This document is for an agent that is already connected to Pimpampum and wants to use it as shared
project memory. If you are working **on** the Pimpampum codebase, read
[`AGENTS.md`](../AGENTS.md) instead.

If the Pimpampum tools are missing, stop and ask the operator to open Pimpampum's **Agents**
settings, connect or repair this agent, and then start a new agent session. Do not request a token,
edit MCP configuration, install packages, or open the local database yourself.

## The brief

Give this to the agent verbatim. It is the whole contract.

```text
Use Pimpampum as the shared project memory.
Resolve the current Workspace, list available work, and claim exactly one Spec or leaf Task before editing.
Read only the relevant Spec, Task, and explicitly scoped Context documents.
When finished, complete or release the Claim with a concise summary and artifact references.
```

## The loop

Three calls. There is no fourth step.

| Beat | Tool            | What it does                                                   |
| ---- | --------------- | -------------------------------------------------------------- |
| pim  | `work_list`     | Returns only work that can be started right now.               |
| pam  | `work_start`    | Takes an expiring lease on exactly one Spec or leaf Task.      |
| pum  | `work_complete` | Records a summary and artifact references, releases the Claim. |

Renew long work with `work_renew`. Give unfinished work back with `work_release` and a useful
handoff note.

Recommended session flow:

```text
workspace_resolve
  → work_list
  → work_start
  → spec_read and/or task_read
  → context_list / context_read for the explicit scope needed
  → work_complete or work_release
```

Resolve from the current repository path. Use one stable `agentId` for start, renewal, release, and
completion. Before a write that accepts `expectedRevision`, reread the bounded manifest and pass
its current revision.

An HTTP session may call `sync_status` once during orientation. The stdio connection intentionally
exposes only the domain tools, so it begins with `workspace_resolve`. Ordinary writes synchronize
automatically; do not call `sync_now` after each mutation.

## The model

```text
Workspace          a product, anchored to one filesystem root
└── Project        a bounded initiative
    └── Spec       the executable Markdown description of one deliverable
        └── Task   work derived from the Spec
            └── Subtask   one level, and no more
```

A ready Spec with no open Tasks is claimable directly. Once open Tasks exist, only leaf Tasks are
claimable. `doing` is derived from a live Claim and is never persisted.

## Rules an agent must respect

- Claim before editing. A Claim is an expiring lease, not a status field.
- Read only the Spec, Task, and Context explicitly in scope. List tools return manifests and
  bounded reads, never whole bodies.
- Never create a Project directly in `done`; call the completion operation.
- Never add Subtasks while the parent Task is claimed.
- Sync conflicts preserve both candidates. Explain them; never choose one autonomously.
- Never read or modify Pimpampum's SQLite database, token, receipts, snapshots, or host
  configuration directly.
- Errors carry stable codes. Do not flatten them or guess around a failed ownership check.

## Errors

| Code                | Meaning                           | Next action                                                                                                                                    |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`       | The local service did not answer. | Ask the operator to check Pimpampum's service status. Do not run `pimpampum install` yourself; the CLI suggestion is written for the operator. |
| `unauthorized`      | The local route was rejected.     | Ask the operator to repair the agent connection.                                                                                               |
| `revision_conflict` | Someone else wrote first.         | Reread and retry only if the change still applies.                                                                                             |
| `conflict`          | A Claim blocks the operation.     | Inspect the current Claim; do not take it over.                                                                                                |
| `invalid_state`     | A lifecycle rule refused.         | Inspect the Project, Spec, and Task states.                                                                                                    |
| `not_found`         | The resource is unknown.          | Resolve the Workspace again.                                                                                                                   |
| `bad_request`       | Input does not match the tool.    | Read the tool schema and correct the request.                                                                                                  |
| `payload_too_large` | The request body exceeds a bound. | Shorten the body or split the write; do not retry as is.                                                                                       |
| `internal_error`    | The daemon failed unexpectedly.   | Stop and report it to the operator; retry only if `retryable` is true.                                                                         |

## Reference

- Tool catalog and lifecycle rules: [`docs/mcp-tools.md`](mcp-tools.md). The live `tools/list`
  result is the authoritative schema.
- HTTP surface: the OpenAPI description served by the local daemon.
- Human installation, connection, and recovery: [`README.md`](../README.md).
