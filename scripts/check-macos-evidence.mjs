#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = join(root, 'thoughts/evidence/macos-live.json');
const binaryPath = join(
  root,
  'platforms/macos/dist/PimpampumMenuBar.app/Contents/MacOS/PimpampumMenuBar',
);

let evidence;
try {
  evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
} catch (error) {
  throw new Error(`Missing or invalid macOS live evidence at ${evidencePath}`, { cause: error });
}

const testedAt = Date.parse(evidence.testedAt);
const age = Date.now() - testedAt;
const maximumAge = 30 * 24 * 60 * 60 * 1_000;
if (!Number.isFinite(testedAt) || age < 0 || age > maximumAge) {
  throw new Error('macOS live evidence is future-dated or older than 30 days.');
}

const binaryHash = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
const expectedChecks = [
  'empty',
  'activeClaim',
  'completion',
  'daemonOffline',
  'nativePopoverRendering',
  'staleRecovery',
  'projectRowActivation',
  'finderRevealExactPath',
  'noDockIcon',
  'repeatInstallRecovery',
  'uninstallCleanup',
];
const renderingNames = ['empty', 'active', 'complete', 'stale', 'recovered'];
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

if (
  evidence.schemaVersion !== 1 ||
  evidence.platform !== 'macOS' ||
  evidence.architecture !== 'arm64' ||
  !['enabled', 'requiresApproval'].includes(evidence.loginItem) ||
  evidence.appSha256 !== binaryHash ||
  !expectedChecks.every((name) => evidence.checks?.[name] === true) ||
  !renderingNames.every((name) => validHash(evidence.renderings?.[name]))
) {
  throw new Error('macOS live evidence is incomplete or does not match the packaged app.');
}

process.stdout.write(`Verified macOS UI smoke evidence for app ${binaryHash}.\n`);
