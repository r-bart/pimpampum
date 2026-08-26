# Pimpampum

**One local operational memory for all your projects and all your agents.**

Pimpampum is a minimal, agent-first project manager. A small daemon runs on your machine and coordinates PRDs, contextual documents, tasks, subtasks, and active work across every registered repository.

It is not trying to become Linear, Jira, or Basecamp. There are no sprints, priorities, estimates, labels, chat, or configurable workflows. Its job is smaller: give humans and agents a shared, deterministic source of truth that is easy to inspect and automate.

## Value proposition

Agents working from different repositories often lose context, duplicate effort, or rely on isolated files that nobody else can discover. Pimpampum solves that problem with one local instance:

- An agent can identify its project from its current working directory.
- It can read the relevant PRD and context without loading entire documents unnecessarily.
- It can discover available work and claim it atomically, avoiding collisions with other agents.
- It can complete work with a concise summary and durable artifact references.
- Another agent can resume the project later from any repository.
- Humans, scripts, and agents see the same state through CLI, HTTP, or MCP.

Data stays on the machine in SQLite. Intent and context remain readable Markdown; integration uses deterministic JSON.

## Principles

- **One instance, many projects.** The daemon is the source of truth for every registered directory.
- **Agent-first.** MCP exposes small, discoverable operations with bounded responses.
- **Local-first.** It only listens on loopback and has no cloud dependency.
- **Markdown for knowledge.** PRDs, context, and task bodies stay readable and portable.
- **JSON for coordination.** Every integration uses deterministic contracts.
- **Explicit concurrency.** Leased claims and optimistic revisions prevent agents from overwriting each other.
- **Zero bloat.** The model ends at project, PRD, context, task, and subtask.
- **No accidental deletion.** The first version exposes no destructive delete operations.

## Mental model

```text
Local instance
└── Workspace                      registered directory or repository
    └── Project / PRD              unit of intent and delivery
        ├── Context document       architecture, research, decisions…
        └── Task                   executable work
            └── Subtask            one optional level
```

Projects move through `draft → ready → done`. Tasks move through `open → done`.

A PRD without open tasks can be claimed directly. Once open tasks exist, agents work on leaf tasks. A project cannot complete while it has open tasks, and a task cannot complete while it has open subtasks.

## Architecture

```text
Agents in any repository
        │
        ├── MCP Streamable HTTP
        ├── MCP stdio bridge
        ├── HTTP + OpenAPI
        └── CLI
                │
          Pimpampum daemon
                │
        SQLite + Markdown/JSON export
```

The MCP stdio bridge is stateless: every operation reaches the same authenticated daemon. Codex, Claude, VCOMP, rdiaz racing, and any project under `100-projects` can therefore share one coordination service without creating a database per repository.

## Requirements

- Node.js 22 or newer.

## Quick start

### 1. Install and start automatically

```bash
npm install
npm run build
npm run build:macos # macOS source builds only
npm run cli -- install
```

A packaged installation exposes the same operation as `pimpampum install`. It installs one
per-user background service and starts the local daemon automatically—no root access or open
terminal is required. Inspect it with `pimpampum status` and remove Pimpampum-owned runtime
integrations with `pimpampum uninstall`.

Uninstall is deliberately narrow: it removes the managed service, desktop integration, and
receipt while it preserves the SQLite database, token, project content, diagnostic logs, backups,
and exports.

The daemon listens on:

```text
http://127.0.0.1:7337
```

On first start it creates:

```text
~/.pimpampum/
  pimpampum.sqlite
  token
  .instance.lock
```

To run only the foreground daemon during development:

```bash
npm run dev
```

### Native status surfaces

On macOS 13 or newer, `pimpampum install` copies the unsigned menu-bar-only app to
`~/Applications/PimpampumMenuBar.app`, registers it as a login item, and installs the daemon as a
LaunchAgent. If macOS reports `requiresApproval`, open the Pimpampum menu and select
**Open Login Items Settings**. Because this first local release is unsigned, macOS may require an
explicit first-open approval in Privacy & Security. The app has no Dock icon and exposes only
overview refresh, completed-group disclosure, and Finder reveal.

On Omarchy Quattro, the package includes the dedicated native Quickshell plugin under
`integrations/omarchy/pimpampum-status`. The same `pimpampum install` command detects `omarchy`
and `omarchy-shell`, preflights the Quattro build and shell IPC before writing, then installs the
systemd user service and widget as one receipt-owned transaction. It rescans and enables the widget
through official Omarchy commands without reading or editing `shell.json`. Before removal it uses
the pinned Quattro `listShellConfig` IPC method to capture only Pimpampum's exact bar section,
index, and inline settings; a partial failure restores that entry through `enablePlugin` and
`setBarWidget`, leaves unrelated layout entries untouched, and restores the exact prior systemd
enabled/running state. Other Linux desktops keep the plain systemd user service. `pimpampum status`
reports the widget as `enabled`, `disabled`, or `missing`.

The widget reads `pimpampum overview` through its installed absolute helper. Installation binds
that receipt-owned helper to the canonical Node, CLI, data-directory, host, and port configuration,
so custom local instances work without exposing or copying the bearer token. Repository
contributors can run `npm run validate:omarchy`; a release additionally requires
`npm run test:e2e:omarchy` on the exact target Quattro machine.

Diagnostic logs live under `~/.pimpampum/logs` by default. If an installation fails, fix the
reported platform prerequisite and rerun `pimpampum install`; reconciliation is idempotent.

### 2. Register an existing repository

In another terminal:

```bash
npm run cli -- workspace:add vcomp "VCOMP" /absolute/path/to/vcomp
npm run cli -- workspace:list
```

A workspace represents the root of a repository or related body of work. Nested directories resolve automatically to the most specific registered workspace.

### 3. Create a project with a PRD

```bash
npm run cli -- project:create \
  vcomp \
  authentication \
  "Authentication" \
  /absolute/path/to/prd.md
```

The response contains the project `id` and initial `revision`. Projects begin as drafts. Make the project available for work with:

```bash
npm run cli -- project:ready <project-id> 1
```

The second argument is the expected revision. If another actor changed the project, the operation returns `revision_conflict` instead of overwriting the newer state.

### 4. Add tasks or work directly from the PRD

Create a task:

```bash
npm run cli -- task:create <project-id> "Implement authentication"
```

Create a subtask:

```bash
npm run cli -- task:create <project-id> "Add end-to-end tests" <parent-task-id>
```

If the project has no open tasks, the project itself appears as claimable work. If tasks exist, only available leaf tasks are returned.

### 5. Claim and complete work

```bash
npm run cli -- work:list vcomp
npm run cli -- work:start task <task-id> codex-thread-123
npm run cli -- work:complete task <task-id> codex-thread-123 <revision> "Delivery complete"
```

Keep the same `agent-id` for the lifetime of a claim. Claims expire and can be renewed through MCP or HTTP. They can also be released without completing:

```bash
npm run cli -- work:release task <task-id> codex-thread-123 "Handoff for the next agent"
```

## Using Pimpampum from agents

The daemon exposes MCP Streamable HTTP at:

```text
POST http://127.0.0.1:7337/mcp
Authorization: Bearer <local-token>
```

The token lives at `~/.pimpampum/token` unless a different data directory is configured.

For clients that only support MCP over stdio:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pimpampum/dist/mcpStdio.js"]
}
```

Recommended agent flow:

```text
workspace_resolve
  → work_list
  → work_start
  → project_read_prd or task_read
  → context_list / context_read
  → work_complete
```

Example:

1. An agent starts inside `/100-projects/vcomp/packages/api`.
2. `workspace_resolve` identifies the `vcomp` workspace.
3. `work_list` returns available projects or leaf tasks.
4. `work_start` claims one unit and returns lightweight startup manifests.
5. The agent reads only the required PRD, task, and context pages.
6. `work_complete` records the outcome and artifact references.

Available tools:

```text
workspace_list       workspace_resolve
work_list            work_start
work_renew           work_release          work_complete
project_list         project_get           project_read_prd
project_create       project_update        project_update_prd
project_completion_get
task_list            task_get              task_read
task_create          task_update           task_completion_get
context_list         context_read          context_put
activity_list
```

The complete tool contract, including arguments, effects, pagination, and errors, is documented in [docs/mcp-tools.md](docs/mcp-tools.md). The same metadata is available dynamically through MCP `tools/list`.

### MCP responses

Each call returns one text content block containing JSON:

```json
{
  "data": {}
}
```

Failures are actionable:

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

Paginated list tools return `items`, `hasMore`, and `nextOffset`. Markdown is read in bounded UTF-16 code-unit pages so agent context usage remains predictable.

## Using the HTTP API

Every `/api/v1` and `/mcp` request requires:

```http
Authorization: Bearer <local-token>
```

Example:

```bash
curl \
  -H "Authorization: Bearer $(tr -d '\n' < ~/.pimpampum/token)" \
  http://127.0.0.1:7337/api/v1/workspaces
```

The complete OpenAPI 3.1 contract is public on loopback:

```text
GET http://127.0.0.1:7337/openapi.json
```

It can be imported directly into Scalar, Swagger UI, Bruno, Postman, or any OpenAPI-compatible generator.

Successful responses use a versioned envelope:

```json
{
  "data": {},
  "meta": {
    "schemaVersion": 1
  }
}
```

Errors indicate whether retrying may help:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "Expected revision 3, current revision is 4",
    "retryable": true,
    "details": {}
  }
}
```

Main API areas:

| Area           | Operations                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| Workspaces     | Register, list, and resolve directories                                    |
| Projects       | Create, inspect, and update projects, manifests, PRDs, and completion data |
| Context        | Create, replace, list, and read contextual Markdown                        |
| Tasks          | Create, inspect, and update tasks and subtasks                             |
| Work           | Discover, claim, renew, release, and complete work                         |
| Activity       | Read bounded automatic activity                                            |
| Administration | Create SQLite backups and portable exports                                 |
| MCP            | Use the Streamable HTTP transport                                          |

`/health` and `/openapi.json` are the only unauthenticated routes.

## CLI reference

During development, use `npm run cli -- <command>`. A compiled installation exposes `pimpampum <command>`.

```text
pimpampum serve
pimpampum health
pimpampum workspace:list
pimpampum workspace:add <id> <name> <root-path>
pimpampum work:list [workspace-id]
pimpampum work:start <project|task> <id> <agent-id>
pimpampum work:release <project|task> <id> <agent-id> [note]
pimpampum work:complete <project|task> <id> <agent-id> <revision> <summary>
pimpampum project:create <workspace-id> <slug> <title> [prd-file]
pimpampum project:get <project-id>
pimpampum project:ready <project-id> <revision>
pimpampum task:create <project-id> <title> [parent-id]
pimpampum backup <directory>
pimpampum export <directory>
```

The CLI covers common human operations. MCP and HTTP expose the complete contract.

## Persistence, backup, and export

The live database must remain in Pimpampum's local data directory. **Do not place the active SQLite database in Dropbox, Google Drive, or iCloud.**

Backups and exports may be written to synchronized folders:

```bash
npm run cli -- backup /path/to/Dropbox/pimpampum-backups
npm run cli -- export /path/to/iCloud/pimpampum-exports
```

- Backups are immutable SQLite snapshots verified with an integrity check.
- Exports contain portable JSON metadata plus PRDs, context, and tasks as Markdown.
- Export is rejected while active claims exist and runs synchronously.
- The bearer token is not stored inside the SQLite backup.

### Restoring a backup

1. Stop the daemon.
2. Preserve the `token` file and keep the failed database separately for possible recovery.
3. Copy the selected snapshot to the configured `pimpampum.sqlite` path.
4. Do not copy stale `-wal` or `-shm` files.
5. Keep permissions private, start the daemon, and verify `GET /health` plus a representative project read.

## Configuration

| Variable             | Default                 | Purpose                |
| -------------------- | ----------------------- | ---------------------- |
| `PIMPAMPUM_DATA_DIR` | `~/.pimpampum`          | Private data directory |
| `PIMPAMPUM_HOST`     | `127.0.0.1`             | Loopback host          |
| `PIMPAMPUM_PORT`     | `7337`                  | Daemon port            |
| `PIMPAMPUM_TOKEN`    | Generated automatically | Local bearer token     |

The host must be `127.0.0.1`, `localhost`, or `::1`. A manually configured token must contain at least 32 printable ASCII characters without spaces.

Only one daemon may own a data directory. The instance lock prevents a second process—even on a different port—from coordinating against the same database.

## Deliberate omissions

Pimpampum intentionally does not include:

- Sprints, milestones, or roadmaps.
- Priorities, estimates, points, or labels.
- Users, teams, roles, or remote permissions.
- Comments, chat, notifications, or social feeds.
- Configurable automations.
- Arbitrary task dependencies.
- More than one level of subtasks.
- Cloud synchronization of the live database.
- A web interface in the first version.

These omissions are part of the product. They keep the contract small, understandable, and stable for agents.

## Development and quality

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:evals
npm run build
```

`npm test` builds from a clean `dist/`, enforces 100% statement, branch, function, and line coverage, and exercises the compiled daemon, CLI, and MCP stdio bridge.

`npm run test:evals` is the small deterministic agent-workflow evaluation suite. It runs the compiled product at its real CLI, HTTP, and MCP boundaries. Its score is binary: all seven workflows must pass without mocks or partial credit. The complete rubric is documented in [docs/evals.md](docs/evals.md).

The evaluation suite covers seven real scenarios:

1. Workspace → project/PRD → task → claim → completion → portable export.
2. PRD and contextual Markdown reads and updates through MCP.
3. Parent/subtask ordering, competing agents, idempotent claims, and artifact recovery.
4. HTTP authentication, optimistic revision conflicts, and the deliberate no-delete boundary.
5. Persistence across daemon restart and rejection of a second instance owner.
6. Real SQLite backup, restore, and subsequent portable export.
7. Per-user service install, status, repeat-install reconciliation, uninstall, and data preservation.

## Status

Pimpampum is at `0.1.0`: a functional, deliberately small local-first release. The next product criterion is not how many features can be added, but whether each addition clearly improves agent coordination without eroding simplicity.

## License

MIT. See [LICENSE](LICENSE).
