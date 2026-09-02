import { z } from 'zod';
import { absolutePathSchema, pageSchema } from './schemas.js';
import {
  syncConflictSchema,
  syncDeviceIdSchema,
  type SyncConflictManifest,
  type SyncStatus,
} from './syncContract.js';

/**
 * Adapter-facing synchronization schemas. They sit beside `syncContract.ts`
 * rather than inside `schemas.ts` because the contract already imports the
 * primitive schemas; importing it back from there would create a cycle.
 */

export const syncConfigurationInputSchema = z.strictObject({
  directory: absolutePathSchema.describe('Absolute path of the shared folder to synchronize.'),
  deviceId: syncDeviceIdSchema.describe(
    'Stable lowercase device identifier, unique across the devices sharing the folder.',
  ),
});

export const resolveSyncConflictInputSchema = z.strictObject({
  choice: z.enum(['local', 'remote']).describe('Candidate to keep for the conflicting entity.'),
});

/** Same shape the sync controller mints; HTTP and MCP accept nothing wider. */
export const syncConflictIdSchema = syncConflictSchema.shape.id.describe(
  'Stable synchronization conflict identifier from the conflict list.',
);

export const syncBlockedSnapshotSchema = z.strictObject({
  path: z
    .string()
    .describe('Path of the failing snapshot, relative to the shared synchronization directory.'),
  reason: z.string().describe('Why the snapshot was rejected.'),
});

export const syncStatusSchema = z.strictObject({
  enabled: z.boolean(),
  paused: z.boolean(),
  state: z.enum([
    'disabled',
    'paused',
    'pending',
    'importing',
    'exporting',
    'healthy',
    'unavailable',
    'error',
    'conflict',
  ]),
  directory: z.string().nullable(),
  deviceId: syncDeviceIdSchema.nullable(),
  lastAttemptAt: z.iso.datetime().nullable(),
  lastImportAt: z.iso.datetime().nullable(),
  lastExportAt: z.iso.datetime().nullable(),
  pendingSnapshotCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  blockedSnapshot: syncBlockedSnapshotSchema.nullable(),
}) satisfies z.ZodType<SyncStatus>;

export const syncConflictManifestSchema = syncConflictSchema.pick({
  id: true,
  entityType: true,
  entityId: true,
  createdAt: true,
}) satisfies z.ZodType<SyncConflictManifest>;

export const syncConflictManifestPageSchema = pageSchema(syncConflictManifestSchema);
