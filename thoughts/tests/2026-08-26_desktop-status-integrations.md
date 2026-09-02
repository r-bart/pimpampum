# Test Manifest: Automatic Service and Desktop Status Integrations

**Date**: 2026-08-26  
**Spec**: `thoughts/specs/2026-08-25_desktop-status-integrations.md`  
**Status**: all passing — amended 2026-09-01 and 2026-09-02 (see the amendment notes at the end)

---

## Framework and Conventions

- TypeScript: Vitest, `describe`/`it`, `expect`, boundary fakes, top-level `test/*.test.ts`.
- HTTP: Supertest against the composed Express application.
- Persistence: real temporary SQLite databases.
- macOS: Swift Testing in `platforms/macos/Tests/PimpampumMenuBarTests/`.
- Omarchy: cross-platform manifest/QML fixture validator plus official live Quattro validation.

The four shared fixtures in `test/fixtures/overview/` are the frozen contract; the four generated
TypeScript acceptance files carry the spec-id comments that bind each test to a requirement and are
edited like any other test, together with the spec they encode. Native Swift and QML tests
supplement them but may not weaken their assertions.

---

## Traceability Matrix

Status is the observed result on 2026-09-01 (`npx vitest run`, `swift test`).

| Spec item | Executable acceptance                  | Test file                                                                                                                                                                | Status  |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| US-1/AC-1 | One explicit lifecycle command surface | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| US-1/AC-2 | Automatic user service definitions     | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| US-1/AC-3 | Restart after abnormal failure         | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| US-1/AC-4 | Idempotent install                     | `test/desktop-status.lifecycle.acceptance.test.ts`                                                                                                                       | Passing |
| US-1/AC-5 | Uninstall preserves data               | `test/desktop-status.lifecycle.acceptance.test.ts`                                                                                                                       | Passing |
| US-2/AC-1 | Compact semantic status                | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| US-2/AC-2 | Active-claim counter                   | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| US-2/AC-3 | Fresh within ten seconds               | `OverviewStoreTests.swift` (polling intervals)                                                                                                                           | Passing |
| US-2/AC-4 | Offline distinct from idle             | `OverviewStoreTests.swift` (stale/offline, cold-start grace)                                                                                                             | Passing |
| US-3/AC-1 | Project counts                         | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| US-3/AC-2 | Current work details                   | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| US-3/AC-3 | Active/available/draft ordering        | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| US-3/AC-4 | Completed collapsed                    | `StatusPopoverTests.swift`; `scripts/validate-omarchy-plugin.mjs` through `test/omarchy-plugin.test.ts`; no write verb: `test/source-contract.test.ts` (source contract) | Passing |
| US-3/AC-5 | Scroll bounded lists                   | `StatusPopoverTests.swift` (scrollable lists inside approved bounds)                                                                                                     | Passing |
| US-4/AC-1 | Finder reveal                          | `WorkspaceOpenerTests.swift`; no `/bin/sh`: `test/source-contract.test.ts` (source contract)                                                                             | Passing |
| US-4/AC-2 | Linux file reveal                      | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| US-4/AC-3 | Missing path error                     | `WorkspaceOpenerTests.swift` (missing or inaccessible directories)                                                                                                       | Passing |
| US-4/AC-4 | No shell-source execution              | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| FR-1      | Authenticated bounded overview         | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| FR-2      | Install/status/uninstall               | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| FR-3      | SwiftUI MenuBarExtra                   | `test/desktop-status.acceptance.test.ts` (`Info.plist` parse: `LSUIElement`); `LoginItemManagerTests.swift`; live smoke `noDockIcon`                                     | Passing |
| FR-4      | Quattro bar-widget                     | `test/desktop-status.acceptance.test.ts` (manifest parse); `test/omarchy-plugin.test.ts` (validator verdict and mutation cases)                                          | Passing |
| FR-5      | Read-only boundary                     | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| EC-1      | Offline                                | `OverviewStoreTests.swift`                                                                                                                                               | Passing |
| EC-2      | Invalid token                          | `OverviewClientTests.swift` (authentication vs server vs schema failures)                                                                                                | Passing |
| EC-3      | No workspaces                          | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| EC-4      | Drafts only                            | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| EC-5      | All complete                           | `test/desktop-status.acceptance.test.ts`                                                                                                                                 | Passing |
| EC-6      | Active plus available                  | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| EC-7      | Claim expiry                           | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| EC-8      | Hundreds of projects                   | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| EC-9      | Duplicate titles                       | `test/desktop-status.safety.acceptance.test.ts`                                                                                                                          | Passing |
| EC-10     | Missing directory                      | `WorkspaceOpenerTests.swift`                                                                                                                                             | Passing |
| EC-11     | Schema mismatch                        | `OverviewClientTests.swift`; `test/omarchy-plugin.test.ts` (`invalid.json`)                                                                                              | Passing |
| EC-12     | Repeated install                       | `test/desktop-status.lifecycle.acceptance.test.ts`                                                                                                                       | Passing |
| EC-13     | Partial install failure                | `test/desktop-status.lifecycle.acceptance.test.ts`                                                                                                                       | Passing |
| EC-14     | Unsafe Omarchy layout mutation         | `test/service-omarchy.test.ts` (layout snapshot and restore safety)                                                                                                      | Passing |

Swift files live in `platforms/macos/Tests/PimpampumMenuBarTests/`.

---

## Generated Test Files

| File                                               | Tests | Todos | Layer                    | Status  |
| -------------------------------------------------- | ----: | ----: | ------------------------ | ------- |
| `test/desktop-status.acceptance.test.ts`           |    10 |     0 | Cross-layer acceptance   | Passing |
| `test/desktop-status.safety.acceptance.test.ts`    |    12 |     0 | Domain/platform safety   | Passing |
| `test/desktop-status.lifecycle.acceptance.test.ts` |     5 |     0 | Service lifecycle safety | Passing |
| `test/quattro-live-evidence.acceptance.test.ts`    |    11 |     0 | Live evidence integrity  | Passing |

The Quattro file gained one case (FR-4: opt-in live runner exposed through the release command)
after the manifest was written; the manifest said 10.

---

## Coverage Summary

- Spec items enumerated: 37.
- Spec items covered by the generated TypeScript acceptance files: 26, plus the eleven Task 4.4
  evidence-integrity cases.
- Spec items covered by native suites and the plugin validator: 11, all implemented and passing
  (211 Swift tests in 30 suites on 2026-09-01; `test/omarchy-plugin.test.ts` 11/11 and
  `test/service-omarchy.test.ts` on 2026-09-02).
- Negative source checks (no shell, no token, no write verb) live in `test/source-contract.test.ts`;
  the DoD counts them as source contract, not as acceptance.
- Traceability coverage: 100%.

---

## Frozen Contract

Only the four shared fixtures are hash-pinned. They have three consumers that must read the same
bytes: `scripts/validate-omarchy-plugin.mjs`, the Swift tests through `OverviewTestSupport.swift`,
and the TypeScript acceptance tests. `npm run check:desktop-contract` verifies them in
`quality.yml` and `release.yml`.

| Frozen artifact                        | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `test/fixtures/overview/complete.json` | `a622e45665a33646afb10eeeea78b3f8ec7248cad176163d1c7f47870520ec5f` |
| `test/fixtures/overview/empty.json`    | `bbf834d7bd82369eb53ccebc3f90c0237342ebd2ab1f579a2047d25e343366eb` |
| `test/fixtures/overview/invalid.json`  | `1dfd2aa7a4db5cffcdd9f07a8df477f6b7c35345eff4b8d94beef25850b6e00f` |
| `test/fixtures/overview/mixed.json`    | `27fb33e9d3113c073d8e08aaa17b96d789d873d555630dfbcf6cfa99d3571453` |

If a fixture must change, amend the spec first, then refresh the digest in
`scripts/check-desktop-status-contract.mjs` and this table in the same commit.

---

## Amendment 2026-09-01

Source: `thoughts/reviews/2026-09-01_deep-review.md`, finding H-14, and Task 0.1 of
`thoughts/plans/2026-09-01_deep-review-remediation.md`.

- The four acceptance test files are no longer frozen. Every one of the eight commits that touched
  `scripts/check-desktop-status-contract.mjs` re-pinned them, and seven of the eight hashes this
  manifest recorded no longer matched the script. The freeze recorded snapshots, not a
  specification.
- The hash pins stay on the four overview fixtures only, for the three-consumer reason above.
- The `@immutable` headers on the acceptance files were removed on 2026-09-02 (Task 8.2). Their
  `@generated-from` spec references and per-test spec-id titles remain the contract: a test changes
  only together with the spec item it names.
- The "Initial status" column was replaced by the observed status; "Planned" native rows now name
  the Swift and Omarchy tests that implement them.

---

## Required Supplemental Suites

- Pure overview status/ordering unit tests.
- SQLite aggregation, expiry, bounds, and performance tests.
- LaunchAgent/systemd adapter and rollback tests.
- Swift model, client, polling, stale-state, login-item, and opener tests.
- Omarchy fixture/static validator tests.
- Live macOS service/app smoke.
- Live Omarchy Quattro plugin smoke.

---

## Amendment 2026-09-02

Source: `thoughts/reviews/2026-09-01_deep-review.md`, finding H-13, and Tasks 8.1 and 8.2 of
`thoughts/plans/2026-09-01_deep-review-remediation.md`.

- `test/desktop-status.acceptance.test.ts` no longer reads Swift, QML or README text. FR-2 renders
  the LaunchAgent and the systemd unit through `src/service/launchd.ts` and `src/service/systemd.ts`
  and asserts on the parsed `KeepAlive`, `RunAtLoad`, `Restart=`, `WantedBy=` and environment.
  FR-3 parses `platforms/macos/Resources/Info.plist`; FR-4 parses the plugin manifest.
- Removed 2026-09-02, no behaviour: the `MenuBarExtra`/`SMAppService` greps (FR-3), the
  `Completed`/`Cancelled`/SF Symbol greps (US-3/AC-4), the `NSWorkspace`/`xdg-open` greps
  (US-4/AC-1), the `requestPopout` grep (FR-4) and the README wording test (FR-2 documentation).
  The rows above now name the Swift suites and the validator that observe those behaviours.
- `test/omarchy-plugin.test.ts` keeps its behaviour cases (validator verdict, fixture drift,
  install/uninstall wrappers, bounded workspace route) and adds validator mutation cases; its
  QML layout, copy and symbol greps were removed. Layout assertions were not moved to a `qml6`
  harness because no `qml6` is available on the review machine.
- The negative security checks moved to `test/source-contract.test.ts`; the matrix marks them
  "source contract".
