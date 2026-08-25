import { describe, expect, it, vi } from 'vitest';
import type { PimpampumHttpClient } from '../src/client.js';
import { CLI_USAGE, runCli, type CliRuntime } from '../src/cliProgram.js';

function fixture() {
  const client = {
    health: vi.fn(async () => ({ status: 'ok', version: '0.1.0' })),
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
  const runtime: CliRuntime = {
    createClient: () => client,
    startServer: vi.fn(async () => ({ config: { baseUrl: 'http://127.0.0.1:7337' }, close })),
    readFile: vi.fn(() => '# PRD'),
    resolvePath: (path) => `/resolved/${path}`,
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    onSignal: (signal, callback) => signals.set(signal, callback),
    exit: vi.fn(() => undefined as never),
  };
  return { client, close, errors, output, runtime, signals };
}

describe('CLI program', () => {
  it('maps every command through the injected runtime', async () => {
    const state = fixture();
    const commands: string[][] = [
      ['health'],
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
    expect(state.errors).toEqual([CLI_USAGE, CLI_USAGE]);

    const validation = fixture();
    await expect(runCli(['workspace:add'], validation.runtime)).rejects.toThrow(
      'Missing workspace id',
    );
    await expect(
      runCli(['work:start', 'invalid', 'target', 'agent'], validation.runtime),
    ).rejects.toThrow('Target type must be project or task');
    await expect(
      runCli(['work:complete', 'task', 'target', 'agent', 'nope', 'done'], validation.runtime),
    ).rejects.toThrow('Revision must be a positive integer');
    await expect(runCli(['project:ready', 'project', '0'], validation.runtime)).rejects.toThrow(
      'Revision must be a positive integer',
    );
  });
});
