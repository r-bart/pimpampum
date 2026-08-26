import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { AutomaticBackupController } from '../src/automaticBackup.js';
import { openDatabase } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { PimpampumStore } from '../src/store.js';
import type { PimpampumHttpGateway } from '../src/types.js';

describe('HTTP API', () => {
  let store: PimpampumStore;
  let automaticBackup: AutomaticBackupController;
  let closeMcp: () => Promise<void>;
  let temporaryDirectory: string;
  let app: ReturnType<typeof request> extends never
    ? never
    : ReturnType<typeof createHttpApp>['app'];
  const token = 'test-token'.repeat(4);

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pimpampum-http-'));
    const database = openDatabase(':memory:');
    store = new PimpampumStore(database, () => automaticBackup.markDirty());
    automaticBackup = new AutomaticBackupController({
      settingsPath: join(temporaryDirectory, 'settings.json'),
      snapshotter: (destination) => store.backupLatest(destination),
    });
    const config: RuntimeConfig = {
      host: '127.0.0.1',
      port: 7337,
      dataDirectory: temporaryDirectory,
      databasePath: ':memory:',
      token,
      baseUrl: 'http://127.0.0.1:7337',
    };
    const created = createHttpApp(store, config, console, Date.now, automaticBackup);
    app = created.app;
    closeMcp = created.close;
  });

  afterEach(async () => {
    await closeMcp();
    await automaticBackup.close();
    store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('keeps health public and protects the API', async () => {
    await request(app).get('/health').expect(200, { status: 'ok', version: '0.1.0' });
    await request(app)
      .get('/openapi.json')
      .expect(200)
      .expect(({ body }) => {
        expect(body.openapi).toBe('3.1.0');
        expect(body.paths['/api/v1/projects'].post.operationId).toBe('createProject');
      });
    await request(app).get('/api/v1/workspaces').expect(401);
    await request(app).get('/api/v1/workspaces').set('authorization', 'Basic test').expect(401);
    await request(app)
      .get('/api/v1/workspaces')
      .set('authorization', 'Bearer wrong-toke')
      .expect(401);
  });

  it('configures, reports, retries and disables one automatic backup destination', async () => {
    const authorization = { authorization: `Bearer ${token}` };
    const backupDirectory = join(temporaryDirectory, 'iCloud Drive', 'Pimpampum');
    mkdirSync(backupDirectory, { recursive: true });

    await request(app).get('/api/v1/settings/backup').expect(401);
    await request(app)
      .get('/api/v1/settings/backup')
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data).toMatchObject({ enabled: false, state: 'disabled' }));
    await request(app)
      .put('/api/v1/settings/backup')
      .set(authorization)
      .send({ directory: 'relative' })
      .expect(400);
    await request(app)
      .put('/api/v1/settings/backup')
      .set(authorization)
      .send({ directory: backupDirectory, unexpected: true })
      .expect(400);

    await request(app)
      .put('/api/v1/settings/backup')
      .set(authorization)
      .send({ directory: backupDirectory })
      .expect(200)
      .expect(({ body }) =>
        expect(body.data).toMatchObject({
          enabled: true,
          directory: backupDirectory,
          state: 'healthy',
        }),
      );
    await request(app)
      .post('/api/v1/settings/backup/retry')
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.state).toBe('healthy'));
    await request(app)
      .delete('/api/v1/settings/backup')
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data).toMatchObject({ enabled: false, state: 'disabled' }));
    await request(app).post('/api/v1/settings/backup/retry').set(authorization).expect(409);
  });

  it('omits automatic-backup routes when the HTTP capability is not composed', async () => {
    const standalone = createHttpApp(store, {
      host: '127.0.0.1',
      port: 7337,
      dataDirectory: temporaryDirectory,
      databasePath: ':memory:',
      token,
      baseUrl: 'http://127.0.0.1:7337',
    });
    const authorization = { authorization: `Bearer ${token}` };
    await request(standalone.app).get('/api/v1/settings/backup').set(authorization).expect(404);
    await request(standalone.app)
      .put('/api/v1/settings/backup')
      .set(authorization)
      .send({ directory: temporaryDirectory })
      .expect(404);
    await request(standalone.app)
      .post('/api/v1/settings/backup/retry')
      .set(authorization)
      .expect(404);
    await request(standalone.app).delete('/api/v1/settings/backup').set(authorization).expect(404);
    await standalone.close();
  });

  it('adds stable daemon runtime metadata to the bounded overview envelope', async () => {
    await closeMcp();
    let clock = Date.parse('2026-08-26T20:00:00.000Z');
    const config: RuntimeConfig = {
      host: '127.0.0.1',
      port: 7337,
      dataDirectory: temporaryDirectory,
      databasePath: ':memory:',
      token,
      baseUrl: 'http://127.0.0.1:7337',
    };
    const created = createHttpApp(store, config, console, () => clock);
    app = created.app;
    closeMcp = created.close;
    clock += 2_500;

    await request(app)
      .get('/api/v1/overview')
      .set('authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          data: {
            daemon: {
              version: '0.1.0',
              startedAt: '2026-08-26T20:00:00.000Z',
              uptimeSeconds: 2,
            },
            generatedAt: '2026-08-26T20:00:02.500Z',
            status: 'empty',
            counts: {
              workspaces: 0,
              projects: 0,
              specs: 0,
              draftProjects: 0,
              openProjects: 0,
              pausedProjects: 0,
              completedProjects: 0,
              cancelledProjects: 0,
              openTasks: 0,
              completedTasks: 0,
              cancelledTasks: 0,
              activeClaims: 0,
              availableWork: 0,
            },
            projects: [],
            projectsTruncated: false,
            activeWork: [],
            activeWorkTruncated: false,
          },
          meta: { schemaVersion: 2 },
        });
      });
  });

  it('registers a workspace, opens a Project and lists its ready Spec as available work', async () => {
    const authorization = { authorization: `Bearer ${token}` };
    await request(app)
      .post('/api/v1/workspaces')
      .set(authorization)
      .send({ id: 'vcomp', name: 'VCOMP', rootPath: temporaryDirectory })
      .expect(201);
    await request(app).get('/api/v1/workspaces').set(authorization).expect(200);

    const projectResponse = await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .send({
        workspaceId: 'vcomp',
        slug: 'auth',
        title: 'Authentication',
      })
      .expect(201);
    const projectId: string = projectResponse.body.data.id;
    const specResponse = await request(app)
      .post(`/api/v1/projects/${projectId}/specs`)
      .set(authorization)
      .send({ slug: 'authentication', title: 'Authentication', body: '# Authentication' })
      .expect(201);
    await request(app)
      .patch(`/api/v1/specs/${specResponse.body.data.id}`)
      .set(authorization)
      .send({ state: 'ready', expectedRevision: 1, actor: 'test' })
      .expect(200);
    await request(app)
      .patch(`/api/v1/projects/${projectId}`)
      .set(authorization)
      .send({ state: 'open', expectedRevision: 1, actor: 'test' })
      .expect(200);

    const workResponse = await request(app)
      .get('/api/v1/work?workspaceId=vcomp')
      .set(authorization)
      .expect(200);

    expect(workResponse.body.data).toMatchObject([
      {
        targetType: 'spec',
        targetId: specResponse.body.data.id,
        workspaceId: 'vcomp',
      },
    ]);
  });

  it('runs the complete authenticated API lifecycle with typed validation failures', async () => {
    const authorization = { authorization: `Bearer ${token}` };
    await request(app)
      .post('/api/v1/workspaces')
      .set(authorization)
      .send({ id: 'lifecycle', name: 'Lifecycle', rootPath: temporaryDirectory })
      .expect(201);
    await request(app)
      .post('/api/v1/workspaces/resolve')
      .set(authorization)
      .send({ path: temporaryDirectory })
      .expect(200)
      .expect(({ body }) => expect(body.data.id).toBe('lifecycle'));
    await request(app)
      .post('/api/v1/workspaces/resolve')
      .set(authorization)
      .send({ path: '.' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('bad_request'));

    await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .send({
        workspaceId: 'lifecycle',
        slug: 'illegal-done',
      })
      .expect(400);
    const created = await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .send({
        workspaceId: 'lifecycle',
        slug: 'agent-runtime',
        title: 'Agent runtime',
      })
      .expect(201);
    const projectId: string = created.body.data.id;
    const cancellableProject = await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .send({
        workspaceId: 'lifecycle',
        slug: 'cancelled-project',
        title: 'Cancelled project',
      })
      .expect(201);
    await request(app)
      .post(`/api/v1/projects/${cancellableProject.body.data.id}/cancel`)
      .set(authorization)
      .send({ expectedRevision: 1, reason: 'Deliberately cancelled', actor: 'test' })
      .expect(200)
      .expect(({ body }) => expect(body.data.state).toBe('cancelled'));

    const createdSpec = await request(app)
      .post(`/api/v1/projects/${projectId}/specs`)
      .set(authorization)
      .send({ slug: 'agent-runtime', title: 'Agent runtime', body: '# Initial' })
      .expect(201);
    const specId: string = createdSpec.body.data.id;
    await request(app)
      .get(`/api/v1/specs/${specId}`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).not.toHaveProperty('body');
        expect(body.data.bodySizeBytes).toBeGreaterThan(0);
      });
    await request(app)
      .get(`/api/v1/specs/${specId}/manifest`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data).not.toHaveProperty('body'));
    const cancellableSpec = await request(app)
      .post(`/api/v1/projects/${projectId}/specs`)
      .set(authorization)
      .send({ slug: 'discarded-spec', title: 'Discarded Spec', body: '# Discarded' })
      .expect(201);
    await request(app)
      .post(`/api/v1/specs/${cancellableSpec.body.data.id}/cancel`)
      .set(authorization)
      .send({ expectedRevision: 1, reason: 'No longer needed', actor: 'test' })
      .expect(200)
      .expect(({ body }) => expect(body.data.state).toBe('cancelled'));
    await request(app)
      .get(`/api/v1/projects/${projectId}/specs?state=cancelled`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.items).toHaveLength(1));
    await request(app)
      .get(`/api/v1/projects/${projectId}/specs`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.items).toHaveLength(2));

    const readySpec = await request(app)
      .patch(`/api/v1/specs/${specId}`)
      .set(authorization)
      .send({ state: 'ready', expectedRevision: 1, actor: 'test' })
      .expect(200);
    const opened = await request(app)
      .patch(`/api/v1/projects/${projectId}`)
      .set(authorization)
      .send({ title: 'Agent runtime v2', state: 'open', expectedRevision: 1, actor: 'test' })
      .expect(200);
    expect(opened.body.data.revision).toBe(2);
    await request(app)
      .patch(`/api/v1/specs/${specId}`)
      .set(authorization)
      .send({ body: '# Ready', expectedRevision: 1 })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('revision_conflict'));
    const updatedSpec = await request(app)
      .patch(`/api/v1/specs/${specId}`)
      .set(authorization)
      .send({ body: '# Ready', expectedRevision: readySpec.body.data.revision, actor: 'test' })
      .expect(200);

    const context = await request(app)
      .put(`/api/v1/projects/${projectId}/context/architecture`)
      .set(authorization)
      .send({ body: '# Architecture', actor: 'test' })
      .expect(200);
    await request(app)
      .put(`/api/v1/projects/${projectId}/context/architecture`)
      .set(authorization)
      .send({
        body: '# Architecture v2',
        expectedRevision: context.body.data.revision,
        actor: 'test',
      })
      .expect(200);
    await request(app)
      .get(`/api/v1/projects/${projectId}/context`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.items[0].body).toBeUndefined();
        expect(body.data.items[0].sizeBytes).toBeGreaterThan(0);
      });
    await request(app)
      .get(`/api/v1/projects/${projectId}/context/architecture`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).not.toHaveProperty('body');
        expect(body.data.sizeBytes).toBeGreaterThan(0);
      });
    await request(app)
      .put('/api/v1/workspaces/lifecycle/context/shared-architecture')
      .set(authorization)
      .send({ body: '# Shared architecture', actor: 'test' })
      .expect(200);
    await request(app)
      .get('/api/v1/workspaces/lifecycle/context')
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.items[0].name).toBe('shared-architecture'));
    await request(app)
      .get('/api/v1/workspaces/lifecycle/context/shared-architecture')
      .set(authorization)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).not.toHaveProperty('body');
        expect(body.data.sizeBytes).toBeGreaterThan(0);
      });
    await request(app)
      .get(
        '/api/v1/workspaces/lifecycle/context/shared-architecture/body?offsetCodeUnits=2&limitCodeUnits=6',
      )
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.body).toBe('Shared'));

    const taskResponse = await request(app)
      .post(`/api/v1/specs/${specId}/tasks`)
      .set(authorization)
      .send({ title: 'Build API' })
      .expect(201);
    const taskId: string = taskResponse.body.data.id;
    const cancellableTask = await request(app)
      .post(`/api/v1/specs/${specId}/tasks`)
      .set(authorization)
      .send({ title: 'Discarded task' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tasks/${cancellableTask.body.data.id}/cancel`)
      .set(authorization)
      .send({ expectedRevision: 1, reason: 'No longer needed', actor: 'test' })
      .expect(200)
      .expect(({ body }) => expect(body.data.state).toBe('cancelled'));
    const updatedTask = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set(authorization)
      .send({ body: 'Implementation details', expectedRevision: 1, actor: 'test' })
      .expect(200);
    const renamedTask = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set(authorization)
      .send({ title: 'Build the complete API', expectedRevision: updatedTask.body.data.revision })
      .expect(200);
    await request(app)
      .get(`/api/v1/tasks/${taskId}`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).not.toHaveProperty('body');
        expect(body.data.bodySizeBytes).toBeGreaterThan(0);
      });
    await request(app).get(`/api/v1/specs/${specId}/tasks`).set(authorization).expect(200);
    await request(app)
      .get('/api/v1/projects?workspaceId=lifecycle&state=open&limit=5&offset=0')
      .set(authorization)
      .expect(200);
    await request(app)
      .get('/api/v1/projects')
      .set(authorization)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.items[0]).not.toHaveProperty('body');
        expect(body.data.items[0].specCount).toBe(2);
      });
    await request(app)
      .get(`/api/v1/projects/${projectId}`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).not.toHaveProperty('prd');
        expect(body.data.specCount).toBe(2);
      });
    await request(app)
      .get(`/api/v1/projects/${projectId}/manifest`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.specCount).toBe(2));
    await request(app)
      .get(`/api/v1/specs/${specId}/body?offsetCodeUnits=2&limitCodeUnits=3`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.body).toBe('Rea'));
    await request(app)
      .get(`/api/v1/tasks/${taskId}/manifest`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.body).toBeUndefined());
    await request(app)
      .get(`/api/v1/tasks/${taskId}/body?offsetCodeUnits=0&limitCodeUnits=14`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.body).toBe('Implementation'));
    await request(app)
      .get(
        `/api/v1/projects/${projectId}/context/architecture/body?offsetCodeUnits=2&limitCodeUnits=12`,
      )
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.body).toBe('Architecture'));
    await request(app)
      .get('/api/v1/work?workspaceId=lifecycle&limit=10')
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data[0].targetId).toBe(taskId));
    await request(app).get('/api/v1/work').set(authorization).expect(200);

    await request(app)
      .put(`/api/v1/work/task/${taskId}/claim`)
      .set(authorization)
      .send({ agentId: 'agent-a', leaseSeconds: 60 })
      .expect(200);
    await request(app)
      .patch(`/api/v1/work/task/${taskId}/claim`)
      .set(authorization)
      .send({ agentId: 'agent-a', leaseSeconds: 120 })
      .expect(200);
    await request(app)
      .delete(`/api/v1/work/task/${taskId}/claim`)
      .set(authorization)
      .send({ agentId: 'agent-b' })
      .expect(409);
    await request(app)
      .delete(`/api/v1/work/task/${taskId}/claim`)
      .set(authorization)
      .send({ agentId: 'agent-a', note: 'handoff' })
      .expect(200);
    await request(app)
      .put(`/api/v1/work/task/${taskId}/claim`)
      .set(authorization)
      .send({ agentId: 'agent-a', leaseSeconds: 60 })
      .expect(200);
    await request(app)
      .post(`/api/v1/work/task/${taskId}/complete`)
      .set(authorization)
      .send({
        agentId: 'agent-a',
        expectedRevision: renamedTask.body.data.revision,
        summary: 'API built',
        artifacts: [{ label: 'commit', uri: 'git:abc' }],
      })
      .expect(200)
      .expect(({ body }) => expect(body.data.state).toBe('done'));

    await request(app)
      .put(`/api/v1/work/spec/${specId}/claim`)
      .set(authorization)
      .send({ agentId: 'agent-a', leaseSeconds: 60 })
      .expect(200);
    await request(app)
      .post(`/api/v1/work/spec/${specId}/complete`)
      .set(authorization)
      .send({
        agentId: 'agent-a',
        expectedRevision: updatedSpec.body.data.revision,
        summary: 'Spec delivered',
      })
      .expect(200);
    await request(app)
      .post(`/api/v1/projects/${projectId}/complete`)
      .set(authorization)
      .send({
        expectedRevision: opened.body.data.revision,
        summary: 'Project delivered',
        actor: 'test',
      })
      .expect(200);
    await request(app)
      .get(`/api/v1/projects/${projectId}/completion`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.completionSummary).toBe('Project delivered'));
    await request(app)
      .get(`/api/v1/specs/${specId}/completion`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.completionSummary).toBe('Spec delivered'));
    await request(app)
      .get(`/api/v1/tasks/${taskId}/completion`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.completionSummary).toBe('API built'));
    await request(app)
      .get(`/api/v1/projects/${projectId}/activity?limit=100`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.length).toBeGreaterThan(8));

    await request(app)
      .post('/api/v1/admin/backup')
      .set(authorization)
      .send({ directory: temporaryDirectory })
      .expect(201);
    await request(app)
      .post('/api/v1/admin/export')
      .set(authorization)
      .send({ directory: temporaryDirectory })
      .expect(201);
    await request(app)
      .post('/api/v1/admin/export')
      .set(authorization)
      .send({ directory: '.' })
      .expect(400);

    await request(app)
      .post('/mcp')
      .set(authorization)
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '0.1.0' },
        },
      })
      .expect(200);
  });

  it('rejects malformed and missing resources without leaking internal errors', async () => {
    const authorization = { authorization: `Bearer ${token}` };
    await request(app).get('/api/v1/workspaces').set('authorization', 'Bearer x').expect(401);
    await request(app)
      .get('/api/v1/projects/not-a-uuid')
      .set(authorization)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('not_found'));
    await request(app)
      .post('/api/v1/workspaces')
      .set(authorization)
      .send({ id: 'invalid!', name: '', rootPath: '.' })
      .expect(400);
    await request(app)
      .post('/api/v1/workspaces')
      .set(authorization)
      .send({ id: 'legacy', name: 'Legacy', rootPath: temporaryDirectory, prd: '# Old field' })
      .expect(400);
    await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .send({ workspaceId: 'legacy', slug: 'old', title: 'Old', prd: '# Old field' })
      .expect(400);
    await request(app)
      .post('/api/v1/specs/11111111-1111-4111-8111-111111111111/tasks')
      .set(authorization)
      .send({
        title: 'Old ownership',
        projectId: '22222222-2222-4222-8222-222222222222',
      })
      .expect(400);
    await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .set('content-type', 'application/json')
      .send('{"broken"')
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('bad_request'));
    await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .send({ prd: 'x'.repeat(2_100_000) })
      .expect(413)
      .expect(({ body }) => expect(body.error.code).toBe('payload_too_large'));
  });

  it('returns JSON for unknown routes, logs internal failures and enforces safe composition', async () => {
    const authorization = { authorization: `Bearer ${token}` };
    await request(app)
      .get('/api/v1/unknown-route')
      .set(authorization)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('not_found'));

    const logger = { error: vi.fn() };
    let gatewayError: unknown = { status: 422 };
    const failingGateway = {
      listWorkspaces: () => {
        throw gatewayError;
      },
    } as unknown as PimpampumHttpGateway;
    const config: RuntimeConfig = {
      host: '127.0.0.1',
      port: 7337,
      dataDirectory: temporaryDirectory,
      databasePath: ':memory:',
      token,
      baseUrl: 'http://127.0.0.1:7337',
    };
    const failingApp = createHttpApp(failingGateway, config, logger);
    await request(failingApp.app)
      .get('/api/v1/workspaces')
      .set(authorization)
      .expect(500)
      .expect(({ body }) => expect(body.error.message).toBe('An internal error occurred'));
    gatewayError = 'primitive failure';
    await request(failingApp.app).get('/api/v1/workspaces').set(authorization).expect(500);
    expect(logger.error).toHaveBeenCalledTimes(2);
    await failingApp.close();

    expect(() => createHttpApp(store, { ...config, token: 'short' })).toThrow(/printable ASCII/);
    expect(() => createHttpApp(store, { ...config, host: '0.0.0.0' })).toThrow(/loopback/);
  });
});
