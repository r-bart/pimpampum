# PRD: Automatic Service and Desktop Status Integrations

**Date**: 2026-08-25  
**Status**: approved

---

## Executive Summary

Pimpampum should run automatically after a one-time installation and expose a compact, read-only operational view in the macOS menu bar and the Omarchy Quattro status bar. Both integrations show project health, available work, and active claims from the single local Pimpampum instance without introducing a separate persisted `doing` state.

The macOS integration will be an unsigned local SwiftUI menu bar application for the first release. The Omarchy integration will be a dedicated native Quickshell plugin. Selecting a project opens its registered workspace directory in Finder or the Linux file explorer.

---

## Problem Statement

### Current State

Pimpampum only runs when a user starts the daemon manually. Its operational state is available through CLI, HTTP, and MCP, but there is no ambient indication that the daemon is online, which projects need attention, or whether agents are working.

### Pain Points

- Users must remember to start the daemon after login or reboot.
- There is no immediate visual confirmation that Pimpampum is healthy.
- Inspecting projects and active work requires opening a terminal or invoking an agent.
- Concurrent agent work is difficult to understand at a glance.
- macOS and Omarchy currently provide no native Pimpampum surface.

---

## Goals and Non-Goals

### Goals

1. Start Pimpampum automatically for the current user after one explicit installation.
2. Show consistent project and active-work semantics on macOS and Omarchy Quattro.
3. Represent work in progress from active claims rather than adding a persisted `doing` state.
4. Show an active-work counter in the compact bar indicator.
5. Allow a user to reveal a project's workspace directory from the status UI.
6. Keep installation, update, and removal safe, idempotent, and reversible.
7. Preserve Pimpampum's local-first security and minimal product model.

### Non-Goals

- Creating, editing, claiming, releasing, or completing work from the status UI.
- A general-purpose desktop project management application.
- A web interface.
- Notifications.
- Windows support.
- Legacy Omarchy Waybar support.
- Signed, notarized, or Mac App Store distribution in the first release.
- Adding a persisted `doing` project or task state.
- Deleting the Pimpampum data directory during normal uninstall.

---

## Product Semantics

### Work in Progress

An unexpired claim is the only source of truth for work in progress:

```text
active claim = currently being worked on
no active claim = not currently being worked on
```

No `doing` state will be stored on projects or tasks. This prevents lifecycle state and claim ownership from drifting apart.

### Project Indicators

| Indicator | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| Blue      | The project has one or more active claims                            |
| Amber     | The project has available work but no active claim                   |
| Green     | The project lifecycle state is `done`                                |
| Gray      | The project is a draft or has no actionable work                     |
| Red       | Pimpampum is unavailable or the integration cannot read valid status |

A project may have active and available work simultaneously. In that case its primary indicator is blue and both counts are displayed.

### Global Indicator Precedence

```text
integration error or daemon offline
  → active work exists
  → available work exists
  → drafts only
  → every project is complete
  → no projects
```

The active-work count shown in the bar is the number of unexpired claims across all registered projects.

### Completed Projects

- Incomplete projects are always visible.
- Completed projects appear in a `Completed (N)` group.
- The completed group is collapsed by default.
- Expanding it reveals all completed projects in the current session.
- Restarting the integration returns the group to its collapsed state.

---

## User Stories

### Automatic Startup

**As a** Pimpampum user  
**I want** the daemon to start automatically when I log in  
**So that** agents can use the shared instance without manual preparation.

Acceptance criteria:

- [ ] One explicit install operation enables automatic startup for the current user.
- [ ] Pimpampum starts after login without a terminal.
- [ ] The service restarts after an unexpected daemon failure.
- [ ] Installation is idempotent.
- [ ] Uninstall removes generated service files but preserves `~/.pimpampum`.

### Ambient Status

**As a** user with multiple projects and agents  
**I want** a compact status indicator  
**So that** I can see whether Pimpampum is healthy and whether work is active.

Acceptance criteria:

- [ ] The compact indicator reflects the global status precedence.
- [ ] The compact indicator displays the active-claim count when it is greater than zero.
- [ ] Status becomes current within ten seconds of a server-side change.
- [ ] Offline and invalid-response states are visibly distinct from healthy idle state.

### Project Overview

**As a** project owner  
**I want** to inspect projects and current work from the status bar  
**So that** I can understand activity without opening a terminal.

Acceptance criteria:

- [ ] Projects show title, primary indicator, active count, and available-work count.
- [ ] Active work shows project, task or project title, agent ID, and lease time remaining.
- [ ] Projects are ordered active first, then available, then draft.
- [ ] Completed projects are collapsed by default.
- [ ] Long project lists are scrollable and do not expand beyond the available screen.

### Reveal Project Directory

**As a** user inspecting a project  
**I want** to select it and open its files  
**So that** I can move directly from status to the repository.

Acceptance criteria:

- [ ] Selecting a project opens its workspace root in Finder on macOS.
- [ ] Selecting a project opens its workspace root through the system file opener on Linux.
- [ ] Missing or inaccessible directories produce a non-destructive inline error.
- [ ] The integration never executes a path returned by the API as shell source.

---

## Functional Requirements

### 1. Aggregated Overview Contract

Add one authenticated, bounded read model:

```http
GET /api/v1/overview
```

Add equivalent CLI access:

```text
pimpampum overview
```

**Amended 2026-08-29.** Every CLI success writes one `{"data": ...}` envelope to stdout, so
`overview`, `install`, `status`, and `uninstall` return the payload under `data` rather than bare.
The HTTP surface keeps its own independently versioned `{meta, data}` envelope. The Omarchy plugin
accepts the bare payload and the `data` envelope, so an installed plugin keeps working against
either CLI version. The live Quattro evidence transcript records raw stdout, so
`scripts/check-quattro-evidence.mjs` unwraps the envelope for Pimpampum CLI commands and keeps
reading omarchy shell and plugin probes as-is.

The response includes:

- Server version, generated timestamp, and uptime.
- Workspace count.
- Project counts by lifecycle state.
- Active-claim count.
- Available-work count.
- One bounded project summary per project.
- One bounded active-work summary per unexpired claim.
- Workspace root path for reveal-directory behavior.

Project summaries include:

- Project ID, title, slug, lifecycle state, and workspace metadata.
- Open-task and completed-task counts.
- Active-claim count.
- Available-work count.
- Last updated timestamp.

Active-work summaries include:

- Target type and target ID.
- Project ID and project title.
- Task title when the target is a task.
- Agent ID.
- Claim expiry timestamp.

The overview response must not include PRD bodies, task bodies, context bodies, completion summaries, or artifact arrays.

### 2. Service Installation

Provide:

```text
pimpampum install
pimpampum status
pimpampum uninstall
```

`install` detects the supported platform:

- macOS: install and activate a per-user LaunchAgent plus the local menu bar application.
- Omarchy Quattro: install and enable a `systemd --user` service plus the Quickshell plugin.
- Other Linux: install and enable the user service without an Omarchy integration.
- Unsupported platforms: fail without partially installing files.

`uninstall` removes only files and registrations created by the installer. It does not remove project data, backups, exports, or tokens.

Generated services:

- Run without root privileges.
- Bind only to the configured loopback address.
- Use the canonical Pimpampum configuration.
- Write bounded diagnostic logs under the Pimpampum data directory.
- Restart after unexpected failure with backoff.
- Avoid restart loops after a clean user-requested stop or uninstall.

### 3. macOS Menu Bar Application

Build an unsigned local SwiftUI application targeting macOS 13 or newer.

Requirements:

- Use a persistent `MenuBarExtra`.
- Use a menu-bar-only application mode with no Dock icon.
- Display a Pimpampum status glyph and active-claim count.
- Open a compact popover containing summary, active work, and projects.
- Poll the local authenticated overview endpoint every five seconds while visible and every ten seconds while closed.
- Refresh immediately when the popover opens.
- Keep the last valid response in memory when the daemon goes offline and label it as stale.
- Never write project state.
- Reveal workspace roots through the native workspace API.
- Install into `~/Applications` for the first local release.
- Start at login after explicit installation.

The first release does not require signing or notarization. Documentation must explain the local unsigned-app launch flow.

### 4. Omarchy Quattro Plugin

Provide a dedicated Omarchy Shell plugin:

```text
integrations/omarchy/pimpampum-status/
```

Requirements:

- Declare a native `bar-widget` plugin manifest.
- Use a Quickshell/QML widget and popout.
- Inherit foreground, background, urgent color, font, bar position, and bar size from the active Omarchy theme.
- Support horizontal and vertical bars.
- Show the same status precedence and active count as macOS.
- Show the same active-work and project information.
- Use Pimpampum CLI output or another authenticated local adapter so the token is not embedded in plugin configuration.
- Reveal workspace roots through the system file opener.
- Hot-reload cleanly under Omarchy Shell.
- Never overwrite Omarchy's shipped files.
- Preserve an existing user-owned `shell.json`; installation must use supported plugin/bar mechanisms or stop with actionable manual instructions.

The plugin targets Omarchy Quattro only. Waybar compatibility is explicitly deferred.

### 5. Read-Only Boundary

The status integrations may:

- Read overview information.
- Refresh.
- Expand or collapse local UI groups.
- Reveal a workspace directory.

They may not:

- Change project or task lifecycle state.
- Create or update PRDs, context, tasks, or subtasks.
- Claim, renew, release, or complete work.
- Start, stop, or restart the daemon from the visible UI.
- Delete data or generated artifacts.

---

## Empty, Error, and Edge States

| Condition                                     | Required behavior                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Daemon offline                                | Red indicator, clear offline label, retain last response as stale if one exists |
| Invalid token                                 | Red indicator and actionable local configuration message; never display token   |
| No workspaces                                 | Neutral empty state with setup command                                          |
| No projects                                   | Neutral empty state                                                             |
| Drafts only                                   | Gray global indicator                                                           |
| All projects complete                         | Green global indicator                                                          |
| Active and available work                     | Blue global indicator with both counts in detail view                           |
| Claim expires between polls                   | Remove it on the next successful refresh                                        |
| Hundreds of projects                          | Bounded API response and scrollable UI                                          |
| Duplicate project titles                      | Show workspace name or slug as disambiguation                                   |
| Missing workspace directory                   | Keep project visible and show reveal error                                      |
| Overview schema mismatch                      | Red incompatible-version state rather than partial rendering                    |
| Service already installed                     | Return success and reconcile generated configuration                            |
| Partial installation failure                  | Roll back artifacts created during that attempt                                 |
| Omarchy plugin layout cannot be edited safely | Leave configuration untouched and print manual completion steps                 |

---

## Technical Considerations

### Domain and Data Model

- No database migration is required for a `doing` state.
- Active work is derived from unexpired claims.
- Project counts are derived atomically from the canonical store.
- Overview computation must use bounded queries and avoid loading Markdown bodies.
- Existing project, task, claim, and completion invariants remain unchanged.

### API

- Add `GET /api/v1/overview` to OpenAPI 3.1.
- Preserve the existing success/error envelope.
- Require bearer authentication.
- Version the overview payload through the existing envelope schema version.
- Add client and CLI support.
- MCP exposure is not required for the status integrations; agents already have specialized discovery tools.

### Security

- Both services run as the logged-in user, never root.
- Project data remains authenticated and loopback-only.
- Tokens must not appear in arguments, logs, plugin manifests, or UI.
- Workspace paths are treated as opaque paths and opened without shell interpolation.
- Installation must validate every target path before writing.

### Performance

- Overview should complete in under 100 ms for 500 projects and 5,000 tasks on the reference machine.
- Bar integrations must not poll more often than every five seconds.
- A failed daemon must not cause a tight retry loop.
- Compact indicators should update without visible UI blocking.

### Compatibility

- macOS 13 or newer.
- Omarchy Quattro with Omarchy Shell/Quickshell.
- Linux distributions with per-user systemd for service-only installation.
- Node.js 22 remains required for the first release.

### Packaging

- Keep platform integrations isolated from the TypeScript domain.
- The npm package must continue to work without building the macOS application.
- Local development can build the unsigned app with the installed Apple toolchain.
- A future standalone executable, signed app, notarized distribution, and update mechanism remain separate work.

---

## Testing and Definition of Done

### Core

- Unit tests cover overview aggregation, status precedence, mixed project states, claim expiry, empty states, and bounded results.
- HTTP and OpenAPI contract tests cover the overview endpoint.
- CLI tests cover overview, install, status, and uninstall behavior through injected platform adapters.
- Existing 100% runtime coverage remains enforced.

### Service Adapters

- LaunchAgent generation and reconciliation are tested without mutating the real user service registry.
- systemd unit generation and reconciliation are tested without mutating the real user service registry.
- Install rollback, repeat installation, and uninstall preservation are tested.
- Paths containing spaces and Unicode are covered.

### macOS

- Swift unit tests cover response decoding, precedence, grouping, sorting, stale state, and reveal-directory actions.
- A local smoke test launches the unsigned app and verifies online and offline rendering.
- The daemon starts after a simulated or real login-agent bootstrap.

### Omarchy

- QML/plugin contract tests validate the manifest and fixture responses.
- A local Quattro smoke test verifies widget load, popout, theme inheritance, refresh, and directory reveal.
- Existing `shell.json` content remains intact.

### End-to-End

- Install → automatic daemon start → overview online → active claim appears → claim completion updates project counts.
- Daemon termination → offline indicator → automatic service recovery → online indicator.
- Project selection opens the exact registered workspace path.
- Uninstall removes integrations and service registration while preserving `~/.pimpampum`.

---

## Success Metrics

| Metric                                  | Target                                | Measurement                          |
| --------------------------------------- | ------------------------------------- | ------------------------------------ |
| Manual daemon starts after installation | Zero during normal use                | Acceptance test and user observation |
| Status freshness                        | At most 10 seconds                    | Timestamped integration test         |
| Project/claim accuracy                  | 100% against overview fixtures        | Cross-contract tests                 |
| Installation idempotency                | No duplicate services or plugins      | Repeated-install test                |
| Data preservation on uninstall          | 100%                                  | E2E filesystem assertion             |
| Runtime regression                      | 0 failures and 100% existing coverage | Full quality gate                    |

No telemetry is collected. Success is evaluated through deterministic tests and direct local use.

---

## Delivery Slices

### Slice 1: Shared Read Model

- Overview domain query.
- HTTP, OpenAPI, client, and CLI contracts.
- Status precedence fixtures.

### Slice 2: Automatic Service

- Platform-neutral installer interfaces.
- macOS LaunchAgent.
- Linux systemd user service.
- Install, status, uninstall, rollback, and logs.

### Slice 3: macOS Integration

- Unsigned SwiftUI menu bar application.
- Startup registration.
- Read-only project and active-work popover.
- Finder reveal.

### Slice 4: Omarchy Quattro Integration

- Dedicated plugin manifest.
- QML bar widget and popout.
- Theme integration.
- File-manager reveal.
- Safe installation.

---

## Risks

| Risk                                                             | Impact | Mitigation                                                                                        |
| ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| Omarchy Quattro plugin APIs change before stable release         | High   | Isolate the plugin, target a documented Quattro version, and validate on the actual machine       |
| Unsigned macOS app triggers Gatekeeper friction                  | Medium | Document the first-launch flow; defer signing and notarization                                    |
| npm or Node installation path changes after service registration | High   | Resolve and store canonical executable paths; add status diagnostics and reinstall reconciliation |
| Automatic shell configuration damages user customization         | High   | Never edit shipped files; preserve user configuration and fail safely                             |
| Polling adds unnecessary process or database load                | Medium | Use one bounded overview call and enforce minimum intervals                                       |
| Status colors differ across themes or accessibility settings     | Medium | Pair every color with iconography and text; inherit Omarchy theme tokens                          |
| A stale claim appears active briefly                             | Low    | Clearly derive from expiry and refresh within ten seconds                                         |

---

## Resolved Decisions

- The implementation preflight will record the exact installed Omarchy Quattro build before its live smoke test.
- The compact indicator shows active claims only; available-work counts remain in the popout.
- The Omarchy plugin ships inside this repository for initial validation and may become a separate plugin repository later.

---

## Design References

No external mockups were provided. The integrations should use the existing Pimpampum rhythmic-wayfinding identity while respecting native platform conventions:

- macOS: native SwiftUI menu bar behavior and accessibility.
- Omarchy: active theme tokens and native bar geometry.
- Shared semantics: blue active, amber available, green complete, gray draft/empty, red unavailable.

## Technical References

- [Apple SwiftUI MenuBarExtra](https://developer.apple.com/documentation/swiftui/menubarextra)
- [Apple Service Management and SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
- [Omarchy Quattro shell and plugin model](https://github.com/basecamp/omarchy/blob/quattro/docs/omarchy-shell.md)
- [Omarchy Quattro top bar model](https://github.com/basecamp/omarchy/blob/quattro/manual/05-the-top-bar.md)

## Amendment 2026-09-01: packaging of the macOS app

The deep review of 2026-09-01 (finding H-12) found that `pimpampum@1.2.11` on npm weighed
157 MB because `platforms/macos/dist` shipped with its embedded runtime. FR-3 is amended: the
signed macOS app is distributed only as a GitHub Release asset and through the packaged
update channel. The npm package ships the daemon, the CLI, the docs and the Omarchy plugin.
`test/desktop-status.acceptance.test.ts` asserts the new `files` list.
