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
  'get /api/v1/settings/sync',
  'put /api/v1/settings/sync',
  'delete /api/v1/settings/sync',
  'post /api/v1/settings/sync/reconcile',
  'post /api/v1/settings/sync/pause',
  'post /api/v1/settings/sync/resume',
  'get /api/v1/settings/sync/conflicts',
  'post /api/v1/settings/sync/conflicts/{conflictId}/resolve',
  'get /api/v1/workspaces',
  'post /api/v1/workspaces',
  'post /api/v1/workspaces/resolve',
  'get /api/v1/workspaces/{workspaceId}/context',
  'get /api/v1/workspaces/{workspaceId}/context/{name}',
  'put /api/v1/workspaces/{workspaceId}/context/{name}',
  'get /api/v1/workspaces/{workspaceId}/context/{name}/body',
  'get /api/v1/projects',
  'post /api/v1/projects',
  'get /api/v1/projects/{projectId}',
  'patch /api/v1/projects/{projectId}',
  'get /api/v1/projects/{projectId}/manifest',
  'get /api/v1/projects/{projectId}/completion',
  'post /api/v1/projects/{projectId}/complete',
  'post /api/v1/projects/{projectId}/cancel',
  'get /api/v1/projects/{projectId}/specs',
  'post /api/v1/projects/{projectId}/specs',
  'get /api/v1/projects/{projectId}/context',
  'get /api/v1/projects/{projectId}/context/{name}',
  'put /api/v1/projects/{projectId}/context/{name}',
  'get /api/v1/projects/{projectId}/context/{name}/body',
  'get /api/v1/specs/{specId}',
  'patch /api/v1/specs/{specId}',
  'get /api/v1/specs/{specId}/manifest',
  'get /api/v1/specs/{specId}/body',
  'get /api/v1/specs/{specId}/completion',
  'post /api/v1/specs/{specId}/cancel',
  'get /api/v1/specs/{specId}/tasks',
  'post /api/v1/specs/{specId}/tasks',
  'get /api/v1/tasks/{taskId}',
  'patch /api/v1/tasks/{taskId}',
  'get /api/v1/tasks/{taskId}/manifest',
  'get /api/v1/tasks/{taskId}/body',
  'get /api/v1/tasks/{taskId}/completion',
  'post /api/v1/tasks/{taskId}/cancel',
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

describe('OpenAPI v2 contract', () => {
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
          ? openApiDocument.components.schemas[name]
          : openApiDocument.components.responses[name ?? ''],
      ).toBeDefined();
    }
    expect(openApiDocument.security).toEqual([{ bearerAuth: [] }]);
    expect(
      (openApiDocument.paths['/health']?.get as { security: unknown } | undefined)?.security,
    ).toEqual([]);
    expect(
      (openApiDocument.paths['/openapi.json']?.get as { security: unknown } | undefined)?.security,
    ).toEqual([]);
  });

  it('publishes the canonical hierarchy, lifecycles, scoped Context, and executable targets', () => {
    const schemas = openApiDocument.components.schemas;
    expect(schemas.ProjectState?.enum).toEqual(['draft', 'open', 'paused', 'done', 'cancelled']);
    expect(schemas.SpecState?.enum).toEqual(['draft', 'ready', 'done', 'cancelled']);
    expect(schemas.TaskState?.enum).toEqual(['open', 'done', 'cancelled']);
    expect(schemas.TargetType?.enum).toEqual(['spec', 'task']);
    expect(schemas.ContextOwnerType?.enum).toEqual(['workspace', 'project']);
    expect(schemas).toHaveProperty('Spec');
    expect(schemas).toHaveProperty('SpecManifest');
    expect(schemas).not.toHaveProperty('ReplacePrdInput');

    expect(openApiDocument.paths).toHaveProperty('/api/v1/projects/{projectId}/specs');
    expect(openApiDocument.paths).toHaveProperty('/api/v1/specs/{specId}/body');
    expect(openApiDocument.paths).toHaveProperty('/api/v1/specs/{specId}/tasks');
    expect(openApiDocument.paths).toHaveProperty('/api/v1/workspaces/{workspaceId}/context');
    expect(openApiDocument.paths).toHaveProperty('/api/v1/projects/{projectId}/context');
    expect(openApiDocument.paths).not.toHaveProperty('/api/v1/projects/{projectId}/prd');
    expect(openApiDocument.paths).not.toHaveProperty('/api/v1/projects/{projectId}/tasks');
  });

  it('separates complete resources from bounded manifests and types every manifest page', () => {
    const schemas = openApiDocument.components.schemas;
    const schema = (name: string) =>
      schemas[name] as {
        additionalProperties: boolean;
        required: string[];
        properties: Record<string, { $ref?: string; items?: { $ref?: string } }>;
        allOf?: unknown;
      };

    const boundedPairs = [
      {
        resource: 'Project',
        manifest: 'ProjectManifest',
        unbounded: ['completionSummary', 'artifacts'],
        bounded: ['artifactCount', 'hasCompletion', 'specCount'],
      },
      {
        resource: 'Spec',
        manifest: 'SpecManifest',
        unbounded: ['body', 'completionSummary', 'artifacts'],
        bounded: ['bodySizeBytes', 'artifactCount', 'hasCompletion', 'taskCount'],
      },
      {
        resource: 'Task',
        manifest: 'TaskManifest',
        unbounded: ['body', 'completionSummary', 'artifacts'],
        bounded: ['bodySizeBytes', 'artifactCount', 'hasCompletion', 'subtaskCount'],
      },
      {
        resource: 'ContextDocument',
        manifest: 'ContextManifest',
        unbounded: ['body'],
        bounded: ['sizeBytes'],
      },
    ] as const;

    for (const { resource, manifest, unbounded, bounded } of boundedPairs) {
      const completeSchema = schema(resource);
      const manifestSchema = schema(manifest);
      expect(completeSchema.additionalProperties).toBe(false);
      expect(manifestSchema.additionalProperties).toBe(false);
      expect(manifestSchema.allOf).toBeUndefined();
      for (const field of unbounded) {
        expect(completeSchema.required).toContain(field);
        expect(completeSchema.properties).toHaveProperty(field);
        expect(manifestSchema.required).not.toContain(field);
        expect(manifestSchema.properties).not.toHaveProperty(field);
      }
      for (const field of bounded) {
        expect(manifestSchema.required).toContain(field);
        expect(manifestSchema.properties).toHaveProperty(field);
      }
    }

    const typedPages = {
      ProjectManifestPage: 'ProjectManifest',
      SpecManifestPage: 'SpecManifest',
      TaskManifestPage: 'TaskManifest',
      ContextManifestPage: 'ContextManifest',
    } as const;
    for (const [pageName, itemName] of Object.entries(typedPages)) {
      const page = schema(pageName);
      expect(page.required).toEqual(['items', 'limit', 'offset', 'hasMore']);
      expect(page.properties.items?.items).toEqual({
        $ref: `#/components/schemas/${itemName}`,
      });
    }

    const successfulDataRef = (path: string, method: 'get') => {
      const operation = openApiDocument.paths[path]?.[method] as {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { allOf: Array<{ properties?: { data?: { $ref?: string } } }> };
              };
            };
          };
        };
      };
      return operation.responses['200'].content['application/json'].schema.allOf[1]?.properties
        ?.data?.$ref;
    };
    expect(successfulDataRef('/api/v1/projects', 'get')).toBe(
      '#/components/schemas/ProjectManifestPage',
    );
    expect(successfulDataRef('/api/v1/projects/{projectId}/specs', 'get')).toBe(
      '#/components/schemas/SpecManifestPage',
    );
    expect(successfulDataRef('/api/v1/specs/{specId}/tasks', 'get')).toBe(
      '#/components/schemas/TaskManifestPage',
    );
    expect(successfulDataRef('/api/v1/workspaces/{workspaceId}/context', 'get')).toBe(
      '#/components/schemas/ContextManifestPage',
    );
    expect(successfulDataRef('/api/v1/projects/{projectId}/context', 'get')).toBe(
      '#/components/schemas/ContextManifestPage',
    );
    expect(successfulDataRef('/api/v1/projects/{projectId}', 'get')).toBe(
      '#/components/schemas/ProjectManifest',
    );
    expect(successfulDataRef('/api/v1/specs/{specId}', 'get')).toBe(
      '#/components/schemas/SpecManifest',
    );
    expect(successfulDataRef('/api/v1/tasks/{taskId}', 'get')).toBe(
      '#/components/schemas/TaskManifest',
    );
    expect(successfulDataRef('/api/v1/workspaces/{workspaceId}/context/{name}', 'get')).toBe(
      '#/components/schemas/ContextManifest',
    );

    const workBundle = schema('WorkBundle');
    expect(workBundle.properties.workspaceContext).toEqual({
      $ref: '#/components/schemas/WorkContextManifestPage',
    });
    expect(workBundle.properties.projectContext).toEqual({
      $ref: '#/components/schemas/WorkContextManifestPage',
    });
    expect(schema('WorkContextManifestPage').required).toEqual(['items', 'hasMore']);
    expect(new Set(schema('WorkItem').required).size).toBe(schema('WorkItem').required.length);
    expect(schema('ActivityEvent').required).toContain('specId');
  });

  it('documents overview schema version 2 with Project, Spec, Task, and Claim rollups', () => {
    const schemas = openApiDocument.components.schemas;
    const successEnvelope = schemas.OverviewSuccessEnvelope as {
      properties: { meta: { properties: { schemaVersion: unknown } } };
    };
    expect(successEnvelope.properties.meta.properties.schemaVersion).toEqual({
      type: 'integer',
      const: 2,
    });

    expect(schemas.OverviewCounts?.required).toEqual([
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
    ]);
    expect(schemas.OverviewProject?.required).toContain('specCount');
    expect(schemas.OverviewActiveWork?.required).toEqual(
      expect.arrayContaining(['targetType', 'specId', 'specTitle', 'taskId', 'taskTitle']),
    );

    const overview = openApiDocument.paths['/api/v1/overview'] as {
      get: { operationId: string; responses: Record<string, unknown> };
    };
    expect(overview.get.operationId).toBe('getOverview');
    expect(overview.get.responses['200']).toEqual({
      description: 'Success',
      content: {
        'application/json': {
          schema: {
            allOf: [
              { $ref: '#/components/schemas/OverviewSuccessEnvelope' },
              { properties: { data: { $ref: '#/components/schemas/Overview' } } },
            ],
          },
        },
      },
    });
  });
});
