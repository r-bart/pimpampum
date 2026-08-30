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
- ALWAYS amend the spec first and then refresh the digest in `scripts/check-desktop-status-contract.mjs` when a frozen acceptance test must change.
- NEVER import application modules at module scope in `src/cli.ts`; it is a bootstrap that loads `src/cliMain.ts` dynamically so startup failures still emit a JSON envelope.
- ALWAYS pass the entry module URL into `runCliEntrypoint`; deriving it from `cliMain.ts` would point launchd and systemd at the wrong file.
- NEVER give CLI failures distinct exit codes; the Omarchy helpers `exec` the CLI and already reserve 64 and 127, and every consumer branches on non-zero then parses the envelope.
- ALWAYS sweep `scripts/` as well as `integrations/` and `platforms/` when changing CLI output; the live runners and the evidence validator parse it too.
- NEVER pick a desktop asset or color from `bar.background`; on a transparent bar Omarchy resolves it to the foreground via `omarchy-bar-text-color`, so paint from `bar.barForeground`.
- NEVER paint popout content from `bar.barForeground`; the popout draws on Omarchy's popup card, so read `Color.popups.text` and `Color.popups.background` or the labels vanish into the card on a light wallpaper.
- NEVER tint a bar icon through a `MultiEffect` over a `layer.enabled` source; the cached texture keeps its first color and survives a wallpaper change. Draw it with `Shape`/`ShapePath` and `fillColor`.
- ALWAYS restart the shell (`omarchy restart shell`) to verify a plugin QML change; `rescanPlugins` reloads the plugin but the QML engine keeps the already-compiled components, so edits appear to do nothing.
- ALWAYS preview an Omarchy popout layout change in a `qml6` harness with stubbed `Style`/`Color` tokens and `grabToImage`; nothing opens the popout from the CLI, so a shell restart alone proves only that it parses.

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
