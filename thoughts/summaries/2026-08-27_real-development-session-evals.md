# Summary: Real Development Session Evals

**Date**: 2026-08-27
**Type**: Feature
**Branch**: `develop`
**Scope**: 12 feature, test, fixture, command, and documentation files before summary artifacts

---

## What Changed

### Deterministic Development Sessions

- Added `test/development-sessions.e2e.test.ts` with two compiled E2E scenarios.
- The handoff scenario proves Task Claim ownership, competing rejection, a partial checkpoint commit,
  release with an activity-visible note, takeover by a different agent identity, repository test
  execution, a completion commit, and externally resolvable artifacts.
- The restart scenario proves that a live Spec Claim survives compiled daemon restart and that a new
  process with the same stable `agentId` can resume idempotently while a competitor remains excluded.

### Synthetic Repository and Session Boundary

- Added a dependency-free ESM repository fixture with test-only source, spec, package metadata, and
  `node:test` coverage.
- Added a bounded session executable with allowlisted actions and strict JSON/path/target validation.
- Sessions call `dist/cli.js call` over authenticated MCP HTTP, edit only the temporary repository,
  run Node tests, invoke Git without shell interpolation, and emit structured evidence.
- The E2E orchestrator independently validates exact source content, passing tests, clean Git state,
  commit objects, changed paths, stored completion details, and handoff activity.

### Eval Command

- `test:e2e` now builds once and runs `test/e2e.test.ts` plus
  `test/development-sessions.e2e.test.ts`.
- `test:evals` remains the clear alias for the deterministic compiled gate.
- `test:coverage` and `test:unit` exclude the legacy E2E filename and the `*.e2e.test.ts` pattern.
- `npm test` builds once, runs focused coverage, then runs all six E2E scenarios.

### Documentation

- Replaced the over-broad eval rubric with a literal six-test inventory.
- Distinguished compiled product scenarios, synthetic development sessions, complementary focused
  suites, and native opt-in gates.
- Corrected the macOS live command to require `PIMPAMPUM_RUN_LIVE_MACOS=1`.
- Clarified that `test:e2e:omarchy` validates plugin/evidence while the `:live` command performs the
  installation workflow.
- Clarified that deterministic evals do not launch or score an LLM.

### Workflow Artifacts

- Added an approved PRD, phased implementation plan, and traceability manifest.
- Froze the generated E2E test at SHA-256
  `0ef2b34949d12a829f1f9f202de0127b75487630be206e8b4efc1bb1ff00749a`.

---

## Why

The product needed evidence that coordination holds around actual development mechanics rather than
only synthetic API sequences. Independent processes now perform repository edits, tests, commits,
handoff, and restart recovery while Pimpampum owns Claims and lifecycle state. The documentation was
also corrected so contributors can treat `npm run test:evals` as an honest release contract.

---

## Decisions Made

| Decision                                     | Rationale                                                                  | Alternative Considered                        |
| -------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| Separate deterministic session processes     | Proves process/session boundaries while remaining CI-safe                  | Keep all session logic inside Vitest          |
| No model invocation                          | Avoids credentials, network, cost, and non-determinism in the release gate | Launch Codex/LLM during evals                 |
| Temporary Git repository with local identity | Prevents writes to user repositories/config and makes cleanup auditable    | Modify the Pimpampum checkout                 |
| MCP HTTP through compiled CLI calls          | Exercises the documented shell-agent fallback and short-lived sessions     | Call store or in-process MCP handler directly |
| External artifact verification               | Stored artifact references are intentionally opaque                        | Trust returned `git:<sha>` strings            |
| Stable Claim lease instead of timed expiry   | Keeps the gate fast and deterministic; expiry stays in focused tests       | Sleep until Claim expiration                  |

---

## What's Pending

- [x] `/post-review` passed after isolating Git configuration and enforcing exact source bytes.
- [x] No product implementation work remains for the feature.

---

## Quality Status

| Check                               | Status                                          |
| ----------------------------------- | ----------------------------------------------- |
| TypeScript typecheck                | Pass                                            |
| Oxlint                              | Pass                                            |
| Prettier                            | Pass                                            |
| Focused tests                       | 378 passed                                      |
| Coverage                            | 100% statements, branches, functions, and lines |
| Compiled evals                      | 6 passed                                        |
| New E2E repeat                      | 2 passed twice consecutively                    |
| Frozen test hash                    | Matches manifest                                |
| Hostile inherited Git configuration | Ignored; 2 E2E passed                           |
| Post-review architecture check      | Pass after fixes                                |

No commits were created. The working tree already contained unrelated macOS changes, which this
feature preserved without reverting or grouping.
