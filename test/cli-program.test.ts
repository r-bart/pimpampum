import { describe, expect, it, vi } from 'vitest';
import type { PimpampumHttpClient } from '../src/client.js';
import { MAX_AGENT_INPUT_BYTES, runCli, type CliRuntime } from '../src/cliProgram.js';
import { AppError } from '../src/errors.js';

function fixture() {
  const client = {
    health: vi.fn(async () => ({ status: 'ok', version: '0.1.0' })),
    getOverview: vi.fn(async () => ({ status: 'empty' })),
    listWorkspaces: vi.fn(async () => []),
    registerWorkspace: vi.fn(async (input: unknown) => input),
    listWork: vi.fn(async () => []),
    startWork: vi.fn(async (input: unknown) => input),
    releaseWork: vi.fn(async () => undefined),
    completeWork: vi.fn(async (input: unknown) => input),
    createProject: vi.fn(async (input: unknown) => input),
    getProject: vi.fn(async (id: string) => ({ id })),
    updateProject: vi.fn(async (input: unknown) => input),
    createTask: vi.fn(async (input: unknown) => input),
    backup: vi.fn(async (directory: string) => ({ path: directory })),
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
        version: '0.1.0',
      })),
      uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
    },
    startServer: vi.fn(async () => ({ config: { baseUrl: 'http://127.0.0.1:7337' }, close })),
    readFile: vi.fn(() => '# PRD'),
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
      ['uninstall'],
      ['workspace:list'],
      ['workspace:add', 'ws', 'Workspace', 'root'],
      ['work:list'],
      ['work:list', 'ws'],
      ['work:start', 'task', 'task-id', 'agent'],
      ['work:release', 'project', 'project-id', 'agent'],
      ['work:release', 'task', 'task-id', 'agent', 'handoff'],
      ['work:complete', 'task', 'task-id', 'agent', '2', 'done'],
      ['project:create', 'ws', 'slug', 'Title'],
      ['project:create', 'ws', 'slug', 'Title', 'prd.md'],
      ['project:get', 'project-id'],
      ['project:ready', 'project-id', '3'],
      ['task:create', 'project-id', 'Task'],
      ['task:create', 'project-id', 'Subtask', 'parent-id'],
      ['backup', 'backups'],
      ['export', 'exports'],
    ];
    for (const command of commands) await runCli(command, state.runtime);

    expect(state.output).toHaveLength(commands.length);
    expect(state.client.startWork).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'task', leaseSeconds: 1_800 }),
    );
    expect(state.client.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ prd: '# PRD' }),
    );
    expect(state.client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'parent-id' }),
    );
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
    await expect(runCli(['project:ready', 'project', '0'], validation.runtime)).rejects.toThrow(
      'exit:1',
    );
    expect(validation.errors.join('\n')).toContain('Missing workspace id');
    expect(validation.errors.join('\n')).toContain('Target type must be project or task');
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
});
