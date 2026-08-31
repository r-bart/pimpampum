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
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  SETUP_CONNECTOR_IDS,
  SETUP_SCHEMA_VERSION,
  type SetupConnectorResult,
  type SetupJournal,
  type SetupStateStore,
} from './types.js';

const stateFileName = 'setup-state.json';
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

function readStateFile(path: string): SetupJournal | null {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Setup state must be a regular file and not a symlink');
  }
  if (metadata.size > maximumStateBytes) throw new Error('Setup state exceeds the size limit');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error('Setup state changed while it was being opened');
    }
    const contents = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(contents) > maximumStateBytes) {
      throw new Error('Setup state exceeds the size limit');
    }
    return parseSetupJournal(JSON.parse(contents) as unknown);
  } finally {
    closeSync(descriptor);
  }
}

function writeStateFile(path: string, state: SetupJournal): void {
  const directory = dirname(path);
  assertPrivateDirectory(directory);
  const temporaryPath = join(directory, `.setup-state.${process.pid}.${randomUUID()}.tmp`);
  const contents = `${JSON.stringify(parseSetupJournal(state))}\n`;
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

export function createSetupStateStore(dataDirectory: string): SetupStateStore {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Error('Setup data directory must be an absolute, NUL-free path');
  }
  const path = join(dataDirectory, stateFileName);
  return {
    path,
    read: () => readStateFile(path),
    write: (state) => writeStateFile(path, state),
    remove: () => rmSync(path, { force: true }),
  };
}

export function readSetupState(dataDirectory: string): SetupJournal | null {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Error('Setup data directory must be an absolute, NUL-free path');
  }
  return readStateFile(join(dataDirectory, stateFileName));
}
