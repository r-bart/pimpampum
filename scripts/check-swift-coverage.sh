#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="$repo_root/platforms/macos"

swift test --package-path "$package_root" --enable-code-coverage

coverage_json="$(swift test --package-path "$package_root" --show-codecov-path)"
profile="$(dirname "$coverage_json")/default.profdata"
debug_directory="$(dirname "$(dirname "$coverage_json")")"
test_binary="$debug_directory/PimpampumMenuBarPackageTests.xctest/Contents/MacOS/PimpampumMenuBarPackageTests"

if [[ ! -f "$profile" || ! -x "$test_binary" ]]; then
    echo "Swift coverage artifacts were not produced at the expected SwiftPM paths." >&2
    exit 1
fi

# This explicit manifest is the review boundary: deterministic models, parsing,
# validation, state derivation, and polling must remain completely covered.
# Any new non-UI logic belongs here. Excluded system/UI adapters are documented
# in thoughts/notes/2026-08-26_swift-coverage.md.
#
# 2026-09-01: this gate reported 100% while every first-run defect of that session sat in files it
# never measured. The whole guided-setup lifecycle is inside it now: models, store, session, command
# runner, bootstrap, launch coordination, location record and every screen decision. The SwiftUI
# bodies and the live NSWorkspace/NSApplication adapters stay out; see
# thoughts/notes/2026-08-26_swift-coverage.md for each exclusion.
covered_sources=(
    "$package_root/Sources/PimpampumMenuBar/Models.swift"
    "$package_root/Sources/PimpampumMenuBar/SetupModels.swift"
    "$package_root/Sources/PimpampumMenuBar/SetupStore.swift"
    "$package_root/Sources/PimpampumMenuBar/SetupSession.swift"
    "$package_root/Sources/PimpampumMenuBar/SetupOnboardingPresentation.swift"
    "$package_root/Sources/PimpampumMenuBar/SetupCommandRunner.swift"
    "$package_root/Sources/PimpampumMenuBar/EmbeddedSetupBootstrap.swift"
    "$package_root/Sources/PimpampumMenuBar/ApplicationLocationRecord.swift"
    "$package_root/Sources/PimpampumMenuBar/WorkspaceRegistration.swift"
    "$package_root/Sources/PimpampumMenuBar/ApplicationLaunchCoordinator.swift"
    "$package_root/Sources/PimpampumMenuBar/OverviewClient.swift"
    "$package_root/Sources/PimpampumMenuBar/DaemonClient.swift"
    "$package_root/Sources/PimpampumMenuBar/DirectoryOpener.swift"
    "$package_root/Sources/PimpampumMenuBar/AuthenticatedDaemonConfiguration.swift"
    "$package_root/Sources/PimpampumMenuBar/OverviewStore.swift"
    "$package_root/Sources/PimpampumMenuBar/ApplicationConfiguration.swift"
    "$package_root/Sources/PimpampumMenuBar/LoginItemManager.swift"
    "$package_root/Sources/PimpampumMenuBar/WorkspaceOpener.swift"
    "$package_root/Sources/PimpampumMenuBar/SettingsWindowOpener.swift"
    "$package_root/Sources/PimpampumMenuBar/StatusPresentation.swift"
    "$package_root/Sources/PimpampumMenuBar/DesktopSmokeLogic.swift"
    "$package_root/Sources/PimpampumMenuBar/BackupSettingsModels.swift"
    "$package_root/Sources/PimpampumMenuBar/BackupSettingsClient.swift"
    "$package_root/Sources/PimpampumMenuBar/BackupSettingsStore.swift"
    "$package_root/Sources/PimpampumMenuBar/UpdateSettingsStore.swift"
    "$package_root/Sources/PimpampumMenuBar/SyncSettingsModels.swift"
    "$package_root/Sources/PimpampumMenuBar/SyncSettingsClient.swift"
    "$package_root/Sources/PimpampumMenuBar/SyncSettingsStore.swift"
    "$package_root/Sources/PimpampumMenuBar/StateVocabulary.swift"
)

report="$(
    xcrun llvm-cov report \
        "$test_binary" \
        -instr-profile="$profile" \
        "${covered_sources[@]}"
)"
printf '%s\n' "$report"

summary="$(printf '%s\n' "$report" | awk '$1 == "TOTAL" { print $4, $7, $10 }')"
if [[ "$summary" != "100.00% 100.00% 100.00%" ]]; then
    echo "Swift core coverage must be 100% for regions, functions, and lines; got: $summary" >&2
    exit 1
fi

echo "Swift core coverage gate passed: 100% regions, functions, and lines."
