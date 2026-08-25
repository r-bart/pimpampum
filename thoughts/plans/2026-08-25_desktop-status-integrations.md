# Implementation Plan: Automatic Service and Desktop Status Integrations

**Date**: 2026-08-25  
**Status**: In progress  
**Source specification**: [../specs/2026-08-25_desktop-status-integrations.md](../specs/2026-08-25_desktop-status-integrations.md)

---

## Overview

Add a bounded project overview contract, safe per-user service installation, a native unsigned macOS menu bar application, and a native Omarchy Quattro bar widget. All visible status is read-only and derived from canonical project state plus unexpired claims; no `doing` state or database migration is introduced.

---

## Preflight Findings

- Package manager: npm, from `package-lock.json`.
- Runtime: Node.js 22+ TypeScript daemon with SQLite, HTTP, MCP, and an injected CLI runtime.
- Domain invariants are centralized in `PimpampumStore`; integrations must not duplicate claimability rules.
- Current runtime coverage gate: 100% statements, branches, functions, and lines.
- macOS host available for implementation: macOS 26.5.2 on arm64.
- Apple toolchain available: Swift 6.3.3 and Xcode 26.6.
- No `systemctl` or `omarchy` executable is available on the current Mac.
- Omarchy Quattro must therefore receive contract tests locally plus a real smoke test on the user's Quattro machine.
- The feature contract is frozen in `thoughts/tests/2026-08-26_desktop-status-integrations.md` with SHA-256 checks for every immutable acceptance file and shared fixture.
- The current Mac freezes the official Quattro contract statically; exact target-machine build evidence remains a mandatory Task 4.4 and Phase 5 gate.

---

## Requirements

- [x] Add an authenticated `GET /api/v1/overview` endpoint and `pimpampum overview`.
- [x] Derive active work exclusively from unexpired claims.
- [x] Return bounded project, count, and active-work summaries without Markdown bodies.
- [x] Add idempotent `install`, `status`, and `uninstall` commands.
- [x] Install a per-user LaunchAgent on macOS and a per-user systemd service on Linux.
- [ ] Install an unsigned SwiftUI menu bar app into `~/Applications`.
- [ ] Install a native Omarchy Quattro `bar-widget` without overwriting user shell configuration.
- [ ] Show active-claim count in compact indicators.
- [ ] Collapse completed projects by default in both detailed views.
- [ ] Reveal the registered workspace root in Finder or the Linux file explorer.
- [ ] Keep both status surfaces strictly read-only.
- [x] Preserve `~/.pimpampum` during uninstall.
- [ ] Maintain the existing TypeScript coverage and compiled E2E gates.

---

## Approach Analysis

### Option A: Shared daemon contract with native platform adapters

**Description**: Add one overview endpoint to the existing daemon. Keep lifecycle installation in the TypeScript CLI, implement macOS UI in SwiftUI, and implement Omarchy UI as a Quickshell plugin. Both UIs consume the same semantic status contract.

**Pros**:

- Native platform behavior and appearance.
- One canonical status calculation.
- No browser runtime or desktop framework.
- Omarchy integration uses its supported plugin model.
- Platform code remains isolated from domain logic.

**Cons**:

- Three implementation languages: TypeScript, Swift, and QML.
- Separate test strategies are required.
- Quattro needs validation on a real Linux machine.

**Complexity**: Medium to high.

### Option B: One cross-platform tray application

**Description**: Build a Tauri or Electron tray application that manages the daemon and serves both macOS and Linux desktop status.

**Pros**:

- More shared UI code.
- One desktop packaging pipeline.
- Easier path to a future settings window.

**Cons**:

- Adds a webview or bundled browser runtime.
- Does not integrate naturally with Omarchy's native bar/plugin model.
- Introduces a large dependency and security surface for a tiny read-only UI.
- Conflicts with Pimpampum's zero-bloat principle.

**Complexity**: High.

### Option C: Script-only indicators

**Description**: Use a shell command plus SwiftBar on macOS and a command widget on Omarchy.

**Pros**:

- Smallest initial code change.
- Fast to prototype.
- Little native build work.

**Cons**:

- Requires third-party software on macOS.
- Limited interaction and stale-state handling.
- Inconsistent visual behavior.
- Weak packaging and startup experience.

**Complexity**: Low initially, medium once hardened.

### Recommendation

Use **Option A**. It keeps the daemon and its overview contract authoritative while using the smallest native surface on each platform. The extra language boundaries are justified because neither Electron nor script-only integrations meet the product's native, low-bloat, reliable-startup requirements.

---

## Architecture Decisions

### 1. Server-derived semantic status

The overview response contains explicit semantic status values so Swift and QML do not independently recreate business rules:

```typescript
export type OverviewStatus = 'active' | 'available' | 'complete' | 'draft' | 'empty';

export interface OverviewProject {
  id: string;
  workspace: Pick<Workspace, 'id' | 'name' | 'rootPath'>;
  slug: string;
  title: string;
  lifecycleState: ProjectState;
  status: Exclude<OverviewStatus, 'empty'>;
  openTaskCount: number;
  completedTaskCount: number;
  activeClaimCount: number;
  availableWorkCount: number;
  updatedAt: string;
}
```

The clients add only the transport-level `offline` and `incompatible` states.

### 2. No database migration

`PimpampumStore.getOverview()` uses a single read transaction and one captured timestamp. It aggregates existing workspaces, projects, tasks, and unexpired claims without reading Markdown or completion bodies. Claimable counts must be compared against `listWork` in tests to prevent semantic drift.

### 3. Bounded overview

- Count fields cover the complete database.
- Project summaries are capped at 500 and report `projectsTruncated`.
- Active-work summaries are capped at 500 and report `activeWorkTruncated`.
- Stable ordering uses status precedence, `updatedAt`, and resource ID.
- Duplicate project titles include workspace name and slug for disambiguation.

### 4. Runtime metadata at the HTTP composition boundary

The store returns domain overview data. `createHttpApp` captures its startup time and adds daemon version, generated timestamp, and uptime. This avoids teaching the domain store about process lifecycle.

### 5. Injected service management

CLI orchestration depends on a `ServiceManager` interface rather than calling `launchctl` or `systemctl` directly. Production adapters receive injected filesystem/process/platform dependencies, allowing destructive system operations to be tested against temporary directories and fake command runners.

### 6. Installation receipt

An installation receipt contains no secret and records:

- Schema version.
- Platform adapter.
- Canonical Node executable and compiled CLI paths.
- Effective base URL and data directory.
- Generated service and integration paths.
- Installed Pimpampum version.

The receipt allows status, reinstall reconciliation, UI discovery, and precise uninstall without guessing targets. The bearer token remains only in the configured Pimpampum data directory.

### 7. Two macOS processes

- A per-user LaunchAgent owns the Node daemon independently of the UI.
- A menu-bar-only SwiftUI app displays status.
- The app uses `SMAppService.mainApp` to register itself at login after explicit installation.
- `pimpampum install` holds the exclusive installation lock, removes any previous acknowledgement, atomically writes a mode-`0600` request containing a random UUID plus `requestedAt`/`expiresAt` (30 seconds), then launches the copied app once with `--register-login-item <request-id>`.
- The app accepts only that request ID before expiry, performs `SMAppService.mainApp.register()`, and atomically writes a mode-`0600` acknowledgement with the same ID, timestamp, and `enabled`, `requiresApproval`, or `error` status. It never writes a token.
- The CLI waits at most ten seconds and rejects mismatched, pre-request, or expired acknowledgements. Repeat installs create a fresh request ID; `status` reports only the latest validated acknowledgement and installed-artifact probes.
- Closing or removing the menu item does not own or stop the daemon.

### 8. Native Omarchy plugin

The plugin id is `dev.pimpampum.status`, declares `kinds: ["bar-widget"]`, and ships inside `integrations/omarchy/pimpampum-status`. Installation stages a real copy with no symlinks, validates it with `omarchy plugin validate`, rescans, and enables it through official Omarchy commands. It never edits `shell.json` directly.

### 9. Read-only UI boundary

The Swift and QML surfaces can refresh, expand groups, and reveal validated workspace paths. No mutating API method or service-control action is exposed from either UI.

---

## Files to Create or Modify

### Shared TypeScript Core

| File                      | Action | Purpose                                                              |
| ------------------------- | ------ | -------------------------------------------------------------------- |
| `src/types.ts`            | Modify | Add overview domain/transport types                                  |
| `src/overview.ts`         | Create | Pure status precedence, ordering, and bounded-response helpers       |
| `src/store.ts`            | Modify | Add atomic overview aggregation over existing tables                 |
| `src/http.ts`             | Modify | Add authenticated overview route and runtime metadata                |
| `src/openapi.ts`          | Modify | Document overview schemas and operation                              |
| `src/client.ts`           | Modify | Add typed overview client method                                     |
| `src/cliProgram.ts`       | Modify | Add overview and lifecycle commands through injected service manager |
| `src/cli.ts`              | Modify | Compose the real platform service manager                            |
| `src/service/types.ts`    | Create | Service state, receipt, command-runner, and adapter contracts        |
| `src/service/manager.ts`  | Create | Install/status/uninstall orchestration and rollback                  |
| `src/service/receipt.ts`  | Create | Private receipt parsing, validation, and atomic persistence          |
| `src/service/launchd.ts`  | Create | LaunchAgent rendering and launchctl adapter                          |
| `src/service/systemd.ts`  | Create | User-unit rendering and systemctl adapter                            |
| `src/service/platform.ts` | Create | Safe filesystem, process, and platform composition                   |
| `src/service/logs.ts`     | Create | Bounded service log rotation                                         |
| `package.json`            | Modify | Add platform builds/tests and ship integration artifacts             |
| `package-lock.json`       | Modify | Keep package metadata synchronized                                   |

### macOS

| File                                                              | Action | Purpose                                               |
| ----------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| `platforms/macos/Package.swift`                                   | Create | Swift package for executable and unit tests           |
| `platforms/macos/Sources/PimpampumMenuBar/App.swift`              | Create | MenuBarExtra application entry point                  |
| `platforms/macos/Sources/PimpampumMenuBar/Models.swift`           | Create | Codable overview contract and display status          |
| `platforms/macos/Sources/PimpampumMenuBar/OverviewClient.swift`   | Create | Authenticated loopback client and response validation |
| `platforms/macos/Sources/PimpampumMenuBar/OverviewStore.swift`    | Create | Polling, stale state, grouping, and sorting           |
| `platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift`    | Create | Read-only summary, active work, and project UI        |
| `platforms/macos/Sources/PimpampumMenuBar/WorkspaceOpener.swift`  | Create | Safe Finder reveal through `NSWorkspace`              |
| `platforms/macos/Sources/PimpampumMenuBar/LoginItemManager.swift` | Create | SMAppService registration and status                  |
| `platforms/macos/Resources/Info.plist`                            | Create | LSUIElement app-bundle metadata                       |
| `platforms/macos/Tests/PimpampumMenuBarTests/*.swift`             | Create | Contract, ordering, polling, stale, and opener tests  |
| `scripts/build-macos-app.sh`                                      | Create | Build and assemble unsigned `.app` bundle             |

### Omarchy Quattro

| File                                                        | Action | Purpose                                                     |
| ----------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `integrations/omarchy/pimpampum-status/manifest.json`       | Create | Third-party bar-widget contract                             |
| `integrations/omarchy/pimpampum-status/BarWidget.qml`       | Create | Compact semantic indicator and active count                 |
| `integrations/omarchy/pimpampum-status/OverviewService.qml` | Create | Bounded polling and JSON validation                         |
| `integrations/omarchy/pimpampum-status/StatusPopout.qml`    | Create | Projects, active work, and collapsed completed group        |
| `integrations/omarchy/pimpampum-status/README.md`           | Create | Quattro compatibility and manual validation                 |
| `integrations/omarchy/pimpampum-status/fixtures/*.json`     | Create | Online, mixed, complete, empty, stale, and invalid fixtures |
| `scripts/validate-omarchy-plugin.mjs`                       | Create | Cross-platform static manifest/QML/fixture checks           |

### Tests and Documentation

| File                           | Action                              | Purpose                                             |
| ------------------------------ | ----------------------------------- | --------------------------------------------------- |
| `test/overview.test.ts`        | Create or make generated tests pass | Status and aggregation contract                     |
| `test/service-manager.test.ts` | Create or make generated tests pass | Orchestration, rollback, and receipt behavior       |
| `test/service-launchd.test.ts` | Create or make generated tests pass | Exact plist and command behavior                    |
| `test/service-systemd.test.ts` | Create or make generated tests pass | Exact unit and command behavior                     |
| `test/http.test.ts`            | Modify                              | Authenticated overview integration                  |
| `test/openapi.test.ts`         | Modify                              | Overview route/schema completeness                  |
| `test/cli-program.test.ts`     | Modify                              | New command mapping and failure paths               |
| `test/e2e.test.ts`             | Modify                              | Compiled overview and lifecycle scenarios           |
| `README.md`                    | Modify                              | Automatic installation and status integration usage |
| `docs/mcp-tools.md`            | Review only                         | Confirm no MCP behavior changed                     |

---

## Implementation Phases

### Phase 0: Executable Contract

#### Task 0.1: Generate immutable tests from the approved PRD

Run `devtronic:generate-tests` for the desktop status specification. Freeze every generated acceptance file and shared fixture with SHA-256 values in the test manifest before implementation. It must cover status precedence, overview bounds, lifecycle safety, and the read-only UI boundary.

#### Task 0.2: Capture platform fixtures and exact Quattro contract

- Record the local macOS/Swift/Xcode versions.
- Capture representative overview fixtures shared by TypeScript, Swift, and QML.
- Freeze the current official Quattro schema, commands, and plugin behavior from primary sources.
- Defer exact installed `omarchy --version`, command presence, and candidate validation to the mandatory real-machine Task 4.4 gate; the current Mac has no Omarchy executable.
- Do not mutate the live Omarchy bar during preflight.

### Phase 1: Shared Overview Contract

#### Task 1.1: Define pure overview semantics

Create the types and pure helpers for:

```typescript
statusForProject(input): 'active' | 'available' | 'complete' | 'draft'
statusForOverview(counts): 'active' | 'available' | 'complete' | 'draft' | 'empty'
sortOverviewProjects(left, right): number
boundOverview(items, limit): { items; truncated }
```

Tests cover every precedence branch, mixed active/available projects, duplicate titles, no projects, drafts only, and all-complete state.

#### Task 1.2: Aggregate overview atomically

Add `PimpampumStore.getOverview()` using a read transaction and one timestamp:

- Count all workspaces/projects/tasks.
- Aggregate task states per project.
- Join active claims to their project and optional task.
- Derive claimable project/task counts with the same conditions as `listWork`.
- Exclude expired claims.
- Return at most 500 project and 500 active-work summaries with truncation flags.
- Never select PRD, task body, context body, completion summary, or artifacts.

Add a performance fixture for 500 projects and 5,000 tasks and compare overview availability against `listWork`.

#### Task 1.3: Expose HTTP, OpenAPI, client, and CLI overview

- Add `GET /api/v1/overview` behind bearer authentication.
- Add daemon version, startup timestamp, uptime, and generated timestamp.
- Add OpenAPI schemas and exact contract tests.
- Add `PimpampumHttpClient.getOverview()`.
- Add `pimpampum overview`.
- Add a compiled E2E assertion that an active claim appears and disappears after completion.

### Phase 2: Platform-Neutral Service Lifecycle

#### Task 2.1: Implement receipt and orchestration

Create `ServiceManager` with:

```typescript
interface ServiceManager {
  install(): Promise<InstallResult>;
  status(): Promise<ServiceStatus>;
  uninstall(): Promise<UninstallResult>;
}
```

Requirements:

- Resolve every target to an explicit validated absolute path.
- Stage writes before activation.
- Record created artifacts for rollback.
- Write the receipt atomically with private permissions.
- Reconcile a repeated install rather than duplicate registrations.
- Preserve the data directory and token on uninstall.
- Refuse an unsupported platform before writing.

#### Task 2.2: Implement macOS LaunchAgent adapter

Generate a per-user plist with:

- Stable label `dev.pimpampum.daemon`.
- Absolute `process.execPath` and compiled `dist/cli.js serve` arguments.
- Captured `PIMPAMPUM_DATA_DIR`, host, port, and token-path context without embedding the token.
- `RunAtLoad` and `KeepAlive` only for abnormal termination.
- Private, bounded stdout/stderr paths.

Use argument-array process execution for `launchctl bootstrap`, `kickstart`, `print`, and `bootout`. Tests use a fake GUI domain and temporary home.

#### Task 2.3: Implement Linux systemd user adapter

Generate `~/.config/systemd/user/pimpampum.service` with:

- Absolute executable arguments.
- Captured non-secret configuration.
- `Restart=on-failure` with backoff.
- Private log handling.
- No root or system-wide unit.

Use argument-array execution for `systemctl --user daemon-reload`, `enable --now`, `show`, `disable --now`, and reset. Unit escaping, spaces, Unicode, repeat install, rollback, and missing-systemd errors receive tests.

#### Task 2.4: Wire CLI lifecycle and package artifacts

- Add `pimpampum install`, `status`, and `uninstall` to the injected CLI runtime.
- Keep `health` as the direct daemon probe; `status` reports installation plus daemon state.
- Rotate logs before activation and retain a bounded number of files.
- Package service templates, macOS app artifacts, and Omarchy plugin sources.
- Ensure `npm pack --dry-run` contains no local token, receipt, or user path.

### Phase 3: macOS Menu Bar Application

#### Task 3.1: Build Swift contract and polling model

- Define strict Codable models matching overview schema version 1.
- Read the non-secret installation receipt and the token file separately.
- Reject non-loopback base URLs and incompatible schema versions.
- Poll every ten seconds while closed and five seconds while open.
- Refresh immediately on open.
- Preserve the last valid response in memory and mark it stale after a failure.
- Unit-test online, offline, invalid-token, invalid-schema, expiry, and cancellation behavior with an injected URL protocol and clock.

#### Task 3.2: Build the read-only MenuBarExtra UI

- Render native icon plus active count.
- Map semantic states to color, symbol, text, and accessibility labels.
- Show daemon summary and active-work section.
- Show incomplete projects ordered active, available, draft.
- Show completed projects in a collapsed `Completed (N)` disclosure group.
- Constrain height and make long lists scrollable.
- Display agent ID and lease remaining for active work.
- Expose no mutations or daemon controls.

#### Task 3.3: Add Finder reveal, login registration, and app assembly

- Validate the workspace URL is an existing directory.
- Use `NSWorkspace`, never a shell command, to reveal it.
- Use `SMAppService.mainApp` for login registration.
- Handle the install-only `--register-login-item` launch, persist a non-secret acknowledgement, and terminate after reporting `enabled`, `requiresApproval`, or the registration error to the waiting CLI.
- Validate the UUID and request time window, write the acknowledgement atomically with mode `0600`, reject concurrent installs through the service installation lock, and never accept a stale acknowledgement from a prior request.
- Surface `requiresApproval` with a direct System Settings action.
- Set `LSUIElement=true` and assemble an unsigned app in `~/Applications`.
- Make installation idempotently replace only the Pimpampum app bundle.

#### Task 3.4: Verify macOS locally

- Run `swift test --enable-code-coverage`.
- Enforce complete coverage for non-UI Swift logic; document view-only exclusions.
- Build the release app on arm64.
- Run an opt-in local smoke: daemon offline, online empty, active claim, completion, stale recovery, Finder reveal, login registration, and uninstall.
- Confirm no Dock icon appears.

### Phase 4: Omarchy Quattro Plugin

#### Task 4.1: Build and validate the plugin contract

- Create a schema-version-1 `bar-widget` manifest with `allowMultiple=false` and default right placement.
- Use only documented injected bar properties and Quickshell APIs.
- Poll through an installed absolute helper that calls `pimpampum overview`; never store the bearer token in QML, settings, or process arguments.
- Validate all shared JSON fixtures cross-platform.

#### Task 4.2: Build widget, popout, and directory reveal

- Render semantic icon and active count in horizontal and vertical layouts.
- Inherit bar foreground, background, urgent, font, position, and size.
- Coordinate the popout through `bar.requestPopout` and `bar.releasePopout`.
- Mirror macOS ordering, active-work details, and collapsed completed group.
- Use a validated absolute path passed as one argument to `xdg-open`; never interpolate it into a shell expression.
- Handle offline, stale, empty, incompatible, and truncated states.

#### Task 4.3: Add safe Omarchy installation

- Detect Quattro and required commands before writing.
- Stage a copy with no symlinks under the user plugin directory.
- Run `omarchy plugin validate`.
- Rescan and enable using official plugin commands.
- Never edit `shell.json` directly.
- On failure, roll back only the staged Pimpampum plugin and leave existing layout untouched.
- Uninstall through the official plugin command and preserve unrelated plugins.

#### Task 4.4: Verify on a real Quattro machine

- Run the repository's static plugin validator on macOS.
- Transfer or install the exact candidate on the Quattro machine.
- Run `omarchy plugin validate`.
- Verify hot reload, theme inheritance, horizontal/top layout, popout coordination, active count, completed collapse, offline recovery, and `xdg-open`.
- Record the tested Omarchy build in the implementation notes.
- Write `thoughts/evidence/quattro-live.json` using the versioned evidence schema and verify it with `npm run check:quattro-evidence`.
- Compute `candidateHash` from the exact local plugin candidate using the repository checker's canonical sorted path/length/content algorithm; record successful `omarchy --version` and `omarchy plugin validate <candidate>` executable/argument arrays and results. Evidence older than 30 days, future-dated evidence, whitespace-only versions, arbitrary hashes, and mismatched candidates are rejected.
- Do not mark this task complete from fixtures alone.

### Phase 5: Cross-Platform Release Gate

#### Task 5.1: Extend compiled E2E and quality gates

- Add compiled overview lifecycle coverage.
- Add fake-platform E2E for install → status → repeat install → uninstall → data preserved.
- Add macOS opt-in real service/app smoke.
- Add Omarchy live-smoke evidence from Task 4.4.
- Keep all six existing product scenarios passing.
- Keep TypeScript runtime coverage at 100%.

#### Task 5.2: Document installation and packaging

- Update README quick start to make `pimpampum install` the recommended path.
- Document unsigned macOS first launch and login approval.
- Document Quattro plugin placement, validation, enablement, and removal.
- Document logs, status, uninstall, preservation, supported versions, and recovery.
- Verify package contents and executable paths from the packed tarball, not only the repository.

#### Task 5.3: Strict post-review

Run `devtronic:post-review --strict`, fix every finding, rerun all gates, and record any explicitly accepted platform limitation. No production TODO, FIXME, HACK, embedded secret, user-specific path, or shell interpolation may remain.

---

## Task Dependencies

```yaml
dependencies:
  0.1: []
  0.2: []
  1.1: [0.1]
  1.2: [1.1]
  1.3: [1.2]
  2.1: [0.1]
  2.2: [2.1]
  2.3: [2.1]
  2.4: [1.3, 2.2, 2.3]
  3.1: [1.3]
  3.2: [3.1]
  3.3: [2.2, 3.2]
  3.4: [3.3]
  4.1: [0.2, 1.3]
  4.2: [4.1]
  4.3: [2.3, 4.2]
  4.4: [4.3]
  5.1: [2.4, 3.4, 4.4]
  5.2: [5.1]
  5.3: [5.2]
```

Parallel execution opportunities:

- Tasks 0.1 and 0.2 can run independently.
- The platform-neutral service layer can begin after generated contracts while overview aggregation is implemented.
- LaunchAgent and systemd adapters can run in parallel after Task 2.1.
- macOS and Omarchy UI work can run in parallel after the overview contract stabilizes.

---

## Risk Analysis

### Product and Domain Risks

- **Semantic drift**: overview availability could differ from `work_list`. Mitigation: compare both against the same fixtures and centralize claimability predicates.
- **Misleading `doing` state**: clients could persist presentation state. Mitigation: expose claims and server-derived semantic status only.
- **Large installations**: hundreds of projects could make bars unusable. Mitigation: bounded transport, truncation flags, grouping, and scrolling.

### Installation Risks

- **Wrong target deletion**: uninstall could remove unrelated user files. Mitigation: installation receipt, exact path validation, ownership marker, and no recursive broad targets.
- **Partial registration**: platform commands can fail after files are written. Mitigation: staged artifacts and explicit rollback ledger.
- **Executable moves after npm update**: registered absolute paths can become stale. Mitigation: `install` reconciles paths and `status` reports the exact failed executable.
- **Environment loss at login**: GUI/system services do not inherit interactive shell variables. Mitigation: capture effective non-secret configuration in service definitions and receipt.
- **Unbounded logs**: launchd/systemd output may grow. Mitigation: error-focused output plus size/count rotation before activation and status reconciliation.

### macOS Risks

- **Unsigned app friction**: Gatekeeper may require one manual approval. Mitigation: document the exact flow and surface status.
- **Login item approval**: SMAppService may require System Settings approval. Mitigation: detect `requiresApproval` and open the correct pane.
- **Menu item removal**: macOS may terminate a menu-only app when removed. Mitigation: daemon ownership remains with LaunchAgent and status can reinstall/reopen the UI.

### Omarchy Risks

- **Quattro API movement**: Quattro plugin contracts may change before stabilization. Mitigation: exact build preflight, isolated plugin, official validation, and recorded compatibility.
- **Unsandboxed plugin execution**: Omarchy plugins run with user permissions. Mitigation: minimal auditable source, no network beyond loopback, no token in QML, no writes beyond local disclosure state.
- **User layout corruption**: direct shell JSON edits are unsafe. Mitigation: use `omarchy plugin` and shell IPC only.
- **No local Linux runtime**: the current Mac cannot prove live QML behavior. Mitigation: Task 4.4 is an explicit non-skippable completion gate.

### Security Risks

- Bearer token leakage through command lines, logs, receipts, or QML.
- Shell injection through workspace paths.
- Service binding to a non-loopback host.
- Symlinked plugin or service targets.

Each receives explicit negative tests and strict post-review checks.

---

## Testing Strategy

### Generated Spec Tests

The matching manifest is `thoughts/tests/2026-08-26_desktop-status-integrations.md`. Its hashed generated tests and fixtures are the immutable Definition of Done.

### TypeScript

- Pure unit tests for semantic status and ordering.
- SQLite integration tests for overview aggregation and expiry.
- Supertest coverage for authentication and response envelopes.
- OpenAPI operation/schema/reference completeness.
- Fake filesystem/process tests for both service adapters.
- Compiled subprocess E2E for overview and lifecycle CLI.
- Existing 100% V8 coverage threshold remains unchanged.

### Swift

- XCTest for decoding, polling state machine, sorting/grouping, stale recovery, login status, and workspace opener.
- Inject URL loading, clocks, filesystem, workspace opener, and login service.
- Run `swift test --enable-code-coverage`.
- Keep SwiftUI scene/view bodies thin; exclude only declarative view composition from coverage.
- Opt-in real app/LaunchAgent smoke on this Mac.

### QML and Omarchy

- Node validator for manifest, relative entry points, forbidden symlinks, fixture schemas, forbidden mutating commands, and unsafe shell interpolation.
- Shared overview fixtures used by TypeScript and Swift contract tests.
- Official `omarchy plugin validate` plus live Quattro smoke.

### Performance

- Seed 500 projects and 5,000 tasks in a temporary SQLite database.
- Assert no body fields appear.
- Measure overview under the 100 ms target on the reference machine; report timing without using an unrealistically brittle CI threshold on unknown hardware.

---

## Done Criteria

### Phase 0

- [x] Approved PRD has a matching SHA-256-frozen test manifest in `thoughts/tests/`.
- [x] Current official Omarchy Quattro schema and plugin commands are recorded from primary sources without changing live configuration.
- [x] Shared mixed/complete/empty/invalid fixtures are frozen.
- [ ] Exact target-machine Omarchy build and live command behavior are recorded in Task 4.4 before Phase 5 can pass.

### Phase 1

- [x] `GET /api/v1/overview` requires bearer auth and returns schema version 1.
- [x] `pimpampum overview` returns the same data contract.
- [x] Active claims, available work, drafts, complete projects, empty state, and truncation have deterministic tests.
- [x] Overview and `work_list` agree on claimable work across fixtures.
- [x] No overview query selects Markdown or completion/artifact bodies.
- [x] OpenAPI documents the full overview contract.

### Phase 2

- [x] Repeating install produces one reconciled registration and no duplicate files.
- [x] Unsupported platforms fail before writes.
- [x] Injected LaunchAgent and systemd E2E tests pass with paths containing spaces and Unicode.
- [x] Partial failures restore the original state.
- [x] Uninstall removes only receipt-owned files and preserves the data directory/token.
- [x] Receipts and package contents contain no token.

### Phase 3

- [ ] Unsigned app builds with Swift 6.3/Xcode 26.6 and installs under `~/Applications`.
- [ ] Menu bar indicator shows active count and all semantic states with accessible non-color labels.
- [ ] Popover shows active work, incomplete projects, and collapsed completed projects.
- [ ] Finder reveal opens the exact workspace root without shell execution.
- [ ] Offline state retains and labels stale data.
- [ ] Login item status and approval path work locally.
- [ ] Swift unit tests and opt-in macOS smoke pass.

### Phase 4

- [ ] `omarchy plugin validate` accepts the candidate on the target Quattro build.
- [ ] Plugin is enabled without direct `shell.json` modification.
- [ ] Widget inherits theme and works in the actual top bar.
- [ ] Popout, active count, completed collapse, stale recovery, and file opening pass live smoke.
- [ ] Plugin removal preserves every unrelated plugin and layout entry.

### Spec Tests

- [ ] All generated feature tests pass.
- [ ] No generated spec test file was modified after generation.

### Overall

- [ ] `npm run typecheck` passes with zero errors.
- [ ] `npm run lint` passes with warnings denied.
- [ ] `npm run format:check` passes.
- [ ] `npm test` passes all existing and new compiled scenarios.
- [ ] TypeScript runtime coverage remains 100% for statements, branches, functions, and lines.
- [ ] `swift test --enable-code-coverage` passes.
- [ ] `npm audit --omit=dev` reports no production vulnerabilities.
- [ ] `npm pack --dry-run` contains every required runtime integration and no local artifacts.
- [ ] `devtronic:post-review --strict` reports no unresolved findings.
- [ ] No TODO, FIXME, HACK, embedded secret, user-specific path, or unsafe shell interpolation remains.
- [ ] README documents install, status, overview, platform behavior, approval, logs, recovery, and uninstall.

---

## Verification Commands

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm audit --omit=dev
npm pack --dry-run
swift test --package-path platforms/macos --enable-code-coverage
node scripts/validate-omarchy-plugin.mjs
```

Platform-specific gates:

```bash
# macOS, opt-in because it registers real per-user services
npm run test:e2e:macos

# Omarchy Quattro, on the target machine
omarchy plugin validate integrations/omarchy/pimpampum-status
npm run test:e2e:omarchy
```

After implementation, run `devtronic:post-review --strict` and repeat every command above.

---

## Approval

Approve this plan only with the following understood:

1. macOS implementation and smoke testing can be completed on the current machine.
2. Omarchy static validation can be completed here, but final UI completion requires access to the actual Quattro machine.
3. Signing, notarization, automatic updates, Waybar, and Windows remain out of scope.
