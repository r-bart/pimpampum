# PRD: Zero-friction local agent setup

**Date**: 2026-08-31
**Status**: approved

---

## Executive Summary

Pimpampum should become the easiest possible way to give local coding agents one shared project
memory. A user downloads the macOS app or installs the Omarchy integration, approves one clear
setup action, and gets a running local service plus verified connections to the supported agents
already installed on that computer. Normal setup must not require Node.js, npm, Terminal, bearer
tokens, configuration files, or knowledge of MCP.

The first release supports Codex and Claude Code through a connector architecture intended for
additional local MCP hosts. The existing daemon remains the single owner of domain invariants,
SQLite, synchronization, backup, HTTP, and MCP. Native surfaces provision and control a packaged
runtime; they do not reimplement or own the domain service.

---

## Problem Statement

### Current State

The downloadable macOS app is a polished native client, but its first-run experience asks the user
to copy an npm command, open Terminal, install a global Node.js package, and check again. Connecting
an agent then requires knowing that Pimpampum exposes MCP, locating the agent's configuration, and
adding a command manually. Omarchy installs the widget and managed user service together, but still
depends on the npm-distributed Node runtime and leaves MCP host registration as a separate concern.

The implementation already has the correct runtime topology: one managed daemon exposes the local
HTTP API and Streamable HTTP MCP, while an ephemeral `stdio` bridge lets compatible hosts reach that
same authenticated daemon. The friction comes from distribution and connection provisioning, not
from the domain or protocol architecture.

### Pain Points

- Users must understand Node.js, npm, Terminal, MCP transports, executable paths, and host-specific
  configuration before receiving any product value.
- The macOS app advertises a native product but delegates its essential setup to a copied shell
  command.
- Every MCP host has a different configuration location and lifecycle, making manual instructions
  fragile and repetitive.
- Tokens or mutable executable paths can be mishandled when users assemble configuration manually.
- Successful configuration is not the same as a verified connection, and current setup does not
  close that gap for the user.
- The product claim of being "absurdly simple" is undermined at the most important first-use
  moment.

---

## Goals & Non-Goals

### Goals

1. Take a new user from download to a verified agent connection in under two minutes.
2. Require no Terminal commands and no external Node.js or npm installation on macOS or Omarchy.
3. Detect supported local MCP hosts and connect the selected hosts through one explicit Pimpampum
   confirmation.
4. Support Codex and Claude Code first without hard-coding host behavior into UI components.
5. Preserve one OS-managed daemon and one canonical `PimpampumStore` across every UI and agent.
6. Keep credentials out of host configuration, process arguments, logs, and visible UI.
7. Make installation, migration, connection, repair, disconnection, update, and removal
   idempotent, verifiable, reversible, and safe around user-owned configuration.
8. Preserve the visual and interaction language of the existing Quiet macOS onboarding and native
   Settings experience.

### Non-Goals

- Reimplementing the TypeScript daemon, SQLite store, or domain rules in Swift or QML.
- Making the macOS menu app or Quickshell plugin own the daemon lifecycle.
- Installing Codex, Claude Code, or any other third-party agent.
- Supporting every MCP host in the first release.
- Providing remote or cloud MCP access.
- Removing all background processes; the shared local service must remain available independently
  of agent and UI lifecycles.
- Silently modifying another application's configuration without explicit user consent.
- Exposing tokens, transport selection, executable paths, or raw configuration in the primary UX.
- Collecting product telemetry.

---

## Primary Users

### New local user

Has installed one or more coding agents and wants shared memory without learning MCP or managing a
runtime.

### Existing npm user

Already has Pimpampum data, a managed Node daemon, and possibly one or more manually configured MCP
clients. The upgrade must preserve data and avoid duplicate services or configuration.

### Advanced or unsupported-host user

Needs diagnostics or manual configuration for a client Pimpampum does not yet manage. Advanced
details may be copied explicitly but stay outside the normal path.

---

## Product Principles

1. **Connect agents, do not teach MCP.** Primary copy talks about shared project memory and agent
   connections.
2. **One meaningful consent.** Pimpampum performs all safe, disclosed setup work after one
   confirmation. Additional operating-system approval appears only when the OS requires it.
3. **Verify outcomes.** A green state means Pimpampum tested the installed runtime and host
   registration, not merely that it wrote a file.
4. **Never surprise user-owned configuration.** Unknown collisions stop for a decision.
5. **Keep the service independent.** Closing the app, restarting Quickshell, or closing an agent
   does not stop shared memory, synchronization, or backup.
6. **Hide machinery, preserve escape hatches.** Normal users see simple states and actions;
   advanced users can inspect paths and copy manual instructions.

## Validated UX Direction

The macOS first-run experience uses the **Guided** direction selected from the interactive
onboarding prototype on 2026-08-31.

- Use one compact popover and three progressive steps: explain the private service, choose detected
  agents, then install and verify.
- Keep the single meaningful consent on **Review & set up**. The explanatory first step does not
  trigger mutations.
- Lead with outcomes and trust: no Terminal window, no visible Node.js runtime, starts at sign-in,
  and can be fully removed.
- Detect Codex and Claude Code automatically, select both by default, and preserve user choice in
  the resulting connection summary.
- Show durable progress, per-agent verification, safe partial failure, retry, and a path to continue
  with the agents that connected successfully.

Rejected directions:

- **Current / Terminal handoff** was rejected because it exposes npm, Node.js, shell commands, and
  manual verification at the highest-friction point in the product.
- **One click / compressed consent** was rejected as the primary first-run experience because it
  asks for configuration changes before establishing enough trust. Its concise detected-agent list
  and progress treatment remain useful inside the Guided flow.

---

## Ideal User Journey

### macOS: clean installation

1. The user downloads and opens one signed `.dmg` or `.app` distribution.
2. The existing menu-bar onboarding appears using the current Quiet visual language.
3. Step one explains that one private service will run for the current user, starts at sign-in,
   remains available when the menu app closes, and can be removed later.
4. Step two lists the supported installed agents Pimpampum detected and selects them by default.
5. The user reviews the bounded configuration changes and selects **Review & set up** once.
6. Step three installs the packaged runtime, registers the per-user service, registers the app for
   login, configures the selected agents, starts the service, and verifies every owned change.
7. If macOS requires Login Items approval, Pimpampum shows the native recovery action and resumes
   verification afterward.
8. The completion screen reports the local service and each agent separately.
9. Pimpampum offers **Open Codex**, **Open Claude Code**, or a concise instruction to begin a new
   session when a running session cannot reload MCP dynamically.
10. Returning to the menu shows the normal portfolio view. Agent connection management lives in
    Settings.

### Omarchy: clean installation

1. The user installs the Pimpampum Omarchy integration through its supported package/plugin path.
2. The installation delivers the widget, packaged runtime, bounded helpers, and `systemd --user`
   unit without requiring a separately installed Node.js runtime.
3. Opening the Pimpampum Settings card detects supported agents and presents **Connect agents**.
4. One confirmation configures and verifies the selected agents.
5. The widget reports completion or an actionable per-agent error without exposing tokens or shell
   fragments.

### Existing installation migration

1. Pimpampum detects the current receipt, service owner, data directory, runtime, and recognized
   agent configurations.
2. Before mutating anything, it snapshots every owned service and host-configuration artifact it
   may replace.
3. It stops the old managed service, installs the packaged runtime, reconciles the service, and
   updates only recognized Pimpampum-owned agent entries.
4. It starts and verifies the new runtime against the existing database and token.
5. Only after successful verification does it remove obsolete owned runtime artifacts.
6. Any failure restores the prior working service and host configurations. User data is never
   rolled back, moved, or deleted by migration.

---

## macOS Experience

### Existing design baseline

The current `SetupOnboardingView` establishes the baseline:

- Compact menu-bar popover.
- Quiet eyebrow, strong title, short supporting copy.
- One full-width 44-point primary action.
- One subdued recovery/secondary action.
- Native typography, materials, spacing, light/dark behavior, keyboard default action, and
  accessibility labels.
- A concise privacy/security footer.

The new experience replaces the command card and Terminal action; it does not add a separate visual
system.

### Proposed first-run content hierarchy

```text
1 OF 3
FIRST, THE SERVICE

One private home for agent context.
Pimpampum keeps shared memory available without a Terminal window or a separate Node app.

⌂ Runs only on this Mac, even when this window is closed.
◎ Starts automatically when you sign in.
↶ Can be stopped and fully removed at any time.

[ Continue ]

2 OF 3
NOW, YOUR AGENTS

Choose who can use Pimpampum.
We found two supported agents. Both can be changed later.

Detected agents
[selected] Codex          Ready to connect
[selected] Claude Code    Ready to connect

[ Back ] [ Review & set up ]

3 OF 3
Making Pimpampum ready.
```

The flow has three short steps but only one mutating confirmation. Agent selection is inline and
both detected supported agents are selected by default.

### Progress

Setup uses one stable surface and a bounded sequence of plain-language steps:

```text
Setting up Pimpampum…

✓ Installing local service
✓ Starting Pimpampum
• Connecting Codex
  Connecting Claude Code
```

The user may close the popover without corrupting setup. Reopening resumes from durable state.

### Completion

```text
You're ready.

✓ Pimpampum is running
✓ Codex is connected
✓ Claude Code is connected

Open a new agent session to use shared project memory.

[ Open Codex ]
[ Done ]
```

When multiple applications can be opened, completion may offer one primary **Open agent** action
and individual actions in the connection list rather than several competing primary buttons.

### Settings

Add **Agents** to the existing segmented Settings window alongside Synchronization, Backup, and
Updates. Each supported connector presents one of these states:

- Not installed
- Detected · Not connected
- Connecting
- Connected · Available
- Connected · New session required
- Needs repair
- Configuration conflict
- Unsupported version
- Unavailable

Each row exposes only relevant actions: **Connect**, **Test**, **Repair**, **Open**, or
**Disconnect**. Advanced details are behind a disclosure and include the effective transport,
runtime path, last verification time, and copyable manual instructions with secrets redacted.

---

## Omarchy Experience

The existing Settings popout gains an **Agents** card using the same status model and wording as
macOS. The card must remain usable within the bounded Quickshell popout and inherit the current
theme, focus, touch/keyboard, and scrolling behavior.

The plugin continues to invoke receipt-owned bounded helpers by absolute path. QML must not parse or
write MCP host configuration, read the bearer token, launch arbitrary commands, or host the daemon.
All detection and mutations go through a dedicated Pimpampum connector command or local API.

---

## User Stories

### US-1: One-action setup

**As a** new Pimpampum user  
**I want to** approve one understandable setup action  
**So that** my installed coding agents gain shared local memory without technical configuration.

Acceptance criteria:

- [ ] macOS normal setup requires no Terminal or external runtime installation.
- [ ] Pimpampum detects Codex and Claude Code when supported installations are present.
- [ ] Detected supported agents are selected by default.
- [ ] One Pimpampum confirmation installs the runtime and connects the selected agents.
- [ ] Any separate system approval is requested only when required by the operating system.

### US-2: Trustworthy completion

**As a** user completing setup  
**I want to** know which parts actually work  
**So that** I do not discover a configuration failure in my first agent session.

Acceptance criteria:

- [ ] Runtime health and every agent connector are verified independently.
- [ ] Partial success remains visible and recoverable.
- [ ] The success state is shown only after an MCP initialization and bounded tool-catalog check
      succeeds through the installed route.
- [ ] The UI distinguishes “configured” from “available in the current agent session.”

### US-3: Safe existing-user migration

**As an** existing npm user  
**I want to** adopt the packaged runtime without losing data or breaking agents  
**So that** the easier distribution is a safe upgrade.

Acceptance criteria:

- [ ] Existing SQLite, token, settings, backups, sync state, receipts, and activity are preserved.
- [ ] A migration cannot leave two daemons owning the same data directory.
- [ ] Recognized Pimpampum connector entries are reconciled idempotently.
- [ ] Unknown configuration collisions are never overwritten automatically.
- [ ] Failed migration restores the prior working runtime and connector configuration.

### US-4: Connection management

**As a** user whose tools change over time  
**I want to** connect, test, repair, and disconnect agents from Pimpampum Settings  
**So that** MCP configuration remains understandable and reversible.

Acceptance criteria:

- [ ] Disconnect removes only the recognized Pimpampum-owned connector entry.
- [ ] Disconnecting an agent does not stop the daemon or delete Pimpampum data.
- [ ] A missing client is reported without offering to install third-party software.
- [ ] Unsupported clients receive redacted manual instructions from Advanced settings.

---

## Functional Requirements

### 1. Packaged Runtime

- macOS and Omarchy distributions include a platform-compatible Pimpampum runtime.
- The runtime exposes the existing CLI, `serve`, and `mcp` behaviors without requiring external
  Node.js or npm during normal installation or execution.
- The daemon remains managed by `launchd` or `systemd --user`, starts automatically, restarts after
  unexpected failure with backoff, and remains independent of UI processes.
- A runtime release is versioned and updated atomically with its native integration.
- The selected packaging technique is an implementation decision. A bundled runtime directory and
  a single executable are both acceptable if they satisfy signing, native-addon, update, startup,
  and rollback requirements.

### 2. Connector Architecture

Each host connector implements a common domain-neutral contract:

- Detect host installation and supported version.
- Inspect current Pimpampum registration without loading unrelated configuration.
- Plan and describe the exact owned mutation.
- Connect idempotently.
- Verify runtime startup and MCP initialization.
- Report whether a new host session is required.
- Repair recognized stale configuration.
- Disconnect only recognized owned configuration.
- Snapshot and restore affected artifacts.
- Produce redacted diagnostics and manual instructions.

Codex and Claude Code are the first connectors. Connector rules must live outside SwiftUI, QML,
HTTP routes, and `PimpampumStore`.

### 3. Detection and Selection

- Detection occurs locally and does not launch the agent.
- Supported detected agents are selected by default during clean onboarding.
- The user can inspect and deselect agents before confirming.
- Unsupported versions are not selected and show concise upgrade guidance.
- Absence is neutral, not an installation error.
- Detection must not traverse broad home-directory contents when a bounded documented location or
  executable probe is available.

### 4. Consent

- Before the first mutation, show that Pimpampum will install one private local service, start at
  login, and update the selected agent configurations.
- One confirmation authorizes only the listed local changes.
- The confirmation does not authorize installing third-party agents, deleting data, enabling
  remote access, or resolving unknown configuration conflicts.
- Advanced users can inspect the planned paths and operations before confirmation.

### 5. Connection Provisioning

- Prefer each host's supported configuration command or API over direct file editing.
- When direct file mutation is necessary, preserve unrelated content and permissions and perform an
  atomic revision-checked replacement.
- Use an absolute, receipt-owned runtime command; do not depend on a graphical session's `PATH` or
  use `npx`.
- Do not place the Pimpampum bearer token in host configuration.
- Prefer prompting for write-capable MCP tools when the host supports approval policy.
- A connector entry includes enough ownership/version metadata, where the host permits it, to
  distinguish safe reconciliation from an unknown collision.

### 6. Verification

- Verify daemon health against the installed receipt and private token.
- Verify the configured MCP route by completing initialization and requesting the bounded tool
  catalog.
- Reject a route that exposes the wrong server identity, incompatible protocol/version, missing
  required tools, or secrets in output.
- Verification has a bounded timeout and cannot leave an orphaned bridge process.
- Record only redacted local connection status and last verification time.

### 7. Recovery and Conflict Handling

- A setup interrupted by app closure, shell restart, logout, or power loss resumes or rolls back
  from durable installation state.
- If a supported host has an unknown `pimpampum` entry, present **Keep existing**, **Replace**, and
  **Cancel** only after showing a redacted comparison. Replacement always requires a separate,
  explicit decision because it exceeds the original safe setup consent.
- If one selected agent fails, keep verified connections, report partial completion, and offer
  **Try again** for the failed connector.
- If runtime installation or daemon verification fails, do not configure agents against a broken
  route.
- If Login Items approval is denied, keep the app and data intact, explain the consequence, and
  provide the native Settings recovery path.

### 8. Update and Removal

- Updates reconcile the packaged runtime, managed service, connector entries, and native surfaces
  as one versioned installation transaction.
- Updating must not require users to reconnect healthy owned connectors.
- Removing Pimpampum removes owned runtime/service artifacts and recognized connector entries while
  preserving the private data directory, token, backups, exports, and synchronized snapshots.
- If connector removal cannot be proven safe, leave the entry and report manual instructions rather
  than guessing.

### 9. Advanced and CLI UX

Provide equivalent non-graphical operations for supported installations:

```text
pimpampum connect codex
pimpampum connect claude-code
pimpampum connections
pimpampum disconnect codex
pimpampum connect --instructions
```

Exact syntax may change during implementation planning, but the surface must remain JSON-first,
non-interactive when all required decisions are supplied, redacted, and compatible with the
existing CLI error envelope.

---

## Security & Privacy Requirements

- Run every component as the logged-in user; never require root.
- Keep HTTP and MCP network listeners on loopback only.
- Keep the data directory private and token files at mode `0600`.
- Keep bearer tokens out of UI, host configuration, process arguments, logs, receipts, diagnostics,
  analytics, and clipboard operations.
- Sign and notarize the macOS app and every nested executable/helper distributed with it.
- Pin the installed runtime to the application release; never fetch or execute an unbounded latest
  package during onboarding.
- Verify downloaded Omarchy/runtime artifacts through the supported release/package trust chain.
- Use absolute owned paths and argument arrays; never interpolate detected paths into shell source.
- Treat host configuration as user data: snapshot, preserve permissions, avoid symlink traversal,
  perform atomic writes, and roll back on failure.
- Default write-capable MCP tools to host approval when the host supports that distinction.
- Do not expose direct database access through connectors or native integrations.
- Do not add telemetry. Verification and success metrics are established through automated and
  observed acceptance tests.

---

## Edge Cases

| Condition                          | Required behavior                                                           |
| ---------------------------------- | --------------------------------------------------------------------------- |
| No supported agent installed       | Finish runtime setup successfully and show how to connect later             |
| Only one supported agent installed | Select it and preserve the one-action path                                  |
| Several supported agents installed | Select all; allow review before confirmation                                |
| Agent running during configuration | Configure safely and report that a new session is required                  |
| Host config is missing             | Create only the minimum owned structure with private permissions            |
| Recognized stale Pimpampum entry   | Reconcile automatically within the approved operation                       |
| Unknown `pimpampum` entry          | Stop and request an explicit conflict decision                              |
| Read-only or managed host config   | Preserve it and show actionable admin/manual guidance                       |
| Connector verification timeout     | Stop the probe, keep diagnostics bounded, and offer retry                   |
| Daemon port occupied               | Do not connect agents; identify conflict without killing unknown processes  |
| Existing npm daemon                | Migrate transactionally without a second daemon or data copy                |
| Existing healthy manual connector  | Adopt only when its identity is provably equivalent; otherwise ask          |
| Login Item requires approval       | Open native settings and resume verification afterward                      |
| App closes during setup            | Resume from durable phase state on next open                                |
| Quickshell restarts                | systemd service and completed connections remain active                     |
| Agent is removed later             | Show Not installed; do not mutate its remaining user configuration silently |
| Runtime update changes path        | Reconcile owned connectors atomically during update                         |
| Uninstall partially fails          | Roll back owned removals and preserve all user data                         |
| Data directory already exists      | Reuse it without resetting token or canonical store                         |

---

## Performance and Reliability

- Clean local setup should complete in under two minutes on supported reference hardware,
  excluding explicit operating-system approval time.
- Agent detection should present initial results within two seconds.
- Connection verification should complete within ten seconds per healthy local connector.
- Setup and migration must use bounded retries and never create a tight restart or polling loop.
- Multiple concurrent setup attempts must serialize through the existing installation lifecycle
  lock.
- The daemon must remain available after the app quits, Quickshell restarts, or every MCP host
  disconnects.

---

## Accessibility and Content

- Preserve keyboard navigation, default/cancel actions, visible focus, VoiceOver labels, reduced
  motion behavior, native control sizing, and light/dark appearance.
- Do not use transport or runtime jargon in primary copy.
- Every error names what failed, whether prior state is still working, and the next safe action.
- Progress must not rely on color alone.
- Status copy uses the same vocabulary on macOS and Omarchy.

---

## Success Metrics

| Metric                                                 | Target          | How to Measure                           |
| ------------------------------------------------------ | --------------- | ---------------------------------------- |
| Download-to-verified-agent time                        | Under 2 minutes | Clean-machine observed acceptance run    |
| Terminal commands in normal setup                      | 0               | macOS and Omarchy E2E acceptance tests   |
| External Node/npm requirement                          | 0               | Clean target without Node/npm            |
| Pimpampum confirmations in default path                | 1               | Interaction trace; OS prompts excluded   |
| Supported agents connected when selected               | 100%            | Codex and Claude Code connector matrices |
| Successful setup with no supported agents              | 100%            | Empty-detection acceptance test          |
| Failed setup preserving prior working state            | 100%            | Fault-injection and rollback tests       |
| Existing user data preserved through migration/removal | 100%            | Filesystem and database E2E assertions   |
| Unknown host configuration overwritten without consent | 0               | Hostile-config acceptance suite          |
| Tokens present in UI/config/args/logs/clipboard        | 0               | Secret-leak assertions                   |
| Duplicate daemon instances after repeated setup/update | 0               | Idempotency and concurrency tests        |

No production telemetry is collected to calculate these metrics.

---

## Technical Considerations

### Architecture

- `PimpampumStore` remains the only owner of domain invariants and transactions.
- HTTP, MCP, CLI, Swift, QML, and connectors must not duplicate domain rules.
- Streamable HTTP MCP remains part of the daemon.
- The `stdio` bridge remains an ephemeral host-owned process and a local credential broker for
  hosts that should not receive the bearer token directly.
- The app and widget manage installation and present status; the OS service manager owns daemon
  availability.

### Runtime packaging discovery

Implementation planning must compare at least:

1. A signed/versioned embedded Node runtime plus bundled application and native addon.
2. A Node single-executable application plus a safe strategy for `better-sqlite3`.
3. Any alternative self-contained runtime only if it preserves compatibility and does not fork
   the domain implementation.

The decision must be based on startup time, artifact size, Apple signing/notarization, Linux target
compatibility, native-addon loading, update atomicity, and rollback—not on hiding a process name.

### Host research

Before implementation, verify the current supported configuration, approval, reload, and removal
mechanisms for Codex and Claude Code from their primary documentation and installed client behavior.
The PRD intentionally specifies connector outcomes rather than freezing undocumented file formats.

---

## Existing Product Alignment

### Reused macOS patterns

- `SetupOnboardingView` Quiet hierarchy and button styles.
- `StatusPopover` setup/normal-state switch and recovery notices.
- `AuthenticatedDaemonConfiguration` receipt and private-token boundary.
- Existing native Settings window and segmented navigation.
- Existing Login Items recovery and asynchronous store patterns.
- Current install receipts, lifecycle lock, rollback, service adapters, and update manager.

### New product components

- Packaged cross-platform runtime artifacts.
- Durable setup/migration coordinator.
- Host connector contract and Codex/Claude Code implementations.
- Agent detection and connection status model.
- macOS onboarding progress and completion states.
- macOS **Agents** Settings section.
- Omarchy **Agents** Settings card.
- Redacted connection diagnostics and manual-instructions surface.

---

## Risks

| Risk                                                | Impact | Mitigation                                                                        |
| --------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| Runtime packaging fails around `better-sqlite3`     | High   | Prototype packaging before implementation planning; retain bundled-runtime option |
| Host config formats or commands change              | High   | Isolated connectors, version detection, primary-doc research, contract tests      |
| Migration breaks a working npm installation         | High   | Snapshot, transactional service swap, health verification, full rollback          |
| App signing rejects nested runtime/helper           | High   | Include nested-code signing and notarization in the earliest packaging spike      |
| One-click setup feels opaque or untrustworthy       | Medium | Clear change summary, explicit consent, advanced planned-operation disclosure     |
| Host requires restart and appears broken            | Medium | Distinguish configured from session-available; offer Open/new-session action      |
| Direct config mutation damages user content         | High   | Prefer host commands; atomic scoped edits; unknown-collision stop; hostile tests  |
| Supporting two hosts delays the core runtime        | Medium | Shared connector contract with Codex as reference, Claude Code as required parity |
| UI lifecycle accidentally becomes service lifecycle | High   | Keep launchd/systemd ownership as an acceptance requirement                       |
| Artifact size increases materially                  | Medium | Measure release size; optimize only after functional packaging is proven          |

---

## Open Questions for Design and Planning

- Which single primary action should completion expose when both Codex and Claude Code are
  connected and installed?
- Should agent selection remain inline in the compact popover or open a small secondary sheet when
  more connectors are added?
- Which packaged-runtime strategy passes the signing, native-addon, startup, and rollback spike?
- What is the supported Omarchy distribution channel for delivering the runtime without npm?

These questions do not block approval of the product outcome. The first two belong to the upcoming
mockup exercise; the latter two belong to technical research and planning.

---

## Definition of Product Approval

This PRD is approved when it correctly captures:

1. The complete no-Node/npm-visible experience rather than only an MCP config helper.
2. Codex and Claude Code as required initial connectors.
3. One explicit, transparent setup confirmation.
4. The existing macOS app as the visual and interaction baseline.
5. An independent OS-managed daemon with native surfaces as installers/controllers.
6. Safe migration, verification, conflict handling, rollback, privacy, and removal.

After approval, create low-fidelity macOS and Omarchy mockups for first run, progress, partial
failure, completion, and ongoing agent-connection management. Then perform runtime/host research and
create the implementation plan.
