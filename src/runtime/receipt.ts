import { statSync } from 'node:fs';
import { join } from 'node:path';

import { isRecord } from '../objects.js';
import { createRuntimeLaunchers } from './launchers.js';
import { resolveRuntimeLayout } from './layout.js';
import {
  assertPrivateMode,
  fail,
  hash,
  parseOwnedJson,
  pathEntryExists,
  readOwnedMetadata,
  receiptPath,
  writeOwnedFile,
} from './ownedFiles.js';
import type {
  RuntimeHostInput,
  RuntimeInstallReceipt,
  RuntimeLayout,
  RuntimeOwnedVersion,
} from './types.js';

/**
 * The receipt is the commit point of every activation and the only proof of ownership the
 * installer accepts: it pins the active version, the entrypoints under the private layout and the
 * SHA-256 of both launchers. Everything here is read-only except `writeReceipt` and the launcher
 * repair, which only the lock-holding modules call.
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECEIPT_KEYS: readonly string[] = [
  'cliPath',
  'controlLauncherPath',
  'controlLauncherSha256',
  'currentVersion',
  'mcpLauncherPath',
  'mcpLauncherSha256',
  'mcpPath',
  'nodePath',
  'ownedVersions',
  'schemaVersion',
  'targetId',
];

export function layoutFor(host: RuntimeHostInput, version: string): RuntimeLayout {
  return resolveRuntimeLayout({
    homeDirectory: host.homeDirectory,
    platform: host.platform,
    architecture: host.architecture,
    version,
  });
}

function parseOwnedVersion(entry: unknown, host: RuntimeHostInput): RuntimeOwnedVersion {
  if (!isRecord(entry)) fail('owned runtime is invalid');
  if (
    Object.keys(entry).sort().join(',') !== 'directory,targetId,version' ||
    typeof entry.version !== 'string'
  ) {
    fail('owned runtime schema is invalid');
  }
  const layout = layoutFor(host, entry.version);
  if (entry.targetId !== layout.targetId || entry.directory !== layout.versionDirectory) {
    fail('owned runtime path is outside the private layout');
  }
  return { version: entry.version, targetId: layout.targetId, directory: layout.versionDirectory };
}

function sha256Field(candidate: Record<string, unknown>, key: string): string {
  const value = candidate[key];
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`runtime receipt ${key} is invalid`);
  }
  return value;
}

/** Validates a parsed receipt against the layout the host would compute; `null` passes through. */
export function parseReceipt(value: unknown, host: RuntimeHostInput): RuntimeInstallReceipt | null {
  if (value === null) return null;
  if (!isRecord(value)) fail('runtime receipt is invalid');
  if (value.schemaVersion !== 1 || RECEIPT_KEYS.some((key) => !Object.hasOwn(value, key))) {
    fail('runtime receipt schema is invalid');
  }
  if (Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key))) {
    fail('runtime receipt has unexpected fields');
  }
  if (typeof value.currentVersion !== 'string') fail('runtime receipt version is invalid');
  const layout = layoutFor(host, value.currentVersion);
  if (value.targetId !== layout.targetId) fail('runtime receipt target is invalid');
  const expected = {
    nodePath: join(layout.versionDirectory, 'bin/node'),
    cliPath: join(layout.versionDirectory, 'dist/cli.js'),
    mcpPath: join(layout.versionDirectory, 'dist/mcpStdio.js'),
    controlLauncherPath: layout.controlLauncherPath,
    mcpLauncherPath: layout.mcpLauncherPath,
  };
  for (const [key, path] of Object.entries(expected)) {
    if (value[key] !== path) fail(`runtime receipt ${key} is outside the owned layout`);
  }
  const controlLauncherSha256 = sha256Field(value, 'controlLauncherSha256');
  const mcpLauncherSha256 = sha256Field(value, 'mcpLauncherSha256');
  if (!Array.isArray(value.ownedVersions)) fail('runtime receipt ownedVersions is invalid');
  return {
    schemaVersion: 1,
    currentVersion: value.currentVersion,
    targetId: layout.targetId,
    ...expected,
    controlLauncherSha256,
    mcpLauncherSha256,
    ownedVersions: value.ownedVersions.map((entry) => parseOwnedVersion(entry, host)),
  };
}

export function readReceipt(host: RuntimeHostInput): RuntimeInstallReceipt | null {
  const path = receiptPath(host.dataDirectory);
  const exists = pathEntryExists(path);
  const value = parseOwnedJson(path, 'Runtime receipt');
  if (exists && value === null) fail('runtime receipt is invalid');
  if (value !== null) assertPrivateMode(path, 'Runtime receipt');
  return parseReceipt(value, host);
}

export function writeReceipt(dataDirectory: string, receipt: RuntimeInstallReceipt): void {
  writeOwnedFile(receiptPath(dataDirectory), `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
}

/** Both launchers must exist, hash to the receipt's pins and be executable; no receipt is fine. */
export function verifyOwnedLaunchers(receipt: RuntimeInstallReceipt | null): void {
  if (receipt === null) return;
  for (const [path, expectedHash] of [
    [receipt.controlLauncherPath, receipt.controlLauncherSha256],
    [receipt.mcpLauncherPath, receipt.mcpLauncherSha256],
  ] as const) {
    const content = readOwnedMetadata(path, 'Owned runtime launcher');
    if (
      content === null ||
      hash(content) !== expectedHash ||
      (statSync(path).mode & 0o777) !== 0o755
    ) {
      fail(`owned runtime launcher drift at ${path}`);
    }
  }
}

/**
 * Rewrites launchers that drifted after their receipt committed. The receipt pins both launcher
 * hashes and the paths they are rendered from, so a regenerated launcher that matches the pinned
 * hash is exactly the committed byte sequence. Anything else is a genuine tamper and fails.
 */
export function repairOwnedLaunchers(receipt: RuntimeInstallReceipt): void {
  const launchers = createRuntimeLaunchers({
    nodePath: receipt.nodePath,
    cliPath: receipt.cliPath,
    mcpPath: receipt.mcpPath,
  });
  if (
    hash(launchers.control) !== receipt.controlLauncherSha256 ||
    hash(launchers.mcp) !== receipt.mcpLauncherSha256
  ) {
    verifyOwnedLaunchers(receipt);
    return;
  }
  writeOwnedFile(receipt.controlLauncherPath, launchers.control, 0o755);
  writeOwnedFile(receipt.mcpLauncherPath, launchers.mcp, 0o755);
  verifyOwnedLaunchers(receipt);
}

/** A launcher on disk without a receipt belongs to someone else; with one it must match it. */
export function assertLauncherOwnership(
  layout: RuntimeLayout,
  receipt: RuntimeInstallReceipt | null,
): void {
  for (const path of [layout.controlLauncherPath, layout.mcpLauncherPath]) {
    if (pathEntryExists(path) && receipt === null) {
      fail(`existing launcher has no ownership receipt: ${path}`);
    }
  }
  verifyOwnedLaunchers(receipt);
}

export function ownedVersionsWith(
  receipt: RuntimeInstallReceipt | null,
  version: string,
  targetId: RuntimeOwnedVersion['targetId'],
  directory: string,
): RuntimeOwnedVersion[] {
  const byIdentity = new Map(
    (receipt?.ownedVersions ?? []).map((owned) => [`${owned.version}:${owned.targetId}`, owned]),
  );
  byIdentity.set(`${version}:${targetId}`, { version, targetId, directory });
  return [...byIdentity.values()].sort((left, right) => left.version.localeCompare(right.version));
}
