# Swift Coverage Boundary

Recorded on 2026-08-26 for the native macOS menu bar application.

## Enforced core

`scripts/check-swift-coverage.sh` runs the Swift test suite with instrumentation and requires exactly 100% region, function, and line coverage for:

- `Models.swift`: overview contract types and derived values.
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

The current result is 552/552 regions, 141/141 functions, and 1009/1009 lines. The suite executes 78 tests across thirteen suites.

Any deterministic behavior added to the macOS application must live in one of these files or be added explicitly to the coverage manifest in the gate script.

## Reviewed exclusions

- `App.swift`: SwiftUI application scene and `NSApplicationDelegate` lifecycle wiring only.
- `StatusPopover.swift`: declarative SwiftUI view composition only; all extracted presentation decisions are enforced through `StatusPresentation.swift`.
- `BackupSettingsView.swift`: declarative SwiftUI composition only. Native tests compose every health-state branch and exercise its injected store, picker, and opener boundaries; deterministic client and state behavior remains in the covered core.
- `BackupDirectoryPicker.swift`: thin `NSOpenPanel`, `FileManager`, and `NSWorkspace` adapters. Its injected selection, path validation, standardization, availability, and open outcomes are exercised by native tests.
- `ApplicationConfigurationSystemAdapter.swift`: one `Data(contentsOf:)` call.
- `LoginItemSystemAdapters.swift`: thin `SMAppService`, private atomic-file, and System Settings adapters.
- `WorkspaceSystemAdapters.swift`: thin `FileManager` and `NSWorkspace` adapters.
- `SettingsWindowSystemAdapter.swift`: thin `NSApplication` selector and activation adapter; selector ordering and fallback behavior live in the covered `SettingsWindowOpener.swift` boundary.
- `OverviewSystemAdapters.swift`: thin `Data(contentsOf:)`, `URLSession`, and wall-clock/sleep adapters. The non-HTTP transport failure is exercised with an ephemeral URL protocol.
- `DesktopSmokeHarness.swift`: live-only AppKit/SwiftUI rendering, system accessibility traversal and activation, Finder opening, and atomic evidence file I/O. Its deterministic request, decoding, selection, labeling, and snapshot behavior lives in the covered `DesktopSmokeLogic.swift` boundary.

These exclusions contain platform calls or declarative view bodies, not business rules. They remain compiled and exercised by the complete Swift test run before the coverage report is evaluated.
