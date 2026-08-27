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

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (schema: JsonSchema): JsonSchema => ({ type: 'array', items: schema });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
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
const objectSchema = (required: string[], properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const pageSchema = (itemSchema: JsonSchema): JsonSchema =>
  objectSchema(['items', 'limit', 'offset', 'hasMore'], {
    items: arrayOf(itemSchema),
    limit: { type: 'integer', minimum: 1 },
    offset: { type: 'integer', minimum: 0 },
    hasMore: { type: 'boolean' },
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
const pagination = [
  {
    name: 'limit',
    in: 'query',
    description: 'Maximum items to return.',
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  },
  {
    name: 'offset',
    in: 'query',
    description: 'Zero-based deterministic item offset.',
    schema: { type: 'integer', minimum: 0, default: 0 },
  },
];
const markdownPageParameters = [
  {
    name: 'offsetCodeUnits',
    in: 'query',
    description: 'Zero-based JavaScript UTF-16 code-unit offset.',
    schema: { type: 'integer', minimum: 0, default: 0 },
  },
  {
    name: 'limitCodeUnits',
    in: 'query',
    description: 'Maximum UTF-16 code units to return.',
    schema: { type: 'integer', minimum: 1, maximum: 100_000, default: 20_000 },
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
    version: '1.0.0',
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
        ...operation('getHealth', 'Check daemon health', 'System', ref('Health'), {
          security: [],
        }),
        responses: { '200': response(ref('Health'), 'Daemon is running') },
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
              schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
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
      get: operation(
        'getProject',
        'Inspect a bounded Project manifest',
        'Projects',
        ref('ProjectManifest'),
      ),
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
      get: operation('getSpec', 'Inspect a bounded Spec manifest', 'Specs', ref('SpecManifest')),
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
      get: operation('getTask', 'Inspect a bounded Task manifest', 'Tasks', ref('TaskManifest')),
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
            {
              name: 'limit',
              in: 'query',
              description: 'Maximum items.',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
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
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'Maximum latest events.',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
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
          'Negotiates the canonical agent tool catalog; tool payloads are described by MCP tools/list.',
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
    schemas: {
      Id: { type: 'string', format: 'uuid' },
      Slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', minLength: 1, maxLength: 80 },
      AbsolutePath: { type: 'string', minLength: 1 },
      Timestamp: { type: 'string', format: 'date-time' },
      Markdown: { type: 'string', maxLength: 1_000_000 },
      ProjectState: { type: 'string', enum: ['draft', 'open', 'paused', 'done', 'cancelled'] },
      WritableProjectState: { type: 'string', enum: ['draft', 'open', 'paused'] },
      SpecState: { type: 'string', enum: ['draft', 'ready', 'done', 'cancelled'] },
      WritableSpecState: { type: 'string', enum: ['draft', 'ready'] },
      TaskState: { type: 'string', enum: ['open', 'done', 'cancelled'] },
      TargetType: { type: 'string', enum: ['spec', 'task'] },
      ContextOwnerType: { type: 'string', enum: ['workspace', 'project'] },
      SuccessEnvelope: objectSchema(['data', 'meta'], {
        data: {},
        meta: objectSchema(['schemaVersion'], { schemaVersion: { type: 'integer', const: 1 } }),
      }),
      OverviewSuccessEnvelope: objectSchema(['data', 'meta'], {
        data: {},
        meta: objectSchema(['schemaVersion'], { schemaVersion: { type: 'integer', const: 2 } }),
      }),
      Error: objectSchema(['code', 'message', 'retryable'], {
        code: {
          type: 'string',
          enum: [
            'bad_request',
            'not_found',
            'conflict',
            'revision_conflict',
            'invalid_state',
            'unauthorized',
            'payload_too_large',
            'internal_error',
          ],
        },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        details: { type: 'object', additionalProperties: true },
      }),
      ErrorEnvelope: objectSchema(['error'], { error: ref('Error') }),
      Health: objectSchema(['status', 'version'], {
        status: { type: 'string', const: 'ok' },
        version: { type: 'string', minLength: 1 },
      }),
      ArtifactReference: objectSchema(['label', 'uri'], {
        label: nullable({ type: 'string', maxLength: 120 }),
        uri: { type: 'string', minLength: 1, maxLength: 1_000 },
      }),
      Workspace: objectSchema(['id', 'name', 'rootPath', 'createdAt', 'updatedAt'], {
        id: ref('Slug'),
        name: { type: 'string', minLength: 1, maxLength: 120 },
        rootPath: ref('AbsolutePath'),
        createdAt: ref('Timestamp'),
        updatedAt: ref('Timestamp'),
      }),
      Project: objectSchema(
        [
          'id',
          'workspaceId',
          'slug',
          'title',
          'state',
          'revision',
          'completionSummary',
          'artifacts',
          'completedAt',
          'createdAt',
          'updatedAt',
        ],
        {
          id: ref('Id'),
          workspaceId: ref('Slug'),
          slug: ref('Slug'),
          title: { type: 'string', minLength: 1, maxLength: 200 },
          state: ref('ProjectState'),
          revision: { type: 'integer', minimum: 1 },
          completionSummary: nullable({ type: 'string', maxLength: 4_000 }),
          artifacts: arrayOf(ref('ArtifactReference')),
          completedAt: nullable(ref('Timestamp')),
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
        },
      ),
      ProjectManifest: {
        ...objectSchema(
          [
            'id',
            'workspaceId',
            'slug',
            'title',
            'state',
            'revision',
            'completedAt',
            'createdAt',
            'updatedAt',
            'artifactCount',
            'hasCompletion',
            'specCount',
            'draftSpecCount',
            'readySpecCount',
            'terminalSpecCount',
          ],
          {
            id: ref('Id'),
            workspaceId: ref('Slug'),
            slug: ref('Slug'),
            title: { type: 'string', minLength: 1, maxLength: 200 },
            state: ref('ProjectState'),
            revision: { type: 'integer', minimum: 1 },
            completedAt: nullable(ref('Timestamp')),
            createdAt: ref('Timestamp'),
            updatedAt: ref('Timestamp'),
            artifactCount: { type: 'integer', minimum: 0 },
            hasCompletion: { type: 'boolean' },
            specCount: { type: 'integer', minimum: 0 },
            draftSpecCount: { type: 'integer', minimum: 0 },
            readySpecCount: { type: 'integer', minimum: 0 },
            terminalSpecCount: { type: 'integer', minimum: 0 },
          },
        ),
        description: 'Project metadata with completion body and artifact array omitted.',
      },
      Claim: objectSchema(
        ['targetType', 'targetId', 'agentId', 'expiresAt', 'createdAt', 'updatedAt'],
        {
          targetType: ref('TargetType'),
          targetId: ref('Id'),
          agentId: { type: 'string', minLength: 1, maxLength: 200 },
          expiresAt: ref('Timestamp'),
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
        },
      ),
      Spec: objectSchema(
        [
          'id',
          'projectId',
          'slug',
          'title',
          'body',
          'state',
          'revision',
          'completionSummary',
          'artifacts',
          'completedAt',
          'createdAt',
          'updatedAt',
          'claim',
        ],
        {
          id: ref('Id'),
          projectId: ref('Id'),
          slug: ref('Slug'),
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: ref('Markdown'),
          state: ref('SpecState'),
          revision: { type: 'integer', minimum: 1 },
          completionSummary: nullable({ type: 'string', maxLength: 4_000 }),
          artifacts: arrayOf(ref('ArtifactReference')),
          completedAt: nullable(ref('Timestamp')),
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
          claim: nullable(ref('Claim')),
        },
      ),
      SpecManifest: {
        ...objectSchema(
          [
            'id',
            'projectId',
            'slug',
            'title',
            'state',
            'revision',
            'completedAt',
            'createdAt',
            'updatedAt',
            'claim',
            'bodySizeBytes',
            'artifactCount',
            'hasCompletion',
            'taskCount',
            'openTaskCount',
            'terminalTaskCount',
          ],
          {
            id: ref('Id'),
            projectId: ref('Id'),
            slug: ref('Slug'),
            title: { type: 'string', minLength: 1, maxLength: 200 },
            state: ref('SpecState'),
            revision: { type: 'integer', minimum: 1 },
            completedAt: nullable(ref('Timestamp')),
            createdAt: ref('Timestamp'),
            updatedAt: ref('Timestamp'),
            claim: nullable(ref('Claim')),
            bodySizeBytes: { type: 'integer', minimum: 0 },
            artifactCount: { type: 'integer', minimum: 0 },
            hasCompletion: { type: 'boolean' },
            taskCount: { type: 'integer', minimum: 0 },
            openTaskCount: { type: 'integer', minimum: 0 },
            terminalTaskCount: { type: 'integer', minimum: 0 },
          },
        ),
        description: 'Spec metadata with Markdown, completion body, and artifact array omitted.',
      },
      Task: objectSchema(
        [
          'id',
          'specId',
          'parentId',
          'title',
          'body',
          'state',
          'revision',
          'completionSummary',
          'artifacts',
          'completedAt',
          'createdAt',
          'updatedAt',
          'claim',
        ],
        {
          id: ref('Id'),
          specId: ref('Id'),
          parentId: nullable(ref('Id')),
          title: { type: 'string', minLength: 1, maxLength: 300 },
          body: nullable(ref('Markdown')),
          state: ref('TaskState'),
          revision: { type: 'integer', minimum: 1 },
          completionSummary: nullable({ type: 'string', maxLength: 4_000 }),
          artifacts: arrayOf(ref('ArtifactReference')),
          completedAt: nullable(ref('Timestamp')),
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
          claim: nullable(ref('Claim')),
        },
      ),
      TaskManifest: {
        ...objectSchema(
          [
            'id',
            'specId',
            'parentId',
            'title',
            'state',
            'revision',
            'completedAt',
            'createdAt',
            'updatedAt',
            'claim',
            'bodySizeBytes',
            'artifactCount',
            'hasCompletion',
            'subtaskCount',
            'openSubtaskCount',
          ],
          {
            id: ref('Id'),
            specId: ref('Id'),
            parentId: nullable(ref('Id')),
            title: { type: 'string', minLength: 1, maxLength: 300 },
            state: ref('TaskState'),
            revision: { type: 'integer', minimum: 1 },
            completedAt: nullable(ref('Timestamp')),
            createdAt: ref('Timestamp'),
            updatedAt: ref('Timestamp'),
            claim: nullable(ref('Claim')),
            bodySizeBytes: { type: 'integer', minimum: 0 },
            artifactCount: { type: 'integer', minimum: 0 },
            hasCompletion: { type: 'boolean' },
            subtaskCount: { type: 'integer', minimum: 0 },
            openSubtaskCount: { type: 'integer', minimum: 0 },
          },
        ),
        description: 'Task metadata with Markdown, completion body, and artifact array omitted.',
      },
      ContextDocument: objectSchema(
        ['id', 'ownerType', 'ownerId', 'name', 'body', 'revision', 'createdAt', 'updatedAt'],
        {
          id: ref('Id'),
          ownerType: ref('ContextOwnerType'),
          ownerId: { type: 'string', minLength: 1 },
          name: ref('Slug'),
          body: ref('Markdown'),
          revision: { type: 'integer', minimum: 1 },
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
        },
      ),
      ContextManifest: {
        ...objectSchema(
          ['id', 'ownerType', 'ownerId', 'name', 'revision', 'createdAt', 'updatedAt', 'sizeBytes'],
          {
            id: ref('Id'),
            ownerType: ref('ContextOwnerType'),
            ownerId: { type: 'string', minLength: 1 },
            name: ref('Slug'),
            revision: { type: 'integer', minimum: 1 },
            createdAt: ref('Timestamp'),
            updatedAt: ref('Timestamp'),
            sizeBytes: { type: 'integer', minimum: 0 },
          },
        ),
        description: 'Context metadata with the Markdown body omitted.',
      },
      MarkdownPage: objectSchema(
        ['body', 'offsetCodeUnits', 'totalCodeUnits', 'sizeBytes', 'hasMore'],
        {
          body: { type: 'string' },
          offsetCodeUnits: { type: 'integer', minimum: 0 },
          totalCodeUnits: { type: 'integer', minimum: 0 },
          sizeBytes: { type: 'integer', minimum: 0 },
          hasMore: { type: 'boolean' },
        },
      ),
      CompletionDetails: objectSchema(['completionSummary', 'artifacts', 'completedAt'], {
        completionSummary: nullable({ type: 'string', maxLength: 4_000 }),
        artifacts: arrayOf(ref('ArtifactReference')),
        completedAt: nullable(ref('Timestamp')),
      }),
      ProjectManifestPage: pageSchema(ref('ProjectManifest')),
      SpecManifestPage: pageSchema(ref('SpecManifest')),
      TaskManifestPage: pageSchema(ref('TaskManifest')),
      ContextManifestPage: pageSchema(ref('ContextManifest')),
      WorkContextManifestPage: objectSchema(['items', 'hasMore'], {
        items: arrayOf(ref('ContextManifest')),
        hasMore: { type: 'boolean' },
      }),
      WorkItem: objectSchema(
        [
          'targetType',
          'targetId',
          'workspaceId',
          'projectId',
          'projectTitle',
          'specId',
          'specTitle',
          'taskId',
          'taskTitle',
          'parentTaskId',
          'revision',
        ],
        {
          targetType: ref('TargetType'),
          targetId: ref('Id'),
          workspaceId: ref('Slug'),
          projectId: ref('Id'),
          projectTitle: { type: 'string' },
          specId: ref('Id'),
          specTitle: { type: 'string' },
          taskId: nullable(ref('Id')),
          taskTitle: nullable({ type: 'string' }),
          parentTaskId: nullable(ref('Id')),
          revision: { type: 'integer', minimum: 1 },
        },
      ),
      WorkBundle: objectSchema(
        ['claim', 'workspace', 'project', 'spec', 'task', 'workspaceContext', 'projectContext'],
        {
          claim: ref('Claim'),
          workspace: ref('Workspace'),
          project: ref('ProjectManifest'),
          spec: ref('SpecManifest'),
          task: nullable(ref('TaskManifest')),
          workspaceContext: ref('WorkContextManifestPage'),
          projectContext: ref('WorkContextManifestPage'),
        },
      ),
      ActivityEvent: objectSchema(
        [
          'id',
          'workspaceId',
          'projectId',
          'specId',
          'targetType',
          'targetId',
          'eventType',
          'actor',
          'data',
          'createdAt',
        ],
        {
          id: { type: 'integer', minimum: 1 },
          workspaceId: nullable(ref('Slug')),
          projectId: nullable(ref('Id')),
          specId: nullable(ref('Id')),
          targetType: { type: 'string' },
          targetId: { type: 'string' },
          eventType: { type: 'string' },
          actor: nullable({ type: 'string' }),
          data: { type: 'object', additionalProperties: true },
          createdAt: ref('Timestamp'),
        },
      ),
      RegisterWorkspaceInput: objectSchema(['id', 'name', 'rootPath'], {
        id: ref('Slug'),
        name: { type: 'string', minLength: 1, maxLength: 120 },
        rootPath: ref('AbsolutePath'),
      }),
      ResolveWorkspaceInput: objectSchema(['path'], { path: ref('AbsolutePath') }),
      CreateProjectInput: objectSchema(['workspaceId', 'slug', 'title'], {
        workspaceId: ref('Slug'),
        slug: ref('Slug'),
        title: { type: 'string', minLength: 1, maxLength: 200 },
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      UpdateProjectInput: objectSchema(['expectedRevision'], {
        title: nullable({ type: 'string', minLength: 1, maxLength: 200 }),
        state: nullable(ref('WritableProjectState')),
        expectedRevision: { type: 'integer', minimum: 1 },
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      CompleteProjectInput: objectSchema(['expectedRevision', 'summary'], {
        expectedRevision: { type: 'integer', minimum: 1 },
        summary: { type: 'string', minLength: 1, maxLength: 4_000 },
        artifacts: { type: 'array', maxItems: 20, items: ref('ArtifactReference'), default: [] },
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      CancelInput: objectSchema(['expectedRevision', 'reason'], {
        expectedRevision: { type: 'integer', minimum: 1 },
        reason: { type: 'string', minLength: 1, maxLength: 4_000 },
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      CreateSpecInput: objectSchema(['slug', 'title'], {
        slug: ref('Slug'),
        title: { type: 'string', minLength: 1, maxLength: 200 },
        body: { ...ref('Markdown'), default: '' },
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      UpdateSpecInput: objectSchema(['expectedRevision'], {
        title: nullable({ type: 'string', minLength: 1, maxLength: 200 }),
        body: nullable(ref('Markdown')),
        state: nullable(ref('WritableSpecState')),
        expectedRevision: { type: 'integer', minimum: 1 },
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      CreateTaskInput: objectSchema(['title'], {
        parentId: nullable(ref('Id')),
        title: { type: 'string', minLength: 1, maxLength: 300 },
        body: nullable(ref('Markdown')),
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      UpdateTaskInput: objectSchema(['expectedRevision'], {
        title: nullable({ type: 'string', minLength: 1, maxLength: 300 }),
        body: nullable(ref('Markdown')),
        expectedRevision: { type: 'integer', minimum: 1 },
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      PutContextInput: objectSchema(['body'], {
        body: ref('Markdown'),
        expectedRevision: nullable({ type: 'integer', minimum: 1 }),
        actor: nullable({ type: 'string', maxLength: 200 }),
      }),
      ClaimInput: objectSchema(['agentId'], {
        agentId: { type: 'string', minLength: 1, maxLength: 200 },
        leaseSeconds: { type: 'integer', minimum: 60, maximum: 86_400, default: 1_800 },
      }),
      ReleaseInput: objectSchema(['agentId'], {
        agentId: { type: 'string', minLength: 1, maxLength: 200 },
        note: nullable({ type: 'string', maxLength: 500 }),
      }),
      CompleteWorkInput: objectSchema(['agentId', 'expectedRevision', 'summary'], {
        agentId: { type: 'string', minLength: 1, maxLength: 200 },
        expectedRevision: { type: 'integer', minimum: 1 },
        summary: { type: 'string', minLength: 1, maxLength: 4_000 },
        artifacts: { type: 'array', maxItems: 20, items: ref('ArtifactReference'), default: [] },
      }),
      Released: objectSchema(['released'], { released: { type: 'boolean', const: true } }),
      DirectoryInput: objectSchema(['directory'], { directory: ref('AbsolutePath') }),
      SyncConfigurationInput: objectSchema(['directory', 'deviceId'], {
        directory: ref('AbsolutePath'),
        deviceId: {
          type: 'string',
          pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$',
        },
      }),
      ResolveSyncConflictInput: objectSchema(['choice'], {
        choice: { type: 'string', enum: ['local', 'remote'] },
      }),
      SyncStatus: objectSchema(
        [
          'enabled',
          'paused',
          'state',
          'directory',
          'deviceId',
          'lastAttemptAt',
          'lastImportAt',
          'lastExportAt',
          'pendingSnapshotCount',
          'conflictCount',
          'error',
        ],
        {
          enabled: { type: 'boolean' },
          paused: { type: 'boolean' },
          state: {
            type: 'string',
            enum: [
              'disabled',
              'paused',
              'pending',
              'importing',
              'exporting',
              'healthy',
              'unavailable',
              'error',
              'conflict',
            ],
          },
          directory: nullable(ref('AbsolutePath')),
          deviceId: nullable({ type: 'string' }),
          lastAttemptAt: nullable(ref('Timestamp')),
          lastImportAt: nullable(ref('Timestamp')),
          lastExportAt: nullable(ref('Timestamp')),
          pendingSnapshotCount: { type: 'integer', minimum: 0 },
          conflictCount: { type: 'integer', minimum: 0 },
          error: nullable({ type: 'string' }),
        },
      ),
      SyncConflict: objectSchema(['id', 'entityType', 'entityId', 'local', 'remote', 'createdAt'], {
        id: { type: 'string' },
        entityType: { type: 'string', enum: ['workspace', 'project', 'spec', 'context', 'task'] },
        entityId: { type: 'string' },
        local: {},
        remote: {},
        createdAt: ref('Timestamp'),
      }),
      SyncConflictManifest: objectSchema(['id', 'entityType', 'entityId', 'createdAt'], {
        id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        entityType: { type: 'string', enum: ['workspace', 'project', 'spec', 'context', 'task'] },
        entityId: { type: 'string' },
        createdAt: ref('Timestamp'),
      }),
      SyncConflictManifestPage: pageSchema(ref('SyncConflictManifest')),
      PathResult: objectSchema(['path'], { path: ref('AbsolutePath') }),
      AutomaticBackupStatus: objectSchema(
        [
          'enabled',
          'directory',
          'snapshotPath',
          'state',
          'lastAttemptAt',
          'lastSuccessAt',
          'lastError',
        ],
        {
          enabled: { type: 'boolean' },
          directory: nullable(ref('AbsolutePath')),
          snapshotPath: nullable(ref('AbsolutePath')),
          state: { type: 'string', enum: ['disabled', 'healthy', 'refreshing', 'error'] },
          lastAttemptAt: nullable(ref('Timestamp')),
          lastSuccessAt: nullable(ref('Timestamp')),
          lastError: nullable({ type: 'string' }),
        },
      ),
      OverviewDaemon: objectSchema(['version', 'startedAt', 'uptimeSeconds'], {
        version: { type: 'string', minLength: 1 },
        startedAt: ref('Timestamp'),
        uptimeSeconds: { type: 'integer', minimum: 0 },
      }),
      OverviewCounts: objectSchema(
        [
          'workspaces',
          'projects',
          'specs',
          'draftProjects',
          'openProjects',
          'pausedProjects',
          'completedProjects',
          'cancelledProjects',
          'openTasks',
          'completedTasks',
          'cancelledTasks',
          'activeClaims',
          'availableWork',
        ],
        {
          workspaces: { type: 'integer', minimum: 0 },
          projects: { type: 'integer', minimum: 0 },
          specs: { type: 'integer', minimum: 0 },
          draftProjects: { type: 'integer', minimum: 0 },
          openProjects: { type: 'integer', minimum: 0 },
          pausedProjects: { type: 'integer', minimum: 0 },
          completedProjects: { type: 'integer', minimum: 0 },
          cancelledProjects: { type: 'integer', minimum: 0 },
          openTasks: { type: 'integer', minimum: 0 },
          completedTasks: { type: 'integer', minimum: 0 },
          cancelledTasks: { type: 'integer', minimum: 0 },
          activeClaims: { type: 'integer', minimum: 0 },
          availableWork: { type: 'integer', minimum: 0 },
        },
      ),
      OverviewWorkspace: objectSchema(['id', 'name', 'rootPath'], {
        id: ref('Slug'),
        name: { type: 'string', minLength: 1, maxLength: 120 },
        rootPath: ref('AbsolutePath'),
      }),
      OverviewProject: objectSchema(
        [
          'id',
          'workspace',
          'slug',
          'title',
          'lifecycleState',
          'status',
          'specCount',
          'openTaskCount',
          'completedTaskCount',
          'activeClaimCount',
          'availableWorkCount',
          'updatedAt',
        ],
        {
          id: ref('Id'),
          workspace: ref('OverviewWorkspace'),
          slug: ref('Slug'),
          title: { type: 'string', minLength: 1, maxLength: 200 },
          lifecycleState: ref('ProjectState'),
          status: { type: 'string', enum: ['active', 'available', 'complete', 'draft', 'paused'] },
          specCount: { type: 'integer', minimum: 0 },
          openTaskCount: { type: 'integer', minimum: 0 },
          completedTaskCount: { type: 'integer', minimum: 0 },
          activeClaimCount: { type: 'integer', minimum: 0 },
          availableWorkCount: { type: 'integer', minimum: 0 },
          updatedAt: ref('Timestamp'),
        },
      ),
      OverviewActiveWork: objectSchema(
        [
          'targetType',
          'targetId',
          'workspaceId',
          'projectId',
          'projectTitle',
          'specId',
          'specTitle',
          'taskId',
          'taskTitle',
          'agentId',
          'expiresAt',
        ],
        {
          targetType: ref('TargetType'),
          targetId: ref('Id'),
          workspaceId: ref('Slug'),
          projectId: ref('Id'),
          projectTitle: { type: 'string' },
          specId: ref('Id'),
          specTitle: { type: 'string' },
          taskId: nullable(ref('Id')),
          taskTitle: nullable({ type: 'string' }),
          agentId: { type: 'string', minLength: 1, maxLength: 200 },
          expiresAt: ref('Timestamp'),
        },
      ),
      Overview: objectSchema(
        [
          'daemon',
          'generatedAt',
          'status',
          'counts',
          'projects',
          'projectsTruncated',
          'activeWork',
          'activeWorkTruncated',
        ],
        {
          daemon: ref('OverviewDaemon'),
          generatedAt: ref('Timestamp'),
          status: {
            type: 'string',
            enum: ['active', 'available', 'complete', 'draft', 'paused', 'empty'],
          },
          counts: ref('OverviewCounts'),
          projects: { type: 'array', maxItems: 500, items: ref('OverviewProject') },
          projectsTruncated: { type: 'boolean' },
          activeWork: { type: 'array', maxItems: 500, items: ref('OverviewActiveWork') },
          activeWorkTruncated: { type: 'boolean' },
        },
      ),
    },
  },
};
