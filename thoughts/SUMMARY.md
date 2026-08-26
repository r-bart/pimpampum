# Current project summary

Pimpampum v0.1 is a local, agent-first coordinator for workspaces, PRDs, context, tasks, subtasks,
claims, activity, backup, and portable export.

The latest completed feature is daemon-owned automatic backup settings. A user or agent can choose
one synchronized destination from the macOS menu app, Omarchy Quattro, CLI, or authenticated API;
every committed mutation coalesces into an integrity-checked rolling SQLite snapshot while the live
database stays local.

See `thoughts/summaries/2026-08-26_automatic-backup-settings.md` for the implementation summary.
