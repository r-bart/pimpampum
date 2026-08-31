import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionReceiptStore } from '../src/cliMain.js';
import { createCliConnectionsRuntime, runCli, type CliRuntime } from '../src/cliProgram.js';
import type { HostConnector } from '../src/connectors/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const output: string[] = [];
  const errors: string[] = [];
  const setup = {
    plan: vi.fn(async (input: unknown) => ({
      operationId: 'operation',
      revision: 'revision',
      input,
    })),
    apply: vi.fn(async (input: unknown) => ({ status: 'complete', input })),
    status: vi.fn(async () => ({ status: 'running' })),
    resume: vi.fn(async (_input?: unknown) => ({ status: 'complete' })),
    retryConnector: vi.fn(
      async (id: string, _onProgress?: (event: unknown) => void | Promise<void>) => ({
        status: 'complete',
        id,
      }),
    ),
  };
  const connections = {
    list: vi.fn(async () => []),
    connect: vi.fn(async (id: string) => ({ id, connected: true })),
    repair: vi.fn(async (id: string) => ({ id, repaired: true })),
    disconnect: vi.fn(async (id: string) => ({ id, disconnected: true })),
    instructions: vi.fn(async () => ({
      transport: 'stdio',
      token: 'private-value',
      note: 'Authorization: Bearer private-value',
    })),
  };
  const runtime = {
    setup,
    connections,
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
    exit: vi.fn(() => undefined as never),
  } as unknown as CliRuntime;
  return { runtime, setup, connections, output, errors };
}

describe('zero-friction CLI commands', () => {
  it('routes setup planning, confirmed apply, status and resume through JSON envelopes', async () => {
    const state = fixture();
    await runCli(
      ['setup', 'plan', '--connector', 'codex', '--connector', 'claude-code'],
      state.runtime,
    );
    await runCli(
      ['setup', 'apply', 'operation', 'revision', '--yes', '--replace', 'codex'],
      state.runtime,
    );
    await runCli(['setup', 'status'], state.runtime);
    await runCli(['setup', 'resume'], state.runtime);

    expect(state.setup.plan).toHaveBeenCalledWith({
      selectedConnectors: ['codex', 'claude-code'],
    });
    expect(state.setup.apply).toHaveBeenCalledWith({
      operationId: 'operation',
      expectedRevision: 'revision',
      confirmed: true,
      conflictDecisions: { codex: 'replace' },
    });
    expect(state.output.map((chunk) => Object.keys(JSON.parse(chunk)))).toEqual([
      ['data'],
      ['data'],
      ['data'],
      ['data'],
    ]);
  });

  it('requires confirmation and forwards the separate replacement decision', async () => {
    const state = fixture();
    await runCli(['connect', 'codex'], state.runtime);
    expect(state.connections.connect).not.toHaveBeenCalled();
    expect(state.runtime.exit).toHaveBeenCalledWith(1);

    await runCli(['connect', 'codex', '--yes', '--replace'], state.runtime);
    await runCli(['repair', 'claude-code', '--yes'], state.runtime);
    expect(state.connections.connect).toHaveBeenCalledWith('codex', {
      confirmed: true,
      conflictDecision: 'replace',
    });
    expect(state.connections.repair).toHaveBeenCalledWith('claude-code', {
      confirmed: true,
      conflictDecision: undefined,
    });
  });

  it('streams only schema-versioned redacted setup events in the private native mode', async () => {
    const state = fixture();
    state.setup.apply.mockImplementationOnce(async (input: unknown) => {
      const typed = input as {
        onProgress(event: unknown): void | Promise<void>;
      };
      await typed.onProgress({
        schemaVersion: 1,
        operationId: 'operation',
        phase: 'connector:codex.verify',
        status: 'failed',
        occurredAt: '2026-08-31T10:00:00.000Z',
        diagnostic: 'Authorization: Bearer private-value',
      });
      return {
        status: 'partial',
        input,
        service: { installed: true, running: true, verified: true },
        connectors: [],
        nextAction: 'retry',
      };
    });

    await runCli(
      ['setup', 'apply', 'operation', 'revision', '--yes', '--events', '--keep', 'codex'],
      state.runtime,
    );

    const events = state.output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.event)).toEqual(['progress', 'result']);
    expect(events.every((event) => event.schemaVersion === 1)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private-value');
    expect(state.setup.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        conflictDecisions: { codex: 'keep' },
        onProgress: expect.any(Function),
      }),
    );
  });

  it('keeps native resume and focused retry on the versioned event channel', async () => {
    const state = fixture();
    const event = {
      schemaVersion: 1,
      operationId: 'operation',
      phase: 'connector:codex.verify',
      status: 'completed',
      occurredAt: '2026-08-31T10:00:00.000Z',
      connectorId: 'codex',
    };
    state.setup.resume.mockImplementationOnce(async (input: unknown) => {
      await (input as { onProgress(value: unknown): void | Promise<void> }).onProgress(event);
      return { status: 'complete' };
    });
    state.setup.retryConnector.mockImplementationOnce(async (_id: string, onProgress: unknown) => {
      await (onProgress as (value: unknown) => void | Promise<void>)(event);
      return { status: 'complete', id: 'codex' };
    });

    await runCli(['setup', 'resume', '--events'], state.runtime);
    await runCli(['setup', 'retry', 'codex', '--events'], state.runtime);

    const events = state.output.map((line) => JSON.parse(line) as { event: string });
    expect(events.map(({ event: kind }) => kind)).toEqual([
      'progress',
      'result',
      'progress',
      'result',
    ]);
    expect(state.setup.retryConnector).toHaveBeenCalledWith('codex', expect.any(Function));
  });

  it('redacts credentials returned accidentally by an instruction boundary', async () => {
    const state = fixture();
    await runCli(['connect', '--instructions'], state.runtime);
    expect(state.output).toHaveLength(1);
    expect(state.output[0]).not.toContain('private-value');
    expect(JSON.parse(state.output[0]!)).toMatchObject({
      data: { transport: 'stdio', token: '[credential redacted]' },
    });
  });

  it('refuses to remove a receipt through a symlinked private directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-cli-receipt-'));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, 'data');
    const outside = join(root, 'outside');
    mkdirSync(dataDirectory);
    mkdirSync(outside);
    writeFileSync(join(outside, 'codex.json'), '{"preserved":true}\n');
    symlinkSync(outside, join(dataDirectory, 'connections'));

    await expect(createConnectionReceiptStore(dataDirectory, 'codex').remove()).rejects.toThrow(
      /symlink/iu,
    );
    expect(readFileSync(join(outside, 'codex.json'), 'utf8')).toBe('{"preserved":true}\n');
  });

  it('executes only the explicitly reviewed replacement plan', async () => {
    const connect = vi.fn(async () => ({
      connectorId: 'codex' as const,
      state: 'ownedCurrent' as const,
      changed: true,
      verification: null,
    }));
    const plan = vi.fn(async (input?: { conflictDecision?: 'replace' }) => ({
      connectorId: 'codex' as const,
      state: 'conflict' as const,
      selectedByDefault: true,
      mutations:
        input?.conflictDecision === 'replace'
          ? [
              { executable: '/usr/bin/codex', arguments: ['mcp', 'remove', 'pimpampum'] },
              { executable: '/usr/bin/codex', arguments: ['mcp', 'add', 'pimpampum'] },
            ]
          : [],
      requiresConflictDecision: input?.conflictDecision !== 'replace',
      ...(input?.conflictDecision === 'replace'
        ? { conflictDecision: 'replace' as const, reviewedEntryFingerprint: 'reviewed' }
        : {}),
      newSessionRequired: true,
      approvalPolicy: 'hostDefault' as const,
      summary: 'reviewed replacement',
    }));
    const connector = {
      id: 'codex',
      displayName: 'Codex',
      plan,
      connect,
    } as unknown as HostConnector;
    const runtime = createCliConnectionsRuntime({
      connectors: [connector],
      launcherPath: '/private/pimpampum-mcp',
    });

    await expect(
      runtime.connect('codex', { confirmed: true, conflictDecision: undefined }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(connect).not.toHaveBeenCalled();
    await runtime.connect('codex', { confirmed: true, conflictDecision: 'replace' });
    expect(plan).toHaveBeenLastCalledWith({ conflictDecision: 'replace' });
    expect(connect).toHaveBeenCalledOnce();
  });
});
