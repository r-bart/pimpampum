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
const boundedEntityArray = <T extends z.ZodType>(schema: T) => z.array(schema).max(50_000);

export const syncDeviceIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);

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
    }),
  ),
  contexts: boundedEntityArray(
    z.strictObject({
      ...common,
      ownerType: z.enum(['workspace', 'project']),
      ownerId: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
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
  schemaVersion: z.literal(1),
  snapshotId: z.string().uuid(),
  deviceId: syncDeviceIdSchema,
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
  parentSnapshots: z.array(z.string().uuid()).max(100),
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

export function parseSyncSnapshot(value: unknown): SyncSnapshot {
  const parsed = syncSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('bad_request', 'Shared snapshot is invalid', 400, false, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
