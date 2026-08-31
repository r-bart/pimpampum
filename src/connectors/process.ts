import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, normalize } from 'node:path';
import type { CommandInvocation } from './types.js';

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_CONFIG_BYTES = 1_000_000;
const TERMINATION_GRACE_MILLISECONDS = 250;
const SAFE_ENVIRONMENT_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
] as const;

export interface BoundedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

export function sanitizeExecutablePath(pathValue: string): string {
  const directories: string[] = [];
  for (const candidate of pathValue.split(delimiter)) {
    if (!candidate || candidate.includes('\0') || !isAbsolute(candidate)) continue;
    const normalized = normalize(candidate);
    if (!directories.includes(normalized)) directories.push(normalized);
  }
  return directories.join(delimiter);
}

export function sanitizedHostEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  pathValue = source.PATH ?? '',
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && !value.includes('\0')) result[key] = value;
  }
  result.PATH = sanitizeExecutablePath(pathValue);
  return result;
}

function assertInvocation(invocation: CommandInvocation): void {
  if (!isAbsolute(invocation.executable) || invocation.executable.includes('\0')) {
    throw new Error('Host executable must be an absolute path');
  }
  for (const argument of invocation.arguments) {
    if (argument.includes('\0')) throw new Error('Host command arguments must not contain NUL');
    if (/^(?:authorization\s*:|bearer\s+)/iu.test(argument)) {
      throw new Error('Credentials must not be passed in host command arguments');
    }
  }
}

function terminateProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
): void {
  if (child.pid === undefined) return;
  try {
    if (platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the close check and the signal.
    }
  }
}

export async function runBoundedHostCommand(
  invocation: CommandInvocation,
  options: {
    timeoutMilliseconds: number;
    maxOutputBytes?: number;
    /** Test seam for deterministic process lifecycle failures. */
    spawnProcess?: typeof spawn;
    /** Test seam for the platform-specific process-group signal branch. */
    platform?: NodeJS.Platform;
  },
): Promise<BoundedCommandResult> {
  assertInvocation(invocation);
  const timeoutMilliseconds = positiveInteger(options.timeoutMilliseconds, 'Command timeout');
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    'Command output limit',
  );

  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(invocation.executable, invocation.arguments, {
      detached: process.platform !== 'win32',
      env: sanitizedHostEnvironment(invocation.environment),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const terminate = (error: Error) => {
      if (failure !== null) return;
      failure = error;
      terminateProcessGroup(child, 'SIGTERM', options.platform ?? process.platform);
      killTimer = setTimeout(
        () => terminateProcessGroup(child, 'SIGKILL', options.platform ?? process.platform),
        TERMINATION_GRACE_MILLISECONDS,
      );
      killTimer.unref();
    };
    const collect = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        terminate(new Error(`Host command output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      target.push(buffer);
    };

    child.stdout.on('data', (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer | string) => collect(stderr, chunk));
    child.once('error', (error) => {
      failure = error;
    });
    const timeout = setTimeout(
      () => terminate(new Error(`Host command timed out after ${timeoutMilliseconds}ms`)),
      timeoutMilliseconds,
    );
    timeout.unref();

    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
      if (failure !== null) {
        reject(failure);
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        signal,
      });
    });
  });
}

function executableCandidates(input: {
  names: string[];
  boundedLocations: string[];
  path: string;
}): string[] {
  const names = input.names.filter(
    (name) =>
      name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('\0'),
  );
  const directories = [
    ...input.boundedLocations.filter((directory) => isAbsolute(directory)),
    ...sanitizeExecutablePath(input.path).split(delimiter).filter(Boolean),
  ].map(normalize);
  const uniqueDirectories = [...new Set(directories)];
  return uniqueDirectories.flatMap((directory) => names.map((name) => join(directory, name)));
}

function accessibleExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function detectExecutable(input: {
  id: string;
  names: string[];
  boundedLocations: string[];
  path: string;
  timeoutMilliseconds: number;
  run: (invocation: CommandInvocation) => Promise<unknown>;
}): Promise<{ executable: string | null; supported: boolean }> {
  const executable = executableCandidates(input).find(accessibleExecutable) ?? null;
  if (executable === null) return { executable: null, supported: false };

  const invocation: CommandInvocation = {
    executable,
    arguments: ['--version'],
    environment: sanitizedHostEnvironment(process.env, input.path),
  };
  let timer!: NodeJS.Timeout;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${input.id} version probe timed out`)),
        input.timeoutMilliseconds,
      );
      timer.unref();
    });
    const result = (await Promise.race([input.run(invocation), timeout])) as {
      exitCode?: unknown;
      stdout?: unknown;
    };
    return {
      executable,
      supported: result.exitCode === 0 && typeof result.stdout === 'string',
    };
  } catch {
    return { executable, supported: false };
  } finally {
    clearTimeout(timer);
  }
}

export interface ConfigurationReadTestHooks {
  metadata?(descriptor: number, actual: Stats): Stats;
  contents?(descriptor: number, actual: Buffer): Buffer;
}

function assertRegularConfiguration(path: string): ReturnType<typeof lstatSync> {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('Host configuration path must be absolute');
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Host configuration must be a regular file and not a symlink');
  }
  return metadata;
}

function readConfiguration(
  path: string,
  maxBytes = DEFAULT_MAX_CONFIG_BYTES,
  testHooks?: ConfigurationReadTestHooks,
): {
  contents: Buffer;
  mode: number;
  revision: string;
  value: unknown;
} {
  positiveInteger(maxBytes, 'Host configuration size limit');
  assertRegularConfiguration(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let metadata: Stats;
  let contents: Buffer;
  try {
    const actualMetadata = fstatSync(descriptor);
    metadata = testHooks?.metadata?.(descriptor, actualMetadata) ?? actualMetadata;
    if (!metadata.isFile()) throw new Error('Host configuration must be a regular file');
    if (metadata.size > maxBytes) {
      throw new Error('Host configuration exceeds the bounded size limit');
    }
    const actualContents = readFileSync(descriptor);
    contents = testHooks?.contents?.(descriptor, actualContents) ?? actualContents;
  } finally {
    closeSync(descriptor);
  }
  if (contents.length > maxBytes)
    throw new Error('Host configuration exceeds the bounded size limit');
  let value: unknown;
  try {
    value = JSON.parse(contents.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Host configuration must contain valid JSON', { cause: error });
  }
  return {
    contents,
    mode: metadata.mode & 0o777,
    revision: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    value,
  };
}

export function configurationRevision(path: string): string {
  return readConfiguration(path).revision;
}

export function readHostConfiguration(
  path: string,
  maxBytes = DEFAULT_MAX_CONFIG_BYTES,
  /** Test seam for deterministic TOCTOU read states. */
  testHooks?: ConfigurationReadTestHooks,
): { value: unknown; revision: string; mode: number } {
  const { value, revision, mode } = readConfiguration(path, maxBytes, testHooks);
  return { value, revision, mode };
}

function privateMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777 || (mode & 0o077) !== 0) {
    throw new Error('Host configuration mode must be private');
  }
  return mode;
}

function revisionConflict(): Error {
  return new Error('Host configuration revision changed concurrently');
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function replaceHostConfigurationEntry(input: {
  path: string;
  expectedRevision: string | null;
  mode: number;
  update(current: unknown): unknown;
  /** Test seam for an I/O failure immediately after the temporary descriptor opens. */
  afterTemporaryOpen?: () => void;
}): Promise<{ revision: string }> {
  if (!isAbsolute(input.path) || input.path.includes('\0')) {
    throw new Error('Host configuration path must be absolute');
  }
  const requestedMode = privateMode(input.mode);
  const existed = pathEntryExists(input.path);
  let previous: ReturnType<typeof readConfiguration> | null = null;
  if (existed) {
    previous = readConfiguration(input.path);
    if ((previous.mode & 0o222) === 0) {
      throw new Error('Host configuration is read-only or managed');
    }
    if (input.expectedRevision !== previous.revision) throw revisionConflict();
  } else if (input.expectedRevision !== null) {
    throw revisionConflict();
  }

  const next = input.update(previous?.value ?? {});
  const serialized = JSON.stringify(next, null, 2);
  if (serialized === undefined) throw new Error('Host configuration update must produce JSON');
  const contents = `${serialized}\n`;
  if (Buffer.byteLength(contents) > DEFAULT_MAX_CONFIG_BYTES) {
    throw new Error('Host configuration update exceeds the bounded size limit');
  }

  const parent = dirname(input.path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = join(parent, `.${randomUUID()}.pimpampum.tmp`);
  const outputMode = previous?.mode ?? requestedMode;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      outputMode,
    );
    input.afterTemporaryOpen?.();
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, outputMode);

    if (previous === null) {
      if (pathEntryExists(input.path)) throw revisionConflict();
    } else {
      let currentRevision: string;
      try {
        currentRevision = configurationRevision(input.path);
      } catch (error) {
        throw new Error('Host configuration changed concurrently', { cause: error });
      }
      if (currentRevision !== previous.revision) throw revisionConflict();
    }
    renameSync(temporaryPath, input.path);
    return { revision: configurationRevision(input.path) };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}
