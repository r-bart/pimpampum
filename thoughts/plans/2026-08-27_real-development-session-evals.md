# Implementation Plan: Real Development Session Evals

**Date**: 2026-08-27
**Status**: Complete
**Spec**: `thoughts/specs/2026-08-27_real-development-session-evals.md`

---

## Overview

Add a deterministic compiled E2E suite whose independent child processes perform synthetic source
edits, execute repository tests, create Git commits, hand work off, and resume after daemon restart.
Then make `test:evals` and `docs/evals.md` describe that exact portable gate.

## Requirements

- [x] Every development workspace is a disposable Git repository containing only synthetic content.
- [x] Sessions run as independent operating-system processes and use the compiled agent-facing CLI.
- [x] Handoff, competing ownership, restart continuity, test execution, commits, and artifacts are
      externally verified.
- [x] `test:evals`, unit/coverage exclusions, README, and eval documentation agree.
- [x] Existing user changes outside the feature files remain untouched.

---

## Approach Analysis

### Option A: One large Vitest orchestrator

**Description**: Put daemon startup, CLI calls, repository edits, Git commands, and every session
action directly in one new TypeScript E2E file.

**Pros**: Few files; simple invocation.

**Cons**: The apparent sessions still execute development logic inside the Vitest process; process
separation is weak and the test becomes difficult to audit.

**Complexity**: Medium

### Option B: Vitest orchestrator plus bounded session executable

**Description**: Let Vitest own isolation, daemon lifecycle, product setup, and final assertions.
Spawn a small checked-in Node executable for each synthetic session. The executable accepts one
strict JSON scenario, calls the compiled CLI over MCP HTTP, applies a named synthetic change, runs
the repository test command, commits, releases, or completes, and returns structured evidence.

**Pros**: Real process boundaries; public-interface coverage; explicit fixture content; deterministic
and CI-safe; Git/test evidence can be independently verified by the orchestrator.

**Cons**: More fixture/support code; careful input validation and cleanup are required.

**Complexity**: Medium

### Option C: Model-in-the-loop eval

**Description**: Launch Codex or another model to interpret a Spec and modify a repository.

**Pros**: Closest to a human-visible agent session.

**Cons**: Requires credentials/network, is non-deterministic, slow, costly, and unsuitable as a
portable release gate. It would conflate model quality with Pimpampum protocol correctness.

**Complexity**: High

### Recommendation

Use Option B. It proves the system boundaries under Pimpampum's control—processes, MCP HTTP, Claims,
filesystem, test runner, Git, persistence, and artifacts—while keeping the release gate repeatable.

---

## Files to Create/Modify

| File                                                          | Action | Purpose                                                        |
| ------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| `test/development-sessions.e2e.test.ts`                       | Create | Orchestrate isolated compiled product and session scenarios    |
| `test/fixtures/development-session/session.mjs`               | Create | Bounded child-process session executable                       |
| `test/fixtures/development-session/package.json`              | Create | Synthetic repository metadata and test command                 |
| `test/fixtures/development-session/src/calculator.js`         | Create | Intentionally incomplete synthetic implementation              |
| `test/fixtures/development-session/test/calculator.test.js`   | Create | Synthetic repository tests                                     |
| `test/fixtures/development-session/spec.md`                   | Create | Synthetic work description supplied to Pimpampum               |
| `thoughts/tests/2026-08-27_real-development-session-evals.md` | Create | Frozen tests-as-Definition-of-Done manifest                    |
| `package.json`                                                | Modify | Run both E2E suites and exclude them from unit/coverage        |
| `docs/evals.md`                                               | Modify | Publish the literal deterministic gate and separate live gates |
| `README.md`                                                   | Modify | Describe the corrected eval command at a high level            |

---

## Implementation Phases

### Phase 1: Freeze the E2E Definition of Done

#### Task 1.1: Add failing development-session E2E scenarios

**Files**: `test/development-sessions.e2e.test.ts`, fixture placeholders

- Define a handoff scenario with owner Claim, competing rejection, checkpoint commit, release note,
  second-agent completion, passing project tests, and resolvable completion artifact.
- Define a restart scenario with live Claim, daemon termination/restart, different-agent rejection,
  same-agent idempotent reclaim from a new process, passing tests, commit, and completion.
- Assert each process has a distinct PID and all repository content is contained by its temp root.

#### Task 1.2: Freeze generated tests

**File**: `thoughts/tests/2026-08-27_real-development-session-evals.md`

- Map every acceptance criterion to an assertion.
- Record the failing baseline and SHA-256 of the generated E2E test.
- Treat the E2E assertions as immutable during implementation; implementation fixes belong in the
  runner, fixtures, scripts, and documentation.

### Phase 2: Implement the Synthetic Session Boundary

#### Task 2.1: Create explicit test-only repository content

**Files**: `test/fixtures/development-session/package.json`, `src/calculator.js`,
`test/calculator.test.js`, `spec.md`

- Use Node built-ins only.
- Seed a passing baseline plus named incomplete work that sessions deterministically implement.
- Mark every title, author, commit, summary, and body as synthetic test data.

#### Task 2.2: Implement the bounded session executable

**File**: `test/fixtures/development-session/session.mjs`

- Validate scenario JSON, absolute repo path, target type/id, agent ID, and requested named action.
- Call `dist/cli.js call ... --stdin` so each operation opens a real short-lived MCP HTTP session.
- Support only named actions required by the frozen tests: claim/checkpoint, rejected claim, release
  with handoff, finish/test/commit/complete, resume/test/commit/complete.
- Invoke Git and the fixture test command without shell interpolation.
- Emit exactly one JSON evidence object to stdout; diagnostic failures go to stderr/non-zero.

### Phase 3: Compiled Product Orchestration

#### Task 3.1: Complete daemon and repository harness

**File**: `test/development-sessions.e2e.test.ts`

- Build on the existing ephemeral port/temp data pattern without direct store access.
- Copy the static fixture to a temp root, initialize Git, and configure repository-local identity.
- Remove inherited `GIT_*` variables; use an empty temporary global config and template directory,
  disable system config/attributes and prompts, and pass that environment to every session.
- Register Workspace and create/open Project/Spec/Task through compiled CLI public commands.
- Start each session executable as a child process with explicit environment and capture its PID.
- Restart the daemon against the same data directory where required.

#### Task 3.2: Verify external evidence

**File**: `test/development-sessions.e2e.test.ts`

- Run the fixture tests independently after completion.
- Resolve each artifact commit with `git cat-file -e` and inspect its changed paths.
- Read completion/activity through compiled MCP HTTP calls and match summary, artifact, actor, and
  handoff note.
- Require a clean worktree and final expected source bytes.

### Phase 4: Align the Eval Contract

#### Task 4.1: Correct package scripts

**File**: `package.json`

- Make `test:e2e` build once and run both E2E files explicitly.
- Keep `test:evals` as the named deterministic gate alias.
- Exclude `test/**/*.e2e.test.ts` and legacy `test/e2e.test.ts` from unit and coverage commands.

#### Task 4.2: Correct published documentation

**Files**: `docs/evals.md`, `README.md`

- List only the scenarios the deterministic command executes.
- State the exact compiled/public interfaces and fixture boundaries.
- Describe complementary acceptance/integration tests without claiming they run under evals.
- Separate opt-in native live gates and fix the required macOS environment variable.
- State explicitly that the gate validates development-session mechanics, not model reasoning.

### Phase 5: Verification and Review

#### Task 5.1: Run feature and project quality gates

- Run the new E2E alone, both compiled E2E suites, typecheck, lint, format check, and full tests.
- Repeat the new E2E to detect leaked processes, ports, Git state, or timing flakiness.

#### Task 5.2: Summarize and post-review

- Create the project summary artifact required by `/summary`.
- Run `/post-review`, address every high/medium finding, and re-run affected gates.

---

## Task Dependencies

```yaml
dependencies:
  1.1: []
  1.2: [1.1]
  2.1: [1.1]
  2.2: [2.1]
  3.1: [1.2, 2.2]
  3.2: [3.1]
  4.1: [1.1]
  4.2: [3.2, 4.1]
  5.1: [3.2, 4.2]
  5.2: [5.1]
```

---

## Risk Analysis

### Edge Cases

- [x] Session output contains malformed or multiple JSON values.
- [x] A child process exits after committing but before release/completion.
- [x] The daemon restarts on the same data directory and an ephemeral replacement port.
- [x] A competitor receives the expected structured Claim conflict rather than a transport error.
- [x] Git is unavailable or lacks global identity.
- [x] Temporary paths contain spaces or Unicode.
- [x] Fixture tests fail and completion must not be recorded.

### Technical Risks

- [x] The CLI may hide MCP error details; assert structured stderr and non-zero status.
- [x] The session executable could become arbitrary command execution; allow only named fixed actions.
- [x] Artifact URIs could escape the fixture repository; parse fixed `git:<sha>` form and resolve in
      the explicit repo.
- [x] Existing Vitest exclusions may accidentally run E2E under coverage; use explicit patterns.

---

## Testing Strategy

- Tests-as-DoD: two compiled E2E scenarios in `test/development-sessions.e2e.test.ts`.
- Fixture self-test: `npm test` inside each temporary synthetic repository.
- Contract verification: compiled CLI `call` over MCP HTTP for work, activity, and completion.
- External evidence: Git object/path assertions and exact source bytes.
- Regression: existing `test/e2e.test.ts` plus full project quality command.
- Flake check: run the new E2E twice consecutively.

---

## Done Criteria

### Phase 1: Frozen Definition of Done

- [x] Two new E2E scenarios fail before runner implementation.
- [x] Manifest maps all PRD criteria and records the frozen test hash.

### Phase 2: Session Process

- [x] Every session result contains a distinct PID and structured evidence.
- [x] Session actions are allowlisted and use no shell interpolation.

### Phase 3: Real Development Workflow

- [x] Handoff test proves repository edit, checkpoint, competition, release note, second-agent test,
      commit, completion, and artifact resolution.
- [x] Restart test proves live Claim persistence, competitor rejection, same-agent process resume,
      repository test, commit, and completion.

### Phase 4: Honest Eval Contract

- [x] `npm run test:evals` runs both E2E files after one build.
- [x] `npm run test:unit` and coverage exclude both E2E files.
- [x] `docs/evals.md` and README match the actual command and platform gates.

### Spec Tests

- [x] All spec tests pass: `npx vitest run test/development-sessions.e2e.test.ts`
- [x] Frozen E2E assertions retain the manifest SHA-256 after implementation.

### Overall

- [x] Full quality passes: `npm run typecheck && npm run lint && npm run format:check && npm test`
- [x] New E2E passes twice consecutively.
- [x] No TODO/FIXME/HACK in new code.
- [x] No unrelated dirty-worktree file is modified by this feature.

---

## Verification

```bash
npm run build
npx vitest run test/development-sessions.e2e.test.ts
npm run test:evals
npm run typecheck
npm run lint
npm run format:check
npm test
```

Finish with `/summary` and `/post-review`.
