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
  it('maps every command through the injected runtime', async () => {
    const state = fixture();
    const commands: string[][] = [
      ['health'],
      ['overview'],
      ['install'],
      ['status'],
      ['update:check'],
      ['update'],
      ['uninstall'],
      ['workspace:list'],
      ['workspace:add', 'ws', 'Workspace', 'root'],
      ['work:list'],
      ['work:list', 'ws'],
      ['work:list', 'ws', 'project-id', 'spec-id'],
      ['work:start', 'spec', 'spec-id', 'agent'],
      ['work:start', 'task', 'task-id', 'agent'],
      ['work:renew', 'spec', 'spec-id', 'agent'],
      ['work:release', 'spec', 'spec-id', 'agent'],
      ['work:release', 'task', 'task-id', 'agent', 'handoff'],
      ['work:complete', 'task', 'task-id', 'agent', '2', 'done'],
      ['project:create', 'ws', 'slug', 'Title'],
      ['project:get', 'project-id'],
      ['project:draft', 'project-id', '2'],
      ['project:open', 'project-id', '3'],
      ['project:pause', 'project-id', '4'],
      ['project:complete', 'project-id', '5', 'Outcome shipped'],
      ['project:cancel', 'project-id', '5', 'Outcome abandoned'],
      ['spec:create', 'project-id', 'feature', 'Feature'],
      ['spec:create', 'project-id', 'feature-with-body', 'Feature with body', 'spec.md'],
      ['spec:get', 'spec-id'],
      ['spec:draft', 'spec-id', '2'],
      ['spec:ready', 'spec-id', '3'],
      ['spec:cancel', 'spec-id', '4', 'No longer required'],
      ['task:create', 'spec-id', 'Task'],
      ['task:create', 'spec-id', 'Subtask', 'parent-id'],
      ['task:get', 'task-id'],
      ['task:cancel', 'task-id', '2', 'Superseded'],
      ['backup', 'backups'],
      ['backup', 'status', '--json'],
      ['backup', 'configure', 'cloud backup', '--json'],
      ['backup', 'retry', '--json'],
      ['backup', 'disable', '--json'],
      ['sync', 'status', '--json'],
      ['sync', 'configure', 'shared folder', '--device', 'linux-test', '--json'],
      ['sync', 'now', '--json'],
      ['sync', 'pause', '--json'],
      ['sync', 'resume', '--json'],
      ['sync', 'conflicts', '--json'],
      ['sync', 'resolve', 'a'.repeat(64), 'local', '--json'],
      ['sync', 'forget', '--json'],
      ['export', 'exports'],
    ];
    for (const command of commands) await runCli(command, state.runtime);

    expect(state.output).toHaveLength(commands.length);
    expect(state.client.listWork).toHaveBeenCalledWith({
      workspaceId: 'ws',
      projectId: 'project-id',
      specId: 'spec-id',
      limit: 50,
    });
    expect(state.client.renewWork).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'spec', leaseSeconds: 1_800 }),
    );
    expect(state.client.createProject).toHaveBeenCalledWith(
      expect.not.objectContaining({ prd: expect.anything() }),
    );
    expect(state.client.createSpec).toHaveBeenCalledWith(
      expect.objectContaining({ body: '# Spec' }),
    );
    expect(state.client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'parent-id' }),
    );
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
