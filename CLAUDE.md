# Pimpampum

A local, agent-first project manager. One daemon owns the SQLite database; HTTP, MCP, and CLI are adapters around the same domain store.

## Commands

- **Dev**: `npm run dev`
- **Build**: `npm run build`
- **Quality**: `npm run typecheck && npm run lint && npm run format:check && npm test`

Run quality checks after every change.

## Code Style

- **Files**: camelCase modules, PascalCase types
- **Code**: camelCase vars/functions, PascalCase types
- **Unused**: Prefix with `_`

## Code Patterns

- Only `PimpampumStore` accesses SQLite; API, MCP, and CLI use the gateway contract.
- Completion is a domain operation, never a freely writable state.

## Architecture

The persistent daemon exposes authenticated JSON HTTP and MCP-over-HTTP. The stdio MCP bridge and CLI call that daemon, preserving one canonical instance. SQLite stays on a local filesystem; backups and portable exports may target synced folders.

## Workflow

- **New feature**: `/brief` → `/spec` → `/create-plan` → `/generate-tests` → `/execute-plan` → `/summary` → `/post-review`
- **Bug fix**: `/brief` → fix → test → `/summary` → `/post-review`
- **Refactor**: `/brief` → `/create-plan` → implement → `/summary` → `/post-review`

> `/brief` for session orientation (with pre-flight checks). `/summary` to document changes. `/checkpoint` to save progress.

## Available Skills

- `/brief` — Session orientation with pre-flight checks
- `/spec` — Product specification interview (PRD)
- `/research` — Codebase investigation (--deep, --external)
- `/create-plan` — Phased implementation plan with task dependencies
- `/execute-plan` — Parallel phase execution of plans
- `/loop` — Autonomous convergence loop from loop.manifest.yaml
- `/quick` — Fast ad-hoc tasks: implement, verify, commit
- `/generate-tests` — Failing tests from spec (Tests-as-DoD)
- `/post-review` — Pre-PR review (architecture, quality, requirements)
- `/audit` — Codebase audit (security, complexity, architecture)
- `/summary` — Post-change documentation
- `/checkpoint` — Save session progress for resumption
- `/backlog` — Issue management with BACK-### IDs
- `/investigate` — Deep error and bug analysis
- `/learn` — Post-task teaching breakdown
- `/scaffold` — Create new projects from scratch
- `/setup` — Interactive project configuration
- `/worktree` — Git worktree management
- `/opensrc` — Fetch npm/GitHub source for full context
- `/create-skill` — Generate new custom skills
- `/devtronic-help` — Discover skills, agents, addons, and workflows from the IDE

## Project Notes

Maintain notes in `thoughts/notes/` updated after every PR.

## Gotchas

<!-- Claude fills this section via self-improvement. Do not delete. -->

- ALWAYS build with `npm run build`; it cleans `dist/` and uses `tsconfig.build.json` so tests never ship.
- ALWAYS run compiled E2E through `npm test` or `npm run test:e2e`; a clean checkout has no ignored `dist/` directory.
- ALWAYS point runtime scripts at `src/daemon.ts`; `src/server.ts` is import-safe composition only.
- NEVER create a project in `done`; call the completion operation so summary, artifacts, timestamps, revisions, and claims remain consistent.
- NEVER add subtasks while their parent task is claimed.
- ALWAYS create SQLite backups locally, run `integrity_check`, then copy and atomically rename them in the destination.
- ALWAYS create backup/settings partial files with unique names and exclusive creation; never reuse a predictable partial path that could be a symlink.
- NEVER flatten typed daemon errors in HTTP/MCP clients; preserve their stable error codes.
- NEVER return PRDs, task bodies, context bodies, or artifact arrays from MCP list/work tools; return manifests and bounded reads.
- ALWAYS enforce loopback binding and one instance lock inside runtime composition, not only environment parsing.
- NEVER start a portable export while claims are active; it is a synchronous maintenance operation.
- ALWAYS validate bearer tokens as printable non-space ASCII before constructing HTTP headers.
- ALWAYS isolate Git-driven evals: strip inherited `GIT_*`, disable system config/attributes, and use temporary empty global config and template paths.
- NEVER hash build inputs by walking the filesystem; enumerate them with `git ls-files --cached` so ignored files like `.DS_Store` cannot change artifact identity.
- NEVER put a state in a live review matrix that a healthy installation cannot show; keep it in automated tests and record the exclusion explicitly.
- NEVER abort `install` on a recoverable login-item state (`error`, `requiresApproval`); record it in the receipt and let the menu app's notice handle retry.
- NEVER print `asAppError` output from the CLI entrypoint; use `createLocalErrorEnvelope` so install/uninstall failures keep their real message and cause chain locally (HTTP/MCP stay flattened).
- ALWAYS print CLI success through `print`, which wraps in `{data}`; only `call` uses `printEnvelope`, because the daemon already enveloped that payload.
- ALWAYS declare a new CLI verb in `src/cliCommands.ts`; `pimpampum help` and `pimpampum commands` are both generated from that table and must never be hand-edited.
- NEVER hardcode a version string, tests included; import `PIMPAMPUM_VERSION` from `src/version.ts`, which reads `package.json`. A release bump breaks any test that spelled the old one.
- NEVER map a transport failure to `internal_error`; use `unavailable`, whose suggestion names `pimpampum status` and `pimpampum install`.
- ALWAYS keep the Omarchy QML readers tolerant of both the bare payload and the `{data}` envelope, so an installed plugin survives a CLI upgrade.
- ALWAYS amend the spec first and then refresh the digest in `scripts/check-desktop-status-contract.mjs` when one of the four `test/fixtures/overview/*.json` fixtures must change; those fixtures are the only frozen artifacts (decision of 2026-09-01, H-14), and acceptance test files are edited like any other test together with the spec item they name.
- NEVER import application modules at module scope in `src/cli.ts`; it is a bootstrap that loads `src/cliMain.ts` dynamically so startup failures still emit a JSON envelope.
- ALWAYS pass the entry module URL into `runCliEntrypoint`; deriving it from `cliMain.ts` would point launchd and systemd at the wrong file.
- NEVER give CLI failures distinct exit codes; the Omarchy helpers `exec` the CLI and already reserve 64 and 127, and every consumer branches on non-zero then parses the envelope.
- ALWAYS sweep `scripts/` as well as `integrations/` and `platforms/` when changing CLI output; the live runners and the evidence validator parse it too.
- ALWAYS sweep `scripts/test-macos-live.mjs` when changing the guided setup's first screen or its accessibility labels; the live smoke asserts one exact label and only the release job runs it, so a green local suite still fails the tag.
- ALWAYS re-read `scripts/test-macos-live.mjs` when changing how `OverviewStore` reports a state; each snapshot launches a fresh app, so anything that delays a state — like the cold-start grace before reporting offline — must be waited for instead of read from the first frame.
- NEVER pin Omarchy runtime hashes from a bundle built on macOS; `build-runtime-bundle.mjs` is deterministic per host, not across hosts, so a macOS build yields a different digest than the Linux runner and the release fails at `Build release assets`. Build in a Linux container, or take the digests CI printed and re-tag: CI reproduces them exactly across runs.
- NEVER pick a desktop asset or color from `bar.background`; on a transparent bar Omarchy resolves it to the foreground via `omarchy-bar-text-color`, so paint from `bar.barForeground`.
- NEVER paint popout content from `bar.barForeground`; the popout draws on Omarchy's popup card, so read `Color.popups.text` and `Color.popups.background` or the labels vanish into the card on a light wallpaper.
- NEVER tint a bar icon through a `MultiEffect` over a `layer.enabled` source; the cached texture keeps its first color and survives a wallpaper change. Draw it with `Shape`/`ShapePath` and `fillColor`.
- ALWAYS restart the shell (`omarchy restart shell`) to verify a plugin QML change; `rescanPlugins` reloads the plugin but the QML engine keeps the already-compiled components, so edits appear to do nothing.
- ALWAYS preview an Omarchy popout layout change in a `qml6` harness with stubbed `Style`/`Color` tokens and `grabToImage`; nothing opens the popout from the CLI, so a shell restart alone proves only that it parses.
- ALWAYS read BOTH streams of the CLI from a desktop adapter; `src/cli.ts` writes the typed error envelope to **stderr** and leaves stdout empty on a failure, so a stdout-only reader shows a generic connection guess.
- ALWAYS drain a `Process`'s stdout and stderr concurrently (two dispatch queues, then `waitUntilExit`); draining one to EOF first lets the child block on the other pipe's full buffer.
- ALWAYS read a `Process` pipe to EOF before `waitUntilExit()`; the reverse order deadlocks once output exceeds the pipe buffer.
- NEVER send a `Process` stream to `FileHandle.nullDevice` just to dodge the pipe-buffer deadlock; you throw away the diagnosis. Drain it concurrently instead.
- NEVER collapse a failed `npm` invocation to `"<operation> failed"`; quote a bounded line from its stderr, or a registry policy, a permission error, and an offline machine become one message.
- ALWAYS put macOS copy decisions in a covered presentation type, never in a SwiftUI body; `scripts/check-swift-coverage.sh` demands 100% and its manifest cannot include a view.
- NEVER approve a macOS artifact locally to ship it; approval happens in the `publish` job of `.github/workflows/release.yml`, where `check-macos-artifact.mjs --approve --require-signature --require-notarization` records `sourceGitCommit` from the tagged checkout after the live smoke. `npm run approve:macos` exists to debug the checker on a committed tree, and its output is ignored by Git.
- NEVER derive a test fixture path from `process.cwd()`'s parent; it silently binds the test to the checkout directory name. Build a temporary directory instead.
- ALWAYS mirror a new `HelpDialogCopy.items` entry in `HelpDialogTests`; that list is frozen copy and the macOS CI job runs `npm run test:macos`.
- ALWAYS regenerate the README `CLI reference` block from `pimpampum help` when you touch `src/cliCommands.ts`; `test/cli-agent-surface.test.ts` compares the whole block and a new verb otherwise ships undocumented.
- ALWAYS update `integrations/omarchy/pimpampum-status/README.md` and the `Native status surfaces` section of `README.md` when a settings card gains a write action; both still claimed the panels were read-only apart from sync and backup after updates shipped.
- NEVER document an MCP tool count from `src/mcp.ts` alone; the daemon registers four `sync_*` tools that `src/mcpStdio.ts` does not, so a live `tools/list` returns 36 over HTTP and 32 over stdio.
- ALWAYS uninstall the local integration before `PIMPAMPUM_RUN_LIVE_MACOS=1 npm run test:e2e:macos`; it refuses to run beside a user installation, and restoring one afterwards can need a retry because the login handshake allows only 10 seconds.
- NEVER decode CLI output in a desktop adapter by splitting on newlines alone; `printEnvelope` indents with `JSON.stringify(value, null, 2)`, so parse the whole buffer as one object first and only then fall back to NDJSON lines.
- NEVER feed a decoder test a hand-compacted envelope the CLI cannot emit; copy the exact bytes a real `pimpampum` invocation writes, or the test pins the decoder against itself.
- NEVER set a `SetupStore` activity that reports `hasBegunMutation` before confirming a journal is running; `SetupOnboardingView` jumps to the final step on that flag and never moves back.
- ALWAYS derive the onboarding's initial `@State` from `SetupOnboardingStep.first`; a literal case silently hides any step inserted ahead of it.
- NEVER plan artifacts from the app bundle in a read-only or uninstall path; an installed CLI runs from the packaged runtime with no build tree, so gate it behind `canPlanArtifacts` and verify the receipt against disk instead.
- ALWAYS trust `check-swift-coverage.sh` only for the files in its `covered_sources` manifest. Since 2026-09-02 it covers the setup lifecycle: `SetupStore`, `SetupSession`, `SetupCommandRunner`, `EmbeddedSetupBootstrap`, `ApplicationLaunchCoordinator`, `ApplicationLocationRecord`, `SetupOnboardingPresentation`, and `WorkspaceRegistration`. `App.swift`, the SwiftUI bodies, `EmbeddedSetupSystemAdapters.swift`, and `WorkspaceFolderPicker.swift` stay outside; widen the manifest when you cover another file rather than reporting a number that excludes the code you changed.
- NEVER present a `.sheet` from a menu-bar popover; the sheet is a real window, the popover closes as soon as it loses key focus, and the whole surface disappears. Render the content inside the popover and close it with a callback the presenting view owns, never `@Environment(\.dismiss)`.
- NEVER set `createsNewApplicationInstance = true` unconditionally when relaunching; login-item registration completes several phases earlier and may already have started the installed copy, leaving two menu-bar apps fighting over one popover.
- ALWAYS leave the progress step something to report; hiding the background service while it behaves blanks the whole screen when the user selected no agents.
- NEVER add `platforms/macos/dist/` to a commit; `.gitignore` ignores that tree except `.npmignore`, a local `npm run build:macos` produces an unsigned artifact, and only the release `publish` job approves the signed one. The copy still tracked from earlier releases is removed with `git rm --cached` in remediation wave 4 (L-38).
- NEVER write inside the app bundle after signing; `Contents/Resources/installation.json` broke the code seal of the Developer ID copy (L-21). Markers live under `~/Library/Application Support/Pimpampum/`.
- ALWAYS name the launcher by absolute path in native copy (`~/Library/Application Support/Pimpampum/bin/pimpampum-control`, `~/.local/share/pimpampum/bin/pimpampum-control`); nothing puts it on `PATH`, so a bare `pimpampum` in a popover or popout is a command the user cannot run.
- NEVER `await task.value` from a store method that a SwiftUI `.task` drives; cancelling the view task leaves the store waiting forever. Use a continuation resumed on completion and in `onCancel`.
- ALWAYS run `npx vitest run test/sync-state.test.ts` under `LANG=da_DK.UTF-8 LC_ALL=da_DK.UTF-8` and `LANG=cs_CZ.UTF-8 LC_ALL=cs_CZ.UTF-8` when touching `src/syncState.ts`; the canonical order must not depend on the daemon locale (H-04), and `quality.yml` runs both.
- NEVER reinstall the same version with different bytes; the runtime installer verifies sizes against its inventory and fails with `size drift`. Remove `~/Library/Application Support/Pimpampum/{Runtime,bin}` first when iterating locally.
- ALWAYS verify a macOS fix from an installed copy outside the checkout; running from `platforms/macos/dist/` hides every defect that depends on the build tree being absent, and a bundle under `~/Desktop` also triggers a TCC prompt that closes the popover.
- NEVER gate the guided setup confirmation on a non-empty agent selection; the success metrics require a setup with no supported agents to complete, and `canReview` demanding one made the service uninstallable on a Mac where nothing was detected.
- NEVER reject symlinks when detecting an agent; Codex and Claude Code install as links into `~/.local/bin`, so resolve with `resolvingSymlinksInPath()`. Detection reads presence only and executes nothing.
- ALWAYS render the confirmation screen from `SetupPlan.changes`, never from a Swift constant; the plan carries the real `path` for every target and a hand-written summary silently drifts from the installer.
- ALWAYS request the setup plan before the confirmation button, not inside its handler; otherwise the user authorizes an operation id and revision that did not exist when they agreed.
- NEVER expect `require('typescript')` to give you the compiler API; TypeScript 7 ships only `tsc.js` and `version.cjs`, so `ts.createSourceFile` is undefined. Measure structure with `npx oxlint src -c <config>` enabling `complexity` and `max-lines-per-function`.
- NEVER report a structural limit as met when no command evaluates it; `.oxlintrc.json` enables neither `complexity` nor `max-lines-per-function`, so `npm run lint` never checked Gate 9's "100 body lines or cyclomatic 25". Fifteen `src/` units break it; see `thoughts/notes/2026-09-02_structure-gate-measurement.md`.

## Release checklist

Before the tag:

1. Update the public surfaces to the release: `README.md`, `site/src/pages/index.astro`,
   `site/public/llms.txt`, `integrations/omarchy/pimpampum-status/README.md`, and `CHANGELOG.md`.
2. Set the `Status` of every plan the release closes to `Complete — released as vX.Y.Z`; amend a spec
   the product diverged from with a dated section.
3. Run `node scripts/check-release-versions.mjs vX.Y.Z`, `npm run check:omarchy-mirror`, and
   `npm run check:package-size`.
4. Run `PIMPAMPUM_RUN_LIVE_MACOS=1 npm run test:e2e:macos` on a Mac with no user installation.

Once per repository, not per release: `gh secret set RELEASE_MANIFEST_SIGNING_KEY` (the Ed25519
private key that signs `release-manifest.json`) and `gh secret set OMARCHY_MIRROR_DEPLOY_KEY` (the
deploy key that pushes `integrations/omarchy/pimpampum-status` to `r-bart/pimpampum-omarchy`).

## Self-Improvement

After every significant correction, update this file:

"Update CLAUDE.md so you don't make that mistake again."

Add learned rules to the **Gotchas** section above. Keep rules:

- Concise (one line each)
- Absolute directives (ALWAYS/NEVER)
- Concrete with actual commands/code

## References

- **README.md** — Architecture, interfaces, and operations
- **thoughts/specs/** — Product requirements and feature matrix
- **thoughts/plans/** — Implementation plans and verification evidence
- **.claude/agents/** — Specialized helpers
