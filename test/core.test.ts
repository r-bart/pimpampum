import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupDatabase, exportPortable } from '../src/backup.js';
import { PimpampumHttpClient, createHttpClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { AppError, asAppError } from '../src/errors.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pimpampum-core-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PIMPAMPUM_DATA_DIR;
  delete process.env.PIMPAMPUM_HOST;
  delete process.env.PIMPAMPUM_PORT;
  delete process.env.PIMPAMPUM_TOKEN;
  for (const directory of temporaryDirectories.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('configuration and infrastructure', () => {
  it('creates and reuses a private token and validates network configuration', () => {
    const dataDirectory = temporaryDirectory();
    chmodSync(dataDirectory, 0o777);
    process.env.PIMPAMPUM_DATA_DIR = dataDirectory;
    const first = loadConfig();
    const second = loadConfig();
    expect(first.token).toHaveLength(64);
    expect(second.token).toBe(first.token);
    const tokenPath = join(dataDirectory, 'token');
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(first.token);
    expect(statSync(dataDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    writeFileSync(tokenPath, '');
    expect(() => loadConfig()).toThrow(/Stored Pimpampum token/);

    process.env.PIMPAMPUM_TOKEN = 'c'.repeat(32);
    process.env.PIMPAMPUM_HOST = '::1';
    process.env.PIMPAMPUM_PORT = '7444';
    expect(loadConfig()).toMatchObject({
      token: 'c'.repeat(32),
      host: '::1',
      port: 7444,
      baseUrl: 'http://[::1]:7444',
    });
    process.env.PIMPAMPUM_TOKEN = 'weak';
    expect(() => loadConfig()).toThrow(/at least 32/);
    process.env.PIMPAMPUM_TOKEN = '😀'.repeat(32);
    expect(() => loadConfig()).toThrow(/printable ASCII/);
    process.env.PIMPAMPUM_TOKEN = 'c'.repeat(32);
    expect(
      loadConfig({
        dataDirectory,
        databasePath: ':memory:',
        host: 'localhost',
        port: 7555,
        token: 'o'.repeat(32),
        baseUrl: 'http://custom.local',
      }),
    ).toMatchObject({
      databasePath: ':memory:',
      host: 'localhost',
      token: 'o'.repeat(32),
      baseUrl: 'http://custom.local',
    });

    expect(() => loadConfig({ host: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => loadConfig({ dataDirectory: 'relative' })).toThrow(/absolute path/);
    expect(() => loadConfig({ token: 'weak' })).toThrow(/at least 32/);
    expect(() => loadConfig({ port: 0 })).toThrow(/between 1 and 65535/);
    expect(() => loadConfig({ port: 65_536 })).toThrow(/between 1 and 65535/);
    expect(() => loadConfig({ port: 1.5 })).toThrow(/between 1 and 65535/);
  });

  it('opens, migrates and reopens file and memory databases', () => {
    const databasePath = join(temporaryDirectory(), 'nested', 'project.sqlite');
    const first = openDatabase(databasePath);
    expect(first.pragma('user_version', { simple: true })).toBe(2);
    first.close();
    const second = openDatabase(databasePath);
    expect(second.pragma('journal_mode', { simple: true })).toBe('wal');
    second.close();
    const memory = openDatabase(':memory:');
    expect(memory.pragma('foreign_keys', { simple: true })).toBe(1);
    memory.close();

    const futurePath = join(temporaryDirectory(), 'future.sqlite');
    const future = new Database(futurePath);
    future.pragma('user_version = 3');
    future.close();
    expect(() => openDatabase(futurePath)).toThrow(/newer than supported/);
  });

  it('maps known, native and unknown errors', () => {
    const appError = new AppError('conflict', 'busy', 409, true, { id: 1 });
    expect(asAppError(appError)).toBe(appError);
    expect(asAppError(new Error('broken'))).toMatchObject({
      code: 'internal_error',
      message: 'An internal error occurred',
      status: 500,
    });
    expect(asAppError('broken')).toMatchObject({
      code: 'internal_error',
      message: 'An internal error occurred',
    });
  });

  it('removes partial backup files when integrity validation fails', async () => {
    const directory = temporaryDirectory();
    const database = openDatabase(':memory:');
    database.exec('CREATE TABLE sample (id INTEGER)');
    const originalPragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      source,
      options,
    ) {
      if (source === 'integrity_check') return 'corrupt';
      return originalPragma.call(this, source, options);
    });

    await expect(backupDatabase(database, directory)).rejects.toMatchObject({
      code: 'internal_error',
      status: 500,
    });
    expect(existsSync(directory)).toBe(true);
    database.close();
  });

  it('removes partial portable exports when a source read fails', () => {
    const directory = temporaryDirectory();
    const source = {
      listWorkspaces: () => [
        {
          id: 'ws',
          name: 'Workspace',
          rootPath: '/tmp/ws',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      listProjectManifests: () => {
        throw new Error('source failed');
      },
      getProject: () => {
        throw new Error('unexpected project');
      },
      listSpecManifests: () => [],
      getSpec: () => {
        throw new Error('unexpected spec');
      },
      listTaskManifests: () => [],
      getTask: () => {
        throw new Error('unexpected task');
      },
      listContextManifests: () => [],
      readContext: () => {
        throw new Error('unexpected context');
      },
    };
    expect(() => exportPortable(source, directory)).toThrow('source failed');
    expect(readdirSync(directory).some((entry) => entry.endsWith('.partial'))).toBe(false);
  });

  it('paginates portable exports until the source is exhausted', () => {
    const directory = temporaryDirectory();
    const offsets: number[] = [];
    const project = {
      id: 'project-id',
      workspaceId: 'ws',
      slug: 'project',
      title: 'Project',
      state: 'draft' as const,
      revision: 1,
      completionSummary: null,
      artifacts: [],
      completedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const source = {
      listWorkspaces: () => [
        {
          id: 'ws',
          name: 'Workspace',
          rootPath: '/tmp/ws',
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      listProjectManifests: ({ offset }: { offset: number }) => {
        offsets.push(offset);
        return offset === 0 ? Array.from({ length: 10 }, () => project) : [];
      },
      getProject: () => project,
      listSpecManifests: () => [],
      getSpec: () => {
        throw new Error('unexpected spec');
      },
      listTaskManifests: () => [],
      getTask: () => {
        throw new Error('unexpected task');
      },
      listContextManifests: () => [],
      readContext: () => {
        throw new Error('unexpected context');
      },
    };

    const exported = exportPortable(
      source as unknown as Parameters<typeof exportPortable>[0],
      directory,
    );
    expect(offsets).toEqual([0, 10]);
    expect(
      existsSync(join(exported, 'workspaces', 'ws', 'projects', 'project', 'project.json')),
    ).toBe(true);
  });

  it('streams paginated task and context collections without buffering them', () => {
    const directory = temporaryDirectory();
    const timestamp = '2026-01-01T00:00:00.000Z';
    const project = {
      id: 'project-id',
      workspaceId: 'ws',
      slug: 'streamed',
      title: 'Streamed',
      state: 'draft' as const,
      revision: 1,
      completionSummary: null,
      artifacts: [],
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const spec = {
      id: 'spec-id',
      projectId: project.id,
      slug: 'primary',
      title: 'Primary',
      body: '# Streamed',
      state: 'draft' as const,
      revision: 1,
      completionSummary: null,
      artifacts: [],
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      claim: null,
    };
    const taskOffsets: number[] = [];
    const contextOffsets: number[] = [];
    const source = {
      listWorkspaces: () => [
        {
          id: 'ws',
          name: 'Workspace',
          rootPath: '/tmp/ws',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      listProjectManifests: ({ offset }: { offset: number }) => (offset === 0 ? [project] : []),
      getProject: () => project,
      listSpecManifests: ({ offset }: { offset: number }) => (offset === 0 ? [spec] : []),
      getSpec: () => spec,
      listTaskManifests: ({ offset }: { offset: number }) => {
        taskOffsets.push(offset);
        return offset === 0
          ? Array.from({ length: 100 }, (_, index) => ({ id: `task-${index}` }))
          : [];
      },
      getTask: (id: string) => ({
        id,
        specId: spec.id,
        parentId: null,
        title: id,
        body: `Body ${id}`,
        state: 'open' as const,
        revision: 1,
        completionSummary: null,
        artifacts: [],
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        claim: null,
      }),
      listContextManifests: ({ ownerType, offset }: { ownerType: string; offset: number }) => {
        if (ownerType === 'workspace') return [];
        contextOffsets.push(offset);
        return offset === 0
          ? Array.from({ length: 100 }, (_, index) => ({ name: `document-${index}` }))
          : [];
      },
      readContext: (ownerType: 'workspace' | 'project', ownerId: string, name: string) => ({
        id: name,
        ownerType,
        ownerId,
        name,
        body: `Body ${name}`,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    };

    const exported = exportPortable(
      source as unknown as Parameters<typeof exportPortable>[0],
      directory,
    );
    expect(taskOffsets).toEqual([0, 100]);
    expect(contextOffsets).toEqual([0, 100]);
    expect(
      JSON.parse(
        readFileSync(
          join(exported, 'workspaces/ws/projects/streamed/specs/primary/tasks.json'),
          'utf8',
        ),
      ),
    ).toHaveLength(100);
    expect(
      JSON.parse(
        readFileSync(join(exported, 'workspaces/ws/projects/streamed/context.json'), 'utf8'),
      ),
    ).toHaveLength(100);
  });
});

describe('HTTP client adapter', () => {
  it('maps every gateway operation to the authenticated versioned API', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/health')) {
        return Response.json({ status: 'ok', version: '0.1.0' });
      }
      if (url.endsWith('/api/v1/overview')) {
        return Response.json({
          data: {
            daemon: {
              version: '0.1.0',
              startedAt: '2026-08-26T20:00:00.000Z',
              uptimeSeconds: 1,
            },
            generatedAt: '2026-08-26T20:00:01.000Z',
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
        });
      }
      if (url.includes('/api/v1/settings/backup')) {
        return Response.json({
          data: {
            enabled: true,
            directory: '/tmp/backups',
            snapshotPath: '/tmp/backups/pimpampum-latest.sqlite',
            state: 'healthy',
            lastAttemptAt: '2026-08-26T20:00:00.000Z',
            lastSuccessAt: '2026-08-26T20:00:00.000Z',
            error: null,
          },
        });
      }
      if (url.endsWith('/api/v1/projects/project-1') && init.method === 'GET') {
        return Response.json({ data: { id: 'project-1' } });
      }
      return Response.json({ data: { ok: true } });
    });
    const client = createHttpClient({
      host: '127.0.0.1',
      port: 7337,
      dataDirectory: '/tmp',
      databasePath: ':memory:',
      token: 'secret',
      baseUrl: 'http://127.0.0.1:7337',
    });

    await client.health();
    await client.getOverview();
    await client.getAutomaticBackupStatus();
    await client.configureAutomaticBackup('/tmp/backups');
    await client.retryAutomaticBackup();
    await client.disableAutomaticBackup();
    await client.getSyncStatus();
    await client.configureSync('/tmp/shared', 'linux');
    await client.reconcileSync();
    await client.pauseSync();
    await client.resumeSync();
    await client.forgetSync();
    await client.listSyncConflicts();
    await client.resolveSyncConflict('a'.repeat(64), 'remote');
    await client.listWorkspaces();
    await client.registerWorkspace({ id: 'ws', name: 'WS', rootPath: '/tmp/ws' });
    await client.resolveWorkspace('/tmp/ws/project');
    await client.listWork({
      workspaceId: 'ws',
      projectId: 'project-1',
      specId: 'spec-1',
      limit: 3,
    });
    await client.listWork({ workspaceId: null, projectId: null, specId: null, limit: 4 });
    await client.startWork({
      targetType: 'task',
      targetId: 'task-1',
      agentId: 'agent',
      leaseSeconds: 60,
    });
    await client.renewWork({
      targetType: 'task',
      targetId: 'task-1',
      agentId: 'agent',
      leaseSeconds: 60,
    });
    await client.releaseWork({
      targetType: 'task',
      targetId: 'task-1',
      agentId: 'agent',
      note: null,
    });
    await client.completeWork({
      targetType: 'task',
      targetId: 'task-1',
      agentId: 'agent',
      expectedRevision: 1,
      summary: 'done',
      artifacts: [],
    });
    expect(await client.getProject('project-1')).toMatchObject({ id: 'project-1' });
    await client.getProjectManifest('project-1');
    await client.getProjectCompletion('project-1');
    await client.listProjectManifests({ workspaceId: 'ws', state: 'open', limit: 10, offset: 2 });
    await client.listProjectManifests({ workspaceId: null, state: null, limit: 10, offset: 0 });
    await client.createProject({
      workspaceId: 'ws',
      slug: 'project',
      title: 'Project',
      actor: null,
    });
    await client.updateProject({
      projectId: 'project-1',
      title: 'Updated',
      state: 'open',
      expectedRevision: 1,
      actor: 'agent',
    });
    await client.completeProject({
      projectId: 'project-1',
      expectedRevision: 2,
      summary: 'Outcome shipped',
      artifacts: [],
      actor: 'agent',
    });
    await client.cancelProject({
      projectId: 'project-1',
      expectedRevision: 2,
      reason: 'No longer needed',
      actor: 'agent',
    });
    await client.createSpec({
      projectId: 'project-1',
      slug: 'feature',
      title: 'Feature',
      body: '# Spec',
      actor: null,
    });
    await client.getSpec('spec-1');
    await client.getSpecManifest('spec-1');
    await client.readSpecBody('spec-1', 2, 20);
    await client.getSpecCompletion('spec-1');
    await client.listSpecManifests({
      projectId: 'project-1',
      state: 'ready',
      limit: 10,
      offset: 0,
    });
    await client.listSpecManifests({
      projectId: 'project-1',
      state: null,
      limit: 5,
      offset: 1,
    });
    await client.updateSpec({
      specId: 'spec-1',
      title: 'Updated feature',
      body: '# Updated spec',
      state: 'ready',
      expectedRevision: 1,
      actor: 'agent',
    });
    await client.cancelSpec({
      specId: 'spec-1',
      expectedRevision: 2,
      reason: 'Superseded',
      actor: 'agent',
    });
    await client.createTask({
      specId: 'spec-1',
      parentId: null,
      title: 'Task',
      body: null,
      actor: null,
    });
    await client.getTask('task-1');
    await client.getTaskManifest('task-1');
    await client.readTaskBody('task-1', 3, 30);
    await client.getTaskCompletion('task-1');
    await client.listTaskManifests({ specId: 'spec-1', limit: 10, offset: 0 });
    await client.updateTask({
      taskId: 'task-1',
      title: null,
      body: 'Body',
      expectedRevision: 1,
      actor: null,
    });
    await client.cancelTask({
      taskId: 'task-1',
      expectedRevision: 2,
      reason: 'Superseded',
      actor: null,
    });
    await client.listContextManifests({
      ownerType: 'project',
      ownerId: 'project-1',
      limit: 10,
      offset: 0,
    });
    await client.getContextManifest('workspace', 'ws', 'shared architecture');
    await client.getContextManifest('project', 'project-1', 'architecture notes');
    await client.readContextPage('project', 'project-1', 'architecture notes', 4, 40);
    await client.putContext({
      ownerType: 'project',
      ownerId: 'project-1',
      name: 'architecture notes',
      body: '# Notes',
      expectedRevision: null,
      actor: null,
    });
    await client.listActivity('project-1', 20);
    await client.backup('/tmp/backups');
    await client.exportPortable('/tmp/exports');

    expect(calls).toHaveLength(57);
    expect(new Headers(calls[0]?.init.headers).has('authorization')).toBe(false);
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe('Bearer secret');
    expect(calls[1]?.url).toBe('http://127.0.0.1:7337/api/v1/overview');
    expect(calls.some(({ url }) => url.endsWith('/work?limit=4'))).toBe(true);
    expect(
      calls.some(({ url }) =>
        url.endsWith('/work?limit=3&workspaceId=ws&projectId=project-1&specId=spec-1'),
      ),
    ).toBe(true);
    expect(
      calls.some(({ url }) =>
        url.endsWith('/projects?limit=10&offset=2&workspaceId=ws&state=open'),
      ),
    ).toBe(true);
    expect(calls.some(({ url }) => url.includes('/projects/project-1/specs?'))).toBe(true);
    expect(calls.some(({ url }) => url.includes('/specs/spec-1/body?'))).toBe(true);
    expect(calls.some(({ url }) => url.includes('/specs/spec-1/tasks?'))).toBe(true);
    expect(calls.some(({ url }) => url.includes('/projects/project-1/context?'))).toBe(true);
    expect(
      calls.some(({ url }) => url.includes('/workspaces/ws/context/shared%20architecture')),
    ).toBe(true);
    expect(calls.every(({ url }) => !url.includes('/prd'))).toBe(true);
    expect(
      calls.some(
        ({ url, init }) =>
          url.endsWith('/api/v1/projects') &&
          init.method === 'POST' &&
          !String(init.body).includes('prd'),
      ),
    ).toBe(true);
    expect(calls.some(({ url }) => url.includes('architecture%20notes'))).toBe(true);
    expect(calls.some(({ init }) => init.body !== undefined)).toBe(true);
  });

  it('preserves typed API errors and safely defaults malformed errors', async () => {
    const responses = [
      Response.json(
        {
          error: {
            code: 'revision_conflict',
            message: 'stale',
            retryable: true,
            details: { currentRevision: 2 },
          },
        },
        { status: 409 },
      ),
      Response.json({ error: { code: 'surprise' } }, { status: 418 }),
      Response.json({}, { status: 500 }),
    ];
    vi.stubGlobal('fetch', async () => responses.shift() as Response);
    const client = new PimpampumHttpClient('http://127.0.0.1:7337', 'secret');

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: 'revision_conflict',
      message: 'stale',
      retryable: true,
      details: { currentRevision: 2 },
    });
    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: 'bad_request',
      message: 'HTTP 418',
    });
    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: 'internal_error',
      message: 'HTTP 500',
      retryable: true,
      details: {},
    });
  });

  it('maps status fallbacks, network failures and invalid success envelopes', async () => {
    const failures = [401, 403, 404, 409, 413].map(
      (status) => new Response('<html>failure</html>', { status }),
    );
    vi.stubGlobal('fetch', async () => failures.shift() as Response);
    const client = new PimpampumHttpClient('http://127.0.0.1:7337', 'secret', 1);
    for (const code of [
      'unauthorized',
      'unauthorized',
      'not_found',
      'conflict',
      'payload_too_large',
    ]) {
      await expect(client.listWorkspaces()).rejects.toMatchObject({ code });
    }

    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: 'internal_error',
      status: 503,
      retryable: true,
    });

    const invalidApiResponses = [
      new Response('', { status: 200 }),
      Response.json('primitive'),
      Response.json(null),
      Response.json({ unexpected: true }),
    ];
    vi.stubGlobal('fetch', async () => invalidApiResponses.shift() as Response);
    for (let index = 0; index < 4; index += 1) {
      await expect(client.listWorkspaces()).rejects.toMatchObject({ status: 502 });
    }

    const invalidHealthResponses = [
      new Response('', { status: 200 }),
      Response.json(null),
      Response.json({ status: 1, version: '0.1.0' }),
      Response.json({ status: 'ok', version: 1 }),
    ];
    vi.stubGlobal('fetch', async () => invalidHealthResponses.shift() as Response);
    for (let index = 0; index < 4; index += 1) {
      await expect(client.health()).rejects.toMatchObject({ status: 502 });
    }
  });
});
