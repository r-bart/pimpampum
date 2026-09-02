#!/usr/bin/env node

// Validates the Omarchy plugin delivery contract: the plugin and runtime manifests agree on one
// exact version, every runtime target pins the exact release asset and its digest, and every
// executable helper the QML can launch ships with an interpreter header. Returns the hash binding
// the Task 6.2 live evidence records. One condition per `fail`.
//
//   check-omarchy-delivery.mjs [pluginRoot]

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exactObject, parseJson } from './lib/checks.mjs';
import { sha256 } from './lib/hashTree.mjs';
import { isInside } from './lib/paths.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultPluginRoot = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');
const supportedTargets = ['linux-arm64', 'linux-x64'];
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const MAXIMUM_BOOTSTRAP_BYTES = 100_663_296;
// The one list of plugin files installed with mode 0o755. `pluginArtifacts` in
// src/service/omarchy.ts mirrors it, and the Quattro live runner imports it to verify an installed
// tree. `pimpampum-common.sh` is a sourced library, listed here so its bytes are hashed into the
// delivery evidence alongside the helpers that source it.
export const executableHelpers = [
  'install.sh',
  'uninstall.sh',
  'pimpampum-backup',
  'pimpampum-bootstrap',
  'pimpampum-common.sh',
  'pimpampum-connections',
  'pimpampum-control-route',
  'pimpampum-folder-picker',
  'pimpampum-overview',
  'pimpampum-plugin-lifecycle',
  'pimpampum-service',
  'pimpampum-sync',
  'pimpampum-update',
];

function fail(message, cause) {
  const text = `Omarchy delivery validation failed: ${message}`;
  throw cause === undefined ? new Error(text) : new Error(text, { cause });
}

function isExactSemver(value) {
  return typeof value === 'string' && EXACT_SEMVER_PATTERN.test(value);
}

function boundedJson(path, maximumBytes, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  if (metadata.size <= 0 || metadata.size > maximumBytes) fail(`${label} has an invalid size`);
  return parseJson(readFileSync(path, 'utf8'), label, fail);
}

function regularChild(root, child, label) {
  const path = join(root, child);
  if (!isInside(root, resolve(path))) fail(`${label} escapes the plugin root`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  return { path, metadata };
}

function assertPluginRoot(pluginRoot) {
  const rootMetadata = lstatSync(pluginRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail('plugin root must be a real directory');
  }
  for (const name of readdirSync(pluginRoot)) {
    const metadata = lstatSync(join(pluginRoot, name));
    if (metadata.isSymbolicLink()) fail(`top-level symlink is forbidden: ${name}`);
  }
}

function validatePluginManifest(pluginRoot) {
  const pluginManifest = exactObject(
    boundedJson(join(pluginRoot, 'manifest.json'), 16 * 1024, 'plugin manifest'),
    [
      'schemaVersion',
      'id',
      'name',
      'version',
      'author',
      'description',
      'kinds',
      'entryPoints',
      'barWidget',
    ],
    'plugin manifest',
    fail,
  );
  if (pluginManifest.schemaVersion !== 1) fail('plugin manifest schemaVersion must be 1');
  if (pluginManifest.id !== 'dev.pimpampum.status') fail('plugin manifest id is incompatible');
  if (!isExactSemver(pluginManifest.version)) {
    fail('plugin manifest version must be exact semver');
  }
  if (JSON.stringify(pluginManifest.kinds) !== JSON.stringify(['bar-widget'])) {
    fail('plugin manifest kind is incompatible');
  }
  const entryPoints = exactObject(pluginManifest.entryPoints, ['barWidget'], 'entryPoints', fail);
  if (entryPoints.barWidget !== 'BarWidget.qml') fail('bar widget entry point is incompatible');
  regularChild(pluginRoot, entryPoints.barWidget, 'bar widget entry point');
  return pluginManifest;
}

function validateRuntimeManifest(pluginRoot, pluginManifest) {
  const runtimeManifestPath = join(pluginRoot, 'runtime-manifest.json');
  const runtimeManifest = exactObject(
    boundedJson(runtimeManifestPath, 16 * 1024, 'runtime manifest'),
    ['version', 'targets'],
    'runtime manifest',
    fail,
  );
  if (!isExactSemver(runtimeManifest.version)) {
    fail('runtime manifest version must be exact semver');
  }
  if (runtimeManifest.version !== pluginManifest.version) {
    fail('plugin and runtime manifest versions must match');
  }
  return { runtimeManifest, runtimeManifestPath };
}

/** One runtime target: the exact pinned release asset URL, a real digest and a bounded size. */
function validateTarget(target, value, version) {
  const entry = exactObject(value, ['url', 'sha256', 'maximumBytes'], target, fail);
  const expectedUrl =
    `https://github.com/r-bart/pimpampum/releases/download/v${version}/` +
    `pimpampum-runtime-${version}-${target}.tar.gz`;
  if (entry.url !== expectedUrl) fail(`${target} URL is not the exact pinned release asset`);
  if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    fail(`${target} SHA-256 is invalid`);
  }
  if (entry.sha256 === '0'.repeat(64)) fail(`${target} SHA-256 is empty`);
  if (!Number.isSafeInteger(entry.maximumBytes)) fail(`${target} maximumBytes must be an integer`);
  if (entry.maximumBytes <= 0 || entry.maximumBytes > MAXIMUM_BOOTSTRAP_BYTES) {
    fail(`${target} maximumBytes is outside the bootstrap bound`);
  }
  return { artifactSha256: entry.sha256, maximumBytes: entry.maximumBytes, url: entry.url };
}

function validateTargets(runtimeManifest) {
  const targets = exactObject(runtimeManifest.targets, supportedTargets, 'runtime targets', fail);
  const targetEvidence = {};
  for (const target of supportedTargets) {
    targetEvidence[target] = validateTarget(target, targets[target], runtimeManifest.version);
  }
  return targetEvidence;
}

function validateHelpers(pluginRoot) {
  const helperEvidence = {};
  for (const helper of executableHelpers) {
    const { path, metadata } = regularChild(pluginRoot, helper, helper);
    if ((metadata.mode & 0o111) === 0) fail(`${helper} must be executable`);
    const contents = readFileSync(path);
    if (contents.byteLength < 16 || contents.byteLength > 256 * 1024) {
      fail(`${helper} has an invalid size`);
    }
    const firstLine = contents.subarray(0, Math.min(contents.length, 128)).toString('utf8');
    if (!firstLine.startsWith('#!')) fail(`${helper} must have an interpreter header`);
    helperEvidence[helper] = {
      sha256: sha256(contents),
      mode: metadata.mode & 0o777,
      size: contents.byteLength,
    };
  }
  return helperEvidence;
}

/** Every helper a QML file resolves by name must be one of the validated executables. */
function qmlLaunchedHelpers(pluginRoot, helperEvidence) {
  const launched = new Set();
  for (const name of readdirSync(pluginRoot).filter((child) => child.endsWith('.qml'))) {
    const { path } = regularChild(pluginRoot, name, name);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(
      /Qt\.resolvedUrl\(\s*["'](pimpampum-[a-z0-9-]+)["']\s*\)/gu,
    )) {
      launched.add(match[1]);
    }
  }
  for (const helper of launched) {
    if (!Object.hasOwn(helperEvidence, helper)) {
      fail(`QML launches an unvalidated helper: ${helper}`);
    }
  }
  return [...launched].sort();
}

export function validateOmarchyDelivery(candidate = defaultPluginRoot) {
  const pluginRoot = realpathSync(resolve(candidate));
  assertPluginRoot(pluginRoot);
  const pluginManifest = validatePluginManifest(pluginRoot);
  const { runtimeManifest, runtimeManifestPath } = validateRuntimeManifest(
    pluginRoot,
    pluginManifest,
  );
  const targets = validateTargets(runtimeManifest);
  const helpers = validateHelpers(pluginRoot);
  return {
    schemaVersion: 1,
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeVersion: runtimeManifest.version,
    runtimeManifestSha256: sha256(readFileSync(runtimeManifestPath)),
    targets,
    helpers,
    qmlLaunchedHelpers: qmlLaunchedHelpers(pluginRoot, helpers),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = validateOmarchyDelivery(process.argv[2] ?? defaultPluginRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
