# Quattro live matrix: what a reviewer can honestly attest

The Quattro live smoke ends with a named human typing `yes` to the question "did you directly
observe every Task 3.3 matrix item during this run". The evidence checker refuses anything else.
The matrix as first written contained three items no reviewer could observe on a healthy
installation, which made an honest `yes` impossible and the release gate unreachable.

## The three items

- **`incompatible`.** The widget enters this state when `envelope.meta.schemaVersion !== 2`
  (`OverviewService.qml`). The daemon pins that value: `overviewContract.ts` declares
  `z.literal(2)` and `http.ts` emits it. A healthy daemon cannot produce anything else. The only
  ways to show it are a stubbed `PIMPAMPUM_CLI` or a fixture, and the plugin README already rules
  both out as live evidence.
- **`importing` and `exporting`.** `syncController.ts` sets each one at the start of a local
  filesystem operation and clears it when that operation returns. The widget polls; whether a poll
  lands inside that window is luck, not verification.

All three remain covered by automated tests (`service-omarchy.test.ts`, `omarchy-plugin.test.ts`,
and the sync controller suite).

## What changed

`TASK_3_3_REVIEW_MATRIX` no longer lists them. A sibling `TASK_3_3_AUTOMATED_ONLY` names each one
with the reason it is excluded. Both are printed in the review prompt and hashed into the approval
binding, so the evidence records exactly what was and was not observed rather than deferring the
exclusion silently. The evidence schema itself is unchanged; the checker's `visualReview` shape is
deliberately stable and gains no authored flags.

## Interruption reporting

Ctrl+C during a prompt aborted readline with an `AbortError`, which escaped the runner as an
uncaught exception and printed a Node stack trace after the cleanup had already restored the
Omarchy baseline. The trace made a clean abort look like a crash. The runner now reports the
interruption itself (`interrupted by SIGINT`) in the failure diagnostic and exits 130 with one
line. Cleanup behaviour is unchanged and was verified: `before == after` in the recorded failure
diagnostic from the aborted run.
