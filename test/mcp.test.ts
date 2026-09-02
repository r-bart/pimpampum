import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createPimpampumMcpHandler } from '../src/mcp.js';
import { AppError } from '../src/errors.js';
import { PimpampumStore } from '../src/store.js';
import { SyncController } from '../src/syncController.js';
import type { PimpampumGateway } from '../src/types.js';
import { canonicalTools } from './helpers/canonicalTools.js';

describe('MCP endpoint v2', () => {
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

  it('publishes only the canonical Workspace/Project/Spec/Task agent vocabulary', async () => {
    const handler = createPimpampumMcpHandler(store);
    const client = new Client(
      { name: 'pimpampum-test', version: '0.2.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(canonicalTools);
      expect(tools.tools.map((tool) => tool.name)).not.toContain('project_read_prd');
      expect(tools.tools.map((tool) => tool.name)).not.toContain('project_update_prd');

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
    } finally {
      await client.close();
    }
  });

  it('teaches agents synchronization status and conflict handling without configuration authority', async () => {
    const sync = new SyncController({
      settingsPath: join(temporaryDirectory, 'sync.json'),
      snapshotter: () => store.exportSyncState(),
      importer: (state) => store.applySyncState(state),
    });
    const handler = createPimpampumMcpHandler(store, sync);
    const client = new Client(
      { name: 'sync-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const syncTools = tools.tools.filter((tool) => tool.name.startsWith('sync_'));
      expect(syncTools.map((tool) => tool.name)).toEqual([
        'sync_status',
        'sync_now',
        'sync_conflict_list',
        'sync_conflict_read',
      ]);
      expect(syncTools.map((tool) => tool.name)).not.toContain('sync_configure');
      expect(syncTools.find((tool) => tool.name === 'sync_status')?.description).toContain(
        'never edit snapshot files',
      );
      const status = await client.callTool({ name: 'sync_status', arguments: {} });
      expect(JSON.stringify(status.content)).toContain('disabled');
      await sync.configure(temporaryDirectory, 'test-device');
      expect((await client.callTool({ name: 'sync_now', arguments: {} })).isError).not.toBe(true);
      const emptyConflicts = await client.callTool({ name: 'sync_conflict_list', arguments: {} });
      expect(emptyConflicts.isError).not.toBe(true);
      (sync as unknown as { settings: { conflicts: unknown[] } }).settings.conflicts.push({
        id: 'a'.repeat(64),
        entityType: 'project',
        entityId: 'project',
        local: {},
        remote: {},
        createdAt: '2026-08-26T00:00:00.000Z',
      });
      const manifests = await client.callTool({ name: 'sync_conflict_list', arguments: {} });
      expect(JSON.stringify(manifests.content)).not.toContain('"local"');
      const known = await client.callTool({
        name: 'sync_conflict_read',
        arguments: { conflictId: 'a'.repeat(64) },
      });
      expect(known.isError).not.toBe(true);
      expect(JSON.stringify(known.content)).toContain('hasMore');
      expect(
        (
          await client.callTool({
            name: 'sync_conflict_read',
            arguments: { conflictId: 'a'.repeat(64), limitCodeUnits: 1, offsetCodeUnits: 0 },
          })
        ).isError,
      ).not.toBe(true);
      const missing = await client.callTool({
        name: 'sync_conflict_read',
        arguments: { conflictId: 'b'.repeat(64) },
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain('not_found');
      const malformed = await client.callTool({
        name: 'sync_conflict_read',
        arguments: { conflictId: 'known' },
      });
      expect(malformed.isError).toBe(true);
      expect(JSON.stringify(malformed.content)).not.toContain('not_found');
    } finally {
      await client.close();
      await sync.close();
    }
  });

  it('round-trips a complete Project, Spec, Task, Context, Claim, and completion workflow', async () => {
    const handler = createPimpampumMcpHandler(store);
    const client = new Client(
      { name: 'pimpampum-workflow', version: '0.2.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);

    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const data = <T>(result: Awaited<ReturnType<typeof call>>): T => {
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('Expected an MCP text result');
      return (JSON.parse(block.text) as { data: T }).data;
    };

    try {
      expect(data<Array<{ id: string }>>(await call('workspace_list', {}))).toMatchObject([
        { id: 'vcomp' },
      ]);
      expect(
        data<{ id: string }>(await call('workspace_resolve', { path: temporaryDirectory })).id,
      ).toBe('vcomp');

      const project = data<{ id: string; revision: number; state: string }>(
        await call('project_create', {
          workspaceId: 'vcomp',
          slug: 'agent-runtime',
          title: 'Agent runtime',
          actor: 'mcp-test',
        }),
      );
      expect(project).toMatchObject({ state: 'draft', specCount: 0 });

      const spec = data<{ id: string; revision: number; state: string }>(
        await call('spec_create', {
          projectId: project.id,
          slug: 'mcp-contract',
          title: 'MCP contract',
          body: '# Contract\n\nExpose one canonical protocol.',
          actor: 'mcp-test',
        }),
      );
      expect(spec).toMatchObject({ state: 'draft', taskCount: 0 });

      const openProject = data<{ revision: number; state: string }>(
        await call('project_update', {
          projectId: project.id,
          state: 'open',
          expectedRevision: project.revision,
          actor: 'mcp-test',
        }),
      );
      expect(openProject.state).toBe('open');

      const readySpec = data<{ revision: number; state: string }>(
        await call('spec_update', {
          specId: spec.id,
          state: 'ready',
          expectedRevision: spec.revision,
          actor: 'mcp-test',
        }),
      );
      expect(readySpec.state).toBe('ready');
      expect(
        data<{ body: string }>(
          await call('spec_read', {
            specId: spec.id,
            offsetCodeUnits: 0,
            limitCodeUnits: 100,
          }),
        ).body,
      ).toContain('canonical protocol');

      await call('context_put', {
        ownerType: 'workspace',
        ownerId: 'vcomp',
        name: 'agents',
        body: '# Workspace agents',
        actor: 'mcp-test',
      });
      await call('context_put', {
        ownerType: 'project',
        ownerId: project.id,
        name: 'agents',
        body: '# Project agents',
        actor: 'mcp-test',
      });
      expect(
        data<{ body: string }>(
          await call('context_read', {
            ownerType: 'project',
            ownerId: project.id,
            name: 'agents',
            offsetCodeUnits: 0,
            limitCodeUnits: 100,
          }),
        ).body,
      ).toBe('# Project agents');

      const task = data<{ id: string; revision: number }>(
        await call('task_create', {
          specId: spec.id,
          title: 'Implement MCP',
          body: 'Ship the v2 tools.',
          actor: 'mcp-test',
        }),
      );
      expect(
        data<{ items: Array<{ id: string }> }>(
          await call('task_list', { specId: spec.id, limit: 10, offset: 0 }),
        ).items[0]?.id,
      ).toBe(task.id);
      expect(
        data<{ items: Array<{ targetType: string; targetId: string }> }>(
          await call('work_list', {
            workspaceId: 'vcomp',
            projectId: project.id,
            specId: spec.id,
            limit: 10,
          }),
        ).items,
      ).toContainEqual(expect.objectContaining({ targetType: 'task', targetId: task.id }));

      const bundle = data<{
        claim: { targetType: string };
        spec: { id: string };
        task: { id: string };
        workspaceContext: { items: unknown[] };
        projectContext: { items: unknown[] };
      }>(
        await call('work_start', {
          targetType: 'task',
          targetId: task.id,
          agentId: 'mcp-agent',
          leaseSeconds: 60,
        }),
      );
      expect(bundle).toMatchObject({
        claim: { targetType: 'task' },
        spec: { id: spec.id },
        task: { id: task.id },
      });
      expect(bundle.workspaceContext.items).toHaveLength(1);
      expect(bundle.projectContext.items).toHaveLength(1);

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
        note: 'handoff check',
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
        expectedRevision: task.revision,
        summary: 'Task delivered',
        artifacts: [],
      });
      expect(
        data<{ completionSummary: string }>(await call('task_completion_get', { taskId: task.id }))
          .completionSummary,
      ).toBe('Task delivered');

      await call('work_start', {
        targetType: 'spec',
        targetId: spec.id,
        agentId: 'mcp-agent',
        leaseSeconds: 60,
      });
      await call('work_complete', {
        targetType: 'spec',
        targetId: spec.id,
        agentId: 'mcp-agent',
        expectedRevision: readySpec.revision,
        summary: 'Spec delivered',
        artifacts: [],
      });
      await call('project_complete', {
        projectId: project.id,
        expectedRevision: openProject.revision,
        summary: 'Initiative delivered',
        artifacts: [],
        actor: 'mcp-test',
      });

      expect(
        data<{ completionSummary: string }>(
          await call('project_completion_get', { projectId: project.id }),
        ).completionSummary,
      ).toBe('Initiative delivered');
      expect(
        data<unknown[]>(await call('activity_list', { projectId: project.id, limit: 100 })).length,
      ).toBeGreaterThan(10);
    } finally {
      await client.close();
    }
  });

  it('executes bounded discovery, manifest reads, updates, and every cancellation boundary', async () => {
    const handler = createPimpampumMcpHandler(store);
    const client = new Client(
      { name: 'pimpampum-coverage', version: '0.2.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);

    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const data = <T>(result: Awaited<ReturnType<typeof call>>): T => {
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('Expected an MCP text result');
      return (JSON.parse(block.text) as { data: T }).data;
    };

    try {
      const project = data<{ id: string; revision: number }>(
        await call('project_create', {
          workspaceId: 'vcomp',
          slug: 'coverage-project',
          title: 'Coverage project',
          actor: 'coverage',
        }),
      );
      const projectToCancel = data<{ id: string; revision: number }>(
        await call('project_create', {
          workspaceId: 'vcomp',
          slug: 'cancel-project',
          title: 'Cancel project',
          actor: 'coverage',
        }),
      );

      const projectPage = data<{
        items: Array<{ id: string }>;
        page: { hasMore: boolean; nextOffset: number | null };
      }>(
        await call('project_list', {
          workspaceId: 'vcomp',
          state: 'draft',
          limit: 1,
          offset: 0,
        }),
      );
      expect(projectPage.items).toHaveLength(1);
      expect(projectPage.page).toMatchObject({ hasMore: true, nextOffset: 1 });
      expect(data<{ id: string }>(await call('project_get', { projectId: project.id })).id).toBe(
        project.id,
      );

      const cancelledSpec = data<{ id: string; revision: number }>(
        await call('spec_create', {
          projectId: project.id,
          slug: 'cancelled-spec',
          title: 'Cancelled Spec',
          body: '# Cancel me',
          actor: 'coverage',
        }),
      );
      const taskSpec = data<{ id: string; revision: number }>(
        await call('spec_create', {
          projectId: project.id,
          slug: 'task-spec',
          title: 'Task Spec',
          body: '# Tasks',
          actor: 'coverage',
        }),
      );
      const specPage = data<{
        items: Array<{ id: string }>;
        page: { hasMore: boolean; nextOffset: number | null };
      }>(
        await call('spec_list', {
          projectId: project.id,
          state: 'draft',
          limit: 1,
          offset: 0,
        }),
      );
      expect(specPage.items).toHaveLength(1);
      expect(specPage.page).toMatchObject({ hasMore: true, nextOffset: 1 });
      expect(
        data<{ completionSummary: null }>(
          await call('spec_completion_get', { specId: cancelledSpec.id }),
        ).completionSummary,
      ).toBeNull();
      expect(
        data<{ state: string }>(
          await call('spec_cancel', {
            specId: cancelledSpec.id,
            expectedRevision: cancelledSpec.revision,
            reason: 'Coverage cancellation',
            actor: 'coverage',
          }),
        ).state,
      ).toBe('cancelled');

      const firstTask = data<{ id: string; revision: number }>(
        await call('task_create', {
          specId: taskSpec.id,
          title: 'First task',
          body: 'Original task body',
          actor: 'coverage',
        }),
      );
      await call('task_create', {
        specId: taskSpec.id,
        title: 'Second task',
        body: 'Second task body',
        actor: 'coverage',
      });
      expect(data<{ id: string }>(await call('task_get', { taskId: firstTask.id })).id).toBe(
        firstTask.id,
      );
      expect(
        data<{ body: string }>(
          await call('task_read', {
            taskId: firstTask.id,
            offsetCodeUnits: 0,
            limitCodeUnits: 100,
          }),
        ).body,
      ).toBe('Original task body');
      const updatedTask = data<{ revision: number; title: string }>(
        await call('task_update', {
          taskId: firstTask.id,
          title: 'Updated task',
          body: 'Updated task body',
          expectedRevision: firstTask.revision,
          actor: 'coverage',
        }),
      );
      expect(updatedTask.title).toBe('Updated task');
      expect(
        data<{ state: string }>(
          await call('task_cancel', {
            taskId: firstTask.id,
            expectedRevision: updatedTask.revision,
            reason: 'No longer needed',
            actor: 'coverage',
          }),
        ).state,
      ).toBe('cancelled');

      await call('context_put', {
        ownerType: 'project',
        ownerId: project.id,
        name: 'architecture',
        body: '# Architecture',
        actor: 'coverage',
      });
      await call('context_put', {
        ownerType: 'project',
        ownerId: project.id,
        name: 'decisions',
        body: '# Decisions',
        actor: 'coverage',
      });
      const contextPage = data<{
        items: Array<{ name: string }>;
        page: { hasMore: boolean; nextOffset: number | null };
      }>(
        await call('context_list', {
          ownerType: 'project',
          ownerId: project.id,
          limit: 1,
          offset: 0,
        }),
      );
      expect(contextPage.items).toHaveLength(1);
      expect(contextPage.page).toMatchObject({ hasMore: true, nextOffset: 1 });

      await call('spec_create', {
        projectId: projectToCancel.id,
        slug: 'descendant',
        title: 'Descendant Spec',
        body: '# Descendant',
        actor: 'coverage',
      });
      expect(
        data<{ state: string }>(
          await call('project_cancel', {
            projectId: projectToCancel.id,
            expectedRevision: projectToCancel.revision,
            reason: 'Cancel the initiative',
            actor: 'coverage',
          }),
        ).state,
      ).toBe('cancelled');
    } finally {
      await client.close();
    }
  });

  it('rejects updates that change nothing without bumping the revision or logging an event', async () => {
    const handler = createPimpampumMcpHandler(store);
    const client = new Client(
      { name: 'pimpampum-noop', version: '0.2.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const data = <T>(result: Awaited<ReturnType<typeof call>>): T => {
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('Expected an MCP text result');
      return (JSON.parse(block.text) as { data: T }).data;
    };
    const failure = (result: Awaited<ReturnType<typeof call>>) => {
      expect(result.isError).toBe(true);
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('Expected an MCP text error');
      return (JSON.parse(block.text) as { error: { code: string; message: string } }).error;
    };
    try {
      const project = data<{ id: string; revision: number }>(
        await call('project_create', { workspaceId: 'vcomp', slug: 'noop', title: 'Noop' }),
      );
      const spec = data<{ id: string; revision: number }>(
        await call('spec_create', { projectId: project.id, slug: 'noop', title: 'Noop' }),
      );
      const task = data<{ id: string; revision: number }>(
        await call('task_create', { specId: spec.id, title: 'Noop' }),
      );
      const mutationsBefore = store.mutationCount;
      expect(
        failure(
          await call('project_update', {
            projectId: project.id,
            expectedRevision: project.revision,
          }),
        ),
      ).toMatchObject({ code: 'bad_request', message: /title and\/or state/u });
      expect(
        failure(await call('spec_update', { specId: spec.id, expectedRevision: spec.revision })),
      ).toMatchObject({ code: 'bad_request', message: /title, body, and\/or state/u });
      expect(
        failure(await call('task_update', { taskId: task.id, expectedRevision: task.revision })),
      ).toMatchObject({ code: 'bad_request', message: /title and\/or body/u });
      expect(store.mutationCount).toBe(mutationsBefore);
      expect(
        data<{ revision: number }>(await call('project_get', { projectId: project.id })).revision,
      ).toBe(project.revision);
      const events = data<Array<{ eventType: string }>>(
        await call('activity_list', { projectId: project.id, limit: 50 }),
      ).map((event) => event.eventType);
      expect(events).not.toContain('project.updated');
      expect(events).not.toContain('spec.updated');
      expect(events).not.toContain('task.updated');
      const completed = data<{ id: string; state: string }>(
        await (async () => {
          await call('spec_update', {
            specId: spec.id,
            body: '# Ready',
            state: 'ready',
            expectedRevision: spec.revision,
          });
          await call('project_update', {
            projectId: project.id,
            state: 'open',
            expectedRevision: project.revision,
          });
          await call('work_start', { targetType: 'task', targetId: task.id, agentId: 'noop' });
          return call('work_complete', {
            targetType: 'task',
            targetId: task.id,
            agentId: 'noop',
            expectedRevision: task.revision,
            summary: 'Done',
          });
        })(),
      );
      expect(completed).toMatchObject({ id: task.id, state: 'done' });
    } finally {
      await client.close();
    }
  });

  it('logs unexpected tool failures and transport rejections through the injected logger', async () => {
    const logger = { error: vi.fn() };
    const gateway = {
      listWorkspaces: () => {
        throw new Error('disk on fire');
      },
      getProjectManifest: () => {
        throw new AppError('not_found', 'Project missing', 404);
      },
    } as unknown as PimpampumGateway;
    const handler = createPimpampumMcpHandler(gateway, undefined, logger);
    const client = new Client(
      { name: 'pimpampum-logger', version: '0.2.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    try {
      const unexpected = await client.callTool({ name: 'workspace_list', arguments: {} });
      expect(unexpected.isError).toBe(true);
      expect(JSON.stringify(unexpected.content)).toContain('internal_error');
      expect(JSON.stringify(unexpected.content)).not.toContain('disk on fire');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0]?.[1]).toMatchObject({ message: 'disk on fire' });

      const typed = await client.callTool({
        name: 'project_get',
        arguments: { projectId: '00000000-0000-4000-8000-000000000001' },
      });
      expect(typed.isError).toBe(true);
      expect(logger.error).toHaveBeenCalledTimes(1);

      // A well-formed JSON body that is not JSON-RPC is rejected out of band; the
      // handler reports it through `onerror`, which lands in the same daemon log.
      const rejected = await handler.fetch(
        new Request('http://test.local/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ hello: 'world' }),
        }),
      );
      expect(rejected.status).toBe(400);
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls[1]?.[0]).toBe('Pimpampum MCP transport failed');
    } finally {
      await client.close();
    }
  });

  it('returns actionable envelopes for invalid v2 targets and revision conflicts', async () => {
    const handler = createPimpampumMcpHandler(store);
    const client = new Client(
      { name: 'pimpampum-errors', version: '0.2.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    try {
      const invalidTarget = await client.callTool({
        name: 'work_start',
        arguments: {
          targetType: 'project',
          targetId: '00000000-0000-4000-8000-000000000001',
          agentId: 'agent',
        },
      });
      expect(invalidTarget.isError).toBe(true);
      expect(invalidTarget.content).toContainEqual(
        expect.objectContaining({ type: 'text', text: expect.stringContaining('spec') }),
      );

      const result = await client.callTool({
        name: 'spec_get',
        arguments: { specId: '00000000-0000-4000-8000-000000000001' },
      });
      expect(result.isError).toBe(true);
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('Expected MCP text error');
      expect(JSON.parse(block.text)).toEqual({
        error: expect.objectContaining({
          code: 'not_found',
          retryable: false,
          suggestion: 'Verify the resource ID or resolve the current workspace again.',
        }),
      });
    } finally {
      await client.close();
    }
  });
});
