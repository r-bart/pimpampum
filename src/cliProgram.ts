import type { AgentCliClient } from './agentClient.js';
import {
  createAgentSuccessEnvelope,
  createLocalErrorEnvelope,
  extractAgentEnvelope,
  localErrorDetails,
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
  type CliOption,
} from './cliCommands.js';
import { AppError, type ErrorCode } from './errors.js';
import { MAX_AGENT_INPUT_BYTES } from './limits.js';
import type { ServiceManager } from './service/types.js';
import type { ArtifactReference, TargetType } from './types.js';
import type { UpdateManager } from './update.js';
import type { SetupStateStore } from './setup/types.js';
import type { SetupProgressEvent } from './setup/types.js';
import { PIMPAMPUM_VERSION } from './version.js';

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

/**
 * `--body-file` cap. The daemon's body limit is the authority; this bound only stops the CLI from
 * loading an arbitrary file into memory before the daemon can refuse it.
 */
export const MAX_BODY_FILE_BYTES = 1_000_000;

export const CLI_USAGE = renderUsage(PIMPAMPUM_VERSION);

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

function printSetupEvent(runtime: CliRuntime, event: 'progress' | 'result', data: unknown): void {
  runtime.stdout(
    `${JSON.stringify({ schemaVersion: 1, event, data: redactBoundaryValue(data) })}\n`,
  );
}

/**
 * Emits the setup result through the channel the caller selected: the NDJSON event stream when
 * `--events` was passed, the one redacted envelope otherwise.
 */
function printSetupResult(runtime: CliRuntime, events: boolean, result: unknown): void {
  if (events) printSetupEvent(runtime, 'result', result);
  else printBoundary(runtime, result);
}

function setupProgressReporter(
  runtime: CliRuntime,
  events: boolean,
): ((event: SetupProgressEvent) => void) | undefined {
  return events ? (event) => printSetupEvent(runtime, 'progress', event) : undefined;
}

/**
 * The setup and connector layers throw plain errors that carry a stable `code` property. This
 * table is the only translation to an agent error code; message text is never classified, so a
 * diagnostic that happens to mention a conflict cannot change the exit contract.
 *
 * `CONNECTOR_CONFLICT` is thrown today. The `SETUP_*` codes name the coordinator's plain-error
 * sites so they map correctly the moment the coordinator adopts them.
 */
const LOCAL_ERROR_CODES: Readonly<Record<string, { code: ErrorCode; status: number }>> = {
  CONNECTOR_CONFLICT: { code: 'conflict', status: 409 },
  SETUP_PLAN_STALE: { code: 'conflict', status: 409 },
  SETUP_OPERATION_IN_PROGRESS: { code: 'conflict', status: 409 },
  SETUP_JOURNAL_REVISION_MISMATCH: { code: 'conflict', status: 409 },
  SETUP_CONFIRMATION_REQUIRED: { code: 'bad_request', status: 400 },
  SETUP_CONNECTOR_NOT_SELECTED: { code: 'bad_request', status: 400 },
  SETUP_UNSUPPORTED_CONNECTOR: { code: 'bad_request', status: 400 },
  SETUP_NOTHING_TO_RESUME: { code: 'not_found', status: 404 },
};

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
    const typed = LOCAL_ERROR_CODES[code];
    if (typed !== undefined) {
      throw new AppError(typed.code, message || 'The local operation failed', typed.status);
    }
    throw new AppError(
      'internal_error',
      message || 'The local operation failed',
      500,
      false,
      error instanceof Error
        ? (redactBoundaryValue(localErrorDetails(error)) as Record<string, unknown>)
        : {},
    );
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

/** `--replace` alone, or `--replace <revision>` pinning the exact entry the reviewer saw. */
function replacementOf(input: CommandInput): CliConnectorMutationInput {
  const revision = input.option('--replace');
  return {
    confirmed: true,
    conflictDecision: input.boolean('--replace') ? 'replace' : undefined,
    ...(revision === undefined ? {} : { reviewedEntryFingerprint: revision }),
  };
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

/**
 * Resolves `<group> <action>` from user input. An action the catalog does not declare is the
 * caller's mistake, so it fails as `bad_request` with the whole banner, never as the
 * `internal_error` that `describe` reserves for a verb the program forgot to declare.
 */
function describeAction(group: string, action: string | undefined): CliCommand {
  const name = `${group} ${required(action, `${group} action`)}`;
  const command = commandsByName.get(name);
  if (!command) {
    throw new AppError('bad_request', `Unknown ${group} action: ${String(action)}`, 400, false, {
      usage: CLI_USAGE,
    });
  }
  return command;
}

function badArgument(command: CliCommand, message: string): AppError {
  return new AppError('bad_request', message, 400, false, { usage: renderUsageLine(command) });
}

/**
 * Reads a `--body-file` through the runtime's bounded reader. A missing or unreadable file is the
 * caller's argument problem and names the path; a bounded-read failure keeps its own typed code.
 */
function readBodyFile(runtime: CliRuntime, path: string): string {
  const resolved = runtime.resolvePath(path);
  try {
    return runtime.readFile(resolved, MAX_BODY_FILE_BYTES);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('bad_request', `Could not read body file: ${resolved}`, 400, false, {
      path: resolved,
    });
  }
}

export interface CommandInput {
  positional: string[];
  option(flag: string): string | undefined;
  optionAll(flag: string): string[];
  /** `true` when the flag appeared, bare or with a value. */
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
    const existing = values.get(token);
    if (
      option.value === null ||
      (option.valueOptional === true && !takesOptionalValue(option, remaining))
    ) {
      if (flags.has(token) || existing !== undefined) {
        throw badArgument(command, `Repeated option: ${token}`);
      }
      flags.add(token);
      continue;
    }
    const value = remaining.pop();
    if (value === undefined || value.startsWith('--')) {
      throw badArgument(command, `Option ${token} requires a value`);
    }
    if ((existing !== undefined && option.repeatable !== true) || flags.has(token)) {
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
    // Present in either form: bare, or with a value.
    boolean: (flag) => flags.has(flag) || values.has(flag),
  };
}

/** Whether the next token is the optional value of `option` rather than a positional or a flag. */
function takesOptionalValue(option: CliOption, remaining: readonly string[]): boolean {
  const next = remaining[remaining.length - 1];
  if (next === undefined || next.startsWith('--')) return false;
  return option.valuePattern === undefined || new RegExp(option.valuePattern, 'u').test(next);
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
  const descriptor = describe('call');
  const parsed = parseCommandArguments(descriptor, arguments_);
  const name = required(parsed.positional[0], 'tool name');
  const inline = parsed.option('--input');
  const inputFile = parsed.option('--input-file');
  const selected = [inline, inputFile, parsed.boolean('--stdin') ? 'stdin' : undefined].filter(
    (source) => source !== undefined,
  );
  if (selected.length > 1) throw badArgument(descriptor, 'Choose only one tool input source');
  let serialized: string;
  if (inline !== undefined) {
    serialized = inline;
  } else if (parsed.boolean('--stdin')) {
    serialized = await runtime.readStdin(MAX_AGENT_INPUT_BYTES);
  } else if (inputFile !== undefined) {
    const path = runtime.resolvePath(inputFile);
    try {
      serialized = runtime.readFile(path, MAX_AGENT_INPUT_BYTES);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('bad_request', `Could not read tool input file: ${path}`, 400);
    }
  } else {
    serialized = '{}';
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
  // affordance. `commands` returns the same catalog as JSON for everything else. Even these parse
  // their arguments, so a typo never passes silently on any verb.
  if (command === 'help' || command === '--help' || command === '-h') {
    parseCommandArguments(describe('help'), args);
    runtime.stdout(CLI_USAGE);
    return null;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    parseCommandArguments(describe('version'), args);
    print(runtime, { name: 'pimpampum', version: PIMPAMPUM_VERSION });
    return null;
  }
  if (command === 'commands') {
    parseCommandArguments(describe(command), args);
    print(runtime, describeCommands(PIMPAMPUM_VERSION));
    return null;
  }

  // stdout carries the MCP protocol for this command, so it writes no envelope. The bridge owns
  // its own shutdown signals and keeps the process alive until the host closes the transport.
  if (command === 'mcp') {
    parseCommandArguments(describe(command), args);
    await runtime.startStdioBridge();
    return null;
  }

  if (command === 'serve') {
    parseCommandArguments(describe(command), args);
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
    parseCommandArguments(describe(command), args);
    print(runtime, runtime.describeConfig());
    return null;
  }

  if (command === 'connections') {
    parseCommandArguments(describe(command), args);
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
    printBoundary(runtime, await callBoundary(() => connections.connect(id, replacementOf(input))));
    return null;
  }
  if (command === 'repair') {
    const descriptor = describe(command);
    const input = parseCommandArguments(descriptor, args);
    requireConfirmation(descriptor, input);
    const id = connectorId(input.positional[0]);
    printBoundary(
      runtime,
      await callBoundary(() => connectionsRuntime(runtime).repair(id, replacementOf(input))),
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
    const descriptor = describeAction(command, args[0]);
    const input = parseCommandArguments(descriptor, args.slice(1));
    const setup = setupRuntime(runtime);
    const events = input.boolean('--events');
    switch (descriptor.name) {
      case 'setup plan': {
        const selectedConnectors = input.optionAll('--connector').map(connectorId);
        printBoundary(runtime, await callBoundary(() => setup.plan({ selectedConnectors })));
        return null;
      }
      case 'setup apply': {
        requireConfirmation(descriptor, input);
        const replacements = input.optionAll('--replace').map(connectorId);
        const keeps = input.optionAll('--keep').map(connectorId);
        if (keeps.length > 0 && !events) {
          throw badArgument(descriptor, 'Keep decisions are reserved for native setup event mode');
        }
        if (keeps.some((id) => replacements.includes(id))) {
          throw badArgument(
            descriptor,
            'A connector cannot be both kept and replaced in one setup decision',
          );
        }
        const conflictDecisions = Object.fromEntries([
          ...replacements.map((id) => [id, 'replace' as const] as const),
          ...keeps.map((id) => [id, 'keep' as const] as const),
        ]) as Partial<Record<CliConnectorId, 'replace' | 'keep'>>;
        const onProgress = setupProgressReporter(runtime, events);
        const result = await callBoundary(() =>
          setup.apply({
            operationId: required(input.positional[0], 'operation id'),
            expectedRevision: required(input.positional[1], 'expected revision'),
            confirmed: true,
            ...(replacements.length === 0 && keeps.length === 0 ? {} : { conflictDecisions }),
            ...(onProgress === undefined ? {} : { onProgress }),
          }),
        );
        printSetupResult(runtime, events, result);
        return null;
      }
      case 'setup retry': {
        if (!events) throw badArgument(descriptor, 'setup retry requires --events');
        const id = connectorId(input.positional[0]);
        const result = await callBoundary(() =>
          setup.retryConnector(id, setupProgressReporter(runtime, true)),
        );
        printSetupResult(runtime, true, result);
        return null;
      }
      case 'setup status': {
        printBoundary(runtime, await callBoundary(() => setup.status()));
        return null;
      }
      default: {
        const onProgress = setupProgressReporter(runtime, events);
        const result = await callBoundary(() =>
          setup.resume(onProgress === undefined ? undefined : { onProgress }),
        );
        printSetupResult(runtime, events, result);
        return null;
      }
    }
  }
  if (command === 'tools') {
    parseCommandArguments(describe(command), args);
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
    const input = parseCommandArguments(describe(command), args);
    const manager = input.boolean('--service-only')
      ? (runtime.serviceOnlyManager ?? runtime.serviceManager)
      : runtime.serviceManager;
    print(runtime, await manager.install());
    return null;
  }
  if (command === 'status') {
    parseCommandArguments(describe(command), args);
    print(runtime, await runtime.serviceManager.status());
    return null;
  }
  if (command === 'update:check') {
    parseCommandArguments(describe(command), args);
    print(runtime, await runtime.updateManager.check());
    return null;
  }
  if (command === 'update') {
    parseCommandArguments(describe(command), args);
    print(runtime, await runtime.updateManager.update());
    return null;
  }
  if (command === 'uninstall') {
    parseCommandArguments(describe(command), args);
    print(runtime, await runtime.serviceManager.uninstall());
    return null;
  }

  // Reject an unknown verb before the client exists: resolving the client may itself fail typed
  // when no daemon token is stored, and that failure must not hide the argument mistake.
  if (!commandsByName.has(command) && command !== 'sync') throw unknownCommand(command);
  const client = runtime.createClient();
  switch (command) {
    case 'health':
      parseCommandArguments(describe(command), args);
      print(runtime, await client.health());
      return null;
    case 'overview':
      parseCommandArguments(describe(command), args);
      print(runtime, await client.getOverview());
      return null;
    case 'workspace:list':
      parseCommandArguments(describe(command), args);
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
          body: bodyFile ? readBodyFile(runtime, bodyFile) : '',
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
          body: bodyFile ? readBodyFile(runtime, bodyFile) : null,
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
    case 'backup': {
      // `backup <directory>` and the automatic-backup subcommands share one verb; a first token
      // the catalog declares as an action selects the subcommand, anything else is the directory.
      const subcommand =
        args[0] === undefined ? undefined : commandsByName.get(`backup ${args[0]}`);
      if (subcommand === undefined) {
        const input = parseCommandArguments(describe(command), args);
        print(
          runtime,
          await client.backup(
            runtime.resolvePath(required(input.positional[0], 'backup directory')),
          ),
        );
        return null;
      }
      const input = parseCommandArguments(subcommand, args.slice(1));
      switch (subcommand.name) {
        case 'backup status':
          print(runtime, await client.getAutomaticBackupStatus());
          return null;
        case 'backup configure':
          print(
            runtime,
            await client.configureAutomaticBackup(
              runtime.resolvePath(required(input.positional[0], 'backup directory')),
            ),
          );
          return null;
        case 'backup retry':
          // A retry that ends in `state: 'error'` is a successful report of a failed backup: the
          // data carries `error`, and the caller decides. Exit 1 would hide that data.
          print(runtime, await client.retryAutomaticBackup());
          return null;
        default:
          print(runtime, await client.disableAutomaticBackup());
          return null;
      }
    }
    case 'export': {
      const input = parseCommandArguments(describe(command), args);
      print(
        runtime,
        await client.exportPortable(
          runtime.resolvePath(required(input.positional[0], 'export directory')),
        ),
      );
      return null;
    }
    case 'sync': {
      const descriptor = describeAction(command, args[0]);
      const input = parseCommandArguments(descriptor, args.slice(1));
      switch (descriptor.name) {
        case 'sync status':
          print(runtime, await client.getSyncStatus());
          return null;
        case 'sync configure': {
          const directory = runtime.resolvePath(required(input.positional[0], 'shared folder'));
          const deviceId = input.option('--device');
          if (deviceId === undefined) {
            throw badArgument(descriptor, 'sync configure requires --device <id>');
          }
          print(runtime, await client.configureSync(directory, deviceId));
          return null;
        }
        case 'sync resolve': {
          const conflictId = required(input.positional[0], 'conflict id');
          const choice = required(input.positional[1], 'conflict choice');
          if (choice !== 'local' && choice !== 'remote') {
            throw badArgument(descriptor, 'Conflict choice must be local or remote');
          }
          print(runtime, await client.resolveSyncConflict(conflictId, choice));
          return null;
        }
        case 'sync now':
          print(runtime, await client.reconcileSync());
          return null;
        case 'sync pause':
          print(runtime, await client.pauseSync());
          return null;
        case 'sync resume':
          print(runtime, await client.resumeSync());
          return null;
        case 'sync conflicts':
          print(runtime, await client.listSyncConflicts());
          return null;
        default:
          print(runtime, await client.forgetSync());
          return null;
      }
    }
    default:
      // A declared multi-token name passed as one token, such as `"setup plan"`.
      throw unknownCommand(command);
  }
}

function unknownCommand(command: string): AppError {
  return new AppError('bad_request', `Unknown command: ${command}`, 400, false, {
    usage: CLI_USAGE,
  });
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
