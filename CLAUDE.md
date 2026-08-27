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
