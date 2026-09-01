# Deep review of Pimpampum (2026-09-01)

Read-only review of the whole repository at commit `8c72d8f` (`develop`, v1.2.11).
Nothing was modified. Every finding below was either verified by the lead
(reading the cited lines, running Node, curl, or the registry) or confirmed by
the reviewing agent with a cited trace. Findings whose mechanism is confirmed
but whose trigger was not reproduced say so.

## 1. Executive summary

The codebase is unusually well guarded for its age: one SQLite owner, typed
error codes preserved through every adapter, ownership-hashed receipts before
any deletion, strict archive parsers, journaled install transactions, 100%
statement coverage on the TypeScript core, and a Swift coverage gate at 100%
on its manifest. The domain invariants (completion as an operation, claims as
the only path to work, revision guards) hold everywhere they were probed.

The problems are not in the domain. They sit at the seams the tests cannot
reach: the release channel, the shared-folder sync contract across machines,
the installed-CLI topology on macOS, the Linux update path, and a test suite
whose size (37,000 lines) hides that a large share of it asserts the
implementation against itself. The macOS onboarding adds one more: its
lifecycle state is owned by SwiftUI view identity, so a poll tick can destroy a
setup in progress.

Twelve things to fix first:

1. The packaged update channel does not exist and could not be fetched if it
   did (H-01). Every "Check for updates" button ships broken.
2. The Omarchy plugin mirror is two releases behind and nothing publishes it
   (H-02).
3. `ulimit -f 128` in the Omarchy connections helper kills Claude Code
   connect for any real `~/.claude.json` (H-03).
4. Sync canonical ordering depends on the daemon's locale; mixed-locale
   fleets reject each other's snapshots forever (H-04).
5. A sync-imported unresolved workspace becomes a phantom that matches every
   path (H-05).
6. An installed macOS CLI reclassifies the managed app as adopted and breaks
   `status`, `uninstall` and reinstall (H-06); uninstall also deletes the
   runtime inside a user-owned bundle (H-07).
7. The systemd adapter never restarts a running daemon, so Linux updates
   cannot pass health verification (H-08).
8. Destructive journal recovery runs on every CLI start outside the lifecycle
   lock (H-09).
9. The npm package weighs 157 MB because it ships the macOS app with its
   embedded runtime (H-12).
10. The test suite counts ~900 lines of source-text greps and several
    self-referential fixtures as acceptance coverage (H-13 to H-17).
11. The macOS guided setup can be torn down mid-run by the overview poll, and
    the relaunch can leave no menu-bar app at all (X-01, X-02).
12. A native install has no documented way to register a Workspace, and the
    site describes the pre-1.2 first run (D-01, D-02).

## 2. Scope and method

| Area                                                                                                | Reviewer                     | Verified by lead                               |
| --------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| Domain and store (`src/store.ts`, `domainRules.ts`, `migrations.ts`, `overview.ts`)                 | review-core                  | H-05, M-C2 (SQLite variable limit run live)    |
| HTTP, MCP, OpenAPI adapters                                                                         | review-adapters              | H-10                                           |
| CLI, update, sync (`cliMain.ts`, `cliProgram.ts`, `update.ts`, `syncController.ts`, `syncState.ts`) | review-cli-sync              | H-01, H-04 (Node under six locales)            |
| Service and setup (`src/service/*`, `src/setup/*`)                                                  | review-service-setup         | H-06, H-07, H-08 (code read)                   |
| Runtime and connectors (`src/runtime/*`, `src/connectors/*`)                                        | review-runtime-connectors    | H-09 (code read)                               |
| Omarchy plugin, scripts, CI                                                                         | review-omarchy-ci            | H-02 (live), H-03 (code read), H-12 (registry) |
| Test suite (97 files, five partitions)                                                              | review-tests (5 sub-reviews) | Suite run: green                               |
| macOS Swift app                                                                                     | review-macos (second pass)   | X-01, X-02 (code read on both sides)           |
| Documentation, process, site                                                                        | review-docs (second pass)    | See section 9                                  |
| Architecture, duplication, complexity, security, dependencies                                       | `/audit` skill (7 agents)    | Cross-checked against the reviews above        |

The first pass of `review-macos`, `review-docs` and the consolidation of
`review-tests` was lost to a session limit. Sections 8 and 9 come from a
second pass.

### Baseline measured on this machine

| Metric                                                                  | Value                                                                                                                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck && npm run lint && npm run format:check && npm test` | green                                                                                                                                           |
| Unit + acceptance                                                       | 95 files, 1,025 tests, 5 todo, 100% statements/branches/functions                                                                               |
| Compiled E2E                                                            | 6 tests, green                                                                                                                                  |
| Coverage exclusions                                                     | `cli.ts`, `cliMain.ts` (1,548 lines), `daemon.ts`, `mcpStdio.ts`, `types.ts`                                                                    |
| Swift gate                                                              | 856/856 regions on the manifest; `SetupStore.swift` (56%) and `SetupCommandRunner.swift` (64%) outside it                                       |
| Source size                                                             | `src/` 10,489 lines; `test/` 37,041 lines in 97 files; Swift 7,604 + 6,266 test lines; QML 3,614; Omarchy shell helpers 1,086; `scripts/` 7,130 |
| npm audit                                                               | 0 vulnerabilities; two patch updates pending                                                                                                    |
| Repository                                                              | 182 commits since 2026-08-24, 17 tags, `.git` 64 MB                                                                                             |
| Published package `pimpampum@1.2.11`                                    | 157,648,272 bytes unpacked, 2,733 files                                                                                                         |

## 3. High-severity findings

Each item names the exact place, what goes wrong, and the smallest fix that
closes it.

### H-01. The packaged update channel cannot work

- **Where** `src/cliMain.ts:249` (`DEFAULT_RELEASE_CHANNEL_URL`), `:357`
  (`redirect: 'error'`), `:553-562` (public key path); `test/cli-update-wiring.test.ts:203-217`
  pins the redirect policy; `src/update.ts:512` routes every macOS app and
  packaged runtime here; `scripts/package-release-assets.sh:85`;
  `.github/workflows/release.yml:171-208`.
- **What** The default URL points at a release named `update-channel-stable`
  that does not exist (HTTP 404 today; `gh release view` says "release not
  found"). No script or workflow publishes `release-manifest.json` or
  `pimpampum-release-public-key.pem`, and nothing copies the key into the app
  bundle. Even once published, GitHub answers `releases/download/*` with a 302
  to `release-assets.githubusercontent.com`, and the fetcher rejects redirects.
  On Linux the packaged provider is wired only for `darwin-arm64`
  (`cliMain.ts:877-883`; `reconcile` refuses other targets at `:640-642`), so
  the Omarchy Updates panel (`pimpampum-control-route:94-100`) fails before
  touching the network.
- **Impact** macOS Settings > Updates and Omarchy "Check for updates" and
  "Install update" cannot succeed for any packaged install. The failure is
  typed (`unavailable`), so it looks like a network problem. The README
  advertises both (`README.md:103-104`).
- **Fix** Add a release step that signs `release-manifest.json` with Ed25519
  and uploads it to a rolling `update-channel-stable` release, and ship the
  public key inside the bundle and the Omarchy runtime. Follow redirects
  manually with a bounded hop count, HTTPS only, host allowlist
  `github.com` to `*.githubusercontent.com` (integrity is already the signed
  sha256). Either implement the Linux `reconcile` or return `unavailable`
  with a suggestion that names `pimpampum-bootstrap`, and correct the README.
  Add an E2E that resolves the default URL shape against a local server that
  answers 302.

### H-02. The Omarchy plugin mirror is outside the release pipeline

- **Where** `README.md:76` (`omarchy plugin add https://github.com/r-bart/pimpampum-omarchy.git`);
  `release.yml:171-208` has no mirror step; `scripts/check-omarchy-delivery.mjs:65-190`
  validates the local directory only.
- **What** Verified live on 2026-09-01: the mirror's `manifest.json` and
  `runtime-manifest.json` say `1.2.9` (HEAD `5f76ac1a`) while npm and GitHub
  Releases are at `1.2.11`. The 1.2.11 lifecycle fix
  (`pimpampum-plugin-lifecycle:253-259`) is not in the mirror. The lifecycle
  fails closed on a digest change without a version change (`:203-208`), so a
  manual push is exactly where a slip becomes an install failure.
- **Fix** Add a `mirror` job after `publish`: `git subtree split --prefix
integrations/omarchy/pimpampum-status`, push with a deploy key, tag
  `v<version>`, then compare the mirror's `runtime-manifest.json` SHA with the
  local `runtimeManifestSha256`. Until then, a `check:omarchy-mirror` script.

### H-03. `ulimit -f 128` breaks Claude Code connect on Omarchy

- **Where** `integrations/omarchy/pimpampum-status/pimpampum-connections:149`;
  `src/connectors/process.ts:372-405` (whole-file rewrite via temp + rename);
  `src/cliMain.ts:1162` (host config is `~/.claude.json`).
- **What** `-f` counts 512-byte blocks under `/bin/sh`, so the CLI runs with a
  64 KiB file-size limit. Claude Code stores per-project history in
  `~/.claude.json`; the copy on this machine is 234,219 bytes. The rewrite
  raises `EFBIG`, the CLI dies, the helper reports `command_failed`, and the
  popout says "Needs repair". The same command works from a terminal.
- **Fix** Remove `ulimit -f`; the 64 KiB stdout/stderr check at `:154-157`
  already bounds output. Add a test where the fake launcher writes a 200 KiB
  file.

### H-04. Sync canonical ordering depends on the daemon locale

- **Where** `src/syncState.ts:8` (object keys), `:27` (entities), `:34-37`
  (activity) sort with `localeCompare`; `src/syncController.ts:575-577`
  rejects a snapshot whose recomputed hash differs; `src/store.ts:1549` dedupes
  activity by fingerprint.
- **What** Node takes the default collation from `LANG`/`LC_ALL`. Run on this
  machine: `da_DK` orders `aa` after `å` and `z`; `sv_SE` moves `å` after `z`;
  `cs_CZ` places `ch` after `ci`. A systemd user daemon inherits the user
  locale; launchd usually has none. Two devices then produce different
  canonical JSON for the same state.
- **Impact** The receiving device rejects the snapshot forever with "Shared
  snapshot hash does not match its state". Activity fingerprints diverge, so
  events duplicate instead of deduplicating. The trigger is data-dependent
  (`chat-bot` vs `cli-tool`, `aa…` vs `ab…`) and silent until permanent.
- **Fix** Sort by code units in `canonicalJson` and `normalizedSyncState`.
  Version the hash (`schemaVersion: 2`) because existing snapshots were hashed
  with the old order. Add a fixture with `aa`, `ab`, `å`, `ch` keys and assert
  the canonical string byte for byte.

### H-05. A sync-imported unresolved workspace becomes a phantom that matches every path

- **Where** `src/store.ts:2020` maps the sentinel root path
  `/__pimpampum_unresolved__/<id>` to `rootPath: ''`; `resolveWorkspace`
  `store.ts:303-308` computes `relative('', resolved)`, which Node treats as
  `relative(cwd, resolved)`.
- **What** Confirmed by the reviewer with the real in-memory store: after a
  sync import creates such a workspace, any path under the daemon's cwd
  resolves to it instead of `not_found`. launchd and systemd set no
  `WorkingDirectory`, so under launchd the cwd is `/` and the phantom matches
  everything. Projects then get created in the wrong workspace.
- **Fix** Skip `rootPath === ''` in `resolveWorkspace` and add the test. Long
  term, make `root_path` nullable instead of a sentinel.

### H-06. An installed CLI reclassifies the managed macOS app as adopted

- **Where** `src/service/macosApp.ts:214-218`; `src/runtime/bootstrap.ts:93-98`;
  `src/cliMain.ts:935-937`; `src/service/manager.ts:362-375`, `:393-395`,
  `:435-437`.
- **What** `applicationLocation` returns `managed: false` whenever the source
  bundle's parent is `/Applications` or `~/Applications`, before consulting
  the recorded path. The installed CLI gets `sourceApplicationPath =
~/Applications/Pimpampum.app` whenever that directory exists, which is the
  managed copy setup created. With a receipt holding N app files and a plan
  of one plist, `status()` reports `installed: false` for a healthy install,
  `prepareUninstall` throws "Receipt artifact is not owned by the platform
  adapter", and `install` throws "not inside an adapter-owned root".
  `test/service-macos-app.test.ts:349-359` freezes "`~/Applications` means
  adopted" without asking who put the bundle there. The live smoke runs from
  the build tree and never sees this topology.
- **Fix** Persist `managed: boolean` in `application-path.json` at install
  and read it everywhere. Add a manager-level test: managed install, then
  `status` and `uninstall` with `appBundlePath` equal to the managed path.

### H-07. Uninstall deletes the embedded runtime inside an adopted, user-owned bundle

- **Where** `src/service/macosApp.ts:751` (`removeEmbeddedRuntimeSource` with
  no `managed` check), contrast the install gate at `:616-618` and the
  contract at `:198-209`.
- **What** For an app the user placed in `/Applications`, `afterUninstall`
  removes `Contents/Resources/PimpampumRuntime` from the user's bundle. This
  writes outside the home directory, strips the runtime the app needs to run
  setup again, and breaks the bundle's code seal. The only test covers the
  managed path (`test/service-macos-app.test.ts:626-640`).
- **Fix** Guard `removeEmbeddedRuntimeSource` and `removeEmptyAppDirectories`
  with `location.managed`. Add an adopted-path uninstall test asserting the
  bundle is byte-identical afterwards.

### H-08. The systemd adapter never restarts a running daemon

- **Where** `src/service/systemd.ts:251-266` (`daemon-reload`, `show`,
  `enable --now`); contrast `src/service/launchd.ts:301-305` (`kickstart -k`);
  `src/update.ts:231-238`; `pimpampum-bootstrap:353`.
- **What** `systemctl enable --now` on an already-active unit does not restart
  it. The update path installs the new runtime with the old daemon still
  serving; `verifyServiceHealth` demands the new version
  (`src/service/health.ts:99`), fails after 30 s, and rolls back. Only the
  rollback (`restoreSystemdState`, `systemd.ts:205-234`) restarts the unit.
  `test/service-systemd.test.ts:539-543` asserts `enable --now` alone.
- **Confidence** Likely. systemd semantics from documentation; not executed.
- **Fix** After `enable --now`, run `restart` when `previousState.running`,
  mirroring `kickstart -k`. Adjust the frozen expectation.

### H-09. Destructive journal recovery runs on every CLI start, outside the lifecycle lock

- **Where** `src/runtime/installer.ts:815-819` (`inspectInstalledRuntime` calls
  both `recoverInterrupted*`), reached from `src/runtime/bootstrap.ts:85`,
  which `src/cliMain.ts:924` executes before any verb dispatch. The writer's
  window is `installer.ts:765-789`; the lock wraps only install, update and
  uninstall (`cliMain.ts:716`, `:1152`, `:1243`, `:1428`).
- **What** A concurrent `status` poll (menu bar app, Omarchy widget, second
  terminal) that starts between the journal write and its removal reads the
  old receipt, concludes the activation was interrupted, restores the old
  launchers and receipt, and deletes the freshly renamed version directory
  (`:632-639`). One interleaving leaves old receipt plus new launchers, which
  fails `verifyOwnedLaunchers` on every later CLI start, including `uninstall`.
  The committed branch (`:629-630`) never removes the journal on drift, so the
  wedge is permanent. The window is tens of milliseconds; the desktop surfaces
  poll continuously.
- **Confidence** Code path confirmed; race not reproduced.
- **Fix** Make `inspectInstalledRuntime` read-only. Run recovery only inside
  the lifecycle-locked entry points, or try-acquire the lock and skip recovery
  when held. Add a test that injects a concurrent inspect between the journal
  write and the receipt write.

### H-10. The OpenAPI document drifts from the code, and nothing checks it

- **Where** `src/openapi.ts:1243-1262` (`AutomaticBackupStatus`) documents
  `lastError` and the enum `[disabled, healthy, refreshing, error]`; the code
  emits `error` and `[disabled, pending, healthy, error]`
  (`src/backupContract.ts:5-15`, `:29`; `src/automaticBackup.ts:66-90`).
  Also: `actor` `minLength 1` in `schemas.ts:41` but `""` accepted in
  `openapi.ts:1111`; `Workspace.rootPath` can be `''` (`store.ts:2020`) but
  OpenAPI requires an absolute path; the "at least one field" refine
  (`schemas.ts:78`, `:98`, `:117`) is absent; `conflictId` is `^[a-f0-9]{64}$`
  in OpenAPI, `min 1 max 128` in MCP (`mcp.ts:214`), and unvalidated in HTTP
  (`http.ts:223`); `limit` max is 200 in HTTP and 100 in MCP (`mcp.ts:72`);
  `components.schemas.SyncConflict` is referenced by no route.
- **What** `parseAutomaticBackupStatus` is `.strict()`, so a client generated
  from the document would be rejected by the daemon. `test/openapi.test.ts`
  checks a hand-copied operation list and `$ref` consistency, never a real
  body against `components.schemas`, and never the live router.
- **Fix** Generate `components.schemas` from the Zod schemas with
  `z.toJSONSchema` (Zod 4 is already a dependency; ~450 of the 720
  hand-written lines disappear). Walk the Express router in the test and diff
  it against `paths`. Add one round-trip test per contract type.

### H-11. The sync contract lets a synced context name escape the export directory

- **Where** `src/syncContract.ts:63` (`name: z.string().min(1).max(200)`,
  not `slugSchema`) while `http.ts:394` and `mcp.ts:770` enforce slugs;
  `src/store.ts:1524-1541` upserts verbatim; `src/backup.ts:87`
  `join(contextPath, \`${document.name}.md\`)`.
- **What** A snapshot in the shared folder with a context named `../../x`
  makes `exportPortable` write outside the export directory. The shared
  folder is a trust boundary the code otherwise respects (O_NOFOLLOW reads,
  size and hash checks).
- **Fix** Use `slugSchema` in the sync contract and reject path separators in
  `writeContextExport`.

### H-12. The npm package ships the macOS app with its 150 MB private runtime

- **Where** `package.json:8-23` (`files` includes `platforms/macos/dist`);
  `release.yml:122-128` then `:171-187` (`npm pack` runs after `build:macos`
  populated `Contents/Resources/PimpampumRuntime`); no `.npmignore`.
- **What** Registry metadata for `pimpampum@1.2.11`: 157,648,272 bytes
  unpacked, 2,733 files (a local `npm pack --dry-run` shows 7 MB because the
  runtime is not in the checkout). `server.json:18` advertises `runtimeHint:
npx`, so every MCP client downloads 150 MB for a stdio bridge, and every
  Linux `npm install -g` pays for a macOS Node binary. `test/fixtures/overview`
  and `thoughts/evidence/*.example.json` ship too.
- **Fix** Ship the app only as the GitHub Release zip and let `pimpampum
install` fetch it through the release manifest (H-01). At minimum add
  `platforms/macos/dist/.npmignore` excluding `**/PimpampumRuntime/**` and drop
  the fixture and evidence entries. Add a tarball size gate on PR.

### H-13. Source-text greps are counted as acceptance coverage

- **Where** `test/omarchy-plugin.test.ts:89-452`,
  `test/desktop-status.acceptance.test.ts:349-459`,
  `test/backup-settings-ui.acceptance.test.ts:8-87`,
  `test/omarchy-agents-ui.test.ts:9-62`, `test/runtime-release-integration.test.ts:9-65`,
  `test/zero-friction-surfaces.acceptance.test.ts:22-148`,
  `test/zero-friction-runtime.acceptance.test.ts:280-305`,
  `test/zero-friction-lifecycle-security.acceptance.test.ts:364-386`,
  `test/macos-live-gates.test.ts:231-278`.
- **What** Roughly 900 lines assert that substrings exist in QML, Swift, YAML
  and shell sources: an SF Symbol name, an arithmetic layout expression,
  `KeepAlive`, `codesign`, `Try again`. The two popout defects recorded in
  CLAUDE.md shipped with these tests green; the file now contains the fixes
  as new greps, so it is a changelog of past bugs, not a detector. The DoD
  matrices credit these as covering FR-1.3, PERF-6, SEC-1..12, A11Y-1..5.
- **Fix** Keep only the negative security greps (no `sh -c`, no token, no
  write verbs). Move layout and copy assertions into the `qml6` harness
  CLAUDE.md already mandates, or delete them. Rename what remains to a
  source-contract suite so the DoD matrix is honest.

### H-14. The frozen-hash mechanism freezes snapshots, not a specification

- **Where** `scripts/check-desktop-status-contract.mjs:8-43`; `@immutable`
  headers on `test/desktop-status.acceptance.test.ts:3`,
  `test/quattro-live-evidence.acceptance.test.ts:3`,
  `test/zero-friction-setup.acceptance.test.ts:1-7`,
  `test/agent-cli.acceptance.test.ts:1-7`; DoD tables in
  `thoughts/tests/2026-08-26_desktop-status-integrations.md`,
  `2026-08-27_real-development-session-evals.md`,
  `2026-08-31_zero-friction-local-agent-setup.md`.
- **What** The four frozen files were edited in every one of the eight
  commits that touched the checker. Seven of eight hashes in the 2026-08-26
  DoD no longer match the script; the evals DoD hash mismatches; two of seven
  zero-friction hashes are stale and that set has no checker at all.
  `test/agent-cli.acceptance.test.ts:151` still calls `project_update_prd`, a
  tool removed from the product, behind a mock that echoes any name. Frozen
  content includes CLI verb spellings, Swift enum cases and README wording.
- **Fix** Keep the hash pin only for the four overview fixtures (a real
  three-consumer contract). Unfreeze the test files and rely on the spec-id
  comments they already carry. If a freeze must stay, enforce it for every
  set and refresh the DoD tables in the same commit.

### H-15. Fixtures "captured from a real invocation" no longer match the producer

- **Where** `test/fixtures/setup/plan-envelope.json:5-18` vs
  `src/setup/coordinator.ts:536-556`; `test/setup-envelope-shape.test.ts:8-34`;
  Swift consumer `SetupOnboardingCopyTests.swift:130-141`;
  `test/fixtures/connectors/**` (24 files, no consumer);
  `test/fixtures/overview/*.json` (hand-authored, no TypeScript equality test).
- **What** The setup fixture has three changes without `path`; the
  coordinator emits four with `path` (the plan changed 37 seconds after the
  fixture landed and was never regenerated). The TypeScript test checks
  indentation and two discriminators; the Swift test reads three fields. The
  connector fixtures that record real Codex and Claude Code output are read by
  nothing; the connector tests stub `--help` with a one-line string the test
  chose. This is the exact pattern behind the Swift decoder defect the last
  session fixed.
- **Fix** Generate the setup fixture in-test from `runCli(['setup','plan'])`
  with a temp data directory and assert equality. Drive `detect()` tests from
  `scenarios.json`. Add one test that serves the `mixed` overview scenario
  from a real store through `createHttpApp` and deep-compares it with the
  fixture.

### H-16. Coverage-closure tests pin migrations and adapters to their own text

- **Where** `test/coverage-closure.test.ts:26-86` (fake `better-sqlite3`
  whose `get()` returns `count: 1` only when the SQL contains
  `parent.parent_id IS NOT NULL`); `test/cli-update-coverage-pass2.test.ts:133-156`
  (mocks five one-line delegations and asserts the strings come back);
  `test/setup-coordinator-branch-hardening.test.ts:176-193`;
  `test/openapi.test.ts:4-64`; `test/core.test.ts:585-617`
  (`toHaveLength(57)` plus ~12 URL substrings); `test/cli-program.test.ts:136-210`
  (49 commands run, 5 asserted); `test/sync-controller.test.ts:187-277`,
  `:402-428` (rewrites the loop it claims to test).
- **What** The three-level-task migration rejection is exercised only through
  a stub that matches the SQL string. No test walks the live router against
  the OpenAPI document. Swapping `'paused'` for `'draft'` in `project:pause`
  passes. Roughly 30% of the coverage-chasing partition (~2,000 lines) can
  fail for no real bug.
- **Fix** Build a real v1 database with a three-level task in the migration
  acceptance test and delete the double. Turn the CLI mapping list into a
  table of `[argv, clientMethod, expectedArgs]`. Reach sync-controller
  branches through the public surface. Delete the delegation tautology.

### H-17. `sync-e2e.test.ts` is a compiled E2E that runs inside `test:unit`

- **Where** `test/sync-e2e.test.ts:10`, `:96-114`; `package.json` scripts
  exclude only `test/e2e.test.ts` and `test/**/*.e2e.test.ts`.
- **What** The file spawns `dist/cli.js` daemons, has no `existsSync` guard,
  and uses `stdio: 'ignore'`. On a clean checkout `npm run test:unit` fails
  after a 4 s poll with "Compiled sync daemons did not start" and no cause. It
  ran in the coverage pass and contributed no instrumented coverage.
- **Fix** Rename to `sync.e2e.test.ts`, add the build guard, pipe stderr into
  the failure message, add a SIGKILL fallback to `stop()`.

## 4. Medium-severity findings by area

### Core domain and store

- **M-C1. Deleting parent and child task in one snapshot fails the import
  forever.** `store.ts:1580-1582` deletes with `NOT IN (...)`; `migrations.ts:67`
  has `ON DELETE RESTRICT`; the FK error becomes `internal_error` and
  `syncController.ts:483` retries every cycle. Reachable through
  `mergeEntities` drops or `resolveConflict('remote')`. Verified live by the
  reviewer. Delete subtasks first.
- **M-C2. Large portfolios cannot sync.** The same `NOT IN` builds one
  placeholder per id; `syncContract.ts:20` allows 50,000 entities per
  collection; SQLite rejects above 32,766 (verified: 32,000 passes, 33,000
  fails with "too many SQL variables"). Use a temp table or chunked deletes.
- **M-C3. MCP updates with only `expectedRevision` succeed and emit a phantom
  event.** The "nothing to update" refine lives only in the HTTP schemas
  (`schemas.ts:78`, `:98`, `:117`); `mcp.ts:351-362`, `:525-540`, `:677-688`
  lack it. Verified live. Move the guard into the store.
- **M-C4. N+1 claim lookups on the sync hot path.** `store.ts:2066`, `:2113`
  call `getClaim` per row; `exportSyncState` (`:1409-1423`) maps every spec
  and task then discards the claim; `applySyncState` (`:1548-1550`) calls
  `exportSyncState` again inside the write transaction. Sync runs on every
  mutation. Use a LEFT JOIN and claim-free mappers.
- **M-C5. Cascade cancel revokes claims silently.** Claims are deleted at
  `store.ts:476-480`, `:647-651`, `:936-940` with only `*.cancelled` events;
  the agent id is never logged; the agent's next `renewWork` sees the same
  `conflict` as an expiry. Emit `work.revoked` with agent id and reason.
- **M-C6. A corrupt backup settings file prevents daemon start.**
  `automaticBackup.ts:166-175` throws in the constructor; `server.ts:77-80`
  propagates. The user cannot repair it from the menu app because the daemon
  is down. Start in state `error` instead.

### HTTP, MCP and OpenAPI adapters

- **M-A1. MCP `run()` swallows non-`AppError` failures without logging**
  (`mcp.ts:104-117`); `createMcpHandler` (`:973-976`) has no `onerror`.
  `agentProtocol.ts:34-35` tells the agent to inspect logs that contain
  nothing.
- **M-A2. `GET /mcp` returns Express HTML 404 with `X-Powered-By`.**
  `http.ts:589-602` registers only `app.post('/mcp')`; the SDK client opens a
  GET stream after `initialize` and treats only 405 as "no stream". Add
  `app.all('/mcp')` returning 405 with `Allow: POST`, `app.disable('x-powered-by')`,
  and a global JSON 404.
- **M-A3. `hasMore` is a heuristic on four endpoints.** `http.ts:55-57`
  returns `items.length === limit`, so an exact last page says `hasMore: true`
  (verified with `limit=2`). Sync conflicts and MCP already use lookahead.
- **M-A4. The error code catalogue is hand-written four times**
  (`errors.ts:1-10`, `client.ts:54-64`, `agentProtocol.ts:110-122`,
  `openapi.ts:728-739`). Export one `ERROR_CODES` constant.
- **M-A5. MCP re-declares shared schemas.** `mcp.ts:51-57` vs `schemas.ts:41`;
  lease bounds, summary and note limits in three copies; `contextOwnerTypeSchema`
  and `expectedRevisionSchema` in `schemas.ts` have no importer.
- **M-A6. `agentClient.ts:50-79` maps every non-auth `SdkHttpError` (404,
  413, 415, 500) to `unavailable` "daemon did not answer".** Map status like
  `client.ts:66-75`.
- **M-A7. Instance lock TOCTOU.** `server.ts:27-42`: two starters read the
  same stale PID, both `rmSync`, the second deletes the first's fresh lock.
  Use `renameSync` takeover and re-verify.
- **M-A8. `loadConfig()` mints a token for clients.** `config.ts:32-49`,
  `:57-58`; a stdio bridge started before the daemon creates a different token
  and every call is `unauthorized` with no hint. Add `createToken: false` for
  clients.

### CLI, update and sync

- **M-S1. Every CLI invocation composes the whole lifecycle graph eagerly.**
  `cliMain.ts:905` creates the data directory and token even for `help`;
  `:924-934` throws on a receipt version mismatch; `:1489-1530` builds the
  update manager for every verb; `readUpdateReceipt` throws on an invalid
  receipt. Any failure lands in `cli.ts:14-45` with "reinstall with `npm
install --global pimpampum`", wrong for a packaged install and fatal for
  `pimpampum status`, the command every suggestion points at. Build managers
  behind thunks; keep `help`, `version`, `commands` free of filesystem writes.
- **M-S2. `setup retry`, `--events` and `--keep` are hidden from the
  catalog.** `cliProgram.ts:290-320`, `:770-781`; absent from
  `src/cliCommands.ts`; `SetupCommandRunner.swift:86-87`, `:112`, `:124`
  depend on them. Violates the CLAUDE.md rule that every verb is declared in
  the table. `--events` is a third exception to the one-envelope contract the
  banner does not mention.
- **M-S3. Half of the verbs bypass the catalog parser.** `cliProgram.ts:836-851`
  (`status`, `update:check`, `update`, `uninstall` ignore all arguments),
  `:1080-1170` (`backup`, `export`, `sync` hand-rolled). `pimpampum uninstall
--keep-service` uninstalls; `pimpampum update --check` installs; `sync
configure /dir --json --device x` fails although the catalog lists both
  options. Route every verb through `parseCommandArguments` and add a test
  that `<verb> --definitely-unknown` fails for each catalog entry.
- **M-S4. One unreadable snapshot halts all imports and does not name the
  file.** `syncController.ts:402-407`, `:543-579`, `:356-359`; `safeError`
  keeps only the message. Put the relative path in error details and in
  `SyncStatus`; reject a newer `schemaVersion` with an upgrade message.
- **M-S5. The poller exports and hashes the whole database every 5 s.**
  `syncController.ts:160`, `:719` mark dirty unconditionally; `publish`
  (`:490-495`) runs the full snapshot and hash before its early return. Keep a
  mutation counter and skip `publish` when nothing moved.
- **M-S6. Snapshot files and the applied-id ledger grow without bound.**
  `syncController.ts:516-541` writes a full-state file per change and deletes
  only partials; `appliedSnapshotIds` (`:534`, `:654-670`) is never compacted;
  a missing parent keeps a child pending forever (`test/sync-controller.test.ts:561`).
  Specify retention in the sync spec.
- **M-S7. `baseState` is persisted on every import and publish but never
  read** (`syncController.ts:313`, `:473`, `:536`; parsed at startup `:623-626`).
  Drop it.

### Service and setup

- **M-V1. Login-item registration gets 10 s while the daemon gets 30 s, and a
  timeout tears down a healthy install.** `macosApp.ts:446-447`, `:497`,
  `:522-531`; `health.ts:50-55`; `manager.ts:695`, `:702-750`. Poll until the
  request's own `expiresAt` and treat a timeout like `error` (record it, keep
  the install), as CLAUDE.md already demands for recoverable login-item states.
- **M-V2. Uninstall is impossible once the user has trashed the app.**
  `macosApp.ts:376-384`, `:655-666`: `deactivate` starts with `open -n
<bundle>`; a missing bundle makes it throw before the daemon stops.
  `manualInstructions` (`types.ts:104-108`) exists and is never set. Skip
  unregistration when the bundle is gone and return the instructions.
- **M-V3. `afterUninstall` deletes the control files first and rollback never
  restores them** (`macosApp.ts:737-755`; `manager.ts:494-497`, `:503-528`).
  Snapshot control files in `prepareDeactivationRollback`; delete them last.
- **M-V4. The manager lifecycle lock has a stale-recovery race and duplicates
  the setup lock.** `manager.ts:47-76` (`rmSync` without identity re-check,
  immediate failure); `setup/state.ts:555-584` does it right with dev/ino
  checks and a 30 s wait. A read-only `status` during an install fails with
  `internal_error`. Reuse `createSetupLifecycleLock`.
- **M-V5. Every external process runs with no timeout and the full
  environment.** `service/platform.ts:26-44` (`launchctl`, `systemctl`,
  `open`, `pkill`, `omarchy`, `npm`, `unzip`, `tar`, `ditto`); `PIMPAMPUM_TOKEN`
  reaches `npm`. `maxBuffer: 1_000_000` is below the 1 MiB parse cap in
  `omarchy.ts:381-383`, so that guard is unreachable. `connectors/process.ts:124-164`
  already does this right; reuse it.
- **M-V6. An unreadable receipt blocks install, status and uninstall with no
  repair path, and the receipt write is not fsynced.** `receipt.ts:105-129`,
  `:132-156`; `manager.ts:483`, `:572`, `:758`. Fsync file and directory; on
  parse failure raise a typed error naming the path and the repair step.
- **M-V7. `retryConnector` can strand a journal whose base phases never
  completed.** `coordinator.ts:674-700` has no precondition on
  `service.verify`; `resume` (`:649-655`) ignores `partial`. Refuse the retry
  unless `service.verify` completed.
- **M-V8. `setup plan/apply` on Omarchy never detects Omarchy.**
  `cliMain.ts:947-956` probes `omarchy version` only for `install`, `status`,
  `uninstall`; `setup apply` then installs a service without the status plugin.
- **M-V9. Release public key from user-writable paths and a manifest with no
  freshness.** `cliMain.ts:553-562` accepts the key from `~/.pimpampum` or
  `~/Applications/Pimpampum.app/Contents/Resources`, and env variables override
  both; the manifest has no `issuedAt`, so an old valid manifest replays.
  Embed the key as a constant; allow env override only under an explicit dev
  flag; add `issuedAt` and reject older-than-last-accepted.

### Runtime and connectors

- **M-R1. Reinstalling an owned version never repairs it.** `installer.ts:723-730`,
  `:767`: on drift the validated, smoke-tested staged copy is discarded and the
  install fails with `size drift`. The CLAUDE.md gotcha about deleting
  `Runtime` and `bin` by hand is this behaviour. Quarantine the existing
  directory and rename the staged payload in.
- **M-R2. Capability probing repeats on every operation.** Counted from the
  code: one Codex connect spawns ~47 processes; one Claude Code connect ~16,
  five of them concurrent full Claude Code start-ups (`codex.ts:306-323`,
  `:343-349`, `:371`, `:505`, `:527`, `:531`; `claudeCode.ts:341-347`,
  `:566-575`). Memoize `detect()` per connector instance.
- **M-R3. The two connectors duplicate the lifecycle with diverging
  semantics.** `connect` on an unconnectable state throws in Codex
  (`codex.ts:519-526`) but returns `{changed: false}` in Claude
  (`claudeCode.ts:584-597`); `inspect` propagates errors in Codex and
  collapses everything to `unavailable` in Claude (`:452-460`). Extract a
  shared connector core.
- **M-R4. `registry.ts` is a second, weaker ownership oracle and is dead in
  production.** `registry.ts:31-37` treats any non-hex fingerprint as proof;
  `planDisconnect`, `redactConnectorDiagnostics`, `parseRuntimeTargetId` are
  referenced only by tests. Delete them.
- **M-R5. The Omarchy bootstrap re-implements the receipt and launcher
  contract in shell.** `pimpampum-bootstrap:332-343` writes them with
  `printf`; `installer.ts:272-289` enforces exact keys. Adding one receipt
  field breaks every CLI start on Omarchy. Let the shell stage and smoke only,
  then call the TypeScript installer; or add a contract test that parses the
  shell output with `parseReceipt`.

### Omarchy plugin, scripts and CI

- **M-O1. Release is not atomic.** `release.yml:176-187` publishes to npm
  before `gh release create` (`:188-208`). If the release step fails, npm
  holds the version and a re-run dies at `:187`. Create a draft release with
  all assets first, publish, then undraft; make the npm step idempotent.
- **M-O2. Write-capable token and persisted credentials in non-publishing
  jobs.** `release.yml:7-9` sets `contents: write` and `id-token: write` at
  workflow level; checkouts keep `persist-credentials: true`. `validate` and
  `runtime` run `npm ci` with lifecycle scripts. Scope permissions to
  `publish`; SHA-pin `actions/*`.
- **M-O3. The Quattro live runner verifies a helper transform the installer
  no longer performs.** `scripts/test-omarchy-live.mjs:1290-1404` expects
  helpers rewritten as bash exporting `PIMPAMPUM_*`; `omarchy.ts:134-160`
  copies bytes verbatim. With a production candidate the runner throws right
  after install. This is the only source of human-observed Quattro evidence.
- **M-O4. The connections helper collapses typed CLI errors into
  `command_failed`** (`pimpampum-connections:158-163`;
  `AgentConnectionService.qml:181-204`). `unavailable`, a missing binary and
  the ulimit failure (H-03) read identically. Forward the envelope `code`.
- **M-O5. The static validator's safety sweeps skip four QML files.**
  `validate-omarchy-plugin.mjs:217-229` fixes 9 of 14 files;
  `AgentConnectionService.qml`, `AgentsSettingsCard.qml`, `PimpampumHeaderIcon.qml`,
  `UpdateService.qml` are unchecked. Enumerate with `readdirSync`.
- **M-O6. Digest pinning needs a second commit per release and CI hides the
  value.** Four releases show a "prepare" commit followed by a "pin digests"
  commit; `check-reviewed-runtime-manifest.mjs:80-82` fails without printing
  the generated manifest. Print it and upload it as an artifact.
- **M-O7. The Omarchy adapter is tested only against a simulator nobody
  compared with the real CLI.** `test/service-omarchy.test.ts:97-241`
  (`fakeQuattro`, 145 lines) answers every `omarchy` command with shapes the
  test author wrote; no fixture records real output; the evidence file is a
  pending template. Capture real stdout into `test/fixtures/omarchy/` and
  replay it.

### Test suite structure

- **M-T1. Adoption and installed-CLI uninstall never go through the
  manager.** `test/service-macos-app.test.ts:295-331` swallows the error it
  raises with `.catch(() => undefined)`; `:333-415` call adapter hooks
  directly. No test installs with a bundle in `~/Applications` and then runs
  `manager.status()`/`uninstall()` from an adapter without a bundle. This is
  the blind spot behind H-06 and H-07.
- **M-T2. No test proves claim exclusivity under concurrent requests.**
  Competitors are always sequential. Add one E2E with 20 parallel claims and
  expect one 200 and nineteen 409.
- **M-T3. Duplicate device ids across two live devices are untested** and
  probably wedge sync (`syncController.ts:204-211`, `:408-414`).
- **M-T4. Hook-level tests drive adapters in orders the manager never
  produces.** About 480 of 1,442 lines in `test/service-omarchy.test.ts`
  (`:842-1134`, `:1287-1420`) and similar blocks in `service-macos-app.test.ts`
  assert IPC call counts.
- **M-T5. Call-ordinal fault injection with assertions weaker than the
  titles.** `runtime-installer-fs-faults.test.ts:139-204`,
  `service-macos-fs-faults.test.ts:62-67`, `setup-state-fs-faults.test.ts:151-241`
  inject on "the 5th `writeFileSync`" without naming the path. Inject by path
  and assert the named post-condition.
- **M-T6. Third-party SDK prototype spies** (`connectors-targeted-branches.test.ts:225-273`)
  pin private members of `@modelcontextprotocol/client`.
- **M-T7. Two tests leak child stderr and run Git without isolation.**
  `test/service-omarchy.test.ts:698-706` prints `pimpampum-control-route:
control launcher differs from its runtime receipt` to the vitest output and
  asserts only `.toThrow()`; `:713-742` runs `git init/clone/pull` with the
  user's environment, against the CLAUDE.md rule. Reuse
  `isolatedGitEnvironment` from `macos-source-hash.test.ts:18-39`.
- **M-T8. Speed.** `service-omarchy` 15.3 s, `omarchy-bootstrap` 14.0 s,
  `omarchy-plugin-lifecycle` 12.0 s, `connectors-targeted-branches` 9.4 s
  bound the parallel run. Build archives once per file; write the synthetic
  MCP server once per describe.
- **M-T9. `macos-package-artifact.test.ts:111` is `skipIf(!darwin)`**, so a
  Linux-only CI run reports the artifact gate as passed by absence.

## 5. Low-severity findings

| Id   | Where                                                                                                | What                                                                                                                                                                 | Fix                                             |
| ---- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| L-01 | `store.ts:483`                                                                                       | `cancelled_at` is write-only; absent from `types.ts` and `SyncState`, so NULL after sync                                                                             | Map it or drop it                               |
| L-02 | `store.ts:339`, `:542`, `:676`, `:836`                                                               | Public `list*` methods returning full bodies are called only by tests                                                                                                | Delete; coverage tests keep them alive          |
| L-03 | `store.ts:206-214`                                                                                   | Markdown paging can split a surrogate pair (`readSpecBody(id,0,1)` on `😀x` returns `\ud83d`)                                                                        | Page on code points                             |
| L-04 | `store.ts:491-495`                                                                                   | `cancelProject` UPDATE lacks `changed()` unlike its 9 siblings; revision is checked earlier, so no race                                                              | Align                                           |
| L-05 | `store.ts:191`, `:1026`, `:1055`                                                                     | No injectable clock; claim expiry boundary untested                                                                                                                  | Inject `now`                                    |
| L-06 | `store.ts:1194-1201` vs `overview.ts:8-58`                                                           | Overview ordering duplicated in SQL and JS; >500 projects truncation untested                                                                                        | One source                                      |
| L-07 | `server.ts:108-117`                                                                                  | Listen-failure cleanup skips `syncController.close()`                                                                                                                | Close it                                        |
| L-08 | `http.ts:130-132`, `service/health.ts:69-100`, `cliProgram.ts:856`                                   | `/health` liveness consumed as readiness                                                                                                                             | Add `SELECT 1` or document                      |
| L-09 | `http.ts:263-269`, `:327-333`, `:470-476`                                                            | Duplicate alias routes `/x/{id}` and `/x/{id}/manifest` with different OpenAPI summaries                                                                             | Keep one                                        |
| L-10 | `client.ts:252-506`                                                                                  | Path segments interpolated without `encodeURIComponent`; `ownerId` is `z.string().min(1)` in MCP, so `../workspaces/x` rewrites the request path in the stdio bridge | Encode                                          |
| L-11 | `mcp.ts:139-143`, `:963`                                                                             | `work_complete` duck-types `projectId` instead of `input.targetType`                                                                                                 | Use the input                                   |
| L-12 | `http.ts:589`                                                                                        | No test expects 401 for `POST /mcp` without `Authorization`; no test sends a foreign `Host`/`Origin` expecting 403 (protection comes from the SDK)                   | Add both                                        |
| L-13 | `backup.ts:109-113`, `:144-148`                                                                      | SQLite copy created in `tmpdir()` with default mode then chmod 600; Linux manual `serve` only                                                                        | Create inside the 0700 data dir                 |
| L-14 | `cliProgram.ts:1006`, `:1056`; `cliMain.ts:1539-1540`                                                | `--body-file` reads are unbounded and a missing file becomes `internal_error` with daemon-log advice                                                                 | Use `readBoundedUtf8File`; map to `bad_request` |
| L-15 | `update.ts:150`                                                                                      | `split('-', 2)` truncates a prerelease containing a hyphen (`1.0.0-rc-2` never beats `1.0.0-rc-1`)                                                                   | Split at first hyphen                           |
| L-16 | `cliMain.ts:335-340`                                                                                 | try/catch around `Buffer.from(sig, 'base64')` can never fire                                                                                                         | Strict base64 regex                             |
| L-17 | `cliProgram.ts:1096-1106`                                                                            | `backup retry` turns a 200 with `state === 'error'` into `internal_error` exit 1                                                                                     | Return the data                                 |
| L-18 | `cliProgram.ts:335-341`, `agentClient.ts:62`                                                         | Unknown errors classified as `conflict`/`not_found` by regex on message text                                                                                         | Typed codes                                     |
| L-19 | `systemd.ts:38-46`, `:63-65`                                                                         | `$` doubled inside `Environment=`, where systemd does not expand                                                                                                     | Separate quoting                                |
| L-20 | `macosApp.ts:672-676`                                                                                | Bundle path used as an unescaped `pkill -f` regex; `(`, `[`, `+` in a home path break uninstall                                                                      | Escape                                          |
| L-21 | `macosApp.ts:476-480`                                                                                | `installation.json` written into the sealed `Contents/Resources` of the managed signed copy; effect on the seal unverified                                           | Check with `codesign --verify --deep --strict`  |
| L-22 | `connectors/process.ts:25`, `claudeCode.ts:266-280`                                                  | `~/.claude.json` capped at 1,000,000 bytes and every inspection failure reported without a cause                                                                     | Raise the cap; attach a diagnostic              |
| L-23 | `cliProgram.ts:692`, `:708`                                                                          | CLI `--replace` never carries the reviewed fingerprint; the guided setup does                                                                                        | Accept `--replace <revision>`                   |
| L-24 | `installer.ts:699-721`                                                                               | A no-op reinstall copies and smoke-tests 175 MB before the identity check                                                                                            | Check identity first                            |
| L-25 | `installer.ts:175-185`                                                                               | Payload bytes never fsynced before rename; a durable receipt can vouch for a zero-length `bin/node`                                                                  | fsync entrypoints                               |
| L-26 | `verifier.ts:308-313`                                                                                | No SIGKILL after `close()` deadline; hung bridge left running                                                                                                        | Kill `transport.pid`                            |
| L-27 | `UpdateService.qml:103-109`; `StatusPopout.qml:971`                                                  | The one reader that requires `{data}`; copy says "Check npm" although Omarchy uses the packaged provider                                                             | Unwrap both; fix copy                           |
| L-28 | `pimpampum-bootstrap:222-225`, `pimpampum-plugin-lifecycle:316-335`, `pimpampum-control-route:87-88` | No `--proto-redir =https`; `remove` leaves `runtime/<version>/`; `hostname` failure degrades silently to `device_id=linux`                                           | Small hardening                                 |
| L-29 | `pimpampum-control-route:17-61` + three copies                                                       | Receipt and launcher verification prologue written four times; only one rejects control characters in HOME                                                           | One sourced `common.sh`                         |
| L-30 | `package.json:52-56`; `quality.yml:21-22`; `release.yml:27-28`                                       | `test:evals` equals `test:e2e` and both workflows run the E2E twice; `validate:omarchy` runs four times; no `concurrency` group                                      | Remove duplicates                               |
| L-31 | `quality.yml:25`, `release.yml:31`                                                                   | `npm audit --omit=dev` at default level gates the tag on the calendar                                                                                                | `--audit-level=high` on tag                     |
| L-32 | `package.json:107-110`                                                                               | `allowScripts` is honoured by npm 11 (verified) but CI's `npm ci` on Node 22 runs npm 10, which ignores it                                                           | Pin npm 11 before `npm ci` or drop the field    |
| L-33 | `ServiceControl.qml:46-51`                                                                           | Reads stdout synchronously in `onExited` while five sibling services defer through `Qt.callLater`; unverified on a Quickshell host                                   | Align                                           |
| L-34 | `test/omarchy-*.test.ts`                                                                             | Helper tests never use a HOME with spaces or non-ASCII; the quoting in `pimpampum-bootstrap:114-116`, `:332-335` is untested                                         | Add one                                         |
| L-35 | `test/update.test.ts:26`, `:31`; `test/core.test.ts:44-50`                                           | Require an `npm` next to `process.execPath`; `PIMPAMPUM_TOKEN` in the developer shell changes an assertion                                                           | Temp `bin/` layout; clear env                   |
| L-36 | `test/migration-indexes.test.ts:22-27`                                                               | Hand-written v1 DDL without CHECK/REFERENCES/UNIQUE differs from the faithful one in the migration acceptance test                                                   | Share one helper                                |
| L-37 | `quality.yml:3-6`                                                                                    | CI runs on `pull_request` and `push: master` only; `develop` pushes get no CI                                                                                        | Document or add                                 |
| L-38 | `.git`                                                                                               | ~15 blobs of 2.6-4.2 MB are the committed macOS binary, one per release; the pack is 61 MB and grows ~4 MB per release                                               | Move the binary to Release assets               |

## 6. Structure, duplication and complexity

The audit agents produced full tables; this section keeps the items that
change how the code is maintained.

### Hotspots (cyclomatic / cognitive / body lines)

| Unit                                                                                       | Metrics                                                                                                                                                                                        | Direction                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cliProgram.ts:618` `executeCli`                                                           | 113 / ~135 / 554 lines                                                                                                                                                                         | Table-driven handlers per `CLI_COMMANDS` entry                                                                                                                                                            |
| `cliMain.ts:904` `runCliEntrypoint`                                                        | 643 lines, nesting 6, hosts packaged uninstall (`:1221-1421`), install transaction (`:1424-1456`), receipt store (`:169`), signature verification (`:290-392`), packaged provider (`:541-869`) | Extract `composeCliRuntime(host)`, `service/packagedLifecycle.ts`, `cliInput.ts`; leave a 30-line shell; then drop `cliMain.ts` from the coverage exclusion (~650 lines of untested rollback logic today) |
| `store.ts:219-2137` `PimpampumStore`                                                       | 1,919 lines, 91 methods                                                                                                                                                                        | Split by aggregate under one façade; `validateSyncState` (cog 61, no DB) to a pure module; one event writer with an options object instead of 8 parameters                                                |
| `service/manager.ts:568` `install()`                                                       | 37 / 101 / 183 lines, nesting 5 (worst in the repo)                                                                                                                                            | `reconcileExisting` + `installFresh` + one `Transaction` helper (snapshot, mutate, compensate) replacing three hand-written ladders                                                                       |
| `runtime/archive.ts:464` `validateZip`                                                     | 44 / 56 / 159 lines                                                                                                                                                                            | `readEndRecord`, `readCentralDirectory`, `validateLocalEntry`, `validateDataDescriptor`                                                                                                                   |
| `openapi.ts:706-1426`                                                                      | 720 hand-transcribed lines, 54 operations mirroring 59 routes                                                                                                                                  | Generate from Zod (H-10)                                                                                                                                                                                  |
| `http.ts:112` `createHttpApp`                                                              | 498 lines, 6 params                                                                                                                                                                            | Route modules per aggregate                                                                                                                                                                               |
| `mcp.ts:145` `buildMcpServer`                                                              | 821 lines                                                                                                                                                                                      | Registration table                                                                                                                                                                                        |
| `StatusPopout.qml`                                                                         | 1,845 lines, nesting 10, ~850 duplicated lines inside the file, three pages toggled by `visible:`                                                                                              | `PortfolioPage`/`SettingsPage`/`HelpPage` behind a `Loader`; extract `PimpampumCard`, `HoverSurface`, `ManagedFolderCard`; move 27 functions and 18 flags to a `QtObject` controller                      |
| `scripts/test-omarchy-live.mjs`                                                            | `run` 595 lines, `createRealDependencies` 538                                                                                                                                                  | `LiveSession`, declarative seed table, `CaptureFlow`, `EvidenceWriter`, `ProcessRunner`                                                                                                                   |
| `scripts/check-quattro-evidence.mjs`, `validate-omarchy-plugin.mjs`, `test-macos-live.mjs` | script bodies of 457-656 lines, cyclomatic ~130-150; `invariant(a && b && … && m)` with one message                                                                                            | Named check functions, one assertion each                                                                                                                                                                 |

### Duplication worth removing

- Hand-written `parse*` functions without Zod in `setup/state.ts` (5),
  `runtime/installer.ts` (4), `runtime/manifest.ts` (7), `connectors/codex.ts`
  (4), `service/omarchy.ts` (2): ~24 parsers with cyclomatic 20-35, while
  `service/receipt.ts` already shows the Zod pattern.
- `AggregateError` rollback ladder at 13 sites; `allOrAggregate` exists at
  `service/omarchy.ts:534` and is used nowhere else.
- Atomic write partial-then-rename in 9 places (`automaticBackup.ts`,
  `syncController.ts` x2, `backup.ts` x2, `installer.ts`, `setup/state.ts`,
  `receipt.ts`, `connectors/process.ts`) that differ in fsync, chmod and
  error handling. One `atomicFile.ts`.
- `isRecord` in 9 modules; error code list x4; `redactDiagnostic` x3;
  symlink-rejecting tree walk x4 in `src` and x8 in `scripts`; `processIsAlive`
  x2; lifecycle lock x2.
- `store.ts`: 9 UPDATE-with-revision-bump blocks, 3 identical cascade
  cancels (7 identical SET literals), 3 `getXCompletion`, 4 sync upserts with
  column lists written twice.
- `mcp.ts`: 10 "mutate then re-read manifest" blocks.
- `codex.ts` vs `claudeCode.ts`: apply-plan ~75%, conflict branch ~90%,
  restore ~90% (M-R3).
- QML: `BackupService.qml` vs `SyncService.qml` ~75%; `actionableProcessError`
  identical x3; state vocabulary in three places (`AgentsSettingsCard.qml:24-34`,
  `AgentConnectionService.qml:25-35`, `SetupModels.swift:37-49`).
- Swift: `loadConfiguration` + `mapConfigurationError` x3, five-case
  `*ClientError` enums x3, ISO-8601 decoder x4, `WorkspaceOpener` vs
  `BackupDirectoryOpener` ~95%, `ProjectRowButton` vs `SpecRowButton` ~90%.
- Tests: `temporaryDirectory` defined in ~20 files; `availablePort`,
  `stopDaemon`, envelope unwrapping x3; the acknowledgement-writing fake x13;
  the 130-line `CliRuntime` mock x2; two setup dependency factories.

Estimated removable lines: ~600 in `src/`, ~2,000 across QML, Swift and
scripts, and several thousand in `test/` once helpers exist.

### Architecture rules

All CLAUDE.md invariants that were probed hold: only `PimpampumStore` touches
SQLite; completion is an operation; adapters keep error codes; MCP list and
work tools return manifests and bounded reads; loopback binding and the
instance lock live in composition; no version literals. Minor layering slips:
`syncController.ts:22` imports `assertNoSymlinkTraversal` from the installer
layer; `service/manager.ts` imports `launchd` and `systemd` directly while the
real selection lives in `cliMain.ts`; `cliMain.ts:947-949` reads
`process.argv[2]` as a second implicit dispatch.

## 7. Security posture

No Critical. The controls that matter are present and tested: bearer
compared in constant time, 2 MB body limit, loopback-only bind, DNS-rebinding
rejection (from the MCP SDK, verified live but untested here), O_NOFOLLOW
reads in sync, symlink refusal before every deletion, receipt-hashed
ownership, signed release manifests, strict archive parsing, allow-listed
subprocess environments in the connectors.

Open items, in order: H-11 (sync context name traversal), M-V5 (no timeout
and full environment for service commands), M-V9 (update trust root from
user-writable paths and no manifest freshness), L-12 (missing negative tests
for `/mcp` 401 and foreign `Host`/`Origin` 403), L-13 (tmp copy mode window on
Linux). Two design notes to document rather than fix: sync snapshots carry no
authenticity beyond the recomputed hash, and one admin bearer lets any agent
write database copies to arbitrary absolute paths through the backup, export
and sync settings routes (not exposed over MCP).

## 8. macOS application (second-pass review)

What holds: both child pipes drain concurrently on dispatch threads and reach
EOF before `waitUntilExit()` (`SetupCommandRunner.swift:415-419`,
`UpdateSettingsSystemAdapter.swift:24-27`; flood tests at
`UpdateCommandRunnerTests.swift:66-101`); the NDJSON decoder parses the whole
buffer first, caps bytes per event and per stream, pins the schema and rejects
identifiers that start with `-` (`SetupCommandRunner.swift:208-220`,
`:326-331`); child processes get a whitelisted environment (`:476-483`); one
authority validates receipt, loopback and token
(`AuthenticatedDaemonConfiguration.swift:43-77`); credentials and home paths
are redacted before display (`SetupStore.swift:444-470`); the cold-start grace
before reporting offline is honoured by the harness (`OverviewStore.swift:136-143`,
`DesktopSmokeHarness.swift:94-100`); no `.sheet` remains and the confirmation
renders `plan.changes` with real paths (`SetupChangesHelp.swift:61-79`).
`swift test` at HEAD: 211 tests in 30 suites pass.

- **X-01 [High] The overview poll tears the guided setup down while `setup
apply` is still running.** `StatusPopover.swift:96-104` renders
  `SetupOnboardingView` only while `connectionState == .setupRequired`;
  `OverviewStore` keeps polling every 5 s while the popover is open and
  `refresh()` sets `.online` as soon as the daemon answers
  (`OverviewStore.swift:103-131`). The CLI writes the receipt and activates the
  daemon (`src/service/manager.ts:691-695`) before login-item registration and
  every connector phase (`src/setup/coordinator.ts:350-429`, `:447-510`). The
  onboarding view, its `@StateObject` store and its `@State` step are destroyed
  while `Task { await store.apply() }` (`SetupOnboardingView.swift:520`) is
  running. Step 4 is where conflict recovery, "Try again", the login approval
  notice and the Done button that triggers the relaunch live
  (`SetupOnboardingView.swift:346-358`); with connectors selected they run
  after the daemon is up, so the user lands on "Loading overview" mid-setup,
  never sees a partial failure, and `pendingApplicationRelaunch` is never
  consumed, so a copy started from Downloads keeps running. Own the setup
  session outside the conditional view and keep rendering it while
  `activity.hasBegunMutation || completion != nil`, or pause polling while a
  mutation is in flight. Likely: mechanism confirmed on both sides, not observed
  live.
- **X-02 [High] Single-instance stand-down races the relauncher and can leave
  the menu bar with no app.** `App.swift:17-25` `shouldStandDown` terminates
  the newer instance whenever an older process shares the bundle id, without
  comparing `bundleURL`. On the copy-to-`~/Applications` path the CLI runs
  `open -n <installedApp>` (`src/service/macosApp.ts:549`) while the Downloads
  copy is alive, so that instance exits at once. At Done, `relaunchIfNeeded`
  (`EmbeddedSetupBootstrap.swift:99-114`) launches a new instance and then
  terminates the current one; the newcomer evaluates `shouldStandDown` in a
  `Task` after launch, and if LaunchServices still lists the Downloads process
  at that instant the newcomer exits too, leaving no menu-bar app until the
  next login. The same rule makes a newer build launched from Downloads exit
  silently whenever an older adopted version is running. Stand down only for a
  peer whose `bundleURL` equals `Bundle.main.bundleURL`, skip peers with
  `isTerminated`, or pass a launch argument from the relauncher; add a two-path
  case to `SingleInstanceTests.swift`. Likely: the window is real, the outcome
  depends on `openApplication` timing.
- **X-03 [Medium] A failed or skipped plan leaves an enabled button that does
  nothing.** `SetupOnboardingView.swift:411`, `:426`, `:519-526`, `:572-600`;
  `SetupStore.swift:75`, `:161-179`, `:267-274`. `review()` returns silently
  unless `activity == .idle`; `start()` runs `resume()` in parallel, so a fast
  Enter-Enter reaches step 3 with planning skipped; a failed `setup plan` leaves
  `plan` nil. The spinner "Working out the exact list" stays forever,
  `canReview` is true, and `reviewAndSetUp()` returns on its guard. Disable the
  button while `plan == nil || errorMessage != nil` and show an error row with
  "Try again". Confirmed for the failed-plan path.
- **X-04 [Medium] A terminal journal rehydrates as a completed setup and
  strands reinstall.** `SetupStore.swift:276-277`, `:350-401`;
  `SetupOnboardingView.swift:565-568`, `:346-358`. `resume()` turns any
  non-running journal into `completion` and the view jumps to step 4. The CLI
  never deletes `setup-state.json` (`src/setup/state.ts:487` has no callers;
  uninstall removes only the receipt), so after `uninstall` or a failed base
  phase the popover opens on "4 OF 4" with the stale result, step 4 has no
  Back, and Done shows the same screen. `SetupClientStoreTests.swift:491-515`
  asserts this. Rehydrate only running journals; add "Start over"; remove the
  journal on uninstall. Confirmed.
- **X-05 [Medium] The header help button resets the guided setup and spawns a
  competing `setup resume`.** `StatusPopover.swift:83-104`, `:221-232`;
  toggling `isHelpPresented` swaps the `if/else` branch and discards the store
  and step. A fresh store's `start()` reads a running journal and calls `setup
resume --events` while the apply holds `.setup-lifecycle.lock`; the CLI
  waits 30 s (`src/setup/state.ts:597-647`) then fails with "Timed out waiting
  for the setup lifecycle lock" as `internal_error`, which lands as a banner on
  step 4 with agents frozen at "Connecting". Hide help during setup or render
  it inside the onboarding; poll `setup status` instead of `setup resume`
  while a journal is running. Confirmed for the reset; likely for the lock
  contention.
- **X-06 [Medium] The relaunch target is hardcoded to
  `~/Applications/Pimpampum.app`.** `EmbeddedSetupBootstrap.swift:16-20`,
  `:54-66` never read the `application-path.json` the CLI writes
  (`macosApp.ts:210-225`, `:610-615`). With an adopted `/Applications` bundle
  and a stale `~/Applications` copy, Done launches the stale copy and
  terminates the adopted one. The packaged updater hardcodes the same path
  (`src/cliMain.ts:646`, `:745-748`). Read the record or return the path in the
  setup result. Likely.
- **X-07 [Medium] "How it works" is 440 pt wide inside a 360 pt popover.**
  `HelpDialog.swift:95-96` `.frame(width: 440)` plus padding inside
  `StatusPopover.swift:88-94`, `:155` `.frame(width: 360)`; text wraps at 440
  and the sides are clipped. A leftover from the sheet era. Use `maxWidth:
.infinity` like `SetupChangesHelpDialog`. Confirmed by arithmetic; not
  rendered.
- **X-08 [Low] The app depends on an undeclared verb and a stale fixture.**
  `SetupCommandRunner.swift:125` calls `setup retry <id> --events`, which
  `src/cliCommands.ts` does not declare (M-S2); `SetupOnboardingCopyTests.swift:128-139`
  pins the plan fixture the CLI no longer emits (H-15).
- **X-09 [Low] Dead cancellation path and a possible wrong-bundle login-item
  registration.** `beginReview`, `cancelBeforeMutation` and `canCancel`
  (`SetupStore.swift:76`, `:152-159`, `:294-297`) have no callers.
  `SetupAssistant.prepareApp()` registers `SMAppService.mainApp` from whichever
  copy is running, so from a Downloads copy it may register the transient
  bundle (unverified).

Structural reading: the app is a set of thin, well-bounded adapters around a
bundled CLI, and the files inside the coverage manifest are strong on parsing,
validation and redaction. The weaknesses cluster where lifecycle state is
owned by SwiftUI view identity: `SetupStore` is a `@StateObject` of a
conditionally rendered child and the step machine is `@State`, so a poll tick
or a help button can destroy a setup in progress. Every X finding lives in
`SetupStore.swift`, `SetupOnboardingView.swift`, `App.swift`,
`EmbeddedSetupBootstrap.swift` or `StatusPopover.swift`, none of which
`check-swift-coverage.sh:29-48` measures. Location and instance policy is
duplicated across TypeScript and Swift (managed path, bundle id at
`LoginItemSystemAdapters.swift:27`, connector state strings matched by
substring at `SetupStore.swift:416-431`). No test drives the real CLI through
the real decoder or the real view lifecycle; the live smoke exercises setup
only through the CLI.

## 9. Documentation, process and site (second-pass review)

What holds: the README's tool counts (36 over HTTP, 32 over stdio) match
`src/mcp.ts:145-159` and `src/mcpStdio.ts:8`; the unauthenticated routes match
`src/http.ts:138` and `:589`; the configuration table matches
`src/config.ts:53-68`; `package.json`, `server.json`, `README.md`, the plugin
`manifest.json` and the site all say `1.2.11`; LICENSE is MIT and the
repository URLs point at `r-bart/pimpampum`; `docs/agents.md` names error
codes that exist; `docs/evals.md` counts the six E2E tests that exist.

- **D-01 [High] A native install has no documented route to a registered
  Workspace.** `README.md:48-49`, `:171-176` promise that setup never opens
  Terminal; `docs/mcp-tools.md:171-172` calls registration "an administrative
  CLI or HTTP operation"; the macOS empty state (`StatusPopover.swift:313`)
  gives no instruction; the Omarchy empty state (`StatusPopout.qml:579`)
  prints a bare `pimpampum workspace:add`, but the native CLI lives at
  `.../bin/pimpampum-control` (`src/runtime/layout.ts:59`, `:78`), nothing
  links it onto `PATH`, and the README never mentions it. A user who followed
  only the app or plugin path cannot complete the README's first workflow
  without also installing the npm package. Add a Workspace registration action
  to the guided setup's final step and the empty state, or document the
  launcher path per platform.
- **D-02 [High] The marketing site describes the pre-1.2 first run.**
  `site/src/pages/index.astro:333`, `:352-359` lead with `npm install
--global pimpampum` and say the app "copies the one command it still needs
  and opens Terminal for you". The guided setup replaced that flow, and
  `README.md:666-670` calls the npm CLI the advanced alternative. The page is
  stamped `1.2.11` twice. Rewrite `Get it` from `README.md:51-83`.
- **D-03 [Medium] Omarchy installation is documented three ways.**
  `README.md:73-83` (`omarchy plugin add …`, "do not copy the plugin
  directory"), the plugin `README.md:58-71` (`pimpampum install` as the single
  command, npm presupposed, `omarchy plugin add` never mentioned), and
  `site/public/llms.txt:12-26` (npm then `pimpampum install`). The plugin README
  ships in the npm tarball.
- **D-04 [Medium] The plugin README's security boundary omits the Agents card
  and its helper.** `integrations/omarchy/pimpampum-status/README.md:5-8`,
  `:31-56` list four cards and three kinds of write; `StatusPopout.qml:415`,
  `:941` instantiate `AgentsSettingsCard`, and `pimpampum-connections:17-37`
  accepts `plan | connect | test | disconnect | repair [replace]`, which write
  host configuration. CLAUDE.md already carries a gotcha demanding this update.
- **D-05 [Medium] Two contradictory MCP connection stories for agents.**
  `site/public/llms.txt:14`, `:33-41` and the site call `{"command":
"pimpampum-mcp"}` the whole configuration and `pimpampum install` "safe for an
  agent to run unattended"; `README.md:270-283` and `docs/mcp-tools.md:53-55`
  say to prefer the absolute launcher; `docs/agents.md:7-9` orders the agent to
  stop and ask the operator. The `unavailable` suggestion
  (`src/agentProtocol.ts:30-31`) tells the agent to run `pimpampum install`.
  `llms.txt` exists to be read by agents.
- **D-06 [Medium] "100% coverage" is stated without its exclusions.**
  `README.md:723-724` vs `vitest.config.ts:9`; the excluded `cliMain.ts` holds
  the install, uninstall, update and setup orchestration where the last ten
  hotfixes landed.
- **D-07 [Medium] Shipped plans and one spec still read as unfinished.**
  `thoughts/plans/2026-08-25_desktop-status-integrations.md:4` "In progress";
  `2026-08-27_desktop-v1-release-readiness.md:4` "Ready for execution" and
  "7 compiled workflow evals" (there are six); `2026-08-26_desktop-design-handoff-integration.md:4`
  and `2026-08-26_domain-model-v2.md:4` "Quattro live evidence pending"
  although the gate was retired on 2026-08-28;
  `thoughts/specs/2026-08-25_desktop-status-integrations.md:12`, `:247`, `:263`
  describe an unsigned app. CLAUDE.md tells agents to orient from these files.
- **D-08 [Medium] Nothing keeps `server.json` and the site version aligned.**
  `release.yml:26` compares the tag with `package.json` only; `server.json:6`,
  `:17` and two literals in `index.astro` are maintained by hand. `server.json`
  is the MCP registry manifest.
- **D-09 [Low] Site hygiene.** `site/astro.config.mjs:5` is `defineConfig({})`
  (no canonical, no sitemap); no Open Graph tags; no CI builds the site;
  `robots.txt:5-7` names `llms.txt` without a path; `site/README.md` and
  `site/AGENTS.md` are Astro boilerplate.
- **D-10 [Low] Install footprint is undocumented.** `~/Applications/Pimpampum.app`
  (managed copy), `~/Library/Application Support/Pimpampum/`,
  `~/.local/share/pimpampum/`, `~/.config/omarchy/plugins/dev.pimpampum.status`
  appear nowhere in the README or its uninstall contract (`README.md:414-417`).
- **D-11 [Low] Reference gaps.** `PIMPAMPUM_RELEASE_MANIFEST_URL` and
  `PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH` (`cliMain.ts:555`, `:561`) are
  undocumented; the agent error table (`docs/agents.md:81-89`) lacks
  `payload_too_large` and `internal_error`; the site lists "activity feeds"
  as omitted while `activity_list` exists.
- **D-12 [Low] Agent-instruction files drift.** `AGENTS.md:20` says "PascalCase
  components" where CLAUDE.md says camelCase modules; `AGENTS.md:38` omits
  `/post-review` for bug fixes; `loop.manifest.yaml:39-43` omits
  `format:check`; `.ai-template/manifest.json:39-48` claims `AGENTS.md` and
  `loop.manifest.yaml` are unmodified (checksums differ).
- **D-13 [Low] No changelog.** Release notes are GitHub's generated commit
  lists (`release.yml:207`); eleven patch releases in two days have no
  user-facing record.

Process reading: the artefacts are unusually rich for a solo project. The
weakness is closure, not creation. Plans are not marked done when the tag
ships, a spec is not amended when the product diverges, and the public
surfaces (site, `llms.txt`, plugin README) are not on the release checklist,
so they describe the product one or two minors ago. One release-checklist
step ("update site, `llms.txt`, plugin README and plan statuses; run the
version-alignment check") closes most of this section.

## 10. Process observations

- 182 commits in eight days, 65 of them on 2026-08-31; 51 `fix` against 31
  `feat`; 15 tags from v1.1.1 to v1.2.11 in about a week, with four failed
  release attempts for v1.2.11. The release loop (M-O6) and the non-atomic
  publish (M-O1) explain most of the retries.
- `develop` pushes get no CI (L-37). Releases come from `master`, so the gap
  is acceptable only while every change reaches `master` through a PR.
- The 100% coverage threshold is producing the wrong incentive: dead public
  methods kept alive by tests (L-02, M-R4), a fake database double (H-16),
  hook sequences the manager never runs (M-T4), and `cliMain.ts` excluded
  wholesale. Coverage on the covered files is real; the number says nothing
  about the 1,548 excluded lines where the install and uninstall transactions
  live.
- The "immutable" and "frozen hash" mechanisms are being re-pinned as a
  matter of routine (H-14). Either enforce them for every set or retire them.
- `.claude/rules/architecture.md` is still the unfilled template;
  `.ai-template/manifest.json` claims CLAUDE.md is unmodified;
  `thoughts/SUMMARY.md` duplicates the latest summary byte for byte;
  `loop.manifest.yaml` points at the 2026-08-26 DoD; `site/public/llms.txt:122-123`
  links to `blob/main/` on a repository whose default branch is `master`.

## 11. Suggested order of work

The task-level plan with dependencies and a coverage matrix for every id is
[2026-09-01_deep-review-remediation.md](../plans/2026-09-01_deep-review-remediation.md).

**Now (release-blocking, days)**

1. H-01 update channel: publish the signed manifest and key, follow
   allow-listed redirects, fix or disable the Linux route, correct the README.
2. H-02 mirror job; H-03 remove `ulimit -f`; M-O4 forward CLI error codes in
   the connections helper.
3. H-04 code-unit ordering with a versioned hash; H-05 phantom workspace;
   H-11 slug in the sync contract; M-C1 and M-C2 delete order and chunking.
4. H-06, H-07, M-V1, M-V2, M-V3: persist `managed`, guard the adopted path,
   extend the login-item wait, handle the missing bundle. Add the three
   topology tests from M-T1.
5. X-01 and X-02: own the setup session outside the conditional view and
   compare bundle URLs before standing down.
6. H-08 systemd restart; H-09 read-only inspect; M-R1 repair on drift.
7. H-12 and L-38: stop shipping the app in the npm package and in Git.
8. M-O1 and M-O2: draft release first, scoped permissions.
9. D-01 and D-02: give a native install a way to register a Workspace, and
   rewrite the site's `Get it` section from the current README.

**Next (contract hygiene, one to two weeks)**

10. X-03 to X-07: disable the setup button without a plan, rehydrate only
    running journals, hide help during setup, read `application-path.json`
    from Swift, fix the help width.
11. D-03 to D-08: one Omarchy install story, the Agents helper in the plugin
    security boundary, `llms.txt` aligned with `docs/agents.md`, coverage
    exclusions named, plan statuses closed, `server.json` and the site version
    in the release check.
12. H-10 generate OpenAPI from Zod and walk the router in the test; M-A4 one
    error-code constant; M-A5 remove duplicated MCP schemas; M-C3 move the
    "nothing to update" guard into the store.
13. M-S1 lazy composition so `help`, `version` and `status` never fail on
    local state; M-S2 and M-S3 route every verb through the catalog.
14. M-S4 to M-S7 sync operability: name the blocking file, publish only on
    change, specify retention, drop `baseState`.
15. M-V4 to M-V7 and M-V9: one lock, bounded service commands, fsynced
    receipts with a repair path, retry preconditions, embedded release key.
16. M-R2 to M-R5: memoized detection, shared connector core, delete
    `registry.ts` extras, TypeScript-owned receipts on Omarchy.

**Later (test honesty and structure, ongoing)**

17. H-13 to H-17 and M-T1 to M-T9: retire greps and frozen hashes, regenerate
    fixtures from producers, replace mock-call assertions with state
    assertions, add the concurrency and duplicate-device tests, shared test
    helpers, rename `sync-e2e`. Widen the Swift coverage manifest to the five
    lifecycle files named in section 8.
18. Section 6: split `executeCli`, `runCliEntrypoint` (then un-exclude it
    from coverage), `PimpampumStore`, `manager.install`, `StatusPopout.qml`,
    and the live scripts; Zod for the 24 hand-written parsers; one atomic
    write, one rollback helper.
19. Process: fill `architecture.md`, delete the stale template manifest and
    duplicate summary, fix `llms.txt`, decide on `develop` CI, move the macOS
    binary out of Git history going forward, add a changelog and the site
    hygiene items (D-09 to D-13).

## 12. What was not reviewed

- No live Omarchy, Quattro or systemd host was available. H-08 and every
  Omarchy runtime claim rest on reading code and documentation.
- The race in H-09 was traced, not reproduced. X-01 and X-02 were traced in
  Swift and TypeScript, not observed in a running app; the local
  `dist/Pimpampum.app` has no embedded runtime, so setup could not be exercised
  from it.
- The sync poller cost (M-S5) was not measured.
- Branding assets, `site/` page content beyond the links checked, and the
  `thoughts/design/` hand-off were not assessed for accuracy.
- Whether adding `installation.json` under `Contents/Resources` breaks the
  code seal (L-21) was not tested with `codesign`.
