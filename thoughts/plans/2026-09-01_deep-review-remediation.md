# Implementation Plan: Deep-review remediation

**Date**: 2026-09-01
**Status**: Draft — awaiting approval
**Source review**:
[2026-09-01_deep-review.md](../reviews/2026-09-01_deep-review.md) (128 findings: 21 high, 62
medium, 45 low)

---

## Overview

Resolve every finding of the 2026-09-01 deep review without changing the product's shape. The
daemon, the SQLite store, the HTTP/MCP adapters, the packaged runtime, the macOS app and the
Omarchy plugin stay. The work falls into three kinds:

1. **Defects that block users today** (update channel, Omarchy mirror and helper, sync hashing,
   macOS install topology and onboarding lifecycle, Linux restart, installer recovery race).
2. **Contract hygiene** (OpenAPI drift, duplicated schemas and error codes, catalog gaps, locks,
   receipts, connectors, documentation that contradicts the code).
3. **Test honesty and structure** (source-text greps counted as acceptance, frozen hashes re-pinned
   weekly, fixtures the producer no longer emits, five oversized units, ~2,000 duplicated lines).

Phases 1 to 4 ship as hotfix releases. Phases 5 to 7 form one minor release. Phases 8 and 9 run
continuously behind the quality gate and ship whenever a phase gate passes.

Every task names the finding ids it closes. The coverage matrix at the end maps all 128 ids to a
task; a task is done when its findings are struck from the review report.

## Planning Preconditions

- The review report is the source of truth for scope. Fixing a finding differently from its
  recommendation is fine; leaving one unaddressed requires an explicit "won't fix" entry in the
  report.
- Frozen contracts follow the CLAUDE.md rule: amend the spec or DoD first, then refresh the digest
  in `scripts/check-desktop-status-contract.mjs`. Task 0.1 decides once which files stay frozen.
- macOS changes are verified from an installed copy outside the checkout, never from
  `platforms/macos/dist/`. `npm run approve:macos` needs a clean tree with committed inputs.
- Omarchy runtime digests come from CI output, never from a macOS build.
- No live Omarchy, Quattro or systemd host was available during the review. Phase 4's gate needs
  one; the Quattro runbook in `thoughts/notes/2026-08-28_quattro-live-runbook.md` applies.
- Package manager: npm (`package-lock.json`). Quality gate after every change:
  `npm run typecheck && npm run lint && npm run format:check && npm test`.

---

## Requirements

- [ ] `update:check` and `update` succeed from a packaged install on macOS against the real
      release channel; on Omarchy they either succeed or fail with a typed `unavailable` that names
      `pimpampum-bootstrap`.
- [ ] `omarchy plugin add` installs the version that npm and GitHub Releases carry.
- [ ] Two devices with different locales converge through a shared folder.
- [ ] A managed, an adopted and an installed-CLI macOS topology all pass `status`, `uninstall`
      and reinstall from the installed CLI, and uninstall never writes outside the home directory.
- [ ] The guided setup survives the overview poll, the help button and a relaunch, and shows every
      partial failure.
- [ ] A Linux update over a running daemon passes health verification.
- [ ] Concurrent `status` polls during an update cannot alter the installed runtime.
- [ ] The npm tarball ships no macOS app or runtime.
- [ ] The OpenAPI document is generated from the Zod schemas and every route is documented.
- [ ] Every CLI verb is in `CLI_COMMANDS`, parsed by the catalog parser, and rejects unknown
      flags.
- [ ] No acceptance test asserts source text except the negative security greps; every fixture is
      produced by the code it pins; frozen hashes exist only where the report keeps them.
- [ ] No `src/` function exceeds 100 body lines or cyclomatic 25 outside the declarative files
      listed in the report (`openapi.ts` until generated, `cliCommands.ts`, `schemas.ts`,
      `*Contract.ts`, `types.ts`, `limits.ts`, `errors.ts`).
- [ ] README, plugin README, `llms.txt` and the site describe the shipped product and are on the
      release checklist.

---

## Current Architecture and Reuse Boundaries

### Reuse unchanged

- `PimpampumStore` as the only SQLite owner; domain rules; revision guards; completion as an
  operation.
- Typed `AppError` codes preserved through HTTP, MCP and CLI.
- Receipt-hashed ownership before deletion; journaled runtime transactions; strict archive
  parsing; allow-listed subprocess environments in `src/connectors/process.ts`.
- `createSetupLifecycleLock` in `src/setup/state.ts` (becomes the one lock).
- Swift coverage gate and its manifest (widened, not replaced).

### Extend deliberately

- `application-path.json` gains `managed: boolean` and becomes the single source of truth for
  where the macOS app lives.
- Sync snapshots gain `schemaVersion: 2` with code-unit canonical order.
- The release pipeline gains a signed manifest, a rolling channel release, a mirror job and a
  draft-first publish.
- `SetupStore` moves out of a conditionally rendered view.
- OpenAPI `components.schemas` become generated output.

---

## Approach Analysis

### Option A: Severity waves with a hotfix train

Fix the release-blocking highs first in small releases, then contract hygiene in one minor, then
tests and structure continuously.

**Pros**: users get working updates and installs within days; each wave has its own gate; refactors
land on code that already has honest tests. **Cons**: some files are touched twice (for example
`cliMain.ts` in Phases 1, 6 and 9).

### Option B: Structure first

Split `executeCli`, `runCliEntrypoint`, `PimpampumStore` and `manager.install` first, then fix
defects on the new shape.

**Pros**: fixes land once. **Cons**: the release channel and the Omarchy mirror stay broken for
weeks; refactors run on a suite that asserts implementation text, so regressions hide.

### Option C: Highs only

Fix the 21 highs and stop.

**Pros**: smallest. **Cons**: leaves the causes (duplicated contracts, view-owned lifecycle,
grep tests) that produced the highs; the user asked for all of them.

### Recommendation

Option A. Phases 1 to 4 are the hotfix train (target `v1.2.12` to `v1.2.14`). Phases 5 to 7 are
`v1.3.0`. Phases 8 and 9 ship with whichever release is next once their gate passes.

---

## Architecture Decisions

### Update channel

Sign `release-manifest.json` with the existing Ed25519 verifier contract. Publish it and
`pimpampum-release-public-key.pem` to a rolling GitHub release `update-channel-stable`, and embed
the public key as a constant in `src/update.ts` (env override only under
`PIMPAMPUM_DEV_RELEASE_KEY=1`). `boundedFetchBytes` follows at most three redirects, HTTPS only,
from `github.com` to `*.githubusercontent.com`; integrity stays the signed sha256 and size. The
manifest gains `issuedAt`; the client rejects a manifest older than the last accepted one.

### Sync canonical form

`canonicalJson` and `normalizedSyncState` sort by UTF-16 code units. Snapshots carry
`schemaVersion: 2`. A `schemaVersion: 1` snapshot is accepted when its hash matches under
code-unit order (true for every snapshot produced under C or English locales) and otherwise
reported as `blockedSnapshot` with an upgrade message. A snapshot with `schemaVersion > 2` is
reported the same way.

### macOS location and instance policy

`application-path.json` becomes `{ schemaVersion: 2, path, managed }` written at install. Every
later operation (`status`, `uninstall`, `install`, relaunch) reads it; the parent-directory
heuristic is used only when no record exists. Swift reads the same file; the constant
`~/Applications/Pimpampum.app` disappears from both languages. `shouldStandDown` compares
`bundleURL` and skips terminated peers.

### Setup session ownership

`SetupStore` is owned by `OverviewStore` (or the App) as a `SetupSession` that outlives the
conditional view. `StatusPopover` renders the onboarding while `session.isActive`, regardless of
`connectionState`. The help button is hidden while a session is active.

### One lock, one atomic write, one rollback ladder

`createSetupLifecycleLock` replaces the manager lock; `src/fsAtomic.ts` replaces the nine
partial-then-rename copies; `allOrAggregate` (moved to `src/aggregateRollback.ts`) replaces the 13
hand-written ladders. Receipts, journals and settings all fsync file and directory.

### Generated OpenAPI

`components.schemas` come from `z.toJSONSchema` over `src/schemas.ts` and the `*Contract.ts`
schemas; `paths` stay hand-written but a test walks the Express router and diffs it.

### Test policy

Hash pins remain only on the four overview fixtures. `@immutable` headers are removed; each
acceptance test keeps its spec-id comment. Source-text assertions survive only as negative security
checks in one `source-contract` suite that the DoD does not count as acceptance. Fixtures are
generated by the producer in-test or by a checked-in script that the test re-runs.

---

## Files to Create or Modify

| File                                                                              | Action   | Purpose                                                                      |
| --------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `scripts/sign-release-manifest.mjs`                                               | Create   | Sign `release-manifest.json`, emit key fingerprint, verify before upload     |
| `scripts/check-omarchy-mirror.mjs`                                                | Create   | Compare mirror HEAD manifests with the tag                                   |
| `scripts/check-package-size.mjs`                                                  | Create   | Fail when the tarball exceeds a budget or contains the app or runtime        |
| `scripts/check-release-versions.mjs`                                              | Create   | Tag == `package.json` == `server.json` == site                               |
| `.github/workflows/release.yml`                                                   | Modify   | Draft release, publish, undraft, sign manifest, mirror job, scoped tokens    |
| `.github/workflows/quality.yml`                                                   | Modify   | Drop duplicate E2E, add concurrency, site build, size gate, print manifests  |
| `package.json`                                                                    | Modify   | `files` without `platforms/macos/dist`, fixtures, evidence; scripts          |
| `platforms/macos/dist/.npmignore`                                                 | Create   | Belt and braces until the app leaves the package                             |
| `src/update.ts`                                                                   | Modify   | Embedded key, redirect policy, `issuedAt`, Linux `reconcile` or typed error  |
| `src/cliMain.ts`                                                                  | Modify   | Fetch policy, lazy composition, catalog routing, split into composition mods |
| `src/cliComposition/*.ts`                                                         | Create   | Platform adapters, connector setup, packaged lifecycle, input readers        |
| `src/cliHandlers/*.ts`                                                            | Create   | One handler module per `CLI_COMMANDS` group; `executeCli` becomes a table    |
| `src/cliCommands.ts`                                                              | Modify   | Declare `setup retry`, `--events`, `--keep`, `--device`; banner text         |
| `src/cliProgram.ts`                                                               | Modify   | Route every verb through `parseCommandArguments`; typed error mapping        |
| `src/syncState.ts`                                                                | Modify   | Code-unit ordering, `schemaVersion: 2`, versioned hash                       |
| `src/syncContract.ts`                                                             | Modify   | `slugSchema` for context names; `schemaVersion` union; retention fields      |
| `src/syncController.ts`                                                           | Modify   | `blockedSnapshot`, mutation counter, retention, drop `baseState`             |
| `src/syncValidation.ts`                                                           | Create   | Pure `validateSyncState` extracted from the store                            |
| `src/store.ts` → `src/store/*.ts`                                                 | Refactor | Phantom workspace filter, child-first deletes, chunked `NOT IN`, split       |
| `src/backup.ts`                                                                   | Modify   | Reject separators in context export; temp copy inside data dir; dedupe       |
| `src/fsAtomic.ts`                                                                 | Create   | One fsynced partial-then-rename writer                                       |
| `src/aggregateRollback.ts`                                                        | Create   | `allOrAggregate` shared by service, setup, connectors, installer             |
| `src/errors.ts`                                                                   | Modify   | Export `ERROR_CODES` consumed by client, protocol, OpenAPI                   |
| `src/schemas.ts`                                                                  | Modify   | Add completion, release, lease, cancel schemas; remove dead ones             |
| `src/openapi.ts`                                                                  | Refactor | `components.schemas` generated from Zod                                      |
| `src/http.ts`                                                                     | Modify   | 405 on `/mcp`, no `X-Powered-By`, JSON 404, lookahead paging, route modules  |
| `src/mcp.ts`                                                                      | Modify   | Logger + `onerror`, shared schemas, `manifestAfter()` helper                 |
| `src/server.ts`                                                                   | Modify   | Lock takeover by rename, close sync controller on listen failure             |
| `src/config.ts`                                                                   | Modify   | `loadConfig({ createToken: false })` for clients                             |
| `src/agentClient.ts`, `src/client.ts`                                             | Modify   | Status-based error mapping, encoded path segments                            |
| `src/service/macosApp.ts`                                                         | Modify   | `managed` record, adopted guards, missing bundle, control files last, pkill  |
| `src/service/manager.ts`                                                          | Refactor | Shared lock, `Transaction` helper, `install()` split                         |
| `src/service/systemd.ts`                                                          | Modify   | `restart` after `enable --now`; `Environment=` quoting                       |
| `src/service/platform.ts`                                                         | Modify   | Timeout, allow-listed env, `maxBuffer` aligned with parse caps               |
| `src/service/receipt.ts`                                                          | Modify   | fsync; typed unreadable-receipt error naming the repair                      |
| `src/setup/coordinator.ts` → `src/setup/{guided,lifecycle}.ts`                    | Refactor | `retryConnector` precondition; two modules; remove journal on uninstall      |
| `src/setup/state.ts`, `src/runtime/installer.ts`, `src/runtime/manifest.ts`, …    | Modify   | Zod parsers replacing 24 hand-written `parse*`                               |
| `src/runtime/installer.ts` → `src/runtime/{receipt,journal,install,removal}.ts`   | Refactor | Read-only inspect, lock-scoped recovery, repair on drift, fsync payload      |
| `src/runtime/archive.ts`                                                          | Refactor | Split `validateZip`/`validateTarGzip`                                        |
| `src/connectors/core.ts`                                                          | Create   | Shared plan/apply/rollback/disconnect/receipt for both hosts                 |
| `src/connectors/codex.ts`, `src/connectors/claudeCode.ts`                         | Refactor | Host-specific invocations only; memoized `detect()`                          |
| `src/connectors/registry.ts`                                                      | Modify   | Delete `planDisconnect`, `disconnectInvocation`, `receiptProvesEntry`        |
| `src/connectors/verifier.ts`                                                      | Modify   | SIGKILL after close deadline                                                 |
| `integrations/omarchy/pimpampum-status/pimpampum-connections`                     | Modify   | Remove `ulimit -f`; forward `cliCode` and bounded message                    |
| `integrations/omarchy/pimpampum-status/pimpampum-common.sh`                       | Create   | Shared HOME/receipt/launcher prologue                                        |
| `integrations/omarchy/pimpampum-status/*.qml`                                     | Modify   | Envelope unwrap in `UpdateService`, copy, `ServiceControl` deferral, split   |
| `integrations/omarchy/pimpampum-status/README.md`                                 | Modify   | Agents helper in the boundary; one install story                             |
| `scripts/validate-omarchy-plugin.mjs`                                             | Modify   | Enumerate QML with `readdirSync`; named checks                               |
| `scripts/test-omarchy-live.mjs`                                                   | Refactor | Verify installed bytes against candidate; decompose runner                   |
| `scripts/check-desktop-status-contract.mjs`                                       | Modify   | Pin only the four overview fixtures                                          |
| `scripts/check-swift-coverage.sh`                                                 | Modify   | Add the five lifecycle Swift files to the manifest                           |
| `platforms/macos/Sources/PimpampumMenuBar/{App,StatusPopover,SetupStore,…}.swift` | Modify   | `SetupSession`, stand-down by URL, button state, journal policy, help width  |
| `platforms/macos/Sources/PimpampumMenuBar/EmbeddedSetupBootstrap.swift`           | Modify   | Read `application-path.json`; no managed-path constant                       |
| `platforms/macos/Tests/PimpampumMenuBarTests/*`                                   | Modify   | Session lifecycle, two-path stand-down, regenerated plan fixture             |
| `test/helpers/*.ts`                                                               | Create   | `tmp`, `git`, `compiledDaemon`, `service`, `setupDependencies`, `connector`  |
| `test/**`                                                                         | Modify   | Per Phase 8 tasks                                                            |
| `README.md`, `docs/*.md`, `site/**`, `site/public/llms.txt`                       | Modify   | Per Phase 7 tasks                                                            |
| `thoughts/specs/*`, `thoughts/tests/*`, `thoughts/plans/*`                        | Modify   | Amendments, statuses, DoD tables                                             |
| `CHANGELOG.md`                                                                    | Create   | Per-release user-facing notes; release checklist                             |

---

## Implementation Phases

### Phase 0 — Decide the test contract and lay the helpers

#### Task 0.1: Decide what stays frozen and amend the DoDs

**Findings**: H-14 (policy half)
**Files**: `thoughts/tests/2026-08-26_desktop-status-integrations.md`,
`thoughts/tests/2026-08-27_real-development-session-evals.md`,
`thoughts/tests/2026-08-31_zero-friction-local-agent-setup.md`,
`scripts/check-desktop-status-contract.mjs`

- Record the decision from the report: hash pins stay on `test/fixtures/overview/*.json` only.
- Rewrite each DoD's Immutability table as a traceability table (spec id → test file → status), and
  update the "Initial status" columns to the real state.
- Reduce the checker to the four fixtures; keep the amendment comment pattern at its top.
- This task gates every later edit to a currently frozen test file.

#### Task 0.2: Shared test helpers

**Findings**: enabler for M-T7, M-T8, L-35 and the duplication rows of section 6
**Files**: `test/helpers/tmp.ts`, `test/helpers/git.ts` (from
`test/macos-source-hash.test.ts:18-39`), `test/helpers/compiledDaemon.ts` (port, spawn, stop with
SIGKILL fallback, envelope unwrap), `test/helpers/service.ts` (`adapterContext`, `success`,
`acknowledgingOpen`), `test/helpers/setupDependencies.ts`, `test/helpers/connectorHarness.ts`

- Create the helpers with the behaviour of the best existing copy; migrate callers opportunistically
  in the phase that touches each file. No behaviour change.

**Gate 0**: DoD tables are honest; `check:desktop-contract` passes on the four fixtures; helpers
exist and `npm test` is green.

### Phase 1 — Release channel and distribution (hotfix `v1.2.12`)

#### Task 1.1: Make the packaged update channel real

**Findings**: H-01, M-V9 (embedded key), L-15, L-16
**Depends on**: none
**Files**: `src/update.ts`, `src/cliMain.ts:249,290-392,553-589,640-642,877-883`,
`scripts/sign-release-manifest.mjs`, `scripts/package-release-assets.sh`,
`.github/workflows/release.yml`, `test/cli-update-wiring.test.ts`, `test/update.test.ts`,
`README.md:103-104`

- Embed the release public key as a constant; accept `PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH` only
  with `PIMPAMPUM_DEV_RELEASE_KEY=1`.
- Generate the signing key pair once, store the private key as a repository secret, and add a
  release step that runs `sign-release-manifest.mjs` and uploads `release-manifest.json` plus the
  public key to the rolling `update-channel-stable` release (create it if absent, replace assets).
- `boundedFetchBytes`: manual redirect following, max 3 hops, HTTPS only, allowlist `github.com`
  → `*.githubusercontent.com`, size cap preserved across hops. Replace the test that pins
  `redirect: 'error'` with tests for allowed, disallowed host, downgrade to HTTP and hop limit.
- Add `issuedAt` to the manifest; persist the last accepted `issuedAt` in the update receipt and
  reject older manifests.
- `isNewerVersion`: split the prerelease at the first hyphen; replace the dead base64 try/catch
  with a strict regex.
- Linux: either implement `reconcile` for `linux-x64`/`linux-arm64` (tar.gz runtime through the
  systemd and Omarchy adapters) or make `usesPackagedRelease` on Linux return a typed
  `unavailable` whose suggestion names `pimpampum-bootstrap`. Decide at task start; record it in
  the README. The E2E in this task must cover the chosen behaviour.
- E2E: a local HTTPS-less test server that answers 302 then 200 for the manifest and the asset
  shape the pipeline emits; `update:check` resolves it.

#### Task 1.2: Publish the Omarchy plugin mirror from the release

**Findings**: H-02
**Depends on**: none
**Files**: `.github/workflows/release.yml`, `scripts/check-omarchy-mirror.mjs`, `package.json`

- Add a `mirror` job after `publish`: `git subtree split --prefix
integrations/omarchy/pimpampum-status`, push to `r-bart/pimpampum-omarchy` with a deploy key,
  tag `v<version>`, then verify that the mirror's `runtime-manifest.json` sha256 equals
  `check-omarchy-delivery`'s `runtimeManifestSha256`.
- `check:omarchy-mirror` compares the mirror HEAD manifests with the local ones; run it in
  `quality.yml` as a warning and in `release.yml` as a gate after the push.
- Push the 1.2.11 plugin to the mirror by hand once, using the same script, and record it in a
  note.

#### Task 1.3: Stop shipping the macOS app in npm and in Git

**Findings**: H-12, L-38
**Depends on**: 1.1 (installs fetch the app through the channel)
**Files**: `package.json:8-23`, `platforms/macos/dist/.npmignore`, `.gitignore`,
`scripts/check-package-size.mjs`, `scripts/prepare-package.mjs`, `src/cliMain.ts` (packaged
install source), `.github/workflows/quality.yml`

- Remove `platforms/macos/dist`, `test/fixtures/overview` and `thoughts/evidence/*.example.json`
  from `files`; add the `.npmignore` for `**/PimpampumRuntime/**` as a second guard.
- `pimpampum install` on macOS from an npm install downloads the release zip through the channel
  from Task 1.1 and verifies it with the existing inventory checks; document the change.
- Stop tracking the app binary: keep `platforms/macos/dist/` as a build output, move the approval
  record (`check-macos-artifact.mjs`) to hash the built artifact from the release job. Do not
  rewrite history; the pack stops growing from the next release.
- `check-package-size.mjs`: `npm pack --dry-run --json`, fail above 10 MB unpacked or when any
  path matches `PimpampumRuntime|Pimpampum.app`. Run it in the PR `macos` job.

#### Task 1.4: Release workflow hygiene

**Findings**: M-O1, M-O2, M-O6, L-30, L-31, L-32, L-37, D-08
**Depends on**: none
**Files**: `.github/workflows/release.yml`, `.github/workflows/quality.yml`,
`scripts/check-reviewed-runtime-manifest.mjs:80-82`, `scripts/check-release-versions.mjs`,
`package.json:52-59`, `site/src/pages/index.astro`

- Order: `gh release create --draft` with every asset → `npm publish` (skip when `npm view
pimpampum@<v>` already answers) → `gh release edit --draft=false` → mirror job.
- Move `permissions: contents: write, id-token: write` into `publish` and `mirror`; every other
  checkout gets `persist-credentials: false`; SHA-pin `actions/*`.
- Print the generated runtime manifest on digest mismatch and upload it as a workflow artifact
  from the `runtime-manifest` job; add that job to `release.yml` before `publish`.
- Remove `test:evals` from both workflows (it duplicates `test:e2e` inside `npm test`); run
  `validate:omarchy` once; add `concurrency` groups.
- `npm audit --omit=dev --audit-level=high` on the tag; keep the strict form in a weekly
  scheduled job.
- Run `npm install --global npm@11` before every `npm ci` on Node 22 jobs so `allowScripts` is
  honoured, or drop the field and document the decision.
- `check-release-versions.mjs`: tag == `package.json` == `server.json` (both fields) == the version
  the site reads from `package.json` at build time (replace the two literals).
- Decide `develop` CI: add `push: branches: [develop]` to `quality.yml` or document in
  CLAUDE.md that only PRs are gated. Recommendation: add it.

**Gate 1**: a tag run publishes the signed manifest and key, the mirror carries the same version,
the tarball is under budget, and `pimpampum update:check` from a packaged macOS install returns
the current version. Release `v1.2.12`.

### Phase 2 — Sync integrity (hotfix `v1.2.13`)

#### Task 2.1: Locale-independent canonical form

**Findings**: H-04
**Depends on**: none
**Files**: `src/syncState.ts:8,27,34-37`, `src/syncContract.ts:125`, `src/syncController.ts:543-579`,
`test/sync-state.test.ts`, `test/sync-controller.test.ts`

- Replace every `localeCompare` with a code-unit comparator; sort `ids` at `:66` the same way.
- Snapshots write `schemaVersion: 2`; the reader accepts 1 and 2 per the architecture decision and
  reports anything else as blocked.
- Fixture with keys and ids `aa`, `ab`, `å`, `ch`, `ci`, `I`, `i`, `İ`; assert the canonical string
  byte for byte; run that test under `LANG=da_DK.UTF-8` and `cs_CZ.UTF-8` in `quality.yml`.

#### Task 2.2: No phantom workspace

**Findings**: H-05
**Depends on**: none
**Files**: `src/store.ts:303-308,2020`, `test/store.test.ts`, `test/sync-acceptance.test.ts`

- `resolveWorkspace` skips `rootPath === ''`; sync-imported unresolved workspaces resolve to
  `not_found` until the user attaches a path.
- Test: import a snapshot with an unresolved workspace, resolve a path under `process.cwd()`,
  expect `not_found`; create a project by path, expect `not_found`.
- Follow-up recorded for Phase 9: nullable `root_path` instead of the sentinel.

#### Task 2.3: Sync contract hardening

**Findings**: H-11, M-C1, M-C2
**Depends on**: 2.1
**Files**: `src/syncContract.ts:63`, `src/backup.ts:87`, `src/store.ts:1580-1582`,
`src/migrations.ts:67`, `test/sync-acceptance.test.ts`, `test/store.test.ts`

- Context `name` uses `slugSchema`; `writeContextExport` rejects any separator or `..` even if
  the schema is bypassed.
- `deleteMissingSyncRows`: load remote ids into a temporary table and delete with `NOT IN
(SELECT id FROM temp)`, or chunk at 900 ids; delete tasks with `parent_id IS NOT NULL` first.
- Tests: snapshot that removes parent and child together; 33,000 tasks import; export with a
  hostile synced name stays inside the export directory.

#### Task 2.4: Sync operability

**Findings**: M-S4, M-S5, M-S6, M-S7, L-01
**Depends on**: 2.1, 2.3
**Files**: `src/syncController.ts:160,313,402-427,473,490-541,654-670,719`, `src/syncContract.ts`,
`src/store.ts:483`, `src/types.ts`, `thoughts/specs/2026-08-26_shared-folder-sync.md`

- `SyncStatus.blockedSnapshot: { path, reason }` when a pending file fails validation; the error
  detail names the relative path; a newer `schemaVersion` says "upgrade Pimpampum on this
  device".
- Store-level mutation counter bumped by the write path; `publish()` returns early when it has not
  moved since the last publish; the poll keeps importing.
- Amend the sync spec with a retention rule: each snapshot carries the heads its device has
  applied; a device deletes its own snapshots older than the oldest head every known device has
  acknowledged; `appliedSnapshotIds` is compacted to ids still referenced.
- Drop `baseState` (optional in the schema for one release).
- Map `cancelled_at` into `types.ts` and `SyncState` or drop the column write.

#### Task 2.5: Sync scenario tests

**Findings**: M-T3
**Depends on**: 2.4
**Files**: `test/sync-acceptance.test.ts`

- Two controllers configured with the same `deviceId` on one folder: assert the observable state
  and that `forget` plus reconfigure recovers.
- Mixed-locale convergence: two stores, one publishing under a Danish comparator stub, converge
  after Task 2.1.

**Gate 2**: `sync-acceptance` covers locale, duplicate device, parent+child delete and 33,000
tasks. Release `v1.2.13`.

### Phase 3 — macOS install topology and onboarding (hotfix `v1.2.14`)

#### Task 3.1: One record for where the app lives

**Findings**: H-06, H-07, M-V1, M-V2, M-V3, L-20, L-21
**Depends on**: none
**Files**: `src/service/macosApp.ts:210-225,376-384,446-531,598-606,616-618,655-676,737-755`,
`src/service/types.ts:104-108`, `src/service/manager.ts:494-528`, `test/service-macos-app.test.ts`

- `application-path.json` schema 2 with `managed`; `applicationLocation` reads it first and falls
  back to the parent heuristic only when absent; migrate schema 1 on read.
- `afterUninstall`: guard `removeEmbeddedRuntimeSource` and `removeEmptyAppDirectories` with
  `managed`; delete control files last; `prepareDeactivationRollback` snapshots and restores them.
- `deactivate`: when the bundle is missing, skip unregistration, stop the daemon, remove files,
  return `manualInstructions` ("Remove Pimpampum from System Settings › Login Items").
- Login item: poll until the request's `expiresAt`; on timeout return `loginItem: 'error'` and
  keep the install (same for unregistration).
- Escape regex metacharacters before `pkill -f`; verify `codesign --verify --deep --strict` on a
  managed copy after `installation.json` is written; if it fails, move the marker to
  `~/.pimpampum`.

#### Task 3.2: Manager-level topology tests

**Findings**: M-T1
**Depends on**: 3.1, 0.2
**Files**: `test/service-macos-app.test.ts:295-415`, `test/helpers/service.ts`

- Three lifecycle tests through `createPlatformServiceManager`: managed copy from Downloads;
  adopted bundle in `~/Applications`; installed CLI with `appBundlePath` pointing at the runtime
  and a recorded path. Each asserts the `open` argv, the receipt, `status()`, and that uninstall
  leaves an adopted bundle byte-identical. Remove the `.catch(() => undefined)`.

#### Task 3.3: Setup session survives the view

**Findings**: X-01, X-05, X-03, X-04, X-07, X-09
**Depends on**: none (Swift only), 6.3 for the CLI side of X-04
**Files**: `platforms/macos/Sources/PimpampumMenuBar/{OverviewStore,StatusPopover,SetupStore,SetupOnboardingView,HelpDialog}.swift`,
`platforms/macos/Tests/PimpampumMenuBarTests/*`

- Introduce `SetupSession` owned by `OverviewStore`; `StatusPopover` renders the onboarding while
  the session is active regardless of `connectionState`; pause overview polling while a mutation
  is in flight.
- Hide the help button while a session is active; when a `running` journal exists at start, poll
  `setup status` instead of invoking `setup resume`.
- Disable the confirmation button while `plan == nil || errorMessage != nil`; replace the spinner
  with an error row and "Try again"; make `review()` await idleness.
- Rehydrate only `running` journals; add "Start over" on step 4 for `failed` and `complete`.
- `HelpDialog` uses `maxWidth: .infinity`; add a `sizeThatFits` assertion at 360 pt.
- Delete `beginReview`, `cancelBeforeMutation`, `canCancel`; guard `prepareApp()` behind
  `!requiresInstalledApplicationRelaunch`.

#### Task 3.4: Relaunch and single instance

**Findings**: X-02, X-06
**Depends on**: 3.1
**Files**: `App.swift:17-25`, `EmbeddedSetupBootstrap.swift:16-66,99-114`,
`platforms/macos/Tests/PimpampumMenuBarTests/SingleInstanceTests.swift`, `src/cliMain.ts:646,745-748`

- `shouldStandDown` only for a peer whose `bundleURL` equals `Bundle.main.bundleURL` and
  `!isTerminated`; the relauncher passes `--relaunched-from <pid>` so the newcomer waits for that
  pid to exit before evaluating peers.
- Swift reads `application-path.json` (schema 2, absolute, no NUL) for the relaunch target; the
  packaged updater in `cliMain.ts` reads the same record; the managed-path constant disappears.

#### Task 3.5: Widen the Swift coverage manifest

**Findings**: section 8 structural note; H-14 (Swift half)
**Depends on**: 3.3, 3.4
**Files**: `scripts/check-swift-coverage.sh:29-48`, `thoughts/notes/2026-08-26_swift-coverage.md`

- Add `SetupStore.swift`, `SetupCommandRunner.swift`, `App.swift` (delegate logic extracted to a
  testable type), `EmbeddedSetupBootstrap.swift` and the `SetupSession`; extract the remaining
  view logic into presentation types until 100% holds. Replace `ZeroFrictionSetupAcceptanceTests`
  source-text assertions with behaviour tests.

#### Task 3.6: Register a Workspace without Terminal

**Findings**: D-01
**Depends on**: 3.3; spec amendment to `thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md`
**Files**: `src/setup/coordinator.ts`, `src/cliProgram.ts`, `SetupOnboardingView.swift:346-358`,
`StatusPopover.swift:313`, `StatusPopout.qml:579`, `pimpampum-control-route`, `README.md`

- Amend the spec: the final setup step and the empty state offer "Add a workspace" (folder picker
  → `workspace:add` through the control launcher).
- Omarchy empty state shows the absolute launcher, not a bare `pimpampum`.
- README documents the launcher path per platform under `Install and connect`.

**Gate 3**: `npm run test:macos` at 100% on the widened manifest; live smoke from an installed
copy outside the checkout passes the three topologies and a full guided setup with two agents;
`test-macos-live.mjs` labels updated where the first screen changed. Release `v1.2.14`.

### Phase 4 — Linux, Omarchy plugin and runtime installer (hotfix `v1.2.15`)

#### Task 4.1: Omarchy helpers and QML

**Findings**: H-03, M-O4, M-O5, L-27, L-28, L-29, L-33, L-34
**Depends on**: none
**Files**: `integrations/omarchy/pimpampum-status/{pimpampum-connections,pimpampum-common.sh,pimpampum-bootstrap,pimpampum-plugin-lifecycle,pimpampum-control-route}`,
`{AgentConnectionService,UpdateService,ServiceControl,StatusPopout}.qml`,
`scripts/validate-omarchy-plugin.mjs:141-164,217-229`, `test/omarchy-connections.test.ts`,
`test/omarchy-bootstrap.test.ts`

- Remove `ulimit -f`; keep the post-hoc 64 KiB output check.
- Forward `cliCode` (filtered `^[a-z_]{1,40}$`) and a control-character-stripped 200-char message
  from the stderr envelope; QML renders them like `actionableProcessError`.
- `pimpampum-common.sh` sourced by absolute path, listed in `executableHelpers` and the
  validator; every helper rejects control characters and `'` in HOME.
- `UpdateService.qml` unwraps both shapes; copy stops naming npm; `ServiceControl.qml` defers
  through `Qt.callLater`.
- `--proto-redir =https` in bootstrap; lifecycle `remove` cleans `runtime/<version>/`;
  `uname -n` instead of `hostname`.
- Validator enumerates `.qml` with `readdirSync`.
- Tests: fake launcher writing a 200 KiB file; HOME with spaces and non-ASCII.

#### Task 4.2: systemd restart and Omarchy detection

**Findings**: H-08, L-19, M-V8
**Depends on**: none
**Files**: `src/service/systemd.ts:38-65,251-266`, `src/cliMain.ts:947-956`,
`test/service-systemd.test.ts:539-543`

- After `enable --now`, run `restart` when `previousState.running` (mirror `kickstart -k`).
- Separate quoting for `Environment=`.
- Probe `omarchy version` lazily inside adapter selection so `setup` and `update` detect Omarchy.

#### Task 4.3: Installer recovery, repair and durability

**Findings**: H-09, M-R1, M-R5, L-24, L-25
**Depends on**: none
**Files**: `src/runtime/installer.ts:175-185,626-642,699-789,815-819`, `src/runtime/bootstrap.ts:85`,
`integrations/omarchy/pimpampum-status/pimpampum-bootstrap:332-343`, `test/runtime-installer.test.ts`,
`test/runtime-installer-fs-faults.test.ts`

- `inspectInstalledRuntime` becomes read-only; recovery runs only inside lifecycle-locked entry
  points (try-acquire; skip with "installation in progress" when held).
- Owned destination with drift: quarantine via the removal journal, rename the staged payload in,
  record `replacedFinal` so rollback restores the quarantined copy.
- Compute `finalExists` and launcher identity before staging; fsync copied entrypoints and the
  native addon before `renameSync`.
- Bootstrap: after staging and smoke, call `node dist/cli.js install` from the staged payload so
  TypeScript writes launchers and receipt; keep a contract test that parses the shell output with
  `parseReceipt` until the switch lands.
- Test: inject a concurrent `inspectInstalledRuntime` between journal write and receipt write.

#### Task 4.4: Bounded service commands

**Findings**: M-V5
**Depends on**: none
**Files**: `src/service/platform.ts:26-44`, `src/connectors/process.ts`, callers in `src/cliMain.ts`,
`test/service-platform.test.ts`

- `runServiceCommand` gains a default timeout (per-call override for `open` on first launch),
  `killSignal`, an allow-listed environment (no `PIMPAMPUM_TOKEN`), and `maxBuffer` equal to the
  largest parse cap; timeouts become a typed error naming the executable.

#### Task 4.5: Omarchy evidence and test realism

**Findings**: M-O3, M-O7, M-T7, M-T8 (Omarchy files)
**Depends on**: 4.1, 0.2
**Files**: `scripts/test-omarchy-live.mjs:1290-1404`, `test/service-omarchy.test.ts:97-241,698-742`,
`test/fixtures/omarchy/*`, `test/omarchy-bootstrap.test.ts`, `test/omarchy-plugin-lifecycle.test.ts`

- Delete the helper templates; compare installed bytes with the staged candidate; import
  `executableHelpers` from `check-omarchy-delivery.mjs`.
- Capture real `omarchy version`, `plugin list --json`, `plugin validate`, shell IPC outputs from
  the Omarchy host into fixtures; `fakeQuattro` replays those bytes; a check fails when a fixture
  is missing for a command the adapter issues.
- `stdio: 'pipe'` on the helper spawn and assert exit 69 with the refusal text; Git through
  `test/helpers/git.ts` with `--quiet`.
- Build the tarball once per file; copy the plugin tree from a cached copy.

**Gate 4**: Omarchy live run (`PIMPAMPUM_RUN_LIVE_OMARCHY`) passes install, connect Claude Code
with a 200 KiB `~/.claude.json`, update over a running daemon, and uninstall; Quattro evidence is
recorded. Release `v1.2.15`.

### Phase 5 — Adapter contracts (`v1.3.0`)

#### Task 5.1: Generated OpenAPI

**Findings**: H-10, L-09
**Depends on**: 5.2
**Files**: `src/openapi.ts:706-1426`, `src/http.ts:263-269,327-333,470-476`, `test/openapi.test.ts`

- `components.schemas` from `z.toJSONSchema` over `schemas.ts`, `overviewContract.ts`,
  `backupContract.ts`, `syncContract.ts`; delete the hand-written 720 lines and the dead
  `SyncConflict` component.
- Test walks `app.router.stack` and diffs `{method, path}` against `paths`; one round-trip test
  per contract type validates a real body against the generated schema.
- Keep one of each alias route pair.

#### Task 5.2: One catalogue for codes and schemas

**Findings**: M-A4, M-A5, M-C3, L-11
**Depends on**: none
**Files**: `src/errors.ts`, `src/client.ts:54-64`, `src/agentProtocol.ts:110-122`, `src/openapi.ts:728-739`,
`src/schemas.ts`, `src/mcp.ts:51-57,139-143,351-362,378-390,525-540,677-688,875-961`,
`src/http.ts:284-291,551-555`, `src/store.ts:393`

- `ERROR_CODES` exported once; OpenAPI derives its list minus `unavailable` with a comment.
- Add `completeProjectSchema`, `releaseSchema`, lease, cancel and update schemas to `schemas.ts`;
  MCP and HTTP import them; remove `contextOwnerTypeSchema`/`expectedRevisionSchema` duplicates.
- The "nothing to update" guard moves into the store (`updateProject`, `updateSpec`,
  `updateTask`), so MCP and HTTP share it; `work_complete` uses `input.targetType`.

#### Task 5.3: HTTP and MCP hygiene

**Findings**: M-A1, M-A2, M-A3, M-A6, M-A7, M-A8, L-07, L-08, L-10, L-12
**Depends on**: none
**Files**: `src/http.ts:55-57,130-132,589-602`, `src/mcp.ts:104-117,973-976`, `src/server.ts:27-42,108-117`,
`src/config.ts:32-58`, `src/agentClient.ts:50-79`, `src/client.ts:252-506`, `src/mcpStdio.ts:7`,
`test/http.test.ts`, `test/server.test.ts`

- `run()` logs non-`AppError` failures; `createMcpHandler({ onerror })`.
- `app.all('/mcp')` → 405 `Allow: POST` JSON; `app.disable('x-powered-by')`; global JSON 404.
- `pageData` uses lookahead (`limit + 1`) on the four endpoints.
- `normalizeClientError` maps status like `client.ts:66-75`.
- Instance lock: `renameSync` takeover, re-verify, catch ENOENT; listen failure closes the sync
  controller.
- `loadConfig({ createToken: false })` for the stdio bridge and CLI; `unavailable` with the
  install suggestion when the token is missing.
- `/health` gains a `SELECT 1` probe or the README documents it as liveness.
- `encodeURIComponent` on every path segment in `client.ts`.
- Tests: `POST /mcp` without `Authorization` → 401; foreign `Host`/`Origin` → 403; `GET /mcp` → 405.

#### Task 5.4: Store and CLI correctness

**Findings**: M-C4, M-C5, M-C6, L-02, L-03, L-04, L-05, L-06, L-14, L-17, L-18
**Depends on**: none
**Files**: `src/store.ts:191,206-214,339,491-495,542,676,836,1026,1055,1194-1201,1409-1423,1548-1550,2066,2113`,
`src/overview.ts`, `src/automaticBackup.ts:166-175`, `src/cliProgram.ts:335-341,1006,1056,1096-1106`,
`src/agentClient.ts:62`, `src/cliMain.ts:1539-1540`, tests

- Claims via LEFT JOIN; claim-free manifest mappers; fingerprints from `activity_events`.
- `work.revoked` event with `agentId` and reason on cascade cancel; `ownedClaim` distinguishes a
  terminal target.
- `AutomaticBackupController` starts in state `error` on a corrupt settings file.
- Delete the four dead `list*` methods and their coverage tests; page markdown on code points;
  `cancelProject` uses `changed()`; injectable clock with expiry-boundary tests; overview ordering
  in one place with a >500 projects test.
- `--body-file` through `readBoundedUtf8File`, read failures → `bad_request` naming the path;
  `backup retry` returns the data; typed codes replace the `conflict`/`not found` regexes.

**Gate 5**: `openapi.test.ts` walks the router; no schema literal in `mcp.ts` or `http.ts`
duplicates `schemas.ts`; `ERROR_CODES` has one definition.

### Phase 6 — CLI composition and service/setup hardening (`v1.3.0`)

#### Task 6.1: Lazy composition

**Findings**: M-S1
**Depends on**: none
**Files**: `src/cliMain.ts:905-934,1489-1530`, `src/config.ts:57-74`, `src/runtime/bootstrap.ts:90-124`,
`src/update.ts:114-116,514-527`, `test/cli-program.test.ts`

- `loadConfig` splits into a pure read and `ensureDataDirectory`; `help`, `version`, `commands`,
  `config` perform no filesystem writes.
- Update manager, setup, connections and service managers are built behind thunks resolved on
  first use; receipt and bootstrap failures surface only for the verbs that need them, with a
  suggestion that fits the install kind.

#### Task 6.2: Complete catalog

**Findings**: M-S2, M-S3, X-08
**Depends on**: none
**Files**: `src/cliCommands.ts`, `src/cliProgram.ts:290-320,534-604,770-863,1080-1170`,
`test/cli-agent-surface.test.ts`, `README.md` CLI reference block, `scripts/`, `integrations/`,
`platforms/`

- Declare `setup retry`, `--events`, `--keep`, `--device` with a `native: true` annotation; the
  banner names the NDJSON event stream as the third envelope exception.
- Route every verb, including zero-argument ones, through `parseCommandArguments(describe())`.
- Test iterating `CLI_COMMANDS`: `<verb> --definitely-unknown` → `bad_request`.
- Regenerate the README block; sweep `scripts/`, `integrations/`, `platforms/` for output changes.

#### Task 6.3: One lock, durable receipts, retry preconditions

**Findings**: M-V4, M-V6, M-V7; CLI half of X-04
**Depends on**: none
**Files**: `src/service/manager.ts:47-76,757`, `src/setup/state.ts:487,555-646`, `src/service/receipt.ts:105-156`,
`src/setup/coordinator.ts:649-700`, tests

- Delete the manager lock; reuse `createSetupLifecycleLock`; `status` waits up to 5 s instead of
  failing.
- `writePrivateFileAtomic` fsyncs file and directory; an unreadable receipt raises a typed error
  naming the path and the repair (`pimpampum uninstall --force-receipt` or documented deletion).
- `retryConnector` requires `service.verify` in `completedPhases`; `resume` re-runs incomplete
  base phases regardless of status; uninstall supersedes the journal.

#### Task 6.4: Update trust freshness

**Findings**: M-V9 (remaining), L-13
**Depends on**: 1.1
**Files**: `src/update.ts`, `src/cliMain.ts`, `src/backup.ts:109-148`

- Reject manifests whose `issuedAt` is older than the last accepted (persisted in the update
  receipt); tests for replay.
- Backup temp copies are created inside the 0700 data directory.

#### Task 6.5: Connector core

**Findings**: M-R2, M-R3, M-R4, L-22, L-23, L-26
**Depends on**: 0.2
**Files**: `src/connectors/core.ts`, `src/connectors/codex.ts`, `src/connectors/claudeCode.ts`,
`src/connectors/registry.ts`, `src/connectors/process.ts:25`, `src/connectors/verifier.ts:308-313`,
`src/cliProgram.ts:692,708`, `src/cliMain.ts:118-122`, tests

- `createHostConnectorCore` owns plan/apply/rollback/disconnect/receipt; hosts supply
  `addInvocation`, `removeInvocation`, `inspectEntry`, `parseEntry`, `legacyEntries`. One
  `connect` contract (throw with a typed code) and one `inspect` error contract.
- `detect()` memoized per instance; `inspectEntry` and `snapshot()` receive the detection; drop
  the duplicate `--version`.
- Delete `planDisconnect`, `disconnectInvocation`, `receiptProvesEntry`,
  `redactConnectorDiagnostics`, `parseRuntimeTargetId` with their tests.
- Config cap 16 MiB with a bounded diagnostic on `unavailable`; `--replace <revision>`; SIGKILL
  after the verifier's close deadline.

**Gate 6**: `pimpampum help` succeeds with a read-only HOME; one connect spawns at most 12
processes per host (assert in tests); `service/manager.ts` imports the setup lock.

### Phase 7 — Documentation and site (`v1.3.0`)

#### Task 7.1: One install story

**Findings**: D-03, D-04, D-05, D-10, D-11
**Depends on**: 1.1 (README update copy), 3.6 (launcher paths)
**Files**: `README.md`, `integrations/omarchy/pimpampum-status/README.md`, `site/public/llms.txt`,
`docs/agents.md`, `docs/mcp-tools.md`, `src/agentProtocol.ts:30-31`

- Plugin README leads with `omarchy plugin add`; `pimpampum install` is the CLI-first alternative;
  `llms.txt` matches `docs/agents.md` (stop and ask the operator); decide whether the `unavailable`
  suggestion names the operator action.
- Plugin README security boundary adds `pimpampum-connections` and its verb list; the Agents card
  joins the card list and `manifest.json`.
- "What gets installed where" table; document `PIMPAMPUM_RELEASE_*` variables (or remove them
  after Task 1.1); complete the agent error table; fix the site's omission list.

#### Task 7.2: Site

**Findings**: D-02, D-09
**Depends on**: 1.4 (version from `package.json`)
**Files**: `site/src/pages/index.astro`, `site/astro.config.mjs`, `site/public/robots.txt`,
`site/README.md`, `site/AGENTS.md`, `.github/workflows/quality.yml`

- Rewrite `Get it` from the README: app and plugin first, npm under "advanced", delete the
  Terminal sentence.
- `site` URL, `@astrojs/sitemap`, canonical and Open Graph tags, `Sitemap:` in `robots.txt`,
  boilerplate replaced, `astro build` in CI.

#### Task 7.3: Process artefacts

**Findings**: D-06, D-07, D-12, D-13; section 10 items
**Depends on**: 0.1
**Files**: `README.md:723-724`, `thoughts/plans/*.md` headers, `thoughts/specs/2026-08-25_desktop-status-integrations.md`,
`docs/evals.md`, `AGENTS.md`, `loop.manifest.yaml`, `.ai-template/manifest.json`, `thoughts/SUMMARY.md`,
`.claude/rules/architecture.md`, `site/public/llms.txt:122-123`, `CHANGELOG.md`

- Name the coverage exclusions next to the 100% claim (or remove the sentence once Task 9.2
  un-excludes `cliMain.ts`).
- Set every shipped plan's status with its tag; amend the 2026-08-25 spec about signing; fix the
  eval count.
- `AGENTS.md` points to CLAUDE.md for process; `format:check` in the loop gate; delete
  `.ai-template/manifest.json` or regenerate it; delete `thoughts/SUMMARY.md` or make it an index;
  fill `architecture.md` with the real rules; `blob/master` in `llms.txt`.
- `CHANGELOG.md` with entries from v1.2.9 onward; a release checklist section in CLAUDE.md
  (site, `llms.txt`, plugin README, plan statuses, version check).

**Gate 7**: a new user following only the README installs on macOS or Omarchy and registers a
workspace without Terminal; `check-release-versions.mjs` passes; the site builds in CI.

### Phase 8 — Test honesty (continuous, ships with `v1.3.x`)

#### Task 8.1: Retire source-text acceptance

**Findings**: H-13
**Depends on**: 0.1
**Files**: `test/omarchy-plugin.test.ts:89-452`, `test/desktop-status.acceptance.test.ts:349-459`,
`test/backup-settings-ui.acceptance.test.ts`, `test/omarchy-agents-ui.test.ts`,
`test/runtime-release-integration.test.ts`, `test/omarchy-connections.test.ts:174-203`,
`test/quattro-live-runner.test.ts:464-471`, `test/macos-live-gates.test.ts:231-278`,
`test/zero-friction-surfaces.acceptance.test.ts`, `test/zero-friction-runtime.acceptance.test.ts:280-305`,
`test/zero-friction-lifecycle-security.acceptance.test.ts:364-386`

- Keep negative security greps (no `sh -c`, no token, no write verbs) in one
  `test/source-contract.test.ts`; delete the rest or move layout assertions into a `qml6`
  `grabToImage` harness; render launchd/systemd artefacts through their adapters and parse them;
  export the live runner's scenario table and assert on data; parse workflow YAML.
- Update the DoD traceability tables so grep-backed rows say "source contract", not "acceptance".

#### Task 8.2: Execute the frozen-hash decision

**Findings**: H-14 (execution half)
**Depends on**: 0.1
**Files**: `test/desktop-status*.acceptance.test.ts`, `test/quattro-live-evidence.acceptance.test.ts`,
`test/zero-friction-*.acceptance.test.ts`, `test/agent-cli.acceptance.test.ts:151`,
`test/development-sessions.e2e.test.ts`

- Remove `@immutable` headers; keep spec-id comments; delete the `project_update_prd` call and
  validate tool names against `canonicalTools`; convert dynamic imports with local casts to static
  imports.

#### Task 8.3: Fixtures from producers

**Findings**: H-15
**Depends on**: 3.3 (Swift fixture consumer)
**Files**: `test/fixtures/setup/plan-envelope.json`, `test/setup-envelope-shape.test.ts`,
`test/fixtures/connectors/**`, `test/connectors-*.test.ts`, `test/fixtures/overview/*.json`,
`test/desktop-status.acceptance.test.ts:47-62`, `platforms/macos/Tests/.../SetupOnboardingCopyTests.swift`

- Generate the setup fixture in-test from `runCli(['setup','plan'])` with the real coordinator and
  a temp data directory; the Swift test reads the regenerated file and asserts four changes with
  paths.
- Drive `detect()`/`inspect()` tests from `test/fixtures/connectors/scenarios.json`; refresh the
  fixtures from the current Codex and Claude Code releases and record versions.
- One test builds the `mixed` scenario in a real store, serves it through `createHttpApp`, and
  deep-compares (ids and timestamps normalised) with `test/fixtures/overview/mixed.json`;
  regenerate the fixtures from that path.

#### Task 8.4: Replace doubles and tautologies

**Findings**: H-16, L-36
**Depends on**: 0.2
**Files**: `test/coverage-closure.test.ts`, `test/cli-update-coverage-pass2.test.ts:133-156`,
`test/setup-coordinator-branch-hardening.test.ts`, `test/openapi.test.ts`, `test/core.test.ts:585-617`,
`test/cli-program.test.ts:136-210`, `test/sync-controller.test.ts:187-277,402-428,656-690`,
`test/migration-indexes.test.ts:22-27`, `test/domain-model-v2.migration.acceptance.test.ts`

- Real v1 database with a three-level task in the migration acceptance test; delete the fake
  `better-sqlite3` double; share the faithful v1 DDL helper with `migration-indexes`.
- CLI mapping as a table `[argv, clientMethod, expectedArgs]` for all 49 commands; delete the
  "not Unknown command" test; delete the delegation tautology; coordinator tests assert journal
  and plan store state, not mock arguments.
- Sync-controller branches through the public surface (bad snapshot on disk, read-only settings
  dir); `v8 ignore` with justification where unreachable.

#### Task 8.5: Suite mechanics

**Findings**: H-17, M-T2, M-T4, M-T5, M-T6, M-T8 (rest), M-T9, L-35
**Depends on**: 0.2
**Files**: `test/sync-e2e.test.ts` → `test/sync.e2e.test.ts`, `test/e2e.test.ts`,
`test/service-omarchy.test.ts:842-1420`, `test/service-macos-app.test.ts`, `test/runtime-installer-fs-faults.test.ts`,
`test/service-macos-fs-faults.test.ts`, `test/setup-state-fs-faults.test.ts`,
`test/connectors-targeted-branches.test.ts`, `test/update.test.ts:26-31`, `test/core.test.ts:44-50`,
`test/macos-package-artifact.test.ts:111`, `thoughts/tests/*`

- Rename and guard the sync E2E; pipe daemon stderr into failures; SIGKILL fallback.
- E2E: 20 parallel claims → one 200, nineteen 409; the same through stdio MCP `work_start`.
- Keep hook-level tests with one stated invariant each; move sequence checks to manager scenarios;
  `it.each` with a message per variant; exact messages instead of `/loopback|port|Log directory/`.
- Fault injection by path with the named post-condition; SDK spies replaced by the `spawn` seam;
  `closeSync` asserted with the descriptor; delete `service-macos-fs-faults.test.ts` (superset
  exists).
- Temp `bin/node` + `bin/npm` for `resolveNpmPath`; clear `PIMPAMPUM_*` in `beforeEach`; record
  the darwin-only artifact gate in the DoD; per-describe synthetic MCP server; fake timers for the
  250 ms grace.

**Gate 8**: no test file outside `test/source-contract.test.ts` matches `toContain\(.*\)` against
a source path; `check-desktop-status-contract.mjs` pins four files; the wall time of the slowest
test file is under 8 s; `npm run test:unit` passes on a checkout without `dist/`.

### Phase 9 — Structure (continuous, ships with `v1.3.x` / `v1.4.0`)

#### Task 9.1: Table-driven CLI

**Findings**: section 6 (`executeCli`), duplication row R
**Depends on**: 6.2
**Files**: `src/cliProgram.ts:618-1170`, `src/cliHandlers/*.ts`

- One handler module per `CLI_COMMANDS` group; `executeCli` dispatches from the table; a single
  argument-parsing strategy.

#### Task 9.2: Composition out of `cliMain.ts`

**Findings**: section 6 (`runCliEntrypoint`, `createConcretePackagedProvider`); coverage exclusion
**Depends on**: 6.1
**Files**: `src/cliMain.ts`, `src/cliComposition/{platformAdapters,connectorSetup,packagedLifecycle,packagedUpdateProvider}.ts`,
`src/cliInput.ts`, `vitest.config.ts:9`

- `composeCliRuntime(host)` with an injected host `{platform, arch, homeDirectory, execPath, argv,
env, findExecutable, runCommand, config}`; uninstall and install transactions in
  `service/packagedLifecycle.ts`; bounded readers in `cliInput.ts`; entrypoint under 30 lines.
- Remove `src/cliMain.ts` from the coverage exclusion; keep `cli.ts` and `daemon.ts`.

#### Task 9.3: Store by aggregate

**Findings**: section 6 (`PimpampumStore`), duplication rows B, C, G, S, T, U, V; H-05 follow-up
**Depends on**: 2.2, 5.4
**Files**: `src/store.ts` → `src/store/{transaction,activity,workspaces,projects,specs,tasks,context,claims,overview,sync}.ts`,
`src/syncValidation.ts`, `src/migrations.ts`

- Façade `PimpampumStore` over aggregate modules sharing a `StoreContext`; `load<R,T>()`,
  `bumpRevision()`, one cascade cancel, one `getCompletion`; `validateSyncState` pure; event writer
  with an options object; nullable `root_path` migration.

#### Task 9.4: Shared primitives

**Findings**: section 6 duplication (atomic write, rollback ladder, `isRecord`, `redactDiagnostic`,
tree walk, Zod parsers), `manager.install`
**Depends on**: 6.3
**Files**: `src/fsAtomic.ts`, `src/aggregateRollback.ts`, `src/fsGuards.ts`, `src/service/manager.ts:568`,
`src/setup/state.ts`, `src/runtime/{installer,manifest}.ts`, `src/connectors/codex.ts`,
`src/service/omarchy.ts`, `src/syncController.ts:22`

- Migrate the nine atomic writes and the 13 ladders; one `isRecord`, one `redactDiagnostic`, one
  symlink-rejecting walk; `assertNoSymlinkTraversal` moves to `fsGuards.ts`.
- `manager.install` → `reconcileExisting` + `installFresh` over a `Transaction` helper.
- The 24 hand-written `parse*` become Zod schemas in the style of `service/receipt.ts`.

#### Task 9.5: Runtime modules

**Findings**: section 6 (`archive.ts`, `installer.ts`)
**Depends on**: 4.3
**Files**: `src/runtime/archive.ts`, `src/runtime/{receipt,journal,install,removal}.ts`

- `validateZip` → `readEndRecord`, `readCentralDirectory`, `validateLocalEntry`,
  `validateDataDescriptor`; a map of extra-field validators; `parseTarHeader`.
- `installer.ts` split so the lock boundary from Task 4.3 is a module boundary.

#### Task 9.6: Native surfaces

**Findings**: section 6 (`StatusPopout.qml`, QML services, Swift duplication)
**Depends on**: 3.5, 4.1
**Files**: `integrations/omarchy/pimpampum-status/*.qml`, `platforms/macos/Sources/PimpampumMenuBar/*.swift`

- `StatusPopout.qml` → `PortfolioPage`, `SettingsPage`, `HelpPage` behind a `Loader`;
  `PimpampumCard`, `HoverSurface`, `PortfolioRow`, `ManagedFolderCard`; a `QtObject` controller
  for the 27 functions and 18 flags; `BackupService`/`SyncService` share a `ManagedFolderService`;
  one state vocabulary source generated for QML and Swift.
- Swift: one `DaemonClient` base for the three HTTP clients, one ISO-8601 decoder, one
  `DirectoryOpener`, one row button. Preview every QML layout change in the `qml6` harness.

#### Task 9.7: Scripts

**Findings**: section 6 (live runners and validators), duplication rows for `scripts/`
**Depends on**: 4.5
**Files**: `scripts/lib/{hashTree,waitFor,isInside,parseCliEnvelope,checks}.mjs`, `scripts/test-omarchy-live.mjs`,
`scripts/test-macos-live.mjs`, `scripts/check-quattro-evidence.mjs`, `scripts/validate-omarchy-plugin.mjs`

- Shared helpers; named check functions with one assertion each replacing
  `invariant(a && … && m)`; the Omarchy runner decomposed into `LiveSession`, a declarative seed
  table, `CaptureFlow`, `EvidenceWriter`, `ProcessRunner`.

**Gate 9**: no `src/` unit over 100 body lines or cyclomatic 25 outside the declarative list;
`cliMain.ts` covered; `StatusPopout.qml` under 400 lines; the duplication table of the report
re-run shows no group over 40 lines.

---

## Task Dependencies

```yaml
dependencies:
  0.1: []
  0.2: []
  1.1: []
  1.2: []
  1.3: [1.1]
  1.4: []
  2.1: []
  2.2: []
  2.3: [2.1]
  2.4: [2.1, 2.3]
  2.5: [2.4]
  3.1: []
  3.2: [3.1, 0.2]
  3.3: []
  3.4: [3.1]
  3.5: [3.3, 3.4]
  3.6: [3.3]
  4.1: []
  4.2: []
  4.3: []
  4.4: []
  4.5: [4.1, 0.2]
  5.1: [5.2]
  5.2: []
  5.3: []
  5.4: []
  6.1: []
  6.2: []
  6.3: []
  6.4: [1.1]
  6.5: [0.2]
  7.1: [1.1, 3.6]
  7.2: [1.4]
  7.3: [0.1]
  8.1: [0.1]
  8.2: [0.1]
  8.3: [3.3]
  8.4: [0.2]
  8.5: [0.2]
  9.1: [6.2]
  9.2: [6.1]
  9.3: [2.2, 5.4]
  9.4: [6.3]
  9.5: [4.3]
  9.6: [3.5, 4.1]
  9.7: [4.5]
```

Parallel execution opportunities:

- Phases 1 to 4 have no cross-phase dependencies; four people (or four sessions) can run them at
  once. Within Phase 1, 1.1, 1.2 and 1.4 are independent.
- Phase 3's Swift tasks (3.3) and TypeScript tasks (3.1) are independent until 3.4.
- Phases 5 and 6 are independent of each other; 5.2 must precede 5.1.
- Phase 8 tasks depend only on Phase 0 (and 3.3 for the Swift fixture); they can start on day one.
- Phase 9 waits for the defect fixes in the files it restructures so each refactor lands on tested
  code.

---

## Risk Analysis

### Technical risks

| Risk                                                                           | Severity | Mitigation / stop condition                                                                                     |
| ------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| Sync hash version 2 splits a fleet in mixed versions                           | High     | Reader accepts v1 by code-unit re-hash; a blocked v1 snapshot names the device to upgrade; release notes say so |
| Redirect following widens the update trust surface                             | Medium   | HTTPS only, three hops, host allowlist, signed sha256 and size still mandatory; tests for each rejection        |
| Removing the app from the npm package breaks `pimpampum install` for npm users | High     | Task 1.3 depends on 1.1; the CLI downloads the signed zip through the channel; E2E against a local 302 server   |
| `managed` record migration on existing installs                                | Medium   | Schema 1 read as `managed = (path == managedPath)` once, then rewritten as schema 2                             |
| Swift `SetupSession` refactor touches every onboarding test                    | Medium   | Widen the coverage manifest in the same PR; live smoke from an installed copy is the gate                       |
| systemd `restart` on Omarchy cannot be verified locally                        | Medium   | Gate 4 requires a live Omarchy run before `v1.2.15`; ship 4.1 alone as `v1.2.15` if the host is unavailable     |
| Installer recovery inside the lock changes the CLI start path                  | Medium   | `inspectInstalledRuntime` read-only first (safe), recovery moved second, fault-injection test in between        |
| OpenAPI generation changes documented shapes for existing clients              | Low      | Diff the generated document against the current one; only the drift rows in the report should change            |
| Deleting grep tests drops the coverage number below 100%                       | Medium   | Coverage is measured on `src/`; grep tests cover nothing in `src/`; verify per file before deleting             |
| Store split regresses transaction boundaries                                   | High     | Keep the façade and the `store.test.ts` suite unchanged through the split; one aggregate per PR                 |

### Edge cases

- A user with a `schemaVersion: 1` snapshot produced under Danish locale that never applied: stays
  blocked with a message; deleting the file from the shared folder is the documented recovery.
- Adopted bundle deleted before uninstall on an old install without `application-path.json`:
  Task 3.1's missing-bundle path returns `manualInstructions`.
- Omarchy user who ran `pimpampum setup apply` before Task 4.2: `pimpampum install` reconciles
  and installs the plugin.
- A pre-1.3 CLI reading a schema 2 `application-path.json`: the reader ignores unknown keys, so
  downgrade keeps working.

---

## Testing Strategy

### Unit and contract tests

- Every task lists its tests; a task without a new or changed test is only allowed for
  documentation and process items.
- Contract tests generated from producers (Task 8.3) replace committed fixtures.
- Router walk and body round-trips guard OpenAPI (Task 5.1).

### Integration tests

- Compiled E2E: update channel against a local 302 server; 20 parallel claims; stdio mutation;
  `sync.e2e` renamed and guarded.
- Manager-level topology tests for macOS (Task 3.2) and fault-injection by path for the installer
  (Task 8.5).

### Live/manual verification

- macOS: installed copy outside the checkout; three topologies; guided setup with two agents;
  help during setup; relaunch from Downloads; uninstall after trashing the app.
- Omarchy: bootstrap, connect Claude Code with a 200 KiB config, update over a running daemon,
  uninstall; Quattro evidence recorded.
- Release: a dry-run tag on a fork or a `-rc` tag exercising draft → publish → undraft → mirror.

---

## Done Criteria

### Hotfix train (Phases 1–4)

- [ ] `pimpampum update:check` and `update` succeed on a packaged macOS install; Omarchy returns
      success or a typed `unavailable` naming `pimpampum-bootstrap`.
- [ ] Mirror HEAD equals the tag; `check:omarchy-mirror` passes.
- [ ] Tarball under 10 MB unpacked with no app or runtime.
- [ ] Locale, duplicate-device, parent+child and 33,000-task sync tests pass.
- [ ] Three macOS topologies pass `status`, `uninstall`, reinstall from the installed CLI.
- [ ] Guided setup with two agents completes with the popover open and shows partial failures.
- [ ] Omarchy live run passes with a real `~/.claude.json` over 64 KiB.
- [ ] Concurrent-inspect fault test passes; systemd restart test passes.

### Contract hygiene (Phases 5–7)

- [ ] OpenAPI `components.schemas` generated; router walk test passes.
- [ ] `ERROR_CODES` defined once; no duplicated Zod literal in adapters.
- [ ] `pimpampum help` and `version` never touch the filesystem; every verb rejects unknown flags.
- [ ] One lifecycle lock; receipts fsynced; retry preconditions enforced.
- [ ] Connector core shared; spawn count asserted.
- [ ] README, plugin README, `llms.txt`, site and plan statuses match the product; version check
      in the release job.

### Test honesty and structure (Phases 8–9)

- [ ] Only `test/source-contract.test.ts` asserts source text.
- [ ] Hash pins only on the four overview fixtures; no `@immutable` header.
- [ ] Every committed fixture is produced by a checked-in script the tests re-run.
- [ ] `cliMain.ts` covered; no `src/` unit over 100 lines or cyclomatic 25 outside the
      declarative list; `StatusPopout.qml` under 400 lines.

### Overall

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` passes after every
      task.
- [ ] `npm run test:macos` passes at 100% on the widened manifest.
- [ ] `npm run test:omarchy` and `npm run check:desktop-contract` pass.
- [ ] Every one of the 128 ids in the coverage matrix is struck from the review report or has a
      "won't fix" entry with a reason.
- [ ] `/summary` written per phase; `/post-review` approves each release.

---

## Verification Order

1. Phase 0 first: DoD tables and helpers, so no later edit hits a frozen file by surprise.
2. After every task: the quality gate. After every phase: the phase gate above.
3. Before each hotfix tag: `npm run test:macos`, `npm run test:omarchy`, live smoke for the
   platform the release touches, `check-release-versions.mjs`.
4. After `v1.2.15`: re-run the review's high-severity checks (curl the channel, `npm view` the
   tarball size, the locale sort, `gh api` the mirror) and strike H-01 to H-09 and H-12.
5. After `v1.3.0`: re-run the duplication and complexity tables from the report; record the
   numbers in the summary.

---

## Coverage matrix

| Finding | Task          | Finding | Task     | Finding | Task     | Finding | Task |
| ------- | ------------- | ------- | -------- | ------- | -------- | ------- | ---- |
| H-01    | 1.1           | M-A1    | 5.3      | M-V1    | 3.1      | L-19    | 4.2  |
| H-02    | 1.2           | M-A2    | 5.3      | M-V2    | 3.1      | L-20    | 3.1  |
| H-03    | 4.1           | M-A3    | 5.3      | M-V3    | 3.1      | L-21    | 3.1  |
| H-04    | 2.1           | M-A4    | 5.2      | M-V4    | 6.3      | L-22    | 6.5  |
| H-05    | 2.2           | M-A5    | 5.2      | M-V5    | 4.4      | L-23    | 6.5  |
| H-06    | 3.1           | M-A6    | 5.3      | M-V6    | 6.3      | L-24    | 4.3  |
| H-07    | 3.1           | M-A7    | 5.3      | M-V7    | 6.3      | L-25    | 4.3  |
| H-08    | 4.2           | M-A8    | 5.3      | M-V8    | 4.2      | L-26    | 6.5  |
| H-09    | 4.3           | M-C1    | 2.3      | M-V9    | 1.1, 6.4 | L-27    | 4.1  |
| H-10    | 5.1           | M-C2    | 2.3      | L-01    | 2.4      | L-28    | 4.1  |
| H-11    | 2.3           | M-C3    | 5.2      | L-02    | 5.4      | L-29    | 4.1  |
| H-12    | 1.3           | M-C4    | 5.4      | L-03    | 5.4      | L-30    | 1.4  |
| H-13    | 8.1           | M-C5    | 5.4      | L-04    | 5.4      | L-31    | 1.4  |
| H-14    | 0.1, 8.2, 3.5 | M-C6    | 5.4      | L-05    | 5.4      | L-32    | 1.4  |
| H-15    | 8.3           | M-O1    | 1.4      | L-06    | 5.4      | L-33    | 4.1  |
| H-16    | 8.4           | M-O2    | 1.4      | L-07    | 5.3      | L-34    | 4.1  |
| H-17    | 8.5           | M-O3    | 4.5      | L-08    | 5.3      | L-35    | 8.5  |
| X-01    | 3.3           | M-O4    | 4.1      | L-09    | 5.1      | L-36    | 8.4  |
| X-02    | 3.4           | M-O5    | 4.1      | L-10    | 5.3      | L-37    | 1.4  |
| X-03    | 3.3           | M-O6    | 1.4      | L-11    | 5.2      | L-38    | 1.3  |
| X-04    | 3.3, 6.3      | M-O7    | 4.5      | L-12    | 5.3      | D-01    | 3.6  |
| X-05    | 3.3           | M-R1    | 4.3      | L-13    | 6.4      | D-02    | 7.2  |
| X-06    | 3.4           | M-R2    | 6.5      | L-14    | 5.4      | D-03    | 7.1  |
| X-07    | 3.3           | M-R3    | 6.5      | L-15    | 1.1      | D-04    | 7.1  |
| X-08    | 6.2           | M-R4    | 6.5      | L-16    | 1.1      | D-05    | 7.1  |
| X-09    | 3.3           | M-R5    | 4.3      | L-17    | 5.4      | D-06    | 7.3  |
| M-S1    | 6.1           | M-T1    | 3.2      | L-18    | 5.4      | D-07    | 7.3  |
| M-S2    | 6.2           | M-T2    | 8.5      |         |          | D-08    | 1.4  |
| M-S3    | 6.2           | M-T3    | 2.5      |         |          | D-09    | 7.2  |
| M-S4    | 2.4           | M-T4    | 8.5      |         |          | D-10    | 7.1  |
| M-S5    | 2.4           | M-T5    | 8.5      |         |          | D-11    | 7.1  |
| M-S6    | 2.4           | M-T6    | 8.5      |         |          | D-12    | 7.3  |
| M-S7    | 2.4           | M-T7    | 4.5      |         |          | D-13    | 7.3  |
|         |               | M-T8    | 4.5, 8.5 |         |          |         |      |
|         |               | M-T9    | 8.5      |         |          |         |      |

128 ids: 17 H, 9 X, 51 M, 38 L, 13 D. Section 6 structure items map to Phase 9; section 10 process
items map to Task 7.3 and Task 1.4.

---

## Approval

Approval authorizes the hotfix train (Phases 1–4) to start immediately and in parallel, and the
remaining phases to proceed as described. It does not authorize rewriting Git history to remove
the committed macOS binaries, changing the sync trust model beyond the retention rule, or
removing the 100% coverage threshold; each of those needs a separate decision.
