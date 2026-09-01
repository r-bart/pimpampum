# Test Manifest: Zero-friction Local Agent Setup

**Date**: 2026-08-31  
**Spec**: `thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md`  
**Plan**: `thoughts/plans/2026-08-31_zero-friction-local-agent-setup.md`  
**Status**: all passing (48 executable, 5 live-only todos, 6 Swift) — amended 2026-09-01 (see the amendment note at the end)

---

## Framework and Conventions

- TypeScript: Vitest, `describe`/`it`, `expect`, dynamic imports for not-yet-created modules,
  boundary fakes, isolated temporary homes, and top-level `test/*.test.ts` files.
- CLI: existing `runCli` composition with injected runtime boundaries and JSON envelope assertions.
- macOS: Swift Testing with source-contract assertions that compile before the new Swift types exist.
- Omarchy: Vitest artifact contracts over the pinned manifest, bounded helpers, and QML surface.
- Live-only gates: `it.todo()` is used only where signing/notarization or native target hardware is
  required. The intended command and outcome remain frozen here.

Generated tests assert externally meaningful outcomes. At generation time they did not import
missing TypeScript modules statically, so `npm run typecheck` stayed green while the product did not
exist. Every executable case now passes; the five `todo` cases remain live-only release gates.

### Spec ID scheme

- `US-N/AC-M`: the 18 explicit user-story acceptance criteria.
- `FR-N.M`: each bullet in the nine Functional Requirements sections (45 items).
- `SEC-N`: each Security & Privacy requirement (12 items).
- `EC-N`: each Edge Case table row, in source order (18 items).
- `PERF-N`: each Performance and Reliability requirement (6 items).
- `A11Y-N`: each Accessibility and Content requirement (5 items).

---

## Traceability Matrix

File aliases used below are expanded in **Generated Test Files**. Status is the observed result on
2026-09-01 (`npx vitest run test/zero-friction-*.test.ts` and
`swift test --filter ZeroFrictionSetupAcceptanceTests`). "Passing + live todo" means the executable
part passes and a sibling `it.todo` records the live-only gate.

### User stories

| Spec item | Description                                           | File       | Test contract                            | Status  |
| --------- | ----------------------------------------------------- | ---------- | ---------------------------------------- | ------- |
| US-1/AC-1 | No Terminal or external runtime on macOS              | runtime/UI | Private paths and Guided copy            | Passing |
| US-1/AC-2 | Detect Codex and Claude Code                          | connectors | Registry and bounded detection           | Passing |
| US-1/AC-3 | Select supported detected agents by default           | connectors | Registry plan and native selection       | Passing |
| US-1/AC-4 | One confirmation installs and connects selection      | setup      | Selected one-confirmation apply          | Passing |
| US-1/AC-5 | OS approval only when required                        | setup      | Login Item recovery result               | Passing |
| US-2/AC-1 | Verify runtime and connectors independently           | setup/MCP  | Per-component result and MCP verifier    | Passing |
| US-2/AC-2 | Partial success remains visible and recoverable       | setup/UI   | Focused connector retry and Agents card  | Passing |
| US-2/AC-3 | Success requires initialize and bounded tool catalog  | MCP        | Identity, initialize, and required tools | Passing |
| US-2/AC-4 | Distinguish configured from current-session available | macOS      | Durable progress and completion model    | Passing |
| US-3/AC-1 | Preserve all existing user state                      | lifecycle  | Byte-preserving npm migration            | Passing |
| US-3/AC-2 | Never run two daemons on one data directory           | lifecycle  | Stop-before-activate ordering            | Passing |
| US-3/AC-3 | Reconcile recognized entries idempotently             | connectors | Owned current/stale classification       | Passing |
| US-3/AC-4 | Never overwrite unknown collisions automatically      | setup      | Separate conflict decision               | Passing |
| US-3/AC-5 | Restore prior runtime and connector state on failure  | lifecycle  | Migration and runtime rollback           | Passing |
| US-4/AC-1 | Disconnect only recognized owned entries              | connectors | Receipt-proven disconnect                | Passing |
| US-4/AC-2 | Disconnect preserves daemon and data                  | lifecycle  | Connector-aware removal boundary         | Passing |
| US-4/AC-3 | Missing client does not install third-party software  | connectors | Neutral missing/unsupported plans        | Passing |
| US-4/AC-4 | Advanced manual instructions are redacted             | CLI/MCP    | Redacted instructions and diagnostics    | Passing |

### Functional requirements

| Spec item | Description                                          | File                 | Test contract                              | Status              |
| --------- | ---------------------------------------------------- | -------------------- | ------------------------------------------ | ------------------- |
| FR-1.1    | Both distributions include compatible runtime        | runtime/surfaces     | Manifest and embedded/pinned assets        | Passing             |
| FR-1.2    | CLI, serve, MCP need no external Node/npm            | runtime              | Private paths and empty-PATH target smoke  | Passing + live todo |
| FR-1.3    | OS-managed daemon independent from UI                | runtime/surfaces     | Launchd/systemd ownership                  | Passing             |
| FR-1.4    | Runtime update is versioned and atomic               | runtime/lifecycle    | Activation, rollback, and update           | Passing             |
| FR-2.1    | Connector detects host and supported version         | connectors           | Registry and bounded detection             | Passing             |
| FR-2.2    | Inspect target entry without unrelated config        | connectors/security  | Bounded probe and scoped config access     | Passing             |
| FR-2.3    | Plan and describe exact owned mutation               | connectors/setup     | Tokenless host plans and review plan       | Passing             |
| FR-2.4    | Connect idempotently                                 | connectors           | Owned-current classification               | Passing             |
| FR-2.5    | Verify startup and MCP initialization                | MCP                  | Installed-route verification               | Passing             |
| FR-2.6    | Report new-session requirement                       | connectors/macOS     | Plan/result availability distinction       | Passing             |
| FR-2.7    | Repair recognized stale configuration                | connectors           | Owned-stale classification                 | Passing             |
| FR-2.8    | Disconnect only recognized configuration             | connectors           | Receipt-proven removal plan                | Passing             |
| FR-2.9    | Snapshot/restore and redact diagnostics              | lifecycle/MCP        | Rollback and redaction                     | Passing             |
| FR-2.10   | Common domain-neutral connector contract             | connectors/surfaces  | Registry parity and UI boundary            | Passing             |
| FR-3.1    | Detection is local and does not launch agent         | connectors           | Version-only executable probe              | Passing             |
| FR-3.2    | Supported detected agents selected by default        | connectors/macOS     | Selection metadata                         | Passing             |
| FR-3.3    | User can inspect and deselect before consent         | setup/macOS          | Planned changes and selected-only apply    | Passing             |
| FR-3.4    | Unsupported versions unselected with guidance        | connectors           | Unsupported plan                           | Passing             |
| FR-3.5    | Absence is neutral                                   | connectors/setup     | Missing host and no-agent completion       | Passing             |
| FR-3.6    | Detection avoids broad home traversal                | connectors           | Bounded locations and sanitized PATH       | Passing             |
| FR-4.1    | Review service/login/connector changes first         | setup/macOS          | Non-mutating setup plan                    | Passing             |
| FR-4.2    | One confirmation authorizes listed changes only      | setup/CLI            | Confirmed selected apply                   | Passing             |
| FR-4.3    | Consent excludes agents/data/remote/conflict changes | setup/CLI            | Conflict refusal without second decision   | Passing             |
| FR-4.4    | Advanced users can inspect paths and operations      | setup                | Typed plan change list                     | Passing             |
| FR-5.1    | Prefer supported host command or API                 | connectors           | Codex/Claude official CLI plans            | Passing             |
| FR-5.2    | Direct writes preserve content/mode/revision         | security             | Atomic scoped replacement                  | Passing             |
| FR-5.3    | Absolute receipt-owned command; no PATH/npx          | runtime/connectors   | Absolute launcher plans                    | Passing             |
| FR-5.4    | Bearer token absent from host configuration          | connectors/security  | Tokenless commands and leak scans          | Passing             |
| FR-5.5    | Prefer host approval for write-capable tools         | connectors           | Safe approval policy                       | Passing             |
| FR-5.6    | Ownership/version metadata distinguishes collision   | connectors           | Fingerprint classification                 | Passing             |
| FR-6.1    | Verify daemon against receipt and private token      | setup/MCP            | Service verification before connectors     | Passing             |
| FR-6.2    | Verify initialize and bounded catalog                | MCP                  | Required tool-catalog check                | Passing             |
| FR-6.3    | Reject wrong identity/protocol/tools/secrets         | MCP                  | Fail-closed verifier                       | Passing             |
| FR-6.4    | Timeout is bounded and bridge is reaped              | MCP                  | Close-on-every-exit assertion              | Passing             |
| FR-6.5    | Persist only redacted status and verification time   | setup/CLI            | Private journal and redacted envelopes     | Passing             |
| FR-7.1    | Interrupted setup resumes or rolls back durably      | setup                | Durable journal resume                     | Passing             |
| FR-7.2    | Unknown entry gets Keep/Replace/Cancel decision      | setup/CLI            | Separate conflict apply                    | Passing             |
| FR-7.3    | Partial agent failure keeps verified connections     | setup                | Focused retry without reconnecting healthy | Passing             |
| FR-7.4    | Broken runtime prevents connector mutation           | setup                | Service-health gate and rollback           | Passing             |
| FR-7.5    | Login denial keeps app/data and offers recovery      | setup                | Native recovery next action                | Passing             |
| FR-8.1    | Update reconciles installation transactionally       | lifecycle/surfaces   | Packaged update transaction                | Passing             |
| FR-8.2    | Healthy connectors survive update                    | lifecycle            | Reconcile without disconnect               | Passing             |
| FR-8.3    | Removal deletes owned artifacts but preserves data   | lifecycle            | Connector-aware removal                    | Passing             |
| FR-8.4    | Unsafe connector removal leaves entry with guidance  | connectors/lifecycle | Proven ownership boundary                  | Passing             |
| FR-9.1    | JSON-first, non-interactive, redacted CLI            | CLI/surfaces         | Connection command envelope                | Passing             |

### Security and privacy

| Spec item | Description                                     | File                | Test contract                          | Status              |
| --------- | ----------------------------------------------- | ------------------- | -------------------------------------- | ------------------- |
| SEC-1     | Logged-in user only; never root                 | security/surfaces   | Rootless sources and bootstrap         | Passing             |
| SEC-2     | HTTP/MCP network listeners remain loopback      | security            | Server binding contract                | Passing             |
| SEC-3     | Private directory and `0600` token/state files  | setup/security      | Journal/config modes                   | Passing             |
| SEC-4     | Tokens absent from all observable surfaces      | all                 | Commands, output, config, source scans | Passing             |
| SEC-5     | Sign/notarize app and nested executable code    | runtime/surfaces    | Artifact checker and native gate       | Passing + live todo |
| SEC-6     | Runtime pinned to application release           | runtime/surfaces    | Versioned manifest, no latest          | Passing             |
| SEC-7     | Verify Omarchy/runtime artifact trust chain     | surfaces            | SHA/target bootstrap and target smoke  | Passing + live todo |
| SEC-8     | Absolute paths/argument arrays; no shell source | connectors/security | Process and symlink boundaries         | Passing             |
| SEC-9     | Host config treated as protected user data      | security            | Atomic revision-checked scoped write   | Passing             |
| SEC-10    | Write-capable tools retain host approval        | connectors          | Safe approval policy                   | Passing             |
| SEC-11    | No direct database access through connectors/UI | security/surfaces   | Source-boundary negative assertions    | Passing             |
| SEC-12    | No telemetry                                    | security            | Source-boundary negative assertions    | Passing             |

### Edge cases

| Spec item | Description                                 | File             | Test contract                          | Status              |
| --------- | ------------------------------------------- | ---------------- | -------------------------------------- | ------------------- |
| EC-1      | No supported agent                          | setup            | Runtime-only successful completion     | Passing             |
| EC-2      | One supported agent                         | setup/macOS      | Selected-only apply                    | Passing             |
| EC-3      | Several supported agents                    | setup/macOS      | Default multi-selection and review     | Passing             |
| EC-4      | Agent running during configuration          | connectors/macOS | New-session-required state             | Passing             |
| EC-5      | Missing host config                         | security         | Minimum private config creation        | Passing             |
| EC-6      | Recognized stale Pimpampum entry            | connectors       | Automatic owned-stale repair state     | Passing             |
| EC-7      | Unknown `pimpampum` entry                   | setup/CLI        | Zero mutation before second decision   | Passing             |
| EC-8      | Read-only/managed host config               | security         | Preserve and fail with guidance        | Passing             |
| EC-9      | Connector verification timeout              | setup/MCP        | Bounded failure, child cleanup, retry  | Passing             |
| EC-10     | Daemon port occupied                        | setup            | No connector mutation; rollback        | Passing             |
| EC-11     | Existing npm daemon                         | lifecycle        | Transactional stop/switch/reconcile    | Passing             |
| EC-12     | Existing healthy manual connector           | connectors       | Equivalent-unowned classification      | Passing             |
| EC-13     | Login Item approval/app closes during setup | setup            | Recovery action and durable resume     | Passing             |
| EC-14     | Quickshell restarts                         | surfaces         | No QML service ownership and live gate | Passing + live todo |
| EC-15     | Agent removed later                         | connectors       | Neutral missing state; no mutation     | Passing             |
| EC-16     | Runtime update changes path                 | lifecycle        | Atomic update and connector reconcile  | Passing             |
| EC-17     | Uninstall partially fails                   | lifecycle        | Restore completed owned removals       | Passing             |
| EC-18     | Data directory already exists               | lifecycle        | Reuse bytes/token/store                | Passing             |

### Performance, reliability, accessibility, and content

| Spec item | Description                                     | File             | Test contract                          | Status    |
| --------- | ----------------------------------------------- | ---------------- | -------------------------------------- | --------- |
| PERF-1    | Clean setup under two minutes                   | runtime          | Observed clean-machine timing          | Live todo |
| PERF-2    | Detection results within two seconds            | connectors       | Bounded 2-second probe                 | Passing   |
| PERF-3    | Healthy connector verifies within ten seconds   | MCP              | 10-second verifier contract            | Passing   |
| PERF-4    | Bounded retries; no tight loops                 | setup            | Durable resume and focused retry       | Passing   |
| PERF-5    | Concurrent setup serializes via lifecycle lock  | setup            | Maximum one active operation           | Passing   |
| PERF-6    | Daemon survives app/QML/host shutdown           | runtime/surfaces | OS ownership and no UI stop            | Passing   |
| A11Y-1    | Keyboard/focus/VoiceOver/motion/theme preserved | macOS/surfaces   | Native accessibility source contract   | Passing   |
| A11Y-2    | Primary copy avoids runtime/transport jargon    | macOS            | Guided copy and npm/Terminal negatives | Passing   |
| A11Y-3    | Errors name failure, prior state, next action   | macOS/setup      | Partial/recovery presentation          | Passing   |
| A11Y-4    | Progress does not rely on color                 | macOS/surfaces   | Labels and accessibility metadata      | Passing   |
| A11Y-5    | Shared vocabulary on macOS and Omarchy          | macOS/surfaces   | Cross-surface state strings            | Passing   |

---

## Generated Test Files

| Alias      | File                                                                                 | Passing | Todos | Layer                                |
| ---------- | ------------------------------------------------------------------------------------ | ------: | ----: | ------------------------------------ |
| runtime    | `test/zero-friction-runtime.acceptance.test.ts`                                      |       7 |     3 | Runtime, packaging, service          |
| connectors | `test/zero-friction-connectors.acceptance.test.ts`                                   |      11 |     0 | Connector contract and MCP verifier  |
| setup      | `test/zero-friction-setup.acceptance.test.ts`                                        |       9 |     0 | Consent, coordinator, recovery       |
| lifecycle  | `test/zero-friction-lifecycle-security.acceptance.test.ts`                           |       9 |     0 | Migration, update, removal, security |
| CLI        | `test/zero-friction-cli.acceptance.test.ts`                                          |       4 |     0 | JSON-first CLI                       |
| surfaces   | `test/zero-friction-surfaces.acceptance.test.ts`                                     |       8 |     2 | macOS packaging and Omarchy          |
| macOS      | `platforms/macos/Tests/PimpampumMenuBarTests/ZeroFrictionSetupAcceptanceTests.swift` |       6 |     0 | Guided native UX                     |
| **Total**  |                                                                                      |  **54** | **5** |                                      |

---

## Coverage Summary

- Total enumerated spec items: **104**.
- Generated cases: **59** — 54 executable cases, all passing, and 5 explicit live-only todos.
- TypeScript cases: **53** — 48 passing and 5 todos.
- Swift cases: **6** — all passing.
- Traceability coverage: **100%** of enumerated user-story, functional, security, edge,
  performance, reliability, accessibility, and content requirements.
- Some cases cover several requirements where the PRD intentionally repeats one product invariant
  across user story, functional, edge, security, and success-metric sections.

### Verification

Observed on 2026-09-01:

- `npx vitest run test/zero-friction-*.test.ts --reporter=verbose`: 6 files, 48 passed, 5 todo.
- `swift test --package-path platforms/macos --filter ZeroFrictionSetupAcceptanceTests`: 6 passed.

At generation time (2026-08-31) `npm run typecheck`, `npm run lint` and `npm run format:check`
passed while every executable case failed on absent product behavior, as intended.

---

## Traceability of Generated Files

Status is the observed result on 2026-09-01.

| File                                                                                 | Spec sections covered                                    | Status            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------- |
| `test/zero-friction-runtime.acceptance.test.ts`                                      | US-1, US-3, FR-1, FR-5.3, SEC-5–SEC-7, PERF-1, PERF-6    | 7 passing, 3 todo |
| `test/zero-friction-connectors.acceptance.test.ts`                                   | US-1–US-4, FR-2, FR-3, FR-5, FR-6, EC-4, EC-6, EC-12     | 11 passing        |
| `test/zero-friction-setup.acceptance.test.ts`                                        | US-1/AC-4–AC-5, US-2/AC-2, FR-4, FR-7, EC-1–EC-3, EC-13  | 9 passing         |
| `test/zero-friction-lifecycle-security.acceptance.test.ts`                           | US-3, FR-5.2, FR-8, SEC-1–SEC-4, SEC-8–SEC-12, EC-5–EC-8 | 9 passing         |
| `test/zero-friction-cli.acceptance.test.ts`                                          | FR-4.2, FR-4.3, FR-7.2, FR-9.1, US-4/AC-4                | 4 passing         |
| `test/zero-friction-surfaces.acceptance.test.ts`                                     | FR-1.1, FR-8, FR-9.1, SEC-7, EC-14, A11Y-1, A11Y-5       | 8 passing, 2 todo |
| `platforms/macos/Tests/PimpampumMenuBarTests/ZeroFrictionSetupAcceptanceTests.swift` | US-2/AC-4, FR-3.2, FR-3.3, A11Y-1–A11Y-4, EC-2, EC-3     | 6 passing         |

The five todos and their live gates:

| Todo                                                                                  | File     |
| ------------------------------------------------------------------------------------- | -------- |
| PERF-1: completes clean observed setup in under two minutes                           | runtime  |
| FR-1.2: proves CLI, serve, SQLite and MCP with an empty external PATH on every target | runtime  |
| SEC-5: verifies signing, notarization and stapling on a clean macOS release artifact  | runtime  |
| SEC-7: proves a no-Node Omarchy bootstrap on every supported target architecture      | surfaces |
| EC-14: proves completed connections survive a live Quickshell restart                 | surfaces |

---

## Amendment 2026-09-01

Source: `thoughts/reviews/2026-09-01_deep-review.md`, finding H-14, and Task 0.1 of
`thoughts/plans/2026-09-01_deep-review-remediation.md`.

- The "Immutability" hash table was removed. Two of its seven hashes were already stale, and no
  script ever verified this set, so the table recorded snapshots rather than a contract.
- The generated files are no longer frozen. Their `@immutable` headers will be removed in a later
  phase of the remediation plan. The `@generated-from` reference and the spec-id test titles remain
  the contract: a test changes only together with the spec item it names, and the PRD is amended
  first.
- The "Initial status" columns were replaced by the observed status.
- The five `it.todo` cases stay as written until a live runner produces the evidence they name;
  converting one is a spec-visible change, not a cleanup.

---

## Required Live Evidence

The five `todo` cases are executable release gates that require a signed artifact or native target:

1. Clean download-to-verified-agent macOS setup under two minutes.
2. Empty-external-`PATH` runtime/SQLite/HTTP/MCP smoke on `darwin-arm64`, `linux-x64`, and
   `linux-arm64`.
3. Nested code signing, notarization, and stapling on the release macOS app.
4. No-Node Omarchy bootstrap on every supported target architecture.
5. Completed connector availability after a live Quickshell restart.

Add runners and evidence that satisfy these descriptions; convert a `todo` only together with the
evidence and the spec item it names.

---

## Next Step

The implementation plan at `thoughts/plans/2026-08-31_zero-friction-local-agent-setup.md` is
complete. Remaining work is the live evidence for the five todos above.
