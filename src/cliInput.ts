/**
 * Everything the CLI reads on a caller's behalf: the argument vector, and the files or stdin a
 * verb names. Parsing is table-driven from `CLI_COMMANDS`, so every verb rejects an unknown flag
 * or a surplus positional the same way; every file read is bounded, so no argument can make the
 * process load an unbounded file before the daemon refuses it.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import type { Readable } from 'node:stream';
import {
  CLI_COMMANDS,
  renderUsage,
  renderUsageLine,
  type CliCommand,
  type CliOption,
} from './cliCommands.js';
import { AppError } from './errors.js';
import { PIMPAMPUM_VERSION } from './version.js';

export const CLI_USAGE = renderUsage(PIMPAMPUM_VERSION);

/**
 * `--body-file` cap. The daemon's body limit is the authority; this bound only stops the CLI from
 * loading an arbitrary file into memory before the daemon can refuse it.
 */
export const MAX_BODY_FILE_BYTES = 1_000_000;

const commandsByName = new Map(CLI_COMMANDS.map((command) => [command.name, command]));
/** The first token of every declared name: `setup` for `setup plan`, `backup` for both forms. */
const verbs = new Set(CLI_COMMANDS.map((command) => command.name.split(' ')[0]!));
/** The human spellings of the two commands people type without reading the banner. */
const verbAliases = new Map([
  ['--help', 'help'],
  ['-h', 'help'],
  ['--version', 'version'],
  ['-v', 'version'],
]);

export function describe(name: string): CliCommand {
  const command = commandsByName.get(name);
  if (!command) throw new AppError('internal_error', `Undeclared CLI command: ${name}`, 500);
  return command;
}

export function badArgument(command: CliCommand, message: string): AppError {
  return new AppError('bad_request', message, 400, false, { usage: renderUsageLine(command) });
}

export function unknownCommand(command: string): AppError {
  return new AppError('bad_request', `Unknown command: ${command}`, 400, false, {
    usage: CLI_USAGE,
  });
}

export function required(value: string | undefined, label: string): string {
  if (!value) throw new AppError('bad_request', `Missing ${label}`, 400);
  return value;
}

export interface ResolvedCommand {
  command: CliCommand;
  /** The tokens after the command name, ready for `parseCommandArguments`. */
  args: string[];
}

/**
 * Maps an argument vector to its catalog entry. A verb the catalog does not declare, or a declared
 * multi-token name passed as one token such as `"setup plan"`, is the caller's mistake and fails as
 * `bad_request` with the whole banner. `backup <directory>` and `backup status` share one verb: a
 * second token the catalog declares as an action selects the action, anything else belongs to the
 * bare verb.
 */
export function resolveCommand(arguments_: readonly string[]): ResolvedCommand {
  const [first, ...rest] = arguments_;
  if (!first) {
    throw new AppError('bad_request', 'Missing command', 400, false, { usage: CLI_USAGE });
  }
  const verb = verbAliases.get(first) ?? first;
  if (!verbs.has(verb)) throw unknownCommand(first);
  const action = rest[0] === undefined ? undefined : commandsByName.get(`${verb} ${rest[0]}`);
  if (action !== undefined) return { command: action, args: rest.slice(1) };
  const bare = commandsByName.get(verb);
  if (bare !== undefined) return { command: bare, args: rest };
  // A verb that only exists with an action, such as `setup` or `sync`.
  const name = required(rest[0], `${verb} action`);
  throw new AppError('bad_request', `Unknown ${verb} action: ${name}`, 400, false, {
    usage: CLI_USAGE,
  });
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
export function parseCommandArguments(command: CliCommand, args: readonly string[]): CommandInput {
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

export function decodeToolInput(buffer: Uint8Array, label = 'Tool input'): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new AppError('bad_request', `${label} must be valid UTF-8`, 400);
  }
}

export function inputTooLarge(maxBytes: number, label = 'Tool input'): AppError {
  return new AppError('payload_too_large', `${label} exceeds ${String(maxBytes)} UTF-8 bytes`, 413);
}

/**
 * Every file the CLI reads on a caller's behalf — `--input-file`, `--body-file` — comes through
 * here, so no argument can make the process load an unbounded file before the daemon refuses it.
 */
export function readBoundedUtf8File(path: string, maxBytes: number, label = 'Tool input'): string {
  const descriptor = openSync(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, maxBytes + 1 - total));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  if (total > maxBytes) throw inputTooLarge(maxBytes, label);
  return decodeToolInput(Buffer.concat(chunks, total), label);
}

/** Drains `--stdin` input with the same bound and decoding as a file, chunk by chunk. */
export async function readBoundedStdin(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > maxBytes) throw inputTooLarge(maxBytes);
    chunks.push(bytes);
  }
  return decodeToolInput(Buffer.concat(chunks, total));
}
