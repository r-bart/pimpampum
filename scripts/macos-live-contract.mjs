// Data shared by the macOS live smoke (`scripts/test-macos-live.mjs`, the producer) and the gate
// tests (`test/macos-live-gates.test.ts`). The runner throws at import time unless
// PIMPAMPUM_RUN_LIVE_MACOS=1, so the contract it must satisfy lives here where a test can read it.

/** Every setup lifecycle case the live smoke must observe before it writes evidence. */
export const LIVE_SETUP_SCENARIOS = Object.freeze([
  'cleanNoNode',
  'guidedSetupPopover',
  'legacyNpmMigration',
  'noAgent',
  'oneAgent',
  'twoAgents',
  'partialFailure',
  'conflictDecision',
  'popoverRestartResume',
  'packagedUpdate',
  'disconnect',
  'removal',
]);

/**
 * PERF-1: download/artifact preflight through the first verified agent must finish under two
 * minutes. The remaining fault-injection, UI and removal cases are release validation and are not
 * charged to this budget.
 */
export const GUIDED_SETUP_BUDGET_MILLISECONDS = 120_000;
