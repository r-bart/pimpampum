/**
 * What every handler module shares: the handler contract, the output helpers that keep the
 * one-envelope contract, the redaction and error translation at the local boundary, and the small
 * value parsers for positional arguments.
 */
import type { AgentCliClient } from '../agentClient.js';
import {
  createAgentSuccessEnvelope,
  localErrorDetails,
  type AgentErrorEnvelope,
} from '../agentProtocol.js';
import type { CliCommand } from '../cliCommands.js';
import { badArgument, MAX_BODY_FILE_BYTES, required, type CommandInput } from '../cliInput.js';
import type {
  CliConnectionsRuntime,
  CliConnectorId,
  CliConnectorMutationInput,
  CliRuntime,
  CliSetupRuntime,
} from '../cliProgram.js';
import { AppError, type ErrorCode } from '../errors.js';
import { isRecord } from '../objects.js';
import type { SetupProgressEvent } from '../setup/types.js';
import type { ArtifactReference, TargetType } from '../types.js';

export interface CliHandlerContext {
  command: CliCommand;
  input: CommandInput;
  runtime: CliRuntime;
}

/**
 * One verb. A handler prints its own success and returns nothing; `call` alone returns the error
 * envelope the daemon produced, so `runCli` can write it unchanged instead of wrapping it.
 */
export type CliHandler = (context: CliHandlerContext) => Promise<AgentErrorEnvelope | void>;

export type CliHandlerTable = Readonly<Record<string, CliHandler>>;

export { badArgument, required };
export { isRecord };

export function targetType(value: string | undefined): TargetType {
  const resolved = required(value, 'target type');
  if (resolved !== 'spec' && resolved !== 'task') {
    throw new AppError('bad_request', 'Target type must be spec or task', 400);
  }
  return resolved;
}

export function revision(value: string | undefined): number {
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
export function print(runtime: CliRuntime, value: unknown): void {
  printEnvelope(runtime, createAgentSuccessEnvelope(value));
}

export function printEnvelope(runtime: CliRuntime, value: unknown): void {
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

export function printBoundary(runtime: CliRuntime, value: unknown): void {
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
export function printSetupResult(runtime: CliRuntime, events: boolean, result: unknown): void {
  if (events) printSetupEvent(runtime, 'result', result);
  else printBoundary(runtime, result);
}

export function setupProgressReporter(
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

export async function callBoundary<T>(operation: () => Promise<T>): Promise<T> {
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

export function connectorId(value: string | undefined): CliConnectorId {
  const id = required(value, 'connector id');
  if (id !== 'codex' && id !== 'claude-code') {
    throw new AppError('bad_request', 'Connector id must be codex or claude-code', 400);
  }
  return id;
}

export function requireConfirmation(command: CliCommand, input: CommandInput): void {
  if (!input.boolean('--yes')) {
    throw badArgument(command, 'This operation requires the explicit --yes flag');
  }
}

/** `--replace` alone, or `--replace <revision>` pinning the exact entry the reviewer saw. */
export function replacementOf(input: CommandInput): CliConnectorMutationInput {
  const revision = input.option('--replace');
  return {
    confirmed: true,
    conflictDecision: input.boolean('--replace') ? 'replace' : undefined,
    ...(revision === undefined ? {} : { reviewedEntryFingerprint: revision }),
  };
}

export function connectionsRuntime(runtime: CliRuntime): CliConnectionsRuntime {
  if (runtime.connections === undefined) {
    throw new AppError('unavailable', 'Connection management is unavailable in this runtime', 503);
  }
  return runtime.connections;
}

export function setupRuntime(runtime: CliRuntime): CliSetupRuntime {
  if (runtime.setup === undefined) {
    throw new AppError('unavailable', 'Setup management is unavailable in this runtime', 503);
  }
  return runtime.setup;
}

/**
 * Reads a `--body-file` through the runtime's bounded reader. A missing or unreadable file is the
 * caller's argument problem and names the path; a bounded-read failure keeps its own typed code.
 */
export function readBodyFile(runtime: CliRuntime, path: string): string {
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

/**
 * Some verbs accept the same value positionally or by flag, for backward compatibility. Supplying
 * both is ambiguous, so it fails instead of letting one side win quietly.
 */
export function exclusive(
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

export function optionalCount(
  input: CommandInput,
  flag: string,
  label: string,
): number | undefined {
  const raw = input.option(flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('bad_request', `${label} must be a positive integer`, 400);
  }
  return parsed;
}

export function actorOf(input: CommandInput): string {
  return input.option('--actor') ?? 'cli';
}

/**
 * Artifact references from either `--artifact <uri>`, repeated, or one `--artifacts <json>` array.
 * Bounds and field limits stay with the daemon schema, which is the authority.
 */
export function artifactsOf(command: CliCommand, input: CommandInput): ArtifactReference[] {
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

export async function withAgentClient<T>(
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
