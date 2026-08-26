# Agent Workflow Evals

Pimpampum keeps one small deterministic evaluation suite for the workflows that matter to agents. It runs the compiled daemon, CLI, HTTP API, and MCP stdio bridge against temporary real SQLite databases. The suite is repository-only and requires a full source checkout; it is not part of the published runtime tarball.

Run it with:

```bash
npm run test:evals
```

## Rubric

The suite has nine equally required evaluations. A release passes only when every evaluation passes; there is no partial score and no retry that hides a first failure.

| Evaluation          | Product behavior under evaluation                                                    | Pass condition                                                                    |
| ------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Project delivery    | Workspace registration, project and PRD creation, task claim, completion, and export | The compiled interfaces preserve revisions and produce a portable export          |
| Agent-first CLI     | Offline configuration, discovery, and every MCP tool through the shell fallback      | A shell-only agent can use the complete canonical contract with JSON envelopes    |
| MCP project context | PRD and contextual Markdown management through the MCP bridge                        | MCP round-trips exact bounded documents through the shared daemon                 |
| Competing agents    | Parent/subtask ordering, claims, idempotency, and artifact recovery                  | Only claimable work is offered and concurrent ownership remains safe              |
| Contract safety     | Authentication, optimistic concurrency, and the no-delete boundary                   | Unauthorized, stale, and intentionally unsupported operations fail explicitly     |
| Process continuity  | Daemon restart and single-instance ownership                                         | State survives restart and a second daemon cannot own the same data directory     |
| Data recovery       | SQLite backup, restore, and portable export                                          | The restored instance is usable and exportable without losing project state       |
| Automatic backup    | Configuration, post-mutation refresh, failure isolation, recovery, and disable       | The rolling snapshot recovers while committed project work remains valid          |
| Local lifecycle     | Install, status, reconciliation, uninstall, and persistence                          | Per-user artifacts are exact, repeat install is idempotent, and user data remains |

## Evaluation boundaries

- The tests execute `dist/cli.js` and `dist/mcpStdio.js`, never TypeScript-only entry points.
- Network calls use an authenticated loopback daemon on an ephemeral port.
- MCP calls use the published tool metadata and schemas.
- Persistent scenarios use real temporary files and SQLite databases.
- Every run starts from clean temporary state and removes it afterward.

## Platform release gate

The separate Quattro gate is opt-in, target-specific, and repository-only; it remains outside
`npm run test:evals` because it temporarily mutates the real per-user shell and requires visual
review. From a full source checkout, run `npm run build`, then
`PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live`, inspect and approve the captured UI, and
finally run `npm run test:e2e:omarchy`. Schema-v2 evidence binds the exact candidate to lifecycle
transcripts, baseline restoration, and the reviewed screenshots. The published package ships the
non-mutating checker, which accepts explicit evidence and candidate paths through
`npm run check:quattro-evidence -- <evidence> <candidate>`.

These evals judge Pimpampum's coordination contract, not the quality of any particular model's prose or planning. Model-specific evals can be layered on later without weakening this deterministic release gate.
