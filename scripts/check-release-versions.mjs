#!/usr/bin/env node

// One version, every place it is spelled: the release tag, `package.json`, both `server.json`
// fields, the Omarchy plugin manifests, and a site that must read the version instead of writing
// it. Runs as the first release step so a stale copy fails before anything is built.
//
//   check-release-versions.mjs <tag> [repository-root]

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SITE_PAGE = 'site/src/pages/index.astro';

function fail(message) {
  throw new Error(`Release version check failed: ${message}`);
}

function readJson(root, path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch (error) {
    throw new Error(`Release version check failed: ${path} is not valid JSON`, { cause: error });
  }
}

/** Returns the verified version and every source that spelled it. */
export function checkReleaseVersions(tag, repositoryRoot = defaultRepositoryRoot) {
  if (typeof tag !== 'string' || !tag.startsWith('v') || !VERSION_PATTERN.test(tag.slice(1))) {
    fail(`tag ${String(tag)} must be v<major>.<minor>.<patch>`);
  }
  const version = tag.slice(1);
  const sources = {
    'package.json#version': readJson(repositoryRoot, 'package.json').version,
    'server.json#version': readJson(repositoryRoot, 'server.json').version,
    ...Object.fromEntries(
      (readJson(repositoryRoot, 'server.json').packages ?? []).map((entry, index) => [
        `server.json#packages[${String(index)}].version`,
        entry?.version,
      ]),
    ),
    'integrations/omarchy/pimpampum-status/manifest.json#version': readJson(
      repositoryRoot,
      'integrations/omarchy/pimpampum-status/manifest.json',
    ).version,
    'integrations/omarchy/pimpampum-status/runtime-manifest.json#version': readJson(
      repositoryRoot,
      'integrations/omarchy/pimpampum-status/runtime-manifest.json',
    ).version,
  };
  const drift = Object.entries(sources)
    .filter(([, value]) => value !== version)
    .map(([source, value]) => `${source} is ${String(value)}`);
  if (drift.length > 0) fail(`tag ${tag} does not match: ${drift.join('; ')}`);

  // The site reads `package.json` at build time; a literal semver in the page is a copy that will
  // rot on the next release.
  const page = readFileSync(join(repositoryRoot, SITE_PAGE), 'utf8');
  // Exactly three dotted numbers: `127.0.0.1` is an address, not a version.
  const literals = page.match(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/gu) ?? [];
  if (literals.length > 0) {
    fail(`${SITE_PAGE} spells a version literally (${literals.join(', ')}); read package.json`);
  }
  return { version, sources: Object.keys(sources) };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag) fail('usage: check-release-versions.mjs <tag> [repository-root]');
  const result = checkReleaseVersions(tag, process.argv[3] ?? defaultRepositoryRoot);
  process.stdout.write(
    `Release ${tag} matches ${String(result.sources.length)} version sources and a literal-free site page.\n`,
  );
}
