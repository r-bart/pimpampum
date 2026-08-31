import type { AgentCliClient } from './agentClient.js';
import {
  createAgentSuccessEnvelope,
  createLocalErrorEnvelope,
  extractAgentEnvelope,
  type AgentErrorEnvelope,
} from './agentProtocol.js';
import type { PimpampumHttpClient } from './client.js';
import type { HostConnector } from './connectors/types.js';
import {
  CLI_COMMANDS,
  describeCommands,
  renderUsage,
  renderUsageLine,
  type CliCommand,
} from './cliCommands.js';
import { AppError } from './errors.js';
import { MAX_AGENT_INPUT_BYTES } from './limits.js';
import type { ServiceManager } from './service/types.js';
import type { ArtifactReference, TargetType } from './types.js';
import type { UpdateManager } from './update.js';
import type { SetupStateStore } from './setup/types.js';
import { PIMPAMPUM_VERSION } from './version.js';

export type CliConnectorId = 'codex' | 'claude-code';

export interface CliConnectionsRuntime {
  list(): Promise<unknown>;
  connect(
    id: CliConnectorId,
    input: { confirmed: boolean; conflictDecision: 'replace' | undefined },
  ): Promise<unknown>;
  repair(
    id: CliConnectorId,
    input: { confirmed: boolean; conflictDecision: 'replace' | undefined },
  ): Promise<unknown>;
  disconnect(id: CliConnectorId, input: { confirmed: boolean }): Promise<unknown>;
  instructions(): Promise<unknown>;
}

export interface CliSetupRuntime {
  plan(input: { selectedConnectors: CliConnectorId[] }): Promise<unknown>;
  apply(input: {
    operationId: string;
    expectedRevision: string;
    confirmed: boolean;
    conflictDecisions?: Partial<Record<CliConnectorId, 'replace'>>;
  }): Promise<unknown>;
  status(): Promise<unknown>;
  resume(): Promise<unknown>;
}

export interface SetupCoordinatorCliBoundary {
  plan(input: { selectedConnectors: CliConnectorId[] }): Promise<unknown>;
  apply(input: {
    operationId: string;
    expectedRevision: string;
    confirmed: boolean;
    conflictDecisions?: Partial<Record<CliConnectorId, 'replace'>>;
  }): Promise<unknown>;
  resume(): Promise<unknown>;
}

export function createCliSetupRuntime(
  coordinator: SetupCoordinatorCliBoundary,
  stateStore: Pick<SetupStateStore, 'read'>,
): CliSetupRuntime {
  return {
    plan: (input) => coordinator.plan(input),
    apply: (input) => coordinator.apply(input),
    status: async () => stateStore.read(),
    resume: () => coordinator.resume(),
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
    confirmed: boolean,
    decision: 'replace' | undefined,
  ): Promise<unknown> => {
    if (!confirmed) {
      throw new AppError('bad_request', 'Connector mutation requires explicit confirmation', 400);
    }
    const connector = resolveConnector(id);
    const plan = await connector.plan();
    if (plan.state === 'conflict') {
      if (decision !== 'replace') {
        throw new AppError(
          'conflict',
          'The existing connector entry requires an explicit replacement decision',
          409,
        );
      }
      throw new AppError(
        'conflict',
        'Replacement was explicitly requested, but this connector cannot safely replace the current unowned entry',
        409,
      );
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
            available,
          };
        }),
      );
    },
    connect: (id, options) => act(id, 'connect', options.confirmed, options.conflictDecision),
    repair: (id, options) => act(id, 'repair', options.confirmed, options.conflictDecision),
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
  serviceManager: ServiceManager;
  serviceOnlyManager?: ServiceManager;
  updateManager: UpdateManager;
  connections?: CliConnectionsRuntime;
  setup?: CliSetupRuntime;
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

export const CLI_USAGE = renderUsage(PIMPAMPUM_VERSION);

function required(value: string | undefined, label: string): string {
  if (!value) throw new AppError('bad_request', `Missing ${label}`, 400);
  return value;
}

function targetType(value: string | undefined): TargetType {
  const resolved = required(value, 'target type');
  if (resolved !== 'spec' && resolved !== 'task') {
    throw new AppError('bad_request', 'Target type must be spec or task', 400);
  }
  return resolved;
}

function revision(value: string | undefined): number {
  const parsed = Number(required(value, 'revision'));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('bad_request', 'Revision must be a positive integer', 400);
  }
  return parsed;
}

function acceptOptionalJsonFlag(arguments_: string[], startIndex: number): void {
  const trailing = arguments_.slice(startIndex);
  if (trailing.length > 1 || trailing.some((argument) => argument !== '--json')) {
    throw new AppError('bad_request', 'Only the optional --json flag is accepted', 400);
  }
}

/**
 * Every success leaves the process as one `{ "data": ... }` envelope. `printEnvelope` exists for
 * the one payload that already arrives enveloped from the daemon, so `call` does not wrap twice.
 */
function print(runtime: CliRuntime, value: unknown): void {
  printEnvelope(runtime, createAgentSuccessEnvelope(value));
}

function printEnvelope(runtime: CliRuntime, value: unknown): void {
  runtime.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function redactText(value: string): string {
  return value
    .replace(/(?:authorization\s*:?\s*)?bearer\s+\S+/giu, '[credential redacted]')
    .replace(/\bPIMPAMPUM_TOKEN\b(?:\s*[:=]\s*\S+)?/giu, '[credential redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/giu, '[credential redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 2_048);
}

function redactBoundaryValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[bounded]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value))
    return value.slice(0, 512).map((item) => redactBoundaryValue(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 512)
      .map(([key, item]) => [
        key,
        /^(?:authorization|token|secret|api[_-]?key|access[_-]?token)$/iu.test(key)
          ? '[credential redacted]'
          : redactBoundaryValue(item, depth + 1),
      ]),
  );
}

function printBoundary(runtime: CliRuntime, value: unknown): void {
  print(runtime, redactBoundaryValue(value));
}

async function callBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError(
        error.code,
        redactText(error.message),
        error.status,
        error.retryable,
        redactBoundaryValue(error.details) as Record<string, unknown>,
      );
    }
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    const message = redactText(
      error instanceof Error ? error.message : 'The local operation failed',
    );
    if (/CONFLICT/iu.test(code) || /conflict|requires a decision/iu.test(message)) {
      throw new AppError('conflict', message || 'An explicit conflict decision is required', 409);
    }
    throw new AppError('internal_error', message || 'The local operation failed', 500);
  }
}

function connectorId(value: string | undefined): CliConnectorId {
  const id = required(value, 'connector id');
  if (id !== 'codex' && id !== 'claude-code') {
    throw new AppError('bad_request', 'Connector id must be codex or claude-code', 400);
  }
  return id;
}

function requireConfirmation(command: CliCommand, input: CommandInput): void {
  if (!input.boolean('--yes')) {
    throw badArgument(command, 'This operation requires the explicit --yes flag');
  }
}

function connectionsRuntime(runtime: CliRuntime): CliConnectionsRuntime {
  if (runtime.connections === undefined) {
    throw new AppError('unavailable', 'Connection management is unavailable in this runtime', 503);
  }
  return runtime.connections;
}

function setupRuntime(runtime: CliRuntime): CliSetupRuntime {
  if (runtime.setup === undefined) {
    throw new AppError('unavailable', 'Setup management is unavailable in this runtime', 503);
  }
  return runtime.setup;
}

const commandsByName = new Map(CLI_COMMANDS.map((command) => [command.name, command]));

export function describe(name: string): CliCommand {
  const command = commandsByName.get(name);
  if (!command) throw new AppError('internal_error', `Undeclared CLI command: ${name}`, 500);
  return command;
}

function badArgument(command: CliCommand, message: string): AppError {
  return new AppError('bad_request', message, 400, false, { usage: renderUsageLine(command) });
}

export interface CommandInput {
  positional: string[];
  option(flag: string): string | undefined;
  optionAll(flag: string): string[];
  boolean(flag: string): boolean;
}

/**
 * Parses one command's arguments against its catalog entry. Options are declared, so an unknown
 * flag and a surplus positional both fail loudly with that command's usage line attached, instead
 * of being dropped on the floor.
 */
export function parseCommandArguments(command: CliCommand, args: string[]): CommandInput {
  const declared = new Map(command.options.map((option) => [option.flag, option]));
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positional: string[] = [];
  const remaining = [...args].reverse();
  let optionsEnded = false;

  for (let token = remaining.pop(); token !== undefined; token = remaining.pop()) {
    // `--` ends option parsing, so a summary, reason or note may itself begin with two dashes.
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const option = declared.get(token);
    if (!option) {
      throw badArgument(command, `Unknown option for ${command.name}: ${token}`);
    }
    if (option.value === null) {
      if (flags.has(token)) throw badArgument(command, `Repeated option: ${token}`);
      flags.add(token);
      continue;
    }
    const value = remaining.pop();
    if (value === undefined || value.startsWith('--')) {
      throw badArgument(command, `Option ${token} requires a value`);
    }
    const existing = values.get(token);
    if (existing && option.repeatable !== true) {
      throw badArgument(command, `Repeated option: ${token}`);
    }
    values.set(token, [...(existing ?? []), value]);
  }

  if (positional.length > command.arguments.length) {
    throw badArgument(
      command,
      `${command.name} accepts at most ${String(command.arguments.length)} positional arguments`,
    );
  }

  return {
    positional,
    option: (flag) => values.get(flag)?.[0],
    optionAll: (flag) => values.get(flag) ?? [],
    boolean: (flag) => flags.has(flag),
  };
}

/**
 * Some verbs accept the same value positionally or by flag, for backward compatibility. Supplying
 * both is ambiguous, so it fails instead of letting one side win quietly.
 */
function exclusive(
  command: CliCommand,
  input: CommandInput,
  flag: string,
  positionalIndex: number,
  positionalName: string,
): string | undefined {
  const flagged = input.option(flag);
  const positional = input.positional[positionalIndex];
  if (flagged !== undefined && positional !== undefined) {
    throw badArgument(command, `Pass either the ${positionalName} argument or ${flag}, not both`);
  }
  return flagged ?? positional;
}

function optionalCount(input: CommandInput, flag: string, label: string): number | undefined {
  const raw = input.option(flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('bad_request', `${label} must be a positive integer`, 400);
  }
  return parsed;
}

function actorOf(input: CommandInput): string {
  return input.option('--actor') ?? 'cli';
}

/**
 * Artifact references from either `--artifact <uri>`, repeated, or one `--artifacts <json>` array.
 * Bounds and field limits stay with the daemon schema, which is the authority.
 */
function artifactsOf(command: CliCommand, input: CommandInput): ArtifactReference[] {
  const uris = input.optionAll('--artifact');
  const serialized = input.option('--artifacts');
  if (serialized !== undefined && uris.length > 0) {
    throw badArgument(command, 'Choose either --artifact or --artifacts, not both');
  }
  if (serialized === undefined) {
    return uris.map((uri) => ({ label: null, uri }));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    throw badArgument(command, '--artifacts must be valid JSON');
  }
  if (!Array.isArray(decoded)) {
    throw badArgument(command, '--artifacts must be a JSON array');
  }
  return decoded.map((entry) => {
    if (!isRecord(entry) || typeof entry.uri !== 'string' || entry.uri.length === 0) {
      throw badArgument(command, 'Each --artifacts entry needs a non-empty uri string');
    }
    const label = entry.label;
    if (label !== undefined && label !== null && typeof label !== 'string') {
      throw badArgument(command, 'An --artifacts label must be a string or null');
    }
    return { label: label ?? null, uri: entry.uri };
  });
}

function writeError(runtime: CliRuntime, value: AgentErrorEnvelope): void {
  runtime.stderr(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseToolInput(
  arguments_: string[],
  runtime: CliRuntime,
): Promise<{ name: string; input: Record<string, unknown> }> {
  const name = required(arguments_[0], 'tool name');
  const sources: Array<
    { kind: 'inline'; value: string } | { kind: 'stdin' } | { kind: 'file'; path: string }
  > = [];
  let index = 1;
  while (index < arguments_.length) {
    const argument = arguments_[index];
    if (argument === '--input') {
      sources.push({
        kind: 'inline',
        value: required(arguments_[index + 1], 'inline JSON input'),
      });
      index += 2;
      continue;
    }
    if (argument === '--stdin') {
      sources.push({ kind: 'stdin' });
      index += 1;
      continue;
    }
    if (argument === '--input-file') {
      sources.push({
        kind: 'file',
        path: runtime.resolvePath(required(arguments_[index + 1], 'input file path')),
      });
      index += 2;
      continue;
    }
    throw new AppError('bad_request', `Unknown call argument: ${String(argument)}`, 400);
  }
  if (sources.length > 1) {
    throw new AppError('bad_request', 'Choose only one tool input source', 400);
  }
  const source = sources[0];
  let serialized: string;
  if (!source) {
    serialized = '{}';
  } else if (source.kind === 'inline') {
    serialized = source.value;
  } else if (source.kind === 'stdin') {
    serialized = await runtime.readStdin(MAX_AGENT_INPUT_BYTES);
  } else {
    try {
      serialized = runtime.readFile(source.path, MAX_AGENT_INPUT_BYTES);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('bad_request', `Could not read tool input file: ${source.path}`, 400);
    }
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AGENT_INPUT_BYTES) {
    throw new AppError(
      'payload_too_large',
      `Tool input exceeds ${String(MAX_AGENT_INPUT_BYTES)} UTF-8 bytes`,
      413,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    throw new AppError('bad_request', 'Tool input must be valid JSON', 400);
  }
  if (!isRecord(input)) {
    throw new AppError('bad_request', 'Tool input must be a JSON object', 400);
  }
  return { name, input };
}

async function withAgentClient<T>(
  runtime: CliRuntime,
  operation: (client: AgentCliClient) => Promise<T>,
): Promise<T> {
  const client = await runtime.createAgentClient();
  try {
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function executeCli(
  arguments_: string[],
  runtime: CliRuntime,
): Promise<AgentErrorEnvelope | null> {
  const [command, ...args] = arguments_;
  if (!command) {
    throw new AppError('bad_request', 'Missing command', 400, false, { usage: CLI_USAGE });
  }

  // `help` is the one command that prints text rather than an envelope, because it is the human
  // affordance. `commands` returns the same catalog as JSON for everything else.
  if (command === 'help' || command === '--help' || command === '-h') {
    runtime.stdout(CLI_USAGE);
    return null;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    print(runtime, { name: 'pimpampum', version: PIMPAMPUM_VERSION });
    return null;
  }
  if (command === 'commands') {
    print(runtime, describeCommands(PIMPAMPUM_VERSION));
    return null;
  }

  // stdout carries the MCP protocol for this command, so it writes no envelope. The bridge owns
  // its own shutdown signals and keeps the process alive until the host closes the transport.
  if (command === 'mcp') {
    await runtime.startStdioBridge();
    return null;
  }

  if (command === 'serve') {
    const running = await runtime.startServer();
    print(runtime, { listening: true, baseUrl: running.config.baseUrl });
    const shutdown = async () => {
      await running.close();
      runtime.exit(0);
    };
    runtime.onSignal('SIGINT', () => void shutdown());
    runtime.onSignal('SIGTERM', () => void shutdown());
    return null;
  }

  if (command === 'config') {
    print(runtime, runtime.describeConfig());
    return null;
  }

  if (command === 'connections') {
    const input = parseCommandArguments(describe(command), args);
    if (input.positional.length > 0)
      throw badArgument(describe(command), 'connections takes no arguments');
    printBoundary(runtime, await callBoundary(() => connectionsRuntime(runtime).list()));
    return null;
  }
  if (command === 'connect') {
    const descriptor = describe(command);
    const input = parseCommandArguments(descriptor, args);
    const connections = connectionsRuntime(runtime);
    if (input.boolean('--instructions')) {
      if (input.positional.length > 0 || input.boolean('--yes') || input.boolean('--replace')) {
        throw badArgument(
          descriptor,
          '--instructions cannot be combined with a connector or mutation flags',
        );
      }
      printBoundary(runtime, await callBoundary(() => connections.instructions()));
      return null;
    }
    requireConfirmation(descriptor, input);
    const id = connectorId(input.positional[0]);
    printBoundary(
      runtime,
      await callBoundary(() =>
        connections.connect(id, {
          confirmed: true,
          conflictDecision: input.boolean('--replace') ? 'replace' : undefined,
        }),
      ),
    );
    return null;
  }
  if (command === 'repair') {
    const descriptor = describe(command);
    const input = parseCommandArguments(descriptor, args);
    requireConfirmation(descriptor, input);
    const id = connectorId(input.positional[0]);
    printBoundary(
      runtime,
      await callBoundary(() =>
        connectionsRuntime(runtime).repair(id, {
          confirmed: true,
          conflictDecision: input.boolean('--replace') ? 'replace' : undefined,
        }),
      ),
    );
    return null;
  }
  if (command === 'disconnect') {
    const descriptor = describe(command);
    const input = parseCommandArguments(descriptor, args);
    requireConfirmation(descriptor, input);
    const id = connectorId(input.positional[0]);
    printBoundary(
      runtime,
      await callBoundary(() => connectionsRuntime(runtime).disconnect(id, { confirmed: true })),
    );
    return null;
  }
  if (command === 'setup') {
    const action = required(args[0], 'setup action');
    const setup = setupRuntime(runtime);
    if (action === 'plan') {
      const descriptor = describe('setup plan');
      const input = parseCommandArguments(descriptor, args.slice(1));
      const selectedConnectors = input.optionAll('--connector').map(connectorId);
      printBoundary(runtime, await callBoundary(() => setup.plan({ selectedConnectors })));
      return null;
    }
    if (action === 'apply') {
      const descriptor = describe('setup apply');
      const input = parseCommandArguments(descriptor, args.slice(1));
      requireConfirmation(descriptor, input);
      const replacements = input.optionAll('--replace').map(connectorId);
      const conflictDecisions = Object.fromEntries(
        replacements.map((id) => [id, 'replace' as const]),
      ) as Partial<Record<CliConnectorId, 'replace'>>;
      printBoundary(
        runtime,
        await callBoundary(() =>
          setup.apply({
            operationId: required(input.positional[0], 'operation id'),
            expectedRevision: required(input.positional[1], 'expected revision'),
            confirmed: true,
            ...(replacements.length === 0 ? {} : { conflictDecisions }),
          }),
        ),
      );
      return null;
    }
    if (action === 'status') {
      parseCommandArguments(describe('setup status'), args.slice(1));
      printBoundary(runtime, await callBoundary(() => setup.status()));
      return null;
    }
    if (action === 'resume') {
      parseCommandArguments(describe('setup resume'), args.slice(1));
      printBoundary(runtime, await callBoundary(() => setup.resume()));
      return null;
    }
    throw new AppError('bad_request', `Unknown setup action: ${action}`, 400);
  }
  if (command === 'tools') {
    const catalog = await withAgentClient(runtime, (client) => client.listTools());
    print(runtime, catalog);
    return null;
  }
  if (command === 'call') {
    const { name, input } = await parseToolInput(args, runtime);
    const envelope = await withAgentClient(runtime, async (client) =>
      extractAgentEnvelope(await client.callTool({ name, arguments: input })),
    );
    if ('error' in envelope) return envelope;
    printEnvelope(runtime, envelope);
    return null;
  }

  if (command === 'install') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--service-only')) {
      throw new AppError(
        'bad_request',
        'Install accepts only the optional --service-only flag',
        400,
      );
    }
    const manager =
      args[0] === '--service-only'
        ? (runtime.serviceOnlyManager ?? runtime.serviceManager)
        : runtime.serviceManager;
    print(runtime, await manager.install());
    return null;
  }
  if (command === 'status') {
    print(runtime, await runtime.serviceManager.status());
    return null;
  }
  if (command === 'update:check') {
    print(runtime, await runtime.updateManager.check());
    return null;
  }
  if (command === 'update') {
    print(runtime, await runtime.updateManager.update());
    return null;
  }
  if (command === 'uninstall') {
    print(runtime, await runtime.serviceManager.uninstall());
    return null;
  }

  const client = runtime.createClient();
  switch (command) {
    case 'health':
      print(runtime, await client.health());
      return null;
    case 'overview':
      print(runtime, await client.getOverview());
      return null;
    case 'workspace:list':
      print(runtime, await client.listWorkspaces());
      return null;
    case 'workspace:add': {
      const input = parseCommandArguments(describe(command), args);
      print(
        runtime,
        await client.registerWorkspace({
          id: required(input.positional[0], 'workspace id'),
          name: required(input.positional[1], 'workspace name'),
          rootPath: runtime.resolvePath(required(input.positional[2], 'workspace root path')),
        }),
      );
      return null;
    }
    case 'work:list': {
      const input = parseCommandArguments(describe(command), args);
      print(
        runtime,
        await client.listWork({
          workspaceId: input.positional[0] ?? null,
          projectId: input.positional[1] ?? null,
          specId: input.positional[2] ?? null,
          limit: optionalCount(input, '--limit', 'Limit') ?? 50,
        }),
      );
      return null;
    }
    case 'work:start':
    case 'work:renew': {
      const descriptor = describe(command);
      const input = parseCommandArguments(descriptor, args);
      const claim = {
        targetType: targetType(input.positional[0]),
        targetId: required(input.positional[1], 'target id'),
        agentId: required(input.positional[2], 'agent id'),
        leaseSeconds: optionalCount(input, '--lease-seconds', 'Lease seconds') ?? 1_800,
      };
      print(
        runtime,
        command === 'work:start' ? await client.startWork(claim) : await client.renewWork(claim),
      );
      return null;
    }
    case 'work:release': {
      const input = parseCommandArguments(describe(command), args);
      await client.releaseWork({
        targetType: targetType(input.positional[0]),
        targetId: required(input.positional[1], 'target id'),
        agentId: required(input.positional[2], 'agent id'),
        note: exclusive(describe(command), input, '--note', 3, 'note') ?? null,
      });
      print(runtime, { released: true });
      return null;
    }
    case 'work:complete': {
      const descriptor = describe(command);
      const input = parseCommandArguments(descriptor, args);
      print(
        runtime,
        await client.completeWork({
          targetType: targetType(input.positional[0]),
          targetId: required(input.positional[1], 'target id'),
          agentId: required(input.positional[2], 'agent id'),
          expectedRevision: revision(input.positional[3]),
          summary: required(input.positional[4], 'summary'),
          artifacts: artifactsOf(descriptor, input),
        }),
      );
      return null;
    }
    case 'project:create': {
      const input = parseCommandArguments(describe(command), args);
      print(
        runtime,
        await client.createProject({
          workspaceId: required(input.positional[0], 'workspace id'),
          slug: required(input.positional[1], 'project slug'),
          title: required(input.positional[2], 'project title'),
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'project:get': {
      const input = parseCommandArguments(describe(command), args);
      print(runtime, await client.getProject(required(input.positional[0], 'project id')));
      return null;
    }
    case 'project:draft':
    case 'project:open':
    case 'project:pause': {
      const input = parseCommandArguments(describe(command), args);
      const state =
        command === 'project:pause' ? 'paused' : command === 'project:open' ? 'open' : 'draft';
      print(
        runtime,
        await client.updateProject({
          projectId: required(input.positional[0], 'project id'),
          title: null,
          state,
          expectedRevision: revision(input.positional[1]),
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'project:complete': {
      const descriptor = describe(command);
      const input = parseCommandArguments(descriptor, args);
      print(
        runtime,
        await client.completeProject({
          projectId: required(input.positional[0], 'project id'),
          expectedRevision: revision(input.positional[1]),
          summary: required(input.positional[2], 'summary'),
          artifacts: artifactsOf(descriptor, input),
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'project:cancel': {
      const input = parseCommandArguments(describe(command), args);
      print(
        runtime,
        await client.cancelProject({
          projectId: required(input.positional[0], 'project id'),
          expectedRevision: revision(input.positional[1]),
          reason: required(input.positional[2], 'reason'),
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'spec:create': {
      const descriptor = describe(command);
      const input = parseCommandArguments(descriptor, args);
      const bodyFile = exclusive(descriptor, input, '--body-file', 3, 'body-file');
      print(
        runtime,
        await client.createSpec({
          projectId: required(input.positional[0], 'project id'),
          slug: required(input.positional[1], 'spec slug'),
          title: required(input.positional[2], 'spec title'),
          body: bodyFile ? runtime.readFile(bodyFile) : '',
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'spec:get': {
      const input = parseCommandArguments(describe(command), args);
      print(runtime, await client.getSpec(required(input.positional[0], 'spec id')));
      return null;
    }
    case 'spec:draft':
    case 'spec:ready': {
      const input = parseCommandArguments(describe(command), args);
      print(
        runtime,
        await client.updateSpec({
          specId: required(input.positional[0], 'spec id'),
          title: null,
          body: null,
          state: command === 'spec:ready' ? 'ready' : 'draft',
          expectedRevision: revision(input.positional[1]),
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'spec:cancel': {
      const input = parseCommandArguments(describe(command), args);
      print(
        runtime,
        await client.cancelSpec({
          specId: required(input.positional[0], 'spec id'),
          expectedRevision: revision(input.positional[1]),
          reason: required(input.positional[2], 'reason'),
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'task:create': {
      const descriptor = describe(command);
      const input = parseCommandArguments(descriptor, args);
      const bodyFile = input.option('--body-file');
      print(
        runtime,
        await client.createTask({
          specId: required(input.positional[0], 'spec id'),
          title: required(input.positional[1], 'task title'),
          parentId: exclusive(descriptor, input, '--parent', 2, 'parent-id') ?? null,
          body: bodyFile ? runtime.readFile(bodyFile) : null,
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'task:get': {
      const input = parseCommandArguments(describe(command), args);
      print(runtime, await client.getTask(required(input.positional[0], 'task id')));
      return null;
    }
    case 'task:cancel': {
      const input = parseCommandArguments(describe(command), args);
      print(
        runtime,
        await client.cancelTask({
          taskId: required(input.positional[0], 'task id'),
          expectedRevision: revision(input.positional[1]),
          reason: required(input.positional[2], 'reason'),
          actor: actorOf(input),
        }),
      );
      return null;
    }
    case 'backup':
      if (args[0] === 'status') {
        acceptOptionalJsonFlag(args, 1);
        print(runtime, await client.getAutomaticBackupStatus());
        return null;
      }
      if (args[0] === 'configure') {
        acceptOptionalJsonFlag(args, 2);
        print(
          runtime,
          await client.configureAutomaticBackup(
            runtime.resolvePath(required(args[1], 'backup directory')),
          ),
        );
        return null;
      }
      if (args[0] === 'retry') {
        acceptOptionalJsonFlag(args, 1);
        const status = await client.retryAutomaticBackup();
        if (status.state === 'error') {
          throw new AppError(
            'internal_error',
            status.error ?? 'Automatic backup retry failed',
            500,
            true,
          );
        }
        print(runtime, status);
        return null;
      }
      if (args[0] === 'disable') {
        acceptOptionalJsonFlag(args, 1);
        print(runtime, await client.disableAutomaticBackup());
        return null;
      }
      print(
        runtime,
        await client.backup(runtime.resolvePath(required(args[0], 'backup directory'))),
      );
      return null;
    case 'export':
      print(
        runtime,
        await client.exportPortable(runtime.resolvePath(required(args[0], 'export directory'))),
      );
      return null;
    case 'sync': {
      const action = required(args[0], 'sync action');
      if (action === 'status') {
        acceptOptionalJsonFlag(args, 1);
        print(runtime, await client.getSyncStatus());
        return null;
      }
      if (action === 'configure') {
        const directory = runtime.resolvePath(required(args[1], 'shared folder'));
        const deviceIndex = args.indexOf('--device');
        if (deviceIndex !== 2 || !args[3] || args.slice(4).some((value) => value !== '--json')) {
          throw new AppError(
            'bad_request',
            'Use sync configure <directory> --device <device-id> [--json]',
            400,
          );
        }
        print(runtime, await client.configureSync(directory, args[3]));
        return null;
      }
      if (action === 'resolve') {
        const conflictId = required(args[1], 'conflict id');
        const choice = required(args[2], 'conflict choice');
        if (
          (choice !== 'local' && choice !== 'remote') ||
          args.slice(3).some((value) => value !== '--json')
        ) {
          throw new AppError(
            'bad_request',
            'Use sync resolve <conflict-id> <local|remote> [--json]',
            400,
          );
        }
        print(runtime, await client.resolveSyncConflict(conflictId, choice));
        return null;
      }
      acceptOptionalJsonFlag(args, 1);
      if (action === 'now') print(runtime, await client.reconcileSync());
      else if (action === 'pause') print(runtime, await client.pauseSync());
      else if (action === 'resume') print(runtime, await client.resumeSync());
      else if (action === 'conflicts') print(runtime, await client.listSyncConflicts());
      else if (action === 'forget') print(runtime, await client.forgetSync());
      else throw new AppError('bad_request', `Unknown sync action: ${action}`, 400);
      return null;
    }
    default:
      throw new AppError('bad_request', `Unknown command: ${command}`, 400, false, {
        usage: CLI_USAGE,
      });
  }
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
