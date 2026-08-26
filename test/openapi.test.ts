import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/openapi.js';

const expectedOperations = [
  'get /health',
  'get /openapi.json',
  'get /api/v1/overview',
  'get /api/v1/settings/backup',
  'put /api/v1/settings/backup',
  'delete /api/v1/settings/backup',
  'post /api/v1/settings/backup/retry',
  'get /api/v1/workspaces',
  'post /api/v1/workspaces',
  'post /api/v1/workspaces/resolve',
  'get /api/v1/projects',
  'post /api/v1/projects',
  'get /api/v1/projects/{projectId}',
  'patch /api/v1/projects/{projectId}',
  'get /api/v1/projects/{projectId}/manifest',
  'get /api/v1/projects/{projectId}/prd',
  'put /api/v1/projects/{projectId}/prd',
  'get /api/v1/projects/{projectId}/completion',
  'get /api/v1/projects/{projectId}/context',
  'get /api/v1/projects/{projectId}/context/{name}',
  'put /api/v1/projects/{projectId}/context/{name}',
  'get /api/v1/projects/{projectId}/context/{name}/body',
  'get /api/v1/projects/{projectId}/tasks',
  'post /api/v1/projects/{projectId}/tasks',
  'get /api/v1/tasks/{taskId}',
  'patch /api/v1/tasks/{taskId}',
  'get /api/v1/tasks/{taskId}/manifest',
  'get /api/v1/tasks/{taskId}/body',
  'get /api/v1/tasks/{taskId}/completion',
  'get /api/v1/work',
  'put /api/v1/work/{targetType}/{targetId}/claim',
  'patch /api/v1/work/{targetType}/{targetId}/claim',
  'delete /api/v1/work/{targetType}/{targetId}/claim',
  'post /api/v1/work/{targetType}/{targetId}/complete',
  'get /api/v1/projects/{projectId}/activity',
  'post /api/v1/admin/backup',
  'post /api/v1/admin/export',
  'post /mcp',
] as const;

function objectEntries(value: object): Array<[string, unknown]> {
  return Object.entries(value);
}

function collectRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (typeof value !== 'object' || value === null) return [];
  return objectEntries(value).flatMap(([key, child]) =>
    key === '$ref' && typeof child === 'string' ? [child] : collectRefs(child),
  );
}

describe('OpenAPI contract', () => {
  it('documents every live HTTP operation with unique agent-readable metadata', () => {
    const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const operations = objectEntries(openApiDocument.paths).flatMap(([path, pathItem]) =>
      objectEntries(pathItem as object)
        .filter(([method]) => methods.has(method))
        .map(([method, operation]) => ({
          key: `${method} ${path}`,
          operation: operation as {
            operationId: string;
            summary: string;
            tags: string[];
            responses: object;
          },
        })),
    );

    expect(operations.map(({ key }) => key)).toEqual(expectedOperations);
    expect(new Set(operations.map(({ operation }) => operation.operationId)).size).toBe(
      operations.length,
    );
    for (const { operation } of operations) {
      expect(operation.operationId).toBeTruthy();
      expect(operation.summary).toBeTruthy();
      expect(operation.tags).not.toHaveLength(0);
      expect(Object.keys(operation.responses)).not.toHaveLength(0);
    }
  });

  it('keeps every local component reference resolvable and security explicit', () => {
    const references = collectRefs(openApiDocument);
    for (const reference of references) {
      expect(reference).toMatch(/^#\/components\/(schemas|responses)\/[A-Za-z]+$/);
      const [, , section, name] = reference.split('/');
      expect(
        name && section === 'schemas'
          ? openApiDocument.components.schemas[
              name as keyof typeof openApiDocument.components.schemas
            ]
          : openApiDocument.components.responses[
              name as keyof typeof openApiDocument.components.responses
            ],
      ).toBeDefined();
    }
    expect(openApiDocument.security).toEqual([{ bearerAuth: [] }]);
    const health = openApiDocument.paths['/health'];
    const contract = openApiDocument.paths['/openapi.json'];
    expect(health).toBeDefined();
    expect(contract).toBeDefined();
    expect((health?.get as { security: unknown } | undefined)?.security).toEqual([]);
    expect((contract?.get as { security: unknown } | undefined)?.security).toEqual([]);
  });

  it('documents the exact bounded overview response contract', () => {
    const overviewPath = openApiDocument.paths['/api/v1/overview'] as {
      get: { operationId: string; responses: Record<string, unknown> };
    };
    const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });

    expect(overviewPath.get.operationId).toBe('getOverview');
    expect(overviewPath.get.responses['200']).toEqual({
      description: 'Success',
      content: {
        'application/json': {
          schema: {
            allOf: [schemaRef('SuccessEnvelope'), { properties: { data: schemaRef('Overview') } }],
          },
        },
      },
    });
    expect({
      OverviewDaemon: openApiDocument.components.schemas.OverviewDaemon,
      OverviewCounts: openApiDocument.components.schemas.OverviewCounts,
      OverviewWorkspace: openApiDocument.components.schemas.OverviewWorkspace,
      OverviewProject: openApiDocument.components.schemas.OverviewProject,
      OverviewActiveWork: openApiDocument.components.schemas.OverviewActiveWork,
      Overview: openApiDocument.components.schemas.Overview,
    }).toEqual({
      OverviewDaemon: {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'startedAt', 'uptimeSeconds'],
        properties: {
          version: { type: 'string', minLength: 1 },
          startedAt: schemaRef('Timestamp'),
          uptimeSeconds: { type: 'integer', minimum: 0 },
        },
      },
      OverviewCounts: {
        type: 'object',
        additionalProperties: false,
        required: [
          'workspaces',
          'projects',
          'draftProjects',
          'readyProjects',
          'completedProjects',
          'openTasks',
          'completedTasks',
          'activeClaims',
          'availableWork',
        ],
        properties: {
          workspaces: { type: 'integer', minimum: 0 },
          projects: { type: 'integer', minimum: 0 },
          draftProjects: { type: 'integer', minimum: 0 },
          readyProjects: { type: 'integer', minimum: 0 },
          completedProjects: { type: 'integer', minimum: 0 },
          openTasks: { type: 'integer', minimum: 0 },
          completedTasks: { type: 'integer', minimum: 0 },
          activeClaims: { type: 'integer', minimum: 0 },
          availableWork: { type: 'integer', minimum: 0 },
        },
      },
      OverviewWorkspace: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'rootPath'],
        properties: {
          id: schemaRef('Slug'),
          name: { type: 'string', minLength: 1, maxLength: 120 },
          rootPath: schemaRef('AbsolutePath'),
        },
      },
      OverviewProject: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'workspace',
          'slug',
          'title',
          'lifecycleState',
          'status',
          'openTaskCount',
          'completedTaskCount',
          'activeClaimCount',
          'availableWorkCount',
          'updatedAt',
        ],
        properties: {
          id: { type: 'string', minLength: 1 },
          workspace: schemaRef('OverviewWorkspace'),
          slug: schemaRef('Slug'),
          title: { type: 'string', minLength: 1, maxLength: 200 },
          lifecycleState: { type: 'string', enum: ['draft', 'ready', 'done'] },
          status: { type: 'string', enum: ['active', 'available', 'complete', 'draft'] },
          openTaskCount: { type: 'integer', minimum: 0 },
          completedTaskCount: { type: 'integer', minimum: 0 },
          activeClaimCount: { type: 'integer', minimum: 0 },
          availableWorkCount: { type: 'integer', minimum: 0 },
          updatedAt: schemaRef('Timestamp'),
        },
      },
      OverviewActiveWork: {
        type: 'object',
        additionalProperties: false,
        required: [
          'targetType',
          'targetId',
          'workspaceId',
          'projectId',
          'projectTitle',
          'taskId',
          'taskTitle',
          'agentId',
          'expiresAt',
        ],
        properties: {
          targetType: { type: 'string', enum: ['project', 'task'] },
          targetId: { type: 'string', minLength: 1 },
          workspaceId: schemaRef('Slug'),
          projectId: { type: 'string', minLength: 1 },
          projectTitle: { type: 'string', minLength: 1, maxLength: 200 },
          taskId: { type: ['string', 'null'], minLength: 1 },
          taskTitle: { type: ['string', 'null'], maxLength: 300 },
          agentId: { type: 'string', minLength: 1, maxLength: 200 },
          expiresAt: schemaRef('Timestamp'),
        },
      },
      Overview: {
        type: 'object',
        additionalProperties: false,
        required: [
          'daemon',
          'generatedAt',
          'status',
          'counts',
          'projects',
          'projectsTruncated',
          'activeWork',
          'activeWorkTruncated',
        ],
        properties: {
          daemon: schemaRef('OverviewDaemon'),
          generatedAt: schemaRef('Timestamp'),
          status: {
            type: 'string',
            enum: ['active', 'available', 'complete', 'draft', 'empty'],
          },
          counts: schemaRef('OverviewCounts'),
          projects: {
            type: 'array',
            maxItems: 500,
            items: schemaRef('OverviewProject'),
          },
          projectsTruncated: { type: 'boolean' },
          activeWork: {
            type: 'array',
            maxItems: 500,
            items: schemaRef('OverviewActiveWork'),
          },
          activeWorkTruncated: { type: 'boolean' },
        },
      },
    });
  });
});
