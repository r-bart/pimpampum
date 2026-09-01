import type { ConnectorId } from './types.js';

export interface ConnectorDescriptor {
  id: ConnectorId;
  displayName: string;
}

const CONNECTORS: readonly ConnectorDescriptor[] = [
  { id: 'codex', displayName: 'Codex' },
  { id: 'claude-code', displayName: 'Claude Code' },
];

/** The deterministic order every surface lists connectors in. Ownership decisions live in the core. */
export function createConnectorRegistry(): ConnectorDescriptor[] {
  return CONNECTORS.map((connector) => ({ ...connector }));
}
