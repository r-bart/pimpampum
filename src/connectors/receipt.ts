import { createHash } from 'node:crypto';
import type { ConnectionReceipt, ConnectorState, HostEntry } from './types.js';

function normalizedEntry(entry: HostEntry): HostEntry {
  return {
    command: entry.command,
    arguments: [...entry.arguments],
    scope: entry.scope,
  };
}

export function fingerprintCommand(entry: HostEntry): string {
  const normalized = normalizedEntry(entry);
  return createHash('sha256')
    .update(
      JSON.stringify({
        scope: normalized.scope,
        command: normalized.command,
        arguments: normalized.arguments,
      }),
    )
    .digest('hex');
}

function sameEntry(left: HostEntry, right: HostEntry): boolean {
  return fingerprintCommand(left) === fingerprintCommand(right);
}

function receiptOwnsEntry(receipt: ConnectionReceipt | null, entry: HostEntry): boolean {
  return (
    receipt !== null &&
    receipt.scope === entry.scope &&
    receipt.commandFingerprint === fingerprintCommand(entry)
  );
}

export function classifyConnectorOwnership(input: {
  entry: HostEntry | null;
  receipt: ConnectionReceipt | null;
  expected: HostEntry;
  recognizedLegacyEntries: HostEntry[];
}): ConnectorState {
  const entry = input.entry;
  if (entry === null) return 'notConnected';

  if (sameEntry(entry, input.expected)) {
    return receiptOwnsEntry(input.receipt, entry) ? 'ownedCurrent' : 'equivalentUnowned';
  }

  const recognizedLegacy = input.recognizedLegacyEntries.some((legacy) => sameEntry(entry, legacy));
  if (recognizedLegacy && receiptOwnsEntry(input.receipt, entry)) return 'ownedStale';

  return 'conflict';
}
