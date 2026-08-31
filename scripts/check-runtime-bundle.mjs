#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const RUNTIME_TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ platform: 'darwin', architecture: 'arm64' }),
  'linux-arm64': Object.freeze({ platform: 'linux', architecture: 'arm64' }),
  'linux-x64': Object.freeze({ platform: 'linux', architecture: 'x64' }),
});

export const MAXIMUM_UNPACKED_BYTES = 175 * 1024 * 1024;
export const MAXIMUM_ARCHIVE_BYTES = 96 * 1024 * 1024;
const MAXIMUM_ARCHIVE_OUTPUT_BYTES = MAXIMUM_UNPACKED_BYTES + 16 * 1024 * 1024;
const MAXIMUM_FILES = 100_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const ALLOWED_MODES = new Set([0o644, 0o755]);
const INSTALLED_ADDON_PATH = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

function fail(message) {
  throw new Error(`Invalid runtime bundle: ${message}`);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} has unexpected field ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing field ${JSON.stringify(key)}`);
  }
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function nonemptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function containsControlCharacterOrBackslash(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === '\\' || codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function validateBundlePath(value, label = 'path') {
  const path = nonemptyString(value, label);
  if (
    Buffer.byteLength(path) > 1024 ||
    containsControlCharacterOrBackslash(path) ||
    posix.isAbsolute(path) ||
    path === '.' ||
    path === '..' ||
    path.startsWith('./') ||
    path.endsWith('/') ||
    posix.normalize(path) !== path ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail(`${label} is absolute, unsafe, non-canonical, or contains path traversal`);
  }
  return path;
}

function target(value, label = 'target') {
  const targetId = nonemptyString(value, label);
  if (!Object.hasOwn(RUNTIME_TARGETS, targetId)) fail(`${label} ${targetId} is unsupported`);
  return targetId;
}

function manifestFile(value, index) {
  const candidate = record(value, `files[${index}]`);
  exactKeys(candidate, ['mode', 'path', 'sha256', 'size'], `files[${index}]`);
  const path = validateBundlePath(candidate.path, `files[${index}].path`);
  const hash = nonemptyString(candidate.sha256, `files[${index}].sha256`);
  if (!SHA256_PATTERN.test(hash) || /^0{64}$/u.test(hash)) fail(`files[${index}] has invalid hash`);
  const mode = safeInteger(candidate.mode, `files[${index}].mode`);
  if (!ALLOWED_MODES.has(mode)) fail(`files[${index}] has invalid mode`);
  return { path, sha256: hash, mode, size: safeInteger(candidate.size, `files[${index}].size`) };
}

export function parseBundleManifest(value, expectedTarget) {
  const candidate = record(value, 'manifest');
  exactKeys(
    candidate,
    [
      'entrypoints',
      'files',
      'nodeVersion',
      'pimpampumVersion',
      'schemaVersion',
      'target',
      'unpackedBytes',
    ],
    'manifest',
  );
  if (candidate.schemaVersion !== 1) fail('manifest schemaVersion must be 1');
  const pimpampumVersion = nonemptyString(candidate.pimpampumVersion, 'Pimpampum version');
  const nodeVersion = nonemptyString(candidate.nodeVersion, 'Node version');
  if (!VERSION_PATTERN.test(pimpampumVersion) || !VERSION_PATTERN.test(nodeVersion)) {
    fail('manifest versions must be exact semantic versions');
  }
  const targetCandidate = record(candidate.target, 'manifest target');
  exactKeys(targetCandidate, ['architecture', 'platform'], 'manifest target');
  const targetId = target(`${targetCandidate.platform}-${targetCandidate.architecture}`);
  if (expectedTarget !== undefined && targetId !== target(expectedTarget, 'expected target')) {
    fail(`wrong target: expected ${expectedTarget}, received ${targetId}`);
  }
  const entrypointsCandidate = record(candidate.entrypoints, 'entrypoints');
  exactKeys(entrypointsCandidate, ['cli', 'mcp', 'node'], 'entrypoints');
  const entrypoints = Object.fromEntries(
    Object.entries(entrypointsCandidate).map(([name, path]) => [
      name,
      validateBundlePath(path, `${name} entrypoint`),
    ]),
  );
  if (new Set(Object.values(entrypoints)).size !== 3) fail('entrypoints must be distinct');
  const unpackedBytes = safeInteger(candidate.unpackedBytes, 'unpackedBytes', 1);
  if (unpackedBytes > MAXIMUM_UNPACKED_BYTES) fail('manifest exceeds maximum unpacked size');
  if (!Array.isArray(candidate.files) || candidate.files.length === 0)
    fail('files must not be empty');
  if (candidate.files.length > MAXIMUM_FILES) fail('manifest has too many files');
  const files = candidate.files.map(manifestFile);
  const seen = new Set();
  let total = 0;
  for (const file of files) {
    if (seen.has(file.path)) fail(`duplicate file path ${file.path}`);
    seen.add(file.path);
    total += file.size;
    if (!Number.isSafeInteger(total) || total > MAXIMUM_UNPACKED_BYTES)
      fail('file size total is too large');
  }
  if (total !== unpackedBytes) fail('manifest unpackedBytes does not match file sizes');
  for (const [name, path] of Object.entries(entrypoints)) {
    if (!seen.has(path)) fail(`${name} entrypoint is missing from files`);
  }
  const addons = files.filter((file) => file.path.endsWith('.node'));
  if (addons.length !== 1 || addons[0].path !== INSTALLED_ADDON_PATH) {
    fail(`bundle must contain only the installed native addon ${INSTALLED_ADDON_PATH}`);
  }
  return {
    schemaVersion: 1,
    pimpampumVersion,
    nodeVersion,
    target: RUNTIME_TARGETS[targetId],
    unpackedBytes,
    entrypoints,
    files,
  };
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) fail(`symlink is not allowed: ${relative(root, path)}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
      else fail(`device or special file is not allowed: ${relative(root, path)}`);
    }
  };
  visit(root);
  return files;
}

function assertInside(root, path, label) {
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`))
    fail(`${label} escapes its root`);
}

export function assertNativeBinaryTarget(path, targetId, label = 'native binary') {
  const bytes = readFileSync(path);
  if (bytes.length < 20) fail(`${label} is too small to identify`);
  if (targetId === 'darwin-arm64') {
    const magic = bytes.readUInt32LE(0);
    const cpuType = bytes.readUInt32LE(4);
    if (magic !== 0xfeedfacf || cpuType !== 0x0100000c) fail(`${label} is not Mach-O arm64`);
    return;
  }
  if (bytes.subarray(0, 4).compare(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) !== 0) {
    fail(`${label} is not ELF`);
  }
  if (bytes[4] !== 2) fail(`${label} must be 64-bit ELF`);
  if (bytes[5] !== 1) fail(`${label} must be little-endian ELF`);
  const machine = bytes.readUInt16LE(18);
  const expectedMachine = targetId === 'linux-x64' ? 62 : 183;
  if (machine !== expectedMachine) fail(`${label} has the wrong architecture`);
}

function tarString(header, offset, length) {
  const end = header.indexOf(0, offset);
  const boundedEnd = end === -1 || end > offset + length ? offset + length : end;
  return header.subarray(offset, boundedEnd).toString('utf8');
}

function tarOctal(header, offset, length, label) {
  const value = tarString(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) fail(`archive ${label} is not octal`);
  return Number.parseInt(value, 8);
}

export function readRuntimeArchive(path) {
  const compressed = readFileSync(path);
  if (compressed.length === 0 || compressed.length > MAXIMUM_ARCHIVE_BYTES)
    fail('archive size is invalid');
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAXIMUM_ARCHIVE_OUTPUT_BYTES });
  } catch (error) {
    fail(
      `archive cannot be decompressed within limits: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = new Map();
  let offset = 0;
  let foundEndMarker = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > tar.length ||
        !tar.subarray(offset, offset + 1024).every((byte) => byte === 0) ||
        !tar.subarray(offset + 1024).every((byte) => byte === 0)
      ) {
        fail('archive has data after end marker');
      }
      foundEndMarker = true;
      break;
    }
    const recordedChecksum = tarOctal(header, 148, 8, 'checksum');
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (checksum !== recordedChecksum) fail('archive header checksum mismatch');
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const archivePath = validateBundlePath(prefix ? `${prefix}/${name}` : name, 'archive path');
    const type = header[156];
    if (type !== 0 && type !== 0x30)
      fail(`archive has unsupported link/device entry ${archivePath}`);
    const mode = tarOctal(header, 100, 8, 'mode');
    if (!ALLOWED_MODES.has(mode)) fail(`archive entry ${archivePath} has invalid mode`);
    const size = tarOctal(header, 124, 12, 'size');
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) fail(`archive entry ${archivePath} is truncated`);
    if (entries.has(archivePath)) fail(`archive has duplicate entry ${archivePath}`);
    entries.set(archivePath, { mode, content: tar.subarray(contentStart, contentEnd) });
    if (entries.size > MAXIMUM_FILES + 3) fail('archive has too many entries');
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (entries.size === 0) fail('archive is empty');
  if (!foundEndMarker) fail('archive is missing its end marker');
  return entries;
}

function json(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function checkRuntimeBundle(bundleDirectory, options = {}) {
  const root = resolve(bundleDirectory);
  if (!isAbsolute(root) || !statSync(root).isDirectory()) fail('bundle path must be a directory');
  const manifestPath = join(root, 'runtime-manifest.json');
  const manifest = parseBundleManifest(json(manifestPath, 'runtime manifest'), options.targetId);
  const targetId = `${manifest.target.platform}-${manifest.target.architecture}`;
  const archiveName = `pimpampum-runtime-${manifest.pimpampumVersion}-${targetId}.tar.gz`;
  const expectedRootEntries = [
    archiveName,
    'archive-sha256.json',
    'payload',
    'runtime-inventory.json',
    'runtime-manifest.json',
    'runtime-sbom.spdx.json',
  ];
  const rootEntries = readdirSync(root).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries.sort())) {
    fail(`bundle root has missing or unexpected files: ${rootEntries.join(', ')}`);
  }
  for (const name of expectedRootEntries) {
    const metadata = lstatSync(join(root, name));
    if (metadata.isSymbolicLink()) fail(`bundle root entry must not be a symlink: ${name}`);
    if (name === 'payload' ? !metadata.isDirectory() : !metadata.isFile()) {
      fail(`bundle root entry has the wrong type: ${name}`);
    }
  }
  const payloadRoot = join(root, 'payload');
  assertInside(root, payloadRoot, 'payload');
  const actualPaths = walkFiles(payloadRoot).map((path) =>
    relative(payloadRoot, path).split(sep).join('/'),
  );
  const expectedPaths = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actualPaths.sort()) !== JSON.stringify(expectedPaths)) {
    fail('payload has missing or unexpected files');
  }
  for (const file of manifest.files) {
    const path = join(payloadRoot, ...file.path.split('/'));
    assertInside(payloadRoot, path, `payload file ${file.path}`);
    const metadata = statSync(path);
    const mode = metadata.mode & 0o777;
    const content = readFileSync(path);
    if (mode !== file.mode) fail(`mode drift for ${file.path}`);
    if (content.length !== file.size) fail(`size drift for ${file.path}`);
    if (sha256(content) !== file.sha256) fail(`hash drift for ${file.path}`);
  }
  assertNativeBinaryTarget(join(payloadRoot, 'bin/node'), targetId, 'Node binary');
  assertNativeBinaryTarget(
    join(payloadRoot, ...INSTALLED_ADDON_PATH.split('/')),
    targetId,
    'better-sqlite3 addon',
  );
  const inventory = json(join(root, 'runtime-inventory.json'), 'runtime inventory');
  exactKeys(
    record(inventory, 'runtime inventory'),
    ['files', 'schemaVersion', 'target'],
    'runtime inventory',
  );
  if (
    inventory.schemaVersion !== 1 ||
    inventory.target !== targetId ||
    canonicalJson(inventory.files) !== canonicalJson(manifest.files)
  ) {
    fail('runtime inventory differs from manifest');
  }
  const sbom = record(json(join(root, 'runtime-sbom.spdx.json'), 'runtime SBOM'), 'runtime SBOM');
  if (
    sbom.spdxVersion !== 'SPDX-2.3' ||
    sbom.dataLicense !== 'CC0-1.0' ||
    !Array.isArray(sbom.packages)
  ) {
    fail('runtime SBOM has an invalid SPDX contract');
  }
  if (options.lockfilePath !== undefined) {
    const lockHash = sha256(readFileSync(options.lockfilePath));
    if (sbom.documentComment !== `package-lock.json sha256:${lockHash}`)
      fail('runtime SBOM lockfile hash drift');
  }
  const archivePath = join(root, archiveName);
  const descriptor = record(
    json(join(root, 'archive-sha256.json'), 'archive descriptor'),
    'archive descriptor',
  );
  exactKeys(descriptor, ['file', 'schemaVersion', 'sha256', 'size'], 'archive descriptor');
  const archiveBytes = readFileSync(archivePath);
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.file !== archiveName ||
    descriptor.size !== archiveBytes.length ||
    descriptor.sha256 !== sha256(archiveBytes)
  ) {
    fail('archive SHA-256 or size drift');
  }
  const archiveEntries = readRuntimeArchive(archivePath);
  const metadataFiles = [
    'runtime-inventory.json',
    'runtime-manifest.json',
    'runtime-sbom.spdx.json',
  ];
  const expectedArchivePaths = [
    ...metadataFiles,
    ...manifest.files.map((file) => `payload/${file.path}`),
  ].sort();
  if (JSON.stringify([...archiveEntries.keys()].sort()) !== JSON.stringify(expectedArchivePaths)) {
    fail('archive has missing or unexpected entries');
  }
  for (const name of metadataFiles) {
    const entry = archiveEntries.get(name);
    const content = readFileSync(join(root, name));
    if (entry.mode !== 0o644 || !entry.content.equals(content))
      fail(`archive metadata drift for ${name}`);
  }
  for (const file of manifest.files) {
    const entry = archiveEntries.get(`payload/${file.path}`);
    if (entry.mode !== file.mode || sha256(entry.content) !== file.sha256) {
      fail(`archive payload drift for ${file.path}`);
    }
  }
  return {
    valid: true,
    target: targetId,
    version: manifest.pimpampumVersion,
    files: manifest.files.length,
    unpackedBytes: manifest.unpackedBytes,
    archiveSha256: descriptor.sha256,
  };
}

function cliArguments(arguments_) {
  const [bundleDirectory, ...rest] = arguments_;
  if (!bundleDirectory)
    fail(
      'usage: check-runtime-bundle.mjs <bundle-directory> --target <target> [--lockfile <path>]',
    );
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--target') options.targetId = rest[++index];
    else if (argument === '--lockfile') options.lockfilePath = rest[++index];
    else fail(`unknown argument ${argument}`);
  }
  if (!options.targetId) fail('--target is required');
  return { bundleDirectory, options };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { bundleDirectory, options } = cliArguments(process.argv.slice(2));
    const result = checkRuntimeBundle(bundleDirectory, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
