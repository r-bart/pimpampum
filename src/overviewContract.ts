import { z } from 'zod';
import { AppError } from './errors.js';
import type { Overview } from './types.js';

const timestampSchema = z.iso.datetime();
const identifierSchema = z.string().min(1);
const countSchema = z.number().int().nonnegative();

export const overviewDaemonSchema = z.strictObject({
  version: z.string().min(1),
  startedAt: timestampSchema,
  uptimeSeconds: countSchema,
});

export const overviewCountsSchema = z.strictObject({
  workspaces: countSchema,
  projects: countSchema,
  specs: countSchema,
  draftProjects: countSchema,
  openProjects: countSchema,
  pausedProjects: countSchema,
  completedProjects: countSchema,
  cancelledProjects: countSchema,
  openTasks: countSchema,
  completedTasks: countSchema,
  cancelledTasks: countSchema,
  activeClaims: countSchema,
  availableWork: countSchema,
});

export const overviewWorkspaceSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().min(1).max(120),
  rootPath: z.string().min(1),
});

export const overviewProjectSchema = z.strictObject({
  id: identifierSchema,
  workspace: overviewWorkspaceSchema,
  slug: identifierSchema,
  title: z.string().min(1).max(200),
  lifecycleState: z.enum(['draft', 'open', 'paused', 'done', 'cancelled']),
  status: z.enum(['active', 'available', 'complete', 'draft', 'paused']),
  specCount: countSchema,
  openTaskCount: countSchema,
  completedTaskCount: countSchema,
  activeClaimCount: countSchema,
  availableWorkCount: countSchema,
  updatedAt: timestampSchema,
});

export const overviewSpecSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  projectTitle: z.string().min(1).max(200),
  projectLifecycleState: z.enum(['draft', 'open', 'paused', 'done', 'cancelled']),
  workspace: overviewWorkspaceSchema,
  slug: identifierSchema,
  title: z.string().min(1).max(200),
  lifecycleState: z.enum(['draft', 'ready', 'done', 'cancelled']),
  taskCount: countSchema,
  openTaskCount: countSchema,
  completedTaskCount: countSchema,
  activeClaimCount: countSchema,
  updatedAt: timestampSchema,
});

export const overviewActiveWorkSchema = z.strictObject({
  targetType: z.enum(['spec', 'task']),
  targetId: identifierSchema,
  workspaceId: identifierSchema,
  projectId: identifierSchema,
  projectTitle: z.string().min(1).max(200),
  specId: identifierSchema,
  specTitle: z.string().min(1).max(200),
  taskId: identifierSchema.nullable(),
  taskTitle: z.string().min(1).max(300).nullable(),
  agentId: z.string().min(1).max(200),
  expiresAt: timestampSchema,
});

export const overviewSchema = z.strictObject({
  daemon: overviewDaemonSchema,
  generatedAt: timestampSchema,
  status: z.enum(['active', 'available', 'complete', 'draft', 'paused', 'empty']),
  counts: overviewCountsSchema,
  projects: z.array(overviewProjectSchema).max(500),
  projectsTruncated: z.boolean(),
  specs: z.array(overviewSpecSchema).max(500),
  specsTruncated: z.boolean(),
  activeWork: z.array(overviewActiveWorkSchema).max(500),
  activeWorkTruncated: z.boolean(),
});

export const overviewEnvelopeSchema = z.strictObject({
  data: overviewSchema,
  meta: z.strictObject({ schemaVersion: z.literal(2) }),
});

export function parseOverview(value: unknown): Overview {
  const parsed = overviewSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('internal_error', 'Pimpampum returned an invalid overview', 502, true, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
