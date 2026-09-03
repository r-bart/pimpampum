# Changelog

User-facing changes per release. Versions follow semantic versioning; every tag is a GitHub Release
with signed macOS, Linux runtime, manifest, SBOM, and checksum assets, and an npm publication with
provenance. Earlier releases (`v1.0.0` to `v1.2.8`) are described by their GitHub Release notes and
by `thoughts/summaries/`.

## v1.3.1 — 2026-09-03

A first-run fix for Omarchy, found by installing `v1.3.0` from its published channel on a real
Omarchy machine.

- **The packaged install no longer rewrites the plugin directory Omarchy owns.** An installed CLI
  carries no build tree, so it plans the plugin files from the directory `omarchy plugin add`
  installed — and then wrote all of them back, byte for byte identical. Omarchy watches that
  directory: each install fired 184 plugin reloads in one burst, wedging the shell IPC that the same
  install calls for `plugin list` and `rescanPlugins`. Setup failed roughly two times in three, and
  succeeded on a retry. `install` now skips any artifact whose bytes and mode already match on disk,
  which also makes every install idempotent on both platforms.

## v1.3.0 — 2026-09-02

Remediation of the 2026-09-01 deep review (`thoughts/reviews/2026-09-01_deep-review.md`): all 128
findings, in four waves plus their documentation. Section 1b of that report is the ledger of which
wave closed each finding. Grouped below by finding family.

The release the review's plan mapped to five tags (`v1.2.12` to `v1.2.15`, then `v1.3.0`) ships as
one minor version. The HTTP and MCP wire contracts are unchanged: every public method set, error
code, message and envelope shape is preserved. Two things do change for a caller, and both are
listed below: `pimpampum backup retry` reports a failed backup in its payload instead of in its
exit code, and databases migrate forward to schema v3, which is one-way. A `v1.2.11` daemon that
opens a v3 database refuses with a typed error naming both versions, so a rollback needs a backup
taken before the upgrade.

### Wave 1 — release channel, sync integrity, macOS topology, Omarchy helpers, runtime installer

- Update channel (H-01, L-15, L-16, M-V9): the Ed25519 release public key is embedded in the CLI;
  `release-manifest.json` is signed in the release job and published to the rolling
  `update-channel-stable` release with `issuedAt`; redirects are followed only over HTTPS to
  allow-listed hosts; on Linux `update` answers a typed `unavailable` whose remedy is
  `pimpampum-bootstrap`.
- Omarchy delivery (H-02, H-03, M-O3 to M-O7): the plugin mirror is pushed and verified from the
  release workflow; `ulimit -f` no longer breaks Claude Code connect; the connections helper forwards
  CLI error codes.
- Sync (H-04, H-05, H-11, M-C1, M-C2, M-S4 to M-S7): locale-independent canonical ordering with a
  versioned hash; no phantom workspace from an unresolved import; synced context names cannot escape
  the export directory; delete order and chunking fixed; the blocking file is named.
- macOS install topology (H-06, H-07, M-V1 to M-V3, M-V5, X-01 to X-07, X-09): the installed CLI
  records the app location and the `managed` flag; an adopted user-owned bundle is never modified or
  deleted; the login-item wait is extended; the setup session is owned outside the conditional view;
  the single-instance guard compares bundle URLs.
- Service (H-08, H-09, M-R1): the systemd adapter restarts a running daemon; journal recovery is
  read-only outside the lifecycle lock; drift is repaired.
- Packaging (H-12, L-38): the npm package no longer ships the 150 MB macOS app; the
  `platforms/macos/dist/` tree is ignored.
- Release process (M-O1, M-O2, D-08): draft release first, scoped permissions,
  `check-release-versions.mjs` keeps `server.json`, the plugin manifests, and the site aligned with
  the tag.
- Tests (M-T1, M-T3, M-T7, M-T8, H-14 policy): shared test helpers; the frozen hashes stay on the
  four overview fixtures only.

### Wave 2 — adapter contracts, CLI composition, service and connector hardening, macOS follow-ups

- Adapters (H-10, M-A1 to M-A8): the OpenAPI components are generated from Zod and checked against
  the router; one error-code constant; duplicated MCP schemas removed.
- CLI (M-S1 to M-S3, X-04, X-06, X-08): lazy composition so `help`, `version`, and `status` never
  fail on local state; every verb routes through the catalog; uninstall supersedes the setup journal.
- The macOS live smoke's two-minute guided-setup budget measured the wrong span. `main` runs
  `verifyLegacyMigration` between the first-run UI and the connector lifecycle, so 88s of legacy
  migration sat inside a window meant to cover preflight through the first verified agent. The
  guided setup itself costs 44.7s and the whole measured window now reports 91.3s against the 120s
  budget. The migration is excluded by subtraction, not by reordering, because the later scenarios
  build on the state it leaves. Nothing in the product changed.
- **Behaviour change.** `pimpampum backup retry` now exits zero when the backup itself failed, and
  puts the reason in the payload as `state: "error"` with a populated `error`. Up to `v1.2.11` it
  raised `internal_error`, so the reason was flattened into an exit code. The macOS Settings card
  calls the daemon over HTTP and is unaffected; the Omarchy card reads the returned state and still
  shows the failure. A script that only checked the exit code must now read `state`.
- Service and setup (M-V2, M-V4, M-V6 to M-V9): one lifecycle lock; bounded service commands;
  fsynced receipts with a repair path; manual uninstall instructions propagate; older manifests are
  rejected by `issuedAt`.
- Connectors (M-R2 to M-R4): memoized detection and a shared connector core for Codex and Claude
  Code.
- macOS (D-01, L-21): **Add a workspace** on the last setup step and the empty overview; the
  installation marker moved out of the signed bundle to
  `~/Library/Application Support/Pimpampum/installation.json`; Swift decoders accept
  `blockedSnapshot` and the backup error state.
- Omarchy (D-01): **Add a workspace** in the empty popout through the bounded
  `pimpampum-control-route workspace add` route; the Updates card renders the Linux remedy.

### Wave 3 — documentation (this changelog)

- One install story: the macOS app and `omarchy plugin add` first, npm as the advanced alternative,
  in the README, the plugin README, `llms.txt`, and the site (D-02, D-03, D-05).
- README: "What gets installed where", the packaged CLI path per platform, workspace registration
  among the bounded native writes, named coverage exclusions (D-06, D-10).
- Plugin README security boundary: `pimpampum-common.sh`, `pimpampum-connections` and its verbs, the
  Agents card, `cliCode` forwarding, `workspace add`, the `uname -n` device id (D-04).
- Reference gaps closed: agent error table, `PIMPAMPUM_RELEASE_*` variables, the site's omission
  list, eval counts (D-11).
- Process artefacts: plan statuses name their release tag; the desktop-status spec is amended for
  signing; `AGENTS.md`, `loop.manifest.yaml`, `.claude/rules/architecture.md`, and
  `thoughts/SUMMARY.md` are real; `.ai-template/manifest.json` is deleted (D-07, D-12, D-13).
- Site hygiene: canonical URL, sitemap, Open Graph tags, `robots.txt` with `Sitemap:` and the
  `llms.txt` path (D-09).

### Wave 4 — structure across store, runtime, CLI, service, scripts and native surfaces

Section 6 of the review (hotspots, duplication, architecture rules). Behaviour is unchanged except
for the three defects named below; every public method set, error code, message and wire contract is
preserved.

- Store: `PimpampumStore` becomes a 260-line facade over 16 aggregate modules that share one
  `StoreContext`, with one revision bump, one cascade cancel, one completion projection and one
  activity writer. `validateSyncState` moves to `src/syncValidation.ts` as a pure function.
- Schema v3: `workspaces.root_path` is nullable, so a workspace that arrives through synchronization
  without a local root no longer needs a sentinel path. A v2 sentinel row converts to `NULL`, and a
  v1 database chains v1 to v3 in one transaction. Registering a workspace whose root clashes now
  raises the typed conflict instead of a raw SQLite error.
- Runtime: `installer.ts` becomes a 30-line facade over `ownedFiles`, `receipt`, `journal`,
  `payload`, `install`, `removal` and `inspect`, so the lifecycle-lock boundary is a module
  boundary. `validateZip` splits into `readEndRecord`, `readCentralDirectory`, `validateLocalEntry`
  and `validateDataDescriptor` with a validator map for extra fields.
- CLI: `executeCli` dispatches from `CLI_COMMANDS` through one handler module per group.
  `cliMain.ts` drops from 1,937 to 77 lines over nine `cliComposition` modules and
  `service/packagedLifecycle.ts`, all reached through an injected host, and leaves the coverage
  exclusion in `vitest.config.ts`.
- Shared primitives: the receipt copies of `writePrivateFileAtomic` and `assertNoSymlinkTraversal`
  retire into `src/fsAtomic.ts` and `src/fsGuards.ts`; five `isRecord` copies and two `asError`
  copies into `src/objects.ts`; two `redactDiagnostic` copies into `src/diagnostics.ts`; 13 rollback
  ladders into `src/aggregateRollback.ts`. `manager.install` splits into `reconcileExisting` and
  `installFresh` over a transaction helper, and 13 hand-written parsers become Zod schemas.
- Scripts: shared helpers under `scripts/lib`, the Omarchy live runner decomposed into
  `scripts/omarchy-live` with byte-identical evidence, and the three checkers rewritten so each
  assertion is one named condition. The plugin validator targets a surface rather than a file, so
  QML can be reorganized inside a screen without editing the validator, while moving copy between
  screens still fails.
- Native surfaces: `StatusPopout.qml` drops from 1,983 to 307 lines behind a `Loader` over
  `PortfolioPage`, `SettingsPage` and `HelpPage` with a `PopoutController` and shared components;
  `BackupService` and `SyncService` derive from `ManagedFolderService`. One state vocabulary is
  generated for QML and Swift with a `--check` mode wired into both native gates. Swift gains a
  `DaemonClient` base under the three HTTP clients, one `DirectoryOpener` and one row button.
- Three defects fixed in passing. The runtime stage-marker write sat outside the `try`/`finally`
  that clears the staging directory, so a failed write left an empty `.pimpampum-stage-*` that the
  next install rejected as not receipt-owned. `createAgentClient` threw synchronously although it
  returns a promise, so a caller using `.catch()` missed the failure. The Omarchy connection service
  compared agent state against loose literals instead of the generated vocabulary, in 21 places.
- Tests: the source contract covers all five CLI payload readers and pins both sides of the set, so
  a sixth reader cannot ship untested. The `xdg-open` safety row pins both launcher call sites and
  forbids shell interpolation across every QML file instead of one. It is also the only test file
  that reads repository sources: the Omarchy connection wiring contract moved into it.
- The 100% coverage gate stopped depending on timing. `runServiceCommand`'s SIGKILL escalation was
  covered only because an unref'd 100 ms grace timer happened to fire before the test file ended; a
  loaded machine left it uncovered and failed the threshold with every test passing. The test now
  waits for the child to disappear, which is what proves the escalation ran, and covers the branch
  on every run.
- The macOS live smoke runs again. Removing the app from the npm package left
  `scripts/test-macos-live.mjs` reading it back out of `node_modules/pimpampum/platforms/macos/dist`,
  a path that stopped existing in the same change. Every run failed at its first command, and only
  the release job runs it, so no release had exercised it since. It now stages the built bundle with
  `ditto` from `platforms/macos/dist/Pimpampum.app`, which is how a user receives it and where the
  release job's own approval step leaves the signed copy.
- The macOS bundle version stopped being a manual step. `platforms/macos/Resources/Info.plist` had
  its `CFBundleShortVersionString` edited by hand at every release up to `v1.2.11`, and no checker
  covered it, so a forgotten bump failed late in the release job rather than at
  `check-release-versions.mjs`. The template now carries `__PIMPAMPUM_VERSION__`, the build
  substitutes `package.json`'s version and refuses a template without the placeholder, and the
  version check rejects a literal there.
- The structural limit became a real check. `.oxlintrc.json` did not exist, so `npm run lint` never
  evaluated the review's "no unit over 100 lines or cyclomatic 25" clause. It does now, on `src/**`,
  with nine declarative factories exempted from the length rule by name and reason. Six procedures
  that broke a limit were split, behaviour unchanged: `importPending` in `src/syncController.ts`
  (144 lines to 55), `verifyMcpRoute` in `src/connectors/verifier.ts` (cyclomatic 29 to 15),
  `planHostConnection` in `src/connectors/core.ts` (112 lines to 41), `startServer` in
  `src/server.ts` (107 to 26), `verifyServiceHealth` in `src/service/health.ts` (cyclomatic 28 to 7)
  and `request` in `src/client.ts` (26 to 11).

### Beyond the remediation

- The guided setup shows its four steps as a bar that fills as you advance, in place of the `1 OF 4`
  counter. Every segment up to the current step is filled, so the header reads as progress rather
  than as a cursor. Screen readers still hear `Step 1 of 4`, which is now the only place the count
  is spelled out, and the bar does not animate under Reduce Motion.

## v1.2.11 — 2026-09-01

macOS first-run reliability. The published `v1.2.10` could not complete setup on a clean Mac.

- Fixed fourteen first-run defects: the setup decoder now parses the CLI's indented envelope;
  `status` and `uninstall` no longer plan artifacts from the app bundle; `resume` reads the journal
  before announcing a mutation; a Mac with no detected agent can confirm setup; agent detection
  follows symlinks in `~/.local/bin`; the relaunch runs after `apply()` completes; the overview waits
  through the cold-start grace before reporting offline.
- Install topology: an app already placed in an Applications folder is adopted instead of copied, so
  the login item no longer starts a second copy; the installed CLI records the application path.
- Guided setup rewritten: four steps with a welcome step; the confirmation screen lists the real
  path of every planned change; help opens inside the popover instead of a sheet that closed it; the
  popover keeps one size across steps.
- Swift coverage manifest widened with `SetupModels.swift`.
- Release: four failed attempts before the tag, all caught before publication by the live smoke and
  the runtime digest check. The Omarchy runtime digests are the ones CI produces.

## v1.2.10 — 2026-08-31

macOS first-run hotfix.

- The first-run popover no longer collapses to an empty body when the menu-bar host proposes zero
  height; Guided setup is visible on a clean install.
- The distributed bundle is `Pimpampum.app` (the executable remains `PimpampumMenuBar`).
- Relaunch after installation targets the exact installed app with a fresh LaunchServices instance.
- Native and live smoke harnesses require a visible Guided setup popover before any installation
  mutation.
- Omarchy runtime pins updated to the native Linux arm64 and x64 archives of this version.

## v1.2.9 — 2026-08-31

Zero-friction local agent setup: the release that closed the feature plan
`thoughts/plans/2026-08-31_zero-friction-local-agent-setup.md`.

- Setup rollback and disconnect hardening: Codex verifies absence and restores owned state on a
  failed disconnect; the Omarchy lifecycle treats a still-present entry as a failed disconnect even
  when the host command exits zero; aggregate compensation failures stay durable in the setup journal.
- The app and the plugin ship their own pinned runtime (`darwin-arm64`, `linux-arm64`, `linux-x64`)
  with manifest, inventory, and SBOM; `launchd` or `systemd --user` owns the daemon.
- Codex and Claude Code connectors with ownership receipts, conflict detection, atomic changes,
  disconnect, and a bounded MCP verifier; the stable `pimpampum-mcp` launcher carries no token.
- Guided setup on macOS and the Agents card on Omarchy; `setup plan`, `setup apply`,
  `setup status`, `setup resume`, `connect`, `repair`, and `disconnect` in the CLI.
- Release qualification: nested macOS signing, notarization and stapling, exact-artifact live smoke,
  npm provenance, and the reviewed Omarchy runtime pins checked before a tag.
