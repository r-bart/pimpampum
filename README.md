# Pimpampum

![Pimpampum — Agent-first project management. Absurdly simple.](branding/assets/readme_cover.png)

**Project management for people who are already the whole company.**

Pimpampum is an ultra-minimal, agent-first project manager for solopreneurs running a portfolio of
products. One tiny local service gives every repository and every agent the same operational
memory: initiatives, specs, context, tasks, active work, and what happened next.

No sprint planning. No backlog-grooming ceremony. No mandatory discussion about whether a task
feels more like a three or a five today. You are already in enough meetings with yourself.

## One small control room for your product portfolio

Your products may live in different repositories. Your agents may come from different vendors.
Your brain may occasionally decline to remember what happened three Tuesdays ago. Pimpampum gives
all of them one deterministic source of truth without asking you to move your work into another
cloud dashboard.

An agent working inside any registered repository can:

- Resolve the current product from its working directory.
- Read only the executable Spec and contextual pages it needs.
- Discover available work and claim it atomically before touching code.
- Complete or release work with a durable summary and artifact references.
- Leave the initiative ready for whichever agent—or human—turns up next.

Humans, scripts, and agents see the same state through MCP, CLI, or HTTP. Data stays local in
SQLite. Product intent stays readable in Markdown. Integrations speak deterministic JSON. Boring
formats are excellent colleagues.

## The useful bits

| You need to…                                    | Pimpampum gives you…                                      | Use…                                         |
| ----------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| See the state of every product                  | One portfolio overview and native status indicator        | `pimpampum overview` or the desktop menu     |
| Preserve product intent                         | Specs and scoped Context documents in Markdown            | `spec_read`, `context_list`, `context_read`  |
| Break work down, but not into dust              | Tasks and one optional level of Subtasks                  | `task_create`, `task_list`, `task_read`      |
| Stop agents doing the same job twice            | Atomic, expiring Claims                                   | `work_list`, `work_start`, `work_renew`      |
| Hand work to the next agent                     | Completion summaries, releases, and artifact references   | `work_complete` or `work_release`            |
| Use whichever agent you like                    | MCP, a JSON-first CLI, and a documented local API         | `pimpampum tools`, `pimpampum call`, OpenAPI |
| Work on the same portfolio on several computers | Immutable JSON snapshots through any shared folder        | **Settings…** or `pimpampum sync configure`  |
| Keep a recovery copy                            | Automatic SQLite backup to a local or synchronized folder | `pimpampum backup configure`                 |

## Install and connect

Pimpampum ships the private service and agent connection it needs. The normal setup does not ask
you to install Node.js, open Terminal, copy a token, or edit an MCP configuration file.

### macOS — download the app

1. Download `PimpampumMenuBar-<version>-macos-arm64.zip` from
   [GitHub Releases](https://github.com/r-bart/pimpampum/releases), expand it, and open
   **PimpampumMenuBar**. Published builds are signed, notarized, and support Apple Silicon Macs
   running macOS 13 or newer.
2. Choose **Continue**. Pimpampum detects Codex and Claude Code locally and selects the supported
   agents it found.
3. Review the exact changes, adjust the selection if needed, then choose **Review & set up**. This
   is the one confirmation that installs and verifies the private service, enables start at
   sign-in, and connects the selected agents.
4. If macOS asks for Login Items approval, use **Open Login Items Settings**, approve Pimpampum,
   and return to the setup view. Setup progress is durable, so closing and reopening the menu does
   not corrupt it.
5. When an agent says **New session required**, open a new Codex or Claude Code session. Existing
   sessions may not reload newly connected tools.

The service keeps running when the menu app closes. It stays private to your account and keeps its
database on this Mac.

### Omarchy Quattro — install the plugin

Install and enable the Pimpampum Status plugin through Omarchy's supported plugin flow:

```bash
omarchy plugin add https://github.com/r-bart/pimpampum-omarchy.git --enable --yes
```

Open its widget, choose **Get started**, review the detected agents, and choose **Connect selected
agents**. The plugin downloads the exact pinned runtime for the current Linux architecture,
verifies it, and installs the `systemd --user` service without a separate Node.js or npm
installation. Start a new agent session whenever the completed card requests one. Do not copy the
plugin directory or edit Quickshell configuration by hand.

### Manage agent connections

On macOS, open **Settings… → Agents**. On Omarchy, open **Settings → Agents** in the Pimpampum
popout. The service, Codex, and Claude Code are reported independently, and only actions valid for
the current state are shown:

- **Connect** adds that agent after confirmation; **Test** verifies it without changing it.
- **Repair** reconciles a Pimpampum-managed connection; **Open** launches the installed agent.
- **Disconnect** removes only the selected agent connection. The daemon, other agents, and all
  local data remain in place.
- **Advanced** on macOS shows the stable launcher path, stdio transport, last verification, and
  tokenless manual guidance when an administrator needs the underlying details.

If an existing entry named `pimpampum` is different, setup stops before changing it. Review the
redacted comparison and choose **Keep existing**, **Replace**, or **Cancel**. Replacement is a
separate decision and applies only to the reviewed entry. A partial failure leaves verified agents
connected and offers **Try again** for the one that failed.

Updates are available under **Settings… → Updates** on macOS and **Settings → Updates** on
Omarchy. **Check for updates** is read-only; **Install update** verifies and reconciles the packaged
runtime, service, and managed connections while preserving local data. See
[Advanced lifecycle commands](#advanced-lifecycle-commands) for non-graphical repair, update, and
removal.

## The deliberately small model

```text
Local instance
└── Workspace                      product or registered repository
    ├── Context document           workspace-wide durable knowledge
    └── Project                    bounded initiative or outcome
        ├── Context document       knowledge shared by its Specs
        └── Spec                   executable Markdown specification
            └── Task               executable work derived from the Spec
                └── Subtask        one optional level
```

### Domain language

| Term                   | Definition                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local instance**     | The single Pimpampum daemon and database on one machine. Every registered Workspace and connected agent shares it.                                                           |
| **Workspace**          | A product or body of work anchored to one filesystem root, such as Pimpampum. It owns Projects and Workspace-wide Context.                                                   |
| **Project**            | A bounded initiative or outcome inside a Workspace. It groups one or more related Specs and shared Context. It is a container, not a directly executable job.                |
| **Spec**               | The canonical Markdown description of one deliverable. It may describe a feature, requirement, bug, refactor, migration, research effort, or something equally inconvenient. |
| **PRD**                | A product-requirements form of a Spec. Useful product language, but not a separate Pimpampum entity.                                                                         |
| **Context document**   | Supplementary Markdown scoped explicitly to a Workspace or Project: architecture, research, conventions, decisions, brand, and similar durable knowledge.                    |
| **Task**               | A concrete unit of work owned by one Spec. When it has open Subtasks, agents work on those leaves first.                                                                     |
| **Subtask**            | A child Task used to split larger work. Pimpampum permits one Subtask level and no recursive project-management fan fiction.                                                 |
| **Claim**              | An expiring lease that reserves one executable Spec or leaf Task for one agent.                                                                                              |
| **Doing**              | A derived status shown while a valid Claim exists. It is never persisted as a lifecycle state.                                                                               |
| **Completion summary** | A concise, durable record of what changed when work finishes.                                                                                                                |
| **Artifact reference** | A durable URI pointing to an output such as a commit, file, report, pull request, or build.                                                                                  |
| **Revision**           | A monotonically increasing version used to detect concurrent edits before anything is overwritten.                                                                           |

The relationships are strict: a Workspace has many Projects, a Project has many Specs, and a Spec
has many Tasks. Every Task belongs to exactly one Spec. Every Subtask belongs to exactly one
top-level Task in that same Spec.

Projects move through `draft | open | paused | done | cancelled`. Specs use
`draft | ready | done | cancelled`. Tasks and Subtasks use `open | done | cancelled`. A ready Spec
without open Tasks can be claimed directly; once open Tasks exist, only leaf Tasks are claimable.
`doing` appears only when a live Claim exists. Terminal records and activity remain available, so
“cancelled” never quietly means “we deleted the evidence.”

## Architecture

```text
Agents in any registered repository
        │
        ├── MCP Streamable HTTP
        ├── MCP stdio bridge
        ├── HTTP + OpenAPI 3.1
        └── JSON-first CLI
                │
          one local daemon
                │
        SQLite + Markdown/JSON export
```

The MCP stdio bridge is stateless: every operation reaches the same authenticated daemon. Every
agent and every repository on one machine share that single coordination service, instead of each
one growing a tiny lonely database of its own.

## A complete first workflow

### 1. Register a repository

```bash
pimpampum workspace:add storefront "Storefront" /absolute/path/to/storefront
pimpampum workspace:list
```

Nested directories resolve to the most specific registered Workspace.

### 2. Create the initiative and its first Spec

```bash
pimpampum project:create storefront authentication "Authentication"

pimpampum spec:create \
  <project-id> \
  passwordless-login \
  "Passwordless login" \
  /absolute/path/to/spec.md
```

Both begin as drafts. A Project needs at least one Spec before opening. A Spec needs non-blank
Markdown before becoming ready:

```bash
pimpampum project:open <project-id> <project-revision>
pimpampum spec:ready <spec-id> <spec-revision>
```

Expected revisions make a stale writer fail with `revision_conflict` instead of politely erasing
newer work.

### 3. Add Tasks only when they help

```bash
pimpampum task:create <spec-id> "Implement authentication"
pimpampum task:create <spec-id> "Add end-to-end tests" <parent-task-id>
```

No Tasks are required. A ready Spec with no open Tasks is executable work itself. If Tasks exist,
agents claim available leaves.

### 4. Claim and finish work

```bash
pimpampum work:list storefront <project-id> <spec-id>
pimpampum work:start task <task-id> codex-thread-123
pimpampum work:renew task <task-id> codex-thread-123
pimpampum work:complete task <task-id> codex-thread-123 <revision> "Delivery complete"
```

Use the same stable agent ID for the Claim lifetime. Release unfinished work with a handoff note:

```bash
pimpampum work:release task <task-id> codex-thread-123 "Tests remain for the next agent"
```

After every Task is terminal, claim and complete the Spec. When every Spec is terminal, complete
the Project without a Claim:

```bash
pimpampum work:start spec <spec-id> codex-thread-123
pimpampum work:complete spec <spec-id> codex-thread-123 <revision> "Spec delivered"
pimpampum project:complete <project-id> <revision> "Initiative delivered"
```

Projects may also be paused and reopened. Cancelling a Project, Spec, or Task atomically cancels
its non-terminal descendants and releases their Claims while preserving history.

## Using Pimpampum from agents

After Guided setup connects an agent, start a new agent session if requested. The short contract in
[docs/agents.md](docs/agents.md) begins at that point: resolve the current Workspace, claim work,
and leave a durable result. Give an agent that file, or this brief:

```text
Use Pimpampum as the shared project memory.
Resolve the current Workspace, list available work, and claim exactly one Spec or leaf Task before editing.
Read only the relevant Spec, Task, and explicitly scoped Context documents.
When finished, complete or release the Claim with a concise summary and artifact references.
```

If the Pimpampum tools are absent, do not hand the agent a token or ask it to edit host settings.
Open Pimpampum's **Agents** settings, use **Connect**, **Test**, or **Repair**, then start a new
agent session.

### MCP

Guided setup registers the tokenless local route for Codex and Claude Code and verifies its tool
catalog. Nothing in the normal path requires an MCP URL or configuration fragment. The details
below are for administrators and hosts without a supported connector.

Streamable HTTP:

```text
POST http://127.0.0.1:7337/mcp
Authorization: Bearer <local-token>
```

For an unsupported MCP host that only supports stdio, use the stable absolute launcher shown under
**Settings… → Agents → Advanced**. Its equivalent shape is:

```json
{
  "mcpServers": {
    "pimpampum": { "command": "/absolute/path/to/pimpampum-mcp", "args": [] }
  }
}
```

The stdio bridge resolves its own credentials from the local data directory, so the agent never
handles a token. Run `pimpampum connect --instructions` for bounded, tokenless manual guidance
matched to the installed runtime.

`pimpampum mcp` starts the same bridge through the main binary. That is the route MCP registry
clients use (`npx pimpampum mcp`), because `npx pimpampum` alone resolves to the CLI. Both routes
resolve the local token themselves.

Recommended flow:

```text
workspace_resolve
  → work_list
  → work_start
  → spec_read and/or task_read
  → context_list / context_read for the explicit scope needed
  → work_complete or work_release
```

The canonical catalog holds 32 domain tools:

```text
workspace_list          workspace_resolve

project_list            project_get             project_create
project_update          project_complete        project_cancel
project_completion_get

spec_list               spec_get                spec_read
spec_create             spec_update             spec_completion_get
spec_cancel

task_list               task_get                task_read
task_create             task_update             task_completion_get
task_cancel

context_list            context_read            context_put
activity_list

work_list               work_start              work_renew
work_release            work_complete
```

The daemon adds four synchronization tools, so `tools/list` returns 36 over HTTP:

```text
sync_status             sync_now
sync_conflict_list      sync_conflict_read
```

The stdio bridge exposes the 32 domain tools only. A stdio session starts at `workspace_resolve`;
`sync_status` is available to HTTP clients alone.

No transitional aliases are exposed. The live MCP `tools/list` result is authoritative and
includes strict schemas, defaults, descriptions, bounds, and effect annotations. The full human
reference is [docs/mcp-tools.md](docs/mcp-tools.md).

### Agent-first CLI

MCP through Guided setup is preferred. A shell-only agent or administrator can still inspect and
call the exact same contract without hard-coding HTTP routes:

```bash
pimpampum status
pimpampum commands
pimpampum config
pimpampum tools
pimpampum call workspace_resolve --input '{"path":"/absolute/project/path"}'
```

`pimpampum commands` describes the CLI to itself: every verb with its arguments, its options, its
usage line, and the same effect annotations MCP tools carry (`readOnlyHint`, `destructiveHint`,
`idempotentHint`) plus `requiresDaemon`. `--help`, `-h`, `--version`, and `-v` all work and exit 0.

`config` works while offline and reports the effective data directory, base URL, redacted token
source, MCP URL, and stdio command. It never prints the bearer token.

Call a tool with inline JSON, standard input, or a UTF-8 file:

```bash
pimpampum call workspace_list

pimpampum call work_list \
  --input '{"workspaceId":"storefront","projectId":null,"specId":null,"limit":20}'

printf '%s' '{
  "projectId": "PROJECT_ID",
  "slug": "agent-cli",
  "title": "Agent-first CLI",
  "body": "# Contract\n\nExpose the complete MCP surface.",
  "actor": "codex-thread-123"
}' | pimpampum call spec_create --stdin

pimpampum call work_complete --input-file ./complete-work.json
```

Choose exactly one input source: `--input`, `--stdin`, or `--input-file`. Calls accept JSON objects
up to 2,000,000 UTF-8 bytes.

Every Pimpampum command writes one `{ "data": ... }` envelope to stdout and exits 0, or one
actionable `{ "error": ... }` envelope to stderr and exits non-zero. `help` is the single exception:
it prints the text banner. Errors carry a stable `code`, a `retryable` boolean, and a `suggestion`.
When the daemon does not answer, the code is `unavailable` and the suggestion names the recovery
command, so an agent never has to guess whether the failure is transport or domain.

### Advanced lifecycle commands

These commands are the non-graphical alternative to Guided setup and native Settings. Mutations
require explicit confirmation and use the same receipt ownership, verification, rollback, and
redaction boundaries:

```bash
pimpampum setup plan --connector codex --connector claude-code
pimpampum setup apply <operation-id> <revision> --yes
pimpampum setup status
pimpampum setup resume

pimpampum connections
pimpampum connect codex --yes
pimpampum connect claude-code --yes
pimpampum repair codex --yes
pimpampum disconnect codex --yes
pimpampum connect --instructions

pimpampum update:check
pimpampum update
pimpampum uninstall
```

`setup plan` does not change the service or agent settings; it stores a bounded reviewed plan and
returns the operation ID, exact revision, detected agents, and any conflict. Apply only that
reviewed revision. A conflict remains a no-op unless the operator reviews it and repeats
`setup apply` with `--replace <connector>` or uses `--replace` on the individual connect/repair
command. `disconnect` removes only a receipt-proven connection. `uninstall` removes
Pimpampum-owned service, runtime, native integration, and proven connector entries while preserving
the database, token, logs, backups, exports, and synchronized snapshots. If ownership cannot be
proved, it leaves the entry unchanged and returns manual guidance.

## HTTP and OpenAPI

Every `/api/v1` and `/mcp` request requires:

```http
Authorization: Bearer <local-token>
```

The token lives at `~/.pimpampum/token` unless another data directory is configured.

```bash
curl \
  -H "Authorization: Bearer $(tr -d '\n' < ~/.pimpampum/token)" \
  http://127.0.0.1:7337/api/v1/workspaces
```

The public loopback OpenAPI 3.1 document is available at:

```text
GET http://127.0.0.1:7337/openapi.json
```

It documents all Workspace, Project, Spec, Task, scoped Context, work, activity, portfolio
overview, synchronization, backup, and export operations. `/health` and `/openapi.json` are the
only unauthenticated routes. Ordinary success envelopes use HTTP schema version 1; the
independently versioned portfolio overview uses schema version 2 because the macOS and Omarchy
clients validate it strictly.

Domain Model v2 deliberately keeps the pre-release `/api/v1` route prefix. The version of the
resource model and the URL prefix are separate boundaries. A minimal HTTP creation flow is:

```bash
TOKEN="$(tr -d '\n' < ~/.pimpampum/token)"

curl -X POST http://127.0.0.1:7337/api/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"storefront","slug":"authentication","title":"Authentication","actor":"human"}'

curl -X POST http://127.0.0.1:7337/api/v1/projects/PROJECT_ID/specs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"passwordless-login","title":"Passwordless login","body":"# Passwordless login","actor":"human"}'
```

Use `PATCH /api/v1/projects/{projectId}` and `PATCH /api/v1/specs/{specId}` with
`expectedRevision` for reversible lifecycle changes. Executable work is listed at
`GET /api/v1/work` and Claims accept only `spec` or `task`. Refer to `/openapi.json` for exact
request and response schemas rather than reproducing them in an agent prompt.

## CLI reference

Generated by `pimpampum help`. `pimpampum commands` returns the same catalog as JSON, with
per-argument descriptions and effect annotations.

```text
Pimpampum 1.2.3

Every command writes one {"data": ...} envelope to stdout and exits 0, or one
{"error": ...} envelope to stderr and exits non-zero. The only
exceptions are `help`, which prints this text, and `mcp`, whose stdout carries
the MCP protocol. Run `pimpampum commands` for the same catalog as JSON, and
`pimpampum tools` for the domain tool schemas.

Use `--` to end option parsing when a value itself begins with two dashes.

Usage:
  pimpampum help
  pimpampum version
  pimpampum commands
  pimpampum config
  pimpampum serve
  pimpampum mcp
  pimpampum install [--service-only]
  pimpampum status
  pimpampum setup plan [--connector <codex|claude-code>]...
  pimpampum setup apply <operation-id> <revision> --yes [--replace <codex|claude-code>]...
  pimpampum setup status
  pimpampum setup resume
  pimpampum connections
  pimpampum connect [codex|claude-code] [--yes] [--replace] [--instructions]
  pimpampum repair <codex|claude-code> --yes [--replace]
  pimpampum disconnect <codex|claude-code> --yes
  pimpampum update:check
  pimpampum update
  pimpampum uninstall
  pimpampum health
  pimpampum overview
  pimpampum tools
  pimpampum call <tool-name> [--input <json>] [--stdin] [--input-file <path>]
  pimpampum workspace:list
  pimpampum workspace:add <workspace-id> <name> <root-path> [--actor <id>]
  pimpampum work:list [workspace-id] [project-id] [spec-id] [--limit <n>]
  pimpampum work:start <spec|task> <target-id> <agent-id> [--lease-seconds <n>]
  pimpampum work:renew <spec|task> <target-id> <agent-id> [--lease-seconds <n>]
  pimpampum work:release <spec|task> <target-id> <agent-id> [note] [--note <text>]
  pimpampum work:complete <spec|task> <target-id> <agent-id> <revision> <summary> [--artifact <uri>]... [--artifacts <json>]
  pimpampum project:create <workspace-id> <slug> <title> [--actor <id>]
  pimpampum project:get <project-id>
  pimpampum project:draft <project-id> <revision> [--actor <id>]
  pimpampum project:open <project-id> <revision> [--actor <id>]
  pimpampum project:pause <project-id> <revision> [--actor <id>]
  pimpampum project:complete <project-id> <revision> <summary> [--artifact <uri>]... [--artifacts <json>] [--actor <id>]
  pimpampum project:cancel <project-id> <revision> <reason> [--actor <id>]
  pimpampum spec:create <project-id> <slug> <title> [body-file] [--body-file <path>] [--actor <id>]
  pimpampum spec:get <spec-id>
  pimpampum spec:draft <spec-id> <revision> [--actor <id>]
  pimpampum spec:ready <spec-id> <revision> [--actor <id>]
  pimpampum spec:cancel <spec-id> <revision> <reason> [--actor <id>]
  pimpampum task:create <spec-id> <title> [parent-id] [--parent <id>] [--body-file <path>] [--actor <id>]
  pimpampum task:get <task-id>
  pimpampum task:cancel <task-id> <revision> <reason> [--actor <id>]
  pimpampum backup <directory>
  pimpampum backup status [--json]
  pimpampum backup configure <directory> [--json]
  pimpampum backup retry [--json]
  pimpampum backup disable [--json]
  pimpampum sync status [--json]
  pimpampum sync configure <directory> --device <id> [--json]
  pimpampum sync now [--json]
  pimpampum sync pause [--json]
  pimpampum sync resume [--json]
  pimpampum sync conflicts [--json]
  pimpampum sync resolve <conflict-id> <local|remote> [--json]
  pimpampum sync forget [--json]
  pimpampum export <directory>
```

Named commands cover common human operations. `tools` and `call` expose the complete MCP contract
as the canonical shell fallback for agents.

## Native status surfaces

The daemon is meant to disappear into the machine, not become a new pet process you check every
morning.

On **macOS 13+ on Apple Silicon**, download the signed menu-bar app and follow Guided setup. The
menu shows portfolio status, active Claims, current Spec/Task work, and every Project. Green means the
portfolio is terminal; an active badge means an agent owns work; an error means the daemon needs
attention. Click a Project to open its Workspace in Finder. **Settings…** configures agents,
updates, automatic synchronization, and backup. **Quit** closes the menu app and deliberately
leaves the daemon running.
The published app is signed and notarized; a locally built development app is not. The app has no
Dock icon. It knows its place.

On **Omarchy Quattro**, the enabled plugin bootstraps a dedicated Quickshell widget and systemd
user service. The bar shows the same portfolio state and Claim count. Its popout lists current work
and Projects, opens Workspaces with `xdg-open`, and exposes agent, update, synchronization, backup,
and service controls.

Portfolio content remains read-only in both native clients. Their bounded writes are explicit
agent connection, update, synchronization, backup, and service lifecycle actions; project work
still goes through the domain tools.

## Persistence, backup, and export

### Synchronization between computers

Choose a folder that is already synchronized by Google Drive, Dropbox, iCloud Drive, Syncthing,
rclone, or an equivalent provider. Pimpampum creates a `Pimpampum/devices/<device>` namespace and
writes immutable, complete JSON snapshots there; every computer keeps its live SQLite database,
token, Claims, settings, and Workspace paths locally.

```bash
pimpampum sync configure "/path/to/your/shared/folder" --device linux-desktop --json
pimpampum sync status --json
```

After configuration, import runs at startup, on polling, and with `sync now`; export is automatic
after committed changes. The Settings toggle pauses/resumes an existing configuration. It is off
until the user chooses a folder, and automatic thereafter. If the provider is offline, local work
continues and is exported after recovery. Concurrent edits to unrelated entities merge; divergent
edits to the same base are preserved as visible conflicts without a timestamp winner.

Resolve one explicitly with `pimpampum sync resolve <id> local` to keep this machine's candidate,
or `remote` to keep the other candidate. The decision is published to every device. MCP agents may
explain the preserved candidates but never choose one autonomously.

Google does not provide an official Google Drive desktop client for Linux. A mounted/synchronized
folder from rclone or another Linux client works because Pimpampum integrates with the filesystem,
not a provider API. Do not place `pimpampum.sqlite` itself in a cloud-synchronized directory.

### Backup and portable export

The live SQLite database must remain in Pimpampum's local data directory. **Do not place it inside
Dropbox, Google Drive, or iCloud.** Synchronized databases are an exciting way to discover file
locking at the least convenient possible moment.

Backups and exports may target any locally mounted or synchronized folder:

```bash
pimpampum backup /path/to/Dropbox/pimpampum-backups
pimpampum export /path/to/iCloud/pimpampum-exports
```

- Manual backups are immutable, integrity-checked SQLite snapshots.
- Automatic backup atomically refreshes `pimpampum-latest.sqlite` after each successful mutation.
- Backup failure never rolls back committed local project work.
- Portable export is rejected while live Claims exist.
- Claims and bearer tokens are excluded from portable exports.

Choose automatic backup from **Settings…** on macOS, from **Backup** in the Quattro popout, or with:

```bash
pimpampum backup configure "/path/to/Dropbox/Pimpampum" --json
pimpampum backup status --json
pimpampum backup retry --json
pimpampum backup disable --json
```

The schema-v2 portable export is deterministic and readable. `pimpampum export <directory>` creates
one timestamped directory inside the directory you name, and returns that exact path as `data.path`:

```text
pimpampum-export-<timestamp>-<id>/
  manifest.json                  schemaVersion: 2
  workspaces.json
  workspaces/<workspace-id>/
    context.json
    context/*.md
    projects/<project-slug>/
      project.json
      context.json
      context/*.md
      specs/<spec-slug>/
        spec.json
        spec.md
        tasks.json
```

To restore a SQLite backup: stop the daemon, preserve the token, move the failed database aside,
copy the selected snapshot to the configured `pimpampum.sqlite`, remove no unrelated files, avoid
stale `-wal` or `-shm` companions, restart, and verify `/health` plus a representative read.

## Configuration

| Variable             | Default                 | Purpose                |
| -------------------- | ----------------------- | ---------------------- |
| `PIMPAMPUM_DATA_DIR` | `~/.pimpampum`          | Private data directory |
| `PIMPAMPUM_HOST`     | `127.0.0.1`             | Loopback host          |
| `PIMPAMPUM_PORT`     | `7337`                  | Daemon port            |
| `PIMPAMPUM_TOKEN`    | Generated automatically | Local bearer token     |

The host must be loopback. A manually configured token must contain at least 32 printable ASCII
characters without spaces. One instance lock prevents two daemons from owning the same data
directory.

## Advanced installation and development

The signed macOS app and Omarchy plugin are the recommended installation paths. For automation or
another supported Linux desktop, the packaged CLI remains available as an advanced alternative and
requires Node.js 22 or newer:

```bash
npm install --global pimpampum
pimpampum install
```

`pimpampum install` installs the per-user service without root access. `pimpampum status` verifies
it. On macOS, `pimpampum install --service-only` deliberately leaves the separately downloaded app
in place.

To run a development checkout:

```bash
gh repo clone r-bart/pimpampum
cd pimpampum
npm ci
npm run build
npm run build:macos # macOS only
npm run cli -- install
```

When running from source, replace `pimpampum <command>` with `npm run cli -- <command>`. Run only
the foreground development daemon with `npm run dev`. Source-built macOS apps are unsigned
development artifacts; only the published release app carries the signing and notarization
guarantees described above.

## Deliberate omissions

Pimpampum does not include the following, and nobody forgot to add them:

- Sprints, milestones, roadmaps, priorities, estimates, points, or labels.
- Users, teams, roles, comments, chat, notifications, or social feeds.
- Configurable workflows or arbitrary Task dependencies.
- More than one level of Subtasks.
- Cloud synchronization of the live database.
- A web interface in the first version.

These omissions keep the contract small enough for an agent to understand and a human to trust.
Excellent larger tools already exist for the rest; Pimpampum would like to remain comprehensible
before lunch.

## Development and quality

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:evals
npm run build
```

`npm test` builds from a clean `dist/`, enforces 100% statement, branch, function, and line
coverage, and runs the six compiled E2E scenarios. `npm run test:evals` runs only that deterministic
E2E gate: four product workflows plus two synthetic Git development sessions that test handoff,
restart, repository tests, commits, and artifact verification. It does not launch or evaluate an
LLM. The exact boundaries and rubric live in [docs/evals.md](docs/evals.md).

Native live validation remains separate and explicitly opt-in because it depends on the target
desktop and may touch the current user's installed integration:

```bash
PIMPAMPUM_RUN_LIVE_MACOS=1 npm run test:e2e:macos
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
```

From a clean Omarchy Quattro machine with no existing Pimpampum installation, the complete live
smoke starts from a fresh checkout. The npm command builds the CLI before exercising installation,
the native plugin, service controls, screenshots, cleanup, and evidence capture:

```bash
git clone https://github.com/r-bart/pimpampum.git
cd pimpampum
npm ci
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
```

The similarly named Quattro command below only validates the plugin; it does not run the live
workflow. If a `thoughts/evidence/quattro-live.json` has been captured,
`npm run check:quattro-evidence` verifies it against the current plugin:

```bash
npm run test:e2e:omarchy
```

The macOS live smoke is a release gate and runs against the exact signed, notarized artifact. The
Quattro smoke remains opt-in evidence, recorded when a person runs it, and its absence does not
block a tag (decision of 2026-08-28).

## Status

The current release is `1.2.3`: functional, local-first, and deliberately small. Every
future feature has one admission test: does it improve coordination more than it increases surface
area? If not, it can enjoy a fulfilling life in another product.

## License

MIT. See [LICENSE](LICENSE).
