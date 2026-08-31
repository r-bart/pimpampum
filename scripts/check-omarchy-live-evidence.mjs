#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOmarchyDelivery } from './check-omarchy-delivery.mjs';

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

function fail(message) {
  throw new Error(`Task 6.2 Omarchy evidence is invalid: ${message}`);
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has unexpected or missing fields`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail(`${label} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is invalid`);
  return parsed;
}

export function validateTask62Evidence(input) {
  const evidencePath = realpathSync(resolve(input.evidencePath));
  const allowedRoot = realpathSync(resolve(input.allowedRoot));
  const child = relative(allowedRoot, evidencePath);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail('evidence path escapes its trusted root');
  }
  const metadata = lstatSync(evidencePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > 1024 * 1024
  ) {
    fail('evidence must be a bounded regular file');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    throw new Error('Task 6.2 Omarchy evidence is invalid: evidence is not JSON', { cause: error });
  }
  const evidence = exactObject(
    parsed,
    [
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
    ],
    'evidence',
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.status !== 'passed' ||
    evidence.explicitOptIn !== true
  ) {
    fail('evidence must be an explicitly opted-in passed schemaVersion 1 artifact');
  }
  if (typeof evidence.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(evidence.commit)) {
    fail('commit must be an exact Git commit');
  }
  if (!['linux-x64', 'linux-arm64'].includes(evidence.target)) fail('target is unsupported');
  if (
    typeof evidence.runtimeVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(evidence.runtimeVersion)
  ) {
    fail('runtimeVersion is invalid');
  }
  const delivery = validateOmarchyDelivery(input.candidatePath);
  if (
    evidence.runtimeVersion !== delivery.runtimeVersion ||
    digest(evidence.runtimeManifestSha256, 'runtimeManifestSha256') !==
      delivery.runtimeManifestSha256 ||
    digest(evidence.artifactSha256, 'artifactSha256') !==
      delivery.targets[evidence.target].artifactSha256
  ) {
    fail('runtime or artifact hash binding differs from the checked candidate');
  }
  const startedAt = timestamp(evidence.startedAt, 'startedAt');
  const finishedAt = timestamp(evidence.finishedAt, 'finishedAt');
  if (
    !Number.isSafeInteger(evidence.durationMs) ||
    evidence.durationMs < 0 ||
    evidence.durationMs !== finishedAt - startedAt ||
    evidence.durationMs > 60 * 60_000
  ) {
    fail('overall duration is invalid');
  }
  if (
    !Array.isArray(evidence.scenarios) ||
    evidence.scenarios.length !== TASK_6_2_SCENARIOS.length
  ) {
    fail('scenario matrix is incomplete');
  }
  for (const [index, expectedId] of TASK_6_2_SCENARIOS.entries()) {
    const scenario = exactObject(
      evidence.scenarios[index],
      ['id', 'passed', 'observed', 'startedAt', 'finishedAt', 'durationMs'],
      `scenario ${expectedId}`,
    );
    if (scenario.id !== expectedId || scenario.passed !== true)
      fail(`scenario ${expectedId} did not pass`);
    if (
      typeof scenario.observed !== 'string' ||
      scenario.observed.length === 0 ||
      scenario.observed.length > 512
    ) {
      fail(`scenario ${expectedId} has invalid observations`);
    }
    const scenarioStart = timestamp(scenario.startedAt, `${expectedId}.startedAt`);
    const scenarioFinish = timestamp(scenario.finishedAt, `${expectedId}.finishedAt`);
    if (
      !Number.isSafeInteger(scenario.durationMs) ||
      scenario.durationMs < 0 ||
      scenario.durationMs !== scenarioFinish - scenarioStart ||
      scenario.durationMs > 10 * 60_000
    ) {
      fail(`scenario ${expectedId} duration is invalid`);
    }
  }
  const preserved = exactObject(
    evidence.preservedData,
    ['beforeSha256', 'afterSha256', 'unchanged'],
    'preservedData',
  );
  if (
    digest(preserved.beforeSha256, 'preservedData.beforeSha256') !==
      digest(preserved.afterSha256, 'preservedData.afterSha256') ||
    preserved.unchanged !== true
  ) {
    fail('removal did not preserve user data byte-for-byte');
  }
  const cleanup = exactObject(evidence.cleanup, ['completed'], 'cleanup');
  if (cleanup.completed !== true) fail('cleanup did not complete');
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
