import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { AutomaticBackupController } from '../src/automaticBackup.js';
import { openDatabase } from '../src/db.js';
import { ERROR_CODES } from '../src/errors.js';
import { createHttpApp } from '../src/http.js';
import { generateComponentSchemas, openApiDocument } from '../src/openapi.js';
import { PimpampumStore } from '../src/store.js';
import { SyncController } from '../src/syncController.js';

type Schema = Record<string, unknown>;

const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);

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
  'patch /api/v1/specs/{specId}',
  'get /api/v1/specs/{specId}/manifest',
  'get /api/v1/specs/{specId}/body',
  'get /api/v1/specs/{specId}/completion',
  'post /api/v1/specs/{specId}/cancel',
  'get /api/v1/specs/{specId}/tasks',
  'post /api/v1/specs/{specId}/tasks',
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

function documentedOperations(): string[] {
  return objectEntries(openApiDocument.paths).flatMap(([path, pathItem]) =>
    objectEntries(pathItem as object)
      .filter(([method]) => httpMethods.has(method))
      .map(([method]) => `${method} ${path}`),
  );
}

/**
 * Validates a value against the JSON Schema subset `z.toJSONSchema` emits for
 * this contract. It resolves `$ref`s into `components.schemas` and reports
 * every violation with its path, so a drift names the field that moved.
 */
function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const components = openApiDocument.components.schemas;
  if (typeof schema.$ref === 'string') {
    const target = components[schema.$ref.split('/').pop() ?? ''];
    return target ? validate(target, value, path) : [`${path}: unresolved ${schema.$ref}`];
  }
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${path}: ${message}`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    fail(`expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(`expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((branch) => validate(branch as Schema, value).length === 0);
    if (matches.length === 0) fail('matched no anyOf branch');
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validate(branch as Schema, value).length === 0);
    if (matches.length !== 1) fail(`matched ${String(matches.length)} oneOf branches`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) errors.push(...validate(branch as Schema, value, path));
  }
  if (typeof schema.not === 'object' && schema.not !== null) {
    if (validate(schema.not as Schema, value).length === 0) fail('matched the not schema');
  }
  const type = schema.type;
  if (typeof type === 'string') {
    const typeMatches: Record<string, (candidate: unknown) => boolean> = {
      null: (candidate) => candidate === null,
      boolean: (candidate) => typeof candidate === 'boolean',
      string: (candidate) => typeof candidate === 'string',
      number: (candidate) => typeof candidate === 'number',
      integer: (candidate) => Number.isInteger(candidate),
      array: (candidate) => Array.isArray(candidate),
      object: (candidate) =>
        typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate),
    };
    const matches = typeMatches[type];
    if (!matches) fail(`unsupported type ${type}`);
    else if (!matches(value)) {
      fail(`expected ${type}, got ${JSON.stringify(value)}`);
      return errors;
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(`shorter than ${String(schema.minLength)}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      fail(`longer than ${String(schema.maxLength)}`);
    }
    if (typeof schema.pattern === 'string') {
      let pattern: RegExp;
      try {
        pattern = new RegExp(schema.pattern, 'u');
      } catch {
        pattern = new RegExp(schema.pattern);
      }
      if (!pattern.test(value)) fail(`does not match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail('below minimum');
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail('above maximum');
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      fail('not above exclusiveMinimum');
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      fail('too few items');
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      fail('too many items');
    }
    if (typeof schema.items === 'object' && schema.items !== null) {
      value.forEach((item, index) =>
        errors.push(...validate(schema.items as Schema, item, `${path}[${String(index)}]`)),
      );
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) fail(`missing required ${key}`);
    }
    for (const [key, child] of Object.entries(record)) {
      const property = properties[key];
      if (property) {
        errors.push(...validate(property, child, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        fail(`unexpected property ${key}`);
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties as Schema, child, `${path}.${key}`));
      }
      if (typeof schema.propertyNames === 'object' && schema.propertyNames !== null) {
        errors.push(...validate(schema.propertyNames as Schema, key, `${path}[key ${key}]`));
      }
    }
  }
  return errors;
}

const conforms = (name: string, value: unknown) =>
  validate({ $ref: `#/components/schemas/${name}` }, value);

describe('OpenAPI v2 contract', () => {
  const token = 'openapi-contract-token'.repeat(2);
  const authorization = { authorization: `Bearer ${token}` };
  let store: PimpampumStore;
  let automaticBackup: AutomaticBackupController;
  let sync: SyncController;
  let closeMcp: () => Promise<void>;
  let temporaryDirectory: string;
  let app: ReturnType<typeof createHttpApp>['app'];

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pimpampum-openapi-'));
    store = new PimpampumStore(openDatabase(':memory:'), () => {
      automaticBackup.markDirty();
      sync.markDirty();
    });
    automaticBackup = new AutomaticBackupController({
      settingsPath: join(temporaryDirectory, 'settings.json'),
      snapshotter: (destination) => store.backupLatest(destination),
    });
    sync = new SyncController({
      settingsPath: join(temporaryDirectory, 'sync.json'),
      snapshotter: () => store.exportSyncState(),
      importer: (state) => store.applySyncState(state),
    });
    const config: RuntimeConfig = {
      host: '127.0.0.1',
      port: 7337,
      dataDirectory: temporaryDirectory,
      databasePath: ':memory:',
      token,
      baseUrl: 'http://127.0.0.1:7337',
    };
    const created = createHttpApp(store, config, console, Date.now, automaticBackup, sync);
    app = created.app;
    closeMcp = created.close;
  });

  afterEach(async () => {
    await closeMcp();
    await automaticBackup.close();
    await sync.close();
    store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('documents exactly the routes the Express router serves', () => {
    const stack = (
      app as unknown as {
        router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      }
    ).router.stack;
    const served = new Set<string>();
    for (const layer of stack) {
      if (!layer.route) continue;
      const path = layer.route.path.replaceAll(/:([A-Za-z]+)/gu, '{$1}');
      for (const method of Object.keys(layer.route.methods)) served.add(`${method} ${path}`);
    }
    const documented = documentedOperations();
    expect([...served].sort()).toEqual([...documented].sort());
    expect(documented).toEqual(expectedOperations);
    expect(documented).not.toContain('get /api/v1/projects/{projectId}');
    expect(documented).not.toContain('get /api/v1/specs/{specId}');
    expect(documented).not.toContain('get /api/v1/tasks/{taskId}');
  });

  it('documents every operation with unique agent-readable metadata', () => {
    const operations = objectEntries(openApiDocument.paths).flatMap(([path, pathItem]) =>
      objectEntries(pathItem as object)
        .filter(([method]) => httpMethods.has(method))
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
    expect(references.length).toBeGreaterThan(50);
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

  it('generates components from the Zod catalogue and fixes the documented drift', () => {
    const schemas = openApiDocument.components.schemas;
    expect(generateComponentSchemas()).toEqual(schemas);
    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema, name).not.toHaveProperty('$schema');
      expect(schema, name).not.toHaveProperty('$id');
    }
    expect(schemas).not.toHaveProperty('SyncConflict');

    const property = (name: string, key: string): Schema =>
      ((schemas[name] ?? {}).properties as Record<string, Schema>)[key] ?? {};
    // `unavailable` is minted by clients when the daemon does not answer; the daemon never returns it.
    expect(property('Error', 'code').enum).toEqual(
      ERROR_CODES.filter((code) => code !== 'unavailable'),
    );
    expect(property('AutomaticBackupStatus', 'state').enum).toEqual([
      'disabled',
      'pending',
      'healthy',
      'error',
    ]);
    expect(schemas.AutomaticBackupStatus?.required).toContain('error');
    expect(schemas.AutomaticBackupStatus?.required).not.toContain('lastError');
    const actor = property('CreateProjectInput', 'actor');
    expect(actor.anyOf).toHaveLength(2);
    expect((actor.anyOf as Schema[])[0]).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 200,
    });
    expect(property('Workspace', 'rootPath')).not.toHaveProperty('minLength');
    expect(schemas.UpdateProjectInput?.anyOf).toHaveLength(2);
    expect(schemas.UpdateSpecInput?.anyOf).toHaveLength(3);
    expect(schemas.UpdateTaskInput?.anyOf).toHaveLength(2);
    expect(property('SyncConflictManifest', 'id').pattern).toBe('^[a-f0-9]{64}$');
    const resolve = openApiDocument.paths['/api/v1/settings/sync/conflicts/{conflictId}/resolve']
      ?.post as { parameters: Array<{ schema: Schema }> };
    expect(resolve.parameters[0]).toMatchObject({ schema: { pattern: '^[a-f0-9]{64}$' } });
    const listProjects = openApiDocument.paths['/api/v1/projects']?.get as {
      parameters: Array<{ name: string; schema: Schema }>;
    };
    expect(listProjects.parameters.find(({ name }) => name === 'limit')?.schema).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 50,
    });
    for (const name of [
      'Project',
      'ProjectManifest',
      'Spec',
      'SpecManifest',
      'Task',
      'TaskManifest',
    ]) {
      expect(schemas[name]?.required, name).toContain('cancelledAt');
    }
    expect(schemas.Health?.required).toEqual(['status', 'version', 'ready']);
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
    expect(successfulDataRef('/api/v1/projects/{projectId}/manifest', 'get')).toBe(
      '#/components/schemas/ProjectManifest',
    );
    expect(successfulDataRef('/api/v1/specs/{specId}/manifest', 'get')).toBe(
      '#/components/schemas/SpecManifest',
    );
    expect(successfulDataRef('/api/v1/tasks/{taskId}/manifest', 'get')).toBe(
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
    expect(successEnvelope.properties.meta.properties.schemaVersion).toMatchObject({ const: 2 });

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
    expect(schemas.WorkItem?.required).not.toContain('projectLifecycleState');
    expect(schemas.OverviewSpec?.required).toContain('projectLifecycleState');

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

  it('validates a real body of every contract type against the generated schema', async () => {
    const backupDirectory = join(temporaryDirectory, 'backups');
    const sharedDirectory = join(temporaryDirectory, 'shared');
    mkdirSync(backupDirectory);
    mkdirSync(sharedDirectory);
    const data = async (
      response: request.Test,
      component: string,
      envelope = 'SuccessEnvelope',
    ): Promise<Record<string, never>> => {
      const { body } = await response;
      expect(validate({ $ref: `#/components/schemas/${envelope}` }, body)).toEqual([]);
      const items: unknown[] = Array.isArray(body.data) ? body.data : [body.data];
      for (const item of items) expect(conforms(component, item)).toEqual([]);
      return body.data as Record<string, never>;
    };
    const input = (component: string, body: unknown) => {
      expect(conforms(component, body)).toEqual([]);
      return body as object;
    };

    const health = await request(app).get('/health').expect(200);
    expect(conforms('Health', health.body)).toEqual([]);
    const unauthorized = await request(app).get('/api/v1/workspaces').expect(401);
    expect(conforms('ErrorEnvelope', unauthorized.body)).toEqual([]);
    const missing = await request(app).get('/nowhere').expect(404);
    expect(conforms('ErrorEnvelope', missing.body)).toEqual([]);

    const registerInput = input('RegisterWorkspaceInput', {
      id: 'contract',
      name: 'Contract',
      rootPath: temporaryDirectory,
    });
    const workspace = await data(
      request(app).post('/api/v1/workspaces').set(authorization).send(registerInput).expect(201),
      'Workspace',
    );
    await data(
      request(app)
        .post('/api/v1/workspaces/resolve')
        .set(authorization)
        .send(input('ResolveWorkspaceInput', { path: temporaryDirectory })),
      'Workspace',
    );
    expect(
      conforms('Workspace', { ...workspace, rootPath: '' }),
      'synced Workspaces without a local root',
    ).toEqual([]);

    const project = await data(
      request(app)
        .post('/api/v1/projects')
        .set(authorization)
        .send(input('CreateProjectInput', { workspaceId: 'contract', slug: 'alpha', title: 'A' }))
        .expect(201),
      'Project',
    );
    expect(conforms('UpdateProjectInput', { expectedRevision: 1 })).not.toEqual([]);
    expect(
      conforms('UpdateProjectInput', { title: null, state: null, expectedRevision: 1 }),
    ).not.toEqual([]);
    expect(conforms('UpdateTaskInput', { body: null, expectedRevision: 1 })).toEqual([]);
    const spec = await data(
      request(app)
        .post(`/api/v1/projects/${project.id}/specs`)
        .set(authorization)
        .send(input('CreateSpecInput', { slug: 'alpha', title: 'A', body: '# Alpha 😀' }))
        .expect(201),
      'Spec',
    );
    const readySpec = await data(
      request(app)
        .patch(`/api/v1/specs/${spec.id}`)
        .set(authorization)
        .send(input('UpdateSpecInput', { state: 'ready', expectedRevision: spec.revision })),
      'Spec',
    );
    const openProject = await data(
      request(app)
        .patch(`/api/v1/projects/${project.id}`)
        .set(authorization)
        .send(input('UpdateProjectInput', { state: 'open', expectedRevision: project.revision })),
      'Project',
    );
    const task = await data(
      request(app)
        .post(`/api/v1/specs/${spec.id}/tasks`)
        .set(authorization)
        .send(input('CreateTaskInput', { title: 'Task', body: 'Body' }))
        .expect(201),
      'Task',
    );
    const updatedTask = await data(
      request(app)
        .patch(`/api/v1/tasks/${task.id}`)
        .set(authorization)
        .send(input('UpdateTaskInput', { title: 'Task two', expectedRevision: task.revision })),
      'Task',
    );
    await data(
      request(app)
        .put(`/api/v1/projects/${project.id}/context/brief`)
        .set(authorization)
        .send(input('PutContextInput', { body: '# Brief' })),
      'ContextDocument',
    );
    await data(
      request(app)
        .put('/api/v1/workspaces/contract/context/brief')
        .set(authorization)
        .send(input('PutContextInput', { body: '# Workspace brief' })),
      'ContextDocument',
    );

    await data(request(app).get('/api/v1/workspaces').set(authorization), 'Workspace');
    await data(
      request(app).get(`/api/v1/projects/${project.id}/manifest`).set(authorization),
      'ProjectManifest',
    );
    await data(
      request(app).get(`/api/v1/specs/${spec.id}/manifest`).set(authorization),
      'SpecManifest',
    );
    await data(
      request(app).get(`/api/v1/tasks/${task.id}/manifest`).set(authorization),
      'TaskManifest',
    );
    await data(request(app).get('/api/v1/projects').set(authorization), 'ProjectManifestPage');
    await data(
      request(app).get(`/api/v1/projects/${project.id}/specs`).set(authorization),
      'SpecManifestPage',
    );
    await data(
      request(app).get(`/api/v1/specs/${spec.id}/tasks`).set(authorization),
      'TaskManifestPage',
    );
    await data(
      request(app).get(`/api/v1/projects/${project.id}/context`).set(authorization),
      'ContextManifestPage',
    );
    await data(
      request(app).get(`/api/v1/projects/${project.id}/context/brief`).set(authorization),
      'ContextManifest',
    );
    await data(
      request(app).get(`/api/v1/projects/${project.id}/context/brief/body`).set(authorization),
      'MarkdownPage',
    );
    await data(
      request(app).get(`/api/v1/specs/${spec.id}/body?limitCodeUnits=8`).set(authorization),
      'MarkdownPage',
    );
    await data(
      request(app).get(`/api/v1/tasks/${task.id}/body`).set(authorization),
      'MarkdownPage',
    );
    await data(
      request(app).get(`/api/v1/projects/${project.id}/completion`).set(authorization),
      'CompletionDetails',
    );
    const workItems = await data(request(app).get('/api/v1/work').set(authorization), 'WorkItem');
    expect(workItems).toHaveLength(1);

    const claimInput = input('ClaimInput', { agentId: 'contract-agent' });
    await data(
      request(app).put(`/api/v1/work/task/${task.id}/claim`).set(authorization).send(claimInput),
      'WorkBundle',
    );
    await data(
      request(app)
        .patch(`/api/v1/work/task/${task.id}/claim`)
        .set(authorization)
        .send(input('ClaimInput', { agentId: 'contract-agent', leaseSeconds: 120 })),
      'Claim',
    );
    const completedTask = await data(
      request(app)
        .post(`/api/v1/work/task/${task.id}/complete`)
        .set(authorization)
        .send(
          input('CompleteWorkInput', {
            agentId: 'contract-agent',
            expectedRevision: updatedTask.revision,
            summary: 'Done',
            artifacts: [{ uri: 'file:///tmp/result.md' }],
          }),
        ),
      'Task',
    );
    expect(completedTask.state).toBe('done');
    await data(
      request(app).put(`/api/v1/work/spec/${spec.id}/claim`).set(authorization).send(claimInput),
      'WorkBundle',
    );
    await data(
      request(app)
        .delete(`/api/v1/work/spec/${spec.id}/claim`)
        .set(authorization)
        .send(input('ReleaseInput', { agentId: 'contract-agent', note: 'handoff' })),
      'Released',
    );
    await data(
      request(app).put(`/api/v1/work/spec/${spec.id}/claim`).set(authorization).send(claimInput),
      'WorkBundle',
    );
    const completedSpec = await data(
      request(app)
        .post(`/api/v1/work/spec/${spec.id}/complete`)
        .set(authorization)
        .send(
          input('CompleteWorkInput', {
            agentId: 'contract-agent',
            expectedRevision: readySpec.revision,
            summary: 'Spec done',
          }),
        ),
      'Spec',
    );
    expect(completedSpec.state).toBe('done');
    await data(
      request(app)
        .post(`/api/v1/projects/${project.id}/complete`)
        .set(authorization)
        .send(
          input('CompleteProjectInput', {
            expectedRevision: openProject.revision,
            summary: 'Project done',
            actor: 'contract',
          }),
        ),
      'Project',
    );
    const cancellable = await data(
      request(app)
        .post('/api/v1/projects')
        .set(authorization)
        .send(input('CreateProjectInput', { workspaceId: 'contract', slug: 'beta', title: 'B' }))
        .expect(201),
      'Project',
    );
    const cancelled = await data(
      request(app)
        .post(`/api/v1/projects/${cancellable.id}/cancel`)
        .set(authorization)
        .send(input('CancelInput', { expectedRevision: cancellable.revision, reason: 'Scope' })),
      'Project',
    );
    expect(cancelled.cancelledAt).toMatch(/^\d{4}-/u);
    const activity = await data(
      request(app).get(`/api/v1/projects/${project.id}/activity`).set(authorization),
      'ActivityEvent',
    );
    expect(activity.length).toBeGreaterThan(5);

    await data(
      request(app).get('/api/v1/overview').set(authorization),
      'Overview',
      'OverviewSuccessEnvelope',
    );
    await data(
      request(app).get('/api/v1/settings/backup').set(authorization),
      'AutomaticBackupStatus',
    );
    await data(
      request(app)
        .put('/api/v1/settings/backup')
        .set(authorization)
        .send(input('DirectoryInput', { directory: backupDirectory })),
      'AutomaticBackupStatus',
    );
    await data(request(app).get('/api/v1/settings/sync').set(authorization), 'SyncStatus');
    await data(
      request(app)
        .put('/api/v1/settings/sync')
        .set(authorization)
        .send(
          input('SyncConfigurationInput', { directory: sharedDirectory, deviceId: 'contract' }),
        ),
      'SyncStatus',
    );
    await data(
      request(app).get('/api/v1/settings/sync/conflicts').set(authorization),
      'SyncConflictManifestPage',
    );
    input('ResolveSyncConflictInput', { choice: 'local' });
    await data(
      request(app)
        .post('/api/v1/admin/backup')
        .set(authorization)
        .send(input('DirectoryInput', { directory: join(temporaryDirectory, 'explicit') }))
        .expect(201),
      'PathResult',
    );
    await data(
      request(app)
        .post('/api/v1/admin/export')
        .set(authorization)
        .send(input('DirectoryInput', { directory: join(temporaryDirectory, 'export') }))
        .expect(201),
      'PathResult',
    );
  });
});
