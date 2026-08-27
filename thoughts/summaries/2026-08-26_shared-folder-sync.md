# Shared-folder synchronization summary

Implemented provider-neutral synchronization across independent Pimpampum daemons. Each device
keeps SQLite and machine-specific state locally, publishes immutable complete JSON snapshots to its
own shared-folder namespace, imports on startup/poll/manual request, and exports automatically after
committed mutations.

Unrelated entity changes converge. Divergent same-base candidates remain durable conflicts;
conflicted entities reject further mutation while unrelated work remains available. Explicit
CLI/HTTP resolution converges causally on every device; imported deletions are transactional and a
failed local-ledger write is safely replayable. Added
HTTP/OpenAPI/client operations, CLI `sync` commands, bounded MCP tools, macOS Settings, Omarchy
Quattro controls, documentation, adversarial coverage, and a compiled two-daemon E2E.
