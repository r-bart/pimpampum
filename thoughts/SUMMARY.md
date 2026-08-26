# Current project summary

Pimpampum v0.1 is a local, agent-first coordinator for workspaces, PRDs, context, tasks, subtasks,
claims, activity, backup, and portable export.

The latest completed feature is the agent-first CLI. MCP remains canonical; shell-only agents can
inspect redacted configuration, discover the live tool catalog, and invoke every tool through
bounded deterministic JSON using `pimpampum config`, `pimpampum tools`, and `pimpampum call`.

See `thoughts/summaries/2026-08-26_agent-first-cli.md` for the implementation summary and
`thoughts/notes/2026-08-26_agent-first-cli.md` for strict review lessons.
