#!/usr/bin/env node

// Verifies that the reviewed Omarchy runtime pins equal the exact archives CI built.
//
//   check-reviewed-runtime-manifest.mjs <runtime-bundles-root> [repository-root] [--output <path>]
//
// On a mismatch it prints the generated manifest, and `--output` writes it to a file the workflow
// uploads, so a release pin is copied from CI instead of rebuilt on a laptop that yields other
// digests.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  options = {},
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
  const generatedText = `${JSON.stringify(generated, null, 2)}\n`;
  // Written before the comparison so a failing run still leaves the artifact to copy from.
  if (options.outputPath) writeFileSync(options.outputPath, generatedText, { mode: 0o644 });
  const reviewedPath = join(
    repositoryRoot,
    'integrations/omarchy/pimpampum-status/runtime-manifest.json',
  );
  const reviewed = parseJson(reviewedPath, 'reviewed Omarchy runtime manifest');
  if (JSON.stringify(reviewed) !== JSON.stringify(generated)) {
    process.stderr.write(
      `Generated Omarchy runtime manifest (copy it to ${reviewedPath}):\n${generatedText}`,
    );
    fail('checked-in Omarchy manifest does not match the exact runtime archives');
  }
  return generated;
}

function parseArguments(argv) {
  const positional = [];
  let outputPath;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') {
      outputPath = argv[index + 1];
      if (!outputPath) fail('--output needs a path');
      index += 1;
    } else {
      positional.push(argv[index]);
    }
  }
  return { positional, outputPath };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { positional, outputPath } = parseArguments(process.argv.slice(2));
  const runtimeBundlesRoot = positional[0];
  if (!runtimeBundlesRoot) {
    fail(
      'usage: check-reviewed-runtime-manifest.mjs <runtime-bundles-root> [repository-root] [--output <path>]',
    );
  }
  const result = checkReviewedRuntimeManifest(
    runtimeBundlesRoot,
    positional[1] ?? defaultRepositoryRoot,
    outputPath ? { outputPath: resolve(outputPath) } : {},
  );
  process.stdout.write(
    `Reviewed Omarchy manifest matches ${Object.keys(result.targets).length} exact runtime archives.\n`,
  );
}
