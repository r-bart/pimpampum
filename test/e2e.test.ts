import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_AGENT_INPUT_BYTES } from '../src/cliProgram.js';
import type { Overview, Project, Task, WorkBundle, WorkItem, Workspace } from '../src/types.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiledCli = join(repositoryRoot, 'dist', 'cli.js');
const compiledMcpBridge = join(repositoryRoot, 'dist', 'mcpStdio.js');

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate an ephemeral TCP port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function executeCli<T>(environment: NodeJS.ProcessEnv, ...arguments_: string[]): Promise<T> {
  return new Promise((resolveResult, reject) => {
    const cliProcess = spawn(process.execPath, [compiledCli, ...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    cliProcess.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    cliProcess.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    cliProcess.once('error', reject);
    cliProcess.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `CLI ${arguments_[0] ?? '<unknown>'} exited with code ${String(code)} and signal ${String(signal)}: ${stderr}`,
          ),
        );
        return;
      }
      try {
        const result: unknown = JSON.parse(stdout);
        resolveResult(result as T);
      } catch (error) {
        reject(new Error(`CLI returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
}

function executeCliWithInput<T>(
  environment: NodeJS.ProcessEnv,
  input: string,
  ...arguments_: string[]
): Promise<T> {
  return new Promise((resolveResult, reject) => {
    const cliProcess = spawn(process.execPath, [compiledCli, ...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    cliProcess.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    cliProcess.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    cliProcess.once('error', reject);
    cliProcess.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `CLI ${arguments_[0] ?? '<unknown>'} exited with code ${String(code)} and signal ${String(signal)}: ${stderr}`,
          ),
        );
        return;
      }
      try {
        resolveResult(JSON.parse(stdout) as T);
      } catch (error) {
        reject(new Error(`CLI returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
    cliProcess.stdin.end(input);
  });
}

function executeCliFailure(
  environment: NodeJS.ProcessEnv,
  ...arguments_: string[]
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const cliProcess = spawn(process.execPath, [compiledCli, ...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    cliProcess.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      cliProcess.kill('SIGKILL');
      reject(new Error(`CLI ${arguments_[0] ?? '<unknown>'} did not exit after 5 seconds`));
    }, 5_000);
    cliProcess.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    cliProcess.once('exit', (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stderr });
    });
  });
}

async function stopDaemon(daemon: ChildProcess | undefined): Promise<void> {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill('SIGTERM');
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      daemon.kill('SIGKILL');
    }, 2_000);
    daemon.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

describe.sequential('compiled product end to end', () => {
  let daemon: ChildProcess | undefined;
  let environment: NodeJS.ProcessEnv;
  let temporaryDirectory: string;
  let dataDirectory: string;
  let workspaceRoot: string;
  let exportRoot: string;
  let baseUrl: string;
  const token = 'e2e-test-token'.repeat(4);

  async function startDaemon(): Promise<void> {
    daemon = spawn(process.execPath, [compiledCli, 'serve'], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let daemonError = '';
    daemon.stderr?.on('data', (chunk: Buffer) => {
      daemonError += chunk.toString();
    });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (daemon.exitCode !== null) {
        throw new Error(`Compiled daemon exited before becoming healthy: ${daemonError}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return;
      } catch {
        // The daemon is still binding its listener.
      }
      await delay(50);
    }
    throw new Error(`Compiled daemon did not become healthy: ${daemonError}`);
  }

  async function restartDaemon(): Promise<void> {
    await stopDaemon(daemon);
    daemon = undefined;
    await startDaemon();
  }

  async function api<T>(path: string, init: RequestInit = {}, expectedStatus = 200): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const payload = (await response.json()) as { data?: T; error?: { code: string } };
    if (response.status !== expectedStatus) {
      throw new Error(
        `Expected HTTP ${expectedStatus} from ${path}, received ${response.status}: ${JSON.stringify(payload)}`,
      );
    }
    return (payload.data ?? payload) as T;
  }

  async function connectMcp(): Promise<Client> {
    const stdioEnvironment = Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledMcpBridge],
      env: stdioEnvironment,
      cwd: repositoryRoot,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'compiled-e2e', version: '0.1.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    return client;
  }

  const mcpData = <T>(result: Awaited<ReturnType<Client['callTool']>>): T => {
    const block = result.content[0];
    if (!block || block.type !== 'text') throw new Error('Expected an MCP text result');
    return (JSON.parse(block.text) as { data: T }).data;
  };

  beforeAll(async () => {
    if (!existsSync(compiledCli) || !existsSync(compiledMcpBridge)) {
      throw new Error('Compiled entrypoints are missing. Run `npm run build` before the E2E test.');
    }

    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pimpampum-e2e-'));
    dataDirectory = join(temporaryDirectory, 'data');
    workspaceRoot = join(temporaryDirectory, 'workspace');
    exportRoot = join(temporaryDirectory, 'exports');
    mkdirSync(workspaceRoot, { recursive: true });
    workspaceRoot = realpathSync(workspaceRoot);
    mkdirSync(exportRoot, { recursive: true });

    const port = await availablePort();
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
    await stopDaemon(daemon);
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('completes a project with a task and produces a portable export', async () => {
    await expect(executeCli(environment, 'health')).resolves.toEqual({
      status: 'ok',
      version: '0.1.0',
    });

    const workspace = await executeCli<Workspace>(
      environment,
      'workspace:add',
      'e2e-workspace',
      'E2E Workspace',
      workspaceRoot,
    );
    expect(workspace).toMatchObject({ id: 'e2e-workspace', rootPath: workspaceRoot });

    const stdioEnvironment = Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const mcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledMcpBridge],
      env: stdioEnvironment,
      cwd: repositoryRoot,
      stderr: 'pipe',
    });
    const mcpClient = new Client(
      { name: 'compiled-e2e', version: '0.1.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await mcpClient.connect(mcpTransport);
    const mcpTools = await mcpClient.listTools();
    expect(mcpTools.tools.map((tool) => tool.name)).toContain('project_list');
    const mcpWorkspaces = await mcpClient.callTool({ name: 'workspace_list', arguments: {} });
    const mcpData = <T>(result: Awaited<ReturnType<typeof mcpClient.callTool>>): T => {
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('Expected an MCP text result');
      return (JSON.parse(block.text) as { data: T }).data;
    };
    expect(mcpData(mcpWorkspaces)).toMatchObject([{ id: workspace.id }]);

    const prdPath = join(temporaryDirectory, 'prd.md');
    writeFileSync(prdPath, '# E2E project\n\nShip the smallest complete workflow.\n');
    const draftProject = await executeCli<Project>(
      environment,
      'project:create',
      workspace.id,
      'e2e-project',
      'E2E Project',
      prdPath,
    );
    expect(draftProject).toMatchObject({ state: 'draft', revision: 1 });
    const mcpProjects = await mcpClient.callTool({
      name: 'project_list',
      arguments: { workspaceId: workspace.id },
    });
    const projectManifests = mcpData<{
      items: Array<{ id: string; prd?: string; prdSizeBytes: number }>;
    }>(mcpProjects).items;
    expect(projectManifests).toMatchObject([
      { id: draftProject.id, prdSizeBytes: Buffer.byteLength(draftProject.prd, 'utf8') },
    ]);
    expect(projectManifests[0]?.prd).toBeUndefined();
    await mcpClient.close();

    const readyProject = await executeCli<Project>(
      environment,
      'project:ready',
      draftProject.id,
      String(draftProject.revision),
    );
    expect(readyProject).toMatchObject({ state: 'ready', revision: 2 });

    const task = await executeCli<Task>(
      environment,
      'task:create',
      draftProject.id,
      'Verify the compiled workflow',
    );
    expect(task).toMatchObject({ projectId: draftProject.id, state: 'open', revision: 1 });

    const taskWork = await executeCli<WorkItem[]>(environment, 'work:list', workspace.id);
    expect(taskWork).toMatchObject([{ targetType: 'task', targetId: task.id }]);

    const taskBundle = await executeCli<WorkBundle>(
      environment,
      'work:start',
      'task',
      task.id,
      'e2e-agent',
    );
    expect(taskBundle).toMatchObject({
      claim: { agentId: 'e2e-agent', targetType: 'task', targetId: task.id },
      task: { id: task.id, revision: task.revision },
    });
    const activeOverview = await executeCli<Overview>(environment, 'overview');
    expect(activeOverview.counts.activeClaims).toBeGreaterThan(0);
    expect(activeOverview.activeWork).toContainEqual(
      expect.objectContaining({ targetId: task.id, agentId: 'e2e-agent' }),
    );

    const completedTask = await executeCli<Task>(
      environment,
      'work:complete',
      'task',
      task.id,
      'e2e-agent',
      String(taskBundle.task?.revision),
      'Compiled task workflow verified',
    );
    expect(completedTask).toMatchObject({
      state: 'done',
      completionSummary: 'Compiled task workflow verified',
    });
    const completedTaskOverview = await executeCli<Overview>(environment, 'overview');
    expect(completedTaskOverview.activeWork).not.toContainEqual(
      expect.objectContaining({ targetId: task.id }),
    );

    const projectWork = await executeCli<WorkItem[]>(environment, 'work:list', workspace.id);
    expect(projectWork).toMatchObject([{ targetType: 'project', targetId: draftProject.id }]);

    const projectBundle = await executeCli<WorkBundle>(
      environment,
      'work:start',
      'project',
      draftProject.id,
      'e2e-agent',
    );
    const completedProject = await executeCli<Project>(
      environment,
      'work:complete',
      'project',
      draftProject.id,
      'e2e-agent',
      String(projectBundle.project.revision),
      'Compiled project workflow verified',
    );
    expect(completedProject).toMatchObject({
      state: 'done',
      completionSummary: 'Compiled project workflow verified',
    });

    const exported = await executeCli<{ path: string }>(environment, 'export', exportRoot);
    const projectExport = join(exported.path, 'projects', workspace.id, 'e2e-project');
    expect(existsSync(join(projectExport, 'prd.md'))).toBe(true);
    expect(readFileSync(join(projectExport, 'prd.md'), 'utf8')).toContain('# E2E project');
    const exportedProject = JSON.parse(
      readFileSync(join(projectExport, 'project.json'), 'utf8'),
    ) as Project;
    const exportedTasks = JSON.parse(
      readFileSync(join(projectExport, 'tasks.json'), 'utf8'),
    ) as Task[];
    expect(exportedProject).toMatchObject({ id: draftProject.id, state: 'done' });
    expect(exportedTasks).toMatchObject([{ id: task.id, state: 'done' }]);
  }, 15_000);

  it('lets a shell-only agent configure, discover and use every operation through MCP', async () => {
    const effective = await executeCli<{
      data: {
        dataDirectory: string;
        tokenPath: string | null;
        tokenSource: 'environment' | 'file';
        token?: string;
        mcp: { streamableHttpUrl: string; stdio: { args: string[] } };
      };
    }>(environment, 'config');
    expect(effective.data).toMatchObject({
      dataDirectory,
      tokenPath: null,
      tokenSource: 'environment',
      mcp: {
        streamableHttpUrl: `${baseUrl}/mcp`,
        stdio: { args: [compiledMcpBridge] },
      },
    });
    expect(effective.data.token).toBeUndefined();

    const fileTokenEnvironment = { ...environment };
    delete fileTokenEnvironment.PIMPAMPUM_TOKEN;
    fileTokenEnvironment.PIMPAMPUM_DATA_DIR = join(temporaryDirectory, 'file-token-config');
    const fileTokenConfiguration = await executeCli<{
      data: { tokenPath: string | null; tokenSource: string; token?: string };
    }>(fileTokenEnvironment, 'config');
    expect(fileTokenConfiguration.data).toMatchObject({
      tokenPath: join(fileTokenEnvironment.PIMPAMPUM_DATA_DIR, 'token'),
      tokenSource: 'file',
    });
    expect(fileTokenConfiguration.data.token).toBeUndefined();

    const catalog = await executeCli<{
      data: { tools: Array<{ name: string; inputSchema: object }> };
    }>(environment, 'tools');
    expect(catalog.data.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'workspace_resolve',
        'project_create',
        'context_put',
        'work_complete',
      ]),
    );
    expect(catalog.data.tools.every((tool) => Object.keys(tool.inputSchema).length > 0)).toBe(true);

    const workspaces = await executeCli<{ data: Workspace[] }>(
      environment,
      'call',
      'workspace_list',
    );
    expect(workspaces.data).toContainEqual(expect.objectContaining({ id: 'e2e-workspace' }));

    const project = await executeCli<{ data: { id: string; revision: number } }>(
      environment,
      'call',
      'project_create',
      '--input',
      JSON.stringify({
        workspaceId: 'e2e-workspace',
        slug: 'agent-cli-e2e',
        title: 'Agent CLI E2E',
        prd: '# Agent CLI\n\nShell-only workflow 🚀',
      }),
    );
    const context = await executeCliWithInput<{ data: { name: string; revision: number } }>(
      environment,
      JSON.stringify({
        projectId: project.data.id,
        name: 'agent-notes',
        body: '# Notes\n\nCreated through standard input.',
      }),
      'call',
      'context_put',
      '--stdin',
    );
    expect(context.data).toMatchObject({ name: 'agent-notes', revision: 1 });

    const multibyteBody = '🚀'.repeat(300_000);
    const multibyteRequest = JSON.stringify({
      projectId: project.data.id,
      name: 'unicode-boundary',
      body: multibyteBody,
    });
    expect(Buffer.byteLength(multibyteRequest, 'utf8')).toBeGreaterThan(1_100_000);
    expect(Buffer.byteLength(multibyteRequest, 'utf8')).toBeLessThan(MAX_AGENT_INPUT_BYTES);
    const multibyteContext = await executeCliWithInput<{
      data: { name: string; sizeBytes: number };
    }>(environment, multibyteRequest, 'call', 'context_put', '--stdin');
    expect(multibyteContext.data).toMatchObject({
      name: 'unicode-boundary',
      sizeBytes: Buffer.byteLength(multibyteBody, 'utf8'),
    });

    const requestPath = join(temporaryDirectory, 'agent-cli-request.json');
    writeFileSync(requestPath, JSON.stringify({ projectId: project.data.id, limit: 10 }));
    const activity = await executeCli<{ data: Array<{ projectId: string }> }>(
      environment,
      'call',
      'activity_list',
      '--input-file',
      requestPath,
    );
    expect(activity.data).toContainEqual(expect.objectContaining({ projectId: project.data.id }));

    const rejected = await executeCliFailure(
      environment,
      'call',
      'workspace_resolve',
      '--input',
      '{"path":"relative"}',
    );
    expect(rejected.code).toBe(1);
    expect(
      JSON.parse(rejected.stderr) as { error: { code: string; suggestion: string } },
    ).toMatchObject({ error: { code: 'bad_request', suggestion: expect.any(String) } });

    const oversizedRequestPath = join(temporaryDirectory, 'agent-cli-oversized-request.json');
    writeFileSync(
      oversizedRequestPath,
      JSON.stringify({ body: 'x'.repeat(MAX_AGENT_INPUT_BYTES) }),
    );
    const oversized = await executeCliFailure(
      environment,
      'call',
      'context_put',
      '--input-file',
      oversizedRequestPath,
    );
    expect(oversized.code).toBe(1);
    expect(JSON.parse(oversized.stderr) as { error: { code: string } }).toMatchObject({
      error: { code: 'payload_too_large' },
    });

    const invalidUtf8RequestPath = join(temporaryDirectory, 'agent-cli-invalid-utf8.json');
    writeFileSync(
      invalidUtf8RequestPath,
      Buffer.concat([Buffer.from('{"body":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    );
    const invalidUtf8 = await executeCliFailure(
      environment,
      'call',
      'context_put',
      '--input-file',
      invalidUtf8RequestPath,
    );
    expect(invalidUtf8.code).toBe(1);
    expect(
      JSON.parse(invalidUtf8.stderr) as { error: { code: string; message: string } },
    ).toMatchObject({
      error: { code: 'bad_request', message: 'Tool input must be valid UTF-8' },
    });

    const invalidConfiguration = await executeCliFailure(
      { ...environment, PIMPAMPUM_PORT: 'not-a-port' },
      'config',
    );
    expect(invalidConfiguration.code).toBe(1);
    expect(
      JSON.parse(invalidConfiguration.stderr) as { error: { code: string; message: string } },
    ).toMatchObject({
      error: {
        code: 'bad_request',
        message: 'PIMPAMPUM_PORT must be an integer between 1 and 65535',
      },
    });
  }, 20_000);

  it('manages project, PRD and contextual Markdown through the compiled MCP bridge', async () => {
    const client = await connectMcp();
    const call = (name: string, arguments_: Record<string, unknown>) =>
      client.callTool({ name, arguments: arguments_ });
    try {
      const project = mcpData<{ id: string; revision: number; state: string }>(
        await call('project_create', {
          workspaceId: 'e2e-workspace',
          slug: 'prd-context-lifecycle',
          title: 'PRD context lifecycle',
          prd: '# Initial PRD 😀\n\nAgent-readable outcome.',
        }),
      );
      expect(project).toMatchObject({ state: 'draft', revision: 1 });

      const firstPage = mcpData<{ body: string; hasMore: boolean; totalCodeUnits: number }>(
        await call('project_read_prd', {
          projectId: project.id,
          offsetCodeUnits: 0,
          limitCodeUnits: 8,
        }),
      );
      expect(firstPage).toMatchObject({ body: '# Initia', hasMore: true });
      expect(firstPage.totalCodeUnits).toBeGreaterThan(firstPage.body.length);

      const ready = mcpData<{ revision: number; title: string; state: string }>(
        await call('project_update', {
          projectId: project.id,
          title: 'PRD and context lifecycle',
          state: 'ready',
          expectedRevision: project.revision,
          actor: 'e2e-mcp-agent',
        }),
      );
      expect(ready).toMatchObject({ title: 'PRD and context lifecycle', state: 'ready' });

      const updatedPrd = mcpData<{ revision: number; prdSizeBytes: number }>(
        await call('project_update_prd', {
          projectId: project.id,
          prd: '# Updated PRD\n\nThis is the canonical outcome.',
          expectedRevision: ready.revision,
          actor: 'e2e-mcp-agent',
        }),
      );
      expect(updatedPrd.revision).toBe(ready.revision + 1);
      expect(updatedPrd.prdSizeBytes).toBeGreaterThan(20);

      const staleWrite = await call('project_update_prd', {
        projectId: project.id,
        prd: '# Stale',
        expectedRevision: ready.revision,
        actor: 'stale-agent',
      });
      expect(staleWrite.isError).toBe(true);

      const createdContext = mcpData<{ revision: number; body?: string; sizeBytes: number }>(
        await call('context_put', {
          projectId: project.id,
          name: 'architecture-e2e',
          body: '# Architecture\n\nSQLite daemon.',
          actor: 'e2e-mcp-agent',
        }),
      );
      expect(createdContext).toMatchObject({ revision: 1 });
      expect(createdContext.body).toBeUndefined();

      const updatedContext = mcpData<{ revision: number }>(
        await call('context_put', {
          projectId: project.id,
          name: 'architecture-e2e',
          body: '# Architecture v2\n\nOne persistent daemon.',
          expectedRevision: createdContext.revision,
          actor: 'e2e-mcp-agent',
        }),
      );
      expect(updatedContext.revision).toBe(2);
      const contextPage = mcpData<{ body: string; hasMore: boolean }>(
        await call('context_read', {
          projectId: project.id,
          name: 'architecture-e2e',
          offsetCodeUnits: 0,
          limitCodeUnits: 100,
        }),
      );
      expect(contextPage).toMatchObject({
        body: '# Architecture v2\n\nOne persistent daemon.',
        hasMore: false,
      });
      expect(
        mcpData<{ items: Array<{ name: string }> }>(
          await call('context_list', { projectId: project.id }),
        ).items,
      ).toMatchObject([{ name: 'architecture-e2e' }]);

      const aggregate = mcpData<{
        project: { id: string; prd?: string };
        tasks: { items: unknown[] };
        context: { items: Array<{ name: string; body?: string }> };
      }>(await call('project_get', { projectId: project.id }));
      expect(aggregate.project).toMatchObject({ id: project.id });
      expect(aggregate.project.prd).toBeUndefined();
      expect(aggregate.tasks.items).toEqual([]);
      expect(aggregate.context.items[0]?.body).toBeUndefined();

      const fullProject = await api<Project>(`/api/v1/projects/${project.id}`);
      expect(fullProject.prd).toContain('# Updated PRD');
    } finally {
      await client.close();
    }
  });

  it('coordinates a real parent-task and subtask workflow between competing agents', async () => {
    const client = await connectMcp();
    const call = (name: string, arguments_: Record<string, unknown>) =>
      client.callTool({ name, arguments: arguments_ });
    try {
      const project = mcpData<{ id: string; revision: number }>(
        await call('project_create', {
          workspaceId: 'e2e-workspace',
          slug: 'task-hierarchy',
          title: 'Task hierarchy',
          prd: '# Task hierarchy',
          state: 'ready',
        }),
      );
      const parent = mcpData<{ id: string; revision: number }>(
        await call('task_create', {
          projectId: project.id,
          title: 'Parent delivery',
          body: 'Parent acceptance criteria',
          actor: 'e2e-mcp-agent',
        }),
      );
      const child = mcpData<{ id: string; revision: number }>(
        await call('task_create', {
          projectId: project.id,
          parentId: parent.id,
          title: 'Leaf implementation',
          body: 'Leaf acceptance criteria',
          actor: 'e2e-mcp-agent',
        }),
      );
      const rejectedGrandchild = await call('task_create', {
        projectId: project.id,
        parentId: child.id,
        title: 'Forbidden third level',
      });
      expect(rejectedGrandchild.isError).toBe(true);

      const updatedChild = mcpData<{ revision: number; title: string }>(
        await call('task_update', {
          taskId: child.id,
          title: 'Leaf implementation v2',
          expectedRevision: child.revision,
          actor: 'e2e-mcp-agent',
        }),
      );
      expect(updatedChild).toMatchObject({ revision: 2, title: 'Leaf implementation v2' });
      expect(
        mcpData<{ body: string }>(
          await call('task_read', {
            taskId: child.id,
            offsetCodeUnits: 0,
            limitCodeUnits: 100,
          }),
        ).body,
      ).toBe('Leaf acceptance criteria');

      const work = mcpData<{ items: Array<{ targetId: string; projectId: string }> }>(
        await call('work_list', { workspaceId: 'e2e-workspace', limit: 100 }),
      ).items.filter((item) => item.projectId === project.id);
      expect(work).toEqual([expect.objectContaining({ targetId: child.id })]);
      expect(
        (
          await call('work_start', {
            targetType: 'task',
            targetId: parent.id,
            agentId: 'parent-agent',
          })
        ).isError,
      ).toBe(true);

      const firstClaim = mcpData<{ claim: { expiresAt: string } }>(
        await call('work_start', {
          targetType: 'task',
          targetId: child.id,
          agentId: 'agent-a',
          leaseSeconds: 300,
        }),
      );
      const retriedClaim = mcpData<{ claim: { expiresAt: string } }>(
        await call('work_start', {
          targetType: 'task',
          targetId: child.id,
          agentId: 'agent-a',
          leaseSeconds: 600,
        }),
      );
      expect(retriedClaim.claim.expiresAt).toBe(firstClaim.claim.expiresAt);
      expect(
        (
          await call('work_start', {
            targetType: 'task',
            targetId: child.id,
            agentId: 'agent-b',
          })
        ).isError,
      ).toBe(true);
      await call('work_renew', {
        targetType: 'task',
        targetId: child.id,
        agentId: 'agent-a',
        leaseSeconds: 600,
      });
      await call('work_release', {
        targetType: 'task',
        targetId: child.id,
        agentId: 'agent-a',
        note: 'Hand off after verification',
      });
      await call('work_start', {
        targetType: 'task',
        targetId: child.id,
        agentId: 'agent-b',
      });
      const completedChild = mcpData<{ state: string; hasCompletion: boolean }>(
        await call('work_complete', {
          targetType: 'task',
          targetId: child.id,
          agentId: 'agent-b',
          expectedRevision: updatedChild.revision,
          summary: 'Leaf delivered',
          artifacts: [{ label: 'commit', uri: 'git:child-commit' }],
        }),
      );
      expect(completedChild).toMatchObject({ state: 'done', hasCompletion: true });
      expect(
        mcpData<{ artifacts: Array<{ uri: string }> }>(
          await call('task_completion_get', { taskId: child.id }),
        ).artifacts,
      ).toEqual([{ label: 'commit', uri: 'git:child-commit' }]);

      await call('work_start', {
        targetType: 'task',
        targetId: parent.id,
        agentId: 'agent-b',
      });
      await call('work_complete', {
        targetType: 'task',
        targetId: parent.id,
        agentId: 'agent-b',
        expectedRevision: parent.revision,
        summary: 'Parent delivered',
      });
      await call('work_start', {
        targetType: 'project',
        targetId: project.id,
        agentId: 'agent-b',
      });
      const completedProject = mcpData<{ state: string }>(
        await call('work_complete', {
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-b',
          expectedRevision: project.revision,
          summary: 'Hierarchy delivered',
        }),
      );
      expect(completedProject.state).toBe('done');
    } finally {
      await client.close();
    }
  });

  it('enforces authentication, optimistic revisions and the deliberate no-delete boundary', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/v1/projects`);
    expect(unauthenticated.status).toBe(401);

    const project = await api<Project>(
      '/api/v1/projects',
      {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'e2e-workspace',
          slug: 'http-conflicts',
          title: 'HTTP conflicts',
          prd: '# HTTP conflicts',
        }),
      },
      201,
    );
    const stale = await fetch(`${baseUrl}/api/v1/projects/${project.id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Stale write', expectedRevision: 999 }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'revision_conflict' },
    });

    const deletion = await fetch(`${baseUrl}/api/v1/projects/${project.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deletion.status).toBe(404);
  });

  it('persists state across restart and prevents a second daemon from owning the instance', async () => {
    const project = await executeCli<Project>(
      environment,
      'project:create',
      'e2e-workspace',
      'restart-persistence',
      'Restart persistence',
    );
    const secondPort = await availablePort();
    const secondInstance = await executeCliFailure(
      { ...environment, PIMPAMPUM_PORT: String(secondPort) },
      'serve',
    );
    expect(secondInstance.code).toBe(1);
    expect(secondInstance.stderr).toContain('Another Pimpampum daemon owns');

    await restartDaemon();
    const persisted = await executeCli<Project>(environment, 'project:get', project.id);
    expect(persisted).toMatchObject({ id: project.id, title: 'Restart persistence' });
    expect(await executeCli<Workspace[]>(environment, 'workspace:list')).toMatchObject([
      { id: 'e2e-workspace' },
    ]);
  });

  it('backs up, restores and exports a real persisted instance', async () => {
    const survivor = await executeCli<Project>(
      environment,
      'project:create',
      'e2e-workspace',
      'backup-survivor',
      'Backup survivor',
    );
    const backup = await executeCli<{ path: string }>(environment, 'backup', exportRoot);
    expect(existsSync(backup.path)).toBe(true);
    const afterBackup = await executeCli<Project>(
      environment,
      'project:create',
      'e2e-workspace',
      'after-backup',
      'After backup',
    );

    await stopDaemon(daemon);
    daemon = undefined;
    const databasePath = join(dataDirectory, 'pimpampum.sqlite');
    copyFileSync(backup.path, databasePath);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    await startDaemon();

    expect(await executeCli<Project>(environment, 'project:get', survivor.id)).toMatchObject({
      id: survivor.id,
      title: 'Backup survivor',
    });
    const missingAfterRestore = await executeCliFailure(environment, 'project:get', afterBackup.id);
    expect(missingAfterRestore.code).toBe(1);
    expect(missingAfterRestore.stderr).toContain('was not found');

    const exported = await executeCli<{ path: string }>(environment, 'export', exportRoot);
    expect(existsSync(join(exported.path, 'manifest.json'))).toBe(true);
    expect(
      existsSync(join(exported.path, 'projects', 'e2e-workspace', 'backup-survivor', 'prd.md')),
    ).toBe(true);
  });

  it('installs, reconciles, reports and removes compiled per-user services safely', async () => {
    const compiledModuleUrl = pathToFileURL(
      join(repositoryRoot, 'dist', 'service', 'manager.js'),
    ).href;
    const serviceModule = (await import(
      compiledModuleUrl
    )) as typeof import('../src/service/manager.js');

    for (const platform of ['darwin', 'linux'] as const) {
      const root = join(temporaryDirectory, `Service Home ${platform} ü`);
      const serviceData = join(root, 'Pimpampum Data ñ');
      mkdirSync(serviceData, { recursive: true });
      writeFileSync(join(serviceData, 'token'), 'compiled-service-secret');
      writeFileSync(join(serviceData, 'pimpampum.sqlite'), 'preserved-database');
      const commands: Array<[string, string[]]> = [];
      const manager = serviceModule.createPlatformServiceManager({
        platform,
        homeDirectory: root,
        dataDirectory: serviceData,
        nodePath: join(root, 'Runtime ü', 'node'),
        cliPath: join(root, 'Package with spaces', 'dist', 'cli.js'),
        version: '0.1.0',
        runCommand: async (executable, arguments_) => {
          commands.push([executable, arguments_]);
          return {
            exitCode: 0,
            stdout:
              platform === 'darwin' && arguments_[0] === 'print'
                ? 'state = running\npid = 123\n'
                : platform === 'linux' && arguments_.includes('show')
                  ? 'LoadState=loaded\nUnitFileState=disabled\nActiveState=active\n'
                  : '',
            stderr: '',
          };
        },
      });

      const firstInstall = await manager.install();
      expect(firstInstall).toMatchObject({ installed: true, reconciled: false });
      expect(await manager.status()).toMatchObject({ installed: true, running: true });
      const secondInstall = await manager.install();
      expect(secondInstall).toMatchObject({ installed: true, reconciled: true });
      expect(readFileSync(firstInstall.receiptPath, 'utf8')).not.toMatch(
        /compiled-service-secret|bearer/i,
      );

      expect(await manager.uninstall()).toEqual({
        uninstalled: true,
        dataPreserved: true,
      });
      expect(existsSync(firstInstall.receiptPath)).toBe(false);
      expect(readFileSync(join(serviceData, 'token'), 'utf8')).toBe('compiled-service-secret');
      expect(readFileSync(join(serviceData, 'pimpampum.sqlite'), 'utf8')).toBe(
        'preserved-database',
      );
      expect(commands.length).toBeGreaterThanOrEqual(4);
      expect(commands.every(([, arguments_]) => Array.isArray(arguments_))).toBe(true);
    }
  });
});
