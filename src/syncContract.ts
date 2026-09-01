import { z } from 'zod';
import { AppError } from './errors.js';
import {
  artifactSchema,
  idSchema,
  markdownSchema,
  projectStateSchema,
  slugSchema,
  specStateSchema,
  taskStateSchema,
} from './schemas.js';

const common = {
  id: idSchema,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};
const completionSummarySchema = z.string().trim().min(1).max(4_000).nullable();
/**
 * `cancelled_at` is absent from the JSON when the row is NULL instead of being
 * an explicit `null`. Snapshots written before schema version 2 never carried
 * the key, so omitting it keeps the canonical form of an unchanged entity
 * identical across the upgrade and avoids spurious merge conflicts.
 */
const cancelledAtSchema = z.string().datetime().optional();
const boundedEntityArray = <T extends z.ZodType>(schema: T) => z.array(schema).max(50_000);

export const syncDeviceIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
/**
 * Version 2 sorts the canonical form by UTF-16 code units. Version 1 sorted with
 * the process locale, so its hash is accepted only when it matches the
 * code-unit order as well.
 */
export const SYNC_SNAPSHOT_SCHEMA_VERSION = 2;
const MAX_APPLIED_HEADS = 100;

export const syncStateSchema = z.strictObject({
  workspaces: boundedEntityArray(
    z.strictObject({
      id: slugSchema,
      name: z.string().min(1).max(120),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  ),
  projects: boundedEntityArray(
    z.strictObject({
      ...common,
      workspaceId: slugSchema,
      slug: slugSchema,
      title: z.string().min(1).max(200),
      state: projectStateSchema,
      completionSummary: completionSummarySchema,
      artifacts: z.array(artifactSchema).max(20),
      completedAt: z.string().datetime().nullable(),
      cancelledAt: cancelledAtSchema,
    }),
  ),
  specs: boundedEntityArray(
    z.strictObject({
      ...common,
      projectId: idSchema,
      slug: slugSchema,
      title: z.string().min(1).max(200),
      body: markdownSchema,
      state: specStateSchema,
      completionSummary: completionSummarySchema,
      artifacts: z.array(artifactSchema).max(20),
      completedAt: z.string().datetime().nullable(),
      cancelledAt: cancelledAtSchema,
    }),
  ),
  contexts: boundedEntityArray(
    z.strictObject({
      ...common,
      ownerType: z.enum(['workspace', 'project']),
      ownerId: z.string().min(1).max(200),
      // The same slug rule HTTP and MCP enforce; the name becomes a file name in
      // portable exports, so the shared folder must not widen it.
      name: slugSchema,
      body: markdownSchema,
    }),
  ),
  tasks: boundedEntityArray(
    z.strictObject({
      ...common,
      specId: idSchema,
      parentId: idSchema.nullable(),
      title: z.string().min(1).max(300),
      body: markdownSchema.nullable(),
      state: taskStateSchema,
      completionSummary: completionSummarySchema,
      artifacts: z.array(artifactSchema).max(20),
      completedAt: z.string().datetime().nullable(),
      cancelledAt: cancelledAtSchema,
    }),
  ),
  activity: z
    .array(
      z.strictObject({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        workspaceId: slugSchema.nullable(),
        projectId: idSchema.nullable(),
        specId: idSchema.nullable(),
        targetType: z.string().min(1).max(100),
        targetId: z.string().min(1).max(200),
        eventType: z.string().min(1).max(200),
        actor: z.string().min(1).max(200).nullable(),
        data: z.record(z.string(), z.unknown()),
        createdAt: z.string().datetime(),
      }),
    )
    .max(100_000),
});

export type SyncState = z.infer<typeof syncStateSchema>;
export type SyncEntityKind = 'workspace' | 'project' | 'spec' | 'context' | 'task';

export interface SyncConflict {
  id: string;
  entityType: SyncEntityKind;
  entityId: string;
  local: unknown;
  remote: unknown;
  createdAt: string;
}

export type SyncConflictManifest = Pick<
  SyncConflict,
  'id' | 'entityType' | 'entityId' | 'createdAt'
>;

export const syncConflictSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  entityType: z.enum(['workspace', 'project', 'spec', 'context', 'task']),
  entityId: z.string().min(1).max(200),
  local: z.unknown(),
  remote: z.unknown(),
  createdAt: z.string().datetime(),
});

export const syncSnapshotSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(SYNC_SNAPSHOT_SCHEMA_VERSION)]),
  snapshotId: z.string().uuid(),
  deviceId: syncDeviceIdSchema,
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
  parentSnapshots: z.array(z.string().uuid()).max(100),
  /**
   * The newest snapshot of every device the publisher had applied, keyed by
   * device ID. Retention reads it to learn which of its own snapshots every
   * other device has acknowledged. Version 1 snapshots do not carry it.
   */
  appliedHeads: z
    .record(syncDeviceIdSchema, z.string().uuid())
    .refine((heads) => Object.keys(heads).length <= MAX_APPLIED_HEADS, {
      message: `appliedHeads lists more than ${MAX_APPLIED_HEADS} devices`,
    })
    .optional(),
  resolutions: z
    .array(
      z.strictObject({
        entityType: z.enum(['workspace', 'project', 'spec', 'context', 'task']),
        entityId: z.string().min(1),
      }),
    )
    .max(1_000)
    .optional(),
  stateHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  state: syncStateSchema,
});
export type SyncSnapshot = z.infer<typeof syncSnapshotSchema>;

export type SyncStatusState =
  | 'disabled'
  | 'paused'
  | 'pending'
  | 'importing'
  | 'exporting'
  | 'healthy'
  | 'unavailable'
  | 'error'
  | 'conflict';

/**
 * A shared snapshot file that failed validation. `path` is relative to the
 * shared synchronization directory so the user can find the file without the
 * status leaking the absolute folder twice.
 */
export interface SyncBlockedSnapshot {
  path: string;
  reason: string;
}

export interface SyncStatus {
  enabled: boolean;
  paused: boolean;
  state: SyncStatusState;
  directory: string | null;
  deviceId: string | null;
  lastAttemptAt: string | null;
  lastImportAt: string | null;
  lastExportAt: string | null;
  pendingSnapshotCount: number;
  conflictCount: number;
  error: string | null;
  blockedSnapshot: SyncBlockedSnapshot | null;
}

export interface SyncGateway {
  getStatus(): SyncStatus;
  configure(parentDirectory: string, deviceId: string): Promise<SyncStatus>;
  reconcile(): Promise<SyncStatus>;
  pause(): Promise<SyncStatus>;
  resume(): Promise<SyncStatus>;
  forget(): Promise<SyncStatus>;
  listConflicts(input?: {
    limit: number;
    offset: number;
  }): SyncConflict[] | Promise<SyncConflict[]>;
  getConflict(conflictId: string): SyncConflict | null | Promise<SyncConflict | null>;
  resolveConflict(conflictId: string, choice: 'local' | 'remote'): Promise<SyncStatus>;
}

const snapshotVersionProbe = z.looseObject({ schemaVersion: z.number().int() });

export function parseSyncSnapshot(value: unknown): SyncSnapshot {
  const probe = snapshotVersionProbe.safeParse(value);
  if (probe.success && probe.data.schemaVersion > SYNC_SNAPSHOT_SCHEMA_VERSION) {
    throw new AppError(
      'bad_request',
      `Shared snapshot uses format ${probe.data.schemaVersion}; upgrade Pimpampum on this device`,
      400,
      false,
      { schemaVersion: probe.data.schemaVersion },
    );
  }
  const parsed = syncSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('bad_request', 'Shared snapshot is invalid', 400, false, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
