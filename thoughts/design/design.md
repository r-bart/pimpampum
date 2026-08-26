# Design Log

## 2026-08-26 — Automatic Backup Settings

- Scope is two small settings surfaces inside the existing macOS and Quattro integrations; no new dashboard or navigation layer.
- Both clients render server-owned state and never persist a duplicate destination.
- macOS uses its native directory picker. Quattro prefers Qt's folder dialog and keeps a manual absolute-path fallback for runtime portability.
- Status language is shared: disabled, pending, healthy, error.
- The existing compact project/work indicator is unchanged.
- Wireframes approved from the user's explicit request and established minimal product direction.
