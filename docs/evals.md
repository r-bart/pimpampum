# Agent Workflow Evals

Pimpampum keeps one small deterministic evaluation suite for the workflows that matter to agents. It runs the compiled daemon, CLI, HTTP API, and MCP stdio bridge against temporary real SQLite databases.

Run it with:

```bash
npm run test:evals
```

## Rubric

The suite has seven equally required evaluations. A release passes only when every evaluation passes; there is no partial score and no retry that hides a first failure.

| Evaluation          | Product behavior under evaluation                                                    | Pass condition                                                                    |
| ------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Project delivery    | Workspace registration, project and PRD creation, task claim, completion, and export | The compiled interfaces preserve revisions and produce a portable export          |
| MCP project context | PRD and contextual Markdown management through the MCP bridge                        | MCP round-trips exact bounded documents through the shared daemon                 |
| Competing agents    | Parent/subtask ordering, claims, idempotency, and artifact recovery                  | Only claimable work is offered and concurrent ownership remains safe              |
| Contract safety     | Authentication, optimistic concurrency, and the no-delete boundary                   | Unauthorized, stale, and intentionally unsupported operations fail explicitly     |
| Process continuity  | Daemon restart and single-instance ownership                                         | State survives restart and a second daemon cannot own the same data directory     |
| Data recovery       | SQLite backup, restore, and portable export                                          | The restored instance is usable and exportable without losing project state       |
| Local lifecycle     | Install, status, reconciliation, uninstall, and persistence                          | Per-user artifacts are exact, repeat install is idempotent, and user data remains |

## Evaluation boundaries

- The tests execute `dist/cli.js` and `dist/mcpStdio.js`, never TypeScript-only entry points.
- Network calls use an authenticated loopback daemon on an ephemeral port.
- MCP calls use the published tool metadata and schemas.
- Persistent scenarios use real temporary files and SQLite databases.
- Every run starts from clean temporary state and removes it afterward.

These evals judge Pimpampum's coordination contract, not the quality of any particular model's prose or planning. Model-specific evals can be layered on later without weakening this deterministic release gate.
