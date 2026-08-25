import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const evidencePath = process.argv[2] ?? 'thoughts/evidence/quattro-live.json';
const candidateDirectory = resolve(process.argv[3] ?? 'integrations/omarchy/pimpampum-status');

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

function candidateFiles(directory) {
  const rootMetadata = lstatSync(directory);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Candidate root must be a real directory: ${directory}`);
  }
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Candidate contains forbidden symlink: ${absolute}`);
      }
      if (metadata.isDirectory()) visit(absolute);
      else if (metadata.isFile()) files.push(absolute);
    }
  };
  visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
}

function canonicalCandidateHash(directory) {
  const hash = createHash('sha256');
  for (const absolute of candidateFiles(directory)) {
    const relativePath = relative(directory, absolute).split(sep).join('/');
    const contents = readFileSync(absolute);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(contents.length));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

const actualCandidateHash = canonicalCandidateHash(candidateDirectory);
const validatedAt = Date.parse(evidence.validatedAt);
const currentTime = Date.now();
const maximumClockSkewMilliseconds = 5 * 60 * 1_000;
const maximumEvidenceAgeMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const version = typeof evidence.omarchyVersion === 'string' ? evidence.omarchyVersion.trim() : '';
const validatedCandidatePath =
  typeof evidence.validatedCandidatePath === 'string' ? evidence.validatedCandidatePath.trim() : '';
const versionCheck = evidence.commands?.version;
const validationCheck = evidence.commands?.validation;

if (
  evidence.schemaVersion !== 1 ||
  evidence.status !== 'passed' ||
  version.length === 0 ||
  Number.isNaN(validatedAt) ||
  validatedAt > currentTime + maximumClockSkewMilliseconds ||
  currentTime - validatedAt > maximumEvidenceAgeMilliseconds ||
  evidence.candidateHash !== actualCandidateHash ||
  validatedCandidatePath.length === 0 ||
  !isAbsolute(validatedCandidatePath) ||
  versionCheck?.executable !== 'omarchy' ||
  JSON.stringify(versionCheck?.arguments) !== JSON.stringify(['--version']) ||
  versionCheck?.exitCode !== 0 ||
  typeof versionCheck?.stdout !== 'string' ||
  !versionCheck.stdout.includes(version) ||
  validationCheck?.executable !== 'omarchy' ||
  JSON.stringify(validationCheck?.arguments) !==
    JSON.stringify(['plugin', 'validate', validatedCandidatePath]) ||
  validationCheck?.exitCode !== 0 ||
  validationCheck?.passed !== true ||
  typeof validationCheck?.stdout !== 'string' ||
  typeof validationCheck?.stderr !== 'string' ||
  requiredSmokeChecks.some((name) => evidence.smoke?.[name] !== true)
) {
  throw new Error(`Quattro live evidence at ${evidencePath} is incomplete or did not pass`);
}

console.log(
  `Verified Quattro ${version} live evidence for candidate ${actualCandidateHash} from ${evidence.validatedAt}.`,
);
