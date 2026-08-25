import { readFileSync } from 'node:fs';

const evidencePath = process.argv[2] ?? 'thoughts/evidence/quattro-live.json';
let evidence;
try {
  evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
} catch (error) {
  throw new Error(`Missing or invalid Quattro live evidence at ${evidencePath}`, { cause: error });
}

const requiredSmokeChecks = [
  'pluginValidation',
  'hotReload',
  'themeInheritance',
  'horizontalTopLayout',
  'popoutCoordination',
  'activeCount',
  'completedCollapse',
  'offlineRecovery',
  'workspaceOpen',
];

if (
  evidence.schemaVersion !== 1 ||
  evidence.status !== 'passed' ||
  typeof evidence.omarchyVersion !== 'string' ||
  evidence.omarchyVersion.length === 0 ||
  typeof evidence.validatedAt !== 'string' ||
  Number.isNaN(Date.parse(evidence.validatedAt)) ||
  typeof evidence.candidateHash !== 'string' ||
  !/^[a-f0-9]{64}$/.test(evidence.candidateHash) ||
  requiredSmokeChecks.some((name) => evidence.smoke?.[name] !== true)
) {
  throw new Error(`Quattro live evidence at ${evidencePath} is incomplete or did not pass`);
}

console.log(
  `Verified Quattro ${evidence.omarchyVersion} live evidence from ${evidence.validatedAt}.`,
);
