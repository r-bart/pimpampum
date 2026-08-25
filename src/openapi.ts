type JsonSchema = Record<string, unknown>;

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

const projectId = {
  name: 'projectId',
  in: 'path',
  required: true,
  description: 'Project UUID.',
  schema: { type: 'string', format: 'uuid' },
};
const taskId = {
  name: 'taskId',
  in: 'path',
  required: true,
  description: 'Task or subtask UUID.',
  schema: { type: 'string', format: 'uuid' },
};
const contextName = {
  name: 'name',
  in: 'path',
  required: true,
  description: 'Context document lowercase kebab-case name.',
  schema: { $ref: '#/components/schemas/Slug' },
};
const targetType = {
  name: 'targetType',
  in: 'path',
  required: true,
  description: 'Claimed resource kind.',
  schema: { type: 'string', enum: ['project', 'task'] },
};
const targetId = {
  name: 'targetId',
  in: 'path',
  required: true,
  description: 'Claimed project or task UUID.',
  schema: { type: 'string', format: 'uuid' },
};
const limit = {
  name: 'limit',
  in: 'query',
  description: 'Maximum items to return.',
  schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
};
const offset = {
  name: 'offset',
  in: 'query',
  description: 'Zero-based deterministic item offset.',
  schema: { type: 'integer', minimum: 0, default: 0 },
};
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

export const openApiDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Pimpampum Local API',
    version: '0.1.0',
    summary: 'Minimal local coordination for humans and software agents.',
    description:
      'One machine-local daemon manages workspaces, Markdown PRDs, contextual documents, tasks, subtasks, expiring claims, backup, and export. JSON writes use optimistic revisions. The bearer token is stored in the configured Pimpampum data directory.',
    license: { name: 'MIT' },
  },
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  servers: [{ url: 'http://127.0.0.1:7337', description: 'Default local daemon' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'System', description: 'Health and machine-readable contracts.' },
    { name: 'Workspaces', description: 'Registered repository and directory roots.' },
    { name: 'Projects', description: 'Projects whose source of intent is a Markdown PRD.' },
    { name: 'Context', description: 'Named contextual Markdown documents attached to projects.' },
    { name: 'Tasks', description: 'Top-level tasks and one level of subtasks.' },
    { name: 'Work', description: 'Claim, lease, release, and completion coordination.' },
    { name: 'Activity', description: 'Bounded automatic audit events.' },
    { name: 'Administration', description: 'Explicit backup and portable export operations.' },
    { name: 'MCP', description: 'MCP Streamable HTTP transport; tools are documented separately.' },
  ],
  paths: {
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Check daemon health',
        description: 'Public loopback health probe. It does not inspect or expose project data.',
        tags: ['System'],
        security: [],
        responses: {
          '200': response(ref('Health'), 'Daemon is running'),
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApi',
        summary: 'Read the OpenAPI contract',
        description: 'Public OpenAPI 3.1 document for this daemon version.',
        tags: ['System'],
        security: [],
        responses: {
          '200': response({ type: 'object' }, 'OpenAPI 3.1 document'),
        },
      },
    },
    '/api/v1/workspaces': {
      get: {
        operationId: 'listWorkspaces',
        summary: 'List registered workspaces',
        tags: ['Workspaces'],
        responses: responses(arrayOf(ref('Workspace'))),
      },
      post: {
        operationId: 'registerWorkspace',
        summary: 'Register a local workspace root',
        description: 'The root path must be absolute and readable by the daemon process.',
        tags: ['Workspaces'],
        requestBody: body(ref('RegisterWorkspaceInput')),
        responses: responses(ref('Workspace'), '201'),
      },
    },
    '/api/v1/workspaces/resolve': {
      post: {
        operationId: 'resolveWorkspace',
        summary: 'Resolve a path to its workspace',
        description: 'Returns the most specific registered root containing the absolute path.',
        tags: ['Workspaces'],
        requestBody: body({
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: ref('AbsolutePath') },
        }),
        responses: responses(ref('Workspace')),
      },
    },
    '/api/v1/projects': {
      get: {
        operationId: 'listProjects',
        summary: 'List lightweight project manifests',
        description: 'PRD and completion bodies are omitted to keep discovery bounded.',
        tags: ['Projects'],
        parameters: [
          {
            name: 'workspaceId',
            in: 'query',
            description: 'Optional workspace ID filter.',
            schema: ref('Slug'),
          },
          {
            name: 'state',
            in: 'query',
            description: 'Optional lifecycle state filter.',
            schema: { type: 'string', enum: ['draft', 'ready', 'done'] },
          },
          limit,
          offset,
        ],
        responses: responses(arrayOf(ref('ProjectManifest'))),
      },
      post: {
        operationId: 'createProject',
        summary: 'Create a project and Markdown PRD',
        tags: ['Projects'],
        requestBody: body(ref('CreateProjectInput')),
        responses: responses(ref('Project'), '201'),
      },
    },
    '/api/v1/projects/{projectId}': {
      parameters: [projectId],
      get: {
        operationId: 'getProject',
        summary: 'Read a complete project',
        description:
          'Includes the complete PRD and completion fields; prefer the manifest for discovery.',
        tags: ['Projects'],
        responses: responses(ref('Project')),
      },
      patch: {
        operationId: 'updateProject',
        summary: 'Update project metadata',
        description: 'Updates title and/or draft/ready state with optimistic revision control.',
        tags: ['Projects'],
        requestBody: body(ref('UpdateProjectInput')),
        responses: responses(ref('Project')),
      },
    },
    '/api/v1/projects/{projectId}/manifest': {
      parameters: [projectId],
      get: {
        operationId: 'getProjectManifest',
        summary: 'Read a lightweight project manifest',
        tags: ['Projects'],
        responses: responses(ref('ProjectManifest')),
      },
    },
    '/api/v1/projects/{projectId}/prd': {
      parameters: [projectId],
      get: {
        operationId: 'readProjectPrd',
        summary: 'Read a bounded PRD page',
        tags: ['Projects'],
        parameters: markdownPageParameters,
        responses: responses(ref('MarkdownPage')),
      },
      put: {
        operationId: 'replaceProjectPrd',
        summary: 'Replace the complete project PRD',
        tags: ['Projects'],
        requestBody: body(ref('ReplacePrdInput')),
        responses: responses(ref('Project')),
      },
    },
    '/api/v1/projects/{projectId}/completion': {
      parameters: [projectId],
      get: {
        operationId: 'getProjectCompletion',
        summary: 'Read project completion details',
        tags: ['Projects'],
        responses: responses(ref('CompletionDetails')),
      },
    },
    '/api/v1/projects/{projectId}/context': {
      parameters: [projectId],
      get: {
        operationId: 'listContext',
        summary: 'List context manifests',
        description: 'Markdown bodies are omitted.',
        tags: ['Context'],
        parameters: [limit, offset],
        responses: responses(arrayOf(ref('ContextManifest'))),
      },
    },
    '/api/v1/projects/{projectId}/context/{name}': {
      parameters: [projectId, contextName],
      get: {
        operationId: 'getContext',
        summary: 'Read a complete context document',
        tags: ['Context'],
        responses: responses(ref('ContextDocument')),
      },
      put: {
        operationId: 'putContext',
        summary: 'Create or replace a context document',
        description: 'Use null expectedRevision to create and the current revision to replace.',
        tags: ['Context'],
        requestBody: body(ref('PutContextInput')),
        responses: responses(ref('ContextDocument')),
      },
    },
    '/api/v1/projects/{projectId}/context/{name}/body': {
      parameters: [projectId, contextName],
      get: {
        operationId: 'readContextBody',
        summary: 'Read a bounded context page',
        tags: ['Context'],
        parameters: markdownPageParameters,
        responses: responses(ref('MarkdownPage')),
      },
    },
    '/api/v1/projects/{projectId}/tasks': {
      parameters: [projectId],
      get: {
        operationId: 'listTasks',
        summary: 'List task and subtask manifests',
        description: 'Task bodies and completion details are omitted.',
        tags: ['Tasks'],
        parameters: [limit, offset],
        responses: responses(arrayOf(ref('TaskManifest'))),
      },
      post: {
        operationId: 'createTask',
        summary: 'Create a task or one-level subtask',
        tags: ['Tasks'],
        requestBody: body(ref('CreateTaskInput')),
        responses: responses(ref('Task'), '201'),
      },
    },
    '/api/v1/tasks/{taskId}': {
      parameters: [taskId],
      get: {
        operationId: 'getTask',
        summary: 'Read a complete task',
        tags: ['Tasks'],
        responses: responses(ref('Task')),
      },
      patch: {
        operationId: 'updateTask',
        summary: 'Update an open task',
        tags: ['Tasks'],
        requestBody: body(ref('UpdateTaskInput')),
        responses: responses(ref('Task')),
      },
    },
    '/api/v1/tasks/{taskId}/manifest': {
      parameters: [taskId],
      get: {
        operationId: 'getTaskManifest',
        summary: 'Read a lightweight task manifest',
        tags: ['Tasks'],
        responses: responses(ref('TaskManifest')),
      },
    },
    '/api/v1/tasks/{taskId}/body': {
      parameters: [taskId],
      get: {
        operationId: 'readTaskBody',
        summary: 'Read a bounded task body page',
        tags: ['Tasks'],
        parameters: markdownPageParameters,
        responses: responses(ref('MarkdownPage')),
      },
    },
    '/api/v1/tasks/{taskId}/completion': {
      parameters: [taskId],
      get: {
        operationId: 'getTaskCompletion',
        summary: 'Read task completion details',
        tags: ['Tasks'],
        responses: responses(ref('CompletionDetails')),
      },
    },
    '/api/v1/work': {
      get: {
        operationId: 'listClaimableWork',
        summary: 'List claimable projects and leaf tasks',
        tags: ['Work'],
        parameters: [
          {
            name: 'workspaceId',
            in: 'query',
            description: 'Optional workspace ID filter.',
            schema: ref('Slug'),
          },
          limit,
        ],
        responses: responses(arrayOf(ref('WorkItem'))),
      },
    },
    '/api/v1/work/{targetType}/{targetId}/claim': {
      parameters: [targetType, targetId],
      put: {
        operationId: 'startWork',
        summary: 'Atomically claim work',
        description: 'An active claim by another agent returns conflict.',
        tags: ['Work'],
        requestBody: body(ref('ClaimInput')),
        responses: responses(ref('WorkBundle')),
      },
      patch: {
        operationId: 'renewWork',
        summary: 'Renew an owned claim',
        tags: ['Work'],
        requestBody: body(ref('ClaimInput')),
        responses: responses(ref('Claim')),
      },
      delete: {
        operationId: 'releaseWork',
        summary: 'Release an owned claim',
        tags: ['Work'],
        requestBody: body(ref('ReleaseInput')),
        responses: responses({
          type: 'object',
          required: ['released'],
          properties: { released: { type: 'boolean', const: true } },
        }),
      },
    },
    '/api/v1/work/{targetType}/{targetId}/complete': {
      parameters: [targetType, targetId],
      post: {
        operationId: 'completeWork',
        summary: 'Complete claimed work',
        description:
          'Persists summary and artifact references, marks done, and releases the claim.',
        tags: ['Work'],
        requestBody: body(ref('CompleteWorkInput')),
        responses: responses({ oneOf: [ref('Project'), ref('Task')] }),
      },
    },
    '/api/v1/projects/{projectId}/activity': {
      parameters: [projectId],
      get: {
        operationId: 'listActivity',
        summary: 'List latest automatic project activity',
        tags: ['Activity'],
        parameters: [limit],
        responses: responses(arrayOf(ref('ActivityEvent'))),
      },
    },
    '/api/v1/admin/backup': {
      post: {
        operationId: 'createBackup',
        summary: 'Create an integrity-checked SQLite snapshot',
        tags: ['Administration'],
        requestBody: body(ref('DirectoryInput')),
        responses: responses(ref('PathResult'), '201'),
      },
    },
    '/api/v1/admin/export': {
      post: {
        operationId: 'createPortableExport',
        summary: 'Export portable JSON and Markdown',
        description: 'Rejected while active claims exist. The operation is synchronous.',
        tags: ['Administration'],
        requestBody: body(ref('DirectoryInput')),
        responses: responses(ref('PathResult'), '201'),
      },
    },
    '/mcp': {
      post: {
        operationId: 'mcpStreamableHttp',
        summary: 'Send an MCP Streamable HTTP request',
        description:
          'Stateless JSON response mode. MCP initialize, tools/list, and tools/call follow the Model Context Protocol. See docs/mcp-tools.md for the agent tool contract.',
        tags: ['MCP'],
        requestBody: body(ref('JsonRpcRequest')),
        responses: {
          '200': response({ type: 'object' }, 'MCP JSON-RPC response'),
          '401': { $ref: '#/components/responses/Unauthorized' },
          '400': { $ref: '#/components/responses/BadRequest' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Machine-local token from the configured Pimpampum data directory. Never commit it.',
      },
    },
    responses: {
      BadRequest: {
        description: 'Invalid request',
        content: { 'application/json': { schema: ref('ErrorResponse') } },
      },
      Unauthorized: {
        description: 'Missing or invalid bearer token',
        content: { 'application/json': { schema: ref('ErrorResponse') } },
      },
      NotFound: {
        description: 'Resource or route not found',
        content: { 'application/json': { schema: ref('ErrorResponse') } },
      },
      Conflict: {
        description: 'Claim, revision, uniqueness, or state conflict',
        content: { 'application/json': { schema: ref('ErrorResponse') } },
      },
      PayloadTooLarge: {
        description: 'JSON body exceeds 2 MB',
        content: { 'application/json': { schema: ref('ErrorResponse') } },
      },
      InternalError: {
        description: 'Unexpected daemon failure',
        content: { 'application/json': { schema: ref('ErrorResponse') } },
      },
    },
    schemas: {
      Slug: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
        examples: ['vcomp'],
      },
      AbsolutePath: {
        type: 'string',
        minLength: 1,
        description: 'Absolute filesystem path on the daemon machine.',
        examples: ['/Users/roberto/Desktop/ventures/vcomp'],
      },
      Timestamp: { type: 'string', format: 'date-time' },
      Artifact: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'uri'],
        properties: {
          label: { type: ['string', 'null'], maxLength: 120 },
          uri: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
      },
      Claim: {
        type: 'object',
        required: ['targetType', 'targetId', 'agentId', 'expiresAt', 'createdAt', 'updatedAt'],
        properties: {
          targetType: { type: 'string', enum: ['project', 'task'] },
          targetId: { type: 'string', format: 'uuid' },
          agentId: { type: 'string', minLength: 1, maxLength: 200 },
          expiresAt: ref('Timestamp'),
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
        },
      },
      Workspace: {
        type: 'object',
        required: ['id', 'name', 'rootPath', 'createdAt', 'updatedAt'],
        properties: {
          id: ref('Slug'),
          name: { type: 'string', minLength: 1, maxLength: 120 },
          rootPath: ref('AbsolutePath'),
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
        },
      },
      Project: {
        type: 'object',
        required: [
          'id',
          'workspaceId',
          'slug',
          'title',
          'state',
          'prd',
          'revision',
          'completionSummary',
          'artifacts',
          'completedAt',
          'createdAt',
          'updatedAt',
          'claim',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          workspaceId: ref('Slug'),
          slug: ref('Slug'),
          title: { type: 'string', minLength: 1, maxLength: 200 },
          state: { type: 'string', enum: ['draft', 'ready', 'done'] },
          prd: { type: 'string', maxLength: 1_000_000 },
          revision: { type: 'integer', minimum: 1 },
          completionSummary: { type: ['string', 'null'], maxLength: 4_000 },
          artifacts: arrayOf(ref('Artifact')),
          completedAt: { oneOf: [ref('Timestamp'), { type: 'null' }] },
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
          claim: { oneOf: [ref('Claim'), { type: 'null' }] },
        },
      },
      ProjectManifest: {
        allOf: [
          {
            type: 'object',
            required: [
              'id',
              'workspaceId',
              'slug',
              'title',
              'state',
              'revision',
              'completedAt',
              'createdAt',
              'updatedAt',
              'claim',
              'prdSizeBytes',
              'artifactCount',
              'hasCompletion',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              workspaceId: ref('Slug'),
              slug: ref('Slug'),
              title: { type: 'string' },
              state: { type: 'string', enum: ['draft', 'ready', 'done'] },
              revision: { type: 'integer', minimum: 1 },
              completedAt: { oneOf: [ref('Timestamp'), { type: 'null' }] },
              createdAt: ref('Timestamp'),
              updatedAt: ref('Timestamp'),
              claim: { oneOf: [ref('Claim'), { type: 'null' }] },
              prdSizeBytes: { type: 'integer', minimum: 0 },
              artifactCount: { type: 'integer', minimum: 0 },
              hasCompletion: { type: 'boolean' },
            },
          },
        ],
      },
      Task: {
        type: 'object',
        required: [
          'id',
          'projectId',
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
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          parentId: { type: ['string', 'null'], format: 'uuid' },
          title: { type: 'string', minLength: 1, maxLength: 300 },
          body: { type: ['string', 'null'], maxLength: 1_000_000 },
          state: { type: 'string', enum: ['open', 'done'] },
          revision: { type: 'integer', minimum: 1 },
          completionSummary: { type: ['string', 'null'], maxLength: 4_000 },
          artifacts: arrayOf(ref('Artifact')),
          completedAt: { oneOf: [ref('Timestamp'), { type: 'null' }] },
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
          claim: { oneOf: [ref('Claim'), { type: 'null' }] },
        },
      },
      TaskManifest: {
        type: 'object',
        required: [
          'id',
          'projectId',
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
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          parentId: { type: ['string', 'null'], format: 'uuid' },
          title: { type: 'string' },
          state: { type: 'string', enum: ['open', 'done'] },
          revision: { type: 'integer', minimum: 1 },
          completedAt: { oneOf: [ref('Timestamp'), { type: 'null' }] },
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
          claim: { oneOf: [ref('Claim'), { type: 'null' }] },
          bodySizeBytes: { type: 'integer', minimum: 0 },
          artifactCount: { type: 'integer', minimum: 0 },
          hasCompletion: { type: 'boolean' },
        },
      },
      ContextDocument: {
        type: 'object',
        required: ['id', 'projectId', 'name', 'body', 'revision', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          name: ref('Slug'),
          body: { type: 'string', maxLength: 1_000_000 },
          revision: { type: 'integer', minimum: 1 },
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
        },
      },
      ContextManifest: {
        type: 'object',
        required: ['id', 'projectId', 'name', 'revision', 'createdAt', 'updatedAt', 'sizeBytes'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          name: ref('Slug'),
          revision: { type: 'integer', minimum: 1 },
          createdAt: ref('Timestamp'),
          updatedAt: ref('Timestamp'),
          sizeBytes: { type: 'integer', minimum: 0 },
        },
      },
      MarkdownPage: {
        type: 'object',
        required: ['body', 'offsetCodeUnits', 'totalCodeUnits', 'sizeBytes', 'hasMore'],
        properties: {
          body: { type: 'string' },
          offsetCodeUnits: { type: 'integer', minimum: 0 },
          totalCodeUnits: { type: 'integer', minimum: 0 },
          sizeBytes: { type: 'integer', minimum: 0 },
          hasMore: { type: 'boolean' },
        },
      },
      CompletionDetails: {
        type: 'object',
        required: ['completionSummary', 'artifacts', 'completedAt'],
        properties: {
          completionSummary: { type: ['string', 'null'], maxLength: 4_000 },
          artifacts: arrayOf(ref('Artifact')),
          completedAt: { oneOf: [ref('Timestamp'), { type: 'null' }] },
        },
      },
      WorkItem: {
        type: 'object',
        required: [
          'targetType',
          'targetId',
          'workspaceId',
          'projectId',
          'projectTitle',
          'taskId',
          'taskTitle',
          'parentTaskId',
          'revision',
        ],
        properties: {
          targetType: { type: 'string', enum: ['project', 'task'] },
          targetId: { type: 'string', format: 'uuid' },
          workspaceId: ref('Slug'),
          projectId: { type: 'string', format: 'uuid' },
          projectTitle: { type: 'string' },
          taskId: { type: ['string', 'null'], format: 'uuid' },
          taskTitle: { type: ['string', 'null'] },
          parentTaskId: { type: ['string', 'null'], format: 'uuid' },
          revision: { type: 'integer', minimum: 1 },
        },
      },
      WorkBundle: {
        type: 'object',
        required: ['claim', 'workspace', 'project', 'task', 'context', 'contextHasMore'],
        properties: {
          claim: ref('Claim'),
          workspace: ref('Workspace'),
          project: ref('ProjectManifest'),
          task: { oneOf: [ref('TaskManifest'), { type: 'null' }] },
          context: arrayOf(ref('ContextManifest')),
          contextHasMore: { type: 'boolean' },
        },
      },
      ActivityEvent: {
        type: 'object',
        required: [
          'id',
          'workspaceId',
          'projectId',
          'targetType',
          'targetId',
          'eventType',
          'actor',
          'data',
          'createdAt',
        ],
        properties: {
          id: { type: 'integer', minimum: 1 },
          workspaceId: { oneOf: [ref('Slug'), { type: 'null' }] },
          projectId: { type: ['string', 'null'], format: 'uuid' },
          targetType: { type: 'string' },
          targetId: { type: 'string' },
          eventType: { type: 'string' },
          actor: { type: ['string', 'null'] },
          data: { type: 'object', additionalProperties: true },
          createdAt: ref('Timestamp'),
        },
      },
      RegisterWorkspaceInput: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'rootPath'],
        properties: {
          id: ref('Slug'),
          name: { type: 'string', minLength: 1, maxLength: 120 },
          rootPath: ref('AbsolutePath'),
        },
      },
      CreateProjectInput: {
        type: 'object',
        additionalProperties: false,
        required: ['workspaceId', 'slug', 'title'],
        properties: {
          workspaceId: ref('Slug'),
          slug: ref('Slug'),
          title: { type: 'string', minLength: 1, maxLength: 200 },
          prd: { type: 'string', maxLength: 1_000_000, default: '' },
          state: { type: 'string', enum: ['draft', 'ready'], default: 'draft' },
          actor: { type: ['string', 'null'], maxLength: 200, default: null },
        },
      },
      UpdateProjectInput: {
        type: 'object',
        additionalProperties: false,
        required: ['expectedRevision'],
        properties: {
          title: { type: ['string', 'null'], minLength: 1, maxLength: 200, default: null },
          state: { type: ['string', 'null'], enum: ['draft', 'ready', null], default: null },
          expectedRevision: { type: 'integer', minimum: 1 },
          actor: { type: ['string', 'null'], maxLength: 200, default: null },
        },
      },
      ReplacePrdInput: {
        type: 'object',
        additionalProperties: false,
        required: ['prd', 'expectedRevision'],
        properties: {
          prd: { type: 'string', maxLength: 1_000_000 },
          expectedRevision: { type: 'integer', minimum: 1 },
          actor: { type: ['string', 'null'], maxLength: 200, default: null },
        },
      },
      PutContextInput: {
        type: 'object',
        additionalProperties: false,
        required: ['body'],
        properties: {
          body: { type: 'string', maxLength: 1_000_000 },
          expectedRevision: { type: ['integer', 'null'], minimum: 1, default: null },
          actor: { type: ['string', 'null'], maxLength: 200, default: null },
        },
      },
      CreateTaskInput: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          parentId: { type: ['string', 'null'], format: 'uuid', default: null },
          title: { type: 'string', minLength: 1, maxLength: 300 },
          body: { type: ['string', 'null'], maxLength: 1_000_000, default: null },
          actor: { type: ['string', 'null'], maxLength: 200, default: null },
        },
      },
      UpdateTaskInput: {
        type: 'object',
        additionalProperties: false,
        required: ['expectedRevision'],
        properties: {
          title: { type: ['string', 'null'], minLength: 1, maxLength: 300, default: null },
          body: { type: ['string', 'null'], maxLength: 1_000_000 },
          expectedRevision: { type: 'integer', minimum: 1 },
          actor: { type: ['string', 'null'], maxLength: 200, default: null },
        },
      },
      ClaimInput: {
        type: 'object',
        additionalProperties: false,
        required: ['agentId'],
        properties: {
          agentId: { type: 'string', minLength: 1, maxLength: 200 },
          leaseSeconds: { type: 'integer', minimum: 60, maximum: 86_400, default: 1_800 },
        },
      },
      ReleaseInput: {
        type: 'object',
        additionalProperties: false,
        required: ['agentId'],
        properties: {
          agentId: { type: 'string', minLength: 1, maxLength: 200 },
          note: { type: ['string', 'null'], maxLength: 500, default: null },
        },
      },
      CompleteWorkInput: {
        type: 'object',
        additionalProperties: false,
        required: ['agentId', 'expectedRevision', 'summary'],
        properties: {
          agentId: { type: 'string', minLength: 1, maxLength: 200 },
          expectedRevision: { type: 'integer', minimum: 1 },
          summary: { type: 'string', minLength: 1, maxLength: 4_000 },
          artifacts: { type: 'array', maxItems: 20, default: [], items: ref('Artifact') },
        },
      },
      DirectoryInput: {
        type: 'object',
        additionalProperties: false,
        required: ['directory'],
        properties: { directory: ref('AbsolutePath') },
      },
      PathResult: {
        type: 'object',
        required: ['path'],
        properties: { path: ref('AbsolutePath') },
      },
      Health: {
        type: 'object',
        required: ['status', 'version'],
        properties: {
          status: { type: 'string', const: 'ok' },
          version: { type: 'string', const: '0.1.0' },
        },
      },
      JsonRpcRequest: {
        type: 'object',
        required: ['jsonrpc', 'method'],
        properties: {
          jsonrpc: { type: 'string', const: '2.0' },
          id: { type: ['string', 'number', 'null'] },
          method: { type: 'string' },
          params: { type: 'object' },
        },
      },
      SuccessEnvelope: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: {},
          meta: {
            type: 'object',
            required: ['schemaVersion'],
            properties: { schemaVersion: { type: 'integer', const: 1 } },
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'retryable'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'bad_request',
                  'unauthorized',
                  'not_found',
                  'conflict',
                  'revision_conflict',
                  'invalid_state',
                  'payload_too_large',
                  'internal',
                ],
              },
              message: { type: 'string' },
              retryable: { type: 'boolean' },
              details: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
  },
};
