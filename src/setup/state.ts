import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { writePrivateFileAtomic } from '../fsAtomic.js';
import {
  MAXIMUM_PRIVATE_STATE_BYTES,
  PRIVATE_FILE_MODE,
  assertPrivateDirectory,
  createSetupLifecycleLock,
  readPrivateJsonFile,
  removePrivateFile,
} from '../lifecycleLock.js';
import { isRecord } from '../objects.js';
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
const migrationStateFileName = 'installation-migration-state.json';
const maximumStateBytes = MAXIMUM_PRIVATE_STATE_BYTES;
const privateFileMode = PRIVATE_FILE_MODE;

// The lock moved to a neutral module so the service layer can share it; keep the setup-side name.
export { createSetupLifecycleLock };

const connectorIdSchema = z.enum(SETUP_CONNECTOR_IDS);
const hexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nulFree = (value: string): boolean => !value.includes('\0');
const boundedText = (maximum: number): z.ZodString => z.string().min(1).max(maximum);
const nulFreeText = (maximum: number): z.ZodString => boundedText(maximum).refine(nulFree);
/** Every list the journal stores is short, made of short NUL-free strings. */
const stringListSchema = z.array(z.string().max(1_024).refine(nulFree)).max(256);

/**
 * Runs one schema and reports the failure the way every durable file here always did: a
 * `schemaVersion` mismatch is "unsupported", anything else is "invalid". The Zod issues stay on
 * the cause so a diagnostic can still say which field broke.
 */
function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  subject: string,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const schemaMismatch = result.error.issues.some((issue) => issue.path[0] === 'schemaVersion');
  throw new Error(schemaMismatch ? `Unsupported ${subject} schema` : `Invalid ${subject}`, {
    cause: result.error,
  });
}

const connectorResultSchema = z.object({
  id: connectorIdSchema,
  configured: z.boolean(),
  available: z.boolean(),
  newSessionRequired: z.boolean(),
  state: z.string().max(128),
  error: z.string().max(320).optional(),
});

function connectorResult(value: z.output<typeof connectorResultSchema>): SetupConnectorResult {
  return {
    id: value.id,
    configured: value.configured,
    available: value.available,
    newSessionRequired: value.newSessionRequired,
    state: value.state,
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

const setupJournalSchema = z.object({
  schemaVersion: z.literal(SETUP_SCHEMA_VERSION),
  operationId: boundedText(128),
  revision: boundedText(128),
  phase: boundedText(256),
  selectedConnectors: z.array(connectorIdSchema).max(256),
  conflictDecisions: z.partialRecord(connectorIdSchema, z.enum(['keep', 'replace', 'cancel'])),
  reviewedConflictFingerprints: z.partialRecord(connectorIdSchema, hexDigestSchema).optional(),
  completedPhases: stringListSchema,
  diagnostics: stringListSchema,
  service: z.object({ installed: z.boolean(), running: z.boolean(), verified: z.boolean() }),
  connectors: z.array(connectorResultSchema).max(SETUP_CONNECTOR_IDS.length),
  loginItem: z.enum(['pending', 'enabled', 'requires-approval', 'denied']),
  status: z.enum(['running', 'complete', 'partial', 'conflict', 'failed']),
  updatedAt: boundedText(128),
});

function parseSetupJournal(value: unknown): SetupJournal {
  const parsed = parseWith(setupJournalSchema, value, 'setup state');
  const reviewed = parsed.reviewedConflictFingerprints ?? {};
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    operationId: parsed.operationId,
    revision: parsed.revision,
    phase: parsed.phase,
    selectedConnectors: parsed.selectedConnectors,
    conflictDecisions: parsed.conflictDecisions,
    ...(Object.keys(reviewed).length === 0 ? {} : { reviewedConflictFingerprints: reviewed }),
    completedPhases: parsed.completedPhases,
    diagnostics: parsed.diagnostics,
    service: parsed.service,
    connectors: parsed.connectors.map(connectorResult),
    loginItem: parsed.loginItem,
    status: parsed.status,
    updatedAt: parsed.updatedAt,
  };
}

const setupPlanSchema = z.object({
  operationId: nulFreeText(128),
  revision: hexDigestSchema,
  selectedConnectors: z
    .array(connectorIdSchema)
    .max(256)
    .refine((ids) => new Set(ids).size === ids.length),
  changes: z
    .array(
      z.object({
        kind: nulFreeText(128),
        summary: nulFreeText(512),
        path: z.string().max(2_048).refine(nulFree).optional(),
      }),
    )
    .max(64),
  conflicts: z
    .array(
      z.object({
        connectorId: connectorIdSchema,
        comparison: nulFreeText(512),
        entryFingerprint: hexDigestSchema.optional(),
      }),
    )
    .max(SETUP_CONNECTOR_IDS.length),
  requiresConfirmation: z.literal(true),
});

function parseSetupPlan(value: unknown): SetupPlan {
  const parsed = parseWith(setupPlanSchema, value, 'durable setup plan');
  return {
    operationId: parsed.operationId,
    revision: parsed.revision,
    selectedConnectors: parsed.selectedConnectors,
    changes: parsed.changes.map((change) => ({
      kind: change.kind,
      summary: change.summary,
      ...(change.path === undefined ? {} : { path: change.path }),
    })),
    conflicts: parsed.conflicts.map((conflict) => ({
      connectorId: conflict.connectorId,
      comparison: conflict.comparison,
      ...(conflict.entryFingerprint === undefined
        ? {}
        : { entryFingerprint: conflict.entryFingerprint }),
    })),
    requiresConfirmation: true,
  };
}

const installationSnapshotSchema = z.object({
  runtimeVersion: boundedText(128),
  serviceCommand: stringListSchema.min(2),
  connectorEntries: z.record(z.string(), z.unknown()),
  adapter: boundedText(128).optional(),
  dataDirectory: nulFreeText(4_096).optional(),
  runtimeKind: z.enum(['legacy-npm', 'packaged']).optional(),
});

function installationSnapshot(
  parsed: z.output<typeof installationSnapshotSchema>,
): InstallationSnapshot {
  return {
    runtimeVersion: parsed.runtimeVersion,
    serviceCommand: [...parsed.serviceCommand],
    connectorEntries: structuredClone(parsed.connectorEntries),
    ...(parsed.adapter === undefined ? {} : { adapter: parsed.adapter }),
    ...(parsed.dataDirectory === undefined ? {} : { dataDirectory: parsed.dataDirectory }),
    ...(parsed.runtimeKind === undefined ? {} : { runtimeKind: parsed.runtimeKind }),
  };
}

const MIGRATION_PHASES = [
  'staged',
  'stopping',
  'activating',
  'installing',
  'starting',
  'verifying',
  'reconciling',
  'committing',
  'committed',
] as const satisfies readonly InstallationMigrationJournal['phase'][];

/** Canonical base64 of a receipt between one byte and the migration snapshot limit. */
const receiptBase64Schema = z
  .string()
  .max(maximumStateBytes)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
  .refine((encoded) => {
    const bytes = Buffer.from(encoded, 'base64');
    return (
      bytes.byteLength > 0 && bytes.byteLength <= 700_000 && bytes.toString('base64') === encoded
    );
  });

const migrationJournalSchema = z.object({
  schemaVersion: z.literal(SETUP_SCHEMA_VERSION),
  targetVersion: boundedText(128),
  phase: z.enum(MIGRATION_PHASES),
  previous: installationSnapshotSchema,
  previousReceiptBase64: receiptBase64Schema.optional(),
  connectorEntries: z.record(z.string(), z.unknown()),
  staged: z.object({ version: z.string(), nodePath: z.string(), cliPath: z.string() }),
  updatedAt: boundedText(128),
});

function parseMigrationJournal(value: unknown): InstallationMigrationJournal {
  const parsed = parseWith(migrationJournalSchema, value, 'installation migration state');
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    targetVersion: parsed.targetVersion,
    phase: parsed.phase,
    previous: installationSnapshot(parsed.previous),
    ...(parsed.previousReceiptBase64 === undefined
      ? {}
      : { previousReceiptBase64: parsed.previousReceiptBase64 }),
    connectorEntries: structuredClone(parsed.connectorEntries),
    staged: {
      version: parsed.staged.version,
      nodePath: parsed.staged.nodePath,
      cliPath: parsed.staged.cliPath,
    },
    updatedAt: parsed.updatedAt,
  };
}

function readStateFile(path: string): SetupJournal | null {
  const value = readPrivateJsonFile(path, 'Setup state');
  return value === null ? null : parseSetupJournal(value);
}

function writePrivateJsonFile(path: string, value: unknown): void {
  assertPrivateDirectory(dirname(path));
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents) > maximumStateBytes) {
    throw new Error('Setup state exceeds the size limit');
  }
  writePrivateFileAtomic(path, contents, { mode: privateFileMode, label: 'Private setup file' });
}

function writeStateFile(path: string, state: SetupJournal): void {
  writePrivateJsonFile(path, parseSetupJournal(state));
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
