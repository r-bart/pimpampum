import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const idSchema = z.string().uuid().describe('Stable UUID of the resource.');
export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a lowercase kebab-case identifier')
  .describe('Lowercase kebab-case identifier, at most 80 characters.');
export const markdownSchema = z
  .string()
  .max(1_000_000)
  .describe('UTF-8 Markdown content, at most 1,000,000 characters.');
export const absolutePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, 'Use an absolute filesystem path')
  .describe('Absolute filesystem path on the machine running Pimpampum.');
export const projectStateSchema = z
  .enum(['draft', 'open', 'paused', 'done', 'cancelled'])
  .describe('Current Project lifecycle state.');
export const writableProjectStateSchema = z
  .enum(['draft', 'open', 'paused'])
  .describe('Non-terminal Project state; done and cancelled use explicit operations.');
export const specStateSchema = z
  .enum(['draft', 'ready', 'done', 'cancelled'])
  .describe('Current Spec lifecycle state.');
export const writableSpecStateSchema = z
  .enum(['draft', 'ready'])
  .describe('Non-terminal Spec state; done and cancelled use explicit operations.');
export const taskStateSchema = z
  .enum(['open', 'done', 'cancelled'])
  .describe('Current Task lifecycle state.');
export const targetTypeSchema = z
  .enum(['spec', 'task'])
  .describe('Kind of executable resource that may own a Claim.');
export const contextOwnerTypeSchema = z
  .enum(['workspace', 'project'])
  .describe('Scope that owns a Context document.');
export const actorSchema = z.string().min(1).max(200).nullable().default(null);
export const expectedRevisionSchema = z.number().int().positive();
export const artifactSchema = z.strictObject({
  label: z
    .string()
    .max(120)
    .nullable()
    .default(null)
    .describe('Optional human-readable artifact label.'),
  uri: z
    .string()
    .min(1)
    .max(1_000)
    .describe('Artifact URI or absolute path; Pimpampum stores the reference only.'),
});

export const registerWorkspaceSchema = z.strictObject({
  id: slugSchema,
  name: z.string().min(1).max(120),
  rootPath: absolutePathSchema,
});

export const createProjectSchema = z.strictObject({
  workspaceId: slugSchema,
  slug: slugSchema,
  title: z.string().min(1).max(200),
  actor: actorSchema,
});

export const updateProjectSchema = z
  .object({
    title: z.string().min(1).max(200).nullable().default(null),
    state: writableProjectStateSchema.nullable().default(null),
    expectedRevision: expectedRevisionSchema,
    actor: actorSchema,
  })
  .strict()
  .refine(({ title, state }) => title !== null || state !== null, {
    message: 'Provide a title and/or state to update.',
  });

export const createSpecSchema = z.strictObject({
  slug: slugSchema,
  title: z.string().min(1).max(200),
  body: markdownSchema.default(''),
  actor: actorSchema,
});

export const updateSpecSchema = z
  .object({
    title: z.string().min(1).max(200).nullable().default(null),
    body: markdownSchema.nullable().default(null),
    state: writableSpecStateSchema.nullable().default(null),
    expectedRevision: expectedRevisionSchema,
    actor: actorSchema,
  })
  .strict()
  .refine(({ title, body, state }) => title !== null || body !== null || state !== null, {
    message: 'Provide a title, body, and/or state to update.',
  });

export const createTaskSchema = z.strictObject({
  parentId: idSchema.nullable().default(null),
  title: z.string().min(1).max(300),
  body: markdownSchema.nullable().default(null),
  actor: actorSchema,
});

export const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(300).nullable().default(null),
    body: markdownSchema.nullable().optional(),
    expectedRevision: expectedRevisionSchema,
    actor: actorSchema,
  })
  .strict()
  .refine(({ title, body }) => title !== null || body !== undefined, {
    message: 'Provide a title and/or body to update.',
  });

export const putContextSchema = z.strictObject({
  body: markdownSchema,
  expectedRevision: expectedRevisionSchema.nullable().default(null),
  actor: actorSchema,
});

export const cancelSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  reason: z.string().trim().min(1).max(4_000),
  actor: actorSchema,
});

export const claimSchema = z.strictObject({
  agentId: z.string().min(1).max(200),
  leaseSeconds: z.number().int().min(60).max(86_400).default(1_800),
});

export const completeSchema = z.strictObject({
  agentId: z.string().min(1).max(200),
  expectedRevision: expectedRevisionSchema,
  summary: z.string().trim().min(1).max(4_000),
  artifacts: z.array(artifactSchema).max(20).default([]),
});
