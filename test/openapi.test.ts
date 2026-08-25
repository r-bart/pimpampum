import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/openapi.js';

const expectedOperations = [
  'get /health',
  'get /openapi.json',
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
});
