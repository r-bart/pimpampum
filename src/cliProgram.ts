import type { AgentCliClient } from './agentClient.js';
import { createLocalErrorEnvelope, type AgentErrorEnvelope } from './agentProtocol.js';
import type { PimpampumHttpClient } from './client.js';
import { CLI_HANDLERS, handlerFor } from './cliHandlers/index.js';
import { parseCommandArguments, resolveCommand } from './cliInput.js';
import type { HostConnector } from './connectors/types.js';
import { AppError } from './errors.js';
import type { ServiceManager } from './service/types.js';
import type { UpdateManager } from './update.js';
import type { SetupStateStore } from './setup/types.js';
import type { SetupProgressEvent } from './setup/types.js';

export type CliConnectorId = 'codex' | 'claude-code';

export interface CliConnectorMutationInput {
  confirmed: boolean;
  conflictDecision: 'replace' | undefined;
  /** The revision `connections` reported; replacement proceeds only while that entry is on disk. */
  reviewedEntryFingerprint?: string;
}

export interface CliConnectionsRuntime {
  list(): Promise<unknown>;
  connect(id: CliConnectorId, input: CliConnectorMutationInput): Promise<unknown>;
  repair(id: CliConnectorId, input: CliConnectorMutationInput): Promise<unknown>;
  disconnect(id: CliConnectorId, input: { confirmed: boolean }): Promise<unknown>;
  instructions(): Promise<unknown>;
}

export interface CliSetupRuntime {
  plan(input: { selectedConnectors: CliConnectorId[] }): Promise<unknown>;
  apply(input: {
    operationId: string;
    expectedRevision: string;
    confirmed: boolean;
    conflictDecisions?: Partial<Record<CliConnectorId, 'replace' | 'keep'>>;
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>;
  }): Promise<unknown>;
  status(): Promise<unknown>;
  resume(input?: {
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>;
  }): Promise<unknown>;
  retryConnector(
    id: CliConnectorId,
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>,
  ): Promise<unknown>;
}

export interface SetupCoordinatorCliBoundary {
  plan(input: { selectedConnectors: CliConnectorId[] }): Promise<unknown>;
  apply(input: {
    operationId: string;
    expectedRevision: string;
    confirmed: boolean;
    conflictDecisions?: Partial<Record<CliConnectorId, 'replace' | 'keep'>>;
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>;
  }): Promise<unknown>;
  resume(input?: {
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>;
  }): Promise<unknown>;
  retryConnector(
    id: CliConnectorId,
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>,
  ): Promise<unknown>;
}

export function createCliSetupRuntime(
  coordinator: SetupCoordinatorCliBoundary,
  stateStore: Pick<SetupStateStore, 'read'>,
): CliSetupRuntime {
  return {
    plan: (input) => coordinator.plan(input),
    apply: (input) => coordinator.apply(input),
    status: async () => stateStore.read(),
    resume: (input) => coordinator.resume(input),
    retryConnector: (id, onProgress) => coordinator.retryConnector(id, onProgress),
  };
}

export function createCliConnectionsRuntime(input: {
  connectors: readonly HostConnector[];
  launcherPath: string;
}): CliConnectionsRuntime {
  const connectors = new Map(input.connectors.map((connector) => [connector.id, connector]));
  const resolveConnector = (id: CliConnectorId): HostConnector => {
    const connector = connectors.get(id);
    if (connector === undefined)
      throw new AppError('not_found', `Connector is not available: ${id}`, 404);
    return connector;
  };
  const act = async (
    id: CliConnectorId,
    action: 'connect' | 'repair',
    options: CliConnectorMutationInput,
  ): Promise<unknown> => {
    if (!options.confirmed) {
      throw new AppError('bad_request', 'Connector mutation requires explicit confirmation', 400);
    }
    const decision = options.conflictDecision;
    const connector = resolveConnector(id);
    const plan = await connector.plan({
      ...(decision === undefined ? {} : { conflictDecision: decision }),
      ...(options.reviewedEntryFingerprint === undefined
        ? {}
        : { reviewedEntryFingerprint: options.reviewedEntryFingerprint }),
    });
    if (plan.state === 'conflict') {
      if (decision !== 'replace' || plan.mutations.length === 0) {
        throw new AppError(
          'conflict',
          decision === 'replace'
            ? 'The reviewed connector entry cannot be restored safely through the official host CLI'
            : 'The existing connector entry requires an explicit replacement decision',
          409,
        );
      }
    }
    return action === 'connect' ? connector.connect(plan) : connector.repair(plan);
  };
  return {
    async list() {
      return Promise.all(
        input.connectors.map(async (connector) => {
          const inspection = await connector.inspect();
          let available = false;
          if (inspection.state === 'ownedCurrent' || inspection.state === 'equivalentUnowned') {
            available = await connector
              .verify()
              .then((result) => result.available)
              .catch(() => false);
          }
          return {
            id: connector.id,
            displayName: connector.displayName,
            state: inspection.state,
            // The value a reviewer passes back as `--replace <revision>`.
            revision: inspection.entryFingerprint,
            available,
          };
        }),
      );
    },
    connect: (id, options) => act(id, 'connect', options),
    repair: (id, options) => act(id, 'repair', options),
    disconnect: async (id, options) => {
      if (!options.confirmed) {
        throw new AppError('bad_request', 'Connector removal requires explicit confirmation', 400);
      }
      const result = await resolveConnector(id).disconnect();
      return {
        id,
        disconnected: result.changed,
        state: result.state,
        dataPreserved: true,
      };
    },
    instructions: async () => ({
      transport: 'stdio',
      command: input.launcherPath,
      arguments: [],
      tokenIncluded: false,
      connectors: input.connectors.map(({ id, displayName }) => ({ id, displayName })),
    }),
  };
}

export interface AgentCliConfiguration {
  dataDirectory: string;
  databasePath: string;
  baseUrl: string;
  tokenPath: string | null;
  tokenSource: 'environment' | 'file';
  tokenConfigured: boolean;
  mcp: {
    streamableHttpUrl: string;
    stdio: {
      command: string;
      args: string[];
    };
  };
}

export interface CliRuntime {
  createClient(): PimpampumHttpClient;
  createAgentClient(): Promise<AgentCliClient>;
  describeConfig(): AgentCliConfiguration;
  // The entry point resolves these behind getters on first use, so a verb that never touches the
  // service composition never pays for it or fails on its receipts. `undefined` marks a host
  // without that capability.
  serviceManager: ServiceManager;
  serviceOnlyManager?: ServiceManager | undefined;
  updateManager: UpdateManager;
  connections?: CliConnectionsRuntime | undefined;
  setup?: CliSetupRuntime | undefined;
  startServer(): Promise<{ config: { baseUrl: string }; close(): Promise<void> }>;
  startStdioBridge(): Promise<void>;
  readFile(path: string, maxBytes?: number): string;
  readStdin(maxBytes?: number): string | Promise<string>;
  resolvePath(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
  onSignal(signal: 'SIGINT' | 'SIGTERM', callback: () => void): void;
  exit(code: number): never;
}

export { MAX_AGENT_INPUT_BYTES } from './limits.js';
export {
  CLI_USAGE,
  describe,
  MAX_BODY_FILE_BYTES,
  parseCommandArguments,
  resolveCommand,
  type CommandInput,
} from './cliInput.js';
export { CLI_HANDLERS };

/**
 * A gateway whose real client is resolved on every method call. The stdio bridge lives for a whole
 * host session and may start before the daemon has minted its token; resolving per call lets the
 * bridge adopt the token the moment it appears and lets a still-missing token fail typed inside
 * the tool handler, where the MCP layer envelopes it. Only methods are forwarded: a gateway has no
 * data properties, and answering `then` or a symbol would make the proxy look like a thenable.
 */
export function createLazyGateway<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return (...arguments_: unknown[]) => {
        const current = resolve() as Record<PropertyKey, unknown>;
        const method = current[property];
        if (typeof method !== 'function') {
          throw new AppError('internal_error', `Gateway has no method ${property}`, 500);
        }
        return (method as (...input: unknown[]) => unknown).apply(current, arguments_);
      };
    },
  });
}

function writeError(runtime: CliRuntime, value: AgentErrorEnvelope): void {
  runtime.stderr(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Resolve the verb, parse its arguments against the catalog, dispatch. Arguments are validated
 * before any handler runs, so an argument mistake is never hidden behind a daemon or composition
 * failure the handler would have met first.
 */
async function executeCli(
  arguments_: string[],
  runtime: CliRuntime,
): Promise<AgentErrorEnvelope | null> {
  const { command, args } = resolveCommand(arguments_);
  const input = parseCommandArguments(command, args);
  return (await handlerFor(command)({ command, input, runtime })) ?? null;
}

export async function runCli(arguments_: string[], runtime: CliRuntime): Promise<void> {
  let failure: AgentErrorEnvelope | null;
  try {
    failure = await executeCli(arguments_, runtime);
  } catch (error) {
    failure = createLocalErrorEnvelope(error);
  }
  if (failure) {
    writeError(runtime, failure);
    runtime.exit(1);
  }
}
