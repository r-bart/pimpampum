import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';

import { sanitizeExecutablePath } from '../connectors/process.js';
import { AppError } from '../errors.js';
import type { CommandResult, RunCommand } from './types.js';

export function findExecutable(
  name: string,
  pathValue: string | undefined = process.env.PATH,
): string | null {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Executable name must be a simple file name');
  }
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Graphical sessions often have sparse PATH entries, so keep searching.
    }
  }
  return null;
}

/** Every service command finishes or is stopped within this window unless a caller overrides it. */
export const DEFAULT_SERVICE_COMMAND_TIMEOUT_MILLISECONDS = 60_000;

/**
 * Per-stream capture limit. The largest parse cap among the callers is the 1 MiB Omarchy shell
 * configuration in `omarchy.ts`, so the runner must accept more than that or the parser's own
 * guard can never be reached.
 */
export const SERVICE_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const DEFAULT_TERMINATION_GRACE_MILLISECONDS = 2_000;

/**
 * Environment forwarded to `systemctl --user`, `launchctl`, `open`, `pkill`, `omarchy`,
 * `omarchy-shell` and `npm`. Everything else, `PIMPAMPUM_*` (the daemon bearer token among them)
 * and `NODE_OPTIONS` included, stays in this process.
 *
 * - PATH, HOME, USER, LOGNAME: npm resolves `~/.npmrc`, its cache and git from them; the Omarchy
 *   helpers read `~/.config`.
 * - TMPDIR, TEMP, TMP: npm and tar unpack into them.
 * - LANG, LANGUAGE, LC_*: message encoding of every tool; UTF-8 paths in stderr depend on them.
 * - XDG_*: `systemctl --user` finds the user manager through `XDG_RUNTIME_DIR`; the Quickshell
 *   IPC behind `omarchy-shell` lives under the same directory.
 * - DBUS_SESSION_BUS_ADDRESS: the alternative bus route for `systemctl --user`.
 * - SSH_AUTH_SOCK: npm fetching a git dependency over SSH.
 * - WAYLAND_DISPLAY, DISPLAY, HYPRLAND_INSTANCE_SIGNATURE: `omarchy-shell` targets the shell
 *   instance of the current graphical session.
 * - OMARCHY_*: the `omarchy` dispatcher locates its own checkout through `OMARCHY_PATH`.
 */
const SERVICE_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOME',
  'HYPRLAND_INSTANCE_SIGNATURE',
  'LANG',
  'LANGUAGE',
  'LOGNAME',
  'PATH',
  'SSH_AUTH_SOCK',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'WAYLAND_DISPLAY',
]);
const SERVICE_ENVIRONMENT_PREFIXES = ['LC_', 'OMARCHY_', 'XDG_'] as const;

function isForwardedEnvironmentKey(key: string): boolean {
  return (
    SERVICE_ENVIRONMENT_KEYS.has(key) ||
    SERVICE_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * The allow-listed environment a service command receives. `PATH` keeps only absolute entries so
 * a relative directory inherited from the shell cannot resolve a helper's own child processes.
 */
export function serviceCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value.includes('\0') || !isForwardedEnvironmentKey(key)) continue;
    result[key] = value;
  }
  result.PATH = sanitizeExecutablePath(source.PATH ?? '');
  return result;
}

export interface ServiceCommandOptions {
  /** Wall-clock limit before the child receives SIGTERM, then SIGKILL after the grace period. */
  timeoutMilliseconds?: number;
  /** Per-stream capture limit; exceeding it stops the child and fails the command. */
  maxOutputBytes?: number;
  /** Delay between SIGTERM and SIGKILL for a child that ignores the first signal. */
  terminationGraceMilliseconds?: number;
  /** Source environment to filter; defaults to this process's environment. */
  environment?: NodeJS.ProcessEnv;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

/**
 * A service command exceeded its time or output bound and was stopped. `unavailable` is the
 * code every CLI, HTTP and MCP consumer already maps for a tool that did not answer, and its
 * suggestion points at `pimpampum status` and `pimpampum install`.
 */
export class ServiceCommandBoundError extends AppError {
  constructor(
    public readonly executable: string,
    public readonly bound: 'timeout' | 'output',
    limit: number,
  ) {
    super(
      'unavailable',
      bound === 'timeout'
        ? `${basename(executable)} did not finish within ${limit / 1000} s and was stopped`
        : `${basename(executable)} produced more than ${limit} bytes of output and was stopped`,
      503,
      bound === 'timeout',
      bound === 'timeout'
        ? { executable, timeoutMilliseconds: limit }
        : { executable, maxOutputBytes: limit },
    );
    this.name = 'ServiceCommandBoundError';
  }
}

function signalChild(child: ReturnType<typeof execFile>, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the timer firing and the signal.
  }
}

/**
 * Runs one host tool without a shell, with a bounded environment, a bounded output and a
 * deadline. A non-zero exit resolves so callers can inspect stderr; a spawn failure such as
 * ENOENT rejects with the original error; a breached bound rejects with a typed error naming
 * the executable.
 */
export async function runServiceCommand(
  executable: string,
  arguments_: string[],
  options: ServiceCommandOptions = {},
): Promise<CommandResult> {
  const timeoutMilliseconds = positiveInteger(
    options.timeoutMilliseconds ?? DEFAULT_SERVICE_COMMAND_TIMEOUT_MILLISECONDS,
    'Service command timeout',
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? SERVICE_COMMAND_MAX_OUTPUT_BYTES,
    'Service command output limit',
  );
  const terminationGraceMilliseconds = positiveInteger(
    options.terminationGraceMilliseconds ?? DEFAULT_TERMINATION_GRACE_MILLISECONDS,
    'Service command termination grace',
  );
  const environment = serviceCommandEnvironment(options.environment);

  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = execFile(
      executable,
      arguments_,
      { encoding: 'utf8', maxBuffer: maxOutputBytes, shell: false, env: environment },
      (error, stdout, stderr) => {
        clearTimeout(timeout);
        if (killTimer !== null) clearTimeout(killTimer);
        if (error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new ServiceCommandBoundError(executable, 'output', maxOutputBytes));
          return;
        }
        if (timedOut) {
          reject(new ServiceCommandBoundError(executable, 'timeout', timeoutMilliseconds));
          return;
        }
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ exitCode: error.code, stdout, stderr });
      },
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      signalChild(child, 'SIGTERM');
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), terminationGraceMilliseconds);
      killTimer.unref();
    }, timeoutMilliseconds);
    timeout.unref();
  });
}

/**
 * A `RunCommand` with fixed bounds, for an adapter whose one slow step — the first `open` of a
 * freshly installed app while Gatekeeper assesses it — needs a longer deadline than the default.
 */
export function createServiceCommandRunner(options: ServiceCommandOptions): RunCommand {
  return (executable, arguments_) => runServiceCommand(executable, arguments_, options);
}
