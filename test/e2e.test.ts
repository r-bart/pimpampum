import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AutomaticBackupStatus } from '../src/backupContract.js';
import { PIMPAMPUM_VERSION } from '../src/version.js';
import type {
  ContextDocument,
  Overview,
  Project,
  Spec,
  Task,
  WorkBundle,
  WorkItem,
  Workspace,
} from '../src/types.js';
import {
  assertCompiledBuild,
  availablePort,
  compiledCliPath,
  compiledMcpPath,
  repositoryRoot,
  runCompiledCli,
  runProcess,
  startCompiledDaemon,
  stopDaemon,
  type CompiledDaemon,
} from './helpers/compiledDaemon.js';

const executeCli = <T>(environment: NodeJS.ProcessEnv, ...arguments_: string[]): Promise<T> =>
  runCompiledCli<T>(arguments_, { environment });

/** Every MCP tool answers one JSON agent envelope (`{data}` or `{error}`) as its only text block. */
function toolPayload<T = unknown>(result: { content?: unknown }): T {
  const blocks = result.content as Array<{ type: string; text: string }>;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.type).toBe('text');
  return JSON.parse(blocks[0]!.text) as T;
}

interface Resource {
  id: string;
  revision: number;
  state: string;
}

describe.sequential('compiled Domain Model v2 product end to end', () => {
  let daemon: CompiledDaemon | undefined;
  let port = 0;
  let environment: NodeJS.ProcessEnv;
  let temporaryDirectory: string;
  let dataDirectory: string;
  let workspaceRoot: string;
  let exportRoot: string;
  let baseUrl: string;
  const token = 'compiled-v2-e2e-token'.repeat(3);

  async function startDaemon(): Promise<void> {
    daemon = await startCompiledDaemon({ environment, port });
  }

  async function restartDaemon(): Promise<void> {
    await stopDaemon(daemon?.process);
    daemon = undefined;
    await startDaemon();
  }

  async function raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${baseUrl}${path}`, { ...init, headers });
  }

  async function api<T>(path: string, init: RequestInit = {}, expected = 200): Promise<T> {
    const response = await raw(path, init);
    const payload = (await response.json()) as { data?: T; error?: unknown };
    if (response.status !== expected) {
      throw new Error(
        `${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(payload)}`,
      );
    }
    return (payload.data ?? payload) as T;
  }

  const post = <T>(path: string, body: object, status = 200) =>
    api<T>(path, { method: 'POST', body: JSON.stringify(body) }, status);
  const put = <T>(path: string, body: object, status = 200) =>
    api<T>(path, { method: 'PUT', body: JSON.stringify(body) }, status);
  const patch = <T>(path: string, body: object) =>
    api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

  async function createProject(slug: string): Promise<Project> {
    return post<Project>(
      '/api/v1/projects',
      { workspaceId: 'e2e-workspace', slug, title: slug },
      201,
    );
  }

  async function createSpec(projectId: string, slug: string, body = `# ${slug}`): Promise<Spec> {
    return post<Spec>(`/api/v1/projects/${projectId}/specs`, { slug, title: slug, body }, 201);
  }

  async function ready(spec: Spec): Promise<Spec> {
    return patch<Spec>(`/api/v1/specs/${spec.id}`, {
      state: 'ready',
      expectedRevision: spec.revision,
      actor: 'e2e',
    });
  }

  async function open(project: Project): Promise<Project> {
    return patch<Project>(`/api/v1/projects/${project.id}`, {
      state: 'open',
      expectedRevision: project.revision,
      actor: 'e2e',
    });
  }

  beforeAll(async () => {
    assertCompiledBuild([compiledCliPath(), compiledMcpPath()]);
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pimpampum-compiled-v2-'));
    dataDirectory = join(temporaryDirectory, 'data');
    workspaceRoot = join(temporaryDirectory, 'workspace');
    exportRoot = join(temporaryDirectory, 'exports');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(exportRoot, { recursive: true });
    workspaceRoot = realpathSync(workspaceRoot);
    port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    environment = {
      ...process.env,
      PIMPAMPUM_DATA_DIR: dataDirectory,
      PIMPAMPUM_HOST: '127.0.0.1',
      PIMPAMPUM_PORT: String(port),
      PIMPAMPUM_TOKEN: token,
    };
    await startDaemon();
  });

  afterAll(async () => {
    await stopDaemon(daemon?.process);
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('executes the complete multi-Spec portfolio workflow through the compiled daemon', async () => {
    expect(await executeCli(environment, 'health')).toEqual({
      status: 'ok',
      version: PIMPAMPUM_VERSION,
      ready: true,
    });
    const workspace = await executeCli<Workspace>(
      environment,
      'workspace:add',
      'e2e-workspace',
      'E2E Workspace',
      workspaceRoot,
    );
    expect(workspace.rootPath).toBe(workspaceRoot);

    const workspaceContext = await put<ContextDocument>(
      `/api/v1/workspaces/${workspace.id}/context/architecture`,
      { body: '# Shared architecture', expectedRevision: null, actor: 'e2e' },
    );
    let project = await createProject('multi-spec-workflow');
    const projectContext = await put<ContextDocument>(
      `/api/v1/projects/${project.id}/context/architecture`,
      { body: '# Project architecture', expectedRevision: null, actor: 'e2e' },
    );
    expect([workspaceContext.ownerType, projectContext.ownerType]).toEqual([
      'workspace',
      'project',
    ]);

    let direct = await ready(await createSpec(project.id, 'direct-spec'));
    let decomposed = await ready(await createSpec(project.id, 'decomposed-spec'));
    project = await open(project);
    expect(
      await api<WorkItem[]>(`/api/v1/work?projectId=${project.id}&specId=${direct.id}`),
    ).toMatchObject([{ targetType: 'spec', targetId: direct.id }]);

    project = await patch<Project>(`/api/v1/projects/${project.id}`, {
      state: 'paused',
      expectedRevision: project.revision,
      actor: 'e2e',
    });
    expect(await api<WorkItem[]>(`/api/v1/work?projectId=${project.id}`)).toEqual([]);
    project = await open(project);

    const firstClaim = await put<WorkBundle>(`/api/v1/work/spec/${direct.id}/claim`, {
      agentId: 'direct-agent',
      leaseSeconds: 300,
    });
    expect(firstClaim).toMatchObject({
      project: { id: project.id },
      spec: { id: direct.id },
      workspaceContext: { items: [{ name: 'architecture' }] },
      projectContext: { items: [{ name: 'architecture' }] },
    });
    expect(
      (
        await raw(`/api/v1/work/spec/${direct.id}/claim`, {
          method: 'PUT',
          body: JSON.stringify({ agentId: 'competitor', leaseSeconds: 300 }),
        })
      ).status,
    ).toBe(409);
    const renewed = await patch<{ expiresAt: string }>(`/api/v1/work/spec/${direct.id}/claim`, {
      agentId: 'direct-agent',
      leaseSeconds: 600,
    });
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await api(`/api/v1/work/spec/${direct.id}/claim`, {
      method: 'DELETE',
      body: JSON.stringify({ agentId: 'direct-agent', note: 'verified release' }),
    });
    await put(`/api/v1/work/spec/${direct.id}/claim`, {
      agentId: 'direct-agent',
      leaseSeconds: 300,
    });
    direct = await post<Spec>(`/api/v1/work/spec/${direct.id}/complete`, {
      agentId: 'direct-agent',
      expectedRevision: direct.revision,
      summary: 'Direct Spec delivered',
      artifacts: [{ label: 'commit', uri: 'git:direct' }],
    });
    expect(direct.state).toBe('done');

    let parent = await post<Task>(
      `/api/v1/specs/${decomposed.id}/tasks`,
      { title: 'Parent Task', body: 'Integrate the feature.' },
      201,
    );
    let child = await post<Task>(
      `/api/v1/specs/${decomposed.id}/tasks`,
      { parentId: parent.id, title: 'Leaf Subtask' },
      201,
    );
    expect(
      (
        await raw(`/api/v1/work/task/${parent.id}/claim`, {
          method: 'PUT',
          body: JSON.stringify({ agentId: 'task-agent', leaseSeconds: 300 }),
        })
      ).status,
    ).toBe(409);
    await put(`/api/v1/work/task/${child.id}/claim`, {
      agentId: 'task-agent',
      leaseSeconds: 300,
    });
    child = await post<Task>(`/api/v1/work/task/${child.id}/complete`, {
      agentId: 'task-agent',
      expectedRevision: child.revision,
      summary: 'Leaf delivered',
      artifacts: [],
    });
    await put(`/api/v1/work/task/${parent.id}/claim`, {
      agentId: 'task-agent',
      leaseSeconds: 300,
    });
    parent = await post<Task>(`/api/v1/work/task/${parent.id}/complete`, {
      agentId: 'task-agent',
      expectedRevision: parent.revision,
      summary: 'Parent delivered',
      artifacts: [],
    });
    await put(`/api/v1/work/spec/${decomposed.id}/claim`, {
      agentId: 'integration-agent',
      leaseSeconds: 300,
    });
    decomposed = await post<Spec>(`/api/v1/work/spec/${decomposed.id}/complete`, {
      agentId: 'integration-agent',
      expectedRevision: decomposed.revision,
      summary: 'Decomposed Spec integrated',
      artifacts: [],
    });
    project = await post<Project>(`/api/v1/projects/${project.id}/complete`, {
      expectedRevision: project.revision,
      summary: 'All Specs delivered',
      artifacts: [],
      actor: 'owner',
    });
    expect([child.state, parent.state, decomposed.state, project.state]).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
  }, 20_000);

  it('cancels Task, Spec and Project trees atomically through compiled HTTP', async () => {
    let taskProject = await createProject('task-cancel');
    let taskSpec = await ready(await createSpec(taskProject.id, 'task-cancel-spec'));
    taskProject = await open(taskProject);
    const parent = await post<Task>(`/api/v1/specs/${taskSpec.id}/tasks`, { title: 'Parent' }, 201);
    const child = await post<Task>(
      `/api/v1/specs/${taskSpec.id}/tasks`,
      { parentId: parent.id, title: 'Child' },
      201,
    );
    await put(`/api/v1/work/task/${child.id}/claim`, {
      agentId: 'cancel-agent',
      leaseSeconds: 300,
    });
    const cancelledTask = await post<Task>(`/api/v1/tasks/${parent.id}/cancel`, {
      expectedRevision: parent.revision,
      reason: 'Task obsolete',
      actor: 'owner',
    });
    expect([
      cancelledTask.state,
      (await api<Task>(`/api/v1/tasks/${child.id}/manifest`)).state,
    ]).toEqual(['cancelled', 'cancelled']);

    let specProject = await createProject('spec-cancel');
    let cancelledSpec = await ready(await createSpec(specProject.id, 'cancelled-spec'));
    specProject = await open(specProject);
    const specTask = await post<Task>(
      `/api/v1/specs/${cancelledSpec.id}/tasks`,
      { title: 'Spec Task' },
      201,
    );
    await put(`/api/v1/work/task/${specTask.id}/claim`, {
      agentId: 'cancel-agent',
      leaseSeconds: 300,
    });
    cancelledSpec = await post<Spec>(`/api/v1/specs/${cancelledSpec.id}/cancel`, {
      expectedRevision: cancelledSpec.revision,
      reason: 'Platform removed',
      actor: 'owner',
    });
    expect(cancelledSpec.state).toBe('cancelled');
    expect((await api<Task>(`/api/v1/tasks/${specTask.id}/manifest`)).state).toBe('cancelled');

    let cancelledProject = await createProject('project-cancel');
    let projectSpec = await ready(await createSpec(cancelledProject.id, 'project-spec'));
    cancelledProject = await open(cancelledProject);
    const projectTask = await post<Task>(
      `/api/v1/specs/${projectSpec.id}/tasks`,
      { title: 'Project Task' },
      201,
    );
    await put(`/api/v1/work/task/${projectTask.id}/claim`, {
      agentId: 'cancel-agent',
      leaseSeconds: 300,
    });
    cancelledProject = await post<Project>(`/api/v1/projects/${cancelledProject.id}/cancel`, {
      expectedRevision: cancelledProject.revision,
      reason: 'Portfolio decision',
      actor: 'owner',
    });
    projectSpec = await api<Spec>(`/api/v1/specs/${projectSpec.id}/manifest`);
    expect([
      cancelledProject.state,
      projectSpec.state,
      (await api<Task>(`/api/v1/tasks/${projectTask.id}/manifest`)).state,
    ]).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect((await executeCli<Overview>(environment, 'overview')).activeWork).toEqual([]);
  }, 15_000);

  it('persists restart, rolling backup restore and portable export schema 2', async () => {
    const backupDirectory = join(temporaryDirectory, 'Dropbox', 'Pimpampum');
    mkdirSync(backupDirectory, { recursive: true });
    expect(
      await executeCli<AutomaticBackupStatus>(
        environment,
        'backup',
        'configure',
        backupDirectory,
        '--json',
      ),
    ).toMatchObject({ enabled: true, state: 'healthy', directory: backupDirectory });
    const persisted = await executeCli<Project>(
      environment,
      'project:create',
      'e2e-workspace',
      'restart-and-backup',
      'Restart and backup',
    );
    await restartDaemon();
    expect(await executeCli<Project>(environment, 'project:get', persisted.id)).toMatchObject({
      id: persisted.id,
      title: 'Restart and backup',
    });

    const snapshotPath = join(backupDirectory, 'pimpampum-latest.sqlite');
    for (let attempt = 0; attempt < 60; attempt++) {
      if (existsSync(snapshotPath)) {
        const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
        const found = snapshot.prepare('SELECT id FROM projects WHERE id=?').get(persisted.id);
        snapshot.close();
        if (found) break;
      }
      await delay(50);
    }
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    expect(snapshot.pragma('user_version', { simple: true })).toBe(2);
    expect(snapshot.prepare('SELECT id FROM projects WHERE id=?').get(persisted.id)).toEqual({
      id: persisted.id,
    });
    snapshot.close();

    const exported = await executeCli<{ path: string }>(environment, 'export', exportRoot);
    expect(JSON.parse(readFileSync(join(exported.path, 'manifest.json'), 'utf8'))).toMatchObject({
      schemaVersion: 2,
    });
    expect(
      existsSync(
        join(
          exported.path,
          'workspaces',
          'e2e-workspace',
          'projects',
          'multi-spec-workflow',
          'specs',
          'direct-spec',
          'spec.md',
        ),
      ),
    ).toBe(true);

    await stopDaemon(daemon?.process);
    daemon = undefined;
    const databasePath = join(dataDirectory, 'pimpampum.sqlite');
    renameSync(databasePath, `${databasePath}.before-restore`);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    copyFileSync(snapshotPath, databasePath);
    await startDaemon();
    expect(await api<Project>(`/api/v1/projects/${persisted.id}/manifest`)).toMatchObject({
      id: persisted.id,
    });
  }, 20_000);

  it('publishes only v2 HTTP, MCP, target and overview contracts', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/v1/projects`);
    expect(unauthenticated.status).toBe(401);
    const projects = await api<{ items: Array<Resource> }>('/api/v1/projects?limit=100&offset=0');
    const projectId = projects.items[0]?.id;
    expect(projectId).toBeTruthy();
    expect((await raw(`/api/v1/projects/${String(projectId)}/prd`)).status).toBe(404);
    expect(
      (
        await raw(`/api/v1/work/project/${String(projectId)}/claim`, {
          method: 'PUT',
          body: JSON.stringify({ agentId: 'old-agent', leaseSeconds: 300 }),
        })
      ).status,
    ).toBe(400);

    const overviewResponse = await raw('/api/v1/overview');
    const overview = (await overviewResponse.json()) as {
      data: Overview;
      meta: { schemaVersion: number };
    };
    expect(overview.meta.schemaVersion).toBe(2);
    expect(overview.data.counts).toHaveProperty('specs');
    expect(overview.data.counts).toHaveProperty('openProjects');
    expect(overview.data.counts).not.toHaveProperty('readyProjects');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledMcpPath()],
      cwd: repositoryRoot,
      env: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'compiled-v2-e2e', version: '0.2.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['spec_create', 'spec_read', 'spec_cancel']));
      expect(names).not.toEqual(expect.arrayContaining(['project_read_prd', 'project_update_prd']));
      await expect(
        client.callTool({ name: 'project_read_prd', arguments: { projectId } }),
      ).rejects.toThrow(/not found/iu);
      const oldTarget = await client.callTool({
        name: 'work_start',
        arguments: { targetType: 'project', targetId: projectId, agentId: 'old-agent' },
      });
      expect(oldTarget.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 15_000);

  // M-T2: competitors were always sequential. Twenty simultaneous claims on one Task must yield
  // exactly one owner; the rest are typed `conflict` rejections, never a second 200.
  it('grants exactly one of twenty concurrent HTTP claims and rejects nineteen with 409', async () => {
    let project = await createProject('concurrent-http-claims');
    const spec = await ready(await createSpec(project.id, 'concurrent-http-spec'));
    project = await open(project);
    const task = await post<Task>(`/api/v1/specs/${spec.id}/tasks`, { title: 'Contended' }, 201);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        raw(`/api/v1/work/task/${task.id}/claim`, {
          method: 'PUT',
          body: JSON.stringify({ agentId: `http-agent-${String(index)}`, leaseSeconds: 300 }),
        }),
      ),
    );
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, ...Array.from({ length: 19 }, () => 409)]);
    const winner = responses.find((response) => response.status === 200)!;
    const bundle = (await winner.json()) as { data: WorkBundle };
    expect(bundle.data.task).toMatchObject({ id: task.id });
    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      expect(await response.json()).toMatchObject({
        error: { code: 'conflict', message: 'Work is already claimed' },
      });
    }
    const work = await api<WorkItem[]>(`/api/v1/work?projectId=${project.id}`);
    expect(work.filter((item) => item.targetId === task.id)).toEqual([]);
  }, 20_000);

  it('mutates through the stdio MCP bridge and grants exactly one of twenty concurrent work_start calls', async () => {
    let project = await createProject('concurrent-stdio-claims');
    const spec = await ready(await createSpec(project.id, 'concurrent-stdio-spec'));
    project = await open(project);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledMcpPath()],
      cwd: repositoryRoot,
      env: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'compiled-v2-e2e-stdio-writer', version: '0.2.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    try {
      // The suite so far only read through stdio; this is the one mutation that proves the bridge
      // forwards writes to the daemon and the daemon persists them.
      const created = await client.callTool({
        name: 'task_create',
        arguments: { specId: spec.id, title: 'Created over stdio' },
      });
      expect(created.isError).not.toBe(true);
      const task = toolPayload<{ data: Task }>(created).data;
      expect(task).toMatchObject({ specId: spec.id, title: 'Created over stdio', state: 'open' });
      expect(await api<Task>(`/api/v1/tasks/${task.id}/manifest`)).toMatchObject({
        id: task.id,
        title: 'Created over stdio',
      });

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          client.callTool({
            name: 'work_start',
            arguments: {
              targetType: 'task',
              targetId: task.id,
              agentId: `stdio-agent-${String(index)}`,
              leaseSeconds: 300,
            },
          }),
        ),
      );
      const granted = results.filter((result) => result.isError !== true);
      const rejected = results.filter((result) => result.isError === true);
      expect([granted.length, rejected.length]).toEqual([1, 19]);
      expect(toolPayload<{ data: WorkBundle }>(granted[0]!).data.task).toMatchObject({
        id: task.id,
      });
      for (const result of rejected) {
        expect(toolPayload(result)).toMatchObject({
          error: { code: 'conflict', message: 'Work is already claimed', retryable: true },
        });
      }
    } finally {
      await client.close();
    }
  }, 20_000);

  // The commands every suggestion points at must work on a machine where nothing was installed
  // and nothing can be written: no data directory, no token, no receipt. Before this, `loadConfig`
  // created `~/.pimpampum` and minted a token for `help`.
  it('answers help, version, commands and config from a read-only home without writing', async () => {
    const readOnlyHome = join(temporaryDirectory, 'read-only-home');
    mkdirSync(readOnlyHome);
    chmodSync(readOnlyHome, 0o500);
    const offline: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('PIMPAMPUM_')),
    );
    offline.HOME = readOnlyHome;
    try {
      const help = await runProcess(process.execPath, [compiledCliPath(), 'help'], {
        cwd: repositoryRoot,
        environment: offline,
      });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`Pimpampum ${PIMPAMPUM_VERSION}`);
      expect(help.stdout).toContain('Native desktop mode');

      expect(await executeCli(offline, 'version')).toEqual({
        name: 'pimpampum',
        version: PIMPAMPUM_VERSION,
      });
      const catalog = await executeCli<{ commands: Array<{ name: string }> }>(offline, 'commands');
      expect(catalog.commands.map((command) => command.name)).toContain('setup retry');
      expect(await executeCli(offline, 'config')).toMatchObject({
        dataDirectory: join(readOnlyHome, '.pimpampum'),
        tokenPath: join(readOnlyHome, '.pimpampum', 'token'),
        tokenSource: 'file',
        tokenConfigured: false,
      });

      // A client verb reports the missing daemon token typed, with the install remedy, instead of
      // minting a credential of its own.
      const health = await runProcess(process.execPath, [compiledCliPath(), 'health'], {
        cwd: repositoryRoot,
        environment: offline,
      });
      expect(health.code).toBe(1);
      expect(JSON.parse(health.stderr)).toMatchObject({
        error: {
          code: 'unavailable',
          message: expect.stringContaining('No daemon token at'),
          suggestion: expect.stringContaining('pimpampum install'),
        },
      });
      expect(readdirSync(readOnlyHome)).toEqual([]);
    } finally {
      chmodSync(readOnlyHome, 0o700);
    }
  }, 20_000);
});
