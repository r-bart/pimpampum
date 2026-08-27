# Test Manifest: Automatic Service and Desktop Status Integrations

**Date**: 2026-08-26  
**Spec**: `thoughts/specs/2026-08-25_desktop-status-integrations.md`  
**Status**: frozen before implementation

---

## Framework and Conventions

- TypeScript: Vitest, `describe`/`it`, `expect`, boundary fakes, top-level `test/*.test.ts`.
- HTTP: Supertest against the composed Express application.
- Persistence: real temporary SQLite databases.
- macOS: Swift XCTest added during implementation.
- Omarchy: cross-platform manifest/QML fixture validator plus official live Quattro validation.

The four generated TypeScript acceptance files and four shared fixtures are immutable. Native Swift and QML tests added during implementation supplement them but may not weaken their assertions. The fourth acceptance file was frozen when the completion audit converted the previously human-authored Task 4.4 evidence into an executable schema-v2 contract.

---

## Traceability Matrix

| Spec item | Executable acceptance                  | File/test                                         | Initial status |
| --------- | -------------------------------------- | ------------------------------------------------- | -------------- |
| US-1/AC-1 | One explicit lifecycle command surface | CLI overview/lifecycle tests                      | Failing        |
| US-1/AC-2 | Automatic user service definitions     | LaunchAgent/systemd render tests                  | Failing        |
| US-1/AC-3 | Restart after abnormal failure         | Strict LaunchAgent/systemd renderer assertions    | Failing        |
| US-1/AC-4 | Idempotent install                     | Frozen lifecycle manager reconciliation test      | Failing        |
| US-1/AC-5 | Uninstall preserves data               | Frozen receipt-owned uninstall boundary           | Failing        |
| US-2/AC-1 | Compact semantic status                | Overview empty/complete/active tests              | Failing        |
| US-2/AC-2 | Active-claim counter                   | Active overview + native artifact tests           | Failing        |
| US-2/AC-3 | Fresh within ten seconds               | Native polling tests to add                       | Planned        |
| US-2/AC-4 | Offline distinct from idle             | Native stale/offline tests to add                 | Planned        |
| US-3/AC-1 | Project counts                         | Active overview test                              | Failing        |
| US-3/AC-2 | Current work details                   | Active overview test                              | Failing        |
| US-3/AC-3 | Active/available/draft ordering        | Frozen precedence/recency/stable-id test          | Failing        |
| US-3/AC-4 | Completed collapsed                    | Swift/QML artifact assertions                     | Failing        |
| US-3/AC-5 | Scroll bounded lists                   | Native view tests/review to add                   | Planned        |
| US-4/AC-1 | Finder reveal                          | Swift opener artifact assertion                   | Failing        |
| US-4/AC-2 | Linux file reveal                      | QML opener assertion                              | Failing        |
| US-4/AC-3 | Missing path error                     | Native opener tests to add                        | Planned        |
| US-4/AC-4 | No shell-source execution              | Strict separate-argument and shell-negative tests | Failing        |
| FR-1      | Authenticated bounded overview         | HTTP acceptance suite                             | Failing        |
| FR-2      | Install/status/uninstall               | CLI + service render suite                        | Failing        |
| FR-3      | SwiftUI MenuBarExtra                   | macOS artifact suite                              | Failing        |
| FR-4      | Quattro bar-widget                     | Omarchy artifact suite                            | Failing        |
| FR-5      | Read-only boundary                     | Swift/QML negative assertions                     | Failing        |
| EC-1      | Offline                                | Native tests to add                               | Planned        |
| EC-2      | Invalid token                          | HTTP/native tests to add                          | Planned        |
| EC-3      | No workspaces                          | HTTP empty overview                               | Failing        |
| EC-4      | Drafts only                            | Frozen full status-precedence test                | Failing        |
| EC-5      | All complete                           | HTTP complete overview                            | Failing        |
| EC-6      | Active plus available                  | Frozen store/listWork agreement test              | Failing        |
| EC-7      | Claim expiry                           | Frozen expired-claim exclusion test               | Failing        |
| EC-8      | Hundreds of projects                   | Frozen 501-project truncation test                | Failing        |
| EC-9      | Duplicate titles                       | Frozen stable-id ordering test                    | Failing        |
| EC-10     | Missing directory                      | Native opener tests to add                        | Planned        |
| EC-11     | Schema mismatch                        | Swift/QML fixture tests to add                    | Planned        |
| EC-12     | Repeated install                       | Frozen repeat-reconciliation test                 | Failing        |
| EC-13     | Partial install failure                | Frozen receipt-write rollback test                | Failing        |
| EC-14     | Unsafe Omarchy layout mutation         | Plugin installer tests to add                     | Planned        |

---

## Generated Test Files

| File                                               | Executable tests | Todos | Layer                    |
| -------------------------------------------------- | ---------------: | ----: | ------------------------ |
| `test/desktop-status.acceptance.test.ts`           |               14 |     0 | Cross-layer acceptance   |
| `test/desktop-status.safety.acceptance.test.ts`    |               12 |     0 | Domain/platform safety   |
| `test/desktop-status.lifecycle.acceptance.test.ts` |                5 |     0 | Service lifecycle safety |
| `test/quattro-live-evidence.acceptance.test.ts`    |               10 |     0 | Live evidence integrity  |

---

## Coverage Summary

- Spec items enumerated: 37.
- Spec items with immediate generated executable coverage: 28 plus the ten Task 4.4 evidence-integrity cases.
- Spec items assigned to native/platform suites in the approved plan: 9.
- Acceptance file compiles before implementation and fails only because required behavior/artifacts do not exist.
- Traceability coverage: 100%.

---

## Immutability

These files must not be edited during plan execution. The recorded SHA-256 values are checked after every phase:

| Frozen artifact                                    | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `test/desktop-status.acceptance.test.ts`           | `8a9ee548f504bd9c9f7857716efd7a6b734a8fe08b5e081bd8a30577457a0f14` |
| `test/desktop-status.safety.acceptance.test.ts`    | `1e1f711b2e38a07f731a880affb15d537eb7047598eaa9a7bee9f550a57644c7` |
| `test/desktop-status.lifecycle.acceptance.test.ts` | `3fd3289e06b2651d9d0902a026900657c461db0ba780e6d566e21be5a785564d` |
| `test/quattro-live-evidence.acceptance.test.ts`    | `a96d8aa9b12a3d69cca2dce6135f8f7bee08900603bad5f60f421c7952dfb125` |
| `test/fixtures/overview/complete.json`             | `559fd9930739dc13858312d7e63f2b0b8bd408337ef738db582a2aee3a03c188` |
| `test/fixtures/overview/empty.json`                | `0fe194508bc2249166acb088330491a0c9984308fb204e783883afbd1ef9e9e7` |
| `test/fixtures/overview/invalid.json`              | `87641df18c8f1bf5547ced2b9e78a03a9b11ba36165d8a759bb89fb4f3e0e438` |
| `test/fixtures/overview/mixed.json`                | `67600a36f2a12be056a4109d677d7a9c042988cc814a9bc28f048b6a21b413eb` |

If a frozen contract is incorrect, update the approved specification and regenerate it before continuing.

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

## Next Step

Execute `thoughts/plans/2026-08-25_desktop-status-integrations.md` without modifying any frozen artifact.
