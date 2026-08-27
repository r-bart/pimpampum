# Shared-folder synchronization implementation notes

- The live SQLite database remains machine-local. Only immutable, path-neutral JSON snapshots
  belong in a cloud-synchronized folder.
- A daemon writes only `Pimpampum/devices/<device-id>` and validates imported schema, hash,
  namespace, size, and monotonic device sequence before import.
- Workspace IDs synchronize, but absolute roots are local mappings. Claims, tokens, settings,
  locks, receipts, and backup destinations never synchronize.
- Store transactions notify backup and sync after commit. Synchronization failures never roll back
  local work, and identical state hashes suppress feedback loops.
- MCP exposes status, reconciliation, bounded conflict manifests, and paged candidates. It has no
  folder-configuration or conflict-winner tool.
- Settings are unconfigured by default. Choosing a folder enables automatic behavior; the toggle
  means pause/resume, while forgetting is a separate explicit action.
