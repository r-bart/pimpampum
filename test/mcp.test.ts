import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createPimpampumMcpHandler } from '../src/mcp.js';
import { PimpampumStore } from '../src/store.js';
import type { PimpampumGateway, ProjectManifest } from '../src/types.js';

describe('MCP endpoint', () => {
  let store: PimpampumStore;
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pimpampum-mcp-'));
    store = new PimpampumStore(openDatabase(':memory:'));
    store.registerWorkspace({
      id: 'vcomp',
      name: 'VCOMP',
      rootPath: temporaryDirectory,
      actor: 'test',
    });
  });

  afterEach(() => {
    store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('negotiates MCP and exposes functional agent tools', async () => {
    const handler = createPimpampumMcpHandler(store);
    const client = new Client(
      { name: 'pimpampum-test', version: '0.1.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'workspace_list',
      'workspace_resolve',
      'work_list',
      'work_start',
      'work_renew',
      'work_release',
      'work_complete',
      'project_list',
      'project_get',
      'project_read_prd',
      'project_completion_get',
      'project_create',
      'project_update',
      'project_update_prd',
      'task_get',
      'task_read',
      'task_completion_get',
      'task_list',
      'task_create',
      'task_update',
      'context_list',
      'context_read',
      'context_put',
      'activity_list',
    ]);
    for (const tool of tools.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description?.length).toBeGreaterThan(60);
      expect(tool.annotations).toMatchObject({ openWorldHint: false });
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const schema of Object.values(properties)) expect(schema.description).toBeTruthy();
    }

    const call = async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const data = <T>(result: Awaited<ReturnType<typeof call>>): T => {
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('Expected an MCP text result');
      return (JSON.parse(block.text) as { data: T }).data;
    };

    expect(data<Array<{ id: string }>>(await call('workspace_list', {}))).toMatchObject([
      { id: 'vcomp' },
    ]);
    expect(
      data<{ id: string }>(await call('workspace_resolve', { path: temporaryDirectory })).id,
    ).toBe('vcomp');

    const project = data<{ id: string; revision: number }>(
      await call('project_create', {
        workspaceId: 'vcomp',
        slug: 'mcp-runtime',
        title: 'MCP runtime',
        prd: '# Runtime',
      }),
    );
    const manifests = data<{
      items: Array<{ id: string; prd?: string; prdSizeBytes: number }>;
      page: { hasMore: boolean; nextOffset: number | null };
    }>(
      await call('project_list', {
        workspaceId: 'vcomp',
        state: 'draft',
        limit: 10,
        offset: 0,
      }),
    );
    expect(manifests.items[0]).toMatchObject({ id: project.id, prdSizeBytes: 9 });
    expect(manifests.items[0]?.prd).toBeUndefined();
    expect(manifests.page).toMatchObject({ hasMore: false, nextOffset: null });
    const ready = data<{ revision: number }>(
      await call('project_update', {
        projectId: project.id,
        state: 'ready',
        expectedRevision: project.revision,
        actor: 'mcp-test',
      }),
    );
    const withPrd = data<{ revision: number }>(
      await call('project_update_prd', {
        projectId: project.id,
        prd: '# Runtime v2',
        expectedRevision: ready.revision,
        actor: 'mcp-test',
      }),
    );
    expect(
      data<{ body: string }>(
        await call('project_read_prd', {
          projectId: project.id,
          offsetCodeUnits: 0,
          limitCodeUnits: 100,
        }),
      ).body,
    ).toBe('# Runtime v2');
    await call('context_put', {
      projectId: project.id,
      name: 'architecture',
      body: '# Architecture',
      actor: 'mcp-test',
    });
    expect(
      data<{ items: unknown[] }>(await call('context_list', { projectId: project.id })).items,
    ).toHaveLength(1);
    expect(
      data<{ body: string }>(
        await call('context_read', {
          projectId: project.id,
          name: 'architecture',
          offsetCodeUnits: 0,
          limitCodeUnits: 100,
        }),
      ).body,
    ).toBe('# Architecture');

    const task = data<{ id: string; revision: number }>(
      await call('task_create', {
        projectId: project.id,
        title: 'Implement MCP',
        actor: 'mcp-test',
      }),
    );
    expect(
      data<{ items: Array<{ id: string }> }>(
        await call('task_list', { projectId: project.id, limit: 10, offset: 0 }),
      ).items[0]?.id,
    ).toBe(task.id);
    const updatedTask = data<{ revision: number }>(
      await call('task_update', {
        taskId: task.id,
        body: 'Complete workflow',
        expectedRevision: task.revision,
        actor: 'mcp-test',
      }),
    );
    expect(data<{ id: string }>(await call('task_get', { taskId: task.id })).id).toBe(task.id);
    expect(
      data<{ body: string }>(
        await call('task_read', {
          taskId: task.id,
          offsetCodeUnits: 0,
          limitCodeUnits: 100,
        }),
      ).body,
    ).toBe('Complete workflow');
    expect(
      data<{ tasks: { items: unknown[] } }>(await call('project_get', { projectId: project.id }))
        .tasks.items,
    ).toHaveLength(1);
    expect(
      data<{ items: Array<{ targetId: string }> }>(
        await call('work_list', { workspaceId: 'vcomp', limit: 10 }),
      ).items[0]?.targetId,
    ).toBe(task.id);

    await call('work_start', {
      targetType: 'task',
      targetId: task.id,
      agentId: 'mcp-agent',
      leaseSeconds: 60,
    });
    await call('work_renew', {
      targetType: 'task',
      targetId: task.id,
      agentId: 'mcp-agent',
      leaseSeconds: 120,
    });
    await call('work_release', {
      targetType: 'task',
      targetId: task.id,
      agentId: 'mcp-agent',
      note: 'exercise release',
    });
    await call('work_start', {
      targetType: 'task',
      targetId: task.id,
      agentId: 'mcp-agent',
      leaseSeconds: 60,
    });
    await call('work_complete', {
      targetType: 'task',
      targetId: task.id,
      agentId: 'mcp-agent',
      expectedRevision: updatedTask.revision,
      summary: 'Task delivered',
      artifacts: [],
    });
    expect(
      data<{ completionSummary: string }>(await call('task_completion_get', { taskId: task.id }))
        .completionSummary,
    ).toBe('Task delivered');
    expect(
      data<unknown[]>(await call('activity_list', { projectId: project.id, limit: 100 })).length,
    ).toBeGreaterThan(5);

    await call('work_start', {
      targetType: 'project',
      targetId: project.id,
      agentId: 'mcp-agent',
      leaseSeconds: 60,
    });
    await call('work_complete', {
      targetType: 'project',
      targetId: project.id,
      agentId: 'mcp-agent',
      expectedRevision: withPrd.revision,
      summary: 'Project delivered',
      artifacts: [],
    });
    expect(
      data<{ completionSummary: string }>(
        await call('project_completion_get', { projectId: project.id }),
      ).completionSummary,
    ).toBe('Project delivered');
    const rejected = await call('work_start', {
      targetType: 'project',
      targetId: project.id,
      agentId: 'mcp-agent',
      leaseSeconds: 60,
    });
    expect(rejected.isError).toBe(true);
    const rejectedBlock = rejected.content[0];
    expect(
      JSON.parse(rejectedBlock?.type === 'text' ? rejectedBlock.text : '').error.suggestion,
    ).toContain('project');

    await client.close();
    await handler.close();
  });

  it('passes through an already lightweight project manifest from the HTTP gateway', async () => {
    const manifest: ProjectManifest = {
      id: 'fb8d757d-bfb0-447e-92d6-38d24f2970a1',
      workspaceId: 'vcomp',
      slug: 'remote-manifest',
      title: 'Remote manifest',
      state: 'draft',
      revision: 1,
      artifactCount: 0,
      hasCompletion: false,
      completedAt: null,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      claim: null,
      prdSizeBytes: 123,
    };
    const gateway = {
      listProjectManifests: () => [
        manifest,
        { ...manifest, id: '0cf8cd67-c730-4146-b7c7-8a3c56f4606b' },
      ],
    } as unknown as PimpampumGateway;
    const handler = createPimpampumMcpHandler(gateway);
    const client = new Client(
      { name: 'manifest-test', version: '0.1.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);

    const result = await client.callTool({
      name: 'project_list',
      arguments: { limit: 1, offset: 10 },
    });
    const block = result.content[0];
    expect(block?.type).toBe('text');
    expect(JSON.parse(block?.type === 'text' ? block.text : '')).toEqual({
      data: {
        items: [manifest],
        page: { limit: 1, offset: 10, returned: 1, hasMore: true, nextOffset: 11 },
      },
    });

    await client.close();
    await handler.close();
  });

  it('reports truncation and actionable guidance for unexpected gateway failures', async () => {
    const gateway = {
      listWork: () => [{ targetId: 'one' }, { targetId: 'two' }],
      listWorkspaces: () => {
        throw new Error('offline');
      },
    } as unknown as PimpampumGateway;
    const handler = createPimpampumMcpHandler(gateway);
    const client = new Client(
      { name: 'failure-test', version: '0.1.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);

    const work = await client.callTool({ name: 'work_list', arguments: { limit: 1 } });
    const workBlock = work.content[0];
    expect(JSON.parse(workBlock?.type === 'text' ? workBlock.text : '').data).toMatchObject({
      items: [{ targetId: 'one' }],
      truncated: true,
    });
    const failed = await client.callTool({ name: 'workspace_list', arguments: {} });
    const failedBlock = failed.content[0];
    expect(failed.isError).toBe(true);
    expect(
      JSON.parse(failedBlock?.type === 'text' ? failedBlock.text : '').error.suggestion,
    ).toContain('daemon logs');

    await client.close();
    await handler.close();
  });
});
