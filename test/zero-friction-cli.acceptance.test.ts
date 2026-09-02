/**
 * @generated-from thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md
 *
 * These tests encode the spec's acceptance criteria as executable assertions. Amend the spec
 * item they cite together with the test (decision of 2026-09-01, review H-14).
 */
import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliRuntime } from '../src/cliProgram.js';

function runtime() {
  const output: string[] = [];
  const errors: string[] = [];
  const connections = {
    list: vi.fn(async () => [
      { id: 'codex', state: 'ownedCurrent', available: true },
      { id: 'claude-code', state: 'notConnected', available: false },
    ]),
    connect: vi.fn(async (id: string) => ({ id, configured: true, available: true })),
    disconnect: vi.fn(async (id: string) => ({ id, disconnected: true, dataPreserved: true })),
    instructions: vi.fn(async () => ({ transport: 'stdio', tokenIncluded: false })),
  };
  return {
    output,
    errors,
    connections,
    value: {
      connections,
      createClient: vi.fn(),
      serviceManager: {
        install: vi.fn(),
        status: vi.fn(),
        uninstall: vi.fn(),
      },
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
      exit: vi.fn(() => undefined as never),
    } as unknown as CliRuntime,
  };
}

describe('JSON-first connection CLI', () => {
  it('FR-9.1: lists connector state through the standard data envelope', async () => {
    // Spec: FR-9.1, FR-6.5
    const testRuntime = runtime();

    await runCli(['connections'], testRuntime.value);

    expect(testRuntime.connections.list).toHaveBeenCalledOnce();
    expect(JSON.parse(testRuntime.output[0] ?? '')).toEqual({
      data: [
        { id: 'codex', state: 'ownedCurrent', available: true },
        { id: 'claude-code', state: 'notConnected', available: false },
      ],
    });
    expect(testRuntime.errors).toEqual([]);
  });

  it('FR-9.1: connects and disconnects a named supported connector non-interactively', async () => {
    // Spec: US-4/AC-1, FR-9.1
    const testRuntime = runtime();

    await runCli(['connect', 'codex', '--yes'], testRuntime.value);
    await runCli(['disconnect', 'codex', '--yes'], testRuntime.value);

    expect(testRuntime.connections.connect).toHaveBeenCalledWith('codex', {
      confirmed: true,
      conflictDecision: undefined,
    });
    expect(testRuntime.connections.disconnect).toHaveBeenCalledWith('codex', {
      confirmed: true,
    });
    expect(testRuntime.output.map((entry) => JSON.parse(entry))).toEqual([
      { data: { id: 'codex', configured: true, available: true } },
      { data: { id: 'codex', disconnected: true, dataPreserved: true } },
    ]);
  });

  it('FR-4.3/FR-7.2: refuses an unknown conflict without a separate explicit decision', async () => {
    // Spec: FR-4.3, FR-7.2, EC-7
    const testRuntime = runtime();
    testRuntime.connections.connect.mockRejectedValueOnce(
      Object.assign(new Error('Existing pimpampum entry requires a decision'), {
        code: 'CONNECTOR_CONFLICT',
      }),
    );

    await runCli(['connect', 'codex', '--yes'], testRuntime.value);

    expect(testRuntime.value.exit).toHaveBeenCalledWith(1);
    expect(testRuntime.connections.connect).toHaveBeenCalledWith('codex', {
      confirmed: true,
      conflictDecision: undefined,
    });
    expect(JSON.stringify(testRuntime.errors)).toMatch(/CONNECTOR_CONFLICT|conflict/iu);
  });

  it('US-4/AC-4: emits redacted manual instructions without placing credentials on stdout', async () => {
    // Spec: US-4/AC-4, FR-2.9, FR-9.1, SEC-4
    const testRuntime = runtime();

    await runCli(['connect', '--instructions'], testRuntime.value);

    expect(testRuntime.connections.instructions).toHaveBeenCalledOnce();
    const envelope = JSON.parse(testRuntime.output[0] ?? '') as {
      data: { transport: string; tokenIncluded: boolean };
    };
    expect(envelope).toEqual({ data: { transport: 'stdio', tokenIncluded: false } });
    expect(JSON.stringify([testRuntime.output, testRuntime.errors])).not.toMatch(
      /Bearer\s+\S+|PIMPAMPUM_TOKEN/iu,
    );
  });
});
