import { z } from 'zod';
import { automaticBackupStatusSchema } from './backupContract.js';
import {
  overviewActiveWorkSchema,
  overviewCountsSchema,
  overviewDaemonSchema,
  overviewEnvelopeSchema,
  overviewProjectSchema,
  overviewSchema,
  overviewSpecSchema,
  overviewWorkspaceSchema,
} from './overviewContract.js';
import * as s from './schemas.js';
import {
  resolveSyncConflictInputSchema,
  syncConfigurationInputSchema,
  syncConflictIdSchema,
  syncConflictManifestPageSchema,
  syncConflictManifestSchema,
  syncStatusSchema,
} from './syncSchemas.js';
import { PIMPAMPUM_VERSION } from './version.js';

type JsonSchema = Record<string, unknown>;
type Operation = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  jsonSchemaDialect: string;
  servers: Array<Record<string, unknown>>;
  security: Array<Record<string, never[]>>;
  tags: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    responses: Record<string, unknown>;
    schemas: Record<string, JsonSchema>;
  };
}

// ---------------------------------------------------------------------------
// Components: generated from the Zod catalogue
// ---------------------------------------------------------------------------

/**
 * Shared primitives are registered in both registries so every reference to
 * them becomes a `$ref`, whichever side of the wire the containing schema is on.
 */
const primitiveSchemas = {
  Id: s.idSchema,
  Slug: s.slugSchema,
  AbsolutePath: s.absolutePathSchema,
  Timestamp: s.timestampSchema,
  Markdown: s.markdownSchema,
  ProjectState: s.projectStateSchema,
  WritableProjectState: s.writableProjectStateSchema,
  SpecState: s.specStateSchema,
  WritableSpecState: s.writableSpecStateSchema,
  TaskState: s.taskStateSchema,
  TargetType: s.targetTypeSchema,
  ContextOwnerType: s.contextOwnerTypeSchema,
};

/** Request bodies: defaults make a property optional, so they render with `io: 'input'`. */
const inputSchemas = {
  ArtifactReferenceInput: s.artifactSchema,
  RegisterWorkspaceInput: s.registerWorkspaceSchema,
  ResolveWorkspaceInput: s.resolveWorkspaceInputSchema,
  CreateProjectInput: s.createProjectSchema,
  UpdateProjectInput: s.updateProjectSchema,
  CompleteProjectInput: s.completeProjectInputSchema,
  CancelInput: s.cancelInputSchema,
  CreateSpecInput: s.createSpecSchema,
  UpdateSpecInput: s.updateSpecSchema,
  CreateTaskInput: s.createTaskSchema,
  UpdateTaskInput: s.updateTaskSchema,
  PutContextInput: s.putContextSchema,
  ClaimInput: s.claimInputSchema,
  ReleaseInput: s.releaseInputSchema,
  CompleteWorkInput: s.completeWorkInputSchema,
  DirectoryInput: s.directoryInputSchema,
  SyncConfigurationInput: syncConfigurationInputSchema,
  ResolveSyncConflictInput: resolveSyncConflictInputSchema,
};

/** Response bodies: the daemon always fills defaults, so every property is required. */
const outputSchemas = {
  SuccessEnvelope: s.successEnvelopeSchema,
  OverviewSuccessEnvelope: overviewEnvelopeSchema,
  // `Error.code` omits `unavailable`; see `DAEMON_ERROR_CODES` in schemas.ts.
  Error: s.errorSchema,
  ErrorEnvelope: s.errorEnvelopeSchema,
  Health: s.healthSchema,
  ArtifactReference: s.artifactSchema,
  Workspace: s.workspaceSchema,
  Project: s.projectSchema,
  ProjectManifest: s.projectManifestSchema,
  Claim: s.claimSchema,
  Spec: s.specSchema,
  SpecManifest: s.specManifestSchema,
  Task: s.taskSchema,
  TaskManifest: s.taskManifestSchema,
  ContextDocument: s.contextDocumentSchema,
  ContextManifest: s.contextManifestSchema,
  MarkdownPage: s.markdownPageSchema,
  CompletionDetails: s.completionDetailsSchema,
  ProjectManifestPage: s.pageSchema(s.projectManifestSchema),
  SpecManifestPage: s.pageSchema(s.specManifestSchema),
  TaskManifestPage: s.pageSchema(s.taskManifestSchema),
  ContextManifestPage: s.pageSchema(s.contextManifestSchema),
  WorkContextManifestPage: s.workContextManifestPageSchema,
  WorkItem: s.workItemSchema,
  WorkBundle: s.workBundleSchema,
  ActivityEvent: s.activityEventSchema,
  Released: s.releasedSchema,
  PathResult: s.pathResultSchema,
  SyncStatus: syncStatusSchema,
  SyncConflictManifest: syncConflictManifestSchema,
  SyncConflictManifestPage: syncConflictManifestPageSchema,
  AutomaticBackupStatus: automaticBackupStatusSchema,
  OverviewDaemon: overviewDaemonSchema,
  OverviewCounts: overviewCountsSchema,
  OverviewWorkspace: overviewWorkspaceSchema,
  OverviewProject: overviewProjectSchema,
  OverviewActiveWork: overviewActiveWorkSchema,
  OverviewSpec: overviewSpecSchema,
  Overview: overviewSchema,
};

const componentUri = (id: string): string => `#/components/schemas/${id}`;

function generateComponents(
  schemas: Record<string, z.ZodType>,
  io: 'input' | 'output',
): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries({ ...primitiveSchemas, ...schemas })) {
    registry.add(schema, { id: name });
  }
  const generated = z.toJSONSchema(registry, { uri: componentUri, io }).schemas;
  const components: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(generated)) {
    // Each entry is a standalone document; inside `components.schemas` the
    // dialect is declared once and the location is the key.
    const { $schema: _dialect, $id: _id, ...component } = schema as JsonSchema;
    components[name] = component;
  }
  return components;
}

export function generateComponentSchemas(): Record<string, JsonSchema> {
  return {
    ...generateComponents(inputSchemas, 'input'),
    ...generateComponents(outputSchemas, 'output'),
  };
}

/** Standalone JSON Schema for one parameter, derived from the same Zod bound the route parses. */
function parameterSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as JsonSchema;
  return rest;
}

// ---------------------------------------------------------------------------
// Paths: hand-written; test/openapi.test.ts walks the Express router against them
// ---------------------------------------------------------------------------

const ref = (name: string): JsonSchema => ({ $ref: componentUri(name) });
const arrayOf = (schema: JsonSchema): JsonSchema => ({ type: 'array', items: schema });
const body = (schema: JsonSchema) => ({
  required: true,
  content: { 'application/json': { schema } },
});
const response = (schema: JsonSchema, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const responses = (schema: JsonSchema, status: '200' | '201' = '200') => ({
  [status]: response(
    { allOf: [ref('SuccessEnvelope'), { properties: { data: schema } }] },
    status === '201' ? 'Created' : 'Success',
  ),
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '404': { $ref: '#/components/responses/NotFound' },
  '409': { $ref: '#/components/responses/Conflict' },
  '413': { $ref: '#/components/responses/PayloadTooLarge' },
  '500': { $ref: '#/components/responses/InternalError' },
});
const operation = (
  operationId: string,
  summary: string,
  tag: string,
  schema: JsonSchema,
  options: {
    description?: string;
    parameters?: unknown[];
    requestBody?: unknown;
    status?: '200' | '201';
    security?: unknown[];
  } = {},
): Operation => ({
  operationId,
  summary,
  ...(options.description ? { description: options.description } : {}),
  tags: [tag],
  ...(options.security ? { security: options.security } : {}),
  ...(options.parameters ? { parameters: options.parameters } : {}),
  ...(options.requestBody ? { requestBody: options.requestBody } : {}),
  responses: responses(schema, options.status),
});

const uuidPath = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: ref('Id'),
});
const projectId = uuidPath('projectId', 'Project UUID.');
const specId = uuidPath('specId', 'Spec UUID.');
const taskId = uuidPath('taskId', 'Task or Subtask UUID.');
const workspaceId = {
  name: 'workspaceId',
  in: 'path',
  required: true,
  description: 'Workspace ID.',
  schema: ref('Slug'),
};
const contextName = {
  name: 'name',
  in: 'path',
  required: true,
  description: 'Context document name, unique within its explicit scope.',
  schema: ref('Slug'),
};
const targetType = {
  name: 'targetType',
  in: 'path',
  required: true,
  description: 'Claimable executable resource kind.',
  schema: ref('TargetType'),
};
const targetId = uuidPath('targetId', 'Claimed Spec or Task UUID.');
const limitParameter = {
  name: 'limit',
  in: 'query',
  description: 'Maximum items to return.',
  schema: parameterSchema(s.limitSchema),
};
const pagination = [
  limitParameter,
  {
    name: 'offset',
    in: 'query',
    description: 'Zero-based deterministic item offset.',
    schema: parameterSchema(s.offsetSchema),
  },
];
const markdownPageParameters = [
  {
    name: 'offsetCodeUnits',
    in: 'query',
    description: 'Zero-based JavaScript UTF-16 code-unit offset.',
    schema: parameterSchema(s.markdownOffsetSchema),
  },
  {
    name: 'limitCodeUnits',
    in: 'query',
    description: 'Maximum UTF-16 code units to return.',
    schema: parameterSchema(s.markdownLimitSchema),
  },
];

const contextPaths = (scope: 'workspaces' | 'projects', parameter: unknown) => ({
  [`/api/v1/${scope}/{${scope === 'workspaces' ? 'workspaceId' : 'projectId'}}/context`]: {
    parameters: [parameter],
    get: operation(
      scope === 'workspaces' ? 'listWorkspaceContext' : 'listProjectContext',
      `List ${scope === 'workspaces' ? 'Workspace' : 'Project'} Context manifests`,
      'Context',
      ref('ContextManifestPage'),
      { parameters: pagination },
    ),
  },
  [`/api/v1/${scope}/{${scope === 'workspaces' ? 'workspaceId' : 'projectId'}}/context/{name}`]: {
    parameters: [parameter, contextName],
    get: operation(
      scope === 'workspaces' ? 'getWorkspaceContext' : 'getProjectContext',
      `Inspect bounded ${scope === 'workspaces' ? 'Workspace' : 'Project'} Context manifest`,
      'Context',
      ref('ContextManifest'),
    ),
    put: operation(
      scope === 'workspaces' ? 'putWorkspaceContext' : 'putProjectContext',
      `Create or replace ${scope === 'workspaces' ? 'Workspace' : 'Project'} Context`,
      'Context',
      ref('ContextDocument'),
      { requestBody: body(ref('PutContextInput')) },
    ),
  },
  [`/api/v1/${scope}/{${scope === 'workspaces' ? 'workspaceId' : 'projectId'}}/context/{name}/body`]:
    {
      parameters: [parameter, contextName],
      get: operation(
        scope === 'workspaces' ? 'readWorkspaceContextBody' : 'readProjectContextBody',
        `Read bounded ${scope === 'workspaces' ? 'Workspace' : 'Project'} Context Markdown`,
        'Context',
        ref('MarkdownPage'),
        { parameters: markdownPageParameters },
      ),
    },
});

export const openApiDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Pimpampum Local API',
    version: PIMPAMPUM_VERSION,
    summary: 'Minimal local portfolio coordination for humans and software agents.',
    description:
      'One machine-local daemon owns Workspaces, Project initiatives, executable Markdown Specs, Tasks, one-level Subtasks, scoped Context, expiring Claims, backup, and export. Writes use optimistic revisions. Project is never an alias for a PRD; a PRD is one possible kind of Spec.',
    license: { name: 'MIT' },
  },
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  servers: [{ url: 'http://127.0.0.1:7337', description: 'Default local daemon' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'System', description: 'Health and bounded overview schema v2.' },
    { name: 'Workspaces', description: 'Registered repository and directory roots.' },
    { name: 'Projects', description: 'Bounded initiatives that contain Specs.' },
    { name: 'Specs', description: 'Executable Markdown specifications inside Projects.' },
    { name: 'Context', description: 'Explicitly Workspace- or Project-scoped Markdown documents.' },
    { name: 'Tasks', description: 'Tasks and one level of Subtasks owned by Specs.' },
    { name: 'Work', description: 'Discover, claim, lease, release, and complete Specs or Tasks.' },
    { name: 'Activity', description: 'Bounded automatic audit events grouped by Project.' },
    { name: 'Administration', description: 'Automatic backup, explicit snapshots, and export.' },
    { name: 'MCP', description: 'MCP Streamable HTTP transport and discoverable tools.' },
  ],
  paths: {
    '/health': {
      get: {
        ...operation('getHealth', 'Check daemon health and readiness', 'System', ref('Health'), {
          security: [],
        }),
        responses: {
          '200': response(ref('Health'), 'Daemon is running and its database answers'),
          '503': response(ref('Health'), 'Daemon is running but its database does not answer'),
        },
      },
    },
    '/openapi.json': {
      get: {
        ...operation(
          'getOpenApi',
          'Read the OpenAPI contract',
          'System',
          { type: 'object' },
          {
            security: [],
          },
        ),
        responses: { '200': response({ type: 'object' }, 'OpenAPI 3.1 document') },
      },
    },
    '/api/v1/overview': {
      get: {
        ...operation('getOverview', 'Read bounded portfolio status', 'System', ref('Overview')),
        responses: {
          ...responses(ref('Overview')),
          '200': response(
            {
              allOf: [ref('OverviewSuccessEnvelope'), { properties: { data: ref('Overview') } }],
            },
            'Success',
          ),
        },
      },
    },
    '/api/v1/settings/backup': {
      get: operation(
        'getAutomaticBackupStatus',
        'Read automatic backup status',
        'Administration',
        ref('AutomaticBackupStatus'),
      ),
      put: operation(
        'configureAutomaticBackup',
        'Choose the automatic backup directory',
        'Administration',
        ref('AutomaticBackupStatus'),
        { requestBody: body(ref('DirectoryInput')) },
      ),
      delete: operation(
        'disableAutomaticBackup',
        'Disable automatic backup',
        'Administration',
        ref('AutomaticBackupStatus'),
      ),
    },
    '/api/v1/settings/backup/retry': {
      post: operation(
        'retryAutomaticBackup',
        'Retry automatic backup',
        'Administration',
        ref('AutomaticBackupStatus'),
      ),
    },
    '/api/v1/settings/sync': {
      get: operation(
        'getSyncStatus',
        'Read shared-folder synchronization status',
        'Administration',
        ref('SyncStatus'),
      ),
      put: operation(
        'configureSync',
        'Choose a shared folder and enable automatic synchronization',
        'Administration',
        ref('SyncStatus'),
        { requestBody: body(ref('SyncConfigurationInput')) },
      ),
      delete: operation(
        'forgetSync',
        'Forget shared-folder synchronization settings',
        'Administration',
        ref('SyncStatus'),
      ),
    },
    '/api/v1/settings/sync/reconcile': {
      post: operation(
        'reconcileSync',
        'Import pending snapshots and publish current state',
        'Administration',
        ref('SyncStatus'),
      ),
    },
    '/api/v1/settings/sync/pause': {
      post: operation(
        'pauseSync',
        'Pause automatic synchronization',
        'Administration',
        ref('SyncStatus'),
      ),
    },
    '/api/v1/settings/sync/resume': {
      post: operation(
        'resumeSync',
        'Resume automatic synchronization',
        'Administration',
        ref('SyncStatus'),
      ),
    },
    '/api/v1/settings/sync/conflicts': {
      get: operation(
        'listSyncConflicts',
        'List synchronization conflicts requiring user attention',
        'Administration',
        ref('SyncConflictManifestPage'),
        { parameters: pagination },
      ),
    },
    '/api/v1/settings/sync/conflicts/{conflictId}/resolve': {
      post: operation(
        'resolveSyncConflict',
        'Resolve a synchronization conflict using one preserved candidate',
        'Administration',
        ref('SyncStatus'),
        {
          parameters: [
            {
              name: 'conflictId',
              in: 'path',
              required: true,
              description: 'Synchronization conflict identifier.',
              schema: parameterSchema(syncConflictIdSchema),
            },
          ],
          requestBody: body(ref('ResolveSyncConflictInput')),
        },
      ),
    },
    '/api/v1/workspaces': {
      get: operation(
        'listWorkspaces',
        'List registered Workspaces',
        'Workspaces',
        arrayOf(ref('Workspace')),
      ),
      post: operation(
        'registerWorkspace',
        'Register a Workspace root',
        'Workspaces',
        ref('Workspace'),
        {
          requestBody: body(ref('RegisterWorkspaceInput')),
          status: '201',
        },
      ),
    },
    '/api/v1/workspaces/resolve': {
      post: operation(
        'resolveWorkspace',
        'Resolve a path to its Workspace',
        'Workspaces',
        ref('Workspace'),
        {
          requestBody: body(ref('ResolveWorkspaceInput')),
        },
      ),
    },
    ...contextPaths('workspaces', workspaceId),
    '/api/v1/projects': {
      get: operation(
        'listProjects',
        'List bounded Project manifests',
        'Projects',
        ref('ProjectManifestPage'),
        {
          parameters: [
            {
              name: 'workspaceId',
              in: 'query',
              description: 'Optional Workspace ID filter.',
              schema: ref('Slug'),
            },
            {
              name: 'state',
              in: 'query',
              description: 'Optional Project lifecycle filter.',
              schema: ref('ProjectState'),
            },
            ...pagination,
          ],
        },
      ),
      post: operation('createProject', 'Create a draft Project', 'Projects', ref('Project'), {
        requestBody: body(ref('CreateProjectInput')),
        status: '201',
      }),
    },
    '/api/v1/projects/{projectId}': {
      parameters: [projectId],
      patch: operation(
        'updateProject',
        'Update Project metadata or lifecycle',
        'Projects',
        ref('Project'),
        {
          requestBody: body(ref('UpdateProjectInput')),
        },
      ),
    },
    '/api/v1/projects/{projectId}/manifest': {
      parameters: [projectId],
      get: operation(
        'getProjectManifest',
        'Read a bounded Project manifest',
        'Projects',
        ref('ProjectManifest'),
      ),
    },
    '/api/v1/projects/{projectId}/completion': {
      parameters: [projectId],
      get: operation(
        'getProjectCompletion',
        'Read Project completion details',
        'Projects',
        ref('CompletionDetails'),
      ),
    },
    '/api/v1/projects/{projectId}/complete': {
      parameters: [projectId],
      post: operation('completeProject', 'Complete a Project', 'Projects', ref('Project'), {
        description: 'Projects complete without Claims after every child Spec is terminal.',
        requestBody: body(ref('CompleteProjectInput')),
      }),
    },
    '/api/v1/projects/{projectId}/cancel': {
      parameters: [projectId],
      post: operation('cancelProject', 'Cancel a Project tree', 'Projects', ref('Project'), {
        description: 'Atomically cancels non-terminal descendants and releases their Claims.',
        requestBody: body(ref('CancelInput')),
      }),
    },
    '/api/v1/projects/{projectId}/specs': {
      parameters: [projectId],
      get: operation(
        'listProjectSpecs',
        'List bounded Spec manifests',
        'Specs',
        ref('SpecManifestPage'),
        {
          parameters: [
            {
              name: 'state',
              in: 'query',
              description: 'Optional Spec lifecycle filter.',
              schema: ref('SpecState'),
            },
            ...pagination,
          ],
        },
      ),
      post: operation('createSpec', 'Create a Spec inside a Project', 'Specs', ref('Spec'), {
        requestBody: body(ref('CreateSpecInput')),
        status: '201',
      }),
    },
    ...contextPaths('projects', projectId),
    '/api/v1/specs/{specId}': {
      parameters: [specId],
      patch: operation(
        'updateSpec',
        'Update Spec metadata, Markdown, or lifecycle',
        'Specs',
        ref('Spec'),
        {
          requestBody: body(ref('UpdateSpecInput')),
        },
      ),
    },
    '/api/v1/specs/{specId}/manifest': {
      parameters: [specId],
      get: operation(
        'getSpecManifest',
        'Read a bounded Spec manifest',
        'Specs',
        ref('SpecManifest'),
      ),
    },
    '/api/v1/specs/{specId}/body': {
      parameters: [specId],
      get: operation('readSpecBody', 'Read bounded Spec Markdown', 'Specs', ref('MarkdownPage'), {
        parameters: markdownPageParameters,
      }),
    },
    '/api/v1/specs/{specId}/completion': {
      parameters: [specId],
      get: operation(
        'getSpecCompletion',
        'Read Spec completion details',
        'Specs',
        ref('CompletionDetails'),
      ),
    },
    '/api/v1/specs/{specId}/cancel': {
      parameters: [specId],
      post: operation('cancelSpec', 'Cancel a Spec tree', 'Specs', ref('Spec'), {
        requestBody: body(ref('CancelInput')),
      }),
    },
    '/api/v1/specs/{specId}/tasks': {
      parameters: [specId],
      get: operation(
        'listSpecTasks',
        'List bounded Task manifests',
        'Tasks',
        ref('TaskManifestPage'),
        {
          parameters: pagination,
        },
      ),
      post: operation(
        'createTask',
        'Create a Task or Subtask inside a Spec',
        'Tasks',
        ref('Task'),
        {
          requestBody: body(ref('CreateTaskInput')),
          status: '201',
        },
      ),
    },
    '/api/v1/tasks/{taskId}': {
      parameters: [taskId],
      patch: operation('updateTask', 'Update Task metadata or Markdown', 'Tasks', ref('Task'), {
        requestBody: body(ref('UpdateTaskInput')),
      }),
    },
    '/api/v1/tasks/{taskId}/manifest': {
      parameters: [taskId],
      get: operation(
        'getTaskManifest',
        'Read a bounded Task manifest',
        'Tasks',
        ref('TaskManifest'),
      ),
    },
    '/api/v1/tasks/{taskId}/body': {
      parameters: [taskId],
      get: operation('readTaskBody', 'Read bounded Task Markdown', 'Tasks', ref('MarkdownPage'), {
        parameters: markdownPageParameters,
      }),
    },
    '/api/v1/tasks/{taskId}/completion': {
      parameters: [taskId],
      get: operation(
        'getTaskCompletion',
        'Read Task completion details',
        'Tasks',
        ref('CompletionDetails'),
      ),
    },
    '/api/v1/tasks/{taskId}/cancel': {
      parameters: [taskId],
      post: operation('cancelTask', 'Cancel a Task tree', 'Tasks', ref('Task'), {
        requestBody: body(ref('CancelInput')),
      }),
    },
    '/api/v1/work': {
      get: operation(
        'listWork',
        'List claimable Specs and leaf Tasks',
        'Work',
        arrayOf(ref('WorkItem')),
        {
          parameters: [
            {
              name: 'workspaceId',
              in: 'query',
              description: 'Optional Workspace ID.',
              schema: ref('Slug'),
            },
            {
              name: 'projectId',
              in: 'query',
              description: 'Optional Project UUID.',
              schema: ref('Id'),
            },
            { name: 'specId', in: 'query', description: 'Optional Spec UUID.', schema: ref('Id') },
            limitParameter,
          ],
        },
      ),
    },
    '/api/v1/work/{targetType}/{targetId}/claim': {
      parameters: [targetType, targetId],
      put: operation('startWork', 'Claim a Spec or Task', 'Work', ref('WorkBundle'), {
        requestBody: body(ref('ClaimInput')),
      }),
      patch: operation('renewWork', 'Renew a Spec or Task Claim', 'Work', ref('Claim'), {
        requestBody: body(ref('ClaimInput')),
      }),
      delete: operation('releaseWork', 'Release a Spec or Task Claim', 'Work', ref('Released'), {
        requestBody: body(ref('ReleaseInput')),
      }),
    },
    '/api/v1/work/{targetType}/{targetId}/complete': {
      parameters: [targetType, targetId],
      post: operation(
        'completeWork',
        'Complete claimed Spec or Task work',
        'Work',
        {
          oneOf: [ref('Spec'), ref('Task')],
        },
        { requestBody: body(ref('CompleteWorkInput')) },
      ),
    },
    '/api/v1/projects/{projectId}/activity': {
      parameters: [projectId],
      get: operation(
        'listProjectActivity',
        'List bounded Project activity',
        'Activity',
        arrayOf(ref('ActivityEvent')),
        {
          parameters: [{ ...limitParameter, description: 'Maximum latest events.' }],
        },
      ),
    },
    '/api/v1/admin/backup': {
      post: operation(
        'createBackup',
        'Create an explicit SQLite snapshot',
        'Administration',
        ref('PathResult'),
        {
          requestBody: body(ref('DirectoryInput')),
        },
      ),
    },
    '/api/v1/admin/export': {
      post: operation(
        'createPortableExport',
        'Create a portable schema-v2 export',
        'Administration',
        ref('PathResult'),
        {
          requestBody: body(ref('DirectoryInput')),
        },
      ),
    },
    '/mcp': {
      post: {
        operationId: 'callMcp',
        summary: 'Use MCP Streamable HTTP',
        description:
          'Negotiates the canonical agent tool catalog; tool payloads are described by MCP tools/list. Every other method on this path answers 405 with `Allow: POST`.',
        tags: ['MCP'],
        requestBody: body({ type: 'object' }),
        responses: {
          '200': response({ type: 'object' }, 'MCP response'),
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque local token' },
    },
    responses: {
      BadRequest: response(ref('ErrorEnvelope'), 'Invalid request'),
      Unauthorized: response(ref('ErrorEnvelope'), 'Missing or invalid bearer token'),
      NotFound: response(ref('ErrorEnvelope'), 'Resource not found'),
      Conflict: response(ref('ErrorEnvelope'), 'Lifecycle, Claim, or revision conflict'),
      PayloadTooLarge: response(ref('ErrorEnvelope'), 'Payload exceeds a bounded limit'),
      InternalError: response(ref('ErrorEnvelope'), 'Unexpected daemon failure'),
    },
    schemas: generateComponentSchemas(),
  },
};
