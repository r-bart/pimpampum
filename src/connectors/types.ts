export const CONNECTOR_IDS = ['codex', 'claude-code'] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export type ConnectorState =
  | 'notInstalled'
  | 'unsupportedVersion'
  | 'notConnected'
  | 'ownedCurrent'
  | 'ownedStale'
  | 'equivalentUnowned'
  | 'conflict'
  | 'unavailable';

export type ConnectorScope = 'user' | 'project' | 'local' | 'global';
export type OwnedConnectorScope = Extract<ConnectorScope, 'user' | 'global'>;
export type ConnectorApprovalPolicy = 'hostDefault' | 'promptForWrites';
export type ConnectorConflictDecision = 'keep' | 'replace' | 'cancel';

export interface CommandInvocation {
  executable: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
}

/** The tokenless portion of a host MCP entry used for ownership decisions. */
export interface HostEntry {
  command: string;
  arguments: string[];
  scope: ConnectorScope;
  /** False when the official host CLI cannot faithfully restore this inspected entry. */
  restorable?: boolean;
}

export interface ConnectorCapabilities {
  inspect: 'json' | 'boundedConfig';
  add: boolean;
  remove: boolean;
  scopes: ConnectorScope[];
}

export interface ConnectorDetection {
  connectorId: ConnectorId;
  executable: string | null;
  version: string | null;
  supported: boolean;
  capabilities: ConnectorCapabilities | null;
}

export interface ConnectionReceipt {
  schemaVersion: 1;
  connectorId: ConnectorId;
  scope: OwnedConnectorScope;
  commandFingerprint: string;
  configuredAt: string;
  lastVerifiedAt: string | null;
  hostVersion?: string;
  capabilities?: string[];
}

export interface ConnectorInspection {
  connectorId: ConnectorId;
  state: ConnectorState;
  entry: HostEntry | null;
  higherPrecedenceEntry: HostEntry | null;
  receipt: ConnectionReceipt | null;
}

export interface ConnectionPlan {
  connectorId: ConnectorId;
  state: ConnectorState;
  selectedByDefault: boolean;
  mutations: CommandInvocation[];
  requiresConflictDecision: boolean;
  conflictDecision?: ConnectorConflictDecision;
  reviewedEntryFingerprint?: string;
  newSessionRequired: boolean;
  approvalPolicy: ConnectorApprovalPolicy;
  summary: string;
}

export interface ConnectorVerification {
  connectorId: ConnectorId;
  available: boolean;
  verifiedAt: string | null;
  serverName: string | null;
  tools: string[];
  diagnostics: string[];
}

export interface ConnectorSnapshot {
  connectorId: ConnectorId;
  revision: string | null;
  entry: HostEntry | null;
}

export interface ConnectorActionResult {
  connectorId: ConnectorId;
  state: ConnectorState;
  changed: boolean;
  verification: ConnectorVerification | null;
}

export interface ConnectorDiagnostics {
  message: string;
  instructions: string[];
}

/** Domain-neutral connector lifecycle. Host-specific configuration stays behind this interface. */
export interface HostConnector {
  readonly id: ConnectorId;
  readonly displayName: string;
  detect(): Promise<ConnectorDetection>;
  inspect(): Promise<ConnectorInspection>;
  plan(input?: {
    conflictDecision?: ConnectorConflictDecision;
    reviewedEntryFingerprint?: string;
  }): Promise<ConnectionPlan>;
  connect(plan: ConnectionPlan): Promise<ConnectorActionResult>;
  verify(): Promise<ConnectorVerification>;
  repair(plan: ConnectionPlan): Promise<ConnectorActionResult>;
  disconnect(): Promise<ConnectorActionResult>;
  snapshot(): Promise<ConnectorSnapshot>;
  restore(snapshot: ConnectorSnapshot): Promise<void>;
}

const MAX_DIAGNOSTIC_LENGTH = 320;

function displayName(connectorId: string): string {
  if (connectorId === 'codex') return 'Codex';
  if (connectorId === 'claude-code') return 'Claude Code';
  return 'The agent';
}

function sanitizedDiagnostic(stderr: string, token: string): string {
  let value = stderr;
  if (token) value = value.replaceAll(token, '[credential redacted]');
  value = value
    .replace(/(?:authorization\s*:?\s*)?bearer\s+\S+/giu, '[credential redacted]')
    .replace(/\/Users\/[^/\s]+/gu, '~')
    .replace(/\/home\/[^/\s]+/gu, '~')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  return value.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export function redactConnectorDiagnostics(input: {
  connectorId: string;
  executablePath: string;
  token: string;
  stderr: string;
}): ConnectorDiagnostics {
  const name = displayName(input.connectorId);
  const detail = sanitizedDiagnostic(input.stderr, input.token);
  return {
    message: detail ? `${name} could not connect: ${detail}` : `${name} could not connect.`,
    instructions: [
      `Open ${name} settings and review only the Pimpampum MCP entry.`,
      `Retry the connection test, then start a new ${name} session if requested.`,
    ],
  };
}
