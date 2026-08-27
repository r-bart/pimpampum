# PRD: Real Development Session Evals

**Date**: 2026-08-27
**Status**: approved

---

## Executive Summary

Add deterministic end-to-end evaluations that exercise Pimpampum as part of real local development
sessions. Each evaluation uses compiled product interfaces, independent operating-system processes,
a temporary Git repository, synthetic source code, a real test runner, real commits, and verifiable
artifact references. Align `test:evals` and its documentation so the command and published rubric
describe exactly the same executable gate.

---

## Problem Statement

### Current State

The compiled E2E suite proves domain coordination, persistence, backup, HTTP, CLI, and MCP contracts.
It does not perform development work inside a repository. Agent identities are currently represented
by sequential requests inside one Vitest process, while `docs/evals.md` attributes additional
integration and acceptance coverage to `test:evals` that the command does not execute.

### Pain Points

- A release can pass E2E without proving that separate sessions can claim, hand off, resume, test,
  commit, and complete work in an actual repository.
- Completion artifacts can be syntactically accepted without the E2E gate proving that their Git
  commits and files exist.
- The documented eval rubric is broader than the executable `test:evals` command.

---

## Goals & Non-Goals

### Goals

1. Exercise at least two independent development-session processes against one compiled daemon and
   one shared temporary SQLite database.
2. Perform real, deterministic edits in a temporary Git repository containing only test content.
3. Run a real local test command and create real Git commits during the session workflow.
4. Prove exclusive Claims, explicit handoff, re-claim by a different session, and completion.
5. Prove continuity across a daemon restart while a Claim remains active.
6. Verify completion artifact URIs against the temporary Git repository instead of trusting the
   stored references alone.
7. Make `npm run test:evals` run every deterministic compiled eval it documents.

### Non-Goals

- Launching Codex, another LLM, or a remote agent service inside CI.
- Network access, package installation, external repositories, or user credentials.
- Measuring model reasoning quality or generating non-deterministic code.
- Mutating the Pimpampum checkout, user Git configuration, or user application data.
- Including opt-in native macOS or Omarchy live gates in the portable deterministic eval command.

---

## User Stories

### US-1: Handoff between real development sessions

**As a** Pimpampum maintainer
**I want to** run two separate session processes against a synthetic repository
**So that** I know a partial implementation can be handed off and completed safely.

Acceptance Criteria:

- [ ] Session A claims eligible work through the compiled agent-facing CLI and MCP HTTP transport.
- [ ] A competing session cannot claim the same target while Session A owns it.
- [ ] Session A writes a partial source change, records a checkpoint commit, and releases the Claim
      with a handoff note.
- [ ] Session B reads the current work and handoff, claims it, finishes the source change, runs the
      repository's real tests, creates a completion commit, and completes the work.
- [ ] The eval resolves every reported Git artifact and verifies the final source and test output.

### US-2: Continuity across daemon restart

**As a** Pimpampum maintainer
**I want to** restart the compiled daemon during active development
**So that** I know a new process with the same stable session identity can resume safely.

Acceptance Criteria:

- [ ] A session claims work and records a tested repository change.
- [ ] The daemon is terminated and restarted against the same SQLite database.
- [ ] A new operating-system process using the same `agentId` reclaims idempotently, reads the same
      target, and completes it.
- [ ] A different session remains excluded while the restored Claim is active.

### US-3: Honest executable eval contract

**As a** contributor
**I want to** trust `npm run test:evals` and `docs/evals.md`
**So that** the release gate has one unambiguous meaning.

Acceptance Criteria:

- [ ] `test:evals` explicitly runs the existing compiled product E2E and the new development-session
      E2E.
- [ ] Coverage/unit commands exclude every E2E file.
- [ ] Documentation distinguishes deterministic compiled evals, complementary acceptance suites,
      and opt-in native live gates.
- [ ] Documentation does not claim model-level behavior, MCP transports, or scenarios that the
      executable eval command does not exercise.

---

## Functional Requirements

### FR-1: Isolated synthetic repository

- Create a temporary repository for every eval run.
- Configure Git identity only inside that repository.
- Strip inherited `GIT_*` variables, disable system configuration and attributes, point global Git
  configuration at an empty file inside the temporary root, disable prompts, and use an empty
  template directory so user hooks, signing, filters, and templates cannot affect the eval.
- Seed a minimal source module and test suite using Node built-ins; do not install dependencies.
- Keep all fixture names, content, summaries, handoff notes, and commits explicitly synthetic.
- Remove the repository and product data after the suite.

### FR-2: Independent session runner

- Execute each development session as a child process with its own process identity and command log.
- Interact with Pimpampum only through compiled public interfaces.
- Accept a bounded, declarative test scenario rather than arbitrary shell input.
- Return structured JSON with claim, test, commit, and completion evidence.
- Fail closed on malformed product output, failed tests, Git errors, or unexpected ownership.

### FR-3: Handoff and competition

- Use stable and distinct `agentId` values for different sessions.
- Verify one competing Claim fails while the owner Claim is live.
- Persist a partial Git commit before release.
- Record and verify a handoff note in activity.
- Let a different process claim and complete the same target after release.

### FR-4: Restart continuity

- Restart the compiled daemon without replacing its data directory.
- Preserve a live Claim and repository state across the restart.
- Resume from a new child process with the same stable `agentId`.
- Verify idempotent ownership and final completion.

### FR-5: Evidence verification

- Assert the repository tests pass using the local Node executable.
- Assert final source bytes equal the complete expected synthetic implementation.
- Assert reported commit hashes resolve and belong to the temporary repository.
- Assert completion summaries and artifact references round-trip through Pimpampum.
- Assert no unexpected uncommitted changes remain in the fixture repository.

### FR-6: Eval command and documentation

- Build once, then execute all deterministic E2E files explicitly.
- Keep opt-in native platform gates separate.
- Document the exact scenarios, interfaces, isolation boundaries, commands, and exclusions.
- Correct the macOS live command to include its required opt-in environment variable.

---

## Technical Considerations

- Use loopback ports, temporary directories, and the existing compiled daemon startup pattern.
- Pass one controlled Git environment to the orchestrator and every session process without
  repurposing the user's `HOME`.
- Prefer Node built-ins (`node:test`, child processes, filesystem) for the synthetic repository.
- Use CLI `call` commands for MCP HTTP so agent-facing behavior is exercised without internal store
  access.
- Pimpampum stores artifact references but does not validate them; the E2E orchestrator owns Git and
  filesystem verification.
- Avoid timing-based Claim expiry in the deterministic gate. Ownership, release, handoff, restart,
  and idempotent reclaim provide stable coverage; expiry remains covered by focused tests.
- The existing dirty working tree is out of scope and must remain untouched.

---

## Success Metrics

| Metric                    | Target                                                           | How to Measure                                   |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| Real development sessions | At least 2 distinct child processes                              | Captured process/session results                 |
| Repository work           | Source edit, test run, and Git commit all real                   | Filesystem, test exit code, `git cat-file`       |
| Coordination safety       | Zero duplicate successful Claims                                 | Competing session assertion                      |
| Restart continuity        | Active ownership survives daemon restart                         | Same-agent reclaim and different-agent rejection |
| Eval contract drift       | Zero documented scenarios absent from command                    | Review `package.json` against `docs/evals.md`    |
| Isolation                 | Zero writes outside temporary roots and intended repo docs/tests | Test cleanup and git diff review                 |

---

## Open Questions

None. The user requested deterministic test content, and the repository architecture makes local
process/Git/test realism the reliable boundary. Model-in-the-loop evaluation remains intentionally
out of scope.

---

## Risks

| Risk                                         | Impact | Mitigation                                                                        |
| -------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| Child-process orchestration becomes flaky    | High   | Use health polling, explicit timeouts, structured JSON, and no arbitrary sleeps   |
| Tests mutate the developer checkout          | High   | Create and validate one temporary Git root; pass explicit absolute paths          |
| Artifact references provide false confidence | High   | Resolve commits and files externally before accepting completion                  |
| Documentation drifts again                   | Medium | Make command membership and suite boundaries explicit in package scripts and docs |
| Platform-specific Git behavior               | Medium | Use portable Git commands and repository-local identity                           |
