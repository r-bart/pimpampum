# Test Manifest: Zero-friction Local Agent Setup

**Date**: 2026-08-31  
**Spec**: `thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md`  
**Plan**: `thoughts/plans/2026-08-31_zero-friction-local-agent-setup.md`  
**Status**: frozen before implementation — failing as expected

---

## Framework and Conventions

- TypeScript: Vitest, `describe`/`it`, `expect`, dynamic imports for not-yet-created modules,
  boundary fakes, isolated temporary homes, and top-level `test/*.test.ts` files.
- CLI: existing `runCli` composition with injected runtime boundaries and JSON envelope assertions.
- macOS: Swift Testing with source-contract assertions that compile before the new Swift types exist.
- Omarchy: Vitest artifact contracts over the pinned manifest, bounded helpers, and QML surface.
- Live-only gates: `it.todo()` is used only where signing/notarization or native target hardware is
  required. The intended command and outcome remain frozen here.

Generated tests assert externally meaningful outcomes. They do not import missing TypeScript
modules statically, so `npm run typecheck` remains green. Their current runtime failures are caused
by absent product behavior, modules, commands, or artifacts—not compilation errors.

### Spec ID scheme

- `US-N/AC-M`: the 18 explicit user-story acceptance criteria.
- `FR-N.M`: each bullet in the nine Functional Requirements sections (45 items).
- `SEC-N`: each Security & Privacy requirement (12 items).
- `EC-N`: each Edge Case table row, in source order (18 items).
- `PERF-N`: each Performance and Reliability requirement (6 items).
- `A11Y-N`: each Accessibility and Content requirement (5 items).

---

## Traceability Matrix

File aliases used below are expanded in **Generated Test Files**.

### User stories

| Spec item | Description                                           | File       | Test contract                            | Initial status |
| --------- | ----------------------------------------------------- | ---------- | ---------------------------------------- | -------------- |
| US-1/AC-1 | No Terminal or external runtime on macOS              | runtime/UI | Private paths and Guided copy            | Failing        |
| US-1/AC-2 | Detect Codex and Claude Code                          | connectors | Registry and bounded detection           | Failing        |
| US-1/AC-3 | Select supported detected agents by default           | connectors | Registry plan and native selection       | Failing        |
| US-1/AC-4 | One confirmation installs and connects selection      | setup      | Selected one-confirmation apply          | Failing        |
| US-1/AC-5 | OS approval only when required                        | setup      | Login Item recovery result               | Failing        |
| US-2/AC-1 | Verify runtime and connectors independently           | setup/MCP  | Per-component result and MCP verifier    | Failing        |
| US-2/AC-2 | Partial success remains visible and recoverable       | setup/UI   | Focused connector retry and Agents card  | Failing        |
| US-2/AC-3 | Success requires initialize and bounded tool catalog  | MCP        | Identity, initialize, and required tools | Failing        |
| US-2/AC-4 | Distinguish configured from current-session available | macOS      | Durable progress and completion model    | Failing        |
| US-3/AC-1 | Preserve all existing user state                      | lifecycle  | Byte-preserving npm migration            | Failing        |
| US-3/AC-2 | Never run two daemons on one data directory           | lifecycle  | Stop-before-activate ordering            | Failing        |
| US-3/AC-3 | Reconcile recognized entries idempotently             | connectors | Owned current/stale classification       | Failing        |
| US-3/AC-4 | Never overwrite unknown collisions automatically      | setup      | Separate conflict decision               | Failing        |
| US-3/AC-5 | Restore prior runtime and connector state on failure  | lifecycle  | Migration and runtime rollback           | Failing        |
| US-4/AC-1 | Disconnect only recognized owned entries              | connectors | Receipt-proven disconnect                | Failing        |
| US-4/AC-2 | Disconnect preserves daemon and data                  | lifecycle  | Connector-aware removal boundary         | Failing        |
| US-4/AC-3 | Missing client does not install third-party software  | connectors | Neutral missing/unsupported plans        | Failing        |
| US-4/AC-4 | Advanced manual instructions are redacted             | CLI/MCP    | Redacted instructions and diagnostics    | Failing        |

### Functional requirements

| Spec item | Description                                          | File                 | Test contract                              | Initial status      |
| --------- | ---------------------------------------------------- | -------------------- | ------------------------------------------ | ------------------- |
| FR-1.1    | Both distributions include compatible runtime        | runtime/surfaces     | Manifest and embedded/pinned assets        | Failing             |
| FR-1.2    | CLI, serve, MCP need no external Node/npm            | runtime              | Private paths and empty-PATH target smoke  | Failing + live todo |
| FR-1.3    | OS-managed daemon independent from UI                | runtime/surfaces     | Launchd/systemd ownership                  | Failing             |
| FR-1.4    | Runtime update is versioned and atomic               | runtime/lifecycle    | Activation, rollback, and update           | Failing             |
| FR-2.1    | Connector detects host and supported version         | connectors           | Registry and bounded detection             | Failing             |
| FR-2.2    | Inspect target entry without unrelated config        | connectors/security  | Bounded probe and scoped config access     | Failing             |
| FR-2.3    | Plan and describe exact owned mutation               | connectors/setup     | Tokenless host plans and review plan       | Failing             |
| FR-2.4    | Connect idempotently                                 | connectors           | Owned-current classification               | Failing             |
| FR-2.5    | Verify startup and MCP initialization                | MCP                  | Installed-route verification               | Failing             |
| FR-2.6    | Report new-session requirement                       | connectors/macOS     | Plan/result availability distinction       | Failing             |
| FR-2.7    | Repair recognized stale configuration                | connectors           | Owned-stale classification                 | Failing             |
| FR-2.8    | Disconnect only recognized configuration             | connectors           | Receipt-proven removal plan                | Failing             |
| FR-2.9    | Snapshot/restore and redact diagnostics              | lifecycle/MCP        | Rollback and redaction                     | Failing             |
| FR-2.10   | Common domain-neutral connector contract             | connectors/surfaces  | Registry parity and UI boundary            | Failing             |
| FR-3.1    | Detection is local and does not launch agent         | connectors           | Version-only executable probe              | Failing             |
| FR-3.2    | Supported detected agents selected by default        | connectors/macOS     | Selection metadata                         | Failing             |
| FR-3.3    | User can inspect and deselect before consent         | setup/macOS          | Planned changes and selected-only apply    | Failing             |
| FR-3.4    | Unsupported versions unselected with guidance        | connectors           | Unsupported plan                           | Failing             |
| FR-3.5    | Absence is neutral                                   | connectors/setup     | Missing host and no-agent completion       | Failing             |
| FR-3.6    | Detection avoids broad home traversal                | connectors           | Bounded locations and sanitized PATH       | Failing             |
| FR-4.1    | Review service/login/connector changes first         | setup/macOS          | Non-mutating setup plan                    | Failing             |
| FR-4.2    | One confirmation authorizes listed changes only      | setup/CLI            | Confirmed selected apply                   | Failing             |
| FR-4.3    | Consent excludes agents/data/remote/conflict changes | setup/CLI            | Conflict refusal without second decision   | Failing             |
| FR-4.4    | Advanced users can inspect paths and operations      | setup                | Typed plan change list                     | Failing             |
| FR-5.1    | Prefer supported host command or API                 | connectors           | Codex/Claude official CLI plans            | Failing             |
| FR-5.2    | Direct writes preserve content/mode/revision         | security             | Atomic scoped replacement                  | Failing             |
| FR-5.3    | Absolute receipt-owned command; no PATH/npx          | runtime/connectors   | Absolute launcher plans                    | Failing             |
| FR-5.4    | Bearer token absent from host configuration          | connectors/security  | Tokenless commands and leak scans          | Failing             |
| FR-5.5    | Prefer host approval for write-capable tools         | connectors           | Safe approval policy                       | Failing             |
| FR-5.6    | Ownership/version metadata distinguishes collision   | connectors           | Fingerprint classification                 | Failing             |
| FR-6.1    | Verify daemon against receipt and private token      | setup/MCP            | Service verification before connectors     | Failing             |
| FR-6.2    | Verify initialize and bounded catalog                | MCP                  | Required tool-catalog check                | Failing             |
| FR-6.3    | Reject wrong identity/protocol/tools/secrets         | MCP                  | Fail-closed verifier                       | Failing             |
| FR-6.4    | Timeout is bounded and bridge is reaped              | MCP                  | Close-on-every-exit assertion              | Failing             |
| FR-6.5    | Persist only redacted status and verification time   | setup/CLI            | Private journal and redacted envelopes     | Failing             |
| FR-7.1    | Interrupted setup resumes or rolls back durably      | setup                | Durable journal resume                     | Failing             |
| FR-7.2    | Unknown entry gets Keep/Replace/Cancel decision      | setup/CLI            | Separate conflict apply                    | Failing             |
| FR-7.3    | Partial agent failure keeps verified connections     | setup                | Focused retry without reconnecting healthy | Failing             |
| FR-7.4    | Broken runtime prevents connector mutation           | setup                | Service-health gate and rollback           | Failing             |
| FR-7.5    | Login denial keeps app/data and offers recovery      | setup                | Native recovery next action                | Failing             |
| FR-8.1    | Update reconciles installation transactionally       | lifecycle/surfaces   | Packaged update transaction                | Failing             |
| FR-8.2    | Healthy connectors survive update                    | lifecycle            | Reconcile without disconnect               | Failing             |
| FR-8.3    | Removal deletes owned artifacts but preserves data   | lifecycle            | Connector-aware removal                    | Failing             |
| FR-8.4    | Unsafe connector removal leaves entry with guidance  | connectors/lifecycle | Proven ownership boundary                  | Failing             |
| FR-9.1    | JSON-first, non-interactive, redacted CLI            | CLI/surfaces         | Connection command envelope                | Failing             |

### Security and privacy

| Spec item | Description                                     | File                | Test contract                          | Initial status      |
| --------- | ----------------------------------------------- | ------------------- | -------------------------------------- | ------------------- |
| SEC-1     | Logged-in user only; never root                 | security/surfaces   | Rootless sources and bootstrap         | Failing             |
| SEC-2     | HTTP/MCP network listeners remain loopback      | security            | Server binding contract                | Failing             |
| SEC-3     | Private directory and `0600` token/state files  | setup/security      | Journal/config modes                   | Failing             |
| SEC-4     | Tokens absent from all observable surfaces      | all                 | Commands, output, config, source scans | Failing             |
| SEC-5     | Sign/notarize app and nested executable code    | runtime/surfaces    | Artifact checker and native gate       | Failing + live todo |
| SEC-6     | Runtime pinned to application release           | runtime/surfaces    | Versioned manifest, no latest          | Failing             |
| SEC-7     | Verify Omarchy/runtime artifact trust chain     | surfaces            | SHA/target bootstrap and target smoke  | Failing + live todo |
| SEC-8     | Absolute paths/argument arrays; no shell source | connectors/security | Process and symlink boundaries         | Failing             |
| SEC-9     | Host config treated as protected user data      | security            | Atomic revision-checked scoped write   | Failing             |
| SEC-10    | Write-capable tools retain host approval        | connectors          | Safe approval policy                   | Failing             |
| SEC-11    | No direct database access through connectors/UI | security/surfaces   | Source-boundary negative assertions    | Failing             |
| SEC-12    | No telemetry                                    | security            | Source-boundary negative assertions    | Failing             |

### Edge cases

| Spec item | Description                                 | File             | Test contract                          | Initial status      |
| --------- | ------------------------------------------- | ---------------- | -------------------------------------- | ------------------- |
| EC-1      | No supported agent                          | setup            | Runtime-only successful completion     | Failing             |
| EC-2      | One supported agent                         | setup/macOS      | Selected-only apply                    | Failing             |
| EC-3      | Several supported agents                    | setup/macOS      | Default multi-selection and review     | Failing             |
| EC-4      | Agent running during configuration          | connectors/macOS | New-session-required state             | Failing             |
| EC-5      | Missing host config                         | security         | Minimum private config creation        | Failing             |
| EC-6      | Recognized stale Pimpampum entry            | connectors       | Automatic owned-stale repair state     | Failing             |
| EC-7      | Unknown `pimpampum` entry                   | setup/CLI        | Zero mutation before second decision   | Failing             |
| EC-8      | Read-only/managed host config               | security         | Preserve and fail with guidance        | Failing             |
| EC-9      | Connector verification timeout              | setup/MCP        | Bounded failure, child cleanup, retry  | Failing             |
| EC-10     | Daemon port occupied                        | setup            | No connector mutation; rollback        | Failing             |
| EC-11     | Existing npm daemon                         | lifecycle        | Transactional stop/switch/reconcile    | Failing             |
| EC-12     | Existing healthy manual connector           | connectors       | Equivalent-unowned classification      | Failing             |
| EC-13     | Login Item approval/app closes during setup | setup            | Recovery action and durable resume     | Failing             |
| EC-14     | Quickshell restarts                         | surfaces         | No QML service ownership and live gate | Failing + live todo |
| EC-15     | Agent removed later                         | connectors       | Neutral missing state; no mutation     | Failing             |
| EC-16     | Runtime update changes path                 | lifecycle        | Atomic update and connector reconcile  | Failing             |
| EC-17     | Uninstall partially fails                   | lifecycle        | Restore completed owned removals       | Failing             |
| EC-18     | Data directory already exists               | lifecycle        | Reuse bytes/token/store                | Failing             |

### Performance, reliability, accessibility, and content

| Spec item | Description                                     | File             | Test contract                          | Initial status |
| --------- | ----------------------------------------------- | ---------------- | -------------------------------------- | -------------- |
| PERF-1    | Clean setup under two minutes                   | runtime          | Observed clean-machine timing          | Live todo      |
| PERF-2    | Detection results within two seconds            | connectors       | Bounded 2-second probe                 | Failing        |
| PERF-3    | Healthy connector verifies within ten seconds   | MCP              | 10-second verifier contract            | Failing        |
| PERF-4    | Bounded retries; no tight loops                 | setup            | Durable resume and focused retry       | Failing        |
| PERF-5    | Concurrent setup serializes via lifecycle lock  | setup            | Maximum one active operation           | Failing        |
| PERF-6    | Daemon survives app/QML/host shutdown           | runtime/surfaces | OS ownership and no UI stop            | Failing        |
| A11Y-1    | Keyboard/focus/VoiceOver/motion/theme preserved | macOS/surfaces   | Native accessibility source contract   | Failing        |
| A11Y-2    | Primary copy avoids runtime/transport jargon    | macOS            | Guided copy and npm/Terminal negatives | Failing        |
| A11Y-3    | Errors name failure, prior state, next action   | macOS/setup      | Partial/recovery presentation          | Failing        |
| A11Y-4    | Progress does not rely on color                 | macOS/surfaces   | Labels and accessibility metadata      | Failing        |
| A11Y-5    | Shared vocabulary on macOS and Omarchy          | macOS/surfaces   | Cross-surface state strings            | Failing        |

---

## Generated Test Files

| Alias      | File                                                                                 | Failing | Todos | Layer                                |
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
- Generated cases: **59** — 54 executable failures and 5 explicit live-only todos.
- TypeScript cases: **53** — 48 failures and 5 todos.
- Swift cases: **6** — all compile and fail on missing Guided behavior/artifacts.
- Traceability coverage: **100%** of enumerated user-story, functional, security, edge,
  performance, reliability, accessibility, and content requirements.
- Some cases cover several requirements where the PRD intentionally repeats one product invariant
  across user story, functional, edge, security, and success-metric sections.

### Initial verification

- `npm run typecheck`: passes.
- `npm run lint`: passes.
- `npm run format:check`: passes.
- `npx vitest run test/zero-friction-*.test.ts --reporter=verbose`: fails as expected because the
  packaged runtime, connector, setup, CLI, macOS, and Omarchy behavior does not exist yet.
- `swift test --package-path platforms/macos --filter ZeroFrictionSetupAcceptanceTests`: builds the
  complete Swift package and fails the six generated acceptance cases as expected.

The full `npm test` command is expected to remain red until implementation satisfies the generated
Vitest contracts. Baseline tests are not modified by this generation step.

---

## Immutability

The following generated artifacts are frozen. Implementation must make them pass without editing
them. SHA-256 hashes were recorded after final format and verification:

| Frozen artifact                                                                      | SHA-256                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `test/zero-friction-runtime.acceptance.test.ts`                                      | `68c3a07f0aced4e43d11875dab928c3f1984bd9e0f21cfd2194b5b7100ad0683` |
| `test/zero-friction-connectors.acceptance.test.ts`                                   | `a5c72afee001dbb9684c4bf6a95a24f74aa1c9c32d968e9f00548ebef937b8c7` |
| `test/zero-friction-setup.acceptance.test.ts`                                        | `e61bfcb346ab6e9e1bce55955aef05dfad8b1e9c9d2a10b45ded1e1bba61ba06` |
| `test/zero-friction-lifecycle-security.acceptance.test.ts`                           | `63dc032522f2191f9786ad2a0b3f2e1213ff4d6d3ab6ba2b3a1503fc024d5052` |
| `test/zero-friction-cli.acceptance.test.ts`                                          | `b99582c895f3b6d3d6826c7a94559742877258d55e60da01f4baa2cc4fbe9a5d` |
| `test/zero-friction-surfaces.acceptance.test.ts`                                     | `a91b0174855366d2d2564c40618297aa4f81204a7931dd69d3bfa302cc3c57d8` |
| `platforms/macos/Tests/PimpampumMenuBarTests/ZeroFrictionSetupAcceptanceTests.swift` | `16e0901ea278ca872875c257c69a0d81b63fd55e9e5cdc77020aef859d3193e6` |

If a frozen contract is wrong:

1. Update and re-approve the PRD.
2. Regenerate the affected Tests-as-DoD.
3. Update this manifest and all hashes together.
4. Never weaken or patch a generated test during implementation.

---

## Required Live Evidence

The five `todo` cases are executable release gates that require a signed artifact or native target:

1. Clean download-to-verified-agent macOS setup under two minutes.
2. Empty-external-`PATH` runtime/SQLite/HTTP/MCP smoke on `darwin-arm64`, `linux-x64`, and
   `linux-arm64`.
3. Nested code signing, notarization, and stapling on the release macOS app.
4. No-Node Omarchy bootstrap on every supported target architecture.
5. Completed connector availability after a live Quickshell restart.

During implementation, add runners/evidence that satisfy these frozen descriptions; do not convert
the `todo` declarations by editing the generated files.

---

## Next Step

The implementation plan already exists at
`thoughts/plans/2026-08-31_zero-friction-local-agent-setup.md`. Execute it with
`/devtronic:execute-plan`, treating every artifact and hash in this manifest as immutable.
