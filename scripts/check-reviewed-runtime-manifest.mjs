#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['linux-arm64', 'linux-x64'];
const maximumBytes = 100_663_296;

function fail(message) {
  throw new Error(`Reviewed runtime manifest check failed: ${message}`);
}

function parseJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Reviewed runtime manifest check failed: invalid ${label}`, { cause: error });
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findBundle(root, version, target) {
  for (const candidate of [
    join(root, `pimpampum-runtime-${version}-${target}`),
    join(root, `runtime-${target}`),
  ]) {
    if (existsSync(join(candidate, 'archive-sha256.json'))) return candidate;
  }
  fail(`missing ${target} bundle under ${root}`);
}

export function checkReviewedRuntimeManifest(
  runtimeBundlesRoot,
  repositoryRoot = defaultRepositoryRoot,
) {
  const version = parseJson(join(repositoryRoot, 'package.json'), 'package manifest').version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    fail('package version is not exact semver');
  }

  const generatedTargets = {};
  for (const target of targets) {
    const bundle = findBundle(resolve(runtimeBundlesRoot), version, target);
    const descriptor = parseJson(join(bundle, 'archive-sha256.json'), `${target} descriptor`);
    const expectedFile = `pimpampum-runtime-${version}-${target}.tar.gz`;
    if (
      descriptor?.schemaVersion !== 1 ||
      descriptor.file !== expectedFile ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      typeof descriptor.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(descriptor.sha256)
    ) {
      fail(`${target} descriptor is incompatible`);
    }
    const archive = join(bundle, expectedFile);
    if (!existsSync(archive)) fail(`missing ${target} archive`);
    if (readFileSync(archive).length !== descriptor.size || sha256(archive) !== descriptor.sha256) {
      fail(`${target} archive differs from its descriptor`);
    }
    generatedTargets[target] = {
      url: `https://github.com/r-bart/pimpampum/releases/download/v${version}/${expectedFile}`,
      sha256: descriptor.sha256,
      maximumBytes,
    };
  }

  const generated = { version, targets: generatedTargets };
  const reviewedPath = join(
    repositoryRoot,
    'integrations/omarchy/pimpampum-status/runtime-manifest.json',
  );
  const reviewed = parseJson(reviewedPath, 'reviewed Omarchy runtime manifest');
  if (JSON.stringify(reviewed) !== JSON.stringify(generated)) {
    fail('checked-in Omarchy manifest does not match the exact runtime archives');
  }
  return generated;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeBundlesRoot = process.argv[2];
  if (!runtimeBundlesRoot)
    fail('usage: check-reviewed-runtime-manifest.mjs <runtime-bundles-root>');
  const result = checkReviewedRuntimeManifest(
    runtimeBundlesRoot,
    process.argv[3] ?? defaultRepositoryRoot,
  );
  process.stdout.write(
    `Reviewed Omarchy manifest matches ${Object.keys(result.targets).length} exact runtime archives.\n`,
  );
}
