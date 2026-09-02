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

Since 2026-09-02 both rules live in `.oxlintrc.json` and `npm run lint` enforces them, so the
normal way to measure is to run the gate. To measure without the nine exemptions, and see the whole
picture including the declarative units, use a throwaway configuration:

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

### The six that were real residue, and are not any more

These were procedures, not surfaces: one path a reader had to follow end to end. All six were split
the same day, behaviour unchanged, under a suite that holds 100% coverage on the measured files.

| Unit                                          | Lines    | Cyclomatic |
| --------------------------------------------- | -------- | ---------- |
| `src/syncController.ts` `importPending`       | 144 → 55 | → 10       |
| `src/connectors/verifier.ts` `verifyMcpRoute` | 112 → 43 | 29 → 15    |
| `src/connectors/core.ts` `planHostConnection` | 112 → 41 | → 7        |
| `src/server.ts` `startServer`                 | 107 → 26 | → 3        |
| `src/service/health.ts` `verifyServiceHealth` | 27       | 28 → 7     |
| `src/client.ts` `request`                     | 31       | 26 → 11    |

Every extracted helper is inside both limits too. Nothing was brought under the limit by an
exemption or an ignore comment.

What each extraction had to preserve, because these are the parts a careless split would break:

- `client.request` keeps its status mapping. A transport failure still raises `unavailable`, and the
  daemon's own error code still wins over the code derived from the HTTP status.
- `server.startServer` keeps the loopback assertion and the single-instance lock inside runtime
  composition. Neither moved to `src/config.ts`.
- `syncController.importPending` keeps its order: a causally incomplete snapshot stays pending, a
  blocked snapshot names the first path, and descendants of a blocked snapshot are blocked rather
  than pending.
- `connectors/verifier.verifyMcpRoute` keeps its spawn count. One test asserts an exact total of
  eleven host invocations.
- `connectors/core.planHostConnection` was split before the file took its factory exemption, so the
  exemption excuses only the factory's length.

## The gate is executable now

`.oxlintrc.json` did not exist before 2026-09-02, so `npm run lint` ran on oxlint's defaults. The
file now exists and carries both rules, scoped to `src/**` because `npm run lint` lints `src` and
`test` together and a long `it(...)` callback in a test is not a defect. Each of the nine
declarative units has its own `overrides` entry turning `max-lines-per-function` off and leaving
`complexity` on, with the reason written above the entry.

Two things were verified rather than assumed:

- **The default rules survived.** `npx oxlint --print-config` reports the same 111 top-level rules
  with the new file as with an empty one. Adding the config did not silence oxlint's `correctness`
  category.
- **The scoping works in both directions.** A probe function of 122 lines and complexity 31 fires
  both rules under `src/` and neither under `test/`. Pointed at an exempted file, `complexity` still
  fires and `max-lines-per-function` does not.

Re-measured after the split, `npx oxlint src` with both rules at the gate's thresholds reports
exactly the nine declarative units and no `complexity` violation anywhere in `src/`.

## What not to repeat

The gate named a limit and an exception list, and neither was executable. A structural criterion
that no command evaluates is a criterion that gets reported as met. The four waves ran every gate
that existed; this one did not exist.
