# Swift Coverage Boundary

Recorded on 2026-08-26 for the native macOS menu bar application. Updated on 2026-08-30,
when `SyncSettings.swift` was split so its deterministic half could join the enforced core, and on
2026-09-01, when the whole guided-setup lifecycle joined it after the deep review found every
first-run defect in files the gate never measured (review section 8, findings X-01 to X-09). Updated
again on 2026-09-02, when `WorkspaceRegistration.swift` joined with the workspace action (D-01).

## Enforced core

`scripts/check-swift-coverage.sh` runs the Swift test suite with instrumentation and requires exactly 100% region, function, and line coverage for:

- `Models.swift`: overview contract types and derived values.
- `SetupModels.swift`: the setup wire vocabulary, component states and their attention rule.
- `SetupStore.swift`: agent detection, planning that waits for the launch task, the confirmation
  rule (`canConfirm`), apply, focused retry, conflict decisions, `reset`, journal rehydration that
  follows a `running` journal by polling `setup status` and only takes it over once it stalls,
  progress and result mapping, redaction, and the unavailable-runtime fallback.
- `SetupSession.swift`: the app-owned setup session: the current step, `isActive`, the pause of
  overview polling for the duration of a mutation, `reviewAndSetUp`, `startOver`, and `finish`
  with the login-item guard for a copy running outside its recorded location.
- `SetupOnboardingPresentation.swift`: every decision the guided-setup screens make: step titles,
  the plan row (link, failure with retry, or pending), when the final step takes over, which rows
  and buttons appear, and the agent application lookup.
- `SetupCommandRunner.swift`: the argument-array CLI invocations, the bounded NDJSON decoder and
  its validation, the failure envelope, the streaming process runner with both pipes drained
  concurrently, the stream and line caps, the watchdog, and the whitelisted child environment.
- `EmbeddedSetupBootstrap.swift`: setup invocations, the installed-application lookup through the
  CLI's `application-path.json` record with the CLI's own inference as fallback, the relaunch
  decision, and the relaunch request that names the predecessor pid.
- `ApplicationLocationRecord.swift`: the reader of `application-path.json` (schema 1 and 2,
  strict types, absolute NUL-free path, size cap), the managed-location constant, and canonical
  bundle paths.
- `ApplicationLaunchCoordinator.swift`: the launch sequence (helper roles, the bounded wait for a
  relauncher that promised to exit) and the single-instance rule, which stands down only for an
  older, still-running copy of the same bundle path.
- `WorkspaceRegistration.swift`: the `workspace:add` request built from a chosen folder (slug
  derivation with diacritic folding, the 80- and 120-character bounds, rejected folders), the
  decoder of the CLI's indented envelope, the registration state machine, and every word of the
  action's copy (`WorkspaceRegistrationCopy`).
- `OverviewClient.swift`: receipt/token parsing, loopback validation, HTTP response semantics, decoding, and payload validation.
- `AuthenticatedDaemonConfiguration.swift`: the single receipt, loopback URL, and token-validation authority shared by every native daemon client.
- `OverviewStore.swift`: grouping, ordering, stale state, claim expiry, polling intervals, refreshes, and cancellation semantics.
- `ApplicationConfiguration.swift`: environment/resource precedence and safe local paths.
- `LoginItemManager.swift`: request validation, registration/unregistration coordination, acknowledgement semantics, and compensation metadata.
- `WorkspaceOpener.swift`: path validation, standardization, availability checks, and open outcomes.
- `StatusPresentation.swift`: status precedence, counts, bounded formatting, symbols, colors, and accessibility values.
- `DesktopSmokeLogic.swift`: smoke request parsing, seeded overview decoding, exact project selection, connection labels, deterministic snapshots, and hashes.
- `BackupSettingsModels.swift`: strict backup state vocabulary and presentation metadata.
- `BackupSettingsClient.swift`: authenticated requests, exact response decoding, semantic validation, redaction, and bounded errors.
- `BackupSettingsStore.swift`: operation serialization, state publication, cancellation, and stable failure messages.
- `UpdateSettingsStore.swift`: receipt trust, executable-path validation, operation selection, per-operation deadlines, CLI failure-envelope propagation, relaunch derivation, and every panel copy decision.
- `SyncSettingsModels.swift`: the synchronization state vocabulary, every failure description, the `blockedSnapshot` record and its one-line copy (`SyncSettingsPresentation`).
- `SyncSettingsClient.swift`: authenticated requests, strict envelope decoding, timestamp parsing, semantic validation, token redaction, and bounded server messages.
- `SyncSettingsStore.swift`: operation serialization, state publication, cancellation, and stable failure messages.

The current result is 1630/1630 regions, 546/546 functions, and 3381/3381 lines. The suite
executes 314 tests across 43 suites.

Any deterministic behavior added to the macOS application must live in one of these files or be added explicitly to the coverage manifest in the gate script.

## Reviewed exclusions

- `App.swift`: SwiftUI application scene, store ownership, and the `NSApplicationDelegate` that
  hands its arguments to the covered `ApplicationLaunchCoordinator`; the only logic left here is
  the list of live `NSRunningApplication`, `DesktopSmokeHarness` and `LoginRegistrationCoordinator`
  calls the coordinator is given.
- `EmbeddedSetupSystemAdapters.swift`: the live `NSWorkspace.openApplication`,
  `NSApplication.terminate` and running-application lookup behind the relaunch, plus the
  main-bundle bootstrap reference. Executing them would end the test runner.
- `StatusPopover.swift`: declarative SwiftUI view composition only; all extracted presentation decisions are enforced through `StatusPresentation.swift`, including which body the popover renders (`content`), when the help button is hidden, and when the footer shows Settings.
- `SetupOnboardingView.swift`: declarative SwiftUI composition of the four steps plus the step
  vocabulary and copy (`SetupOnboardingStep`, `SetupOnboardingCopy`, pinned by
  `SetupOnboardingCopyTests` and the TypeScript acceptance tests). Every branch it renders is decided
  in `SetupOnboardingPresentation.swift`; the step and the store belong to `SetupSession`.
- `HelpDialog.swift` and `SetupChangesHelp.swift`: declarative dialogs with frozen copy; native
  tests compose them and `HelpDialogTests` pins the dialog to the popover width.
- `BackupSettingsView.swift`: declarative SwiftUI composition only. Native tests compose every health-state branch and exercise its injected store, picker, and opener boundaries; deterministic client and state behavior remains in the covered core.
- `UpdateSettingsView.swift`: declarative SwiftUI composition only. Every copy, version line, relaunch notice, and button state comes from the covered `UpdateSettingsPresentation` in `UpdateSettingsStore.swift`; a native test composes its body.
- `UpdateSettingsSystemAdapter.swift`: one `Process` adapter. It returns the exit code and both streams unchanged so the covered store, not this file, decides what the user reads, and it enforces the deadline the covered `UpdateOperation` declares. `UpdateCommandRunnerTests` drives it with real processes, including one that floods a stream and one that outlives its deadline.
- `SyncSettings.swift`: declarative SwiftUI composition and the `NSWindow` controller only. Its models, client, and store were extracted on 2026-08-30 into the three covered files above; `SyncSettingsView.recoveryGuidance` remains under test.
- `WorkspaceFolderPicker.swift`: the `NSOpenPanel` adapter behind **Add a workspace**. It returns
  the chosen URL unchanged; the covered `WorkspaceRegistration.swift` decides whether that folder
  can become a workspace.
- `BackupDirectoryPicker.swift`: thin `NSOpenPanel`, `FileManager`, and `NSWorkspace` adapters. Its injected selection, path validation, standardization, availability, and open outcomes are exercised by native tests.
- `ApplicationConfigurationSystemAdapter.swift`: one `Data(contentsOf:)` call.
- `LoginItemSystemAdapters.swift`: thin `SMAppService`, private atomic-file, and System Settings adapters.
- `WorkspaceSystemAdapters.swift`: thin `FileManager` and `NSWorkspace` adapters.
- `SettingsWindowSystemAdapter.swift`: thin `NSApplication` selector and activation adapter; selector ordering and fallback behavior live in the covered `SettingsWindowOpener.swift` boundary.
- `OverviewSystemAdapters.swift`: thin `Data(contentsOf:)`, `URLSession`, and wall-clock/sleep adapters. The non-HTTP transport failure is exercised with an ephemeral URL protocol.
- `DesktopSmokeHarness.swift`: live-only AppKit/SwiftUI rendering, system accessibility traversal and activation, Finder opening, and atomic evidence file I/O. Its deterministic request, decoding, selection, labeling, and snapshot behavior lives in the covered `DesktopSmokeLogic.swift` boundary.

These exclusions contain platform calls or declarative view bodies, not business rules. They remain compiled and exercised by the complete Swift test run before the coverage report is evaluated.
