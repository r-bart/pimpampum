# Pimpampum

Local TypeScript daemon with a shared domain store, HTTP API and MCP interfaces.

> **This file is for agents working _on_ this codebase.** If you are an agent
> that wants to _use_ Pimpampum as shared project memory — install it, connect
> over MCP, claim and complete work — read [`docs/agents.md`](docs/agents.md)
> instead. It is short, and it is the whole contract.

## Commands

- **Dev**: `npm run dev`
- **Build**: `npm run build`
- **Quality**: `npm run typecheck && npm run lint && npm run format:check && npm test`

Run quality checks after every change.

## Code Style

- **Files**: PascalCase components, camelCase utils
- **Code**: camelCase vars/functions, PascalCase types
- **Unused**: Prefix with `_`

## Code Patterns

- Keep all invariants and transactions in `PimpampumStore`.
- HTTP, MCP and CLI must not reimplement domain rules.
- Never expose direct database access to agents or clients.
- Keep the live SQLite database on a local filesystem.

## Architecture

Markdown is opaque content, JSON is the wire contract, and SQLite is the canonical store.

## Workflow

- **New feature**: `/brief` → `/spec` → `/create-plan` → `/generate-tests` → `/execute-plan` → `/summary` → `/post-review`
- **Bug fix**: `/brief` → fix → test → `/summary`

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
