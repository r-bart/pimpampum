import { describe, expect, it, vi } from 'vitest';
import type { PimpampumHttpClient } from '../src/client.js';
import {
  createLazyGateway,
  MAX_AGENT_INPUT_BYTES,
  MAX_BODY_FILE_BYTES,
  runCli,
  type CliRuntime,
} from '../src/cliProgram.js';
import { AppError } from '../src/errors.js';

function fixture() {
  const client = {
    health: vi.fn(async () => ({ status: 'ok', version: '1.0.0' })),
    getOverview: vi.fn(async () => ({ status: 'empty' })),
    listWorkspaces: vi.fn(async () => []),
    registerWorkspace: vi.fn(async (input: unknown) => input),
    listWork: vi.fn(async () => []),
    startWork: vi.fn(async (input: unknown) => input),
    renewWork: vi.fn(async (input: unknown) => input),
    releaseWork: vi.fn(async () => undefined),
    completeWork: vi.fn(async (input: unknown) => input),
    createProject: vi.fn(async (input: unknown) => input),
    getProject: vi.fn(async (id: string) => ({ id })),
    updateProject: vi.fn(async (input: unknown) => input),
    completeProject: vi.fn(async (input: unknown) => input),
    cancelProject: vi.fn(async (input: unknown) => input),
    createSpec: vi.fn(async (input: unknown) => input),
    getSpec: vi.fn(async (id: string) => ({ id })),
    updateSpec: vi.fn(async (input: unknown) => input),
    cancelSpec: vi.fn(async (input: unknown) => input),
    createTask: vi.fn(async (input: unknown) => input),
    getTask: vi.fn(async (id: string) => ({ id })),
    cancelTask: vi.fn(async (input: unknown) => input),
    backup: vi.fn(async (directory: string) => ({ path: directory })),
    getAutomaticBackupStatus: vi.fn(async () => ({ state: 'disabled', enabled: false })),
    configureAutomaticBackup: vi.fn(async (directory: string) => ({
      state: 'healthy',
      enabled: true,
      directory,
    })),
    retryAutomaticBackup: vi.fn(async () => ({ state: 'healthy', enabled: true })),
    disableAutomaticBackup: vi.fn(async () => ({ state: 'disabled', enabled: false })),
    getSyncStatus: vi.fn(async () => ({ state: 'disabled', enabled: false })),
    configureSync: vi.fn(async (directory: string, deviceId: string) => ({
      state: 'healthy',
      enabled: true,
      directory,
      deviceId,
    })),
    reconcileSync: vi.fn(async () => ({ state: 'healthy', enabled: true })),
    pauseSync: vi.fn(async () => ({ state: 'paused', enabled: true })),
    resumeSync: vi.fn(async () => ({ state: 'healthy', enabled: true })),
    listSyncConflicts: vi.fn(async () => []),
    resolveSyncConflict: vi.fn(async () => ({ state: 'healthy', enabled: true })),
    forgetSync: vi.fn(async () => ({ state: 'disabled', enabled: false })),
    exportPortable: vi.fn(async (directory: string) => ({ path: directory })),
  } as unknown as PimpampumHttpClient;
  const output: string[] = [];
  const errors: string[] = [];
  const signals = new Map<string, () => void>();
  const close = vi.fn(async () => undefined);
  const agentClient = {
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"data":{}}' }],
    })),
    close: vi.fn(async () => undefined),
  };
  const runtime: CliRuntime = {
    createClient: () => client,
    createAgentClient: vi.fn(async () => agentClient),
    describeConfig: vi.fn(() => ({
      dataDirectory: '/data',
      databasePath: '/data/pimpampum.sqlite',
      baseUrl: 'http://127.0.0.1:7337',
      tokenPath: '/data/token',
      tokenSource: 'file' as const,
      tokenConfigured: true,
      mcp: {
        streamableHttpUrl: 'http://127.0.0.1:7337/mcp',
        stdio: { command: '/node', args: ['/mcpStdio.js'] },
      },
    })),
    serviceManager: {
      install: vi.fn(async () => ({
        installed: true as const,
        reconciled: false,
        receiptPath: '/receipt',
      })),
      status: vi.fn(async () => ({
        installed: true,
        running: true,
        adapter: 'test',
        version: '1.0.0',
      })),
      uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
    },
    updateManager: {
      check: vi.fn(async () => ({
        currentVersion: '1.1.0',
        latestVersion: '1.1.0',
        updateAvailable: false,
      })),
      update: vi.fn(async () => ({
        currentVersion: '1.1.0',
        latestVersion: '1.1.0',
        updateAvailable: false,
        updated: false,
        installedVersion: '1.1.0',
        serviceReconciled: true,
      })),
    },
    serviceOnlyManager: {
      install: vi.fn(async () => ({
        installed: true as const,
        reconciled: false,
        receiptPath: '/service-only-receipt',
      })),
      status: vi.fn(async () => ({
        installed: true,
        running: true,
        adapter: 'launchd',
        version: '1.0.0',
      })),
      uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
    },
    startStdioBridge: vi.fn(async () => undefined),
    startServer: vi.fn(async () => ({ config: { baseUrl: 'http://127.0.0.1:7337' }, close })),
    readFile: vi.fn(() => '# Spec'),
    readStdin: vi.fn(() => '{}'),
    resolvePath: (path) => `/resolved/${path}`,
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    onSignal: (signal, callback) => signals.set(signal, callback),
    exit: vi.fn(() => undefined as never),
  };
  return { agentClient, client, close, errors, output, runtime, signals };
}

describe('CLI program', () => {
  // One row per CLI verb: the argv, the exact gateway method it must reach, and the exact
  // arguments that method receives. Swapping a state literal, a default lease or a resolved path
  // in `src/cliProgram.ts` fails the row that names it.
  type ClientMethod = keyof ReturnType<typeof fixture>['client'];
  type ManagerMethod =
    | 'serviceManager.install'
    | 'serviceManager.status'
    | 'serviceManager.uninstall'
    | 'updateManager.check'
    | 'updateManager.update';
  const conflictId = 'a'.repeat(64);
  const commandTable: Array<[string[], ClientMethod | ManagerMethod, unknown[]]> = [
    [['health'], 'health', []],
    [['overview'], 'getOverview', []],
    [['install'], 'serviceManager.install', []],
    [['status'], 'serviceManager.status', []],
    [['update:check'], 'updateManager.check', []],
    [['update'], 'updateManager.update', []],
    [['uninstall'], 'serviceManager.uninstall', []],
    [['workspace:list'], 'listWorkspaces', []],
    [
      ['workspace:add', 'ws', 'Workspace', 'root'],
      'registerWorkspace',
      [{ id: 'ws', name: 'Workspace', rootPath: '/resolved/root' }],
    ],
    [['work:list'], 'listWork', [{ workspaceId: null, projectId: null, specId: null, limit: 50 }]],
    [
      ['work:list', 'ws'],
      'listWork',
      [{ workspaceId: 'ws', projectId: null, specId: null, limit: 50 }],
    ],
    [
      ['work:list', 'ws', 'project-id', 'spec-id', '--limit', '7'],
      'listWork',
      [{ workspaceId: 'ws', projectId: 'project-id', specId: 'spec-id', limit: 7 }],
    ],
    [
      ['work:start', 'spec', 'spec-id', 'agent'],
      'startWork',
      [{ targetType: 'spec', targetId: 'spec-id', agentId: 'agent', leaseSeconds: 1_800 }],
    ],
    [
      ['work:start', 'task', 'task-id', 'agent', '--lease-seconds', '60'],
      'startWork',
      [{ targetType: 'task', targetId: 'task-id', agentId: 'agent', leaseSeconds: 60 }],
    ],
    [
      ['work:renew', 'spec', 'spec-id', 'agent'],
      'renewWork',
      [{ targetType: 'spec', targetId: 'spec-id', agentId: 'agent', leaseSeconds: 1_800 }],
    ],
    [
      ['work:release', 'spec', 'spec-id', 'agent'],
      'releaseWork',
      [{ targetType: 'spec', targetId: 'spec-id', agentId: 'agent', note: null }],
    ],
    [
      ['work:release', 'task', 'task-id', 'agent', 'handoff'],
      'releaseWork',
      [{ targetType: 'task', targetId: 'task-id', agentId: 'agent', note: 'handoff' }],
    ],
    [
      ['work:complete', 'task', 'task-id', 'agent', '2', 'done'],
      'completeWork',
      [
        {
          targetType: 'task',
          targetId: 'task-id',
          agentId: 'agent',
          expectedRevision: 2,
          summary: 'done',
          artifacts: [],
        },
      ],
    ],
    [
      ['work:complete', 'spec', 'spec-id', 'agent', '3', 'shipped', '--artifact', 'git:abc'],
      'completeWork',
      [
        {
          targetType: 'spec',
          targetId: 'spec-id',
          agentId: 'agent',
          expectedRevision: 3,
          summary: 'shipped',
          artifacts: [{ label: null, uri: 'git:abc' }],
        },
      ],
    ],
    [
      ['project:create', 'ws', 'slug', 'Title'],
      'createProject',
      [{ workspaceId: 'ws', slug: 'slug', title: 'Title', actor: 'cli' }],
    ],
    [
      ['project:create', 'ws', 'slug', 'Title', '--actor', 'codex'],
      'createProject',
      [{ workspaceId: 'ws', slug: 'slug', title: 'Title', actor: 'codex' }],
    ],
    [['project:get', 'project-id'], 'getProject', ['project-id']],
    [
      ['project:draft', 'project-id', '2'],
      'updateProject',
      [{ projectId: 'project-id', title: null, state: 'draft', expectedRevision: 2, actor: 'cli' }],
    ],
    [
      ['project:open', 'project-id', '3'],
      'updateProject',
      [{ projectId: 'project-id', title: null, state: 'open', expectedRevision: 3, actor: 'cli' }],
    ],
    [
      ['project:pause', 'project-id', '4'],
      'updateProject',
      [
        {
          projectId: 'project-id',
          title: null,
          state: 'paused',
          expectedRevision: 4,
          actor: 'cli',
        },
      ],
    ],
    [
      ['project:complete', 'project-id', '5', 'Outcome shipped'],
      'completeProject',
      [
        {
          projectId: 'project-id',
          expectedRevision: 5,
          summary: 'Outcome shipped',
          artifacts: [],
          actor: 'cli',
        },
      ],
    ],
    [
      ['project:cancel', 'project-id', '5', 'Outcome abandoned'],
      'cancelProject',
      [{ projectId: 'project-id', expectedRevision: 5, reason: 'Outcome abandoned', actor: 'cli' }],
    ],
    [
      ['spec:create', 'project-id', 'feature', 'Feature'],
      'createSpec',
      [{ projectId: 'project-id', slug: 'feature', title: 'Feature', body: '', actor: 'cli' }],
    ],
    [
      ['spec:create', 'project-id', 'feature-with-body', 'Feature with body', 'spec.md'],
      'createSpec',
      [
        {
          projectId: 'project-id',
          slug: 'feature-with-body',
          title: 'Feature with body',
          body: '# Spec',
          actor: 'cli',
        },
      ],
    ],
    [['spec:get', 'spec-id'], 'getSpec', ['spec-id']],
    [
      ['spec:draft', 'spec-id', '2'],
      'updateSpec',
      [
        {
          specId: 'spec-id',
          title: null,
          body: null,
          state: 'draft',
          expectedRevision: 2,
          actor: 'cli',
        },
      ],
    ],
    [
      ['spec:ready', 'spec-id', '3'],
      'updateSpec',
      [
        {
          specId: 'spec-id',
          title: null,
          body: null,
          state: 'ready',
          expectedRevision: 3,
          actor: 'cli',
        },
      ],
    ],
    [
      ['spec:cancel', 'spec-id', '4', 'No longer required'],
      'cancelSpec',
      [{ specId: 'spec-id', expectedRevision: 4, reason: 'No longer required', actor: 'cli' }],
    ],
    [
      ['task:create', 'spec-id', 'Task'],
      'createTask',
      [{ specId: 'spec-id', title: 'Task', parentId: null, body: null, actor: 'cli' }],
    ],
    [
      ['task:create', 'spec-id', 'Subtask', 'parent-id'],
      'createTask',
      [{ specId: 'spec-id', title: 'Subtask', parentId: 'parent-id', body: null, actor: 'cli' }],
    ],
    [['task:get', 'task-id'], 'getTask', ['task-id']],
    [
      ['task:cancel', 'task-id', '2', 'Superseded'],
      'cancelTask',
      [{ taskId: 'task-id', expectedRevision: 2, reason: 'Superseded', actor: 'cli' }],
    ],
    [['backup', 'backups'], 'backup', ['/resolved/backups']],
    [['backup', 'status', '--json'], 'getAutomaticBackupStatus', []],
    [
      ['backup', 'configure', 'cloud backup', '--json'],
      'configureAutomaticBackup',
      ['/resolved/cloud backup'],
    ],
    [['backup', 'retry', '--json'], 'retryAutomaticBackup', []],
    [['backup', 'disable', '--json'], 'disableAutomaticBackup', []],
    [['sync', 'status', '--json'], 'getSyncStatus', []],
    [
      ['sync', 'configure', 'shared folder', '--device', 'linux-test', '--json'],
      'configureSync',
      ['/resolved/shared folder', 'linux-test'],
    ],
    [['sync', 'now', '--json'], 'reconcileSync', []],
    [['sync', 'pause', '--json'], 'pauseSync', []],
    [['sync', 'resume', '--json'], 'resumeSync', []],
    [['sync', 'conflicts', '--json'], 'listSyncConflicts', []],
    [
      ['sync', 'resolve', conflictId, 'local', '--json'],
      'resolveSyncConflict',
      [conflictId, 'local'],
    ],
    [['sync', 'forget', '--json'], 'forgetSync', []],
    [['export', 'exports'], 'exportPortable', ['/resolved/exports']],
  ];

  function resolveMethod(state: ReturnType<typeof fixture>, method: ClientMethod | ManagerMethod) {
    if (method.startsWith('serviceManager.') || method.startsWith('updateManager.')) {
      const [owner, name] = method.split('.') as ['serviceManager' | 'updateManager', string];
      return (state.runtime[owner] as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]!;
    }
    return state.client[method as ClientMethod] as unknown as ReturnType<typeof vi.fn>;
  }

  it.each(commandTable)(
    '%j reaches %s with the exact arguments',
    async (argv, method, expectedArguments) => {
      const state = fixture();
      await runCli(argv, state.runtime);

      expect(state.errors).toEqual([]);
      expect(state.runtime.exit).not.toHaveBeenCalled();
      const target = resolveMethod(state, method);
      expect(target).toHaveBeenCalledTimes(1);
      expect(target.mock.calls[0]).toEqual(expectedArguments);
      // Exactly one gateway method ran; no verb fans out to a second call behind the caller's back.
      const clientCalls = Object.entries(state.client as unknown as Record<string, unknown>)
        .filter(([, value]) => vi.isMockFunction(value) && value.mock.calls.length > 0)
        .map(([name]) => name);
      expect(clientCalls).toEqual(method.includes('.') ? [] : [method]);
      // Success is printed once, through the `{data}` envelope the desktop adapters parse.
      expect(state.output).toHaveLength(1);
      expect(Object.keys(JSON.parse(state.output[0] ?? ''))).toEqual(['data']);
    },
  );

  it('covers every catalogued daemon and service verb in the mapping table', () => {
    const verbs = new Set(
      commandTable.map(([argv]) =>
        argv.slice(0, argv[0] === 'backup' || argv[0] === 'sync' ? 2 : 1).join(' '),
      ),
    );
    // `backup <directory>` is the bare verb; its subcommands are rows of their own.
    verbs.add('backup');
    for (const verb of [
      'health',
      'overview',
      'install',
      'status',
      'update:check',
      'update',
      'uninstall',
      'workspace:list',
      'workspace:add',
      'work:list',
      'work:start',
      'work:renew',
      'work:release',
      'work:complete',
      'project:create',
      'project:get',
      'project:draft',
      'project:open',
      'project:pause',
      'project:complete',
      'project:cancel',
      'spec:create',
      'spec:get',
      'spec:draft',
      'spec:ready',
      'spec:cancel',
      'task:create',
      'task:get',
      'task:cancel',
      'backup',
      'backup status',
      'backup configure',
      'backup retry',
      'backup disable',
      'sync status',
      'sync configure',
      'sync now',
      'sync pause',
      'sync resume',
      'sync conflicts',
      'sync resolve',
      'sync forget',
      'export',
    ]) {
      expect(verbs, `missing table row for ${verb}`).toContain(verb);
    }
  });

  // A retry that ends in `state: 'error'` is a successful report: the daemon answered 200 and the
  // payload carries the failure. The desktop cards read `state` and `error` from the data; exit 1
  // would replace that data with a generic envelope.
  it('returns the automatic backup status as data even when the retry reports an error', async () => {
    const state = fixture();
    state.client.retryAutomaticBackup = vi.fn(async () => ({
      state: 'error',
      enabled: true,
      error: 'cloud volume unavailable',
    })) as never;

    await runCli(['backup', 'retry', '--json'], state.runtime);

    expect(state.errors).toEqual([]);
    expect(state.runtime.exit).not.toHaveBeenCalled();
    expect(JSON.parse(state.output[0] ?? '')).toEqual({
      data: { state: 'error', enabled: true, error: 'cloud volume unavailable' },
    });
  });

  it('reads --body-file through the bounded reader and names an unreadable path', async () => {
    const state = fixture();
    await runCli(
      ['spec:create', 'project-id', 'feature', 'Feature', '--body-file', 'spec.md'],
      state.runtime,
    );
    await runCli(['task:create', 'spec-id', 'Task', '--body-file', 'task.md'], state.runtime);
    expect(state.runtime.readFile).toHaveBeenCalledWith('/resolved/spec.md', MAX_BODY_FILE_BYTES);
    expect(state.runtime.readFile).toHaveBeenCalledWith('/resolved/task.md', MAX_BODY_FILE_BYTES);
    expect(MAX_BODY_FILE_BYTES).toBe(1_000_000);

    const unreadable = fixture();
    unreadable.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(unreadable.runtime, 'readFile').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(
      runCli(['task:create', 'spec-id', 'Task', '--body-file', 'missing.md'], unreadable.runtime),
    ).rejects.toThrow('exit:1');
    expect(JSON.parse(unreadable.errors[0] ?? '')).toMatchObject({
      error: {
        code: 'bad_request',
        message: 'Could not read body file: /resolved/missing.md',
        details: { path: '/resolved/missing.md' },
      },
    });
    expect(unreadable.client.createTask).not.toHaveBeenCalled();

    const bounded = fixture();
    bounded.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(bounded.runtime, 'readFile').mockImplementationOnce(() => {
      throw new AppError('payload_too_large', 'File exceeds 1000000 UTF-8 bytes', 413);
    });
    await expect(
      runCli(['spec:create', 'project-id', 'feature', 'Feature', 'huge.md'], bounded.runtime),
    ).rejects.toThrow('exit:1');
    expect(JSON.parse(bounded.errors[0] ?? '')).toMatchObject({
      error: { code: 'payload_too_large' },
    });
  });

  it('routes the macOS onboarding install flag to the service-only manager', async () => {
    const state = fixture();

    await runCli(['install', '--service-only'], state.runtime);

    expect(state.runtime.serviceOnlyManager?.install).toHaveBeenCalledOnce();
    expect(state.runtime.serviceManager.install).not.toHaveBeenCalled();
    expect(JSON.parse(state.output[0] ?? '')).toMatchObject({
      data: { installed: true, receiptPath: '/service-only-receipt' },
    });
  });

  it('reports the real message and cause when a service lifecycle command throws a plain Error', async () => {
    const state = fixture();
    state.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    state.runtime.serviceManager.install = vi.fn(async () => {
      throw new Error('Unable to activate the LaunchAgent', {
        cause: new Error('launchctl bootstrap failed with exit code 5: Input/output error'),
      });
    });

    await expect(runCli(['install'], state.runtime)).rejects.toThrow('exit:1');

    expect(JSON.parse(state.errors[0] ?? '')).toMatchObject({
      error: {
        code: 'internal_error',
        message: 'Unable to activate the LaunchAgent',
        details: {
          name: 'Error',
          causes: ['launchctl bootstrap failed with exit code 5: Input/output error'],
        },
      },
    });
  });

  it('reports every redacted setup aggregate member through the local boundary', async () => {
    const state = fixture();
    state.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    state.runtime.setup = {
      plan: vi.fn(async () => ({})),
      apply: vi.fn(async () => {
        throw new AggregateError(
          [new Error('daemon failed: Bearer private-token'), new Error('rollback bootout failed')],
          'Service installation and rollback failed',
        );
      }),
      status: vi.fn(async () => null),
      resume: vi.fn(async () => null),
      retryConnector: vi.fn(async () => null),
    };

    await expect(
      runCli(['setup', 'apply', 'operation-id', 'revision', '--yes'], state.runtime),
    ).rejects.toThrow('exit:1');

    expect(JSON.parse(state.errors[0] ?? '')).toMatchObject({
      error: {
        message: 'Service installation and rollback failed',
        details: {
          name: 'AggregateError',
          causes: ['daemon failed: [credential redacted]', 'rollback bootout failed'],
        },
      },
    });
  });

  it('treats service-only as the ordinary service install when no platform UI manager exists', async () => {
    const state = fixture();
    delete state.runtime.serviceOnlyManager;

    await runCli(['install', '--service-only'], state.runtime);

    expect(state.runtime.serviceManager.install).toHaveBeenCalledOnce();
  });

  it('rejects unsupported install flags before changing service state', async () => {
    const state = fixture();
    state.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });

    await expect(runCli(['install', '--unknown'], state.runtime)).rejects.toThrow('exit:1');
    await expect(
      runCli(['install', '--service-only', '--service-only'], state.runtime),
    ).rejects.toThrow('exit:1');
    await expect(runCli(['install', 'extra'], state.runtime)).rejects.toThrow('exit:1');

    expect(state.runtime.serviceManager.install).not.toHaveBeenCalled();
    expect(state.runtime.serviceOnlyManager?.install).not.toHaveBeenCalled();
    const messages = state.errors.map((entry) => JSON.parse(entry).error.message as string);
    expect(messages).toEqual([
      'Unknown option for install: --unknown',
      'Repeated option: --service-only',
      'install accepts at most 0 positional arguments',
    ]);
  });

  it('rejects ambiguous automatic backup subcommand arguments before transport', async () => {
    const state = fixture();
    state.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });

    await expect(runCli(['backup', 'status', 'unexpected'], state.runtime)).rejects.toThrow(
      'exit:1',
    );
    await expect(runCli(['backup', 'disable', '--json', '--json'], state.runtime)).rejects.toThrow(
      'exit:1',
    );
    await expect(
      runCli(['backup', 'configure', '/backup', '--pretty'], state.runtime),
    ).rejects.toThrow('exit:1');
    await expect(runCli(['backup', 'configure'], state.runtime)).rejects.toThrow('exit:1');
    await expect(runCli(['backup'], state.runtime)).rejects.toThrow('exit:1');
    await expect(runCli(['backup', '--json'], state.runtime)).rejects.toThrow('exit:1');
    expect(state.client.getAutomaticBackupStatus).not.toHaveBeenCalled();
    expect(state.client.configureAutomaticBackup).not.toHaveBeenCalled();
    expect(state.client.disableAutomaticBackup).not.toHaveBeenCalled();
    expect(state.client.backup).not.toHaveBeenCalled();
    const messages = state.errors.map((entry) => JSON.parse(entry).error.message as string);
    expect(messages).toEqual([
      'backup status accepts at most 0 positional arguments',
      'Repeated option: --json',
      'Unknown option for backup configure: --pretty',
      'Missing backup directory',
      'Missing backup directory',
      'Unknown option for backup: --json',
    ]);
  });

  it('rejects malformed and unknown synchronization commands before transport', async () => {
    const state = fixture();
    state.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    await expect(runCli(['sync', 'configure', '/shared'], state.runtime)).rejects.toThrow('exit:1');
    await expect(runCli(['sync', 'configure', '--device', 'x'], state.runtime)).rejects.toThrow(
      'exit:1',
    );
    await expect(runCli(['sync', 'resolve', 'conflict', 'either'], state.runtime)).rejects.toThrow(
      'exit:1',
    );
    await expect(runCli(['sync', 'resolve', 'conflict'], state.runtime)).rejects.toThrow('exit:1');
    await expect(runCli(['sync', 'wat'], state.runtime)).rejects.toThrow('exit:1');
    await expect(runCli(['sync'], state.runtime)).rejects.toThrow('exit:1');
    await expect(runCli(['sync', 'now', 'extra'], state.runtime)).rejects.toThrow('exit:1');
    expect(state.client.configureSync).not.toHaveBeenCalled();
    expect(state.client.resolveSyncConflict).not.toHaveBeenCalled();
    expect(state.client.reconcileSync).not.toHaveBeenCalled();
    const failures = state.errors.map(
      (entry) => JSON.parse(entry).error as { message: string; details: { usage?: string } },
    );
    expect(failures.map((failure) => failure.message)).toEqual([
      'sync configure requires --device <id>',
      'Missing shared folder',
      'Conflict choice must be local or remote',
      'Missing conflict choice',
      'Unknown sync action: wat',
      'Missing sync action',
      'sync now accepts at most 0 positional arguments',
    ]);
    expect(failures[0]?.details.usage).toBe(
      'pimpampum sync configure <directory> --device <id> [--json]',
    );
    expect(failures[4]?.details.usage).toContain('Usage:');
  });

  it('accepts the declared backup and sync options in any order', async () => {
    const state = fixture();
    await runCli(['sync', 'configure', '--json', '/shared', '--device', 'laptop'], state.runtime);
    await runCli(['backup', 'configure', '--json', '/backup'], state.runtime);
    expect(state.client.configureSync).toHaveBeenCalledWith('/resolved//shared', 'laptop');
    expect(state.client.configureAutomaticBackup).toHaveBeenCalledWith('/resolved//backup');
    expect(state.errors).toEqual([]);
  });

  it('rejects a declared multi-token name passed as one token', async () => {
    const state = fixture();
    state.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    await expect(runCli(['setup plan'], state.runtime)).rejects.toThrow('exit:1');
    expect(JSON.parse(state.errors[0] ?? '')).toMatchObject({
      error: { code: 'bad_request', message: 'Unknown command: setup plan' },
    });
  });

  it('starts the server and closes it through either signal', async () => {
    const state = fixture();
    await runCli(['serve'], state.runtime);
    expect(state.output[0]).toContain('http://127.0.0.1:7337');
    state.signals.get('SIGINT')?.();
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledTimes(1));
    state.signals.get('SIGTERM')?.();
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledTimes(2));
    expect(state.runtime.exit).toHaveBeenCalledWith(0);
  });

  it('prints usage and validates required arguments, target types and revisions', async () => {
    const state = fixture();
    state.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    await expect(runCli([], state.runtime)).rejects.toThrow('exit:1');
    await expect(runCli(['unknown'], state.runtime)).rejects.toThrow('exit:1');
    expect(state.errors).toHaveLength(2);
    expect(state.errors.every((error) => JSON.parse(error).error.code === 'bad_request')).toBe(
      true,
    );

    const validation = fixture();
    validation.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    await expect(runCli(['workspace:add'], validation.runtime)).rejects.toThrow('exit:1');
    await expect(
      runCli(['work:start', 'invalid', 'target', 'agent'], validation.runtime),
    ).rejects.toThrow('exit:1');
    await expect(
      runCli(['work:complete', 'task', 'target', 'agent', 'nope', 'done'], validation.runtime),
    ).rejects.toThrow('exit:1');
    await expect(runCli(['spec:ready', 'spec', '0'], validation.runtime)).rejects.toThrow('exit:1');
    expect(validation.errors.join('\n')).toContain('Missing workspace id');
    expect(validation.errors.join('\n')).toContain('Target type must be spec or task');
    expect(validation.errors.join('\n')).toContain('Revision must be a positive integer');
  });

  it('prints help and ignores a transport cleanup failure after listing tools', async () => {
    const help = fixture();
    await runCli(['help'], help.runtime);
    expect(help.output).toEqual([expect.stringContaining('pimpampum call')]);

    const tools = fixture();
    tools.agentClient.close.mockRejectedValueOnce(new Error('close failed'));
    await runCli(['tools'], tools.runtime);
    expect(tools.output).toEqual([expect.stringContaining('"tools"')]);
    expect(tools.agentClient.close).toHaveBeenCalledOnce();
  });

  it('rejects unreadable and oversized agent input before connecting', async () => {
    const unreadable = fixture();
    unreadable.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(unreadable.runtime, 'readFile').mockImplementationOnce(() => {
      throw new Error('unreadable');
    });
    await expect(
      runCli(['call', 'work_list', '--input-file', 'missing.json'], unreadable.runtime),
    ).rejects.toThrow('exit:1');
    expect(unreadable.errors.join('\n')).toContain('Could not read tool input file');

    const bounded = fixture();
    bounded.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(bounded.runtime, 'readFile').mockImplementationOnce(() => {
      throw new AppError('payload_too_large', 'bounded read rejected the input', 413);
    });
    await expect(
      runCli(['call', 'context_put', '--input-file', 'large.json'], bounded.runtime),
    ).rejects.toThrow('exit:1');
    expect(bounded.errors.join('\n')).toContain('payload_too_large');
    expect(bounded.runtime.createAgentClient).not.toHaveBeenCalled();

    const oversized = fixture();
    oversized.runtime.exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    const input = JSON.stringify({ body: 'x'.repeat(MAX_AGENT_INPUT_BYTES) });
    await expect(
      runCli(['call', 'context_put', '--input', input], oversized.runtime),
    ).rejects.toThrow('exit:1');
    expect(oversized.errors.join('\n')).toContain('payload_too_large');
    expect(oversized.runtime.createAgentClient).not.toHaveBeenCalled();
  });

  // The stdio bridge can outlive the daemon's first start, so its gateway resolves the real client
  // on every call: a missing token fails typed inside the handler, and the token that appears
  // later is adopted without restarting the host.
  it('resolves the gateway on every call so a late daemon token is adopted', async () => {
    const first = { health: vi.fn(async () => ({ status: 'ok', version: '1' })) };
    const second = { health: vi.fn(async () => ({ status: 'ok', version: '2' })) };
    let target: typeof first | null = null;
    const gateway = createLazyGateway<typeof first>(() => {
      if (target === null) throw new AppError('unavailable', 'No daemon token at /data/token', 503);
      return target;
    });

    // The resolver throws synchronously inside the call; the MCP `execute` boundary runs every
    // handler inside its `try`, so the throw becomes that tool's typed failure envelope.
    expect(() => gateway.health()).toThrow(
      expect.objectContaining({ code: 'unavailable', message: 'No daemon token at /data/token' }),
    );
    target = first;
    await expect(gateway.health()).resolves.toEqual({ status: 'ok', version: '1' });
    target = second;
    await expect(gateway.health()).resolves.toEqual({ status: 'ok', version: '2' });
    expect(first.health).toHaveBeenCalledOnce();
    expect(second.health).toHaveBeenCalledOnce();
    expect(second.health.mock.contexts[0]).toBe(second);

    expect((gateway as unknown as { then?: unknown }).then).toBeUndefined();
    expect((gateway as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
    const missing = gateway as unknown as { absent(): unknown };
    expect(() => missing.absent()).toThrow(/Gateway has no method absent/u);
  });
});
