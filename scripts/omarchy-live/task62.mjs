// Task 6.2 is deliberately separate from the human Quattro screenshot artifact. Its injected
// scenario boundary is implemented by the native-target harness and fixture tests; this
// orchestrator owns exact ordering, duration bounds, hash binding, cleanup, and fail-closed output.
// `check-omarchy-live-evidence.mjs` validates what it writes.

import { exactKeys } from '../lib/checks.mjs';
import { requireAbsolute } from '../lib/paths.mjs';
import { TASK_6_2_SCENARIOS } from './contract.mjs';

const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SCENARIO_BUDGET_MS = 10 * 60_000;
const RUN_BUDGET_MS = 60 * 60_000;

function assertPreconditions(dependencies, input) {
  if (dependencies.environment.PIMPAMPUM_OMARCHY_DELIVERY_LIVE !== '1') {
    throw new Error('Set PIMPAMPUM_OMARCHY_DELIVERY_LIVE=1 for the Task 6.2 target smoke');
  }
  if (dependencies.platform !== 'linux' || dependencies.uid === 0) {
    throw new Error('Task 6.2 target smoke requires rootless Linux');
  }
  const target = input.target;
  if (target !== 'linux-x64' && target !== 'linux-arm64') {
    throw new Error('Task 6.2 target must be linux-x64 or linux-arm64');
  }
  return {
    candidatePath: requireAbsolute(input.candidatePath, 'Candidate path'),
    evidencePath: requireAbsolute(input.evidencePath, 'Evidence path'),
    target,
  };
}

function assertDeliveryBinding(delivery) {
  if (
    !exactKeys(delivery, ['runtimeVersion', 'runtimeManifestSha256', 'artifactSha256']) ||
    !RUNTIME_VERSION_PATTERN.test(delivery.runtimeVersion) ||
    !SHA256_PATTERN.test(delivery.runtimeManifestSha256) ||
    !SHA256_PATTERN.test(delivery.artifactSha256)
  ) {
    throw new Error('Task 6.2 delivery validation returned an invalid hash binding');
  }
  return delivery;
}

function assertScenarioResult(id, result, durationMs) {
  if (
    !exactKeys(result, ['passed', 'observed']) ||
    result.passed !== true ||
    typeof result.observed !== 'string' ||
    result.observed.length === 0 ||
    result.observed.length > 512 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > SCENARIO_BUDGET_MS
  ) {
    throw new Error(`Task 6.2 scenario did not pass safely: ${id}`);
  }
}

export function createTask62LiveRunner(dependencies) {
  return {
    async run(input) {
      const { candidatePath, evidencePath, target } = assertPreconditions(dependencies, input);
      const delivery = assertDeliveryBinding(await dependencies.validateDelivery(candidatePath));
      const commit = await dependencies.repositoryCommit();
      if (!/^[a-f0-9]{40}$/u.test(commit)) {
        throw new Error('Task 6.2 evidence requires an exact repository commit');
      }
      const preservedBeforeSha256 = await dependencies.preservedDataSha256();
      if (!SHA256_PATTERN.test(preservedBeforeSha256)) {
        throw new Error('Task 6.2 preserved-data baseline hash is invalid');
      }
      const startedAt = dependencies.now();
      const scenarios = [];
      let cleanupPromise;
      const cleanupOnce = async () => {
        cleanupPromise ??= Promise.resolve().then(() => dependencies.cleanup());
        return cleanupPromise;
      };
      let preservedAfterSha256;
      let cleanup;
      try {
        for (const id of TASK_6_2_SCENARIOS) {
          const scenarioStartedAt = dependencies.now();
          const result = await dependencies.runScenario({
            id,
            target,
            candidatePath,
            runtimeVersion: delivery.runtimeVersion,
            artifactSha256: delivery.artifactSha256,
          });
          const scenarioFinishedAt = dependencies.now();
          const durationMs = scenarioFinishedAt.getTime() - scenarioStartedAt.getTime();
          assertScenarioResult(id, result, durationMs);
          scenarios.push({
            id,
            passed: true,
            observed: result.observed,
            startedAt: scenarioStartedAt.toISOString(),
            finishedAt: scenarioFinishedAt.toISOString(),
            durationMs,
          });
        }
        preservedAfterSha256 = await dependencies.preservedDataSha256();
        if (preservedAfterSha256 !== preservedBeforeSha256) {
          throw new Error('Task 6.2 removal changed preserved user data');
        }
        cleanup = await cleanupOnce();
        if (!exactKeys(cleanup, ['completed']) || cleanup.completed !== true) {
          throw new Error('Task 6.2 cleanup did not complete');
        }
      } catch (error) {
        try {
          await cleanupOnce();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Task 6.2 run and cleanup failed');
        }
        throw error;
      }
      const finishedAt = dependencies.now();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > RUN_BUDGET_MS) {
        throw new Error('Task 6.2 overall duration is invalid');
      }
      const evidence = {
        schemaVersion: 1,
        status: 'passed',
        explicitOptIn: true,
        commit,
        target,
        runtimeVersion: delivery.runtimeVersion,
        runtimeManifestSha256: delivery.runtimeManifestSha256,
        artifactSha256: delivery.artifactSha256,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        scenarios,
        preservedData: {
          beforeSha256: preservedBeforeSha256,
          afterSha256: preservedAfterSha256,
          unchanged: true,
        },
        cleanup,
      };
      dependencies.writeEvidenceAtomic(evidencePath, evidence);
      return evidence;
    },
  };
}
