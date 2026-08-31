import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createRuntimeLaunchers } from './launchers.js';
import { resolveRuntimeLayout } from './layout.js';
import { parseRuntimeManifest } from './manifest.js';
import type {
  RuntimeArchitecture,
  RuntimeInstallReceipt,
  RuntimeInstallation,
  RuntimeManifest,
  RuntimeOwnedVersion,
  RuntimePlatform,
} from './types.js';

const MAXIMUM_UNPACKED_BYTES = 175 * 1024 * 1024;
const RECEIPT_NAME = 'runtime-install-receipt.json';
const JOURNAL_NAME = 'runtime-install-journal.json';
const MAXIMUM_METADATA_BYTES = 256 * 1024;

type FileSnapshot = { content: string; mode: number } | null;

interface ActivationJournal {
  schemaVersion: 1;
  targetId: string;
  candidateVersion: string;
  finalDirectory: string;
  createdFinal: boolean;
  controlLauncher: FileSnapshot;
  mcpLauncher: FileSnapshot;
  receipt: FileSnapshot;
}

export interface InstallRuntimeInput {
  homeDirectory: string;
  dataDirectory: string;
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
  sourceDirectory: string;
  manifest: RuntimeManifest;
  smoke(installation: RuntimeInstallation): Promise<void>;
}

export interface PruneOwnedRuntimeInput {
  homeDirectory: string;
  dataDirectory: string;
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
  keepVersions?: string[];
}

export interface PreparedRuntimeRemoval {
  commit(): void;
  rollback(): void;
}

function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fail(message: string): never {
  throw new Error(`Runtime installation failed: ${message}`);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`private runtime path must be a regular directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function assertRegularDirectory(path: string, label: string): void {
  if (!isAbsolute(path) || !pathEntryExists(path))
    fail(`${label} must be an existing absolute directory`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    fail(`${label} must be a regular directory`);
}

function relativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  if (value.length === 0 || value.startsWith('../') || value === '..')
    fail('runtime file escapes its root');
  return value;
}

function walkTree(root: string): string[] {
  assertRegularDirectory(root, 'Runtime source');
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      const displayPath = relativePath(root, path);
      if (metadata.isSymbolicLink()) fail(`symlink is not allowed: ${displayPath}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
      else fail(`device or special file is not allowed: ${displayPath}`);
    }
  };
  visit(root);
  return files;
}

function validateRuntimeTree(root: string, manifest: RuntimeManifest): void {
  const actual = walkTree(root);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const actualPaths = actual.map((path) => relativePath(root, path)).sort();
  const expectedPaths = [...expected.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail('runtime contains missing or unexpected files');
  }
  for (const path of actual) {
    const relative = relativePath(root, path);
    const expectedFile = expected.get(relative)!;
    const metadata = statSync(path);
    const content = readFileSync(path);
    if ((metadata.mode & 0o777) !== expectedFile.mode) fail(`mode drift for ${relative}`);
    if (content.length !== expectedFile.size) fail(`size drift for ${relative}`);
    if (hash(content) !== expectedFile.sha256) fail(`hash drift for ${relative}`);
  }
}

function copyRuntimeTree(source: string, destination: string, manifest: RuntimeManifest): void {
  privateDirectory(destination);
  for (const file of manifest.files) {
    const sourcePath = join(source, ...file.path.split('/'));
    const destinationPath = join(destination, ...file.path.split('/'));
    privateDirectory(dirname(destinationPath));
    copyFileSync(sourcePath, destinationPath);
    chmodSync(destinationPath, file.mode);
  }
  validateRuntimeTree(destination, manifest);
}

function metadataFile(path: string, label: string): Buffer | null {
  if (!pathEntryExists(path)) return null;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  if (metadata.size > MAXIMUM_METADATA_BYTES) fail(`${label} is too large`);
  return readFileSync(path);
}

function snapshot(path: string, label: string): FileSnapshot {
  const content = metadataFile(path, label);
  if (content === null) return null;
  return { content: content.toString('base64'), mode: statSync(path).mode & 0o777 };
}

function atomicWrite(path: string, content: Buffer | string, mode: number): void {
  if (mode !== 0o600 && mode !== 0o755) {
    fail(`atomic runtime metadata mode is invalid: ${mode.toString(8)}`);
  }
  privateDirectory(dirname(path));
  if (pathEntryExists(path) && lstatSync(path).isSymbolicLink())
    fail(`refusing to replace symlink ${path}`);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode,
    );
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function restore(path: string, value: FileSnapshot): void {
  if (value === null) {
    rmSync(path, { force: true });
    return;
  }
  atomicWrite(path, Buffer.from(value.content, 'base64'), value.mode);
}

function parseJson(path: string, label: string): unknown {
  const content = metadataFile(path, label);
  if (content === null) return null;
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    fail(`${label} contains invalid JSON`);
  }
}

function receiptPath(dataDirectory: string): string {
  return join(dataDirectory, RECEIPT_NAME);
}

function journalPath(dataDirectory: string): string {
  return join(dataDirectory, JOURNAL_NAME);
}

function parseReceipt(
  value: unknown,
  homeDirectory: string,
  platform: RuntimePlatform,
  architecture: RuntimeArchitecture,
): RuntimeInstallReceipt | null {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('runtime receipt is invalid');
  const candidate = value as Record<string, unknown>;
  const keys = [
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
  if (candidate.schemaVersion !== 1 || keys.some((key) => !Object.hasOwn(candidate, key))) {
    fail('runtime receipt schema is invalid');
  }
  if (Object.keys(candidate).some((key) => !keys.includes(key)))
    fail('runtime receipt has unexpected fields');
  if (typeof candidate.currentVersion !== 'string') fail('runtime receipt version is invalid');
  const layout = resolveRuntimeLayout({
    homeDirectory,
    platform,
    architecture,
    version: candidate.currentVersion,
  });
  if (candidate.targetId !== layout.targetId) fail('runtime receipt target is invalid');
  const expected = {
    nodePath: join(layout.versionDirectory, 'bin/node'),
    cliPath: join(layout.versionDirectory, 'dist/cli.js'),
    mcpPath: join(layout.versionDirectory, 'dist/mcpStdio.js'),
    controlLauncherPath: layout.controlLauncherPath,
    mcpLauncherPath: layout.mcpLauncherPath,
  };
  for (const [key, path] of Object.entries(expected)) {
    if (candidate[key] !== path) fail(`runtime receipt ${key} is outside the owned layout`);
  }
  for (const key of ['controlLauncherSha256', 'mcpLauncherSha256'] as const) {
    if (typeof candidate[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate[key])) {
      fail(`runtime receipt ${key} is invalid`);
    }
  }
  if (!Array.isArray(candidate.ownedVersions)) fail('runtime receipt ownedVersions is invalid');
  const ownedVersions: RuntimeOwnedVersion[] = candidate.ownedVersions.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      fail('owned runtime is invalid');
    const owned = entry as Record<string, unknown>;
    if (
      Object.keys(owned).sort().join(',') !== 'directory,targetId,version' ||
      typeof owned.version !== 'string'
    ) {
      fail('owned runtime schema is invalid');
    }
    const ownedLayout = resolveRuntimeLayout({
      homeDirectory,
      platform,
      architecture,
      version: owned.version,
    });
    if (
      owned.targetId !== ownedLayout.targetId ||
      owned.directory !== ownedLayout.versionDirectory
    ) {
      fail('owned runtime path is outside the private layout');
    }
    return {
      version: owned.version,
      targetId: ownedLayout.targetId,
      directory: ownedLayout.versionDirectory,
    };
  });
  return {
    schemaVersion: 1,
    currentVersion: candidate.currentVersion,
    targetId: layout.targetId,
    nodePath: expected.nodePath,
    cliPath: expected.cliPath,
    mcpPath: expected.mcpPath,
    controlLauncherPath: expected.controlLauncherPath,
    controlLauncherSha256: candidate.controlLauncherSha256 as string,
    mcpLauncherPath: expected.mcpLauncherPath,
    mcpLauncherSha256: candidate.mcpLauncherSha256 as string,
    ownedVersions,
  };
}

function readReceipt(input: {
  dataDirectory: string;
  homeDirectory: string;
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
}): RuntimeInstallReceipt | null {
  const path = receiptPath(input.dataDirectory);
  const value = parseJson(path, 'Runtime receipt');
  if (value !== null && (statSync(path).mode & 0o777) !== 0o600) {
    fail('runtime receipt must be private (0600)');
  }
  return parseReceipt(value, input.homeDirectory, input.platform, input.architecture);
}

function verifyOwnedLaunchers(receipt: RuntimeInstallReceipt | null): void {
  if (receipt === null) return;
  for (const [path, expectedHash] of [
    [receipt.controlLauncherPath, receipt.controlLauncherSha256],
    [receipt.mcpLauncherPath, receipt.mcpLauncherSha256],
  ] as const) {
    const content = metadataFile(path, 'Owned runtime launcher');
    if (
      content === null ||
      hash(content) !== expectedHash ||
      (statSync(path).mode & 0o777) !== 0o755
    ) {
      fail(`owned runtime launcher drift at ${path}`);
    }
  }
}

function removeEmptyParents(path: string, stop: string): void {
  let current = path;
  while (current !== stop && current.startsWith(`${stop}${sep}`)) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function cleanOwnedStaging(versionDirectory: string): void {
  if (!pathEntryExists(versionDirectory)) return;
  assertRegularDirectory(versionDirectory, 'Runtime version directory');
  for (const name of readdirSync(versionDirectory)) {
    if (!name.startsWith('.pimpampum-stage-')) continue;
    const path = join(versionDirectory, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      fail('runtime staging path is unsafe');
    const marker = parseJson(join(path, 'staging-owner.json'), 'Runtime staging marker');
    if (
      typeof marker !== 'object' ||
      marker === null ||
      Array.isArray(marker) ||
      Object.keys(marker).sort().join(',') !== 'owner,schemaVersion' ||
      (marker as Record<string, unknown>).schemaVersion !== 1 ||
      (marker as Record<string, unknown>).owner !== 'pimpampum-runtime-installer'
    ) {
      fail('runtime staging directory is not receipt-owned');
    }
    rmSync(path, { recursive: true });
  }
}

function restoreJournalSnapshot(path: string, value: unknown): void {
  if (value === null) return restore(path, null);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).content !== 'string' ||
    !Number.isInteger((value as Record<string, unknown>).mode)
  ) {
    fail('runtime activation journal snapshot is invalid');
  }
  restore(path, value as FileSnapshot);
}

function recoverInterruptedActivation(input: InstallRuntimeInput): void {
  const path = journalPath(input.dataDirectory);
  const value = parseJson(path, 'Runtime activation journal');
  if (value === null) return;
  if ((statSync(path).mode & 0o777) !== 0o600) {
    fail('runtime activation journal must be private (0600)');
  }
  if (typeof value !== 'object' || Array.isArray(value))
    fail('runtime activation journal is invalid');
  const journal = value as unknown as ActivationJournal;
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.candidateVersion !== 'string' ||
    typeof journal.createdFinal !== 'boolean'
  ) {
    fail('runtime activation journal schema is invalid');
  }
  const layout = resolveRuntimeLayout({
    homeDirectory: input.homeDirectory,
    platform: input.platform,
    architecture: input.architecture,
    version: journal.candidateVersion,
  });
  if (journal.targetId !== layout.targetId || journal.finalDirectory !== layout.versionDirectory) {
    fail('runtime activation journal escapes the owned layout');
  }
  const receipt = readReceipt(input);
  const committed =
    receipt?.currentVersion === journal.candidateVersion && receipt.targetId === journal.targetId;
  if (committed) {
    verifyOwnedLaunchers(receipt);
  } else {
    restoreJournalSnapshot(layout.controlLauncherPath, journal.controlLauncher);
    restoreJournalSnapshot(layout.mcpLauncherPath, journal.mcpLauncher);
    restoreJournalSnapshot(receiptPath(input.dataDirectory), journal.receipt);
    if (journal.createdFinal && pathEntryExists(layout.versionDirectory)) {
      assertRegularDirectory(layout.versionDirectory, 'Interrupted runtime directory');
      rmSync(layout.versionDirectory, { recursive: true });
      removeEmptyParents(dirname(layout.versionDirectory), layout.runtimeDirectory);
    }
  }
  rmSync(path, { force: true });
}

function assertLauncherOwnership(
  layout: ReturnType<typeof resolveRuntimeLayout>,
  receipt: RuntimeInstallReceipt | null,
): void {
  for (const path of [layout.controlLauncherPath, layout.mcpLauncherPath]) {
    if (pathEntryExists(path) && receipt === null)
      fail(`existing launcher has no ownership receipt: ${path}`);
  }
  verifyOwnedLaunchers(receipt);
}

function ownedVersionsWith(
  receipt: RuntimeInstallReceipt | null,
  version: string,
  targetId: RuntimeOwnedVersion['targetId'],
  directory: string,
): RuntimeOwnedVersion[] {
  const byIdentity = new Map(
    (receipt?.ownedVersions ?? []).map((owned) => [`${owned.version}:${owned.targetId}`, owned]),
  );
  byIdentity.set(`${version}:${targetId}`, { version, targetId, directory });
  return [...byIdentity.values()].sort(
    (left, right) =>
      left.version.localeCompare(right.version) || left.targetId.localeCompare(right.targetId),
  );
}

export async function installRuntime(input: InstallRuntimeInput): Promise<RuntimeInstallation> {
  assertRegularDirectory(resolve(input.sourceDirectory), 'Runtime source');
  if (!isAbsolute(input.dataDirectory)) fail('Data directory must be absolute');
  privateDirectory(input.dataDirectory);
  recoverInterruptedActivation(input);
  const manifest = parseRuntimeManifest(input.manifest, {
    platform: input.platform,
    architecture: input.architecture,
    maximumUnpackedBytes: MAXIMUM_UNPACKED_BYTES,
  });
  const layout = resolveRuntimeLayout({
    homeDirectory: input.homeDirectory,
    platform: input.platform,
    architecture: input.architecture,
    version: manifest.pimpampumVersion,
  });
  const sourceDirectory = resolve(input.sourceDirectory);
  validateRuntimeTree(sourceDirectory, manifest);
  const previousReceipt = readReceipt(input);
  assertLauncherOwnership(layout, previousReceipt);
  cleanOwnedStaging(dirname(layout.versionDirectory));
  privateDirectory(dirname(layout.versionDirectory));
  const stagingRoot = join(dirname(layout.versionDirectory), `.pimpampum-stage-${randomUUID()}`);
  const stagedPayload = join(stagingRoot, 'payload');
  privateDirectory(stagingRoot);
  atomicWrite(
    join(stagingRoot, 'staging-owner.json'),
    `${JSON.stringify({ schemaVersion: 1, owner: 'pimpampum-runtime-installer' })}\n`,
    0o600,
  );
  try {
    copyRuntimeTree(sourceDirectory, stagedPayload, manifest);
    const stagedNodePath = join(stagedPayload, ...manifest.entrypoints.node.split('/'));
    const stagedCliPath = join(stagedPayload, ...manifest.entrypoints.cli.split('/'));
    const stagedMcpPath = join(stagedPayload, ...manifest.entrypoints.mcp.split('/'));
    const stagedLaunchers = createRuntimeLaunchers({
      nodePath: stagedNodePath,
      cliPath: stagedCliPath,
      mcpPath: stagedMcpPath,
    });
    const stagedLauncherDirectory = join(stagingRoot, 'launchers');
    privateDirectory(stagedLauncherDirectory);
    const stagedMcpLauncherPath = join(stagedLauncherDirectory, 'pimpampum-mcp');
    atomicWrite(join(stagedLauncherDirectory, 'pimpampum-control'), stagedLaunchers.control, 0o755);
    atomicWrite(stagedMcpLauncherPath, stagedLaunchers.mcp, 0o755);
    await input.smoke({
      activated: false,
      version: manifest.pimpampumVersion,
      nodePath: stagedNodePath,
      cliPath: stagedCliPath,
      mcpLauncherPath: stagedMcpLauncherPath,
      previousVersion: previousReceipt?.currentVersion ?? null,
    });

    const finalExists = pathEntryExists(layout.versionDirectory);
    const previouslyOwned = previousReceipt?.ownedVersions.some(
      (owned) => owned.version === manifest.pimpampumVersion && owned.targetId === layout.targetId,
    );
    if (finalExists) {
      if (!previouslyOwned) fail('runtime destination exists without an ownership receipt');
      validateRuntimeTree(layout.versionDirectory, manifest);
    }
    const finalNodePath = join(layout.versionDirectory, ...manifest.entrypoints.node.split('/'));
    const finalCliPath = join(layout.versionDirectory, ...manifest.entrypoints.cli.split('/'));
    const finalMcpPath = join(layout.versionDirectory, ...manifest.entrypoints.mcp.split('/'));
    const finalLaunchers = createRuntimeLaunchers({
      nodePath: finalNodePath,
      cliPath: finalCliPath,
      mcpPath: finalMcpPath,
    });
    if (
      finalExists &&
      previousReceipt?.currentVersion === manifest.pimpampumVersion &&
      hash(finalLaunchers.control) === previousReceipt.controlLauncherSha256 &&
      hash(finalLaunchers.mcp) === previousReceipt.mcpLauncherSha256
    ) {
      return {
        activated: false,
        version: manifest.pimpampumVersion,
        nodePath: finalNodePath,
        cliPath: finalCliPath,
        mcpLauncherPath: layout.mcpLauncherPath,
        previousVersion: previousReceipt.currentVersion,
      };
    }
    privateDirectory(layout.launchersDirectory);
    const activationJournal: ActivationJournal = {
      schemaVersion: 1,
      targetId: layout.targetId,
      candidateVersion: manifest.pimpampumVersion,
      finalDirectory: layout.versionDirectory,
      createdFinal: !finalExists,
      controlLauncher: snapshot(layout.controlLauncherPath, 'Control launcher'),
      mcpLauncher: snapshot(layout.mcpLauncherPath, 'MCP launcher'),
      receipt: snapshot(receiptPath(input.dataDirectory), 'Runtime receipt'),
    };
    atomicWrite(journalPath(input.dataDirectory), `${JSON.stringify(activationJournal)}\n`, 0o600);
    try {
      if (!finalExists) renameSync(stagedPayload, layout.versionDirectory);
      atomicWrite(layout.controlLauncherPath, finalLaunchers.control, 0o755);
      atomicWrite(layout.mcpLauncherPath, finalLaunchers.mcp, 0o755);
      const receipt: RuntimeInstallReceipt = {
        schemaVersion: 1,
        currentVersion: manifest.pimpampumVersion,
        targetId: layout.targetId,
        nodePath: finalNodePath,
        cliPath: finalCliPath,
        mcpPath: finalMcpPath,
        controlLauncherPath: layout.controlLauncherPath,
        controlLauncherSha256: hash(finalLaunchers.control),
        mcpLauncherPath: layout.mcpLauncherPath,
        mcpLauncherSha256: hash(finalLaunchers.mcp),
        ownedVersions: ownedVersionsWith(
          previousReceipt,
          manifest.pimpampumVersion,
          layout.targetId,
          layout.versionDirectory,
        ),
      };
      atomicWrite(receiptPath(input.dataDirectory), `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
      rmSync(journalPath(input.dataDirectory), { force: true });
    } catch (error) {
      restore(layout.controlLauncherPath, activationJournal.controlLauncher);
      restore(layout.mcpLauncherPath, activationJournal.mcpLauncher);
      restore(receiptPath(input.dataDirectory), activationJournal.receipt);
      if (activationJournal.createdFinal && pathEntryExists(layout.versionDirectory)) {
        assertRegularDirectory(layout.versionDirectory, 'Activated runtime directory');
        rmSync(layout.versionDirectory, { recursive: true });
      }
      rmSync(journalPath(input.dataDirectory), { force: true });
      throw error;
    }
    return {
      activated: true,
      version: manifest.pimpampumVersion,
      nodePath: finalNodePath,
      cliPath: finalCliPath,
      mcpLauncherPath: layout.mcpLauncherPath,
      previousVersion: previousReceipt?.currentVersion ?? null,
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    removeEmptyParents(dirname(stagingRoot), layout.runtimeDirectory);
  }
}

export function pruneOwnedRuntimeVersions(input: PruneOwnedRuntimeInput): string[] {
  const receipt = readReceipt(input);
  if (receipt === null) return [];
  verifyOwnedLaunchers(receipt);
  const keep = new Set([receipt.currentVersion, ...(input.keepVersions ?? [])]);
  const removed: string[] = [];
  const retained: RuntimeOwnedVersion[] = [];
  for (const owned of receipt.ownedVersions) {
    if (keep.has(owned.version)) {
      retained.push(owned);
      continue;
    }
    if (pathEntryExists(owned.directory)) {
      const metadata = lstatSync(owned.directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory())
        fail('owned runtime path is unsafe');
      rmSync(owned.directory, { recursive: true });
      const layout = resolveRuntimeLayout({
        homeDirectory: input.homeDirectory,
        platform: input.platform,
        architecture: input.architecture,
        version: owned.version,
      });
      removeEmptyParents(dirname(owned.directory), layout.runtimeDirectory);
    }
    removed.push(owned.version);
  }
  if (removed.length > 0) {
    atomicWrite(
      receiptPath(input.dataDirectory),
      `${JSON.stringify({ ...receipt, ownedVersions: retained }, null, 2)}\n`,
      0o600,
    );
  }
  return removed;
}

export function prepareOwnedRuntimeRemoval(
  input: Omit<PruneOwnedRuntimeInput, 'keepVersions'>,
): PreparedRuntimeRemoval | null {
  const receipt = readReceipt(input);
  if (receipt === null) return null;
  verifyOwnedLaunchers(receipt);
  const runtimeReceiptPath = receiptPath(input.dataDirectory);
  const receiptSnapshot = snapshot(runtimeReceiptPath, 'Runtime receipt');
  const controlSnapshot = snapshot(receipt.controlLauncherPath, 'Control launcher');
  const mcpSnapshot = snapshot(receipt.mcpLauncherPath, 'MCP launcher');
  const layout = resolveRuntimeLayout({
    homeDirectory: input.homeDirectory,
    platform: input.platform,
    architecture: input.architecture,
    version: receipt.currentVersion,
  });
  privateDirectory(layout.versionsDirectory);
  const quarantineRoot = join(layout.versionsDirectory, `.pimpampum-remove-${randomUUID()}`);
  privateDirectory(quarantineRoot);
  const moved: { original: string; quarantined: string }[] = [];
  let finished = false;

  const rollback = (): void => {
    if (finished) return;
    for (const entry of [...moved].reverse()) {
      if (!pathEntryExists(entry.quarantined)) continue;
      if (pathEntryExists(entry.original)) {
        fail('runtime removal rollback destination already exists');
      }
      renameSync(entry.quarantined, entry.original);
    }
    restore(receipt.controlLauncherPath, controlSnapshot);
    restore(receipt.mcpLauncherPath, mcpSnapshot);
    restore(runtimeReceiptPath, receiptSnapshot);
    rmSync(quarantineRoot, { recursive: true, force: true });
    finished = true;
  };

  try {
    for (const [index, owned] of receipt.ownedVersions.entries()) {
      if (!pathEntryExists(owned.directory)) continue;
      const metadata = lstatSync(owned.directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail('owned runtime path is unsafe');
      }
      const quarantined = join(quarantineRoot, String(index));
      renameSync(owned.directory, quarantined);
      moved.push({ original: owned.directory, quarantined });
    }
    rmSync(receipt.controlLauncherPath, { force: true });
    rmSync(receipt.mcpLauncherPath, { force: true });
    rmSync(runtimeReceiptPath, { force: true });
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Runtime removal and rollback failed');
    }
    throw error;
  }

  return {
    commit() {
      if (finished) return;
      rmSync(quarantineRoot, { recursive: true });
      for (const entry of moved) {
        removeEmptyParents(dirname(entry.original), layout.runtimeDirectory);
      }
      try {
        rmdirSync(layout.launchersDirectory);
      } catch {
        // Preserve a non-empty shared launcher directory.
      }
      try {
        rmdirSync(layout.runtimeDirectory);
      } catch {
        // Preserve a non-empty runtime root containing unreceipted/user content.
      }
      finished = true;
    },
    rollback,
  };
}
