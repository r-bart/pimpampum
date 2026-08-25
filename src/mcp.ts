import {
  type CallToolResult,
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { asAppError } from './errors.js';
import {
  absolutePathSchema,
  artifactSchema,
  idSchema,
  markdownSchema,
  slugSchema,
  targetTypeSchema,
} from './schemas.js';
import type { Project, ProjectManifest, PimpampumGateway, Task, TaskManifest } from './types.js';

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const create = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const update = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const transition = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const agentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Stable identifier of the agent or session that owns the claim.');
const actorSchema = z
  .string()
  .min(1)
  .max(200)
  .nullable()
  .default(null)
  .describe('Optional actor identifier recorded in automatic activity.');
const revisionSchema = z
  .number()
  .int()
  .positive()
  .describe('Current resource revision used for optimistic concurrency control.');
const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(50)
  .describe('Maximum items to return; use page.nextOffset while page.hasMore is true.');
const offsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Zero-based item offset for deterministic pagination.');
const markdownOffsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Zero-based UTF-16 code-unit offset; continue from offset plus returned body length.');
const markdownLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(100_000)
  .default(20_000)
  .describe('Maximum UTF-16 code units to return, capped at 100,000.');

const errorGuidance: Record<string, string> = {
  bad_request: 'Correct the arguments using this tool input schema, then retry.',
  conflict: 'Inspect the current claim or resource state before retrying.',
  invalid_state: 'Inspect the project, task hierarchy, and open work before retrying.',
  not_found: 'Verify the resource ID or resolve the current workspace again.',
  revision_conflict: 'Read the latest manifest, then retry with its current revision.',
  unauthorized: 'Verify the daemon bearer token used by the MCP transport or stdio bridge.',
};

function projectManifest(project: Project): ProjectManifest {
  const { prd, artifacts, completionSummary, ...metadata } = project;
  return {
    ...metadata,
    prdSizeBytes: Buffer.byteLength(prd, 'utf8'),
    artifactCount: artifacts.length,
    hasCompletion: completionSummary !== null,
  };
}

function taskManifest(task: Task): TaskManifest {
  const { body, artifacts, completionSummary, ...metadata } = task;
  return {
    ...metadata,
    bodySizeBytes: Buffer.byteLength(body ?? '', 'utf8'),
    artifactCount: artifacts.length,
    hasCompletion: completionSummary !== null,
  };
}

function success(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ data: value }) }] };
}

function failure(error: unknown): CallToolResult {
  const appError = asAppError(error);
  const payload = {
    error: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
      details: appError.details,
      suggestion:
        errorGuidance[appError.code] ??
        'Inspect the daemon logs and retry only if the underlying failure is transient.',
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

async function run(operation: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

async function paged<T>(
  load: (fetchLimit: number) => T[] | Promise<T[]>,
  limit: number,
  offset: number,
) {
  const results = await load(limit + 1);
  const hasMore = results.length > limit;
  const items = results.slice(0, limit);
  return {
    items,
    page: {
      limit,
      offset,
      returned: items.length,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
  };
}

export function buildMcpServer(gateway: PimpampumGateway): McpServer {
  const server = new McpServer({ name: 'pimpampum', version: '0.1.0' });

  server.registerTool(
    'workspace_list',
    {
      title: 'List workspaces',
      description:
        'List every directory root registered in this local Pimpampum instance. Use workspace_resolve when starting from a repository path.',
      annotations: readOnly,
    },
    () => run(() => gateway.listWorkspaces()),
  );

  server.registerTool(
    'workspace_resolve',
    {
      title: 'Resolve workspace',
      description:
        'Resolve an absolute working directory to the most specific registered workspace whose root contains it.',
      annotations: readOnly,
      inputSchema: z
        .object({
          path: absolutePathSchema.describe(
            'Absolute current working directory or repository path to resolve.',
          ),
        })
        .strict(),
    },
    ({ path }) => run(() => gateway.resolveWorkspace(path)),
  );

  server.registerTool(
    'work_list',
    {
      title: 'List claimable work',
      description:
        'List claimable ready projects and open leaf tasks, optionally scoped to one workspace. Results are ordered deterministically and report whether the bounded list was truncated.',
      annotations: readOnly,
      inputSchema: z
        .object({
          workspaceId: slugSchema
            .nullable()
            .default(null)
            .describe('Workspace filter, or null to search all registered workspaces.'),
          limit: limitSchema.describe('Maximum claimable work items to return.'),
        })
        .strict(),
    },
    ({ workspaceId, limit }) =>
      run(async () => {
        const results = await gateway.listWork({ workspaceId, limit: limit + 1 });
        return { items: results.slice(0, limit), limit, truncated: results.length > limit };
      }),
  );

  server.registerTool(
    'work_start',
    {
      title: 'Claim work',
      description:
        'Atomically claim a ready project or open leaf task. Returns the lease plus bounded project, task, workspace, and context manifests needed to begin work. Repeating it for the same agent is idempotent.',
      annotations: { ...create, idempotentHint: true },
      inputSchema: z
        .object({
          targetType: targetTypeSchema,
          targetId: idSchema.describe('UUID of the project or task to claim.'),
          agentId: agentIdSchema,
          leaseSeconds: z
            .number()
            .int()
            .min(60)
            .max(86_400)
            .default(1_800)
            .describe('Lease duration in seconds, from 60 to 86,400; renew before expiresAt.'),
        })
        .strict(),
    },
    (input) => run(() => gateway.startWork(input)),
  );

  server.registerTool(
    'work_renew',
    {
      title: 'Renew claim',
      description:
        'Extend an unexpired claim owned by the same agent. A different or expired owner is rejected.',
      annotations: update,
      inputSchema: z
        .object({
          targetType: targetTypeSchema,
          targetId: idSchema.describe('UUID of the claimed project or task.'),
          agentId: agentIdSchema,
          leaseSeconds: z
            .number()
            .int()
            .min(60)
            .max(86_400)
            .default(1_800)
            .describe('New lease duration in seconds, measured from renewal time.'),
        })
        .strict(),
    },
    (input) => run(() => gateway.renewWork(input)),
  );

  server.registerTool(
    'work_release',
    {
      title: 'Release claim',
      description:
        'Release a claim owned by the agent without completing the resource, optionally recording a concise handoff note.',
      annotations: transition,
      inputSchema: z
        .object({
          targetType: targetTypeSchema,
          targetId: idSchema.describe('UUID of the claimed project or task.'),
          agentId: agentIdSchema,
          note: z
            .string()
            .max(500)
            .nullable()
            .default(null)
            .describe('Optional handoff note, at most 500 characters.'),
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        await gateway.releaseWork(input);
        return { released: true };
      }),
  );

  server.registerTool(
    'work_complete',
    {
      title: 'Complete work',
      description:
        'Complete work claimed by this agent, persist a bounded summary and artifact references, and release its claim. Projects with open tasks and tasks with open subtasks cannot complete.',
      annotations: transition,
      inputSchema: z
        .object({
          targetType: targetTypeSchema,
          targetId: idSchema.describe('UUID of the claimed project or task to complete.'),
          agentId: agentIdSchema,
          expectedRevision: revisionSchema,
          summary: z
            .string()
            .min(1)
            .max(4_000)
            .describe('Concise completion summary, at most 4,000 characters.'),
          artifacts: z
            .array(artifactSchema)
            .max(20)
            .default([])
            .describe('Up to 20 durable artifact references produced by the work.'),
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const completed = await gateway.completeWork(input);
        return 'prd' in completed ? projectManifest(completed) : taskManifest(completed);
      }),
  );

  server.registerTool(
    'project_list',
    {
      title: 'List projects',
      description:
        'List lightweight project manifests across lifecycle states. Markdown and completion bodies are omitted; follow page.nextOffset while page.hasMore is true.',
      annotations: readOnly,
      inputSchema: z
        .object({
          workspaceId: slugSchema
            .nullable()
            .default(null)
            .describe('Workspace filter, or null for all workspaces.'),
          state: z
            .enum(['draft', 'ready', 'done'])
            .nullable()
            .default(null)
            .describe('Lifecycle-state filter, or null for every state.'),
          limit: limitSchema,
          offset: offsetSchema,
        })
        .strict(),
    },
    ({ workspaceId, state, limit, offset }) =>
      run(() =>
        paged(
          (fetchLimit) =>
            gateway.listProjectManifests({ workspaceId, state, limit: fetchLimit, offset }),
          limit,
          offset,
        ),
      ),
  );

  server.registerTool(
    'project_get',
    {
      title: 'Get project overview',
      description:
        'Read one lightweight project manifest together with independently paginated task and context manifests. Use dedicated read tools for Markdown bodies and completion details.',
      annotations: readOnly,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project to inspect.'),
          taskLimit: limitSchema.describe('Maximum task manifests to return.'),
          taskOffset: offsetSchema.describe('Zero-based task offset.'),
          contextLimit: limitSchema.describe('Maximum context manifests to return.'),
          contextOffset: offsetSchema.describe('Zero-based context-document offset.'),
        })
        .strict(),
    },
    ({ projectId, taskLimit, taskOffset, contextLimit, contextOffset }) =>
      run(async () => {
        const [project, tasks, context] = await Promise.all([
          gateway.getProjectManifest(projectId),
          paged(
            (fetchLimit) =>
              gateway.listTaskManifests({ projectId, limit: fetchLimit, offset: taskOffset }),
            taskLimit,
            taskOffset,
          ),
          paged(
            (fetchLimit) =>
              gateway.listContextManifests({
                projectId,
                limit: fetchLimit,
                offset: contextOffset,
              }),
            contextLimit,
            contextOffset,
          ),
        ]);
        return { project, tasks, context };
      }),
  );

  server.registerTool(
    'project_read_prd',
    {
      title: 'Read project PRD',
      description:
        'Read a bounded page of the project PRD. Pagination uses JavaScript UTF-16 code units; continue while hasMore is true.',
      annotations: readOnly,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project whose PRD should be read.'),
          offsetCodeUnits: markdownOffsetSchema,
          limitCodeUnits: markdownLimitSchema,
        })
        .strict(),
    },
    ({ projectId, offsetCodeUnits, limitCodeUnits }) =>
      run(() => gateway.readProjectPrd(projectId, offsetCodeUnits, limitCodeUnits)),
  );

  server.registerTool(
    'project_completion_get',
    {
      title: 'Get project completion',
      description:
        'Read the completion summary, artifact references, and completion time for one project.',
      annotations: readOnly,
      inputSchema: z
        .object({ projectId: idSchema.describe('UUID of the completed or active project.') })
        .strict(),
    },
    ({ projectId }) => run(() => gateway.getProjectCompletion(projectId)),
  );

  server.registerTool(
    'project_create',
    {
      title: 'Create project',
      description:
        'Create a project and its Markdown PRD inside an existing workspace. Slugs are unique within the workspace.',
      annotations: create,
      inputSchema: z
        .object({
          workspaceId: slugSchema.describe('ID of an already registered workspace.'),
          slug: slugSchema.describe('Stable project slug, unique within the workspace.'),
          title: z.string().min(1).max(200).describe('Human-readable project title.'),
          prd: markdownSchema.default('').describe('Initial Markdown PRD; may be empty.'),
          state: z
            .enum(['draft', 'ready'])
            .default('draft')
            .describe('Initial state; done is reached only through work_complete.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) => run(async () => projectManifest(await gateway.createProject(input))),
  );

  server.registerTool(
    'project_update',
    {
      title: 'Update project metadata',
      description:
        'Update a project title and/or move it between draft and ready using optimistic revision control. Does not change the PRD body.',
      annotations: update,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project to update.'),
          title: z
            .string()
            .min(1)
            .max(200)
            .nullable()
            .default(null)
            .describe('Replacement title, or null to preserve it.'),
          state: z
            .enum(['draft', 'ready'])
            .nullable()
            .default(null)
            .describe('Replacement writable state, or null to preserve it.'),
          expectedRevision: revisionSchema,
          actor: actorSchema,
        })
        .strict(),
    },
    (input) => run(async () => projectManifest(await gateway.updateProject(input))),
  );

  server.registerTool(
    'project_update_prd',
    {
      title: 'Replace project PRD',
      description:
        'Replace the complete Markdown PRD using optimistic revision control. Read the latest manifest before writing.',
      annotations: update,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project whose PRD will be replaced.'),
          prd: markdownSchema.describe('Complete replacement Markdown PRD.'),
          expectedRevision: revisionSchema,
          actor: actorSchema,
        })
        .strict(),
    },
    (input) => run(async () => projectManifest(await gateway.updatePrd(input))),
  );

  server.registerTool(
    'task_get',
    {
      title: 'Get task manifest',
      description:
        'Read one lightweight task or subtask manifest without loading its Markdown body or completion details.',
      annotations: readOnly,
      inputSchema: z
        .object({ taskId: idSchema.describe('UUID of the task or subtask to inspect.') })
        .strict(),
    },
    ({ taskId }) => run(() => gateway.getTaskManifest(taskId)),
  );

  server.registerTool(
    'task_read',
    {
      title: 'Read task body',
      description:
        'Read a bounded page of a task Markdown body using UTF-16 code-unit offsets; continue while hasMore is true.',
      annotations: readOnly,
      inputSchema: z
        .object({
          taskId: idSchema.describe('UUID of the task or subtask whose body should be read.'),
          offsetCodeUnits: markdownOffsetSchema,
          limitCodeUnits: markdownLimitSchema,
        })
        .strict(),
    },
    ({ taskId, offsetCodeUnits, limitCodeUnits }) =>
      run(() => gateway.readTaskBody(taskId, offsetCodeUnits, limitCodeUnits)),
  );

  server.registerTool(
    'task_completion_get',
    {
      title: 'Get task completion',
      description:
        'Read the completion summary, artifact references, and completion time for one task or subtask.',
      annotations: readOnly,
      inputSchema: z
        .object({ taskId: idSchema.describe('UUID of the completed or active task.') })
        .strict(),
    },
    ({ taskId }) => run(() => gateway.getTaskCompletion(taskId)),
  );

  server.registerTool(
    'task_list',
    {
      title: 'List project tasks',
      description:
        'List lightweight task and subtask manifests for one project. Follow page.nextOffset while page.hasMore is true.',
      annotations: readOnly,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project whose tasks should be listed.'),
          limit: limitSchema,
          offset: offsetSchema,
        })
        .strict(),
    },
    ({ projectId, limit, offset }) =>
      run(() =>
        paged(
          (fetchLimit) => gateway.listTaskManifests({ projectId, limit: fetchLimit, offset }),
          limit,
          offset,
        ),
      ),
  );

  server.registerTool(
    'task_create',
    {
      title: 'Create task',
      description:
        'Create a top-level task or one-level subtask inside a project. Subtasks cannot have children.',
      annotations: create,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project that owns the task.'),
          parentId: idSchema
            .nullable()
            .default(null)
            .describe('Parent task UUID for a subtask, or null for a top-level task.'),
          title: z.string().min(1).max(300).describe('Human-readable task title.'),
          body: markdownSchema
            .nullable()
            .default(null)
            .describe('Optional Markdown requirements or implementation context.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) => run(async () => taskManifest(await gateway.createTask(input))),
  );

  server.registerTool(
    'task_update',
    {
      title: 'Update task',
      description:
        'Update an open task title and/or complete Markdown body using optimistic revision control.',
      annotations: update,
      inputSchema: z
        .object({
          taskId: idSchema.describe('UUID of the open task or subtask to update.'),
          title: z
            .string()
            .min(1)
            .max(300)
            .nullable()
            .default(null)
            .describe('Replacement title, or null to preserve it.'),
          body: markdownSchema
            .nullable()
            .optional()
            .describe('Complete replacement body; null clears it and omission preserves it.'),
          expectedRevision: revisionSchema,
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => taskManifest(await gateway.updateTask({ ...input, body: input.body }))),
  );

  server.registerTool(
    'context_list',
    {
      title: 'List project context',
      description:
        'List contextual Markdown document manifests without loading their bodies. Follow page.nextOffset while page.hasMore is true.',
      annotations: readOnly,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project whose context should be listed.'),
          limit: limitSchema,
          offset: offsetSchema,
        })
        .strict(),
    },
    ({ projectId, limit, offset }) =>
      run(() =>
        paged(
          (fetchLimit) => gateway.listContextManifests({ projectId, limit: fetchLimit, offset }),
          limit,
          offset,
        ),
      ),
  );

  server.registerTool(
    'context_read',
    {
      title: 'Read context document',
      description:
        'Read a bounded page of one contextual Markdown document using UTF-16 code-unit offsets; continue while hasMore is true.',
      annotations: readOnly,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project that owns the context document.'),
          name: slugSchema.describe('Stable context document name.'),
          offsetCodeUnits: markdownOffsetSchema,
          limitCodeUnits: markdownLimitSchema,
        })
        .strict(),
    },
    ({ projectId, name, offsetCodeUnits, limitCodeUnits }) =>
      run(async () => ({
        projectId,
        name,
        ...(await gateway.readContextPage(projectId, name, offsetCodeUnits, limitCodeUnits)),
      })),
  );

  server.registerTool(
    'context_put',
    {
      title: 'Create or replace context',
      description:
        'Create a contextual Markdown document, or replace it using its current revision. Pass null only when creating a new name.',
      annotations: update,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project that owns the context document.'),
          name: slugSchema.describe('Stable context document name.'),
          body: markdownSchema.describe('Complete replacement Markdown body.'),
          expectedRevision: revisionSchema
            .nullable()
            .default(null)
            .describe('Current revision when replacing, or null when creating a new document.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const document = await gateway.putContext(input);
        const { body, ...metadata } = document;
        return { ...metadata, sizeBytes: Buffer.byteLength(body, 'utf8') };
      }),
  );

  server.registerTool(
    'activity_list',
    {
      title: 'List project activity',
      description:
        'Read the latest automatic project activity events in reverse chronological order. Event data is bounded and completion summaries are previews.',
      annotations: readOnly,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the project whose activity should be listed.'),
          limit: limitSchema.describe('Maximum latest activity events to return.'),
        })
        .strict(),
    },
    ({ projectId, limit }) => run(() => gateway.listActivity(projectId, limit)),
  );

  return server;
}

export function createPimpampumMcpHandler(gateway: PimpampumGateway): McpHttpHandler {
  return createMcpHandler(() => buildMcpServer(gateway), {
    legacy: 'stateless',
    responseMode: 'json',
  });
}
