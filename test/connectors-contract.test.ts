import { describe, expect, it } from 'vitest';
import { classifyConnectorOwnership, fingerprintCommand } from '../src/connectors/receipt.js';
import { createConnectorRegistry, planDisconnect } from '../src/connectors/registry.js';
import {
  redactConnectorDiagnostics,
  type ConnectionReceipt,
  type HostEntry,
} from '../src/connectors/types.js';

const expected: HostEntry = {
  command: '/Users/example/.local/share/pimpampum/bin/pimpampum-mcp',
  arguments: [],
  scope: 'global',
};

function receiptFor(entry = expected): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId: 'codex',
    scope: 'global',
    commandFingerprint: fingerprintCommand(entry),
    configuredAt: '2026-08-31T08:00:00.000Z',
    lastVerifiedAt: null,
  };
}

describe('connector contracts', () => {
  it('creates a fresh deterministic descriptor list', () => {
    const first = createConnectorRegistry();
    first.reverse();
    expect(createConnectorRegistry()).toEqual([
      { id: 'codex', displayName: 'Codex' },
      { id: 'claude-code', displayName: 'Claude Code' },
    ]);
  });

  it('requires receipt agreement before treating exact or legacy entries as owned', () => {
    const legacy = { command: 'npx', arguments: ['pimpampum', 'mcp'], scope: 'global' as const };
    expect(
      classifyConnectorOwnership({
        entry: expected,
        receipt: receiptFor(),
        expected,
        recognizedLegacyEntries: [legacy],
      }),
    ).toBe('ownedCurrent');
    expect(
      classifyConnectorOwnership({
        entry: legacy,
        receipt: receiptFor(legacy),
        expected,
        recognizedLegacyEntries: [legacy],
      }),
    ).toBe('ownedStale');
    expect(
      classifyConnectorOwnership({
        entry: legacy,
        receipt: null,
        expected,
        recognizedLegacyEntries: [legacy],
      }),
    ).toBe('conflict');
  });

  it('redacts credentials and home-directory identities from diagnostics', () => {
    const token = 'private-bearer-token-000000000000';
    const result = redactConnectorDiagnostics({
      connectorId: 'codex',
      executablePath: '/Users/example/.local/bin/codex',
      token,
      stderr: `Authorization: Bearer ${token} in /Users/example/private`,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('/Users/example');
    expect(result.instructions).not.toHaveLength(0);
  });

  it('disconnects only a known connector with a matching-scope receipt', () => {
    expect(
      planDisconnect({
        connectorId: 'codex',
        entry: expected,
        receipt: receiptFor(),
        daemonRunning: true,
        dataDirectory: '/Users/example/.pimpampum',
      }),
    ).toMatchObject({
      preserveDaemon: true,
      preserveData: true,
      mutations: [{ executable: 'codex' }],
    });
    expect(
      planDisconnect({
        connectorId: 'codex',
        entry: expected,
        receipt: null,
        daemonRunning: true,
        dataDirectory: '/Users/example/.pimpampum',
      }).mutations,
    ).toEqual([]);

    expect(
      planDisconnect({
        connectorId: 'codex',
        entry: {
          ...expected,
          command: '/Users/example/unowned/pimpampum-mcp',
        },
        receipt: receiptFor(),
        daemonRunning: true,
        dataDirectory: '/Users/example/.pimpampum',
      }).mutations,
    ).toEqual([]);
  });
});
