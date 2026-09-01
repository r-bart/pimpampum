import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliRuntime } from '../src/cliProgram.js';

function fixture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const setup = {
    plan: vi.fn(async () => ({ operationId: 'operation', revision: 'revision' })),
    apply: vi.fn(async (_input?: unknown) => ({ status: 'complete' })),
    status: vi.fn(async () => ({ status: 'running' })),
    resume: vi.fn(async () => ({ status: 'complete' })),
    retryConnector: vi.fn(async () => ({ status: 'complete' })),
  };
  const startStdioBridge = vi.fn(async () => undefined);
  const runtime = {
    setup,
    startStdioBridge,
    stdout: (value: string) => stdout.push(value),
    stderr: (value: string) => stderr.push(value),
    exit: vi.fn(() => undefined as never),
  } as unknown as CliRuntime;
  return { runtime, setup, startStdioBridge, stdout, stderr };
}

function errors(state: ReturnType<typeof fixture>): string {
  return state.stderr.join('\n');
}

describe('native setup CLI security boundaries', () => {
  it('starts the MCP bridge without writing a competing JSON envelope', async () => {
    const state = fixture();
    await runCli(['mcp'], state.runtime);
    expect(state.startStdioBridge).toHaveBeenCalledOnce();
    expect(state.stdout).toEqual([]);
    expect(state.stderr).toEqual([]);
  });

  // Every native entry is declared in the catalog, so the shared parser rejects a typo, a surplus
  // token or a repeated flag with that command's usage line; only the cross-option rules stay here.
  it.each([
    [['setup', 'retry', 'codex'], /setup retry requires --events/iu],
    [['setup', 'retry', '--events'], /Missing connector id/iu],
    [['setup', 'retry', 'other', '--events'], /Connector id must be codex or claude-code/iu],
    [['setup', 'retry', 'codex', 'extra', '--events'], /at most 1 positional/iu],
    [
      ['setup', 'retry', 'codex', '--events', '--keep', 'codex'],
      /Unknown option for setup retry/iu,
    ],
    [['setup', 'resume', '--events', '--keep', 'codex'], /Unknown option for setup resume/iu],
    [
      ['setup', 'apply', 'operation', 'revision', '--yes', '--keep', 'codex'],
      /reserved for native setup event mode/iu,
    ],
    [
      ['setup', 'apply', 'operation', 'revision', '--yes', '--events', '--events'],
      /Repeated option: --events/iu,
    ],
    [['setup', 'unknown'], /unknown setup action/iu],
    [['setup'], /Missing setup action/iu],
  ])('rejects malformed native arguments %#', async (arguments_, message) => {
    const state = fixture();
    await runCli(arguments_ as string[], state.runtime);
    expect(errors(state)).toMatch(message as RegExp);
    expect(JSON.parse(state.stderr[0]!)).toMatchObject({ error: { code: 'bad_request' } });
    expect(state.runtime.exit).toHaveBeenCalledWith(1);
    expect(state.setup.apply).not.toHaveBeenCalled();
    expect(state.setup.retryConnector).not.toHaveBeenCalled();
    expect(state.setup.resume).not.toHaveBeenCalled();
  });

  it('accepts the declared native options in any order', async () => {
    const state = fixture();
    await runCli(
      ['setup', 'apply', '--events', 'operation', '--keep', 'codex', 'revision', '--yes'],
      state.runtime,
    );
    expect(state.setup.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'operation',
        expectedRevision: 'revision',
        conflictDecisions: { codex: 'keep' },
      }),
    );
    expect(state.stderr).toEqual([]);
  });

  it('rejects contradictory keep and replace decisions before mutation', async () => {
    const state = fixture();
    await runCli(
      [
        'setup',
        'apply',
        'operation',
        'revision',
        '--yes',
        '--events',
        '--keep',
        'codex',
        '--replace',
        'codex',
      ],
      state.runtime,
    );
    expect(errors(state)).toMatch(/both kept and replaced/iu);
    expect(state.setup.apply).not.toHaveBeenCalled();
  });

  it('bounds and redacts deeply nested progress and result envelopes', async () => {
    const state = fixture();
    state.setup.apply.mockImplementationOnce(async (input: unknown) => {
      const onProgress = (input as { onProgress(value: unknown): void }).onProgress;
      let nested: unknown = { token: 'private-token' };
      for (let index = 0; index < 20; index += 1) nested = { child: nested };
      onProgress({
        schemaVersion: 1,
        diagnostic: 'Authorization: Bearer private-bearer',
        values: Array.from({ length: 600 }, (_, index) => `value-${String(index)}`),
        nested,
      });
      return { status: 'complete', secret: 'private-secret' };
    });

    await runCli(['setup', 'apply', 'operation', 'revision', '--yes', '--events'], state.runtime);

    const serialized = state.stdout.join('');
    expect(serialized).not.toMatch(/private-(?:token|bearer|secret)/u);
    expect(serialized).toContain('[bounded]');
    const progress = JSON.parse(state.stdout[0]!) as { data: { values: unknown[] } };
    expect(progress.data.values).toHaveLength(512);
  });
});
