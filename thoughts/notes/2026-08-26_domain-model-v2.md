# Domain Model v2 — implementation and strict review notes

**Date**: 2026-08-26
**Plan**: `thoughts/plans/2026-08-26_domain-model-v2.md`
**Verdict**: Strict review approved; exact-target Quattro live evidence pending

## Delivered

- One coherent `Workspace → Project → Spec → Task → Subtask` hierarchy.
- Explicit Project, Spec, and Task lifecycles with terminal cancellation and one-level nesting.
- Claimable ready Specs and open leaf Tasks, with `doing` derived only from live Claims.
- Workspace and Project Context, bounded manifests, explicit Markdown paging, and scoped identity.
- Transactional v1-to-v2 SQLite migration with identity, revision, body, claim, completion, artifact,
  Context, and activity-history preservation.
- Canonical agent surfaces across CLI, MCP, loopback HTTP, OpenAPI, portable export, automatic
  backup, overview, macOS, and Omarchy.
- Four compiled real-workflow E2E evaluations covering CRUD, claims, cancellation, persistence,
  migration, backup/restore, export, HTTP, CLI, and MCP.

## Strict review corrections

- Work filters must validate their Workspace → Project → Spec ancestry instead of treating a
  contradictory scope as an empty result.
- Claim renewal must revalidate current domain eligibility; ownership alone is insufficient after
  lifecycle changes or migrated state.
- Same-agent claim retries are truly read-only and no longer schedule unnecessary automatic
  backups.
- HTTP request objects reject unknown legacy fields instead of letting Zod strip them silently.
- Canonical GET reads return exact manifests; unbounded Spec, Task, and Context Markdown is read
  only through paged body endpoints.
- OpenAPI manifests are closed exact schemas, list pages have typed items, and WorkBundle Context
  pages are explicitly typed.
- Indexed v1 databases recreate all ten canonical v2 indexes only after renamed legacy tables are
  dropped; a real indexed-database regression now protects the SQLite name-retention edge case.
- Overview aggregation uses bounded SQL result sets and aggregate availability counts rather than
  materializing one million candidate work items and every Project.
- Cancelled Projects are visually distinct from successful completion in both native surfaces.
- Activity responses preserve `specId`, public runtime versions agree on `0.1.0`, and migration
  rejects legacy third-level Task nesting before changing schema.
- macOS and Omarchy live-proof scripts now execute the canonical Project → Spec → Task flow and
  reject old Project-as-PRD aliases.

## Verification evidence

- Frozen Domain Model acceptance files: 11/11 passing with both SHA-256 hashes unchanged.
- TypeScript: 36 files, 377 tests, 100% statements, branches, functions, and lines.
- Compiled E2E/evals: 4/4 real workflows passing.
- Overview benchmark: 500 Projects, 500 Specs, 5,000 Tasks; 10.502 ms median on this host.
- macOS: 93 tests; 100% over 590 regions, 155 functions, and 1,095 lines.
- macOS live: clean uninstall/install smoke passed every automated UI, daemon, backup, Finder,
  recovery, reinstall, and cleanup check; the verified final build was then reinstalled and is
  online.
- Omarchy static/plugin validation and 8/8 frozen desktop contract hashes pass.
- Typecheck, zero-warning lint, formatting, diff check, and package dry-run pass.
- Package dry-run contains the README cover, runtime, docs, OpenAPI runtime, native app, plugin,
  fixtures, and no bearer-token material.
- `devtronic:post-review --strict`: approved with no remaining blocker, major, or minor finding.

## Preserved contract decisions

- The immutable populated migration acceptance test requires the three original v1 activity rows
  to remain exactly three after migration. Migration remaps their ownership and targets in place;
  it deliberately does not append a fourth synthetic activity row, because exact history
  preservation is the stronger frozen migration contract.
- Portable export remains an idle maintenance operation and rejects active Claims.
- The product remains local-first, loopback-only, single-user, and intentionally omits web UI,
  sprints, labels, priorities, comments, and multi-machine concurrent SQLite writes.

## External live gate

- Exact Quattro evidence cannot be produced on this macOS host. Run
  `PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live` on the target Omarchy machine, then
  validate the generated evidence with `npm run test:e2e:omarchy`.
