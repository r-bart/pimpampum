# Pimpampum

Local TypeScript daemon with a shared domain store, HTTP API and MCP interfaces.

> **This file is for agents working _on_ this codebase.** If you are an agent
> that wants to _use_ Pimpampum as shared project memory — install it, connect
> over MCP, claim and complete work — read [`docs/agents.md`](docs/agents.md)
> instead. It is short, and it is the whole contract.

## Process

[`CLAUDE.md`](CLAUDE.md) is the single source for process: commands, code style, code patterns,
architecture invariants, workflow, skills, gotchas, and the release checklist. This file only
restates the parts an agent needs before opening it.

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
- HTTP, MCP and CLI must not reimplement domain rules.
- Never expose direct database access to agents or clients.
- Keep the live SQLite database on a local filesystem.

## Architecture

Markdown is opaque content, JSON is the wire contract, and SQLite is the canonical store. The
persistent daemon exposes authenticated JSON HTTP and MCP-over-HTTP; the stdio MCP bridge and the
CLI call that daemon. The layer map lives in [`.claude/rules/architecture.md`](.claude/rules/architecture.md).

## Workflow

- **New feature**: `/brief` → `/spec` → `/create-plan` → `/generate-tests` → `/execute-plan` → `/summary` → `/post-review`
- **Bug fix**: `/brief` → fix → test → `/summary` → `/post-review`
- **Refactor**: `/brief` → `/create-plan` → implement → `/summary` → `/post-review`

The skill list and the gotchas are in `CLAUDE.md`.
