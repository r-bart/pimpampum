# Product Matrix: Pimpampum v1

**Date**: 2026-08-25
**Status**: approved

## Product definition

A single local service that coordinates agents working across multiple directories. It stores project intent as Markdown, exposes deterministic JSON over HTTP, and provides agent-native operations over MCP.

## Core model

```text
Workspace
└── Project / PRD
    ├── Context document
    └── Task
        └── Subtask
```

## P0 feature matrix

| Area                  | Included in v1                                       |
| --------------------- | ---------------------------------------------------- |
| Runtime               | One persistent daemon bound to localhost             |
| Storage               | One local SQLite database with migrations            |
| Agent interface       | MCP Streamable HTTP endpoint                         |
| Integration interface | Versioned local HTTP JSON API                        |
| Human interface       | Minimal CLI using the HTTP API                       |
| Workspaces            | Register, list and resolve by filesystem path        |
| Projects              | Create, list, inspect and update                     |
| PRDs                  | One Markdown document per project                    |
| Context               | Named Markdown documents per project                 |
| Tasks                 | Create, inspect, update and complete                 |
| Subtasks              | Same entity as tasks, with a maximum depth of one    |
| Project states        | `draft`, `ready`, `done`                             |
| Task states           | `open`, `done`                                       |
| Claims                | Start, renew, release and expire leases              |
| Concurrency           | Atomic transactions and optimistic revisions         |
| Completion            | Summary and artifact references                      |
| Auditability          | Append-only activity events                          |
| Backup                | Consistent SQLite snapshot to a configured directory |
| Portability           | JSON + Markdown export                               |
| Security              | Loopback-only server, bearer token, authorized roots |

## Invariants

- A project belongs to exactly one workspace and contains one PRD.
- A task belongs to exactly one project.
- A subtask belongs to a top-level task in the same project and cannot have children.
- A task cannot complete while it has open subtasks.
- A project cannot complete while it has open tasks.
- A project with open tasks cannot be claimed directly.
- Claims expire and all claim mutations are atomic.
- Agents never read or write the database directly.
- Markdown content is opaque to the coordination engine.

## Explicit non-goals

- Sprints, priorities, labels, estimates or due dates.
- Task dependencies or configurable workflows.
- Comments, chat, notifications or attachments.
- Users, teams, roles or a web UI.
- Semantic search or embedded agents.
- Cloud sync or simultaneous multi-machine writes.
- Direct provider integrations for Dropbox, Drive or iCloud.

## Persistence boundary

The live database remains on a local filesystem. Backups may target any locally mounted or synchronized directory. Cloud folders receive immutable snapshots and portable exports, never the active SQLite database.

## Primary agent workflow

```text
resolve workspace
→ list available work
→ start and atomically claim work
→ read PRD and context
→ perform work in the external workspace
→ complete or release with a handoff
```
