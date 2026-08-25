import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { PimpampumStore } from '../src/store.js';
import type { PimpampumHttpGateway } from '../src/types.js';

describe('HTTP API', () => {
  let store: PimpampumStore;
  let closeMcp: () => Promise<void>;
  let temporaryDirectory: string;
  let app: ReturnType<typeof request> extends never
    ? never
    : ReturnType<typeof createHttpApp>['app'];
  const token = 'test-token'.repeat(4);

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pimpampum-http-'));
    store = new PimpampumStore(openDatabase(':memory:'));
    const config: RuntimeConfig = {
      host: '127.0.0.1',
      port: 7337,
      dataDirectory: temporaryDirectory,
      databasePath: ':memory:',
      token,
      baseUrl: 'http://127.0.0.1:7337',
    };
    const created = createHttpApp(store, config);
    app = created.app;
    closeMcp = created.close;
  });

  afterEach(async () => {
    await closeMcp();
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

  it('registers a workspace, creates a PRD and lists it as available work', async () => {
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
        prd: '# Authentication',
        state: 'ready',
      })
      .expect(201);

    const workResponse = await request(app)
      .get('/api/v1/work?workspaceId=vcomp')
      .set(authorization)
      .expect(200);

    expect(workResponse.body.data).toMatchObject([
      {
        targetType: 'project',
        targetId: projectResponse.body.data.id,
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
        title: 'Illegal',
        state: 'done',
      })
      .expect(400);
    const created = await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .send({
        workspaceId: 'lifecycle',
        slug: 'agent-runtime',
        title: 'Agent runtime',
        prd: '# Initial',
      })
      .expect(201);
    const projectId: string = created.body.data.id;

    const ready = await request(app)
      .patch(`/api/v1/projects/${projectId}`)
      .set(authorization)
      .send({ title: 'Agent runtime v1', state: 'ready', expectedRevision: 1, actor: 'test' })
      .expect(200);
    expect(ready.body.data.revision).toBe(2);
    await request(app)
      .put(`/api/v1/projects/${projectId}/prd`)
      .set(authorization)
      .send({ prd: '# Ready', expectedRevision: 1 })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('revision_conflict'));
    const prd = await request(app)
      .put(`/api/v1/projects/${projectId}/prd`)
      .set(authorization)
      .send({ prd: '# Ready', expectedRevision: 2, actor: 'test' })
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
        expect(body.data[0].body).toBeUndefined();
        expect(body.data[0].sizeBytes).toBeGreaterThan(0);
      });
    await request(app)
      .get(`/api/v1/projects/${projectId}/context/architecture`)
      .set(authorization)
      .expect(200);

    const taskResponse = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(authorization)
      .send({ title: 'Build API' })
      .expect(201);
    const taskId: string = taskResponse.body.data.id;
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
    await request(app).get(`/api/v1/tasks/${taskId}`).set(authorization).expect(200);
    await request(app).get(`/api/v1/projects/${projectId}/tasks`).set(authorization).expect(200);
    await request(app)
      .get('/api/v1/projects?workspaceId=lifecycle&state=ready&limit=5&offset=0')
      .set(authorization)
      .expect(200);
    await request(app)
      .get('/api/v1/projects')
      .set(authorization)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data[0].prd).toBeUndefined();
        expect(body.data[0].prdSizeBytes).toBeGreaterThan(0);
      });
    await request(app)
      .get(`/api/v1/projects/${projectId}`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.prd).toBe('# Ready'));
    await request(app)
      .get(`/api/v1/projects/${projectId}/manifest`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.prdSizeBytes).toBeGreaterThan(0));
    await request(app)
      .get(`/api/v1/projects/${projectId}/prd?offsetCodeUnits=2&limitCodeUnits=3`)
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
      .put(`/api/v1/work/project/${projectId}/claim`)
      .set(authorization)
      .send({ agentId: 'agent-a', leaseSeconds: 60 })
      .expect(200);
    await request(app)
      .post(`/api/v1/work/project/${projectId}/complete`)
      .set(authorization)
      .send({
        agentId: 'agent-a',
        expectedRevision: prd.body.data.revision,
        summary: 'Project delivered',
      })
      .expect(200);
    await request(app)
      .get(`/api/v1/projects/${projectId}/completion`)
      .set(authorization)
      .expect(200)
      .expect(({ body }) => expect(body.data.completionSummary).toBe('Project delivered'));
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
