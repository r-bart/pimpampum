#!/usr/bin/env node

// Compares the published Omarchy plugin mirror (r-bart/pimpampum-omarchy) with the plugin source
// in this repository. Users install from the mirror, so a version or byte drift between the two is
// exactly the state that turns a release into an install failure on Omarchy.
//
//   check-omarchy-mirror.mjs [--warn] [--ref <commit|branch>] [--retries <count>]
//
// Exit 1 on drift; `--warn` reports the drift and exits 0. `--ref` addresses an immutable commit
// instead of `main`, which sidesteps the raw CDN cache right after a push.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR_RAW_BASE = 'https://raw.githubusercontent.com/r-bart/pimpampum-omarchy';
const PLUGIN_ROOT = 'integrations/omarchy/pimpampum-status';
const MIRRORED_FILES = ['manifest.json', 'runtime-manifest.json'];
const MAXIMUM_BYTES = 64 * 1024;
const TIMEOUT_MILLISECONDS = 15_000;
const RETRY_DELAY_MILLISECONDS = 5_000;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseVersion(bytes, label) {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return `${label} is not valid JSON`;
  }
}

/** Pure comparison: `{ file: bytes }` for both sides, returns human-readable drift lines. */
export function compareOmarchyMirror(input) {
  const drift = [];
  for (const file of MIRRORED_FILES) {
    const local = input.local[file];
    const remote = input.remote[file];
    if (local === undefined) {
      drift.push(`${file}: missing locally`);
      continue;
    }
    if (remote === undefined) {
      drift.push(`${file}: missing on the mirror`);
      continue;
    }
    const localVersion = parseVersion(local, `local ${file}`);
    const remoteVersion = parseVersion(remote, `mirror ${file}`);
    if (localVersion !== remoteVersion) {
      drift.push(
        `${file}: version ${String(remoteVersion)} on the mirror, ${String(localVersion)} locally`,
      );
    }
    const localHash = sha256(local);
    const remoteHash = sha256(remote);
    if (localHash !== remoteHash) {
      drift.push(`${file}: sha256 ${remoteHash} on the mirror, ${localHash} locally`);
    }
  }
  return drift;
}

export function readLocalPluginFiles(repositoryRoot = defaultRepositoryRoot) {
  const files = {};
  for (const file of MIRRORED_FILES) {
    files[file] = readFileSync(join(repositoryRoot, PLUGIN_ROOT, file));
  }
  return files;
}

async function fetchBounded(url, fetchImplementation) {
  const response = await fetchImplementation(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS),
    headers: { Accept: 'application/json, text/plain' },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Mirror fetch ${url} returned HTTP ${String(response.status)}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_BYTES)) {
    throw new Error(`Mirror file ${url} exceeds ${String(MAXIMUM_BYTES)} bytes`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_BYTES) {
    throw new Error(`Mirror file ${url} exceeds ${String(MAXIMUM_BYTES)} bytes`);
  }
  return bytes;
}

export async function fetchMirrorFiles(input = {}) {
  const ref = input.ref ?? 'main';
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const retries = input.retries ?? 0;
  const files = {};
  for (const file of MIRRORED_FILES) {
    const url = `${MIRROR_RAW_BASE}/${ref}/${file}`;
    let bytes;
    for (let attempt = 0; ; attempt += 1) {
      bytes = await fetchBounded(url, fetchImplementation);
      if (bytes !== undefined || attempt >= retries) break;
      await delay(input.retryDelayMilliseconds ?? RETRY_DELAY_MILLISECONDS);
    }
    if (bytes !== undefined) files[file] = bytes;
  }
  return files;
}

function parseArguments(argv) {
  const options = { warn: false, ref: 'main', retries: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--warn') {
      options.warn = true;
    } else if (argument === '--ref' || argument === '--retries') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a value`);
      if (argument === '--ref') options.ref = value;
      else options.retries = Number.parseInt(value, 10);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  if (!/^[A-Za-z0-9._/-]{1,128}$/u.test(options.ref)) throw new Error('Invalid --ref');
  if (!Number.isSafeInteger(options.retries) || options.retries < 0 || options.retries > 30) {
    throw new Error('Invalid --retries');
  }
  return options;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const local = readLocalPluginFiles();
  const remote = await fetchMirrorFiles({ ref: options.ref, retries: options.retries });
  const drift = compareOmarchyMirror({ local, remote });
  if (drift.length === 0) {
    const version = parseVersion(local['manifest.json'], 'local manifest.json');
    process.stdout.write(
      `Omarchy plugin mirror at ${options.ref} matches the local plugin ${String(version)}.\n`,
    );
  } else {
    const lines = drift.map((line) => `  - ${line}`).join('\n');
    if (options.warn) {
      process.stdout.write(
        `Warning: the Omarchy plugin mirror at ${options.ref} differs from the local plugin.\n${lines}\nThe release workflow publishes the mirror after npm; a PR is expected to be ahead.\n`,
      );
    } else {
      process.stderr.write(
        `The Omarchy plugin mirror at ${options.ref} differs from the local plugin.\n${lines}\n`,
      );
      process.exit(1);
    }
  }
}
