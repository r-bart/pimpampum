# Implementation Plan: Zero-friction local agent setup

**Date**: 2026-08-31  
**Status**: Complete — released as `v1.2.9`
**Source specification**:
[2026-08-31_zero-friction-local-agent-setup.md](../specs/2026-08-31_zero-friction-local-agent-setup.md)

---

## Overview

Ship Pimpampum as a self-contained per-user product on macOS and Omarchy: the native surface
explains one private service, detects Codex and Claude Code, performs one reviewed setup operation,
and verifies the daemon plus every selected MCP connection without exposing Node.js, npm, tokens,
Terminal, or host configuration.

The implementation keeps the TypeScript daemon, SQLite store, MCP server, and existing
`launchd`/`systemd --user` topology. Distribution changes from “use the user's Node/npm” to a
private, versioned runtime owned by Pimpampum. A shared setup coordinator and connector layer own
all mutations; SwiftUI and QML remain presentation clients.

## Planning Preconditions

- The PRD is approved and the macOS **Guided** onboarding direction is validated.
- The matching
  [Tests-as-DoD manifest](../tests/2026-08-31_zero-friction-local-agent-setup.md) freezes 59 cases
  across Vitest and Swift Testing. Verify its seven SHA-256 hashes before and after every execution
  phase; never edit the generated files during implementation.
- The current worktree contains the untracked approved PRD. Preserve it and any unrelated user
  changes.
- Package manager: npm (`package-lock.json`).
- Current reference hosts observed during planning:
  - Codex CLI `0.151.0`, with JSON-capable `mcp list/get` and CLI-owned add/remove operations.
  - Claude Code `2.1.251`, with local/project/user scopes and CLI-owned add/remove operations.

---

## Requirements

- [x] A clean macOS or Omarchy setup requires no external Node.js/npm and no Terminal command in
      the normal path.
- [x] Pimpampum installs one private, versioned runtime and one OS-managed per-user daemon.
- [x] Codex and Claude Code are detected locally, selected by default when supported, connected
      through one explicit confirmation, and verified independently.
- [x] Host configuration never contains the Pimpampum bearer token.
- [x] Existing npm installations migrate without copying or resetting data and without running two
      daemons against the same SQLite database.
- [x] Unknown host entries named `pimpampum` stop for an explicit conflict decision.
- [x] Setup, migration, update, repair, disconnect, and removal are idempotent, revision-aware,
      resumable, and reversible.
- [x] The macOS app implements the selected three-step Guided onboarding and an Agents settings
      section.
- [x] The Omarchy plugin exposes the same connection states through bounded helpers and QML.
- [x] Signed release assets, artifact checks, live smoke tests, and documentation cover the new
      distribution.

---

## Current Architecture and Reuse Boundaries

### Reuse unchanged

- `PimpampumStore`, SQLite schema/migrations, HTTP API, and domain rules.
- Streamable HTTP MCP in the daemon and the existing ephemeral `mcpStdio.ts` bridge.
- Loopback-only listener, private token, `0700` data directory, and `0600` token/receipt files.
- `createPlatformServiceManager`, service lifecycle lock, receipts, snapshots, and platform
  adapters as the base transaction machinery.
- `launchd`, `systemd --user`, Login Items recovery, macOS Quiet visual language, and Omarchy
  bounded-helper pattern.

### Extend deliberately

- Runtime layout and installation are new infrastructure and must not be represented as thousands
  of in-memory `ServiceArtifact` snapshots.
- Service reconciliation needs a post-activation health gate inside its rollback boundary.
- Connector ownership and setup progress need separate private receipts/journals; they do not
  belong in `PimpampumStore`.
- Existing npm update behavior remains available only for legacy npm installs. Native installs use
  versioned release artifacts.
- UI code consumes typed setup/connection envelopes and never detects executables, parses host
  configuration, or reads the token.

---

## Approach Analysis

### Option A: Private bundled Node runtime directory

**Description**: Ship a pinned Node binary, compiled `dist/`, pruned production dependencies, and
the target `better-sqlite3` prebuild as a signed/hashed runtime payload. Install it atomically
under a Pimpampum-owned version directory and keep a stable owned launcher for MCP hosts.

**Pros**:

- Reuses the current ESM application and CLI without bundler-specific rewrites.
- Loads `better-sqlite3` through its normal filesystem path.
- Fits the existing `nodePath`/`cliPath` service and receipt contracts.
- Can be built and tested per target before release.
- Makes rollback a service-path switch between complete version directories.

**Cons**:

- Larger artifact than a single executable.
- Requires pruning, nested code signing on macOS, and a target matrix.
- Runtime and app update transactions must be coordinated.

**Complexity**: Medium

### Option B: Node single-executable application (SEA)

**Description**: Bundle Pimpampum into one script, inject it into Node, and carry
`better-sqlite3` as an SEA asset extracted for `process.dlopen()`.

**Pros**:

- Small conceptual install surface and simple service command.
- No visible runtime directory.

**Cons**:

- Node documents SEA as active development.
- Requires a new bundling step for the current ESM/dependency graph.
- Native addons require explicit asset extraction and `process.dlopen()`; cross-target caveats
  and signing make rollback and verification harder.
- Moves risk into runtime boot before any user-facing value.

**Complexity**: High

### Option C: Reimplement the daemon natively

**Description**: Port the service/store/MCP stack to Swift and another Linux-native runtime.

**Pros**: Native executables per platform.

**Cons**: Duplicates domain invariants, creates two implementations, endangers data compatibility,
and violates the approved architecture.

**Complexity**: Very high

### Recommendation

Choose **Option A** for V1. It is the shortest path that removes the external Node/npm requirement
without changing the daemon implementation or inventing a native-addon loading scheme. Retain an
SEA spike as future evidence only; do not make it a release dependency.

For Omarchy distribution, use a plugin-pinned runtime manifest and exact release asset. The official
plugin installer clones and activates a Git repository but does not run install hooks, so the
enabled widget must invoke a bounded plugin-local bootstrap helper. That helper downloads only the
version/target named by the checked-in manifest, verifies its SHA-256, stages it privately, and
executes the bundled setup CLI. A separate AUR/package-manager dependency is rejected for V1
because it reintroduces a second user installation step.

---

## Architecture Decisions

### Runtime layout

```text
Signed/pinned distribution payload
            |
            v
RuntimeInstaller: verify -> stage -> smoke -> atomic rename
            |
            +-- macOS: ~/Library/Application Support/Pimpampum/Runtime/<version>/<target>
            |
            +-- Linux: ~/.local/share/pimpampum/runtime/<version>/<target>
            |
            +-- stable owned launchers outside the version directory
                    |
                    +-- pimpampum-control
                    +-- pimpampum-mcp
```

- The runtime manifest records schema version, Pimpampum version, Node version, target, file hashes,
  modes, entrypoints, and maximum supported unpacked size.
- No `current` symlink is used. Stable launchers are regular revisioned files that exec the
  receipt-selected version with an argument array.
- The service receipt continues to point directly at the selected version's Node and CLI paths.
- Keep the previous verified runtime until the new daemon and connector launchers pass health
  checks; garbage-collect only after commit.

### Connector transport and scope

- Use stdio for Codex and Claude Code. Host configuration contains only the absolute
  `pimpampum-mcp` launcher path; the bridge reads the private token file itself.
- Configure Codex at user/global scope through `codex mcp add/remove/get/list`; Codex CLI,
  desktop, and IDE share that configuration.
- Configure Claude Code with `--scope user` for cross-project availability.
- Prefer host CLI mutations. Read a bounded host configuration file only when the host CLI lacks a
  machine-readable inspection route; never log unrelated fields.
- Feature-probe CLI capabilities instead of assuming a version from a path or package manager.
- Preserve host-default tool approval unless a supported persistent CLI flag exists. For Codex,
  set write-aware approval only through an officially supported persistent option; never rewrite
  arbitrary TOML text merely to force it.

### Ownership classification

Each connector inspection returns exactly one of:

- `notInstalled`
- `unsupportedVersion`
- `notConnected`
- `ownedCurrent`
- `ownedStale`
- `equivalentUnowned`
- `conflict`
- `unavailable`

An entry is owned only when the private connection receipt and normalized host entry agree. Known
legacy forms such as `npx pimpampum mcp` are `ownedStale` only when the previous installation
receipt proves equivalence. Unknown entries are never removed or replaced by default.

### Durable setup transaction

- `setup-state.json` is a private atomic journal containing operation ID, requested connectors,
  current phase, redacted results, and rollback/resume metadata.
- `connection-receipt.json` records connector ID, scope, normalized owned command fingerprint,
  host version/capabilities, configured time, and last verification time. It contains no token.
- Runtime/service failure rolls back the runtime switch before any connector is changed.
- Connector failure preserves already verified connectors and returns partial success.
- App/QML closure never corrupts state; the next invocation resumes or safely reconciles the
  journal.

### UI boundary

- The bootstrap/runtime CLI is the single mutation surface before the daemon exists.
- macOS consumes typed JSON/NDJSON setup events through a bounded `Process` adapter.
- Omarchy calls one plugin-local bootstrap helper before installation and receipt-owned bounded
  helpers afterward.
- Neither native UI directly edits host configuration or owns daemon lifetime.

---

## Files to Create or Modify

| File                                                                    | Action   | Purpose                                                                     |
| ----------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `src/runtime/types.ts`                                                  | Create   | Runtime manifest, target, layout, and installation result types             |
| `src/runtime/manifest.ts`                                               | Create   | Strict manifest parsing, target selection, hash/mode validation             |
| `src/runtime/layout.ts`                                                 | Create   | Platform-specific private roots and stable launcher paths                   |
| `src/runtime/installer.ts`                                              | Create   | Stage, smoke-test, atomically activate, roll back, and prune runtimes       |
| `src/runtime/launchers.ts`                                              | Create   | Generate bounded stable control/MCP launcher files                          |
| `src/connectors/types.ts`                                               | Create   | Connector contract and shared status/outcome vocabulary                     |
| `src/connectors/process.ts`                                             | Create   | Bounded executable discovery, argument-array execution, timeouts            |
| `src/connectors/receipt.ts`                                             | Create   | Private connection receipt and ownership fingerprints                       |
| `src/connectors/verifier.ts`                                            | Create   | MCP initialize/list-tools verification through installed stdio route        |
| `src/connectors/codex.ts`                                               | Create   | Codex detection, plan, connect, repair, verify, disconnect                  |
| `src/connectors/claudeCode.ts`                                          | Create   | Claude Code user-scope connector                                            |
| `src/connectors/registry.ts`                                            | Create   | Connector registry with Codex and Claude Code                               |
| `src/setup/types.ts`                                                    | Create   | Setup plan, progress events, partial results, conflict decisions            |
| `src/setup/state.ts`                                                    | Create   | Private durable setup journal                                               |
| `src/setup/coordinator.ts`                                              | Create   | Runtime, service, connector, verification, resume, rollback orchestration   |
| `src/service/types.ts`                                                  | Modify   | Add post-activation verification and packaged-runtime metadata              |
| `src/service/manager.ts`                                                | Modify   | Run health verification inside rollback boundary                            |
| `src/service/macosApp.ts`                                               | Modify   | Install app without treating the large runtime payload as snapshots         |
| `src/service/omarchy.ts`                                                | Modify   | Generate new bounded helpers and packaged-runtime integration               |
| `src/cliCommands.ts`                                                    | Modify   | Describe setup/connection commands and remove npm-specific primary copy     |
| `src/cliProgram.ts`                                                     | Modify   | Route setup, connections, connect, repair, and disconnect commands          |
| `src/cliMain.ts`                                                        | Modify   | Compose runtime installer, coordinator, connector registry, update provider |
| `src/update.ts`                                                         | Refactor | Keep legacy npm provider and add packaged-release provider abstraction      |
| `scripts/build-runtime-bundle.mjs`                                      | Create   | Build deterministic target-specific private runtime payloads                |
| `scripts/check-runtime-bundle.mjs`                                      | Create   | Reject wrong target, extra files, missing addon, hash/mode drift            |
| `scripts/build-macos-app.sh`                                            | Modify   | Embed the reviewed macOS runtime payload                                    |
| `scripts/check-macos-artifact.mjs`                                      | Modify   | Validate nested runtime, addon, launchers, signatures, and manifest         |
| `scripts/package-release-assets.sh`                                     | Modify   | Produce app, Linux runtime/plugin assets, manifests, and checksums          |
| `.github/workflows/quality.yml`                                         | Modify   | Build/smoke runtime targets and run connector contract tests                |
| `.github/workflows/release.yml`                                         | Modify   | Build target matrix, sign nested macOS code, notarize, publish manifests    |
| `platforms/macos/Sources/PimpampumMenuBar/SetupModels.swift`            | Create   | Strict setup/connector envelope models                                      |
| `platforms/macos/Sources/PimpampumMenuBar/SetupCommandRunner.swift`     | Create   | Bounded streaming process adapter for embedded control runtime              |
| `platforms/macos/Sources/PimpampumMenuBar/SetupStore.swift`             | Create   | Guided onboarding state machine and resumption                              |
| `platforms/macos/Sources/PimpampumMenuBar/SetupOnboardingView.swift`    | Replace  | Implement the selected Guided flow                                          |
| `platforms/macos/Sources/PimpampumMenuBar/AgentSettingsView.swift`      | Create   | Ongoing connect/test/repair/disconnect UI                                   |
| `platforms/macos/Sources/PimpampumMenuBar/App.swift`                    | Modify   | Compose setup and agent stores                                              |
| `platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift`          | Modify   | Render durable setup/progress/partial/success states                        |
| `platforms/macos/Sources/PimpampumMenuBar/SyncSettings.swift`           | Modify   | Add Agents to the existing segmented Settings window                        |
| `platforms/macos/Sources/PimpampumMenuBar/UpdateSettingsStore.swift`    | Modify   | Consume packaged update provider and remove npm copy for native installs    |
| `integrations/omarchy/pimpampum-status/runtime-manifest.json`           | Create   | Pin exact Linux runtime asset and SHA per supported architecture            |
| `integrations/omarchy/pimpampum-status/pimpampum-bootstrap`             | Create   | Bounded download/verify/install entry before a receipt exists               |
| `integrations/omarchy/pimpampum-status/pimpampum-connections`           | Create   | Receipt-owned bounded connection helper                                     |
| `integrations/omarchy/pimpampum-status/AgentConnectionService.qml`      | Create   | Parse typed helper results and serialize actions                            |
| `integrations/omarchy/pimpampum-status/AgentsSettingsCard.qml`          | Create   | Agents card matching the shared status vocabulary                           |
| `integrations/omarchy/pimpampum-status/StatusPopout.qml`                | Modify   | Place Guided setup/Agents card in bounded settings UI                       |
| `integrations/omarchy/pimpampum-status/README.md`                       | Modify   | Document one plugin install and recovery without Node/npm                   |
| `test/runtime-*.test.ts`                                                | Create   | Manifest, installer, target, rollback, secret, and artifact tests           |
| `test/connectors-*.test.ts`                                             | Create   | Contract plus Codex/Claude fixture matrices                                 |
| `test/setup-*.acceptance.test.ts`                                       | Create   | End-to-end coordinator and migration fault-injection tests                  |
| `platforms/macos/Tests/PimpampumMenuBarTests/Setup*Tests.swift`         | Create   | Guided state, runner, copy, accessibility, and resumption tests             |
| `platforms/macos/Tests/PimpampumMenuBarTests/AgentSettings*Tests.swift` | Create   | Agent settings presentation/action tests                                    |
| `test/omarchy-plugin.test.ts`                                           | Modify   | Bootstrap/helper/QML states and safety                                      |
| `scripts/test-macos-live.mjs`                                           | Modify   | Clean no-Node setup, migration, partial success, restart, removal           |
| `scripts/test-omarchy-live.mjs`                                         | Modify   | Plugin bootstrap and target-machine connection smoke                        |
| `README.md`, `docs/agents.md`, `docs/mcp-tools.md`                      | Modify   | User install, session restart, advanced/manual connection guidance          |

Generated spec-test files are added to this table as **Make pass** after `/generate-tests`; they
must not be edited during implementation.

---

## Implementation Phases

### Phase 0 — Freeze tests and retire unknowns

#### Task 0.1: Generate Tests-as-DoD from the approved PRD

**Files**: `thoughts/tests/2026-08-31_zero-friction-local-agent-setup.md` and generated test shells

**Status**: Complete on 2026-08-31

- The frozen manifest maps all 104 enumerated PRD items to 59 generated cases.
- Seven generated files carry immutable headers and recorded SHA-256 hashes.
- `/execute-plan` must verify those hashes rather than regenerate or modify the contracts.

#### Task 0.2: Prove the private runtime payload

**Files**: temporary spike under `tmp/` or a throwaway branch; no production integration

- Build `darwin-arm64`, `linux-x64`, and `linux-arm64` candidate payloads using pinned Node 24,
  compiled `dist`, pruned production dependencies, and only the matching
  `better-sqlite3` prebuild.
- Smoke `version`, `serve`, database open/migration, HTTP health, stdio initialization, and tool
  listing on native targets.
- Measure compressed/unpacked size and cold startup.
- Attempt an SEA only long enough to document native-addon/signing cost; do not continue if it
  requires addon extraction or loader changes.

#### Task 0.3: Freeze host connector fixtures

**Files**: redacted Codex/Claude fixture directories and compatibility notes

- Capture machine-readable Codex `mcp get/list --json` shapes.
- Capture bounded Claude Code CLI outputs and the minimum target entry from a synthetic
  `~/.claude.json`; do not copy the developer's real configuration.
- Cover missing host, unsupported flags, absent entry, exact owned entry, legacy npm entry,
  unknown conflict, read-only config, concurrent revision, and host CLI failure.
- Confirm `--scope user` behavior for Claude Code and global/user behavior for Codex.

#### Task 0.4: Prove the Omarchy delivery channel

**Files**: throwaway plugin/runtime release asset

- Validate the current official plugin contract: clone, validate, enable, update, and remove.
- Prove that a plugin-local bounded helper can download an exact-tag runtime asset, verify the
  manifest hash, reject path traversal/oversize/wrong architecture, and install without root.
- If the target Omarchy environment cannot reach release assets, stop and choose a documented
  `pimpampum-bin` package dependency before product implementation.

**Gate 0**:

- Generated spec tests fail for missing behavior and remain unmodified.
- All target payloads open SQLite and complete MCP initialization.
- Runtime size/startup measurements are recorded.
- Codex/Claude and Omarchy fixture contracts are checked in or linked from the plan.

### Phase 1 — Build the packaged runtime foundation

#### Task 1.1: Define runtime manifest and layout

**Depends on**: Tasks 0.1, 0.2

- Implement strict target and manifest schemas.
- Reject absolute/archive-traversal paths, duplicate paths, symlinks, devices, unexpected files,
  invalid modes, wrong versions/targets, oversized payloads, and hash drift.
- Keep data, runtime, logs, app, and plugin roots separate.

#### Task 1.2: Build deterministic target bundles

**Depends on**: Task 1.1

- Build from `package-lock.json` and a pinned official Node release/checksum.
- Include only production runtime files and the matching native addon.
- Emit manifest plus archive SHA-256 and an SBOM/file inventory.
- Ensure the payload works with an empty external `PATH` and no system Node/npm.

#### Task 1.3: Implement atomic runtime installation

**Depends on**: Task 1.2

- Copy/extract into a private same-filesystem staging directory.
- Validate every file before activation, smoke the staged Node/CLI/addon, then atomically rename.
- Generate stable regular-file launchers with absolute owned paths and argument arrays.
- Preserve the last verified version until commit; clean only receipt-owned stale versions.
- Make interrupted staging and repeated installation self-healing.

#### Task 1.4: Put daemon health inside service rollback

**Depends on**: Task 1.3

- Extend the service manager with a post-activation verifier invoked after registration and before
  the transaction returns.
- Verify receipt identity, expected version, loopback health, and one-daemon ownership.
- On failure, restore service artifacts/receipt/log state and reactivate the prior verified runtime.
- Avoid snapshotting the runtime payload in memory; the runtime installer owns version-directory
  rollback.

#### Task 1.5: Integrate runtime artifacts into release packaging

**Depends on**: Tasks 1.2, 1.4

- Embed the macOS payload in app Resources.
- Produce Linux target assets and plugin-pinned manifests.
- Sign nested Node and `.node` binaries before signing the outer app; notarize and staple the
  complete bundle.
- Make artifact checkers reject unsigned, unmanifested, wrong-target, or stale nested code.

**Gate 1**:

- Clean target machines with Node/npm removed can run version, daemon health, SQLite, and MCP smoke.
- A forced post-activation health failure restores the previous daemon and receipt.
- macOS signature verification covers every nested executable and addon.
- Runtime assets are reproducible from the tagged source/lockfile.

### Phase 2 — Implement connector core and headless UX

#### Task 2.1: Define connector, receipt, and status contracts

**Depends on**: Tasks 0.1, 0.3

- Implement the shared detect/inspect/plan/connect/verify/repair/disconnect/snapshot/restore
  interface.
- Keep connector states domain-neutral and UI-ready.
- Store only redacted fingerprints and verification metadata.

#### Task 2.2: Add bounded host-process and config primitives

**Depends on**: Task 2.1

- Search only bounded official/user executable locations plus a sanitized `PATH`.
- Run absolute executables with argument arrays, output limits, timeouts, and process-group cleanup.
- Read only bounded regular config files with symlink protection and revision hashes.
- Never pass tokens, arbitrary shell source, or untrusted paths as commands.

#### Task 2.3: Verify the installed MCP route

**Depends on**: Tasks 1.3, 2.1

- Spawn the stable `pimpampum-mcp` launcher with the MCP client stdio transport.
- Require expected server identity/protocol, initialization, and bounded required tool catalog.
- Enforce startup/catalog timeouts and terminate the complete process group on every exit path.
- Scan stdout/stderr/result diagnostics for token leakage before recording redacted status.

#### Task 2.4: Implement Codex connector

**Depends on**: Tasks 2.2, 2.3

- Detect Codex and feature-probe JSON get/list plus add/remove.
- Use the global user configuration shared by Codex CLI, desktop, and IDE.
- Add `pimpampum` through the official CLI with the stable stdio launcher.
- Classify exact, legacy, equivalent, and conflicting entries; never replace conflict implicitly.
- Report that already-running clients/extensions need restart/new session where applicable.

#### Task 2.5: Implement Claude Code connector

**Depends on**: Tasks 2.2, 2.3

- Detect Claude Code and feature-probe `mcp add-json/add/remove`.
- Use `--scope user` and stdio.
- Inspect only the target entry from bounded synthetic/user JSON when CLI output cannot be parsed
  safely; perform mutations through the official CLI.
- Preserve scope precedence and report higher-precedence collisions as conflicts.

#### Task 2.6: Implement durable setup coordinator

**Depends on**: Tasks 1.4, 2.4, 2.5

- Plan without mutation, persist one reviewed operation, serialize through the lifecycle lock, then
  install runtime/service before connectors.
- Emit typed progress events and persist every phase transition atomically.
- Resume/reconcile interrupted operations.
- Keep verified connectors on partial connector failure; roll back runtime/service failures.
- Require a separate replacement decision for unknown conflicts.

#### Task 2.7: Expose JSON-first CLI commands

**Depends on**: Task 2.6

- Add `setup plan/apply/status/resume`, `connections`, `connect <id>`,
  `repair <id>`, and `disconnect <id>`.
- Keep non-interactive decisions explicit through flags/input JSON and existing typed error
  envelopes.
- Keep `mcp` protocol stdout isolated from CLI envelopes.
- Update command catalog annotations and advanced manual instructions with secrets redacted.

**Gate 2**:

- Codex and Claude Code fixture matrices pass without editing unrelated configuration.
- Repeated setup/connect/repair/disconnect is idempotent.
- Unknown conflicts cause zero mutation before a second explicit decision.
- Stdio verification leaves no child process and no secret in args/config/output.
- CLI setup completes on a clean no-Node machine.

### Phase 3 — Ship the macOS Guided experience

#### Task 3.1: Make the app a self-contained bootstrap source

**Depends on**: Tasks 1.5, 2.7

- Resolve the embedded control runtime from `Bundle.main`, never from `PATH`.
- On first run, invoke setup from the downloaded app while installing stable runtime/app paths into
  the user's owned locations.
- Relaunch/focus the installed app when the source app path is transient.

#### Task 3.2: Add strict Swift setup client and store

**Depends on**: Task 3.1

- Decode bounded schema-versioned plan/progress/result events.
- Model service and per-agent states separately.
- Serialize user actions, cancel safely before mutation, and resume durable operations.
- Sanitize arbitrary child output into actionable errors.

#### Task 3.3: Replace npm onboarding with the selected Guided flow

**Depends on**: Task 3.2

- Step 1: private service explanation, no mutation.
- Step 2: detected supported agents selected by default, exact change summary, Back, and one
  **Review & set up** confirmation.
- Step 3: stable progress surface, per-phase completion, close/reopen continuity.
- Preserve 360-point popover, Quiet hierarchy, 44-point controls, keyboard/VoiceOver, reduced
  motion, light/dark mode, and long-content behavior.

#### Task 3.4: Implement completion, partial failure, conflict, and recovery

**Depends on**: Tasks 2.6, 3.3

- Show service and each selected connector independently.
- Distinguish configured from available in the current session.
- Offer retry for failed connectors and continue with verified connectors.
- Show redacted Keep existing/Replace/Cancel conflict comparison only when required.
- Preserve Login Items recovery and offer safe agent-open/new-session actions.

#### Task 3.5: Add Agents settings

**Depends on**: Tasks 2.7, 3.2

- Add Agents to `DesktopSettingsSection`.
- Expose only valid Connect/Test/Repair/Open/Disconnect actions per state.
- Put paths, transport, last verification, and manual instructions behind Advanced disclosure.
- Disconnect only the selected connector; never stop the daemon or delete data.

**Gate 3**:

- A clean macOS acceptance run reaches a verified connector in under two minutes with one
  Pimpampum confirmation and zero Terminal interactions.
- Closing/reopening the popover during setup resumes the same operation.
- Swift tests cover every Guided state, keyboard action, accessibility label, and long error.
- Existing Overview, Sync, Backup, Updates, Login Items, and workspace behavior remains green.

### Phase 4 — Ship the Omarchy setup and Agents card

#### Task 4.1: Bootstrap the pinned runtime from the plugin

**Depends on**: Tasks 0.4, 1.5, 2.7

- Detect architecture, select only the checked-in exact asset, download with bounded size/time, and
  verify SHA before extraction.
- Use private temp/staging paths, reject unsafe archives, and require no root or external Node/npm.
- Execute the staged control CLI and transition to receipt-owned helpers after commit.

#### Task 4.2: Add bounded connection service/helper

**Depends on**: Task 4.1

- Accept only list/plan/connect/test/repair/disconnect/resume and known connector IDs.
- Return typed JSON; cap stdout/stderr; serialize operations; expose no token or arbitrary command.
- Keep QML out of host config and runtime paths.

#### Task 4.3: Add Guided/Agents UI to the bounded popout

**Depends on**: Task 4.2

- Use the shared status vocabulary and copy while staying native to Quattro.
- Show first-run explanation, detected selection, one confirmation, busy/progress, partial failure,
  conflict, and completion.
- Add an Agents card to Settings with keyboard/focus/accessibility and bounded scrolling.

#### Task 4.4: Reconcile plugin update and removal

**Depends on**: Tasks 2.6, 4.1

- On plugin fast-forward, compare the pinned runtime manifest and reconcile only when version/target
  changes.
- Keep the previous runtime and connector route until verification succeeds.
- Removal disconnects proven-owned entries and runtime/service/plugin artifacts while preserving
  data, backups, exports, and sync snapshots.

**Gate 4**:

- `omarchy plugin add … --enable` followed by the in-widget Guided flow succeeds on a machine
  without Node/npm.
- Wrong-arch, wrong-hash, offline, interrupted download, and read-only target states are
  actionable and non-destructive.
- `npm run validate:omarchy` and focused plugin tests pass.
- Quickshell restart does not affect the daemon or completed connectors.

### Phase 5 — Migration, updates, removal, and security hardening

#### Task 5.1: Migrate existing npm installations transactionally

**Depends on**: Tasks 2.6, 3.1, 4.1

- Detect existing receipt/adapter/runtime and preserve the canonical data directory/token/database.
- Stage the packaged runtime, switch the existing service under the lifecycle lock, health-check,
  then reconcile recognized connector entries.
- Restore the npm runtime/service/connector route on any pre-commit failure.
- Never start two daemons against one data directory.

#### Task 5.2: Replace native npm updates with packaged release updates

**Depends on**: Tasks 1.5, 3.1, 4.1

- Refactor `UpdateManager` into legacy npm and packaged-release providers selected from receipt
  metadata.
- Fetch only a bounded release manifest/channel, verify version/target/hash/signature, stage the
  full app/runtime/plugin candidate, and reuse the coordinator transaction.
- Keep npm commands only for legacy npm installations and developer distribution.

#### Task 5.3: Make removal connector-aware and reversible

**Depends on**: Tasks 2.6, 5.1, 5.2

- Snapshot proven-owned connector entries before removal.
- Disconnect through host CLIs, remove service/runtime/app/plugin artifacts, preserve all user data,
  then commit receipts.
- If ownership cannot be proven, leave the entry and return manual redacted instructions.
- Roll back completed owned removals if a later mandatory removal step fails.

#### Task 5.4: Run hostile-state and concurrency hardening

**Depends on**: Tasks 3.4, 3.5, 4.3, 5.3

- Fault-inject every runtime/service/connector/update/removal phase.
- Test symlinks, FIFOs/devices, oversized files/output, malformed JSON/TOML, concurrent host edits,
  stale locks, dead lock owners, occupied port, killed processes, app/logout/power interruption,
  and config permission changes.
- Assert no token in UI, clipboard, argv, host config, receipts, logs, diagnostics, or test
  snapshots.

**Gate 5**:

- Migration and update faults preserve the prior working daemon and data byte-for-byte.
- Removal preserves data and never removes an unowned host entry.
- Concurrent setup attempts serialize; concurrent host config changes stop safely.
- Security/secret-leak suite passes across macOS and Linux fixtures.

### Phase 6 — Release evidence and documentation

#### Task 6.1: Expand macOS artifact and live gates

**Depends on**: Task 5.4

- Build, sign nested code, sign app, notarize, staple, and approve from the same commit.
- Run clean setup, existing npm migration, no-agent, one-agent, two-agent, partial failure, conflict,
  restart, update, disconnect, and removal live cases.
- Record duration, versions, architecture, artifact hashes, and observed session-restart behavior.

#### Task 6.2: Expand Omarchy validation and opt-in live evidence

**Depends on**: Task 5.4

- Validate plugin/runtime manifest and helpers cross-platform in CI.
- Run target-machine no-Node bootstrap, Codex/Claude connection, Quickshell restart, update, and
  removal smoke.
- Preserve the existing policy that Quattro visual evidence is opt-in unless deliberately changed.

#### Task 6.3: Rewrite user and agent documentation

**Depends on**: Tasks 6.1, 6.2

- Lead with download/plugin install and Guided setup.
- Remove npm/Terminal/MCP jargon from the normal user path.
- Document new-session behavior, Agents settings, conflicts, repair, removal, and advanced CLI.
- Keep `docs/agents.md` focused on using Pimpampum after connection.

**Gate 6**:

- Release assets and evidence bind to the same tagged commit and hashes.
- All user docs match shipped labels and commands.
- A clean observed run meets the under-two-minute target.

---

## Task Dependencies

```yaml
dependencies:
  0.1: []
  0.2: []
  0.3: []
  0.4: []
  1.1: [0.1, 0.2]
  1.2: [1.1]
  1.3: [1.2]
  1.4: [1.3]
  1.5: [1.2, 1.4]
  2.1: [0.1, 0.3]
  2.2: [2.1]
  2.3: [1.3, 2.1]
  2.4: [2.2, 2.3]
  2.5: [2.2, 2.3]
  2.6: [1.4, 2.4, 2.5]
  2.7: [2.6]
  3.1: [1.5, 2.7]
  3.2: [3.1]
  3.3: [3.2]
  3.4: [2.6, 3.3]
  3.5: [2.7, 3.2]
  4.1: [0.4, 1.5, 2.7]
  4.2: [4.1]
  4.3: [4.2]
  4.4: [2.6, 4.1]
  5.1: [2.6, 3.1, 4.1]
  5.2: [1.5, 3.1, 4.1]
  5.3: [2.6, 5.1, 5.2]
  5.4: [3.4, 3.5, 4.3, 5.3]
  6.1: [5.4]
  6.2: [5.4]
  6.3: [6.1, 6.2]
```

Parallel execution opportunities:

- Phase 0 spikes 0.2–0.4 can run independently after test generation starts.
- Codex and Claude connector tasks 2.4/2.5 can run in parallel.
- macOS settings 3.5 can run alongside Guided presentation 3.3 after the shared store exists.
- macOS and Omarchy release gates 6.1/6.2 can run in parallel on their native targets.

---

## Risk Analysis

### Technical risks

| Risk                                                    | Severity | Mitigation / stop condition                                                                                         |
| ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| Private runtime is too large                            | Medium   | Record Gate 0 size; prune target-only deps/addon; do not switch to SEA without a separate approved plan             |
| Nested macOS runtime fails signing/notarization         | High     | Sign addon and Node before outer app in Phase 1; block UI work if Gate 1 fails                                      |
| Runtime path switch leaves daemon unhealthy             | High     | Post-activation health verifier inside service rollback; retain prior version                                       |
| Claude config inspection is unstable                    | High     | Prefer CLI; bound/read only target JSON entry; fixture current versions; fail closed                                |
| Host CLI changes syntax/output                          | High     | Feature probing, isolated connectors, versioned fixtures, unsupported state                                         |
| Omarchy plugin cannot securely deliver runtime          | High     | Gate 0.4 before implementation; fallback to one documented package if release assets are impossible                 |
| Existing app adapter snapshots a large payload          | High     | Runtime installer owns version directories; app adapter must not represent runtime bytes as service artifacts       |
| Connector verification passes but host session is stale | Medium   | Separate configured/verified/new-session-required states and host-specific open/restart guidance                    |
| Update overwrites a running app                         | High     | Stage complete candidate, detached handoff/relaunch, coordinator transaction, prior app retained until verification |
| Config changes concurrently                             | High     | Revision hashes before/after host CLI calls; stop rather than restore stale whole-file snapshots                    |

### Edge cases

- No supported host: install and verify runtime, finish successfully, show Agents settings.
- One host or deselected host: result and completion list only requested connectors.
- Both checkboxes cleared: disable the mutating confirmation.
- Running Codex/Claude session: configure and verify route, report new session/restart required.
- Unknown `pimpampum` entry at another scope: show conflict and do not mutate.
- Host executable disappears between plan/apply: fail that connector, preserve runtime and others.
- Port 7337 belongs to an unknown process: stop before connector mutation; never kill it.
- Existing data directory/receipt/token: reuse and preserve permissions.
- Power loss during staging, service switch, or connector mutation: resume from journal or restore
  last verified phase.
- Plugin/app updated while setup runs: lifecycle lock and operation version prevent mixed assets.
- Runtime archive decompression bomb/path traversal/symlink: reject before final extraction.

---

## Testing Strategy

### Unit and contract tests

- Runtime manifest/layout/archive validation, launcher rendering, atomic activation, pruning, and
  rollback.
- Service-manager post-activation verification and legacy-receipt compatibility.
- Connector contract matrix with fake executables and isolated synthetic homes.
- Codex JSON and Claude scope/config fixtures; no tests read the developer's real home config.
- MCP verifier timeouts, wrong identity, missing tools, malformed protocol, stderr noise, and child
  cleanup.
- Setup journal transitions, resumption, partial success, conflicts, and rollback.
- Swift models/store/presentation and QML/helper static contracts.

### Integration tests

- Real private runtime opens SQLite and serves HTTP/MCP on every target.
- Synthetic host CLIs mutate isolated configuration and prove unrelated content is unchanged.
- Existing npm receipt migrates to packaged paths and rolls back under fault injection.
- Packaged update switches version and keeps healthy connectors.
- Removal preserves data and restores owned state on late failure.

### Live/manual verification

- Signed macOS clean machine with no Node/npm: Guided setup for Codex and Claude Code.
- macOS Login Items approval denied/allowed, popover closed/reopened, host already running.
- Omarchy target with no Node/npm: plugin add/enable, bootstrap, Quickshell restart, update/remove.
- VoiceOver/keyboard/reduced motion/light/dark/long localization on macOS.
- Keyboard/focus/scroll/theme states on Quattro.

---

## Done Criteria

### Phase 0

- [x] Spec test manifest exists and generated tests fail for known missing behavior.
- [x] Generated test hashes are recorded and unchanged thereafter.
- [x] Runtime/SEA/Omarchy/host spike evidence is attached to the plan or a linked note.

### Runtime and service

- [x] Target bundles pass `node scripts/check-runtime-bundle.mjs <bundle>`.
- [x] A clean no-Node target passes version, SQLite, HTTP health, MCP initialize, and list-tools
      smoke.
- [x] Forced daemon-health failure restores prior receipt, service definition, runtime, and logs.
- [x] macOS nested code passes `codesign --verify --deep --strict` and notarization validation.

### Connectors and coordinator

- [x] Codex and Claude connector fixture matrices pass.
- [x] Clean connect, repeat, stale repair, disconnect, partial failure, and conflict tests pass.
- [x] No host config, argv, receipt, log, UI string, or clipboard fixture contains the test token.
- [x] MCP verifier leaves zero child processes after success, timeout, malformed output, or cancel.

### macOS and Omarchy

- [x] Guided clean setup takes less than two minutes, one Pimpampum confirmation, zero Terminal
      actions.
- [x] Mac popover resume, partial failure, conflict, completion, and Agents settings are covered by
      Swift tests and live smoke.
- [x] Omarchy plugin bootstrap works without Node/npm and `npm run validate:omarchy` passes.
- [x] Closing the app or restarting Quickshell leaves the daemon and verified connectors available.

### Spec tests

- [x] All generated spec tests pass with their documented npm/Swift/Omarchy commands.
- [x] No generated spec test file was modified after creation.

### Overall

- [x] `npm run typecheck && npm run lint && npm run format:check && npm test` passes.
- [x] `npm run test:macos` passes with required Swift coverage.
- [x] `npm run test:omarchy` and `npm run check:desktop-contract` pass.
- [x] macOS and Omarchy live gates pass according to their release policies.
- [x] `npm audit --omit=dev` has no unresolved production vulnerability.
- [x] No new TODO/FIXME/HACK remains.
- [x] No domain rule moved out of `PimpampumStore`; UI/QML contains no connector mutation logic.
- [x] `/post-review` approves architecture, security, requirements, and release evidence.

---

## Verification Order

1. Run generated spec tests and confirm failures before implementation.
2. After every change:
   `npm run typecheck && npm run lint && npm run format:check && npm test`.
3. At each platform gate, run `npm run test:macos` or `npm run test:omarchy`.
4. Run runtime artifact checks for every target and secret-leak scans.
5. Run clean/migration/fault-injection live tests.
6. Run `/summary`, then `/post-review`.

---

## Primary References Verified During Planning

- [Codex MCP documentation](https://developers.openai.com/codex/mcp/): shared Codex
  configuration, stdio/HTTP support, JSON-capable CLI management, restart guidance, and
  write-aware approval settings.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp): stdio, user scope, scope
  precedence, official add/remove commands, and connection health behavior.
- [Node.js single executable applications](https://nodejs.org/download/release/latest-v22.x/docs/api/single-executable-applications.html):
  SEA stability and native-addon asset/`process.dlopen` requirements.
- [better-sqlite3 repository](https://github.com/WiseLibs/better-sqlite3): target prebuilds and
  Node-API packaging used by version 13.
- [Omarchy shell plugin documentation](https://github.com/basecamp/omarchy/blob/quattro/docs/omarchy-shell.md):
  git-cloned plugin lifecycle and manifest contract.
- [Omarchy shell README](https://github.com/basecamp/omarchy/blob/quattro/shell/README.md): plugin
  installation/update behavior and the fact that plugin hooks are not executed.

---

## Approval

Approval authorizes implementation planning to proceed to `/generate-tests` and then
`/execute-plan`. It does not authorize changing the chosen runtime strategy to SEA, adding an
external package prerequisite to the default Omarchy path, or overwriting unknown host
configuration without a new explicit decision.
