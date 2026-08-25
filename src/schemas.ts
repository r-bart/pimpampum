import { z } from 'zod';
import { isAbsolute } from 'node:path';

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
  .enum(['draft', 'ready', 'done'])
  .describe('Current project lifecycle state.');
export const writableProjectStateSchema = z
  .enum(['draft', 'ready'])
  .describe('Writable project state; done is reached only through work completion.');
export const targetTypeSchema = z.enum(['project', 'task']).describe('Kind of claimable resource.');
export const artifactSchema = z.object({
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

export const registerWorkspaceSchema = z.object({
  id: slugSchema,
  name: z.string().min(1).max(120),
  rootPath: absolutePathSchema,
});

export const createProjectSchema = z.object({
  workspaceId: slugSchema,
  slug: slugSchema,
  title: z.string().min(1).max(200),
  prd: markdownSchema.default(''),
  state: writableProjectStateSchema.default('draft'),
  actor: z.string().min(1).max(200).nullable().default(null),
});

export const createTaskSchema = z.object({
  parentId: idSchema.nullable().default(null),
  title: z.string().min(1).max(300),
  body: markdownSchema.nullable().default(null),
  actor: z.string().min(1).max(200).nullable().default(null),
});

export const claimSchema = z.object({
  agentId: z.string().min(1).max(200),
  leaseSeconds: z.number().int().min(60).max(86_400).default(1_800),
});

export const completeSchema = z.object({
  agentId: z.string().min(1).max(200),
  expectedRevision: z.number().int().positive(),
  summary: z.string().min(1).max(4_000),
  artifacts: z.array(artifactSchema).max(20).default([]),
});
