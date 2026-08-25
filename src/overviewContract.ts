import { z } from 'zod';
import { AppError } from './errors.js';
import type { Overview } from './types.js';

const timestampSchema = z.iso.datetime();
const identifierSchema = z.string().min(1);
const countSchema = z.number().int().nonnegative();

export const overviewSchema = z.strictObject({
  daemon: z.strictObject({
    version: z.string().min(1),
    startedAt: timestampSchema,
    uptimeSeconds: countSchema,
  }),
  generatedAt: timestampSchema,
  status: z.enum(['active', 'available', 'complete', 'draft', 'empty']),
  counts: z.strictObject({
    workspaces: countSchema,
    projects: countSchema,
    draftProjects: countSchema,
    readyProjects: countSchema,
    completedProjects: countSchema,
    openTasks: countSchema,
    completedTasks: countSchema,
    activeClaims: countSchema,
    availableWork: countSchema,
  }),
  projects: z
    .array(
      z.strictObject({
        id: identifierSchema,
        workspace: z.strictObject({
          id: identifierSchema,
          name: z.string().min(1).max(120),
          rootPath: z.string().min(1),
        }),
        slug: identifierSchema,
        title: z.string().min(1).max(200),
        lifecycleState: z.enum(['draft', 'ready', 'done']),
        status: z.enum(['active', 'available', 'complete', 'draft']),
        openTaskCount: countSchema,
        completedTaskCount: countSchema,
        activeClaimCount: countSchema,
        availableWorkCount: countSchema,
        updatedAt: timestampSchema,
      }),
    )
    .max(500),
  projectsTruncated: z.boolean(),
  activeWork: z
    .array(
      z.strictObject({
        targetType: z.enum(['project', 'task']),
        targetId: identifierSchema,
        workspaceId: identifierSchema,
        projectId: identifierSchema,
        projectTitle: z.string().min(1).max(200),
        taskId: identifierSchema.nullable(),
        taskTitle: z.string().min(1).max(300).nullable(),
        agentId: z.string().min(1).max(200),
        expiresAt: timestampSchema,
      }),
    )
    .max(500),
  activeWorkTruncated: z.boolean(),
});

export const overviewEnvelopeSchema = z.strictObject({
  data: overviewSchema,
  meta: z.strictObject({ schemaVersion: z.literal(1) }),
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
