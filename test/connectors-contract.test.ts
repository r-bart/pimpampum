import { describe, expect, it } from 'vitest';
import { classifyConnectorOwnership, fingerprintCommand } from '../src/connectors/receipt.js';
import { createConnectorRegistry } from '../src/connectors/registry.js';
import type { ConnectionReceipt, HostEntry } from '../src/connectors/types.js';

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
});
