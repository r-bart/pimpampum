# Implementation Plan: Domain Model v2

**Date**: 2026-08-26
**Status**: Implemented; exact-target Quattro live evidence pending
**Source spec**: `thoughts/specs/2026-08-26_domain-model-v2.md`

---

## Overview

Replace the current `Workspace → Project/PRD → Task` contract with the approved
`Workspace → Project → Spec → Task → Subtask` model. The implementation will migrate every v1
database automatically, replace the unreleased public contract without aliases, preserve the
existing native interaction design, and retain Pimpampum's 100% coverage and compiled end-to-end
quality gates.

No implementation code should be written until the spec-test manifest described in Phase 0 exists.

---

## Requirements

- [x] A Workspace owns many Projects and Workspace-scoped Context documents.
- [x] A Project owns many Specs and Project-scoped Context documents.
- [x] A Spec owns its Markdown body and many Tasks.
- [x] Tasks point to Specs; Subtasks remain the same entity with a maximum depth of one.
- [x] Projects use `draft | open | paused | done | cancelled`.
- [x] Specs use `draft | ready | done | cancelled`.
- [x] Tasks use `open | done | cancelled`.
- [x] Only ready Specs in open Projects and their open leaf Tasks are claimable.
- [x] `doing` remains derived exclusively from live Claims.
- [x] Cancellation is atomic, terminal, non-destructive, and releases descendant Claims.
- [x] Workspace and Project Context manifests remain bounded and bodies remain explicitly paged.
- [x] Existing v1 data migrates transactionally with identifiers and history preserved where
      semantically possible.
- [x] MCP, CLI, HTTP `/api/v1`, OpenAPI, export, overview, backup, native surfaces, and docs replace
      the old Project-as-PRD contract together.
- [x] No compatibility aliases or transitional response fields ship.
- [x] Existing macOS and Omarchy UX remains intact apart from terminology and derived rollups.

---

## Current Architecture and Constraints

- `src/db.ts` has one inline schema migration and rejects versions newer than `1`.
- `src/store.ts` is the transactional source of domain invariants, SQL queries, activity recording,
  overview aggregation, claims, backup, and export delegation.
- `src/types.ts` and `src/schemas.ts` define the shared gateway and validation contracts consumed by
  the HTTP client, server, MCP, CLI, OpenAPI, and tests.
- The old Project body is stored in `projects.prd`; Tasks use `tasks.project_id`; Context uses
  `context_documents.project_id`; Claims accept `project | task`.
- Overview schema version `1` is independently validated by TypeScript, Swift, and QML.
- Desktop acceptance files and overview fixtures are hash-frozen by
  `scripts/check-desktop-status-contract.mjs`; changing the approved contract requires an explicit,
  reviewed hash refresh.
- Automatic backup is mutation-driven through the Store callback and must cover every new mutation.
- Portable export currently writes `projects/<workspace>/<project>/prd.md`, `tasks.json`, and one
  Project Context directory.
- `npm test` requires 100% statement, branch, function, and line coverage.
- No generated spec-test manifest currently matches `domain-model-v2`; Phase 0 must create it before
  production implementation.

---

## Approach Analysis

### Option A: Compatibility Overlay

**Description**: Keep the current Project table as the executable Spec, introduce another grouping
table above it, and translate old names at every external boundary.

**Pros**:

- Smaller initial database migration.
- Some existing tests and clients could continue working temporarily.

**Cons**:

- Internal names would contradict public names indefinitely.
- Every query, event, export, and error would need translation.
- Compatibility aliases would violate the approved non-goal and enlarge the agent tool surface.
- Future maintainers would need to remember that internal Project means external Spec.

**Complexity**: High ongoing complexity despite a medium initial change.

### Option B: Normalized In-Place v2 Migration

**Description**: Rebuild the SQLite schema transactionally. Keep existing Workspaces and Projects,
add first-class Specs, move Task ownership and Project Claims to Specs, add scoped Context, and
replace every shipped contract in one coordinated release. Keep the existing Store facade, but
extract migrations and pure lifecycle rules so the expanded domain does not turn into scattered
conditionals.

**Pros**:

- Domain names mean the same thing in storage, code, API, tools, docs, and UI.
- One canonical contract with no aliases.
- Existing architecture and deployment model remain recognizable.
- Pure transition rules can be tested independently from SQL.
- Automatic local-data migration protects current users.

**Cons**:

- Broad coordinated change across almost every product boundary.
- SQLite table rebuild and historical-event mapping require careful fixtures.
- Existing external clients break by design.

**Complexity**: High once, low ongoing complexity.

### Option C: Full Domain-Layer Rewrite

**Description**: Replace `PimpampumStore` with repositories, use cases, aggregates, and a new event
model before implementing v2.

**Pros**:

- Maximum separation of concerns.
- Easier independent replacement of persistence in theory.

**Cons**:

- Expands the task far beyond the product requirement.
- Introduces abstractions before a second persistence implementation exists.
- Makes migration defects harder to distinguish from architectural rewrite defects.
- Conflicts with Pimpampum's deliberately small footprint.

**Complexity**: Very high.

### Recommendation

Use **Option B**. Create `src/migrations.ts` for versioned, transactional schema changes and
`src/domainRules.ts` for pure state/claim eligibility rules. Keep `PimpampumStore` as the public
transactional facade and update its SQL in place. This is the smallest approach that removes the
semantic debt instead of hiding it.

Version boundaries:

- SQLite `user_version`: `1 → 2`.
- Portable export `schemaVersion`: `1 → 2`.
- Overview envelope `schemaVersion`: `1 → 2` because native consumers validate it strictly.
- HTTP route prefix: remain `/api/v1` per the approved pre-release contract decision.
- MCP/CLI: replace names directly, with no aliases.

---

## Target Persistence Shape

The exact SQL belongs in the migration task, but implementation must produce this normalized shape:

```sql
workspaces(id, name, root_path, created_at, updated_at)

projects(
  id, workspace_id, slug, title,
  state CHECK state IN ('draft', 'open', 'paused', 'done', 'cancelled'),
  revision, completion_summary, artifacts_json,
  completed_at, cancelled_at, created_at, updated_at,
  UNIQUE(workspace_id, slug)
)

specs(
  id, project_id, slug, title, body,
  state CHECK state IN ('draft', 'ready', 'done', 'cancelled'),
  revision, completion_summary, artifacts_json,
  completed_at, cancelled_at, created_at, updated_at,
  UNIQUE(project_id, slug)
)

context_documents(
  id,
  workspace_id NULL REFERENCES workspaces,
  project_id NULL REFERENCES projects,
  name, body, revision, created_at, updated_at,
  CHECK exactly_one_owner
)

tasks(
  id, spec_id, parent_id, title, body,
  state CHECK state IN ('open', 'done', 'cancelled'),
  revision, completion_summary, artifacts_json,
  completed_at, cancelled_at, created_at, updated_at
)

claims(
  target_type CHECK target_type IN ('spec', 'task'),
  target_id, agent_id, expires_at, created_at, updated_at,
  PRIMARY KEY(target_type, target_id)
)

activity_events(
  id, workspace_id, project_id, spec_id,
  target_type, target_id, event_type, actor, data_json, created_at
)
```

Use partial unique indexes for Context names in each owner scope, plus indexes for Project state,
Spec state, Task state/parent, Claim expiry, activity scope, and overview joins.

---

## Public Contract Direction

### Canonical MCP Tool Families

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

- `context_*` receives `ownerType: workspace | project` plus `ownerId`.
- `work_*` accepts only `targetType: spec | task`.
- `work_list` accepts optional `workspaceId`, `projectId`, and `specId` filters with ancestor
  consistency validation.
- Project completion/cancellation uses optimistic revisions but no Claim.
- Spec completion through `work_complete` requires an owned Claim.
- Tasks always use `specId`; `projectId` is never accepted as a Task owner.
- Tool descriptions, annotations, examples, bounds, pagination, side effects, and errors remain
  discoverable through MCP `tools/list` and CLI `pimpampum tools`.

### HTTP Resource Shape

Keep `/api/v1` and replace old semantics with nested creation/list routes and canonical resource
routes:

```text
/workspaces
/workspaces/resolve
/workspaces/{workspaceId}/context

/projects
/projects/{projectId}
/projects/{projectId}/context
/projects/{projectId}/specs
/projects/{projectId}/completion
/projects/{projectId}/complete
/projects/{projectId}/cancel
/projects/{projectId}/activity

/specs/{specId}
/specs/{specId}/manifest
/specs/{specId}/body
/specs/{specId}/completion
/specs/{specId}/tasks
/specs/{specId}/cancel

/tasks/{taskId}
/tasks/{taskId}/manifest
/tasks/{taskId}/body
/tasks/{taskId}/completion
/tasks/{taskId}/cancel

/work
/work/{spec|task}/{targetId}/claim
/work/{spec|task}/{targetId}/complete
```

The OpenAPI document remains the source of truth for exact request/response schemas.

---

## Files to Create or Modify

| File or group                                                       | Action | Purpose                                                                                  |
| ------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `thoughts/tests/2026-08-26_domain-model-v2.md`                      | Create | Immutable spec-test manifest before production implementation                            |
| `test/domain-model-v2.acceptance.test.ts`                           | Create | Tests-as-documentation for hierarchy, lifecycle, claims, context, and prohibited aliases |
| `test/migration-v2.test.ts`                                         | Create | Populated v1 → v2 migration, rollback, idempotency, and future-version tests             |
| `src/migrations.ts`                                                 | Create | Versioned schema creation and transactional v1 → v2 data migration                       |
| `src/domainRules.ts`                                                | Create | Pure terminal, transition, readiness, and claim-eligibility rules                        |
| `src/db.ts`                                                         | Modify | Delegate ordered migrations and accept schema version `2`                                |
| `src/types.ts`                                                      | Modify | Project, Spec, scoped Context, Task ownership, WorkBundle, overview, and gateway types   |
| `src/schemas.ts`                                                    | Modify | New lifecycle, scope, create/update/cancel, and target validation                        |
| `src/store.ts`                                                      | Modify | Implement normalized CRUD, invariants, cascades, claims, activity, and overview queries  |
| `src/client.ts`                                                     | Modify | Replace HTTP gateway methods and routes                                                  |
| `src/http.ts`                                                       | Modify | Replace REST handlers and validation                                                     |
| `src/mcp.ts`                                                        | Modify | Replace Project-as-PRD tools with Project/Spec tools                                     |
| `src/cliProgram.ts`                                                 | Modify | Replace named human commands and work target grammar                                     |
| `src/agentProtocol.ts`                                              | Modify | Update actionable hierarchy and lifecycle guidance                                       |
| `src/openapi.ts`                                                    | Modify | Publish the exact new `/api/v1` contract                                                 |
| `src/overview.ts`, `src/overviewContract.ts`                        | Modify | Derive Workspace/Project/Spec rollups and overview schema version `2`                    |
| `src/backup.ts`                                                     | Modify | Export Workspace/Project/Spec hierarchy with schema version `2`                          |
| `platforms/macos/Sources/PimpampumMenuBar/Models.swift`             | Modify | Decode overview v2, Spec active work, and new Project lifecycle                          |
| `platforms/macos/Sources/PimpampumMenuBar/StatusPresentation.swift` | Modify | Preserve visual vocabulary while mapping new rollups                                     |
| `platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift`      | Modify | Update semantic labels and active-work titles without redesigning layout                 |
| `platforms/macos/Tests/PimpampumMenuBarTests/*`                     | Modify | Prove strict decoding, rollups, copy, grouping, opening, and accessibility               |
| `integrations/omarchy/pimpampum-status/OverviewService.qml`         | Modify | Strictly validate overview v2 and `spec                                                  | task` work |
| `integrations/omarchy/pimpampum-status/StatusPopout.qml`            | Modify | Update labels and title composition while preserving current interactions                |
| `integrations/omarchy/pimpampum-status/fixtures/*.json`             | Modify | Canonical overview v2 native fixtures                                                    |
| `test/fixtures/overview/*.json`                                     | Modify | Canonical overview v2 server/macOS/Omarchy fixtures                                      |
| `scripts/check-desktop-status-contract.mjs`                         | Modify | Freeze reviewed v2 acceptance artifacts and fixtures                                     |
| `test/core.test.ts`, `test/store.test.ts`                           | Modify | Unit/integration coverage for new schema and Store behavior                              |
| `test/http.test.ts`, `test/openapi.test.ts`, `test/mcp.test.ts`     | Modify | Exact public-contract replacement and old-contract rejection                             |
| `test/cli-program.test.ts`, `test/agent-cli.acceptance.test.ts`     | Modify | Named commands, dynamic tool calling, errors, and shell-agent workflows                  |
| `test/e2e.test.ts`                                                  | Modify | Compiled real-use Workspace → Project → Spec → Task workflows                            |
| `test/automatic-backup*.test.ts`                                    | Modify | Every new mutation and cancellation schedules the rolling snapshot                       |
| `test/desktop-status*.test.ts`, `test/omarchy-plugin.test.ts`       | Modify | Overview v2 and unchanged native interaction contract                                    |
| `scripts/test-macos-live.mjs`, `scripts/test-omarchy-live.mjs`      | Modify | Seed and verify the v2 hierarchy on real targets                                         |
| `README.md`, `docs/mcp-tools.md`, `docs/evals.md`                   | Modify | One consistent domain language and current usage examples                                |
| `thoughts/specs/2026-08-25_pimpampum-v1.md`                         | Modify | Mark superseded and point to the approved v2 spec                                        |

Generated native binaries and evidence metadata change only after their source, tests, and live
validation have passed. Existing unrelated README cover/package changes must be preserved.

---

## Implementation Phases

### Phase 0: Tests as the Definition of Done

#### Task 0.1: Generate and Freeze Spec Tests

**Files**: `thoughts/tests/2026-08-26_domain-model-v2.md`,
`test/domain-model-v2.acceptance.test.ts`

- Run `devtronic:generate-tests` against the approved v2 spec.
- Cover every acceptance criterion with failing, implementation-independent assertions.
- Freeze the generated tests before touching production code.
- Include a prohibited-contract scan for `project_read_prd`, `project_update_prd`, Project claims,
  `tasks.project_id`, and the old overview schema.

#### Task 0.2: Build the Populated v1 Migration Fixture

**Files**: `test/migration-v2.test.ts`, optional helper under `test/fixtures/`

- Construct a real schema-v1 database containing every state, nested Tasks, Context, active and
  expired Claims, completion summaries, artifacts, activity, and multiple Workspaces/Projects.
- Capture a pre-migration semantic inventory used to assert post-migration equivalence.
- Add failure-injection and future-version rejection cases.

### Phase 1: Schema and Domain Foundation

#### Task 1.1: Define v2 Types, Schemas, and Pure Rules

**Files**: `src/types.ts`, `src/schemas.ts`, `src/domainRules.ts`

Implement canonical types and pure guards before SQL behavior:

```typescript
type ProjectState = 'draft' | 'open' | 'paused' | 'done' | 'cancelled';
type SpecState = 'draft' | 'ready' | 'done' | 'cancelled';
type TaskState = 'open' | 'done' | 'cancelled';
type TargetType = 'spec' | 'task';
type ContextOwnerType = 'workspace' | 'project';
```

- Define Project and Spec manifests that exclude unbounded Markdown/completion bodies.
- Define scoped Context identity and a WorkBundle containing Workspace, Project, Spec, optional
  Task, and separate bounded Context manifest pages.
- Encode reversible and terminal transitions in pure functions with exhaustive switches.

#### Task 1.2: Implement Transactional Schema v2 Migration

**Files**: `src/migrations.ts`, `src/db.ts`, `test/migration-v2.test.ts`

- Create fresh databases directly at v2.
- Rebuild v1 tables inside one transaction and set `user_version = 2` only after all validation.
- Preserve current Workspace and Project IDs; generate one Spec per old Project.
- Use a deterministic collision-safe migrated Spec slug such as `primary`, adding a stable suffix
  only if future fixture data makes it necessary.
- Map Project states, Project Claims, Task ownership, completion data, and Context exactly as the
  spec requires.
- Define an explicit event migration table: Project lifecycle/history stays Project-scoped; PRD and
  Project-work events become Spec-scoped and point to the generated Spec ID; original details remain
  in event data for audit.
- Run `foreign_key_check`, uniqueness checks, and semantic counts before committing.
- Roll back and close the database on any error.

#### Task 1.3: Implement Project and Scoped Context Operations

**Files**: `src/store.ts`, `test/store.test.ts`, `test/core.test.ts`

- Replace Project CRUD with container lifecycle operations.
- Add Workspace and Project Context operations using explicit owner type/id.
- Enforce unique names per scope, terminal Project immutability, and no implicit inheritance.
- Add Project completion and atomic cancellation with revisions, summaries, artifacts, and events.

#### Task 1.4: Implement Spec and Task Operations

**Files**: `src/store.ts`, `test/store.test.ts`, `test/core.test.ts`

- Add Spec CRUD, bounded Markdown, completion, readiness, and cancellation.
- Move Task ownership and same-parent checks from Project to Spec.
- Implement cancellation cascades for Specs, Tasks, and Subtasks in one immediate transaction.
- Preserve terminal immutability and optimistic revisions.

#### Task 1.5: Replace Work Discovery and Claims

**Files**: `src/store.ts`, `src/domainRules.ts`, `test/store.test.ts`

- Discover only Specs or leaf Tasks beneath `open` Projects and `ready` Specs.
- Support consistent Workspace, Project, and Spec filters.
- Convert work start bundles to bounded Workspace/Project/Spec/Task and Context manifests.
- Keep same-agent idempotency, competing-agent exclusion, expiry, renewal, release, and completion.
- Make cancellation remove affected Claims atomically and activity-visible.

#### Task 1.6: Complete Activity and Mutation/Backup Coverage

**Files**: `src/store.ts`, `src/automaticBackup.ts`, `test/automatic-backup*.test.ts`

- Record every new hierarchy, lifecycle, context, cancellation, and claim event.
- Ensure every successful mutation calls the existing backup-dirty callback exactly once after
  commit-equivalent success.
- Prove backup errors remain isolated from domain mutations.

### Phase 2: Agent and Integration Contracts

#### Task 2.1: Replace Gateway, Client, and HTTP API

**Files**: `src/types.ts`, `src/client.ts`, `src/http.ts`, `test/http.test.ts`,
`test/agent-client.test.ts`

- Replace gateway methods and route handlers with the approved resources.
- Keep envelopes, authentication, bounds, actionable errors, and loopback security unchanged.
- Reject old Project-as-PRD routes and Project claim target types.

#### Task 2.2: Replace MCP Tool Catalog

**Files**: `src/mcp.ts`, `src/agentProtocol.ts`, `test/mcp.test.ts`,
`test/agent-protocol.test.ts`

- Implement the canonical tool families and descriptions listed above.
- Keep small inputs, explicit effects, pagination, annotations, and one JSON envelope per call.
- Prove `tools/list` contains no old aliases and every tool round-trips through the shared daemon.

#### Task 2.3: Replace Human and Agent CLI Commands

**Files**: `src/cliProgram.ts`, `test/cli-program.test.ts`,
`test/agent-cli.acceptance.test.ts`

- Replace named Project/PRD commands with Project and Spec commands.
- Change work grammar to `<spec|task>`.
- Preserve non-interactive JSON, stdin/file input, `tools`, `call`, installation, backup, and export.
- Update help and actionable examples atomically.

#### Task 2.4: Rebuild OpenAPI from the Canonical Schemas

**Files**: `src/openapi.ts`, `test/openapi.test.ts`

- Publish every v2 route, lifecycle enum, scoped Context owner, Spec schema, cancellation response,
  work filter, and error.
- Validate every `$ref`, operation ID, request body, response envelope, and security requirement.
- Assert old routes and old target enums are absent.

### Phase 3: Overview and Native Status Surfaces

#### Task 3.1: Define and Query Overview v2

**Files**: `src/types.ts`, `src/overview.ts`, `src/overviewContract.ts`, `src/store.ts`,
`test/overview.test.ts`, `test/fixtures/overview/*.json`, `scripts/benchmark-overview.ts`

- Bump the strict overview envelope to schema version `2`.
- Add counts for Project, Spec, Task, terminal/cancelled entities, Claims, and available work.
- Keep Project rows as the visible grouping and include their Workspace root for file opening.
- Add Spec identity/title to active work and Task identity/title when applicable.
- Preserve the existing visual status vocabulary where possible; lifecycle text distinguishes
  paused/cancelled Projects without inventing a persisted work state.
- Use indexed aggregate queries and keep the 500-row bounds and benchmark budget.

#### Task 3.2: Update macOS Contract Without Redesign

**Files**: `platforms/macos/Sources/PimpampumMenuBar/{Models,StatusPresentation,StatusPopover}.swift`,
related Swift tests

- Strictly decode overview schema version `2`.
- Show Project rows and Spec/Task active-work titles using the existing layout.
- Preserve status mark, badges, count, help, Settings, Quit, Finder opening, accessibility, stale
  data, and login-approval behavior.
- Keep terminal Projects in the existing collapsed terminal group; cancelled lifecycle copy must
  not claim successful completion.

#### Task 3.3: Update Omarchy Contract Without Redesign

**Files**: `integrations/omarchy/pimpampum-status/{OverviewService,StatusPopout}.qml`, fixtures,
`test/omarchy-plugin.test.ts`

- Mirror the strict overview v2 validation and title behavior.
- Preserve bar geometry, popout, `xdg-open`, backup disclosure, offline recovery, and bounded content.
- Reject overview v1 as incompatible rather than rendering ambiguous data.

#### Task 3.4: Re-freeze and Validate the Desktop Contract

**Files**: `test/desktop-status*.test.ts`, overview fixtures,
`scripts/check-desktop-status-contract.mjs`, native evidence checks

- Update the old acceptance contract only for approved domain/overview differences.
- Review the diff before replacing frozen hashes.
- Update live runners and evidence schemas/seeds without weakening restoration or visual-review
  requirements.

### Phase 4: Portability and Documentation

#### Task 4.1: Export the v2 Hierarchy

**Files**: `src/backup.ts`, `test/core.test.ts`, `test/e2e.test.ts`

Produce a deterministic export:

```text
manifest.json                    schemaVersion: 2
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

- Keep claims and bearer tokens out of portable exports.
- Continue rejecting export while live Claims exist.
- Preserve atomic partial-directory cleanup.

#### Task 4.2: Synchronize Public and Internal Documentation

**Files**: `README.md`, `docs/mcp-tools.md`, `docs/evals.md`, old v1 spec marker

- Replace every technical PRD command, route, tool, state, example, and export path.
- Keep PRD only where described as one possible Spec form.
- Mark the 2026-08-25 v1 spec superseded rather than deleting history.
- Update installation and agent briefs with a complete canonical workflow.

### Phase 5: End-to-End Proof and Release Gates

#### Task 5.1: Rebuild Real-Use E2E and Evaluation Workflows

**Files**: `test/e2e.test.ts`, `docs/evals.md`, related acceptance suites

Cover without mocks:

1. Register Workspace and both Context scopes.
2. Create a Project with multiple Specs.
3. Execute one Spec directly and another through Task/Subtask claims.
4. Pause/reopen Project and verify work visibility.
5. Exercise competing Claims, expiry, renewal, release, and handoff.
6. Cancel Task, Spec, and Project trees and verify atomic history/claim cleanup.
7. Complete a Project only after terminal Specs.
8. Restart the daemon and verify persistence.
9. Migrate a populated v1 database and continue work through new CLI, HTTP, and MCP contracts.
10. Refresh automatic backup after every new mutation, restore it, and export schema v2.
11. Reject the old routes, tools, targets, and overview schema.

#### Task 5.2: Run Quality, Performance, Packaging, and Native Gates

- Run TypeScript typecheck, lint, format check, full coverage, compiled E2E, and evals.
- Run overview benchmark and compare with the recorded baseline/budget.
- Build and test the macOS app with Swift coverage.
- Run static Omarchy validation and evidence validation.
- Run macOS live E2E locally.
- Run the opt-in Omarchy Quattro live E2E on the exact target machine before release evidence is
  accepted.
- Run `npm pack --dry-run` and verify docs, OpenAPI-related runtime, native artifacts, and README
  cover are included as intended.

#### Task 5.3: Strict Post-Review

- Run `devtronic:post-review --strict`.
- Fix every requirement, architecture, quality, security, documentation, and regression finding.
- Repeat all affected gates after fixes.

---

## Task Dependencies

```yaml
dependencies:
  0.1: []
  0.2: [0.1]
  1.1: [0.1]
  1.2: [0.2, 1.1]
  1.3: [1.2]
  1.4: [1.3]
  1.5: [1.4]
  1.6: [1.3, 1.4, 1.5]
  2.1: [1.6]
  2.2: [2.1]
  2.3: [2.1]
  2.4: [2.1]
  3.1: [1.6]
  3.2: [3.1]
  3.3: [3.1]
  3.4: [3.2, 3.3]
  4.1: [1.6]
  4.2: [2.2, 2.3, 2.4, 3.4, 4.1]
  5.1: [2.2, 2.3, 2.4, 3.4, 4.1]
  5.2: [4.2, 5.1]
  5.3: [5.2]
```

Parallelizable groups after their direct dependencies:

- Task 1.1 can proceed while the v1 fixture is finalized.
- Tasks 2.2, 2.3, and 2.4 can run in parallel after the HTTP/gateway contract is stable.
- Tasks 3.1 and 4.1 can run in parallel with Phase 2 after Store behavior is stable.
- macOS and Omarchy updates can run in parallel from the same frozen overview v2 fixture.
- Documentation and E2E can proceed in parallel once their upstream contracts are frozen.

---

## Risk Analysis

### Edge Cases

- [ ] A v1 database has multiple Projects in every lifecycle state and active/expired Claims.
- [ ] A migrated Project has empty PRD Markdown and therefore receives a draft Spec.
- [ ] Context names collide across Workspace and Project scopes but remain independent.
- [ ] A Task parent points outside its Spec or attempts a third nesting level.
- [ ] Project/Spec state changes race with Claim creation or renewal.
- [ ] Cancellation races with completion and must have exactly one atomic winner.
- [ ] All Specs are cancelled; the Project cannot imply successful delivery accidentally.
- [ ] A paused Project contains live Claims created immediately before pause.
- [ ] Terminal Context mutation and stale revisions fail without partial writes.
- [ ] Export sees no Claims at check time but a new Claim races with serialization.
- [ ] Backup destination disappears during a cancellation cascade.
- [ ] Native clients encounter stale overview v1 after daemon upgrade.

### Technical Risks

| Risk                                    | Severity | Mitigation                                                                                       |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| SQLite table rebuild loses data         | Critical | One transaction, semantic inventory, foreign-key check, rollback injection, real v1 fixture      |
| Historical events point to wrong entity | High     | Explicit per-event migration map and assertions for Project-vs-Spec identity                     |
| Cancellation leaves orphaned Claims     | High     | Immediate transactions and descendant-count/claim assertions                                     |
| Store becomes harder to maintain        | Medium   | Extract migrations and pure rules; keep one facade; prohibit compatibility branches              |
| Contract drift across five clients      | High     | Shared TS schemas, strict OpenAPI tests, canonical fixtures, frozen desktop contract             |
| Old native app misreads new overview    | Medium   | Overview schema version `2` and strict incompatible-state handling                               |
| Overview query regresses                | Medium   | Purpose-built indexes, bounded output, query-plan review, benchmark                              |
| Existing uncommitted README assets lost | Medium   | Preserve unrelated working-tree changes; no destructive git commands                             |
| Live Quattro target unavailable         | Medium   | Finish static/package gates, clearly hold release evidence until exact-target live test succeeds |

---

## Testing Strategy

### Unit Tests

- Pure lifecycle transition matrices and terminal-state exhaustiveness.
- Readiness and claim eligibility.
- Scoped Context identity and pagination.
- Project/Spec/Task/Subtask ownership and nesting.
- Cancellation cascades and event payloads.
- Overview precedence, counts, sorting, and bounds.
- Export path safety and schema version.
- Client parsing and actionable error normalization.

### Integration Tests

- Fresh v2 schema and populated v1 migration.
- Rollback on migration failure and future-version rejection.
- Competing transactions, revisions, Claims, cancellation, and completion.
- HTTP authentication and every canonical resource route.
- MCP catalog/schema/effects and stdio bridge.
- CLI named commands plus generic `tools`/`call`.
- Automatic backup coalescing and failure isolation for new mutations.
- OpenAPI `$ref`, operation, auth, and old-contract absence.

### End-to-End Tests

- Compiled daemon/CLI/MCP/HTTP workflow with multiple Projects and Specs.
- Real backup, restore, restart, and portable export.
- Install/status/uninstall preserving migrated data.
- macOS native contract and live app lifecycle.
- Omarchy static plugin and exact-target live lifecycle.

### Manual Verification

1. Open the macOS menu app against seeded v2 data and verify Project rows, active Spec/Task titles,
   status count, help, Settings, Quit, and Finder opening.
2. Repeat on Omarchy Quattro and verify bar state, popout hierarchy, backup controls, `xdg-open`,
   offline recovery, and uninstall restoration.
3. Inspect a schema-v2 portable export as plain JSON/Markdown and continue an agent session from the
   restored database.

---

## Done Criteria

### Phase 0: Tests as Definition

- [x] Spec-test manifest exists: `test -f thoughts/tests/2026-08-26_domain-model-v2.md`.
- [x] Generated spec tests fail for missing v2 behavior before implementation.
- [x] Generated spec tests remain unchanged during implementation: verify with Git diff/hash.
- [x] Populated v1 fixture covers every entity, state, Claim category, completion field, artifact,
      and Context body.

### Phase 1: Domain and Migration

- [x] Fresh database reports `PRAGMA user_version = 2` and passes `PRAGMA foreign_key_check`.
- [x] Populated v1 migration preserves semantic inventory exactly and is idempotent on reopen.
- [x] Injected migration failure leaves the v1 database unchanged and startup fails actionably.
- [x] All transition, cancellation, ownership, terminality, revision, and claim invariants pass unit
      and integration tests.
- [x] Every successful new mutation triggers automatic-backup dirtying; failed mutations do not.

### Phase 2: Public Contracts

- [x] MCP `tools/list` exposes the canonical v2 catalog with exact schemas and no old aliases.
- [x] HTTP `/api/v1` and OpenAPI expose Project and Spec resources with no old PRD routes.
- [x] CLI help and named commands use `spec` and work target `<spec|task>` exclusively.
- [x] Old routes/tools/targets return deterministic not-found or validation errors.
- [x] Authentication, pagination, payload limits, retryability, and error suggestions remain intact.

### Phase 3: Overview and Native

- [x] Overview schema version is `2`; v1 is rejected as incompatible by native clients.
- [x] Project/Spec/Task counts and active-work rollups match seeded Store state.
- [x] macOS tests and Swift coverage pass with no layout/interaction regression.
- [x] Omarchy static validation and plugin tests pass with no interaction regression.
- [x] Frozen desktop contract hashes are updated only after reviewed test/fixture diffs.

### Phase 4: Portability and Documentation

- [x] Portable export schema version `2` matches the documented hierarchy and contains no token or
      live Claim.
- [x] Backup/restore preserves the complete migrated model and can continue accepting work.
- [x] README, MCP docs, eval rubric, OpenAPI, CLI help, and v1 supersession notice agree exactly.
- [x] Repository scan finds PRD only as a described form of Spec or in migration/history context.

### Phase 5: Overall Quality

- [x] All spec tests pass.
- [x] No generated spec-test file was modified after freezing.
- [x] `npm run typecheck` passes.
- [x] `npm run lint` passes with zero warnings.
- [x] `npm run format:check` passes.
- [x] `npm test` passes with 100% statements, branches, functions, and lines.
- [x] `npm run test:evals` passes every real workflow without mocks or partial credit.
- [x] `npm run test:macos` passes the enforced Swift coverage threshold.
- [ ] `npm run validate:omarchy` passes; `npm run test:e2e:omarchy` awaits fresh Quattro evidence.
- [x] macOS live E2E passes locally.
- [ ] Omarchy live E2E passes on the exact Quattro target before release evidence is accepted.
- [x] `npm pack --dry-run` includes only intended runtime/docs/native artifacts and the README cover.
- [x] No TODO, FIXME, HACK, compatibility alias, or dual v1/v2 contract remains.
- [x] `devtronic:post-review --strict` reports no unresolved findings.

---

## Verification Commands

The repository uses npm (`package-lock.json`). Run after implementation:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:evals
npm run benchmark:overview
npm run test:macos
npm run validate:omarchy
npm run test:e2e:macos
npm run test:e2e:omarchy
npm pack --dry-run
```

On the exact Omarchy Quattro target, from a clean full checkout:

```bash
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
```

Finish with `devtronic:post-review --strict` and repeat every gate affected by its fixes.
