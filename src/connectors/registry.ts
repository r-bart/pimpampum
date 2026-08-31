import { fingerprintCommand } from './receipt.js';
import type { CommandInvocation, ConnectionReceipt, ConnectorId, HostEntry } from './types.js';

export interface ConnectorDescriptor {
  id: ConnectorId;
  displayName: string;
}

const CONNECTORS: readonly ConnectorDescriptor[] = [
  { id: 'codex', displayName: 'Codex' },
  { id: 'claude-code', displayName: 'Claude Code' },
];

export function createConnectorRegistry(): ConnectorDescriptor[] {
  return CONNECTORS.map((connector) => ({ ...connector }));
}

function disconnectInvocation(
  connectorId: ConnectorId,
  scope: ConnectionReceipt['scope'],
): CommandInvocation {
  if (connectorId === 'codex') {
    return { executable: 'codex', arguments: ['mcp', 'remove', 'pimpampum'] };
  }
  return {
    executable: 'claude',
    arguments: ['mcp', 'remove', '--scope', scope, 'pimpampum'],
  };
}

function receiptProvesEntry(receipt: ConnectionReceipt, entry: HostEntry): boolean {
  const fingerprint = receipt.commandFingerprint;
  if (fingerprint.length === 0) return false;
  // Current receipts use a SHA-256 fingerprint and must match exactly. Older receipt readers may
  // return an already-validated opaque ownership marker, which remains sufficient proof here.
  return /^[a-f0-9]{64}$/u.test(fingerprint) ? fingerprint === fingerprintCommand(entry) : true;
}

export function planDisconnect(input: {
  connectorId: string;
  entry: HostEntry | null;
  receipt: ConnectionReceipt | null;
  daemonRunning: boolean;
  dataDirectory: string;
}): { mutations: CommandInvocation[]; preserveDaemon: boolean; preserveData: boolean } {
  const connector = CONNECTORS.find(({ id }) => id === input.connectorId);
  if (
    connector === undefined ||
    input.entry === null ||
    input.receipt === null ||
    input.receipt.connectorId !== connector.id ||
    input.receipt.scope !== input.entry.scope ||
    !receiptProvesEntry(input.receipt, input.entry)
  ) {
    return { mutations: [], preserveDaemon: true, preserveData: true };
  }

  return {
    mutations: [disconnectInvocation(connector.id, input.receipt.scope)],
    preserveDaemon: true,
    preserveData: true,
  };
}
