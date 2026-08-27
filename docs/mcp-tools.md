# MCP tools

Pimpampum exposes 32 domain tools plus four synchronization tools through one local daemon. MCP `tools/list` is the
canonical machine-readable contract: every tool declares a title, precise description, strict JSON
Schema, defaults, bounds, and effect annotations.

## Connect

Streamable HTTP:

```text
POST http://127.0.0.1:7337/mcp
Authorization: Bearer <token>
```

For hosts that only support stdio, run `pimpampum-mcp` while the daemon is active. The bridge is
stateless and forwards every operation to the same authenticated instance.

## Shell-only agents

The CLI negotiates with the MCP endpoint; it does not maintain a second tool implementation:

```bash
pimpampum config
pimpampum tools
pimpampum call workspace_resolve --input '{"path":"/absolute/project/path"}'
```

`config` reports redacted connection details without exposing the token. `tools` returns the live
catalog. `call` accepts no input for zero-argument tools or exactly one of `--input <json>`,
`--stdin`, and `--input-file <path>`. The JSON root must be an object.

For multiline Markdown, prefer stdin:

```bash
printf '%s' '{
  "projectId": "PROJECT_ID",
  "slug": "agent-cli",
  "title": "Agent-first CLI",
  "body": "# Contract\n\nExpose the complete MCP surface.",
  "actor": "agent-session-id"
}' | pimpampum call spec_create --stdin
```

Success is written to stdout with exit code 0. Failures are written to stderr with a non-zero exit
code. Every invocation opens and closes one short-lived MCP session.

## Result contract

A successful tool returns one JSON text content block:

```json
{ "data": {} }
```

A failure sets `isError: true` and returns one actionable envelope:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "Expected revision 3, current revision is 4",
    "retryable": true,
    "details": {},
    "suggestion": "Read the latest manifest, then retry with its current revision."
  }
}
```

Pimpampum does not duplicate large values into `structuredContent`, keeping context use predictable
across MCP hosts.

Paginated tools return:

```json
{
  "data": {
    "items": [],
    "page": {
      "limit": 50,
      "offset": 0,
      "returned": 0,
      "hasMore": false,
      "nextOffset": null
    }
  }
}
```

Continue from `nextOffset` while `hasMore` is true. `work_list` is a live queue and therefore uses
`truncated` rather than an offset.

## Recommended agent workflow

```text
sync_status
  → workspace_resolve
  → work_list
  → work_start
  → spec_read and/or task_read
  → context_list / context_read for an explicit scope
  → work_complete or work_release
```

Use one stable `agentId` for Claim start, renewal, release, and completion. Renew before
`expiresAt`. Before an update, cancellation, or completion, read the bounded manifest and pass its
current `revision` as `expectedRevision`.

If synchronization is configured, call `sync_status` once during session orientation. Ordinary
domain writes are exported automatically, so do not call `sync_now` after every write. A temporarily
unavailable shared folder never invalidates local committed work. Never read, edit, rename, or delete
snapshot files directly, and never configure, pause, resume, or forget synchronization unless the
user explicitly asks for that administrative change.

## Canonical catalog

### Synchronization

| Tool                 | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `sync_status`        | Read health, pending work, and conflict count during orientation. |
| `sync_now`           | Reconcile immediately when the user requests a machine handoff.   |
| `sync_conflict_list` | List conflicts without choosing a winner.                         |
| `sync_conflict_read` | Read one preserved pair of conflicting entity candidates.         |

Conflicts do not select a timestamp winner. Continue only unrelated work and explain the conflict
to the user. These tools deliberately cannot select folders, pause processing, or resolve a
candidate autonomously.

### Workspace

| Tool                | Purpose                                                           | Key arguments   |
| ------------------- | ----------------------------------------------------------------- | --------------- |
| `workspace_list`    | List registered repository and directory roots.                   | None            |
| `workspace_resolve` | Resolve a working directory to the most specific registered root. | `path` absolute |

Workspace registration is an administrative CLI or HTTP operation. Agents normally resolve an
already registered repository.

### Project

| Tool                     | Purpose                                                          | Key arguments                                            |
| ------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `project_list`           | Page through bounded Project manifests.                          | `workspaceId?`, `state?`, `limit`, `offset`              |
| `project_get`            | Read one bounded Project manifest and Spec rollups.              | `projectId`                                              |
| `project_create`         | Create a draft Project container.                                | `workspaceId`, `slug`, `title`, `actor?`                 |
| `project_update`         | Change title or reversible `draft/open/paused` state.            | `projectId`, changes, `expectedRevision`, `actor?`       |
| `project_complete`       | Mark a Project done after all Specs are terminal.                | `projectId`, `expectedRevision`, `summary`, `artifacts?` |
| `project_cancel`         | Cancel a Project tree and release descendant Claims atomically.  | `projectId`, `expectedRevision`, `reason`, `actor?`      |
| `project_completion_get` | Read Project completion summary, artifacts, and completion time. | `projectId`                                              |

A Project groups an initiative. It has no executable Markdown body and is never claimable.

### Spec

| Tool                  | Purpose                                                        | Key arguments                                    |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `spec_list`           | Page through bounded Spec manifests in one Project.            | `projectId`, `state?`, `limit`, `offset`         |
| `spec_get`            | Read one bounded Spec manifest and Task rollups.               | `specId`                                         |
| `spec_read`           | Read a bounded page of Spec Markdown.                          | `specId`, UTF-16 offset and limit                |
| `spec_create`         | Create a draft Spec inside a Project.                          | `projectId`, `slug`, `title`, `body?`, `actor?`  |
| `spec_update`         | Replace title, complete body, or reversible draft/ready state. | `specId`, changes, `expectedRevision`, `actor?`  |
| `spec_completion_get` | Read Spec completion summary, artifacts, and completion time.  | `specId`                                         |
| `spec_cancel`         | Cancel a Spec tree and release descendant Claims atomically.   | `specId`, `expectedRevision`, `reason`, `actor?` |

A PRD is one possible form of Spec Markdown, not a separate entity or API family.

### Task and Subtask

| Tool                  | Purpose                                                       | Key arguments                                     |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| `task_list`           | Page through bounded Task and Subtask manifests for one Spec. | `specId`, `limit`, `offset`                       |
| `task_get`            | Read one bounded Task manifest.                               | `taskId`                                          |
| `task_read`           | Read a bounded page of Task Markdown.                         | `taskId`, UTF-16 offset and limit                 |
| `task_create`         | Create a Task or one-level Subtask.                           | `specId`, `parentId?`, `title`, `body?`, `actor?` |
| `task_update`         | Replace an open Task title or complete body.                  | `taskId`, changes, `expectedRevision`, `actor?`   |
| `task_completion_get` | Read Task completion summary, artifacts, and completion time. | `taskId`                                          |
| `task_cancel`         | Cancel a Task tree and release affected Claims atomically.    | `taskId`, `expectedRevision`, `reason`, `actor?`  |

Tasks always belong to Specs. A Subtask must share its parent's Spec and cannot have children.

### Context and activity

| Tool            | Purpose                                                             | Key arguments                                                         |
| --------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `context_list`  | Page Context manifests for one explicit Workspace or Project scope. | `ownerType`, `ownerId`, `limit`, `offset`                             |
| `context_read`  | Read bounded Context Markdown from one explicit scope.              | `ownerType`, `ownerId`, `name`, UTF-16 offset and limit               |
| `context_put`   | Create or replace Context in one explicit scope.                    | `ownerType`, `ownerId`, `name`, `body`, `expectedRevision?`, `actor?` |
| `activity_list` | Read bounded automatic activity for a Project and its descendants.  | `projectId`, `limit`                                                  |

Context never inherits implicitly. The same name can exist independently in a Workspace and one of
its Projects; callers choose the scope they mean.

### Work and Claims

| Tool            | Purpose                                                          | Key arguments                                                |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `work_list`     | Discover ready Specs and open leaf Tasks beneath open Projects.  | `workspaceId?`, `projectId?`, `specId?`, `limit`             |
| `work_start`    | Atomically claim work and receive bounded startup manifests.     | `targetType`, `targetId`, `agentId`, `leaseSeconds`          |
| `work_renew`    | Extend an unexpired Claim owned by the same agent.               | Same identity fields as start                                |
| `work_release`  | Release without completing and optionally record a handoff note. | Identity fields, `note?`                                     |
| `work_complete` | Complete claimed work with summary and artifact references.      | Identity fields, `expectedRevision`, `summary`, `artifacts?` |

`targetType` is exactly `spec | task`. A startup bundle contains the Workspace, Project, Spec,
optional Task, Claim, and separate bounded Workspace- and Project-Context manifest pages.

## Lifecycle and safety

- Projects use `draft | open | paused | done | cancelled`.
- Specs use `draft | ready | done | cancelled`.
- Tasks and Subtasks use `open | done | cancelled`.
- A Project must contain a Spec before opening.
- A Spec needs non-blank Markdown before becoming ready.
- Only ready Specs and open leaf Tasks beneath open Projects are claimable.
- An open Task with open Subtasks cannot complete.
- A Spec with open Tasks cannot complete.
- A Project completes without a Claim only after every Spec is terminal.
- Cancellation is terminal, preserves history, cascades to non-terminal descendants, and releases
  affected Claims in one transaction.
- Writes use optimistic revisions. On `revision_conflict`, reread and decide whether the intended
  change still applies.
- Tool annotations set `openWorldHint: false`: tools only access the configured local instance.
- There are no delete tools.

## Naming decision

Tool names omit a `pimpampum_` prefix because MCP clients already expose them under the Pimpampum
server namespace. Shorter names save tokens without introducing aliases. The catalog is replaced
atomically when the domain changes; agents never need to guess whether two names mean the same
operation.
