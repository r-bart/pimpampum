import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from './errors.js';
import type {
  ActivityEvent,
  Claim,
  CompletionDetails,
  ContextDocument,
  ContextManifest,
  ContextManifestPage,
  HealthStatus,
  MarkdownPage,
  Project,
  ProjectManifest,
  Spec,
  SpecManifest,
  Task,
  TaskManifest,
  WorkBundle,
  WorkItem,
  Workspace,
} from './types.js';

/**
 * One catalogue for every value the HTTP and MCP adapters validate and for the
 * shapes the daemon returns. `src/openapi.ts` generates its components from
 * these schemas, so a bound that lives here is a bound the document publishes.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

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
export const timestampSchema = z.iso.datetime().describe('ISO 8601 timestamp in UTC.');
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
  .describe('Context scope: a Workspace or a Project.');
export const contextOwnerIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Workspace ID or Project UUID matching ownerType.');

export const actorSchema = z
  .string()
  .min(1)
  .max(200)
  .nullable()
  .default(null)
  .describe('Optional actor identifier recorded in automatic activity.');
export const agentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Stable identifier of the agent or session that owns the Claim.');
export const revisionSchema = z
  .number()
  .int()
  .positive()
  .describe('Monotonic resource revision; every committed write increments it.');
export const expectedRevisionSchema = revisionSchema.describe(
  'Current resource revision used for optimistic concurrency control.',
);
export const leaseSecondsSchema = z
  .number()
  .int()
  .min(60)
  .max(86_400)
  .default(1_800)
  .describe('Lease duration in seconds, between 60 and 86,400.');
export const summarySchema = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .describe('Completion summary, at most 4,000 characters.');
export const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .describe('Reason recorded in activity, at most 4,000 characters.');
export const noteSchema = z
  .string()
  .max(500)
  .nullable()
  .default(null)
  .describe('Optional handoff note, at most 500 characters.');
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
export const artifactsSchema = z
  .array(artifactSchema)
  .max(20)
  .default([])
  .describe('Produced artifact references, at most 20.');
const projectTitleSchema = z.string().min(1).max(200).describe('Human-readable Project title.');
const specTitleSchema = z.string().min(1).max(200).describe('Human-readable Spec title.');
const taskTitleSchema = z.string().min(1).max(300).describe('Human-readable Task title.');
const workspaceNameSchema = z.string().min(1).max(120).describe('Human-readable Workspace name.');

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PAGE_LIMIT_MAXIMUM = 200;
export const PAGE_LIMIT_DEFAULT = 50;
export const MARKDOWN_PAGE_LIMIT_MAXIMUM = 100_000;
export const MARKDOWN_PAGE_LIMIT_DEFAULT = 20_000;

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(PAGE_LIMIT_MAXIMUM)
  .default(PAGE_LIMIT_DEFAULT)
  .describe('Maximum items to return; continue with the next offset while hasMore is true.');
export const offsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Zero-based item offset for deterministic pagination.');
export const markdownOffsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Zero-based JavaScript UTF-16 code-unit offset.');
export const markdownLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MARKDOWN_PAGE_LIMIT_MAXIMUM)
  .default(MARKDOWN_PAGE_LIMIT_DEFAULT)
  .describe('Maximum UTF-16 code units to return, capped at 100,000.');

/** Query strings arrive as text; the bound itself is defined once, above. */
const queryNumber = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' ? Number(value) : value), schema);

export const paginationQuerySchema = z.object({
  limit: queryNumber(limitSchema),
  offset: queryNumber(offsetSchema),
});
export const limitQuerySchema = z.object({ limit: queryNumber(limitSchema) });
export const markdownPageQuerySchema = z.object({
  offsetCodeUnits: queryNumber(markdownOffsetSchema),
  limitCodeUnits: queryNumber(markdownLimitSchema),
});

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const registerWorkspaceSchema = z.strictObject({
  id: slugSchema.describe('Stable Workspace ID.'),
  name: workspaceNameSchema,
  rootPath: absolutePathSchema.describe('Absolute root directory of the Workspace.'),
});

export const resolveWorkspaceInputSchema = z.strictObject({
  path: absolutePathSchema.describe('Absolute current working directory to resolve.'),
});

export const directoryInputSchema = z.strictObject({
  directory: absolutePathSchema.describe('Absolute destination directory.'),
});

export const createProjectSchema = z.strictObject({
  workspaceId: slugSchema.describe('ID of an already registered Workspace.'),
  slug: slugSchema.describe('Stable Project slug, unique within the Workspace.'),
  title: projectTitleSchema,
  actor: actorSchema,
});

/** Fields of a Project update; the store rejects a write that changes nothing. */
export const updateProjectFieldsSchema = z.strictObject({
  title: projectTitleSchema
    .nullable()
    .default(null)
    .describe('Replacement title, or null to preserve it.'),
  state: writableProjectStateSchema
    .nullable()
    .default(null)
    .describe('Replacement non-terminal state, or null to preserve it.'),
  expectedRevision: expectedRevisionSchema,
  actor: actorSchema,
});

const atLeastOneOf = (fields: string[]) => ({
  description: `At least one of ${fields.join(', ')} must be provided.`,
  anyOf: fields.map((field) => ({
    required: [field],
    properties: { [field]: { not: { type: 'null' } } },
  })),
});

/** HTTP validates the "nothing to update" rule early; the store enforces it for every adapter. */
export const updateProjectSchema = updateProjectFieldsSchema
  .refine(({ title, state }) => title !== null || state !== null, {
    message: 'Provide a title and/or state to update.',
  })
  .meta(atLeastOneOf(['title', 'state']));

export const createSpecSchema = z.strictObject({
  slug: slugSchema.describe('Stable Spec slug, unique within the Project.'),
  title: specTitleSchema,
  body: markdownSchema.default('').describe('Initial complete Markdown body.'),
  actor: actorSchema,
});

export const updateSpecFieldsSchema = z.strictObject({
  title: specTitleSchema
    .nullable()
    .default(null)
    .describe('Replacement title, or null to preserve it.'),
  body: markdownSchema
    .nullable()
    .default(null)
    .describe('Complete replacement body, or null to preserve it.'),
  state: writableSpecStateSchema
    .nullable()
    .default(null)
    .describe('Replacement draft or ready state, or null to preserve it.'),
  expectedRevision: expectedRevisionSchema,
  actor: actorSchema,
});

export const updateSpecSchema = updateSpecFieldsSchema
  .refine(({ title, body, state }) => title !== null || body !== null || state !== null, {
    message: 'Provide a title, body, and/or state to update.',
  })
  .meta(atLeastOneOf(['title', 'body', 'state']));

export const createTaskSchema = z.strictObject({
  parentId: idSchema
    .nullable()
    .default(null)
    .describe('Parent Task UUID, or null for a top-level Task.'),
  title: taskTitleSchema,
  body: markdownSchema.nullable().default(null).describe('Optional complete Markdown body.'),
  actor: actorSchema,
});

export const updateTaskFieldsSchema = z.strictObject({
  title: taskTitleSchema
    .nullable()
    .default(null)
    .describe('Replacement title, or null to preserve it.'),
  body: markdownSchema
    .nullable()
    .optional()
    .describe('Replacement body; null clears it and omission preserves it.'),
  expectedRevision: expectedRevisionSchema,
  actor: actorSchema,
});

export const updateTaskSchema = updateTaskFieldsSchema
  .refine(({ title, body }) => title !== null || body !== undefined, {
    message: 'Provide a title and/or body to update.',
  })
  .meta({
    description: 'At least one of title or body must be provided; a null body clears it.',
    anyOf: [
      { required: ['title'], properties: { title: { not: { type: 'null' } } } },
      { required: ['body'] },
    ],
  });

export const putContextSchema = z.strictObject({
  body: markdownSchema.describe('Complete replacement Markdown body.'),
  expectedRevision: expectedRevisionSchema
    .nullable()
    .default(null)
    .describe('Current revision, or null when creating.'),
  actor: actorSchema,
});

export const cancelInputSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  reason: reasonSchema,
  actor: actorSchema,
});

export const completeProjectInputSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  summary: summarySchema,
  artifacts: artifactsSchema,
  actor: actorSchema,
});

export const claimInputSchema = z.strictObject({
  agentId: agentIdSchema,
  leaseSeconds: leaseSecondsSchema,
});

export const releaseInputSchema = z.strictObject({
  agentId: agentIdSchema,
  note: noteSchema,
});

export const completeWorkInputSchema = z.strictObject({
  agentId: agentIdSchema,
  expectedRevision: expectedRevisionSchema,
  summary: summarySchema,
  artifacts: artifactsSchema,
});

// ---------------------------------------------------------------------------
// Response bodies
// ---------------------------------------------------------------------------

/**
 * `unavailable` is minted by the CLI and the clients when the daemon does not
 * answer; the daemon itself never returns it, so the HTTP and MCP error
 * envelopes document every other code.
 */
export type DaemonErrorCode = Exclude<ErrorCode, 'unavailable'>;
export const DAEMON_ERROR_CODES = ERROR_CODES.filter(
  (code): code is DaemonErrorCode => code !== 'unavailable',
) as [DaemonErrorCode, ...DaemonErrorCode[]];

export const errorSchema = z.strictObject({
  code: z.enum(DAEMON_ERROR_CODES).describe('Stable error code.'),
  message: z.string().describe('Human-readable message without internal details.'),
  retryable: z.boolean().describe('Whether the same request may succeed when retried.'),
  details: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Structured details such as validation issues or the current revision.'),
});
export const errorEnvelopeSchema = z.strictObject({ error: errorSchema });

export const successEnvelopeSchema = z.strictObject({
  data: z.unknown(),
  meta: z.strictObject({ schemaVersion: z.literal(1) }),
});

export const healthSchema = z.strictObject({
  status: z.enum(['ok', 'degraded']).describe('ok when the database answers, degraded otherwise.'),
  version: z.string().min(1).describe('Daemon version.'),
  ready: z.boolean().describe('True when a SELECT 1 probe against SQLite succeeded.'),
}) satisfies z.ZodType<HealthStatus>;

export const workspaceSchema = z.strictObject({
  id: slugSchema,
  name: workspaceNameSchema,
  rootPath: z
    .string()
    .describe(
      'Absolute root path, or an empty string when the Workspace arrived through synchronization and has no local root yet.',
    ),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}) satisfies z.ZodType<Workspace>;

export const claimSchema = z.strictObject({
  targetType: targetTypeSchema,
  targetId: idSchema,
  agentId: agentIdSchema,
  expiresAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}) satisfies z.ZodType<Claim>;

const completionSummarySchema = z.string().max(4_000).nullable();
const nullableTimestampSchema = timestampSchema.nullable();

export const projectSchema = z.strictObject({
  id: idSchema,
  workspaceId: slugSchema,
  slug: slugSchema,
  title: projectTitleSchema,
  state: projectStateSchema,
  revision: revisionSchema,
  completionSummary: completionSummarySchema,
  artifacts: z.array(artifactSchema),
  completedAt: nullableTimestampSchema,
  cancelledAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}) satisfies z.ZodType<Project>;

export const projectManifestSchema = projectSchema
  .omit({ artifacts: true, completionSummary: true })
  .extend({
    artifactCount: z.number().int().nonnegative(),
    hasCompletion: z.boolean(),
    specCount: z.number().int().nonnegative(),
    draftSpecCount: z.number().int().nonnegative(),
    readySpecCount: z.number().int().nonnegative(),
    terminalSpecCount: z.number().int().nonnegative(),
  })
  .describe(
    'Project metadata with completion body and artifact array omitted.',
  ) satisfies z.ZodType<ProjectManifest>;

export const specSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  slug: slugSchema,
  title: specTitleSchema,
  body: markdownSchema,
  state: specStateSchema,
  revision: revisionSchema,
  completionSummary: completionSummarySchema,
  artifacts: z.array(artifactSchema),
  completedAt: nullableTimestampSchema,
  cancelledAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  claim: claimSchema.nullable(),
}) satisfies z.ZodType<Spec>;

export const specManifestSchema = specSchema
  .omit({ body: true, artifacts: true, completionSummary: true })
  .extend({
    bodySizeBytes: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    hasCompletion: z.boolean(),
    taskCount: z.number().int().nonnegative(),
    openTaskCount: z.number().int().nonnegative(),
    terminalTaskCount: z.number().int().nonnegative(),
  })
  .describe(
    'Spec metadata with Markdown, completion body, and artifact array omitted.',
  ) satisfies z.ZodType<SpecManifest>;

export const taskSchema = z.strictObject({
  id: idSchema,
  specId: idSchema,
  parentId: idSchema.nullable(),
  title: taskTitleSchema,
  body: markdownSchema.nullable(),
  state: taskStateSchema,
  revision: revisionSchema,
  completionSummary: completionSummarySchema,
  artifacts: z.array(artifactSchema),
  completedAt: nullableTimestampSchema,
  cancelledAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  claim: claimSchema.nullable(),
}) satisfies z.ZodType<Task>;

export const taskManifestSchema = taskSchema
  .omit({ body: true, artifacts: true, completionSummary: true })
  .extend({
    bodySizeBytes: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    hasCompletion: z.boolean(),
    subtaskCount: z.number().int().nonnegative(),
    openSubtaskCount: z.number().int().nonnegative(),
  })
  .describe(
    'Task metadata with Markdown, completion body, and artifact array omitted.',
  ) satisfies z.ZodType<TaskManifest>;

export const contextDocumentSchema = z.strictObject({
  id: idSchema,
  ownerType: contextOwnerTypeSchema,
  ownerId: contextOwnerIdSchema,
  name: slugSchema,
  body: markdownSchema,
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}) satisfies z.ZodType<ContextDocument>;

export const contextManifestSchema = contextDocumentSchema
  .omit({ body: true })
  .extend({ sizeBytes: z.number().int().nonnegative() })
  .describe(
    'Context metadata with the Markdown body omitted.',
  ) satisfies z.ZodType<ContextManifest>;

export const workContextManifestPageSchema = z.strictObject({
  items: z.array(contextManifestSchema),
  hasMore: z.boolean(),
}) satisfies z.ZodType<ContextManifestPage>;

export const markdownPageSchema = z.strictObject({
  body: z.string(),
  offsetCodeUnits: z.number().int().nonnegative(),
  totalCodeUnits: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  hasMore: z.boolean(),
}) satisfies z.ZodType<MarkdownPage>;

export const completionDetailsSchema = z.strictObject({
  completionSummary: completionSummarySchema,
  artifacts: z.array(artifactSchema),
  completedAt: nullableTimestampSchema,
}) satisfies z.ZodType<CompletionDetails>;

export const activityEventSchema = z.strictObject({
  id: z.number().int().positive(),
  workspaceId: slugSchema.nullable(),
  projectId: idSchema.nullable(),
  specId: idSchema.nullable(),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  eventType: z.string().min(1),
  actor: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
}) satisfies z.ZodType<ActivityEvent>;

export const workItemSchema = z.strictObject({
  targetType: targetTypeSchema,
  targetId: idSchema,
  workspaceId: slugSchema,
  projectId: idSchema,
  projectTitle: projectTitleSchema,
  specId: idSchema,
  specTitle: specTitleSchema,
  taskId: idSchema.nullable(),
  taskTitle: taskTitleSchema.nullable(),
  parentTaskId: idSchema.nullable(),
  revision: revisionSchema,
}) satisfies z.ZodType<WorkItem>;

export const workBundleSchema = z.strictObject({
  claim: claimSchema,
  workspace: workspaceSchema,
  project: projectManifestSchema,
  spec: specManifestSchema,
  task: taskManifestSchema.nullable(),
  workspaceContext: workContextManifestPageSchema,
  projectContext: workContextManifestPageSchema,
}) satisfies z.ZodType<WorkBundle>;

export const releasedSchema = z.strictObject({ released: z.literal(true) });
export const pathResultSchema = z.strictObject({
  path: absolutePathSchema.describe('Absolute path of the created snapshot or export.'),
});

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
    hasMore: z.boolean(),
  });
