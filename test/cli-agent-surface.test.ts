import { describe, expect, it, vi } from 'vitest';
import type { PimpampumHttpClient } from '../src/client.js';
import {
  CLI_COMMANDS,
  describeCommands,
  renderUsageLine,
  type CliCommand,
} from '../src/cliCommands.js';
import {
  describe as describeCommand,
  parseCommandArguments,
  runCli,
  type CliRuntime,
} from '../src/cliProgram.js';
import { AppError } from '../src/errors.js';
import { PIMPAMPUM_VERSION, parseVersion } from '../src/version.js';

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

function fixture() {
  const echo = vi.fn(async (input: unknown) => input);
  const client = {
    health: vi.fn(async () => ({ status: 'ok', version: PIMPAMPUM_VERSION })),
    getOverview: vi.fn(async () => ({ status: 'empty' })),
    listWorkspaces: vi.fn(async () => []),
    registerWorkspace: echo,
    listWork: vi.fn(async () => []),
    startWork: echo,
    renewWork: echo,
    releaseWork: vi.fn(async () => undefined),
    completeWork: echo,
    createProject: echo,
    getProject: vi.fn(async (id: string) => ({ id })),
    updateProject: echo,
    completeProject: echo,
    cancelProject: echo,
    createSpec: echo,
    getSpec: vi.fn(async (id: string) => ({ id })),
    updateSpec: echo,
    cancelSpec: echo,
    createTask: echo,
    getTask: vi.fn(async (id: string) => ({ id })),
    cancelTask: echo,
    backup: vi.fn(async (directory: string) => ({ path: directory })),
    getAutomaticBackupStatus: vi.fn(async () => ({ state: 'disabled', enabled: false })),
    configureAutomaticBackup: vi.fn(async () => ({ state: 'healthy', enabled: true })),
    retryAutomaticBackup: vi.fn(async () => ({ state: 'healthy', enabled: true })),
    disableAutomaticBackup: vi.fn(async () => ({ state: 'disabled', enabled: false })),
    getSyncStatus: vi.fn(async () => ({ state: 'disabled', enabled: false })),
    configureSync: vi.fn(async () => ({ state: 'healthy', enabled: true })),
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
  const agentClient = {
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"data":{}}' }] })),
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
        receiptPath: '/r',
      })),
      status: vi.fn(async () => ({
        installed: true,
        running: true,
        adapter: 't',
        version: '1.0.0',
      })),
      uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
    },
    startStdioBridge: vi.fn(async () => undefined),
    startServer: vi.fn(async () => ({
      config: { baseUrl: 'http://127.0.0.1:7337' },
      close: vi.fn(async () => undefined),
    })),
    readFile: vi.fn(() => '# Body'),
    readStdin: vi.fn(() => '{}'),
    resolvePath: (path) => `/resolved/${path}`,
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    onSignal: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new CliExit(code);
    }),
  };
  return { agentClient, client, errors, output, runtime };
}

function only<T>(chunks: string[]): T {
  expect(chunks).toHaveLength(1);
  return JSON.parse(chunks[0] ?? '') as T;
}

/** Placeholder arguments good enough to reach dispatch for any declared command. */
function sampleArguments(name: string): string[] {
  const command = CLI_COMMANDS.find((entry) => entry.name === name);
  const tokens = name.split(' ').slice(1);
  const positional = (command?.arguments ?? [])
    .filter((argument) => argument.required)
    .map((argument) => (argument.values ? (argument.values[0] ?? 'x') : '1'));
  const required = (command?.options ?? [])
    .filter((option) => option.required === true)
    .flatMap((option) => (option.value === null ? [option.flag] : [option.flag, 'x']));
  return [...tokens, ...positional, ...required];
}

describe('CLI agent surface', () => {
  it('wraps every success in exactly one data envelope', async () => {
    const commands = [
      ['config'],
      ['version'],
      ['commands'],
      ['health'],
      ['overview'],
      ['status'],
      ['install'],
      ['uninstall'],
      ['tools'],
      ['call', 'workspace_list'],
      ['workspace:list'],
      ['work:list'],
      ['work:release', 'spec', 'id', 'agent'],
      ['backup', 'status'],
      ['sync', 'status'],
      ['export', 'out'],
    ];
    for (const command of commands) {
      const state = fixture();
      await runCli(command, state.runtime);
      const payload = only<Record<string, unknown>>(state.output);
      expect(Object.keys(payload), command.join(' ')).toEqual(['data']);
      expect(state.errors).toEqual([]);
    }
  });

  it('runs the MCP stdio bridge without writing to stdout', async () => {
    const state = fixture();
    await runCli(['mcp'], state.runtime);
    expect(state.runtime.startStdioBridge).toHaveBeenCalledOnce();
    // stdout is the protocol channel for this command; an envelope there would corrupt the stream.
    expect(state.output).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  it('answers --help, -h and help with the banner and exit code zero', async () => {
    for (const command of [['help'], ['--help'], ['-h']]) {
      const state = fixture();
      await runCli(command, state.runtime);
      expect(state.output.join(''), command.join(' ')).toContain('pimpampum call');
      expect(state.errors).toEqual([]);
      expect(state.runtime.exit).not.toHaveBeenCalled();
    }
  });

  it('answers --version, -v and version with the packaged version', async () => {
    for (const command of [['version'], ['--version'], ['-v']]) {
      const state = fixture();
      await runCli(command, state.runtime);
      expect(only(state.output)).toEqual({
        data: { name: 'pimpampum', version: PIMPAMPUM_VERSION },
      });
    }
  });

  it('reports the version the package manifest declares', async () => {
    const state = fixture();
    await runCli(['version'], state.runtime);
    const banner = fixture();
    await runCli(['help'], banner.runtime);
    expect(banner.output.join('')).toContain(`Pimpampum ${PIMPAMPUM_VERSION}`);
    expect(only<{ data: { version: string } }>(state.output).data.version).toBe(PIMPAMPUM_VERSION);
  });

  it('returns a machine-readable catalog whose usage lines match the banner', async () => {
    const state = fixture();
    await runCli(['commands'], state.runtime);
    const { data } = only<{ data: ReturnType<typeof describeCommands> }>(state.output);

    expect(data.version).toBe(PIMPAMPUM_VERSION);
    expect(data.commands).toHaveLength(CLI_COMMANDS.length);
    for (const command of data.commands) {
      expect(command.usage).toBe(renderUsageLine(command));
      expect(command.summary.length).toBeGreaterThan(0);
      expect(Object.keys(command.annotations).sort()).toEqual([
        'destructiveHint',
        'idempotentHint',
        'readOnlyHint',
        'requiresDaemon',
      ]);
    }

    const banner = fixture();
    await runCli(['help'], banner.runtime);
    for (const command of data.commands) {
      expect(banner.output.join(''), command.name).toContain(command.usage);
    }
  });

  it('dispatches every command the catalog declares', async () => {
    for (const command of CLI_COMMANDS) {
      const state = fixture();
      const argv = [command.name.split(' ')[0] ?? '', ...sampleArguments(command.name)];
      await runCli(argv, state.runtime).catch(() => undefined);
      const failure = state.errors[0];
      if (failure !== undefined) {
        const message = (JSON.parse(failure) as { error: { message: string } }).error.message;
        expect(message, command.name).not.toContain('Unknown command');
        expect(message, command.name).not.toContain('Undeclared CLI command');
        expect(message, command.name).not.toContain('Unknown sync action');
      }
    }
  });

  it('rejects an unknown option, a surplus positional and a missing value with that usage line', async () => {
    const cases = [
      { argv: ['work:list', '--wat'], message: 'Unknown option for work:list: --wat' },
      { argv: ['work:list', 'a', 'b', 'c', 'd'], message: 'at most 3 positional arguments' },
      { argv: ['work:list', '--limit'], message: 'Option --limit requires a value' },
      { argv: ['work:list', '--limit', '0'], message: 'Limit must be a positive integer' },
      { argv: ['project:get', 'a', 'b'], message: 'at most 1 positional arguments' },
    ];
    for (const { argv, message } of cases) {
      const state = fixture();
      await expect(runCli(argv, state.runtime)).rejects.toMatchObject({ code: 1 });
      const payload = only<{ error: { code: string; message: string; details: unknown } }>(
        state.errors,
      );
      expect(payload.error.code).toBe('bad_request');
      expect(payload.error.message).toContain(message);
      expect(state.output).toEqual([]);
    }
  });

  it('attaches the offending command usage line to an argument error', async () => {
    const state = fixture();
    await expect(runCli(['work:complete', '--nope'], state.runtime)).rejects.toMatchObject({
      code: 1,
    });
    expect(only<{ error: { details: { usage: string } } }>(state.errors).error.details.usage).toBe(
      'pimpampum work:complete <spec|task> <target-id> <agent-id> <revision> <summary> [--artifact <uri>]... [--artifacts <json>]',
    );
  });

  it('passes --limit, --lease-seconds, --note and --actor through to the gateway', async () => {
    const state = fixture();
    await runCli(['work:list', 'ws', '--limit', '7'], state.runtime);
    expect(state.client.listWork).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', limit: 7 }),
    );

    await runCli(['work:start', 'spec', 'id', 'agent', '--lease-seconds', '60'], state.runtime);
    expect(state.client.startWork).toHaveBeenCalledWith(
      expect.objectContaining({ leaseSeconds: 60 }),
    );

    await runCli(['work:release', 'spec', 'id', 'agent', '--note', 'handover'], state.runtime);
    expect(state.client.releaseWork).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'handover' }),
    );

    await runCli(['project:create', 'ws', 'slug', 'Title', '--actor', 'codex-7'], state.runtime);
    expect(state.client.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'codex-7' }),
    );

    await runCli(['task:create', 'spec-id', 'Title', '--parent', 'parent-id'], state.runtime);
    expect(state.client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'parent-id', body: null }),
    );

    await runCli(['task:create', 'spec-id', 'Title', '--body-file', 'body.md'], state.runtime);
    expect(state.client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ body: '# Body' }),
    );
  });

  it('records artifact references that the positional-only form used to drop', async () => {
    const repeated = fixture();
    await runCli(
      [
        'work:complete',
        'task',
        'task-id',
        'agent',
        '2',
        'done',
        '--artifact',
        'https://example.test/pr/1',
        '--artifact',
        '/tmp/report.pdf',
      ],
      repeated.runtime,
    );
    expect(repeated.client.completeWork).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [
          { label: null, uri: 'https://example.test/pr/1' },
          { label: null, uri: '/tmp/report.pdf' },
        ],
      }),
    );

    const labelled = fixture();
    await runCli(
      [
        'project:complete',
        'project-id',
        '3',
        'shipped',
        '--artifacts',
        '[{"label":"PR","uri":"https://example.test/pr/2"},{"uri":"/tmp/a"}]',
      ],
      labelled.runtime,
    );
    expect(labelled.client.completeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [
          { label: 'PR', uri: 'https://example.test/pr/2' },
          { label: null, uri: '/tmp/a' },
        ],
      }),
    );

    const empty = fixture();
    await runCli(['work:complete', 'task', 'id', 'agent', '2', 'done'], empty.runtime);
    expect(empty.client.completeWork).toHaveBeenCalledWith(
      expect.objectContaining({ artifacts: [] }),
    );
  });

  it.each([
    { argv: ['--artifact', 'a', '--artifacts', '[]'], message: 'not both' },
    { argv: ['--artifacts', '{nope'], message: '--artifacts must be valid JSON' },
    { argv: ['--artifacts', '{}'], message: '--artifacts must be a JSON array' },
    { argv: ['--artifacts', '[{"label":"x"}]'], message: 'non-empty uri string' },
    { argv: ['--artifacts', '[{"uri":"a","label":7}]'], message: 'label must be a string or null' },
  ])('rejects malformed artifact input: $message', async ({ argv, message }) => {
    const state = fixture();
    await expect(
      runCli(['work:complete', 'task', 'id', 'agent', '2', 'done', ...argv], state.runtime),
    ).rejects.toMatchObject({ code: 1 });
    expect(only<{ error: { message: string } }>(state.errors).error.message).toContain(message);
    expect(state.client.completeWork).not.toHaveBeenCalled();
  });

  it('accepts a positional value that begins with two dashes after --', async () => {
    const state = fixture();
    await runCli(
      ['work:complete', 'spec', 'id', 'agent', '2', '--', '--fixed the parser'],
      state.runtime,
    );
    expect(state.client.completeWork).toHaveBeenCalledWith(
      expect.objectContaining({ summary: '--fixed the parser' }),
    );

    const reason = fixture();
    await runCli(['project:cancel', 'id', '2', '--', '--not viable'], reason.runtime);
    expect(reason.client.cancelProject).toHaveBeenCalledWith(
      expect.objectContaining({ reason: '--not viable' }),
    );
  });

  it.each([
    {
      argv: ['task:create', 'spec-id', 'Title', 'positional', '--parent', 'flagged'],
      message: 'Pass either the parent-id argument or --parent, not both',
    },
    {
      argv: ['spec:create', 'p', 's', 'T', 'body.md', '--body-file', 'other.md'],
      message: 'Pass either the body-file argument or --body-file, not both',
    },
    {
      argv: ['work:release', 'spec', 'id', 'agent', 'note', '--note', 'other'],
      message: 'Pass either the note argument or --note, not both',
    },
  ])(
    'refuses the same value given positionally and by flag: $message',
    async ({ argv, message }) => {
      const state = fixture();
      await expect(runCli(argv, state.runtime)).rejects.toMatchObject({ code: 1 });
      expect(only<{ error: { message: string } }>(state.errors).error.message).toBe(message);
      expect(state.output).toEqual([]);
    },
  );

  it('names the recovery command when the daemon does not answer', async () => {
    const state = fixture();
    state.client.health = vi.fn(async () => {
      throw new AppError(
        'unavailable',
        'The Pimpampum daemon did not answer on its local address',
        503,
        true,
      );
    }) as never;

    await expect(runCli(['health'], state.runtime)).rejects.toMatchObject({ code: 1 });
    const payload = only<{ error: { code: string; retryable: boolean; suggestion: string } }>(
      state.errors,
    );
    expect(payload.error.code).toBe('unavailable');
    expect(payload.error.retryable).toBe(true);
    expect(payload.error.suggestion).toContain('pimpampum install');
    expect(payload.error.suggestion).toContain('pimpampum status');
  });
});

describe('CLI argument parser', () => {
  const command: CliCommand = {
    name: 'demo',
    summary: 'Synthetic command exercising every option shape.',
    arguments: [
      { name: 'first', required: true, description: 'First.' },
      { name: 'second', required: false, description: 'Second.' },
    ],
    options: [
      { flag: '--single', value: 'v', description: 'Takes one value.' },
      { flag: '--many', value: 'v', description: 'Repeatable.', repeatable: true },
      { flag: '--switch', value: null, description: 'Boolean flag.' },
    ],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      requiresDaemon: false,
    },
  };

  it('separates positionals, single values, repeated values and boolean flags', () => {
    const input = parseCommandArguments(command, [
      'a',
      '--many',
      'one',
      '--switch',
      'b',
      '--single',
      'only',
      '--many',
      'two',
    ]);
    expect(input.positional).toEqual(['a', 'b']);
    expect(input.option('--single')).toBe('only');
    expect(input.optionAll('--many')).toEqual(['one', 'two']);
    expect(input.boolean('--switch')).toBe(true);
    expect(input.boolean('--absent')).toBe(false);
    expect(input.option('--absent')).toBeUndefined();
    expect(input.optionAll('--absent')).toEqual([]);
  });

  it.each([
    { argv: ['--unknown'], message: 'Unknown option for demo: --unknown' },
    { argv: ['--switch', '--switch'], message: 'Repeated option: --switch' },
    { argv: ['--single', 'a', '--single', 'b'], message: 'Repeated option: --single' },
    { argv: ['--single'], message: 'Option --single requires a value' },
    { argv: ['--single', '--switch'], message: 'Option --single requires a value' },
    { argv: ['a', 'b', 'c'], message: 'demo accepts at most 2 positional arguments' },
    { argv: ['--', 'a', 'b', 'c'], message: 'demo accepts at most 2 positional arguments' },
  ])('rejects $message', ({ argv, message }) => {
    expect(() => parseCommandArguments(command, argv)).toThrow(message);
  });

  it('treats everything after -- as positional, including a second --', () => {
    const input = parseCommandArguments(command, ['--switch', '--', '--single', '--']);
    expect(input.positional).toEqual(['--single', '--']);
    expect(input.boolean('--switch')).toBe(true);
    expect(input.option('--single')).toBeUndefined();
  });

  it('refuses to look up a command the catalog does not declare', () => {
    expect(describeCommand('work:list').name).toBe('work:list');
    expect(() => describeCommand('work:teleport')).toThrow('Undeclared CLI command: work:teleport');
  });

  it('attaches the command usage line to every argument error', () => {
    try {
      parseCommandArguments(command, ['--unknown']);
      expect.unreachable('parsing should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details).toEqual({ usage: renderUsageLine(command) });
    }
  });
});

describe('version source', () => {
  it('reads the version the manifest declares', () => {
    expect(parseVersion('{"version":"9.9.9"}')).toBe('9.9.9');
  });

  it.each(['{}', '{"version":""}', '{"version":7}'])(
    'refuses a manifest without a usable version: %s',
    (manifest) => {
      expect(() => parseVersion(manifest)).toThrow('package.json does not declare a version');
    },
  );
});
