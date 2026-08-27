import { z } from 'zod';
import { AppError } from './errors.js';

const artifact = z.strictObject({ label: z.string().nullable(), uri: z.string().min(1) });
const common = {
  id: z.string().min(1),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

export const syncStateSchema = z.strictObject({
  workspaces: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  ),
  projects: z.array(
    z.strictObject({
      ...common,
      workspaceId: z.string().min(1),
      slug: z.string().min(1),
      title: z.string().min(1),
      state: z.enum(['draft', 'open', 'paused', 'done', 'cancelled']),
      completionSummary: z.string().nullable(),
      artifacts: z.array(artifact),
      completedAt: z.string().datetime().nullable(),
    }),
  ),
  specs: z.array(
    z.strictObject({
      ...common,
      projectId: z.string().min(1),
      slug: z.string().min(1),
      title: z.string().min(1),
      body: z.string(),
      state: z.enum(['draft', 'ready', 'done', 'cancelled']),
      completionSummary: z.string().nullable(),
      artifacts: z.array(artifact),
      completedAt: z.string().datetime().nullable(),
    }),
  ),
  contexts: z.array(
    z.strictObject({
      ...common,
      ownerType: z.enum(['workspace', 'project']),
      ownerId: z.string().min(1),
      name: z.string().min(1),
      body: z.string(),
    }),
  ),
  tasks: z.array(
    z.strictObject({
      ...common,
      specId: z.string().min(1),
      parentId: z.string().nullable(),
      title: z.string().min(1),
      body: z.string().nullable(),
      state: z.enum(['open', 'done', 'cancelled']),
      completionSummary: z.string().nullable(),
      artifacts: z.array(artifact),
      completedAt: z.string().datetime().nullable(),
    }),
  ),
  activity: z.array(
    z.strictObject({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      workspaceId: z.string().nullable(),
      projectId: z.string().nullable(),
      specId: z.string().nullable(),
      targetType: z.string().min(1),
      targetId: z.string().min(1),
      eventType: z.string().min(1),
      actor: z.string().nullable(),
      data: z.record(z.string(), z.unknown()),
      createdAt: z.string().datetime(),
    }),
  ),
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
  entityId: z.string().min(1),
  local: z.unknown(),
  remote: z.unknown(),
  createdAt: z.string().datetime(),
});

export const syncSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotId: z.string().uuid(),
  deviceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
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
  listConflicts(): SyncConflict[] | Promise<SyncConflict[]>;
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
