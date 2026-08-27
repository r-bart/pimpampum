/**
 * @generated-from thoughts/specs/2026-08-26_domain-model-v2.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { createPimpampumMcpHandler } from '../src/mcp.js';
import { PimpampumStore } from '../src/store.js';

const token = 'domain-model-v2-test-token'.repeat(2);
const authorization = { authorization: `Bearer ${token}` };

interface Resource {
  id: string;
  revision: number;
  state: string;
  [key: string]: unknown;
}

describe('Domain Model v2 acceptance', () => {
  let temporaryDirectory: string;
  let store: PimpampumStore;
  let app: ReturnType<typeof createHttpApp>['app'];
  let closeMcp: () => Promise<void>;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pimpampum-domain-v2-'));
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

  async function createWorkspace(id = 'pimpampum'): Promise<Resource> {
    const response = await request(app)
      .post('/api/v1/workspaces')
      .set(authorization)
      .send({ id, name: 'Pimpampum', rootPath: temporaryDirectory })
      .expect(201);
    return response.body.data as Resource;
  }

  async function createProject(
    workspaceId: string,
    slug = 'desktop-experience',
  ): Promise<Resource> {
    const response = await request(app)
      .post('/api/v1/projects')
      .set(authorization)
      .send({ workspaceId, slug, title: 'Desktop experience' })
      .expect(201);
    return response.body.data as Resource;
  }

  async function createSpec(
    projectId: string,
    slug = 'macos-menu-bar',
    body = '# macOS menu-bar\n\nShow portfolio state.',
  ): Promise<Resource> {
    const response = await request(app)
      .post(`/api/v1/projects/${projectId}/specs`)
      .set(authorization)
      .send({ slug, title: 'macOS menu-bar', body })
      .expect(201);
    return response.body.data as Resource;
  }

  async function updateProject(
    project: Resource,
    state: 'draft' | 'open' | 'paused',
  ): Promise<Resource> {
    const response = await request(app)
      .patch(`/api/v1/projects/${project.id}`)
      .set(authorization)
      .send({ state, expectedRevision: project.revision, actor: 'acceptance-test' })
      .expect(200);
    return response.body.data as Resource;
  }

  async function updateSpec(spec: Resource, state: 'draft' | 'ready'): Promise<Resource> {
    const response = await request(app)
      .patch(`/api/v1/specs/${spec.id}`)
      .set(authorization)
      .send({ state, expectedRevision: spec.revision, actor: 'acceptance-test' })
      .expect(200);
    return response.body.data as Resource;
  }

  it('FR-1/FR-2: models Workspace → Project → many Specs without a separate PRD entity', async () => {
    // Spec: FR-1, FR-2, AC-1, AC-2, AC-3, AC-4
    const workspace = await createWorkspace();
    const project = await createProject(workspace.id);
    const firstSpec = await createSpec(project.id);
    const secondSpec = await createSpec(
      project.id,
      'omarchy-quattro',
      '# Omarchy Quattro\n\nExpose the same state.',
    );

    expect(project).toMatchObject({ workspaceId: workspace.id, state: 'draft' });
    expect(firstSpec).toMatchObject({ projectId: project.id, state: 'draft' });
    expect(secondSpec).toMatchObject({ projectId: project.id, state: 'draft' });

    const listed = await request(app)
      .get(`/api/v1/projects/${project.id}/specs?limit=20&offset=0`)
      .set(authorization)
      .expect(200);
    expect(listed.body.data.items).toHaveLength(2);
    expect(listed.body.data.items.map((item: Resource) => item.id)).toEqual([
      secondSpec.id,
      firstSpec.id,
    ]);

    const projectPayload = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set(authorization)
      .expect(200);
    expect(projectPayload.body.data).not.toHaveProperty('prd');
    expect(firstSpec).toHaveProperty('body');
  });

  it('FR-3/EC-1: enforces Project and Spec readiness before exposing work', async () => {
    // Spec: FR-3, EC-1, AC-5, AC-6
    const workspace = await createWorkspace();
    const emptyProject = await createProject(workspace.id);

    await request(app)
      .patch(`/api/v1/projects/${emptyProject.id}`)
      .set(authorization)
      .send({
        state: 'open',
        expectedRevision: emptyProject.revision,
        actor: 'acceptance-test',
      })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('invalid_state'));

    const emptySpec = await createSpec(emptyProject.id, 'empty-spec', '');
    await request(app)
      .patch(`/api/v1/specs/${emptySpec.id}`)
      .set(authorization)
      .send({ state: 'ready', expectedRevision: emptySpec.revision, actor: 'acceptance-test' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('invalid_state'));

    const draftWork = await request(app)
      .get(`/api/v1/work?workspaceId=${workspace.id}`)
      .set(authorization)
      .expect(200);
    expect(draftWork.body.data).toEqual([]);

    const spec = await createSpec(emptyProject.id, 'ready-spec', '# Ready spec');
    const readySpec = await updateSpec(spec, 'ready');
    const openProject = await updateProject(emptyProject, 'open');
    const available = await request(app)
      .get(`/api/v1/work?projectId=${openProject.id}&specId=${readySpec.id}`)
      .set(authorization)
      .expect(200);
    expect(available.body.data).toMatchObject([
      { targetType: 'spec', targetId: readySpec.id, projectId: openProject.id },
    ]);
  });

  it('FR-4/FR-5: claims only a direct Spec or an open leaf Task and derives doing from the Claim', async () => {
    // Spec: FR-4, FR-5, AC-5, AC-6
    const workspace = await createWorkspace();
    let project = await createProject(workspace.id);
    let spec = await createSpec(project.id);
    spec = await updateSpec(spec, 'ready');
    project = await updateProject(project, 'open');

    const taskResponse = await request(app)
      .post(`/api/v1/specs/${spec.id}/tasks`)
      .set(authorization)
      .send({ title: 'Build status popover', body: 'Implement the approved design.' })
      .expect(201);
    const task = taskResponse.body.data as Resource;
    const subtaskResponse = await request(app)
      .post(`/api/v1/specs/${spec.id}/tasks`)
      .set(authorization)
      .send({ parentId: task.id, title: 'Decode overview v2' })
      .expect(201);
    const subtask = subtaskResponse.body.data as Resource;

    const available = await request(app)
      .get(`/api/v1/work?projectId=${project.id}&specId=${spec.id}`)
      .set(authorization)
      .expect(200);
    expect(available.body.data).toMatchObject([
      { targetType: 'task', targetId: subtask.id, specId: spec.id },
    ]);

    await request(app)
      .put(`/api/v1/work/task/${task.id}/claim`)
      .set(authorization)
      .send({ agentId: 'parent-agent', leaseSeconds: 600 })
      .expect(409);

    await request(app)
      .put(`/api/v1/work/task/${subtask.id}/claim`)
      .set(authorization)
      .send({ agentId: 'leaf-agent', leaseSeconds: 600 })
      .expect(200);
    await request(app)
      .put(`/api/v1/work/task/${subtask.id}/claim`)
      .set(authorization)
      .send({ agentId: 'competing-agent', leaseSeconds: 600 })
      .expect(409);

    const overview = await request(app).get('/api/v1/overview').set(authorization).expect(200);
    expect(overview.body.meta.schemaVersion).toBe(2);
    expect(overview.body.data.activeWork).toContainEqual(
      expect.objectContaining({
        targetType: 'task',
        targetId: subtask.id,
        specId: spec.id,
        agentId: 'leaf-agent',
      }),
    );
  });

  it('FR-6/EC-2: supports Workspace and Project Context without implicit name overrides', async () => {
    // Spec: FR-6, EC-2, AC-1, AC-2
    const workspace = await createWorkspace();
    const project = await createProject(workspace.id);

    await request(app)
      .put(`/api/v1/workspaces/${workspace.id}/context/architecture`)
      .set(authorization)
      .send({ body: '# Product architecture', expectedRevision: null, actor: 'acceptance-test' })
      .expect(200);
    await request(app)
      .put(`/api/v1/projects/${project.id}/context/architecture`)
      .set(authorization)
      .send({ body: '# Project architecture', expectedRevision: null, actor: 'acceptance-test' })
      .expect(200);

    const workspaceContext = await request(app)
      .get(
        `/api/v1/workspaces/${workspace.id}/context/architecture/body?offsetCodeUnits=0&limitCodeUnits=100`,
      )
      .set(authorization)
      .expect(200);
    const projectContext = await request(app)
      .get(
        `/api/v1/projects/${project.id}/context/architecture/body?offsetCodeUnits=0&limitCodeUnits=100`,
      )
      .set(authorization)
      .expect(200);

    expect(workspaceContext.body.data.body).toBe('# Product architecture');
    expect(projectContext.body.data.body).toBe('# Project architecture');
  });

  it('FR-7/EC-3: pauses and reopens Projects without rewriting descendant states', async () => {
    // Spec: FR-7, EC-3
    const workspace = await createWorkspace();
    let project = await createProject(workspace.id);
    let spec = await createSpec(project.id);
    spec = await updateSpec(spec, 'ready');
    project = await updateProject(project, 'open');

    let work = await request(app)
      .get(`/api/v1/work?projectId=${project.id}`)
      .set(authorization)
      .expect(200);
    expect(work.body.data).toMatchObject([{ targetType: 'spec', targetId: spec.id }]);

    project = await updateProject(project, 'paused');
    work = await request(app)
      .get(`/api/v1/work?projectId=${project.id}`)
      .set(authorization)
      .expect(200);
    expect(work.body.data).toEqual([]);

    project = await updateProject(project, 'open');
    work = await request(app)
      .get(`/api/v1/work?projectId=${project.id}`)
      .set(authorization)
      .expect(200);
    expect(work.body.data).toMatchObject([{ targetType: 'spec', targetId: spec.id }]);
  });

  it('FR-8/EC-4: cancellation is terminal, cascades, releases Claims, and preserves history', async () => {
    // Spec: FR-8, EC-4, AC-7
    const workspace = await createWorkspace();
    let project = await createProject(workspace.id);
    let spec = await createSpec(project.id);
    spec = await updateSpec(spec, 'ready');
    project = await updateProject(project, 'open');
    const taskResponse = await request(app)
      .post(`/api/v1/specs/${spec.id}/tasks`)
      .set(authorization)
      .send({ title: 'Implement cancellation' })
      .expect(201);
    const task = taskResponse.body.data as Resource;

    await request(app)
      .put(`/api/v1/work/task/${task.id}/claim`)
      .set(authorization)
      .send({ agentId: 'cancellation-agent', leaseSeconds: 600 })
      .expect(200);

    const cancelledResponse = await request(app)
      .post(`/api/v1/specs/${spec.id}/cancel`)
      .set(authorization)
      .send({
        expectedRevision: spec.revision,
        reason: 'The operating system removed the required API.',
        actor: 'portfolio-owner',
      })
      .expect(200);
    expect(cancelledResponse.body.data.state).toBe('cancelled');

    const cancelledTask = await request(app)
      .get(`/api/v1/tasks/${task.id}`)
      .set(authorization)
      .expect(200);
    expect(cancelledTask.body.data.state).toBe('cancelled');

    await request(app)
      .patch(`/api/v1/specs/${spec.id}`)
      .set(authorization)
      .send({
        title: 'Rewrite cancelled work',
        expectedRevision: cancelledResponse.body.data.revision,
        actor: 'acceptance-test',
      })
      .expect(409);

    const overview = await request(app).get('/api/v1/overview').set(authorization).expect(200);
    expect(overview.body.data.activeWork).not.toContainEqual(
      expect.objectContaining({ targetId: task.id }),
    );

    const activity = await request(app)
      .get(`/api/v1/projects/${project.id}/activity?limit=100`)
      .set(authorization)
      .expect(200);
    expect(activity.body.data).toContainEqual(
      expect.objectContaining({ targetType: 'spec', targetId: spec.id }),
    );
  });

  it('FR-9: exposes one canonical MCP vocabulary and no Project-as-PRD aliases', async () => {
    // Spec: FR-9, AC-9
    const handler = createPimpampumMcpHandler(store);
    const client = new Client(
      { name: 'domain-model-v2-acceptance', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('spec_create');
      expect(tools).toContain('spec_read');
      expect(tools).toContain('spec_cancel');
      expect(tools).toContain('project_complete');
      expect(tools).not.toContain('project_read_prd');
      expect(tools).not.toContain('project_update_prd');
    } finally {
      await client.close();
    }
  });

  it('FR-10: publishes OpenAPI and overview schema v2 without old PRD resources', async () => {
    // Spec: FR-10, AC-9
    const contract = await request(app).get('/openapi.json').expect(200);
    expect(contract.body.paths).toHaveProperty('/api/v1/projects/{projectId}/specs');
    expect(contract.body.paths).toHaveProperty('/api/v1/specs/{specId}/body');
    expect(contract.body.paths).not.toHaveProperty('/api/v1/projects/{projectId}/prd');
    expect(contract.body.components.schemas).toHaveProperty('Spec');
    expect(contract.body.components.schemas.TargetType.enum).toEqual(['spec', 'task']);

    const overview = await request(app).get('/api/v1/overview').set(authorization).expect(200);
    expect(overview.body.meta.schemaVersion).toBe(2);
    expect(overview.body.data.counts).toHaveProperty('specs');
  });
});
