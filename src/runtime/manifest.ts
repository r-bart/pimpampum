import { posix } from 'node:path';

import type {
  ParseRuntimeManifestOptions,
  RuntimeArchitecture,
  RuntimeEntrypoints,
  RuntimeManifest,
  RuntimeManifestFile,
  RuntimePlatform,
  RuntimeTarget,
  RuntimeTargetId,
} from './types.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const MAXIMUM_MANIFEST_FILES = 100_000;
const MAXIMUM_MANIFEST_PATH_BYTES = 1_024;
const ALLOWED_FILE_MODES = new Set([0o644, 0o755]);
const REQUIRED_NATIVE_ADDON = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

function fail(message: string): never {
  throw new Error(`Invalid runtime manifest: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      fail(`${label} contains unexpected field ${JSON.stringify(key)}`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      fail(`${label} is missing field ${JSON.stringify(key)}`);
    }
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function containsControlCharacterOrBackslash(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === '\\' || codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

export function parseRuntimeVersion(value: unknown, label = 'version'): string {
  const version = stringValue(value, label);
  if (!VERSION_PATTERN.test(version)) {
    fail(`${label} must be an exact semantic version`);
  }
  return version;
}

export function runtimeTargetId(target: RuntimeTarget): RuntimeTargetId {
  if (target.platform === 'darwin') {
    return 'darwin-arm64';
  }
  return target.architecture === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

export function parseRuntimeTarget(
  platformValue: unknown,
  architectureValue: unknown,
  label = 'target',
): RuntimeTarget {
  if (platformValue !== 'darwin' && platformValue !== 'linux') {
    fail(`${label} platform is unsupported`);
  }
  if (architectureValue !== 'arm64' && architectureValue !== 'x64') {
    fail(`${label} architecture is unsupported`);
  }
  if (platformValue === 'darwin' && architectureValue !== 'arm64') {
    fail(`${label} darwin-${architectureValue} is unsupported`);
  }
  return { platform: platformValue, architecture: architectureValue } as RuntimeTarget;
}

export function parseRuntimeTargetId(value: unknown): RuntimeTarget {
  const targetId = stringValue(value, 'target id');
  const separator = targetId.indexOf('-');
  if (separator <= 0 || separator === targetId.length - 1) {
    fail('target id is invalid');
  }
  const platform = targetId.slice(0, separator);
  const architecture = targetId.slice(separator + 1);
  return parseRuntimeTarget(platform, architecture, 'target id');
}

export function validateRuntimeRelativePath(value: unknown, label = 'file path'): string {
  const path = stringValue(value, label);
  if (Buffer.byteLength(path, 'utf8') > MAXIMUM_MANIFEST_PATH_BYTES) {
    fail(`${label} is too long`);
  }
  if (containsControlCharacterOrBackslash(path)) {
    fail(`${label} contains a control character or path separator that is not portable`);
  }
  if (
    posix.isAbsolute(path) ||
    path === '.' ||
    path === '..' ||
    path.startsWith('./') ||
    path.endsWith('/') ||
    posix.normalize(path) !== path ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail(`${label} is absolute, non-canonical, or contains path traversal`);
  }
  return path;
}

function parseEntrypoints(value: unknown): RuntimeEntrypoints {
  const candidate = record(value, 'entrypoints');
  exactKeys(candidate, ['cli', 'mcp', 'node'], 'entrypoints');
  const entrypoints = {
    cli: validateRuntimeRelativePath(candidate.cli, 'CLI entrypoint path'),
    mcp: validateRuntimeRelativePath(candidate.mcp, 'MCP entrypoint path'),
    node: validateRuntimeRelativePath(candidate.node, 'Node entrypoint path'),
  };
  if (new Set(Object.values(entrypoints)).size !== 3) {
    fail('entrypoint paths must be distinct');
  }
  return entrypoints;
}

function parseManifestFile(value: unknown, index: number): RuntimeManifestFile {
  const label = `files[${index}]`;
  const candidate = record(value, label);
  exactKeys(candidate, ['mode', 'path', 'sha256', 'size'], label);
  const path = validateRuntimeRelativePath(candidate.path, `${label} path`);
  const sha256 = stringValue(candidate.sha256, `${label} SHA-256`);
  if (!SHA256_PATTERN.test(sha256) || /^0{64}$/u.test(sha256)) {
    fail(`${label} SHA-256 hash is invalid or an unset placeholder`);
  }
  const mode = safeInteger(candidate.mode, `${label} mode`, 0);
  if (!ALLOWED_FILE_MODES.has(mode)) {
    fail(`${label} mode must be 0644 or 0755; special/device modes are not allowed`);
  }
  const size = safeInteger(candidate.size, `${label} size`, 0);
  return { path, sha256, mode, size };
}

function parseTarget(value: unknown): RuntimeTarget {
  const candidate = record(value, 'target');
  exactKeys(candidate, ['architecture', 'platform'], 'target');
  return parseRuntimeTarget(candidate.platform, candidate.architecture);
}

function assertCompleteRuntime(
  entrypoints: RuntimeEntrypoints,
  files: readonly RuntimeManifestFile[],
): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const [name, path] of Object.entries(entrypoints)) {
    const file = byPath.get(path);
    if (file === undefined) {
      fail(`${name} entrypoint ${JSON.stringify(path)} is not listed in files`);
    }
  }
  if (byPath.get(entrypoints.node)?.mode !== 0o755) {
    fail('Node entrypoint mode must be executable (0755)');
  }
  const nativeAddons = files.filter((file) => file.path.endsWith('.node'));
  if (nativeAddons.length !== 1 || nativeAddons[0]!.path !== REQUIRED_NATIVE_ADDON) {
    fail(
      `files must list only the installed native addon ${JSON.stringify(REQUIRED_NATIVE_ADDON)}`,
    );
  }
}

export function parseRuntimeManifest(
  value: unknown,
  options: ParseRuntimeManifestOptions,
): RuntimeManifest {
  const expectedTarget = parseRuntimeTarget(
    options.platform,
    options.architecture,
    'expected target',
  );
  const maximumUnpackedBytes = safeInteger(
    options.maximumUnpackedBytes,
    'maximum unpacked size limit',
    1,
  );
  const candidate = record(value, 'root');
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
    'root',
  );
  if (candidate.schemaVersion !== 1) {
    fail('schema version must be exactly 1');
  }
  const pimpampumVersion = parseRuntimeVersion(candidate.pimpampumVersion, 'Pimpampum version');
  const nodeVersion = parseRuntimeVersion(candidate.nodeVersion, 'Node version');
  const target = parseTarget(candidate.target);
  if (runtimeTargetId(target) !== runtimeTargetId(expectedTarget)) {
    fail(
      `target ${runtimeTargetId(target)} does not match current platform ${runtimeTargetId(expectedTarget)}`,
    );
  }
  const unpackedBytes = safeInteger(candidate.unpackedBytes, 'unpacked size', 1);
  if (unpackedBytes > maximumUnpackedBytes) {
    fail(`unpacked size ${unpackedBytes} exceeds limit ${maximumUnpackedBytes}`);
  }
  const entrypoints = parseEntrypoints(candidate.entrypoints);
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    fail('files must be a non-empty array');
  }
  if (candidate.files.length > MAXIMUM_MANIFEST_FILES) {
    fail(`files exceeds the ${MAXIMUM_MANIFEST_FILES} entry limit`);
  }
  const files = candidate.files.map((file, index) => parseManifestFile(file, index));
  const paths = new Set<string>();
  let computedUnpackedBytes = 0;
  for (const file of files) {
    if (paths.has(file.path)) {
      fail(`duplicate file path ${JSON.stringify(file.path)}`);
    }
    paths.add(file.path);
    computedUnpackedBytes += file.size;
    if (
      !Number.isSafeInteger(computedUnpackedBytes) ||
      computedUnpackedBytes > maximumUnpackedBytes
    ) {
      fail('file size total exceeds the unpacked size limit');
    }
  }
  if (computedUnpackedBytes !== unpackedBytes) {
    fail(
      `unpacked size ${unpackedBytes} does not match manifest file size total ${computedUnpackedBytes}`,
    );
  }
  assertCompleteRuntime(entrypoints, files);

  return {
    schemaVersion: 1,
    pimpampumVersion,
    nodeVersion,
    target,
    unpackedBytes,
    entrypoints,
    files,
  };
}

export type { RuntimeArchitecture, RuntimePlatform };
