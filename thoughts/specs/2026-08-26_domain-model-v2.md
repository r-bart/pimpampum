# PRD: Domain Model v2

**Date**: 2026-08-26
**Status**: approved

---

## Executive Summary

Pimpampum will replace its one-project/one-PRD model with a durable hierarchy designed for agent
work across product repositories: a Workspace contains Projects, a Project contains Specs, and a
Spec contains Tasks with one optional Subtask level. Specs become the canonical executable
Markdown documents; a PRD is one possible form of Spec rather than a separate entity.

The change preserves local data automatically while deliberately replacing the unreleased v1 CLI,
HTTP, OpenAPI, MCP, export, overview, and native-status contracts. The resulting model must remain
small, deterministic, local-first, and safe for concurrent agents.

---

## Problem Statement

### Current State

The current v1 model is:

```text
Workspace
└── Project / PRD
    ├── Context document
    └── Task
        └── Subtask
```

A Project stores exactly one Markdown PRD, owns all Tasks, can be claimed directly, and moves
through `draft → ready → done`. This makes Project both a durable grouping concept and a single
executable specification.

### Pain Points

- One Project cannot group several related specifications.
- Project and PRD are artificially coupled one-to-one.
- The term PRD excludes valid agent work such as refactors, bugs, migrations, research, and
  non-functional requirements.
- Workspace-wide and Project-wide context cannot be represented independently.
- A directly claimable Project conflates coordination containers with executable work.
- Extending the current model would multiply special cases across MCP, CLI, HTTP, exports, and
  native status surfaces.

---

## Goals and Non-Goals

### Goals

1. Establish one unambiguous domain language shared by humans, agents, APIs, documentation, and
   native status surfaces.
2. Support many Projects per Workspace and many Specs per Project.
3. Make Specs and leaf Tasks the only executable, claimable units.
4. Support contextual Markdown at Workspace and Project scope without implicit inheritance.
5. Preserve optimistic concurrency, expiring claims, bounded reads, completion summaries, artifact
   references, and append-only activity.
6. Add explicit cancellation without destructive deletion.
7. Migrate all existing local data automatically and transactionally.
8. Replace the old unreleased public contract cleanly, without legacy aliases.

### Non-Goals

- Spec types, labels, priorities, estimates, due dates, or arbitrary metadata.
- Sprints, milestones, roadmaps, or configurable workflows.
- Dependencies between Projects, Specs, or Tasks.
- More than one Subtask level.
- Persisted `doing` states.
- Claims on Workspaces or Projects.
- Context documents scoped directly to Specs or Tasks.
- Separate archive states in v2.
- New macOS or Omarchy interaction designs.
- Backward-compatible aliases for the old MCP, CLI, or HTTP contract.
- Cloud synchronization of the live database or simultaneous multi-machine writes.

---

## Domain Language

| Term               | Definition                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local instance     | The single Pimpampum daemon and database on one machine. Every registered Workspace and connected agent shares it.                                              |
| Workspace          | A product or body of work anchored to one registered filesystem root, such as Pimpampum. It contains Projects and Workspace-wide context.                       |
| Project            | A bounded initiative or outcome inside a Workspace. It groups one or more related Specs and the context they share. It is not directly executable or claimable. |
| Spec               | The canonical Markdown description of one deliverable. It may describe a feature, requirement, bug, refactor, migration, or research effort.                    |
| PRD                | A product-requirements form of a Spec. It is product language, not a separate Pimpampum entity.                                                                 |
| Context document   | Supplementary Markdown scoped to a Workspace or Project: architecture, research, conventions, decisions, brand, or other durable knowledge.                     |
| Task               | A concrete unit of work derived from exactly one Spec.                                                                                                          |
| Subtask            | A child Task used to split larger work. Pimpampum permits one Subtask level and no deeper nesting.                                                              |
| Claim              | An expiring lease reserving one executable unit for one agent, preventing duplicate concurrent work.                                                            |
| Doing              | A derived presentation status while a valid Claim exists. It is never persisted as a lifecycle state.                                                           |
| Completion summary | A concise, durable record of the outcome when work or a Project finishes.                                                                                       |
| Artifact reference | A durable URI pointing to an output such as a commit, file, report, pull request, or build.                                                                     |
| Revision           | A monotonically increasing version used to reject stale concurrent writes.                                                                                      |

---

## Canonical Model

```text
Local instance
└── Workspace
    ├── Context document
    └── Project
        ├── Context document
        └── Spec
            └── Task
                └── Subtask
```

### Cardinality and Ownership

- A Workspace contains zero or more Projects.
- A Project belongs to exactly one Workspace and contains zero or more Specs while in `draft`.
- A Spec belongs to exactly one Project and contains zero or more Tasks.
- A Task belongs to exactly one Spec.
- A Subtask belongs to one top-level Task in the same Spec and cannot have children.
- A Context document belongs to exactly one Workspace or exactly one Project.
- Context names are unique within their owner scope. The same name may exist independently at both
  scopes.
- Completion summaries and artifact references belong to the entity whose outcome they describe.

---

## Lifecycle Model

### Persisted States

| Entity       | States                                         |
| ------------ | ---------------------------------------------- |
| Workspace    | No lifecycle state; existence means registered |
| Project      | `draft`, `open`, `paused`, `done`, `cancelled` |
| Spec         | `draft`, `ready`, `done`, `cancelled`          |
| Task/Subtask | `open`, `done`, `cancelled`                    |

`doing` is always derived from a live Claim and is never stored.

### Project Transitions

- Projects are created in `draft`.
- `draft ↔ open` and `open ↔ paused` are reversible transitions.
- A Project may enter `open` only when it contains at least one Spec.
- A `draft` or `paused` Project exposes no claimable work.
- A Project may become `done` only when every Spec is `done` or `cancelled` and no descendant Claim
  is active.
- A Project may be cancelled from any non-terminal state. Cancellation atomically cancels all
  non-terminal descendants and releases descendant Claims.
- `done` and `cancelled` are terminal.

### Spec Transitions

- Specs are created in `draft`; their Markdown body may initially be empty.
- `draft ↔ ready` is reversible while no Claim is active.
- A Spec may enter `ready` only when its Markdown body is non-empty after trimming.
- Tasks and Subtasks may be prepared while their Spec is `draft`.
- A Spec may become `done` only when every Task is `done` or `cancelled`.
- A Spec may be cancelled from a non-terminal state. Cancellation atomically cancels all
  non-terminal descendant Tasks and releases their Claims.
- New Specs may be added to `draft`, `open`, or `paused` Projects, but never to terminal Projects.
- `done` and `cancelled` are terminal and immutable.

### Task and Subtask Transitions

- Tasks and Subtasks are created in `open`.
- A Task may become `done` only when all its Subtasks are `done` or `cancelled`.
- Cancelling a Task atomically cancels its open Subtasks and releases its and their Claims.
- `done` and `cancelled` are terminal and immutable.

---

## Claim and Work-Discovery Model

- Only a `ready` Spec in an `open` Project or an open leaf Task beneath it can be claimed.
- A Spec with no open Tasks is claimable directly. This includes a Spec with no Tasks and a Spec
  whose Tasks are all terminal, allowing final integration and completion.
- While a Spec contains open Tasks, only its open leaf Tasks are claimable.
- A parent Task with open Subtasks is not claimable.
- Claims are atomic, exclusive, renewable, releasable, and expiring leases.
- Repeating a claim operation for the same agent and target is idempotent.
- A valid Claim makes its target appear as `doing` in derived status surfaces.
- Completing or cancelling claimed work releases its Claim.
- Expired or explicitly released work becomes available again.

---

## Context Model

- Workspace Context documents hold knowledge shared by all Projects in that Workspace.
- Project Context documents hold knowledge shared by the Specs in that Project.
- Specs are their own canonical executable documents and do not own additional Context documents.
- Context bodies are never injected automatically into agent responses.
- Starting work returns bounded manifests for the Workspace, Project, Spec, selected Task, and both
  Context scopes.
- Agents explicitly read only the Markdown bodies they need through bounded, paginated operations.
- There is no implicit merge, override, or inheritance behavior between equal names at different
  scopes.
- Context in terminal Projects is immutable. Workspace Context remains mutable while its Workspace
  is registered.

---

## Primary User and Agent Journeys

### Register and Plan Work

1. A solopreneur registers a product repository as a Workspace.
2. They or an agent create a Project in `draft`.
3. They add Workspace or Project Context where reusable knowledge is required.
4. They create one or more draft Specs and optionally decompose them into Tasks and Subtasks.
5. They make each executable Spec `ready`, then move the Project to `open`.

### Execute a Small Spec Directly

1. An agent resolves the Workspace from its current directory.
2. It lists available work and claims a ready Spec with no open Tasks.
3. It reads the bounded Spec and only the Context documents it needs.
4. It performs the work and completes or releases the Spec with a summary and artifact references.

### Execute a Decomposed Spec

1. Agents discover only open leaf Tasks under ready Specs in open Projects.
2. Each agent claims one leaf Task atomically.
3. Completing all Subtasks enables their parent Task.
4. Completing or cancelling all Tasks makes the Spec claimable for final integration and closure.
5. Once every Spec is terminal, the Project can be completed with an aggregate summary.

### Pause or Cancel

1. Pausing a Project hides all descendant work from discovery without changing child states.
2. Reopening the Project makes eligible work available again.
3. Cancelling a Project, Spec, or Task preserves history, atomically closes non-terminal
   descendants, and releases affected Claims.

---

## Functional Requirements

### Workspace Management

- Register, list, resolve by current filesystem path, and inspect Workspaces.
- Create, list, read, update, and page Workspace Context documents.
- Resolve nested paths to the most specific registered Workspace.
- Workspace deletion or unregistration is not introduced in v2.

### Project Management

- Create, list, inspect, update, pause, reopen, complete, and cancel Projects.
- Enforce Project state transitions and terminal immutability with optimistic revisions.
- Create, list, read, update, and page Project Context documents.
- Return derived counts and operational status without loading child Markdown bodies.

### Spec Management

- Create, list, inspect, update, read Markdown, mark ready/draft, complete, and cancel Specs.
- Enforce unique Spec slugs within each Project.
- Keep manifests lightweight and expose Markdown through bounded pages.
- Store completion summaries and bounded artifact references.

### Task Management

- Create, list, inspect, update, read Markdown, complete, and cancel Tasks and one-level Subtasks.
- Associate every Task with one Spec rather than directly with a Project.
- Enforce same-Spec parentage and the maximum depth of one.

### Work Coordination

- Discover claimable Specs and leaf Tasks, optionally scoped by Workspace, Project, or Spec.
- Start, renew, release, complete, and cancel eligible work through atomic Claims.
- Preserve idempotency, bounded responses, actionable errors, and optimistic revision conflicts.

### Activity and Portability

- Record append-only activity for Workspace, Project, Spec, Task, Context, Claim, lifecycle, and
  migration events.
- Export the hierarchy as deterministic JSON metadata plus Markdown Specs and Context documents.
- Preserve consistent SQLite snapshots and automatic post-mutation backups.

### Native Status Surfaces

- Preserve the existing macOS and Omarchy interaction design.
- Adapt labels and hierarchy to Workspace, Project, Spec, and Task.
- Derive active work from Claims and aggregate project/workspace completion from descendants.
- Keep project/workspace navigation read-only apart from the existing backup settings.

---

## Migration Requirements

The database upgrade must run automatically, transactionally, and idempotently before the daemon
accepts requests.

```text
Current Workspace
→ New Workspace

Current Project
→ New Project with the same identity, slug, title, and Context
  └── One migrated Spec containing the former PRD

Current Project Tasks
→ Tasks associated with the migrated Spec

Current Project Claim
→ Claim on the migrated Spec
```

State mapping:

| Current Project | New Project | Migrated Spec |
| --------------- | ----------- | ------------- |
| `draft`         | `draft`     | `draft`       |
| `ready`         | `open`      | `ready`       |
| `done`          | `done`      | `done`        |

- Current Project completion summaries and artifacts move to the migrated Spec and are also
  retained as the aggregate Project completion record for already-completed Projects.
- Current Context remains attached to the migrated Project.
- Current Task and Subtask identifiers, revisions, completion data, and artifacts are preserved.
- The migration must preserve claims, expiry timestamps, activity history, backups, and authorized
  roots without exposing the bearer token.
- Any migration failure rolls back the entire schema and data change and prevents daemon startup
  with an actionable error.

---

## Contract Replacement

- Replace v1 Project-as-PRD operations with explicit Project and Spec operations.
- Replace claim targets `project | task` with `spec | task`.
- Replace Task ownership from `projectId` to `specId`.
- Update CLI, MCP tools, HTTP `/api/v1`, OpenAPI, exports, overview, native helpers, documentation,
  and evaluation fixtures together.
- Keep `/api/v1` because the prior contract has not shipped as a public release.
- Do not expose compatibility aliases, dual response shapes, or transitional deprecation fields.
- Existing local data is compatible through migration; existing clients must adopt the new
  contract.

---

## Edge Cases and Errors

- Empty or whitespace-only Specs cannot become `ready`.
- Empty Projects cannot become `open` or `done`.
- Cross-Workspace Project ownership, cross-Project Spec ownership, and cross-Spec Task parentage are
  rejected.
- A Project cannot complete while any Spec is non-terminal or any descendant Claim exists.
- A Spec cannot complete while any Task is non-terminal.
- A Task cannot complete while any Subtask is non-terminal.
- Lifecycle changes that would invalidate active Claims are rejected unless using explicit
  cancellation, which releases them atomically.
- Stale revisions return `revision_conflict` without partial writes.
- Repeated same-agent claims remain idempotent; competing claims return an actionable conflict.
- Bounded list and Markdown pagination remain mandatory at every collection and document boundary.
- Terminal entities reject content, hierarchy, lifecycle, and Context mutations.
- Cancelling an already terminal entity is an invalid-state error rather than an implicit rewrite.
- Automatic backup failure never rolls back a successful domain mutation; it remains independently
  retryable and observable.

---

## Technical Considerations

- SQLite remains the single source of truth with foreign keys, explicit indexes, WAL mode, and full
  synchronous durability.
- Schema migration must be tested from a real v1 database fixture, not only a newly created v2
  database.
- All mutations affecting multiple descendants, claims, events, or revisions must be atomic.
- MCP remains the preferred agent interface. CLI `tools` and `call` expose the same canonical tool
  catalog for shell-only agents.
- The HTTP API remains loopback-only and bearer-authenticated; `/health` and `/openapi.json` remain
  the only unauthenticated routes.
- Response manifests must not silently load unbounded Spec, Task, or Context Markdown.
- Native surfaces consume one bounded overview contract and do not receive the bearer token.
- No new visual components or desktop interactions are required beyond terminology and rollup
  changes.

---

## Success Metrics

| Metric                | Target                                                                                   | Measurement                                                                |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Migration integrity   | 100% of v1 entities, bodies, revisions, claims, completion data, and artifacts preserved | Deterministic migration integration test against a populated v1 fixture    |
| Contract consistency  | Zero old Project-as-PRD names or claim targets in shipped interfaces                     | Static contract checks across MCP, CLI, HTTP, OpenAPI, docs, and package   |
| Workflow correctness  | Every canonical Workspace → Project → Spec → Task flow passes without mocks              | Compiled end-to-end and evaluation suites                                  |
| Concurrency safety    | No duplicate live claim or stale overwrite succeeds                                      | Competing-agent and optimistic-revision integration tests                  |
| Bounded agent context | No list/start response loads unbounded Markdown                                          | Contract tests for manifests and pagination                                |
| Regression safety     | 100% statements, branches, functions, and lines                                          | Existing coverage gate                                                     |
| Desktop continuity    | Existing macOS and Omarchy interactions remain intact                                    | Native acceptance tests plus target-machine live validation where required |
| Backup continuity     | Every successful migrated-model mutation schedules the configured snapshot               | Automatic-backup integration and recovery tests                            |

---

## Acceptance Criteria

- [ ] A Workspace can contain multiple Projects and Workspace Context documents.
- [ ] A Project can contain multiple Specs and Project Context documents.
- [ ] A Spec can contain Tasks and one-level Subtasks.
- [ ] PRD is documented as a form of Spec and does not appear as a separate entity.
- [ ] Only eligible Specs and leaf Tasks can be claimed.
- [ ] `doing` is derived exclusively from valid Claims.
- [ ] All lifecycle transitions, terminal immutability, cancellation cascades, and revision checks
      follow this specification.
- [ ] A populated v1 database migrates automatically with no lost entities or metadata.
- [ ] MCP, CLI, HTTP, OpenAPI, export, overview, backup, native surfaces, README, and tool
      documentation expose one consistent v2 domain language.
- [ ] Real use-case E2E tests cover CRUD, work execution, cancellation, migration, restart, backup,
      export, and agent handoff.
- [ ] The full quality suite and 100% coverage gate pass.

---

## Design Reference

No new design mockups are required. Existing macOS menu-bar and Omarchy Quattro designs remain the
visual source of truth; implementation changes are limited to terminology, hierarchy, derived
counts, and rollups.

---

## Open Questions

None. The domain hierarchy, terminology, lifecycle, claims, context scope, migration policy, and
visual scope were approved during the product interview.

---

## Risks

| Risk                                      | Impact | Mitigation                                                                                   |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| Partial or lossy v1 migration             | High   | One transaction, populated fixture, integrity assertions, rollback-on-error startup behavior |
| Contract drift across interfaces          | High   | One shared schema/tool catalog plus static cross-interface checks                            |
| Cancellation leaves orphaned live Claims  | High   | Atomic recursive cancellation with explicit claim and activity assertions                    |
| Context scope causes accidental overrides | Medium | Scope-qualified identity; no implicit merge or inheritance                                   |
| Overview becomes expensive                | Medium | Indexed aggregate queries, bounded manifests, and the existing overview benchmark            |
| Native surfaces regress                   | Medium | Preserve visual contract; update fixtures and run platform acceptance/live checks            |
| Legacy aliases reintroduce ambiguity      | Medium | Explicit non-goal and repository-wide prohibited-term checks                                 |
| New hierarchy increases agent round trips | Low    | Return bounded startup manifests while keeping Markdown reads explicit                       |
