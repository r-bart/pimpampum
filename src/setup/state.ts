import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  SETUP_CONNECTOR_IDS,
  SETUP_SCHEMA_VERSION,
  type SetupConnectorResult,
  type InstallationMigrationJournal,
  type InstallationMigrationStateStore,
  type InstallationSnapshot,
  type SetupJournal,
  type SetupPlan,
  type SetupPlanStore,
  type SetupStateStore,
} from './types.js';

const stateFileName = 'setup-state.json';
const planFileName = 'setup-plan.json';
const lifecycleLockFileName = '.setup-lifecycle.lock';
const migrationStateFileName = 'installation-migration-state.json';
const maximumStateBytes = 1_000_000;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPrivateDirectory(dataDirectory: string): void {
  mkdirSync(dataDirectory, { recursive: true, mode: privateDirectoryMode });
  const metadata = lstatSync(dataDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Setup data directory must be a regular private directory');
  }
  chmodSync(dataDirectory, privateDirectoryMode);
}

function assertSafeExistingDirectory(directory: string): boolean {
  try {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Setup data directory must be a regular private directory');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some((item) => typeof item !== 'string' || item.length > 1_024 || item.includes('\0'))
  ) {
    throw new Error(`Invalid setup state ${label}`);
  }
}

function parseConnectorResult(value: unknown): SetupConnectorResult {
  if (!isRecord(value) || !SETUP_CONNECTOR_IDS.includes(value.id as never)) {
    throw new Error('Invalid setup connector result');
  }
  if (
    typeof value.configured !== 'boolean' ||
    typeof value.available !== 'boolean' ||
    typeof value.newSessionRequired !== 'boolean' ||
    typeof value.state !== 'string' ||
    value.state.length > 128
  ) {
    throw new Error('Invalid setup connector result');
  }
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 320)) {
    throw new Error('Invalid setup connector diagnostic');
  }
  return {
    id: value.id as SetupConnectorResult['id'],
    configured: value.configured,
    available: value.available,
    newSessionRequired: value.newSessionRequired,
    state: value.state,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function parseSetupJournal(value: unknown): SetupJournal {
  if (!isRecord(value) || value.schemaVersion !== SETUP_SCHEMA_VERSION) {
    throw new Error('Unsupported setup state schema');
  }
  assertStringArray(value.selectedConnectors, 'selected connectors');
  if (value.selectedConnectors.some((id) => !SETUP_CONNECTOR_IDS.includes(id as never))) {
    throw new Error('Invalid setup connector ID');
  }
  assertStringArray(value.completedPhases, 'completed phases');
  assertStringArray(value.diagnostics, 'diagnostics');
  if (!isRecord(value.conflictDecisions)) throw new Error('Invalid setup conflict decisions');
  const conflictDecisions: SetupJournal['conflictDecisions'] = {};
  for (const [id, decision] of Object.entries(value.conflictDecisions)) {
    if (
      !SETUP_CONNECTOR_IDS.includes(id as never) ||
      !['keep', 'replace', 'cancel'].includes(decision as string)
    ) {
      throw new Error('Invalid setup conflict decision');
    }
    conflictDecisions[id as keyof typeof conflictDecisions] = decision as
      'keep' | 'replace' | 'cancel';
  }
  const reviewedConflictFingerprints: NonNullable<SetupJournal['reviewedConflictFingerprints']> =
    {};
  if (value.reviewedConflictFingerprints !== undefined) {
    if (!isRecord(value.reviewedConflictFingerprints)) {
      throw new Error('Invalid reviewed setup conflict fingerprints');
    }
    for (const [id, fingerprint] of Object.entries(value.reviewedConflictFingerprints)) {
      if (
        !SETUP_CONNECTOR_IDS.includes(id as never) ||
        typeof fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(fingerprint)
      ) {
        throw new Error('Invalid reviewed setup conflict fingerprint');
      }
      reviewedConflictFingerprints[id as keyof typeof reviewedConflictFingerprints] = fingerprint;
    }
  }
  if (!Array.isArray(value.connectors) || value.connectors.length > SETUP_CONNECTOR_IDS.length) {
    throw new Error('Invalid setup connector results');
  }
  const service = value.service;
  if (
    !isRecord(service) ||
    typeof service.installed !== 'boolean' ||
    typeof service.running !== 'boolean' ||
    typeof service.verified !== 'boolean'
  ) {
    throw new Error('Invalid setup service state');
  }
  const loginStates = ['pending', 'enabled', 'requires-approval', 'denied'];
  const statuses = ['running', 'complete', 'partial', 'conflict', 'failed'];
  if (
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    value.operationId.length > 128 ||
    typeof value.revision !== 'string' ||
    value.revision.length === 0 ||
    value.revision.length > 128 ||
    typeof value.phase !== 'string' ||
    value.phase.length === 0 ||
    value.phase.length > 256 ||
    typeof value.updatedAt !== 'string' ||
    value.updatedAt.length === 0 ||
    value.updatedAt.length > 128 ||
    !loginStates.includes(value.loginItem as string) ||
    !statuses.includes(value.status as string)
  ) {
    throw new Error('Invalid setup state envelope');
  }
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    operationId: value.operationId,
    revision: value.revision,
    phase: value.phase,
    selectedConnectors: value.selectedConnectors as SetupJournal['selectedConnectors'],
    conflictDecisions,
    ...(Object.keys(reviewedConflictFingerprints).length === 0
      ? {}
      : { reviewedConflictFingerprints }),
    completedPhases: [...value.completedPhases],
    diagnostics: [...value.diagnostics],
    service: {
      installed: service.installed,
      running: service.running,
      verified: service.verified,
    },
    connectors: value.connectors.map(parseConnectorResult),
    loginItem: value.loginItem as SetupJournal['loginItem'],
    status: value.status as SetupJournal['status'],
    updatedAt: value.updatedAt,
  };
}

function boundedString(value: unknown, label: string, maximum = 1_024): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid setup plan ${label}`);
  }
  return value;
}

function parseSetupPlan(value: unknown): SetupPlan {
  if (!isRecord(value)) throw new Error('Invalid durable setup plan');
  assertStringArray(value.selectedConnectors, 'selected connectors');
  if (
    value.selectedConnectors.some((id) => !SETUP_CONNECTOR_IDS.includes(id as never)) ||
    new Set(value.selectedConnectors).size !== value.selectedConnectors.length
  ) {
    throw new Error('Invalid durable setup plan connector IDs');
  }
  if (!Array.isArray(value.changes) || value.changes.length > 64) {
    throw new Error('Invalid durable setup plan changes');
  }
  const changes = value.changes.map((change) => {
    if (!isRecord(change)) throw new Error('Invalid durable setup plan change');
    const path = change.path;
    if (
      path !== undefined &&
      (typeof path !== 'string' || path.length > 2_048 || path.includes('\0'))
    ) {
      throw new Error('Invalid durable setup plan path');
    }
    return {
      kind: boundedString(change.kind, 'change kind', 128),
      summary: boundedString(change.summary, 'change summary', 512),
      ...(typeof path === 'string' ? { path } : {}),
    };
  });
  if (!Array.isArray(value.conflicts) || value.conflicts.length > SETUP_CONNECTOR_IDS.length) {
    throw new Error('Invalid durable setup plan conflicts');
  }
  const conflicts = value.conflicts.map((conflict) => {
    if (!isRecord(conflict) || !SETUP_CONNECTOR_IDS.includes(conflict.connectorId as never)) {
      throw new Error('Invalid durable setup plan conflict');
    }
    return {
      connectorId: conflict.connectorId as SetupPlan['conflicts'][number]['connectorId'],
      comparison: boundedString(conflict.comparison, 'conflict comparison', 512),
      ...(conflict.entryFingerprint === undefined
        ? {}
        : {
            entryFingerprint: (() => {
              const fingerprint = boundedString(
                conflict.entryFingerprint,
                'conflict fingerprint',
                64,
              );
              if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
                throw new Error('Invalid durable setup plan conflict fingerprint');
              }
              return fingerprint;
            })(),
          }),
    };
  });
  const revision = boundedString(value.revision, 'revision', 64);
  if (!/^[a-f0-9]{64}$/u.test(revision)) throw new Error('Invalid durable setup plan revision');
  if (value.requiresConfirmation !== true) {
    throw new Error('Durable setup plan must require confirmation');
  }
  return {
    operationId: boundedString(value.operationId, 'operation ID', 128),
    revision,
    selectedConnectors: value.selectedConnectors as SetupPlan['selectedConnectors'],
    changes,
    conflicts,
    requiresConfirmation: true,
  };
}

function parseInstallationSnapshot(value: unknown): InstallationSnapshot {
  if (!isRecord(value)) throw new Error('Invalid installation snapshot');
  assertStringArray(value.serviceCommand, 'installation service command');
  if (
    value.serviceCommand.length < 2 ||
    !isRecord(value.connectorEntries) ||
    typeof value.runtimeVersion !== 'string' ||
    value.runtimeVersion.length === 0 ||
    value.runtimeVersion.length > 128 ||
    (value.adapter !== undefined &&
      (typeof value.adapter !== 'string' ||
        value.adapter.length === 0 ||
        value.adapter.length > 128)) ||
    (value.dataDirectory !== undefined &&
      (typeof value.dataDirectory !== 'string' ||
        value.dataDirectory.length === 0 ||
        value.dataDirectory.length > 4_096 ||
        value.dataDirectory.includes('\0'))) ||
    (value.runtimeKind !== undefined &&
      value.runtimeKind !== 'legacy-npm' &&
      value.runtimeKind !== 'packaged')
  ) {
    throw new Error('Invalid installation snapshot');
  }
  return {
    runtimeVersion: value.runtimeVersion,
    serviceCommand: [...value.serviceCommand],
    connectorEntries: structuredClone(value.connectorEntries),
    ...(typeof value.adapter === 'string' ? { adapter: value.adapter } : {}),
    ...(typeof value.dataDirectory === 'string' ? { dataDirectory: value.dataDirectory } : {}),
    ...(value.runtimeKind === 'legacy-npm' || value.runtimeKind === 'packaged'
      ? { runtimeKind: value.runtimeKind }
      : {}),
  };
}

function parseMigrationJournal(value: unknown): InstallationMigrationJournal {
  if (!isRecord(value) || value.schemaVersion !== SETUP_SCHEMA_VERSION) {
    throw new Error('Unsupported installation migration state schema');
  }
  const phases: InstallationMigrationJournal['phase'][] = [
    'staged',
    'stopping',
    'activating',
    'installing',
    'starting',
    'verifying',
    'reconciling',
    'committing',
    'committed',
  ];
  const receiptBytes =
    typeof value.previousReceiptBase64 === 'string'
      ? Buffer.from(value.previousReceiptBase64, 'base64')
      : null;
  if (
    typeof value.targetVersion !== 'string' ||
    value.targetVersion.length === 0 ||
    value.targetVersion.length > 128 ||
    !phases.includes(value.phase as InstallationMigrationJournal['phase']) ||
    !isRecord(value.connectorEntries) ||
    !isRecord(value.staged) ||
    typeof value.staged.version !== 'string' ||
    typeof value.staged.nodePath !== 'string' ||
    typeof value.staged.cliPath !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    value.updatedAt.length === 0 ||
    value.updatedAt.length > 128 ||
    (value.previousReceiptBase64 !== undefined &&
      (typeof value.previousReceiptBase64 !== 'string' ||
        value.previousReceiptBase64.length > maximumStateBytes ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.previousReceiptBase64) ||
        receiptBytes === null ||
        receiptBytes.byteLength === 0 ||
        receiptBytes.byteLength > 700_000 ||
        receiptBytes.toString('base64') !== value.previousReceiptBase64))
  ) {
    throw new Error('Invalid installation migration state');
  }
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    targetVersion: value.targetVersion,
    phase: value.phase as InstallationMigrationJournal['phase'],
    previous: parseInstallationSnapshot(value.previous),
    ...(typeof value.previousReceiptBase64 === 'string'
      ? { previousReceiptBase64: value.previousReceiptBase64 }
      : {}),
    connectorEntries: structuredClone(value.connectorEntries),
    staged: {
      version: value.staged.version,
      nodePath: value.staged.nodePath,
      cliPath: value.staged.cliPath,
    },
    updatedAt: value.updatedAt,
  };
}

function readPrivateJsonFile(path: string, label: string): unknown | null {
  if (!assertSafeExistingDirectory(dirname(path))) return null;
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file and not a symlink`);
  }
  if (metadata.size > maximumStateBytes) throw new Error(`${label} exceeds the size limit`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`${label} changed while it was being opened`);
    }
    const contents = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(contents) > maximumStateBytes) {
      throw new Error(`${label} exceeds the size limit`);
    }
    return JSON.parse(contents) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

function readStateFile(path: string): SetupJournal | null {
  const value = readPrivateJsonFile(path, 'Setup state');
  return value === null ? null : parseSetupJournal(value);
}

function writePrivateJsonFile(path: string, value: unknown): void {
  const directory = dirname(path);
  assertPrivateDirectory(directory);
  let previous: ReturnType<typeof lstatSync> | null = null;
  try {
    previous = lstatSync(path);
    if (previous.isSymbolicLink() || !previous.isFile()) {
      throw new Error('Private setup file must be a regular file and not a symlink');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporaryPath = join(directory, `.setup-state.${process.pid}.${randomUUID()}.tmp`);
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents) > maximumStateBytes) {
    throw new Error('Setup state exceeds the size limit');
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      privateFileMode,
    );
    writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, privateFileMode);
    let current: ReturnType<typeof lstatSync> | null = null;
    try {
      current = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      (previous === null && current !== null) ||
      (previous !== null &&
        (current === null || current.dev !== previous.dev || current.ino !== previous.ino))
    ) {
      throw new Error('Private setup file changed concurrently');
    }
    renameSync(temporaryPath, path);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function writeStateFile(path: string, state: SetupJournal): void {
  writePrivateJsonFile(path, parseSetupJournal(state));
}

function removePrivateFile(path: string, label: string): void {
  if (!assertSafeExistingDirectory(dirname(path))) return;
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file and not a symlink`);
  }
  unlinkSync(path);
}

export function createSetupStateStore(dataDirectory: string): SetupStateStore {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Error('Setup data directory must be an absolute, NUL-free path');
  }
  const path = join(dataDirectory, stateFileName);
  return {
    path,
    read: () => readStateFile(path),
    write: (state) => writeStateFile(path, state),
    remove: () => removePrivateFile(path, 'Setup state'),
  };
}

export function readSetupState(dataDirectory: string): SetupJournal | null {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Error('Setup data directory must be an absolute, NUL-free path');
  }
  return readStateFile(join(dataDirectory, stateFileName));
}

export function createSetupPlanStore(dataDirectory: string): SetupPlanStore {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Error('Setup data directory must be an absolute, NUL-free path');
  }
  const path = join(dataDirectory, planFileName);
  return {
    path,
    read() {
      const value = readPrivateJsonFile(path, 'Setup plan');
      if (value === null) return null;
      if (!isRecord(value) || value.schemaVersion !== SETUP_SCHEMA_VERSION) {
        throw new Error('Unsupported durable setup plan schema');
      }
      return parseSetupPlan(value.plan);
    },
    write(plan) {
      writePrivateJsonFile(path, {
        schemaVersion: SETUP_SCHEMA_VERSION,
        plan: parseSetupPlan(plan),
      });
    },
    remove: () => removePrivateFile(path, 'Setup plan'),
  };
}

export function createInstallationMigrationStateStore(
  dataDirectory: string,
): InstallationMigrationStateStore {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Error('Migration data directory must be an absolute, NUL-free path');
  }
  const path = join(dataDirectory, migrationStateFileName);
  return {
    path,
    read() {
      const value = readPrivateJsonFile(path, 'Installation migration state');
      return value === null ? null : parseMigrationJournal(value);
    },
    write(state) {
      writePrivateJsonFile(path, parseMigrationJournal(state));
    },
    remove: () => removePrivateFile(path, 'Installation migration state'),
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function recoverStaleLock(path: string): boolean {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Setup lifecycle lock must be a regular file and not a symlink');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Setup lifecycle lock must be private');
  }
  const value = readPrivateJsonFile(path, 'Setup lifecycle lock');
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.nonce !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(value.nonce)
  ) {
    throw new Error('Setup lifecycle lock has an invalid owner');
  }
  if (processIsAlive(value.pid as number)) return false;
  const current = lstatSync(path);
  if (current.dev !== metadata.dev || current.ino !== metadata.ino) return false;
  unlinkSync(path);
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createSetupLifecycleLock(
  dataDirectory: string,
  options: { timeoutMilliseconds?: number; retryMilliseconds?: number } = {},
): { run<T>(operation: () => Promise<T>): Promise<T> } {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Error('Setup data directory must be an absolute, NUL-free path');
  }
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
  const retryMilliseconds = options.retryMilliseconds ?? 25;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    !Number.isSafeInteger(retryMilliseconds) ||
    retryMilliseconds <= 0
  ) {
    throw new Error('Setup lifecycle lock timing must use positive integers');
  }
  const path = join(dataDirectory, lifecycleLockFileName);
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertPrivateDirectory(dataDirectory);
      const nonce = randomUUID();
      const startedAt = Date.now();
      while (true) {
        let descriptor: number | null = null;
        let created = false;
        try {
          descriptor = openSync(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            privateFileMode,
          );
          created = true;
          writeFileSync(
            descriptor,
            `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce })}\n`,
          );
          fsyncSync(descriptor);
          closeSync(descriptor);
          descriptor = null;
          break;
        } catch (error) {
          if (descriptor !== null) closeSync(descriptor);
          if (created) {
            try {
              unlinkSync(path);
            } catch {
              // A failed lock write must not mask its original error.
            }
          }
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (recoverStaleLock(path)) continue;
          if (Date.now() - startedAt >= timeoutMilliseconds) {
            throw new Error('Timed out waiting for the setup lifecycle lock');
          }
          await delay(retryMilliseconds);
        }
      }
      try {
        return await operation();
      } finally {
        const owner = readPrivateJsonFile(path, 'Setup lifecycle lock');
        if (isRecord(owner) && owner.nonce === nonce) {
          removePrivateFile(path, 'Setup lifecycle lock');
        }
      }
    },
  };
}
