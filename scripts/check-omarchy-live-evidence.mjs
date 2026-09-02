#!/usr/bin/env node

// Validates the Task 6.2 Omarchy delivery evidence (`thoughts/evidence/omarchy-live.json`) against
// the candidate plugin: the hash binding to the delivery checker, the scenario order and bounds,
// preserved user data and cleanup. One condition per `fail`, so a refusal names the field that
// broke. The scenario list stays local on purpose: this checker pins what the runner must emit.
//
//   check-omarchy-live-evidence.mjs [evidencePath] [candidatePath] [allowedRoot]

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOmarchyDelivery } from './check-omarchy-delivery.mjs';
import { digest, exactObject, parseJson, timestamp } from './lib/checks.mjs';
import { isInside } from './lib/paths.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASK_6_2_SCENARIOS = [
  'bootstrap-no-node',
  'connect-codex',
  'connect-claude-code',
  'reject-wrong-architecture',
  'reject-wrong-hash',
  'reject-offline-download',
  'reject-interrupted-download',
  'quickshell-restart-preserves-daemon-and-connectors',
  'packaged-update-preserves-connectors',
  'receipt-owned-removal-preserves-data',
];
const EVIDENCE_KEYS = [
  'schemaVersion',
  'status',
  'explicitOptIn',
  'commit',
  'target',
  'runtimeVersion',
  'runtimeManifestSha256',
  'artifactSha256',
  'startedAt',
  'finishedAt',
  'durationMs',
  'scenarios',
  'preservedData',
  'cleanup',
];
const SCENARIO_KEYS = ['id', 'passed', 'observed', 'startedAt', 'finishedAt', 'durationMs'];
const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SCENARIO_BUDGET_MS = 10 * 60_000;
const RUN_BUDGET_MS = 60 * 60_000;

function fail(message, cause) {
  const text = `Task 6.2 Omarchy evidence is invalid: ${message}`;
  throw cause === undefined ? new Error(text) : new Error(text, { cause });
}

function readEvidenceFile(input) {
  const evidencePath = realpathSync(resolve(input.evidencePath));
  const allowedRoot = realpathSync(resolve(input.allowedRoot));
  if (!isInside(allowedRoot, evidencePath)) fail('evidence path escapes its trusted root');
  const metadata = lstatSync(evidencePath);
  if (metadata.isSymbolicLink()) fail('evidence must be a regular file, not a symlink');
  if (!metadata.isFile()) fail('evidence must be a regular file');
  if (metadata.size <= 0) fail('evidence must not be empty');
  if (metadata.size > 1024 * 1024) fail('evidence exceeds its size bound');
  return parseJson(readFileSync(evidencePath, 'utf8'), 'evidence', fail);
}

function validateHeader(evidence) {
  if (evidence.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (evidence.status !== 'passed') fail('status must be passed');
  if (evidence.explicitOptIn !== true) fail('explicitOptIn must be true');
  if (typeof evidence.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(evidence.commit)) {
    fail('commit must be an exact Git commit');
  }
  if (!['linux-x64', 'linux-arm64'].includes(evidence.target)) fail('target is unsupported');
  if (
    typeof evidence.runtimeVersion !== 'string' ||
    !RUNTIME_VERSION_PATTERN.test(evidence.runtimeVersion)
  ) {
    fail('runtimeVersion is invalid');
  }
}

/** The evidence must name exactly the runtime and artifact the delivery checker derives now. */
function validateDeliveryBinding(evidence, candidatePath) {
  const delivery = validateOmarchyDelivery(candidatePath);
  if (evidence.runtimeVersion !== delivery.runtimeVersion) {
    fail('runtimeVersion differs from the checked candidate');
  }
  const manifestSha256 = digest(evidence.runtimeManifestSha256, 'runtimeManifestSha256', fail);
  if (manifestSha256 !== delivery.runtimeManifestSha256) {
    fail('runtimeManifestSha256 differs from the checked candidate');
  }
  const artifactSha256 = digest(evidence.artifactSha256, 'artifactSha256', fail);
  if (artifactSha256 !== delivery.targets[evidence.target].artifactSha256) {
    fail('artifactSha256 differs from the checked candidate');
  }
}

function validateDuration(value, startedAt, finishedAt, budgetMs, label) {
  if (!Number.isSafeInteger(value)) fail(`${label} must be an integer`);
  if (value < 0) fail(`${label} must not be negative`);
  if (value !== finishedAt - startedAt) fail(`${label} must equal finishedAt minus startedAt`);
  if (value > budgetMs) fail(`${label} exceeds its budget`);
}

function validateScenario(value, expectedId) {
  const scenario = exactObject(value, SCENARIO_KEYS, `scenario ${expectedId}`, fail);
  if (scenario.id !== expectedId) fail(`scenario ${expectedId} is out of order`);
  if (scenario.passed !== true) fail(`scenario ${expectedId} did not pass`);
  if (typeof scenario.observed !== 'string')
    fail(`scenario ${expectedId} has invalid observations`);
  if (scenario.observed.length === 0 || scenario.observed.length > 512) {
    fail(`scenario ${expectedId} has invalid observations`);
  }
  const start = timestamp(scenario.startedAt, `${expectedId}.startedAt`, fail);
  const finish = timestamp(scenario.finishedAt, `${expectedId}.finishedAt`, fail);
  validateDuration(
    scenario.durationMs,
    start,
    finish,
    SCENARIO_BUDGET_MS,
    `scenario ${expectedId} duration`,
  );
}

function validateScenarios(evidence) {
  if (!Array.isArray(evidence.scenarios)) fail('scenario matrix is incomplete');
  if (evidence.scenarios.length !== TASK_6_2_SCENARIOS.length) {
    fail('scenario matrix is incomplete');
  }
  for (const [index, expectedId] of TASK_6_2_SCENARIOS.entries()) {
    validateScenario(evidence.scenarios[index], expectedId);
  }
}

function validatePreservedDataAndCleanup(evidence) {
  const preserved = exactObject(
    evidence.preservedData,
    ['beforeSha256', 'afterSha256', 'unchanged'],
    'preservedData',
    fail,
  );
  const before = digest(preserved.beforeSha256, 'preservedData.beforeSha256', fail);
  const after = digest(preserved.afterSha256, 'preservedData.afterSha256', fail);
  if (before !== after) fail('removal did not preserve user data byte-for-byte');
  if (preserved.unchanged !== true) fail('preservedData.unchanged must be true');
  const cleanup = exactObject(evidence.cleanup, ['completed'], 'cleanup', fail);
  if (cleanup.completed !== true) fail('cleanup did not complete');
}

export function validateTask62Evidence(input) {
  const evidence = exactObject(readEvidenceFile(input), EVIDENCE_KEYS, 'evidence', fail);
  validateHeader(evidence);
  validateDeliveryBinding(evidence, input.candidatePath);
  const startedAt = timestamp(evidence.startedAt, 'startedAt', fail);
  const finishedAt = timestamp(evidence.finishedAt, 'finishedAt', fail);
  validateDuration(evidence.durationMs, startedAt, finishedAt, RUN_BUDGET_MS, 'overall duration');
  validateScenarios(evidence);
  validatePreservedDataAndCleanup(evidence);
  return evidence;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const evidencePath = resolve(
    process.argv[2] ?? join(repositoryRoot, 'thoughts/evidence/omarchy-live.json'),
  );
  const candidatePath = resolve(
    process.argv[3] ?? join(repositoryRoot, 'integrations/omarchy/pimpampum-status'),
  );
  const allowedRoot = resolve(process.argv[4] ?? join(repositoryRoot, 'thoughts/evidence'));
  const evidence = validateTask62Evidence({ evidencePath, candidatePath, allowedRoot });
  process.stdout.write(
    `Verified Task 6.2 Omarchy ${evidence.target} evidence for ${evidence.commit}.\n`,
  );
}
