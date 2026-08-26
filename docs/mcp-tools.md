# MCP tools

Pimpampum exposes 24 agent-oriented tools through one local daemon. Tool discovery is the canonical contract: every tool declares a title, a precise description, a strict JSON Schema for its arguments, and MCP effect annotations.

## Connect

Streamable HTTP:

```text
POST http://127.0.0.1:7337/mcp
Authorization: Bearer <token>
```

For hosts that only support stdio, run `pimpampum-mcp` while the daemon is active. The bridge is stateless and forwards operations to the authenticated HTTP API.

## Shell-only agents

The CLI negotiates with this same MCP endpoint; it does not maintain a second tool implementation.
Use it when an agent can execute shell commands but cannot attach an MCP server directly:

```bash
pimpampum config
pimpampum tools
pimpampum call workspace_resolve --input '{"path":"/absolute/project/path"}'
```

`config` reports MCP HTTP and stdio connection details, plus a redacted `environment` or `file`
token source, without exposing the token value. `tools`
returns the live `tools/list` result. `call` accepts no input for zero-argument tools or exactly one
of `--input <json>`, `--stdin`, and `--input-file <path>`. The JSON root must be an object.

For multiline Markdown, prefer stdin:

```bash
printf '%s' '{
  "projectId": "PROJECT_ID",
  "prd": "# Updated PRD\n\nAgent-authored outcome.",
  "expectedRevision": 2,
  "actor": "agent-session-id"
}' | pimpampum call project_update_prd --stdin
```

The CLI emits the result contract below unchanged. Success goes to stdout with exit code 0;
failures go to stderr with a non-zero exit code. MCP SDK validation and transport failures are
normalized into the same actionable Pimpampum error shape.

## Result contract

Successful calls return one JSON text content block:

```json
{ "data": {} }
```

Failures set `isError: true` and return:

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

The text block is deliberately canonical. Pimpampum does not copy the same potentially large value into `structuredContent`, keeping context use predictable across MCP hosts.

List tools with an `offset` return:

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

Continue with `nextOffset` while `hasMore` is true. `work_list` has no offset because it is a live claimable-work queue; it returns `truncated` instead.

## Recommended workflow

```text
workspace_resolve
  → work_list
  → work_start
  → project_read_prd or task_read
  → context_list / context_read
  → work_complete
```

Use the same stable `agentId` for claim, renewal, release, and completion. Renew before `expiresAt`. Before any update or completion, read the lightweight manifest and pass its current `revision` as `expectedRevision`.

## Catalog

| Tool                     | Purpose                                                             | Key arguments                                               |
| ------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `workspace_list`         | List registered directory roots.                                    | None                                                        |
| `workspace_resolve`      | Resolve a current working directory to the most specific workspace. | `path` absolute                                             |
| `work_list`              | Discover ready projects and open leaf tasks.                        | `workspaceId?`, `limit`                                     |
| `work_start`             | Atomically claim work and receive bounded startup manifests.        | `targetType`, `targetId`, `agentId`, `leaseSeconds`         |
| `work_renew`             | Extend an unexpired owned claim.                                    | Same identity fields as start                               |
| `work_release`           | Release without completing and optionally leave a handoff note.     | Identity fields, `note?`                                    |
| `work_complete`          | Mark claimed work done with summary and artifact references.        | Identity fields, `expectedRevision`, `summary`, `artifacts` |
| `project_list`           | Page through lightweight projects in any lifecycle state.           | `workspaceId?`, `state?`, `limit`, `offset`                 |
| `project_get`            | Read one project plus independently paged task/context manifests.   | `projectId`, task/context limits and offsets                |
| `project_read_prd`       | Read a bounded PRD page.                                            | `projectId`, UTF-16 offset and limit                        |
| `project_completion_get` | Read completion summary and artifacts.                              | `projectId`                                                 |
| `project_create`         | Create a project and initial Markdown PRD.                          | `workspaceId`, `slug`, `title`, `prd`, `state`              |
| `project_update`         | Change title and/or draft/ready state.                              | `projectId`, changes, `expectedRevision`                    |
| `project_update_prd`     | Replace the complete PRD.                                           | `projectId`, `prd`, `expectedRevision`                      |
| `task_list`              | Page through task and subtask manifests.                            | `projectId`, `limit`, `offset`                              |
| `task_get`               | Read one lightweight task manifest.                                 | `taskId`                                                    |
| `task_read`              | Read a bounded task-body page.                                      | `taskId`, UTF-16 offset and limit                           |
| `task_completion_get`    | Read task completion summary and artifacts.                         | `taskId`                                                    |
| `task_create`            | Create a task or one-level subtask.                                 | `projectId`, `parentId?`, `title`, `body?`                  |
| `task_update`            | Change an open task title/body.                                     | `taskId`, changes, `expectedRevision`                       |
| `context_list`           | Page through context manifests without bodies.                      | `projectId`, `limit`, `offset`                              |
| `context_read`           | Read a bounded contextual Markdown page.                            | `projectId`, `name`, UTF-16 offset and limit                |
| `context_put`            | Create or replace one context document.                             | `projectId`, `name`, `body`, `expectedRevision?`            |
| `activity_list`          | Read latest automatic project events.                               | `projectId`, `limit`                                        |

## State and safety rules

- Projects are `draft → ready → done`; only `work_complete` reaches `done`.
- Tasks are `open → done`; subtasks cannot have children.
- A project with open tasks cannot complete.
- A task with open subtasks cannot complete.
- Once a project has open tasks, agents claim leaf tasks rather than the project.
- Writes use optimistic concurrency. On `revision_conflict`, reread and decide whether the intended change still applies.
- Tool annotations set `openWorldHint: false`: tools only access the configured local Pimpampum instance.
- No tool deletes projects, PRDs, context documents, tasks, or activity.

## Naming decision

Tool names do not repeat a `pimpampum_` prefix because clients already expose them under the Pimpampum server namespace. The shorter names reduce agent tokens while remaining unambiguous within the server.
