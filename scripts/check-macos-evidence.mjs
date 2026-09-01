#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(arguments_) {
  const values = {
    evidence: join(root, 'thoughts/evidence/macos-live.json'),
    app: join(root, 'platforms/macos/dist/Pimpampum.app'),
    metadata: join(root, 'platforms/macos/dist/PimpampumMenuBar.artifact.json'),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (!['--evidence', '--app', '--metadata'].includes(flag)) {
      throw new Error(`Unknown macOS evidence checker argument: ${String(flag)}`);
    }
    const value = arguments_[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new Error(`${flag} requires a path.`);
    }
    values[flag.slice(2)] = resolve(value);
    index += 1;
  }
  return values;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Missing or invalid ${label} at ${path}`, { cause: error });
  }
}

function treeSha256(rootDirectory) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error(`macOS artifact tree contains an unsafe entry: ${path}`);
      }
      if (metadata.isDirectory()) visit(path);
      else files.push({ path, mode: metadata.mode & 0o777 });
    }
  };
  visit(rootDirectory);
  const digest = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(file.path);
    digest.update(relative(rootDirectory, file.path).split(sep).join('/'));
    digest.update('\0');
    digest.update(String(file.mode));
    digest.update('\0');
    digest.update(String(bytes.length));
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const paths = parseArguments(process.argv.slice(2));
const evidence = readJson(paths.evidence, 'macOS live evidence');
const metadataBytes = readFileSync(paths.metadata);
const metadata = readJson(paths.metadata, 'macOS artifact metadata');
const runtimeRoot = join(paths.app, 'Contents/Resources/PimpampumRuntime');
const runtimePayload = join(runtimeRoot, 'payload');
const binaryPath = join(paths.app, 'Contents/MacOS/PimpampumMenuBar');
const artifactPaths = {
  appBinarySha256: binaryPath,
  compactMarkSha256: join(paths.app, 'Contents/Resources/PimpampumCompact.pdf'),
  runtimeManifestSha256: join(runtimeRoot, 'runtime-manifest.json'),
  runtimeInventorySha256: join(runtimeRoot, 'runtime-inventory.json'),
  runtimeSbomSha256: join(runtimeRoot, 'runtime-sbom.spdx.json'),
  runtimeNodeSha256: join(runtimePayload, 'bin/node'),
  runtimeAddonSha256: join(
    runtimePayload,
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  ),
};
const testedAt = Date.parse(evidence.testedAt);
const age = Date.now() - testedAt;
const maximumAge = 30 * 24 * 60 * 60 * 1_000;
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const expectedChecks = [
  'empty',
  'activeClaim',
  'completion',
  'daemonOffline',
  'nativePopoverRendering',
  'guidedSetupPopover',
  'staleRecovery',
  'projectRowActivation',
  'finderRevealExactPath',
  'noDockIcon',
  'repeatInstallRecovery',
  'uninstallCleanup',
];
const expectedScenarios = [
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
];
const expectedReleaseSequence = [
  'sign-nested-runtime',
  'sign-outer-app',
  'notarize',
  'staple',
  'approve',
];

invariant(
  Number.isFinite(testedAt) && age >= 0 && age <= maximumAge,
  'macOS live evidence is future-dated or older than 30 days.',
);
invariant(
  evidence.schemaVersion === 3 &&
    evidence.status === 'passed' &&
    evidence.platform === 'macOS' &&
    evidence.architecture === 'arm64',
  'macOS live evidence has an incompatible identity or schema.',
);
invariant(
  Number.isInteger(evidence.durationMilliseconds) &&
    evidence.durationMilliseconds > 0 &&
    evidence.durationMilliseconds < 120_000,
  'macOS live evidence exceeded the two-minute release budget.',
);
invariant(
  typeof evidence.gitCommit === 'string' &&
    /^[a-f0-9]{40}$/u.test(evidence.gitCommit) &&
    evidence.gitCommit === metadata.sourceGitCommit &&
    metadata.schemaVersion === 3,
  'macOS live evidence is not bound to the approved artifact commit.',
);
try {
  execFileSync('git', ['cat-file', '-e', `${evidence.gitCommit}^{commit}`], {
    cwd: root,
    stdio: 'ignore',
  });
} catch (error) {
  throw new Error('The evidenced macOS source commit is unavailable.', { cause: error });
}
invariant(
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() ===
    evidence.gitCommit,
  'macOS live evidence was not produced from the checked-out release commit.',
);
invariant(
  evidence.sourceInputSha256 === metadata.sourceInputSha256 &&
    validHash(evidence.sourceInputSha256),
  'macOS live evidence does not match the approved source inputs.',
);
invariant(
  JSON.stringify(evidence.releaseSequence) === JSON.stringify(expectedReleaseSequence),
  'macOS live evidence does not record nested sign, outer sign, notarize, staple, approve order.',
);
invariant(
  expectedChecks.every((name) => evidence.checks?.[name] === true) &&
    expectedScenarios.every((name) => evidence.scenarios?.[name] === true),
  'macOS live evidence is missing a required check or setup lifecycle scenario.',
);
invariant(
  evidence.sessionRestart?.required === true &&
    evidence.sessionRestart?.observedAfterNewSession === true &&
    Array.isArray(evidence.sessionRestart?.connectors) &&
    evidence.sessionRestart.connectors.length > 0,
  'macOS live evidence does not record observed new-agent-session behavior.',
);
invariant(
  evidence.versions?.pimpampum === metadata.appVersion &&
    typeof evidence.versions?.node === 'string' &&
    evidence.versions.node.length > 0 &&
    typeof evidence.versions?.macOS === 'string' &&
    evidence.versions.macOS.length > 0 &&
    ['string', 'object'].includes(typeof evidence.versions?.codex) &&
    ['string', 'object'].includes(typeof evidence.versions?.claudeCode),
  'macOS live evidence has incomplete product, runtime, OS, or host versions.',
);
invariant(
  ['enabled', 'requires-approval', 'denied'].includes(evidence.loginItem),
  'macOS live evidence has no bounded Login Items result.',
);

for (const [name, path] of Object.entries(artifactPaths)) {
  invariant(
    validHash(evidence.artifactHashes?.[name]) &&
      evidence.artifactHashes[name] === sha256(readFileSync(path)),
    `macOS live evidence artifact hash mismatch: ${name}`,
  );
}
invariant(
  evidence.artifactHashes?.artifactMetadataSha256 === sha256(metadataBytes) &&
    evidence.artifactHashes?.appBundleSha256 === treeSha256(paths.app),
  'macOS live evidence does not match the approved metadata or final stapled app tree.',
);
invariant(
  Object.values(evidence.renderings ?? {}).every(validHash) &&
    ['setupRequired', 'empty', 'active', 'complete', 'stale', 'recovered'].every((name) =>
      validHash(evidence.renderings?.[name]),
    ),
  'macOS live evidence has incomplete native rendering hashes.',
);

process.stdout.write(
  `Verified macOS setup evidence for ${evidence.gitCommit} and app ${evidence.artifactHashes.appBundleSha256}.\n`,
);
