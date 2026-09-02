# Agent workflow evals

Pimpampum has one portable, deterministic end-to-end gate for its compiled coordination contract
and local development-session mechanics. Run it from a full source checkout with:

```bash
npm run test:evals
```

The command is an alias of `npm run test:e2e`. It builds the TypeScript product once, then runs
exactly these twelve tests:

- Seven compiled product scenarios from `test/e2e.test.ts`.
- Two synthetic development-session scenarios from `test/development-sessions.e2e.test.ts`.
- Two update-channel scenarios from `test/update-channel.e2e.test.ts`.
- One two-machine synchronization scenario from `test/sync.e2e.test.ts`.

Every scenario must pass. The gate does not retry failures or assign a partial score.

## Compiled product scenarios

The seven product scenarios exercise the shared daemon and SQLite store through public compiled
boundaries:

1. A complete multi-Spec portfolio workflow, including independently scoped Context, direct Spec
   work, Task and Subtask Claims, competing ownership, renewal, release notes, pause/reopen, and
   terminal completion.
2. Atomic cancellation of Task, Spec, and Project trees, including descendant state, activity, and
   Claim cleanup.
3. State continuity across daemon restart, rolling SQLite backup and restore, and portable schema-v2
   export.
4. Authentication and the canonical v2 HTTP, MCP, Claim-target, and overview contracts, including
   rejection of obsolete routes and tool names.
5. Twenty concurrent HTTP Claims on one target: exactly one is granted and nineteen are rejected
   with `409`.
6. Twenty concurrent `work_start` calls through the compiled stdio MCP bridge, after mutating
   through it: exactly one is granted.
7. `help`, `version`, `commands`, and `config` answered from a read-only home directory without
   writing anything.

These tests start the compiled daemon on loopback, use the compiled administrative CLI and
authenticated HTTP API for setup and lifecycle operations, and exercise the compiled MCP stdio
bridge for its published agent contract. They use real temporary SQLite files rather than an
in-memory domain substitute.

## Synthetic development sessions

The two development-session scenarios add repository work around that coordination protocol:

1. One independent child process claims a Task, makes a partial source edit and checkpoint commit,
   defeats a competing Claim, then releases with a handoff note. A second process claims the same
   Task, finishes the source change, runs the repository tests, commits, and completes the work.
2. A child process claims work and creates a tested checkpoint, the compiled daemon restarts against
   the same SQLite data, a competitor remains excluded, and a new process with the original stable
   `agentId` resumes idempotently and completes the Spec.

Each session is a separate operating-system process. It calls the compiled `dist/cli.js call`
command, which negotiates with the daemon's authenticated MCP HTTP endpoint. The orchestrator does
not call `PimpampumStore` directly.

Every development workspace is a disposable Git repository containing only checked-in synthetic
fixture content. The sessions perform real file edits, run a real Node test command, and create real
Git commits with repository-local test identity. Before accepting completion, the orchestrator
independently verifies final source bytes, passing tests, a clean worktree, changed paths, and every
reported `git:<commit>` artifact against that temporary repository.

## Update-channel scenarios

The two update-channel scenarios start a loopback HTTP server that answers a redirect and then the
signed `release-manifest.json` the release pipeline emits:

1. With `PIMPAMPUM_DEV_RELEASE_KEY=1` and `PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH`, the compiled
   `update:check` follows the redirect, verifies the signature with the development key, and
   resolves the manifest.
2. Without the development flag, the same manifest is refused with the typed `unavailable` code, so
   a release build never trusts a key from disk.

## Synchronization scenario

Two compiled daemons with separate data directories share one temporary folder as the synchronized
location. Every Project moves from one machine to the other, and unrelated concurrent work on both
sides merges without a conflict. The scenario runs through the compiled CLI and HTTP API only.

## Deterministic boundaries

- Daemons bind to authenticated loopback ports selected for the test run.
- Product state, repositories, Git configuration, and generated artifacts stay under temporary
  directories and are removed afterward.
- The suite requires local Node.js and Git, but no network, credentials, package installation, or
  external repository.
- It exercises compiled public interfaces; TypeScript-only shortcuts and direct database access are
  outside the session contract.
- It validates Claim ownership, handoff, restart, testing, commits, and artifact mechanics. It does
  not launch Codex or another LLM, generate code with a model, or score model reasoning quality.

## Complementary automated suites

The regular unit, acceptance, integration, migration, OpenAPI, packaging, desktop-contract, and
platform-service tests provide broader focused coverage under `npm test` and the platform-specific
commands. They are complementary evidence, not additional scenarios hidden inside
`npm run test:evals`.

In particular, focused suites cover edge cases such as Claim expiry, populated v1 migration,
automatic-backup failure and recovery, exhaustive CLI/MCP schemas, and native contract fixtures.
Their presence must not be interpreted as membership in the twelve-test eval gate.

## Opt-in native live gates

Native live tests are intentionally separate because they depend on a target desktop and may mutate
the current user's installed integration.

Build and test the macOS app locally, then explicitly opt into its live install/recovery/uninstall
flow:

```bash
npm run build:macos
npm run test:macos
PIMPAMPUM_RUN_LIVE_MACOS=1 npm run test:e2e:macos
```

Run the Omarchy Quattro live workflow only on its target environment:

```bash
npm run build
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
```

`npm run test:e2e:omarchy` is not the live workflow. It validates the plugin and checks previously
captured lifecycle, restoration, and screenshot evidence without performing the live installation:

```bash
npm run test:e2e:omarchy
```

The portable twelve-test eval gate and these opt-in native gates answer different questions and do
not invoke one another.
