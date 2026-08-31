#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultPluginRoot = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');
const supportedTargets = ['linux-arm64', 'linux-x64'];
const executableHelpers = [
  'install.sh',
  'uninstall.sh',
  'pimpampum-backup',
  'pimpampum-bootstrap',
  'pimpampum-connections',
  'pimpampum-control-route',
  'pimpampum-folder-picker',
  'pimpampum-overview',
  'pimpampum-plugin-lifecycle',
  'pimpampum-service',
  'pimpampum-sync',
  'pimpampum-update',
];

function fail(message) {
  throw new Error(`Omarchy delivery validation failed: ${message}`);
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (actual.join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has unexpected or missing fields`);
  }
  return value;
}

function boundedJson(path, maximumBytes, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  if (metadata.size <= 0 || metadata.size > maximumBytes) fail(`${label} has an invalid size`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Omarchy delivery validation failed: ${label} is not valid JSON`, {
      cause: error,
    });
  }
}

function regularChild(root, child, label) {
  const path = join(root, child);
  const fromRoot = relative(root, resolve(path));
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(`${label} escapes the plugin root`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  return { path, metadata };
}

export function validateOmarchyDelivery(candidate = defaultPluginRoot) {
  const pluginRoot = realpathSync(resolve(candidate));
  const rootMetadata = lstatSync(pluginRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail('plugin root must be a real directory');
  }
  for (const name of readdirSync(pluginRoot)) {
    const metadata = lstatSync(join(pluginRoot, name));
    if (metadata.isSymbolicLink()) fail(`top-level symlink is forbidden: ${name}`);
  }

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
  );
  if (
    pluginManifest.schemaVersion !== 1 ||
    pluginManifest.id !== 'dev.pimpampum.status' ||
    typeof pluginManifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(pluginManifest.version) ||
    JSON.stringify(pluginManifest.kinds) !== JSON.stringify(['bar-widget'])
  ) {
    fail('plugin manifest identity or kind is incompatible');
  }
  const entryPoints = exactObject(pluginManifest.entryPoints, ['barWidget'], 'entryPoints');
  if (entryPoints.barWidget !== 'BarWidget.qml') fail('bar widget entry point is incompatible');
  regularChild(pluginRoot, entryPoints.barWidget, 'bar widget entry point');

  const runtimeManifestPath = join(pluginRoot, 'runtime-manifest.json');
  const runtimeManifest = exactObject(
    boundedJson(runtimeManifestPath, 16 * 1024, 'runtime manifest'),
    ['version', 'targets'],
    'runtime manifest',
  );
  if (
    typeof runtimeManifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(runtimeManifest.version)
  ) {
    fail('runtime manifest version must be exact semver');
  }
  if (runtimeManifest.version !== pluginManifest.version) {
    fail('plugin and runtime manifest versions must match');
  }
  const targets = exactObject(runtimeManifest.targets, supportedTargets, 'runtime targets');
  const targetEvidence = {};
  for (const target of supportedTargets) {
    const entry = exactObject(targets[target], ['url', 'sha256', 'maximumBytes'], target);
    const expectedUrl =
      `https://github.com/r-bart/pimpampum/releases/download/v${runtimeManifest.version}/` +
      `pimpampum-runtime-${runtimeManifest.version}-${target}.tar.gz`;
    if (entry.url !== expectedUrl) fail(`${target} URL is not the exact pinned release asset`);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      fail(`${target} SHA-256 is invalid`);
    }
    if (entry.sha256 === '0'.repeat(64)) fail(`${target} SHA-256 is empty`);
    if (
      !Number.isSafeInteger(entry.maximumBytes) ||
      entry.maximumBytes <= 0 ||
      entry.maximumBytes > 100_663_296
    ) {
      fail(`${target} maximumBytes is outside the bootstrap bound`);
    }
    targetEvidence[target] = {
      artifactSha256: entry.sha256,
      maximumBytes: entry.maximumBytes,
      url: entry.url,
    };
  }

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
      sha256: createHash('sha256').update(contents).digest('hex'),
      mode: metadata.mode & 0o777,
      size: contents.byteLength,
    };
  }

  const qmlLaunchedHelpers = new Set();
  for (const name of readdirSync(pluginRoot).filter((child) => child.endsWith('.qml'))) {
    const { path } = regularChild(pluginRoot, name, name);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(
      /Qt\.resolvedUrl\(\s*["'](pimpampum-[a-z0-9-]+)["']\s*\)/gu,
    )) {
      qmlLaunchedHelpers.add(match[1]);
    }
  }
  for (const helper of qmlLaunchedHelpers) {
    if (!Object.hasOwn(helperEvidence, helper)) {
      fail(`QML launches an unvalidated helper: ${helper}`);
    }
  }

  return {
    schemaVersion: 1,
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeVersion: runtimeManifest.version,
    runtimeManifestSha256: createHash('sha256')
      .update(readFileSync(runtimeManifestPath))
      .digest('hex'),
    targets: targetEvidence,
    helpers: helperEvidence,
    qmlLaunchedHelpers: [...qmlLaunchedHelpers].sort(),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = validateOmarchyDelivery(process.argv[2] ?? defaultPluginRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
