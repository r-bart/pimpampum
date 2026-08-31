export const SETUP_SCHEMA_VERSION = 1 as const;
export const SETUP_CONNECTOR_IDS = ['codex', 'claude-code'] as const;

export type SetupConnectorId = (typeof SETUP_CONNECTOR_IDS)[number];
export type SetupStatus = 'complete' | 'partial' | 'conflict' | 'failed';
export type SetupNextAction =
  'done' | 'retry' | 'new-session' | 'resolve-conflict' | 'recover-login-item';

export interface SetupChange {
  kind: string;
  summary: string;
  path?: string;
}

export interface SetupConflict {
  connectorId: SetupConnectorId;
  comparison: string;
}

export interface SetupPlan {
  operationId: string;
  revision: string;
  selectedConnectors: SetupConnectorId[];
  changes: SetupChange[];
  conflicts: SetupConflict[];
  requiresConfirmation: boolean;
}

export interface SetupConnectorResult {
  id: SetupConnectorId;
  configured: boolean;
  available: boolean;
  newSessionRequired: boolean;
  state: string;
  error?: string;
}

export interface SetupServiceResult {
  installed: boolean;
  running: boolean;
  verified: boolean;
}

export interface SetupResult {
  status: SetupStatus;
  service: SetupServiceResult;
  connectors: SetupConnectorResult[];
  nextAction: SetupNextAction;
}

export type SetupProgressStatus = 'started' | 'completed' | 'failed';

export interface SetupProgressEvent {
  schemaVersion: typeof SETUP_SCHEMA_VERSION;
  operationId: string;
  phase: string;
  status: SetupProgressStatus;
  occurredAt: string;
  connectorId?: SetupConnectorId;
  diagnostic?: string;
}

export interface SetupJournal {
  schemaVersion: typeof SETUP_SCHEMA_VERSION;
  operationId: string;
  revision: string;
  phase: string;
  selectedConnectors: SetupConnectorId[];
  conflictDecisions: Partial<Record<SetupConnectorId, 'keep' | 'replace' | 'cancel'>>;
  completedPhases: string[];
  diagnostics: string[];
  service: SetupServiceResult;
  connectors: SetupConnectorResult[];
  loginItem: 'pending' | 'enabled' | 'requires-approval' | 'denied';
  status: 'running' | SetupStatus;
  updatedAt: string;
}

export interface SetupStateStore {
  readonly path: string;
  read(): SetupJournal | null;
  write(state: SetupJournal): void;
  remove(): void;
}

export interface InstallationSnapshot {
  runtimeVersion: string;
  serviceCommand: string[];
  connectorEntries: Record<string, unknown>;
}
