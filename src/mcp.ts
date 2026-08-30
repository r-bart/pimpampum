import {
  type CallToolResult,
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createAgentErrorEnvelope, createAgentSuccessEnvelope } from './agentProtocol.js';
import { AppError } from './errors.js';
import {
  absolutePathSchema,
  artifactSchema,
  idSchema,
  markdownSchema,
  projectStateSchema,
  slugSchema,
  specStateSchema,
  targetTypeSchema,
  writableProjectStateSchema,
  writableSpecStateSchema,
} from './schemas.js';
import type { PimpampumGateway, Spec, Task } from './types.js';
import type { SyncGateway } from './syncContract.js';
import { PIMPAMPUM_VERSION } from './version.js';

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

const actorSchema = z
  .string()
  .min(1)
  .max(200)
  .nullable()
  .default(null)
  .describe('Optional actor identifier recorded in automatic activity.');
const agentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Stable identifier of the agent or session that owns the Claim.');
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
  .describe('Maximum items to return; continue with page.nextOffset while page.hasMore is true.');
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
  .describe('Zero-based JavaScript UTF-16 code-unit offset.');
const markdownLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(100_000)
  .default(20_000)
  .describe('Maximum UTF-16 code units to return, capped at 100,000.');
const ownerTypeSchema = z
  .enum(['workspace', 'project'])
  .describe('Context scope: a Workspace or a Project.');
const nullableText = (maximum: number, description: string) =>
  z.string().min(1).max(maximum).nullable().default(null).describe(description);

function success(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(createAgentSuccessEnvelope(value)) }] };
}

function failure(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(createAgentErrorEnvelope(error)) }],
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

async function completedManifest(gateway: PimpampumGateway, completed: Spec | Task) {
  return 'projectId' in completed
    ? gateway.getSpecManifest(completed.id)
    : gateway.getTaskManifest(completed.id);
}

export function buildMcpServer(gateway: PimpampumGateway, sync?: SyncGateway): McpServer {
  const server = new McpServer({ name: 'pimpampum', version: PIMPAMPUM_VERSION });

  server.registerTool(
    'workspace_list',
    {
      title: 'List workspaces',
      description:
        'List every repository or directory root registered in this local Pimpampum instance. Results contain metadata only and never load Context bodies.',
      annotations: readOnly,
    },
    () => run(() => gateway.listWorkspaces()),
  );

  if (sync) {
    server.registerTool(
      'sync_status',
      {
        title: 'Read synchronization status',
        description:
          'Call during session orientation. Reports shared-folder health and conflicts. Normal domain writes export automatically; never edit snapshot files or change sync settings yourself.',
        annotations: readOnly,
      },
      () => run(() => sync.getStatus()),
    );
    server.registerTool(
      'sync_now',
      {
        title: 'Synchronize now',
        description:
          'Reconcile pending immutable snapshots and publish current state when the user asks for an immediate handoff. Do not call after every write; export is automatic.',
        annotations: update,
      },
      () => run(() => sync.reconcile()),
    );
    server.registerTool(
      'sync_conflict_list',
      {
        title: 'List synchronization conflicts',
        description:
          'List bounded conflict manifests that need user attention without candidate bodies. Do not choose a winner autonomously; continue only unrelated work.',
        annotations: readOnly,
        inputSchema: z.strictObject({ limit: limitSchema, offset: offsetSchema }),
      },
      ({ limit, offset }) =>
        run(async () => {
          return paged(
            async (fetchLimit) =>
              (await sync.listConflicts({ limit: fetchLimit, offset })).map(
                ({ id, entityType, entityId, createdAt }) => ({
                  id,
                  entityType,
                  entityId,
                  createdAt,
                }),
              ),
            limit,
            offset,
          );
        }),
    );
    server.registerTool(
      'sync_conflict_read',
      {
        title: 'Read synchronization conflict',
        description:
          'Read bounded JSON pages from both candidates of one conflict for explanation to the user. This is read-only and never resolves or edits either candidate.',
        annotations: readOnly,
        inputSchema: z.strictObject({
          conflictId: z.string().min(1).max(128).describe('Stable ID from sync_conflict_list.'),
          offsetCodeUnits: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe('UTF-16 offset applied independently to both candidates.'),
          limitCodeUnits: z
            .number()
            .int()
            .min(1)
            .max(16_000)
            .default(4_000)
            .describe('Maximum UTF-16 code units returned for each candidate.'),
        }),
      },
      ({ conflictId, offsetCodeUnits, limitCodeUnits }) =>
        run(async () => {
          const conflict = await sync.getConflict(conflictId);
          if (!conflict)
            throw new AppError('not_found', `Sync conflict ${conflictId} was not found`, 404);
          const page = (candidate: unknown) => {
            const content = JSON.stringify(candidate);
            const value = content.slice(offsetCodeUnits, offsetCodeUnits + limitCodeUnits);
            return {
              content: value,
              offsetCodeUnits,
              returnedCodeUnits: value.length,
              totalCodeUnits: content.length,
              hasMore: offsetCodeUnits + value.length < content.length,
            };
          };
          return {
            id: conflict.id,
            entityType: conflict.entityType,
            entityId: conflict.entityId,
            createdAt: conflict.createdAt,
            local: page(conflict.local),
            remote: page(conflict.remote),
          };
        }),
    );
  }

  server.registerTool(
    'workspace_resolve',
    {
      title: 'Resolve workspace',
      description:
        'Resolve an absolute working directory to the most specific registered Workspace whose root contains it. Use this first when an agent starts inside a repository.',
      annotations: readOnly,
      inputSchema: z
        .object({
          path: absolutePathSchema.describe('Absolute current working directory to resolve.'),
        })
        .strict(),
    },
    ({ path }) => run(() => gateway.resolveWorkspace(path)),
  );

  server.registerTool(
    'project_list',
    {
      title: 'List projects',
      description:
        'List bounded Project manifests, optionally filtered by Workspace and lifecycle state. Projects are initiative containers; executable Markdown belongs to their Specs.',
      annotations: readOnly,
      inputSchema: z
        .object({
          workspaceId: slugSchema
            .nullable()
            .default(null)
            .describe('Workspace ID, or null for all.'),
          state: projectStateSchema
            .nullable()
            .default(null)
            .describe('Project state, or null for all.'),
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
      title: 'Get project',
      description:
        'Read one bounded Project manifest. The response summarizes child Specs but excludes Markdown and completion bodies; use the dedicated Spec and completion tools when needed.',
      annotations: readOnly,
      inputSchema: z
        .object({ projectId: idSchema.describe('UUID of the Project to inspect.') })
        .strict(),
    },
    ({ projectId }) => run(() => gateway.getProjectManifest(projectId)),
  );

  server.registerTool(
    'project_create',
    {
      title: 'Create project',
      description:
        'Create a draft Project container in an existing Workspace. Create one or more Specs separately before moving the Project to open.',
      annotations: create,
      inputSchema: z
        .object({
          workspaceId: slugSchema.describe('ID of an already registered Workspace.'),
          slug: slugSchema.describe('Stable Project slug, unique within the Workspace.'),
          title: z.string().min(1).max(200).describe('Human-readable Project title.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const project = await gateway.createProject(input);
        return gateway.getProjectManifest(project.id);
      }),
  );

  server.registerTool(
    'project_update',
    {
      title: 'Update project',
      description:
        'Update a Project title or move it among draft, open, and paused using optimistic concurrency. Terminal states use explicit completion or cancellation tools.',
      annotations: update,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the Project to update.'),
          title: nullableText(200, 'Replacement title, or null to preserve it.'),
          state: writableProjectStateSchema
            .nullable()
            .default(null)
            .describe('Replacement non-terminal state, or null to preserve it.'),
          expectedRevision: revisionSchema,
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const project = await gateway.updateProject(input);
        return gateway.getProjectManifest(project.id);
      }),
  );

  server.registerTool(
    'project_complete',
    {
      title: 'Complete project',
      description:
        'Mark an open or paused Project done after all child Specs are terminal. Records a summary and artifact references; Projects do not require a Claim.',
      annotations: transition,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the Project to complete.'),
          expectedRevision: revisionSchema,
          summary: z.string().trim().min(1).max(4_000).describe('Completion summary.'),
          artifacts: z
            .array(artifactSchema)
            .max(20)
            .default([])
            .describe('Produced artifact references.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const project = await gateway.completeProject(input);
        return gateway.getProjectManifest(project.id);
      }),
  );

  server.registerTool(
    'project_cancel',
    {
      title: 'Cancel project',
      description:
        'Atomically cancel a Project and every non-terminal descendant Spec, Task, and Subtask, release affected Claims, and preserve an activity trail.',
      annotations: transition,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the Project tree to cancel.'),
          expectedRevision: revisionSchema,
          reason: z.string().trim().min(1).max(4_000).describe('Reason recorded in activity.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const project = await gateway.cancelProject(input);
        return gateway.getProjectManifest(project.id);
      }),
  );

  server.registerTool(
    'project_completion_get',
    {
      title: 'Get project completion',
      description:
        'Read the completion summary, artifact references, and completion time for one Project without loading any child Specs or Context documents.',
      annotations: readOnly,
      inputSchema: z
        .object({ projectId: idSchema.describe('UUID of the Project to inspect.') })
        .strict(),
    },
    ({ projectId }) => run(() => gateway.getProjectCompletion(projectId)),
  );

  server.registerTool(
    'spec_list',
    {
      title: 'List specs',
      description:
        'List bounded Spec manifests within one Project, optionally filtered by lifecycle state. Markdown and completion bodies are omitted from discovery responses.',
      annotations: readOnly,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the owning Project.'),
          state: specStateSchema.nullable().default(null).describe('Spec state, or null for all.'),
          limit: limitSchema,
          offset: offsetSchema,
        })
        .strict(),
    },
    ({ projectId, state, limit, offset }) =>
      run(() =>
        paged(
          (fetchLimit) =>
            gateway.listSpecManifests({ projectId, state, limit: fetchLimit, offset }),
          limit,
          offset,
        ),
      ),
  );

  server.registerTool(
    'spec_get',
    {
      title: 'Get spec',
      description:
        'Read one bounded Spec manifest including Task rollups and current Claim metadata, without loading the potentially large Markdown body or completion summary.',
      annotations: readOnly,
      inputSchema: z.object({ specId: idSchema.describe('UUID of the Spec to inspect.') }).strict(),
    },
    ({ specId }) => run(() => gateway.getSpecManifest(specId)),
  );

  server.registerTool(
    'spec_read',
    {
      title: 'Read spec body',
      description:
        'Read a bounded page of executable Spec Markdown. Pagination uses JavaScript UTF-16 code units; continue from the returned offset while hasMore is true.',
      annotations: readOnly,
      inputSchema: z
        .object({
          specId: idSchema.describe('UUID of the Spec whose Markdown should be read.'),
          offsetCodeUnits: markdownOffsetSchema,
          limitCodeUnits: markdownLimitSchema,
        })
        .strict(),
    },
    ({ specId, offsetCodeUnits, limitCodeUnits }) =>
      run(() => gateway.readSpecBody(specId, offsetCodeUnits, limitCodeUnits)),
  );

  server.registerTool(
    'spec_create',
    {
      title: 'Create spec',
      description:
        'Create a draft Spec with Markdown inside a Project. Its slug is unique within that Project; move it to ready only after the body is executable.',
      annotations: create,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the Project that owns the Spec.'),
          slug: slugSchema.describe('Stable Spec slug, unique within the Project.'),
          title: z.string().min(1).max(200).describe('Human-readable Spec title.'),
          body: markdownSchema.default('').describe('Initial complete Markdown body.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const spec = await gateway.createSpec(input);
        return gateway.getSpecManifest(spec.id);
      }),
  );

  server.registerTool(
    'spec_update',
    {
      title: 'Update spec',
      description:
        'Replace a Spec title, complete Markdown body, or draft/ready state using optimistic concurrency. Active Claims prevent reversible lifecycle changes.',
      annotations: update,
      inputSchema: z
        .object({
          specId: idSchema.describe('UUID of the Spec to update.'),
          title: nullableText(200, 'Replacement title, or null to preserve it.'),
          body: markdownSchema
            .nullable()
            .default(null)
            .describe('Complete replacement body, or null to preserve it.'),
          state: writableSpecStateSchema
            .nullable()
            .default(null)
            .describe('Replacement draft or ready state, or null to preserve it.'),
          expectedRevision: revisionSchema,
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const spec = await gateway.updateSpec(input);
        return gateway.getSpecManifest(spec.id);
      }),
  );

  server.registerTool(
    'spec_completion_get',
    {
      title: 'Get spec completion',
      description:
        'Read the completion summary, artifact references, and completion time for one Spec without loading its Markdown body or child Tasks.',
      annotations: readOnly,
      inputSchema: z.object({ specId: idSchema.describe('UUID of the Spec to inspect.') }).strict(),
    },
    ({ specId }) => run(() => gateway.getSpecCompletion(specId)),
  );

  server.registerTool(
    'spec_cancel',
    {
      title: 'Cancel spec',
      description:
        'Atomically cancel a Spec and every non-terminal descendant Task and Subtask, release affected Claims, and preserve completion and activity history.',
      annotations: transition,
      inputSchema: z
        .object({
          specId: idSchema.describe('UUID of the Spec tree to cancel.'),
          expectedRevision: revisionSchema,
          reason: z.string().trim().min(1).max(4_000).describe('Reason recorded in activity.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const spec = await gateway.cancelSpec(input);
        return gateway.getSpecManifest(spec.id);
      }),
  );

  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description:
        'List bounded Task and one-level Subtask manifests for one Spec. Bodies and completion summaries are omitted; parentId preserves the hierarchy.',
      annotations: readOnly,
      inputSchema: z
        .object({
          specId: idSchema.describe('UUID of the Spec whose Tasks should be listed.'),
          limit: limitSchema,
          offset: offsetSchema,
        })
        .strict(),
    },
    ({ specId, limit, offset }) =>
      run(() =>
        paged(
          (fetchLimit) => gateway.listTaskManifests({ specId, limit: fetchLimit, offset }),
          limit,
          offset,
        ),
      ),
  );

  server.registerTool(
    'task_get',
    {
      title: 'Get task',
      description:
        'Read one bounded Task or Subtask manifest, including hierarchy rollups and current Claim metadata, without loading Markdown or completion details.',
      annotations: readOnly,
      inputSchema: z.object({ taskId: idSchema.describe('UUID of the Task to inspect.') }).strict(),
    },
    ({ taskId }) => run(() => gateway.getTaskManifest(taskId)),
  );

  server.registerTool(
    'task_read',
    {
      title: 'Read task body',
      description:
        'Read a bounded page of a Task Markdown body using JavaScript UTF-16 code-unit offsets; continue from the returned offset while hasMore is true.',
      annotations: readOnly,
      inputSchema: z
        .object({
          taskId: idSchema.describe('UUID of the Task whose body should be read.'),
          offsetCodeUnits: markdownOffsetSchema,
          limitCodeUnits: markdownLimitSchema,
        })
        .strict(),
    },
    ({ taskId, offsetCodeUnits, limitCodeUnits }) =>
      run(() => gateway.readTaskBody(taskId, offsetCodeUnits, limitCodeUnits)),
  );

  server.registerTool(
    'task_create',
    {
      title: 'Create task',
      description:
        'Create a top-level Task or one-level Subtask inside a Spec. A parent must belong to the same Spec and a Subtask cannot have children.',
      annotations: create,
      inputSchema: z
        .object({
          specId: idSchema.describe('UUID of the Spec that owns the Task.'),
          parentId: idSchema
            .nullable()
            .default(null)
            .describe('Parent Task UUID, or null for a top-level Task.'),
          title: z.string().min(1).max(300).describe('Human-readable Task title.'),
          body: markdownSchema
            .nullable()
            .default(null)
            .describe('Optional complete Markdown body.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const task = await gateway.createTask(input);
        return gateway.getTaskManifest(task.id);
      }),
  );

  server.registerTool(
    'task_update',
    {
      title: 'Update task',
      description:
        'Replace an open Task title or complete Markdown body using optimistic concurrency. Terminal Tasks and Tasks within terminal Projects are immutable.',
      annotations: update,
      inputSchema: z
        .object({
          taskId: idSchema.describe('UUID of the Task to update.'),
          title: nullableText(300, 'Replacement title, or null to preserve it.'),
          body: markdownSchema
            .nullable()
            .optional()
            .describe('Replacement body; null clears it and omission preserves it.'),
          expectedRevision: revisionSchema,
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const task = await gateway.updateTask({ ...input, body: input.body });
        return gateway.getTaskManifest(task.id);
      }),
  );

  server.registerTool(
    'task_completion_get',
    {
      title: 'Get task completion',
      description:
        'Read the completion summary, artifact references, and completion time for one Task or Subtask without loading its Markdown body.',
      annotations: readOnly,
      inputSchema: z.object({ taskId: idSchema.describe('UUID of the Task to inspect.') }).strict(),
    },
    ({ taskId }) => run(() => gateway.getTaskCompletion(taskId)),
  );

  server.registerTool(
    'task_cancel',
    {
      title: 'Cancel task',
      description:
        'Atomically cancel a Task and its non-terminal Subtasks, release affected Claims, and record the supplied reason without deleting prior history.',
      annotations: transition,
      inputSchema: z
        .object({
          taskId: idSchema.describe('UUID of the Task tree to cancel.'),
          expectedRevision: revisionSchema,
          reason: z.string().trim().min(1).max(4_000).describe('Reason recorded in activity.'),
          actor: actorSchema,
        })
        .strict(),
    },
    (input) =>
      run(async () => {
        const task = await gateway.cancelTask(input);
        return gateway.getTaskManifest(task.id);
      }),
  );

  server.registerTool(
    'context_list',
    {
      title: 'List context documents',
      description:
        'List bounded Context manifests for one explicit Workspace or Project scope. Bodies are never inherited or loaded during discovery.',
      annotations: readOnly,
      inputSchema: z
        .object({
          ownerType: ownerTypeSchema,
          ownerId: z.string().min(1).describe('Workspace ID or Project UUID matching ownerType.'),
          limit: limitSchema,
          offset: offsetSchema,
        })
        .strict(),
    },
    ({ ownerType, ownerId, limit, offset }) =>
      run(() =>
        paged(
          (fetchLimit) =>
            gateway.listContextManifests({ ownerType, ownerId, limit: fetchLimit, offset }),
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
        'Read a bounded Markdown page from one explicitly scoped Context document. The same name may exist independently at Workspace and Project scopes.',
      annotations: readOnly,
      inputSchema: z
        .object({
          ownerType: ownerTypeSchema,
          ownerId: z.string().min(1).describe('Workspace ID or Project UUID matching ownerType.'),
          name: slugSchema.describe('Stable Context name within the selected scope.'),
          offsetCodeUnits: markdownOffsetSchema,
          limitCodeUnits: markdownLimitSchema,
        })
        .strict(),
    },
    ({ ownerType, ownerId, name, offsetCodeUnits, limitCodeUnits }) =>
      run(async () => ({
        ownerType,
        ownerId,
        name,
        ...(await gateway.readContextPage(
          ownerType,
          ownerId,
          name,
          offsetCodeUnits,
          limitCodeUnits,
        )),
      })),
  );

  server.registerTool(
    'context_put',
    {
      title: 'Create or replace context',
      description:
        'Create or atomically replace a Workspace- or Project-scoped Context Markdown document. Supply its revision when replacing an existing name.',
      annotations: update,
      inputSchema: z
        .object({
          ownerType: ownerTypeSchema,
          ownerId: z.string().min(1).describe('Workspace ID or Project UUID matching ownerType.'),
          name: slugSchema.describe('Stable Context name, unique within the selected scope.'),
          body: markdownSchema.describe('Complete replacement Markdown body.'),
          expectedRevision: revisionSchema
            .nullable()
            .default(null)
            .describe('Current revision, or null when creating.'),
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
        'Read bounded automatic activity for a Project and all descendant Specs, Tasks, Context, lifecycle transitions, and Claims in reverse chronological order.',
      annotations: readOnly,
      inputSchema: z
        .object({
          projectId: idSchema.describe('UUID of the Project whose activity should be listed.'),
          limit: limitSchema.describe('Maximum latest activity events to return.'),
        })
        .strict(),
    },
    ({ projectId, limit }) => run(() => gateway.listActivity(projectId, limit)),
  );

  server.registerTool(
    'work_list',
    {
      title: 'List claimable work',
      description:
        'List ready Specs and open leaf Tasks under open Projects. Optional Workspace, Project, and Spec filters are checked for consistent ancestry.',
      annotations: readOnly,
      inputSchema: z
        .object({
          workspaceId: slugSchema
            .nullable()
            .default(null)
            .describe('Workspace filter, or null for all.'),
          projectId: idSchema.nullable().default(null).describe('Project filter, or null for all.'),
          specId: idSchema.nullable().default(null).describe('Spec filter, or null for all.'),
          limit: limitSchema.describe('Maximum executable work items to return.'),
        })
        .strict(),
    },
    ({ workspaceId, projectId, specId, limit }) =>
      run(async () => {
        const results = await gateway.listWork({
          workspaceId,
          projectId,
          specId,
          limit: limit + 1,
        });
        return { items: results.slice(0, limit), limit, truncated: results.length > limit };
      }),
  );

  server.registerTool(
    'work_start',
    {
      title: 'Claim work',
      description:
        'Atomically claim a ready Spec or open leaf Task and return its bounded Workspace, Project, Spec, optional Task, and scoped Context manifests.',
      annotations: { ...create, idempotentHint: true },
      inputSchema: z
        .object({
          targetType: targetTypeSchema,
          targetId: idSchema.describe('UUID of the Spec or Task to claim.'),
          agentId: agentIdSchema,
          leaseSeconds: z
            .number()
            .int()
            .min(60)
            .max(86_400)
            .default(1_800)
            .describe('Lease duration in seconds.'),
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
        'Extend an unexpired Spec or Task Claim owned by the same agent. A competing owner, expired Claim, or no-longer-eligible ancestor state is rejected.',
      annotations: update,
      inputSchema: z
        .object({
          targetType: targetTypeSchema,
          targetId: idSchema.describe('UUID of the claimed Spec or Task.'),
          agentId: agentIdSchema,
          leaseSeconds: z
            .number()
            .int()
            .min(60)
            .max(86_400)
            .default(1_800)
            .describe('New lease duration in seconds.'),
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
        'Release a Spec or Task Claim owned by the agent without completing the resource, optionally recording a concise handoff note in activity.',
      annotations: transition,
      inputSchema: z
        .object({
          targetType: targetTypeSchema,
          targetId: idSchema.describe('UUID of the claimed Spec or Task.'),
          agentId: agentIdSchema,
          note: z.string().max(500).nullable().default(null).describe('Optional handoff note.'),
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
      title: 'Complete claimed work',
      description:
        'Complete a claimed Spec or Task, record its bounded summary and artifact references, and release the Claim atomically. Open descendants block completion.',
      annotations: transition,
      inputSchema: z
        .object({
          targetType: targetTypeSchema,
          targetId: idSchema.describe('UUID of the claimed Spec or Task to complete.'),
          agentId: agentIdSchema,
          expectedRevision: revisionSchema,
          summary: z.string().trim().min(1).max(4_000).describe('Completion summary.'),
          artifacts: z
            .array(artifactSchema)
            .max(20)
            .default([])
            .describe('Produced artifact references.'),
        })
        .strict(),
    },
    (input) => run(async () => completedManifest(gateway, await gateway.completeWork(input))),
  );

  return server;
}

export function createPimpampumMcpHandler(
  gateway: PimpampumGateway,
  sync?: SyncGateway,
): McpHttpHandler {
  return createMcpHandler(() => buildMcpServer(gateway, sync), {
    legacy: 'stateless',
    responseMode: 'json',
  });
}
