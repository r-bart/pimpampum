# Measuring Gate 9: units over 100 body lines or cyclomatic 25

**Date**: 2026-09-02
**Type**: Measurement + open decision
**Branch**: `remediation/deep-review`

## Why this note exists

Gate 9 of the deep-review remediation plan reads:

> no `src/` unit over 100 body lines or cyclomatic 25 outside the declarative list

Two things were missing when wave 4 was committed. No declarative list was ever written down, and
no tool in the repository measures either limit. `npm run lint` uses `oxlint` with the repository
configuration, which enables neither rule, so the clause had never been evaluated. The rest of
Gate 9 does pass and is checkable: `cliMain.ts` is covered and out of the coverage exclusion,
`StatusPopout.qml` is 307 lines, and the duplication groups named in section 6 of the review are
gone.

## The command

`oxlint` implements both ESLint rules; they are simply not in `.oxlintrc.json`. Measure with a
throwaway configuration so the repository gate is untouched:

```bash
cat > /tmp/oxlint-gate9.json <<'JSON'
{
  "rules": {
    "complexity": ["error", { "max": 25 }],
    "max-lines-per-function": ["error", { "max": 100, "skipComments": true, "skipBlankLines": true }]
  }
}
JSON
npx oxlint src -c /tmp/oxlint-gate9.json
```

`max-lines-per-function` counts the physical lines of the function, blank and comment lines
excluded. It is close to, not identical with, the "body lines" the review's hotspot table used.

## The measurement of 2026-09-02

Fifteen units break one of the two limits, in sixteen violations.

### The nine the exception was written for

Each is a factory that returns an object of small methods, or a registration block. Its length is
the size of a surface, not the size of a decision. Splitting them moves declarations between files
without lowering the branching of any single path.

| Unit                                                           | Lines | Kind               |
| -------------------------------------------------------------- | ----- | ------------------ |
| `src/mcp.ts:132` `buildMcpServer`                              | 630   | Tool registration  |
| `src/setup/coordinator.ts:280` `createSetupCoordinator`        | 492   | Factory            |
| `src/http.ts:122` `createHttpApp`                              | 416   | Route registration |
| `src/setup/coordinator.ts:800` `createInstallationLifecycle`   | 360   | Factory            |
| `src/connectors/core.ts:301` `createHostConnectorCore`         | 265   | Factory            |
| `src/service/macosApp.ts:624` `createMacOSDesktopAdapter`      | 262   | Adapter factory    |
| `src/service/omarchy.ts:561` `createOmarchyAdapter`            | 188   | Adapter factory    |
| `src/connectors/claudeCode.ts:193` `createClaudeCodeConnector` | 122   | Factory            |
| `src/service/launchd.ts:268` `createLaunchdAdapter`            | 121   | Adapter factory    |

This is the declarative list the gate refers to. It is written here for the first time.

### The six that are real residue

These are procedures, not surfaces. Each one is a single path a reader has to follow end to end.

| Unit                                              | Lines | Cyclomatic |
| ------------------------------------------------- | ----- | ---------- |
| `src/syncController.ts:440` `importPending`       | 144   | —          |
| `src/connectors/core.ts:149` `planHostConnection` | 112   | —          |
| `src/connectors/verifier.ts:229` `verifyMcpRoute` | 112   | 29         |
| `src/server.ts:118` `startServer`                 | 107   | —          |
| `src/service/health.ts:49` `verifyServiceHealth`  | —     | 28         |
| `src/client.ts:522` `request`                     | —     | 26         |

Wave 4 did not touch five of them. `importPending` was reduced from a larger method when
`validateSyncState` moved out to `src/syncValidation.ts`, and is still over the limit.

## The open decision

Gate 9's numeric clause does not pass. Two ways to close it, and the choice is the user's:

1. **Split the six.** Each is a candidate: `importPending` separates reading, validating and
   applying; `verifyMcpRoute` separates the handshake from the response checks; `request` separates
   status mapping from transport. This is behaviour-preserving work under a suite that already holds
   100% coverage, so a regression would show.
2. **Narrow the gate.** Record the six as accepted, with this note as the reason, and drop the
   numeric clause. Honest, but it removes the only structural limit the plan set.

Either way, the clause should become a real check. Adding `complexity` and
`max-lines-per-function` to `.oxlintrc.json` with the declarative list as `overrides` would make
`npm run lint` enforce it, and would stop the list above from drifting the way the unwritten one
did.

## What not to repeat

The gate named a limit and an exception list, and neither was executable. A structural criterion
that no command evaluates is a criterion that gets reported as met. The four waves ran every gate
that existed; this one did not exist.
