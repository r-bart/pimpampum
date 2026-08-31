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
    resume: vi.fn(async () => ({ status: 'complete' })),
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
