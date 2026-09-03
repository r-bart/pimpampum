# Omarchy: the packaged path had never been run

**Date**: 2026-09-03
**Scope**: `src/service/omarchy.ts`, `src/connectors/*`, `src/setup/coordinator.ts`, the plugin QML
**Version**: 1.3.0 throughout — no bump; only the runtime pins were refreshed.

## What happened

An end-to-end run of the documented Omarchy install on a real Omarchy 4.0.1 machine found five
defects. None of them were visible to the 1567 tests that were passing at the time, and the first
one had been shipping since at least 1.2.11.

| #   | Defect                                                                          | Blast radius                                                                                                                     |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `createOmarchyAdapter` validated the plugin source in its constructor           | Every service verb failed on any Omarchy machine, from the packaged runtime. On released 1.2.11 even `version` and `help` failed |
| 2   | `deactivate` demanded a backup from `omarchy plugin remove`                     | `uninstall` failed for every plugin installed the documented way                                                                 |
| 3   | `OverviewService.handleExit` collapsed all non-credential failures to `offline` | The popout reported a healthy daemon as offline                                                                                  |
| 4   | `SetupPlan.changes` carried "Keep your work on this Mac."                       | Linux users read macOS copy on the consent screen                                                                                |
| 5   | Connectors read the first stdout line and parsed whole stdout as JSON           | On a mise machine neither agent could connect and `connections list` failed outright                                             |

## Why the tests did not catch it

**The fixtures modelled a shape that never ships.** Every case in `test/cli-platform-adapters.test.ts`
created the plugin directory before composing the manager, and every case in
`test/service-omarchy.test.ts` copied a plugin source into place. The packaged runtime — `dist/`
with no `integrations/` beside it, which is what every user runs — was never constructed in a test.
The new regression test in `cli-platform-adapters.test.ts` was checked against the old code first:
it fails there with the exact production error.

**The delivery smoke exists only with injected dependencies.** `scripts/omarchy-live/task62.mjs`
orchestrates ten scenarios — `bootstrap-no-node`, `reject-wrong-hash`,
`packaged-update-preserves-connectors`, `receipt-owned-removal-preserves-data` and the rest — but it
has no CLI entry point and its `runScenario` boundary is supplied by tests. Those scenarios have
never executed against a native target. That gap is still open.

**The plugin validator checks the candidate, not the installation.** `npm run validate:omarchy`
passes against the checkout, where `integrations/` exists by definition.

## Patterns discovered

- **Pattern**: an adapter that reads an installation source it does not always have must resolve
  that source per call and report `canPlanArtifacts()`, never validate it at construction.
  **When to use**: any `PlatformServiceAdapter` whose artifacts come from a build tree.
  `macosApp.ts` already did exactly this; the Omarchy adapter did not, and the divergence was the
  whole bug. When two adapters implement the same interface, a capability one declares and the
  other does not is worth a second look.

- **Pattern**: verify the outcome, not the mechanism. `deactivate` asserted "a backup exists",
  which is one of three things the official command does. Asserting "the directory is gone" holds
  for all three and is the property that actually matters.

- **Pattern**: a host CLI's stdout may carry a bounded preamble. Version managers (mise, asdf,
  volta) install shims that announce themselves before the payload. `payloadVersionLine` and
  `payloadJson` skip that preamble and then parse exactly as strictly as before — the payload never
  becomes more permissive.

- **Pattern**: copy in a module both platforms render must not name a platform.
  `src/setup/coordinator.ts` is shared; "this Mac" reached Linux because nothing in the type system
  says so.

## What was difficult

Proving the runtime pins could be refreshed without a version bump. The `runtime-manifest` job runs
in `quality.yml`, not only on release, so any `src/` change invalidates the reviewed digests. The
gotcha warns that bundle digests are host-specific. Resolved by building both targets from pristine
`master` first and confirming this Linux host reproduced the committed CI digests exactly —
`17a1cfd…` for x64 and `d7947f1…` for arm64 — which made re-pinning from this host verifiable
rather than hopeful.

## Still open

- The native Task 6.2 harness. Ten real delivery scenarios, still injected-only.
- `r-bart/pimpampum-omarchy` is published at 1.2.9 and the release workflow does not push it; it is
  a manual subtree fast-forward.
- v1.3.0 is unreleased, so the pinned asset URLs 404 until the tag is cut. Every live run above
  supplied the archive through `PIMPAMPUM_BOOTSTRAP_ARCHIVE`, with the pin verified as usual.
- The `unavailable` guidance in `src/agentProtocol.ts` is per-code, so
  `OmarchyPluginMissingError` carries the right message and `details.remedy` but inherits a
  suggestion about the daemon. A per-error suggestion override would fix it and touches the shared
  envelope contract.
