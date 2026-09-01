import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** The repository checkout that owns this test tree. */
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `dist/cli.js`, the compiled CLI entrypoint the E2E suites drive. */
export function compiledCliPath(): string {
  return join(repositoryRoot, 'dist', 'cli.js');
}

/** `dist/mcpStdio.js`, the compiled stdio MCP bridge. */
export function compiledMcpPath(): string {
  return join(repositoryRoot, 'dist', 'mcpStdio.js');
}

/**
 * Fails fast when the compiled build is absent. A clean checkout has no `dist/` directory, so a
 * missing file means the suite was started without `npm run build`, not that the product broke.
 */
export function assertCompiledBuild(paths: readonly string[] = [compiledCliPath()]): void {
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length === 0) return;
  throw new Error(
    `Compiled build missing: ${missing.join(', ')}. Run \`npm run build\` first; a clean checkout has no dist/ directory, and \`npm test\` or \`npm run test:e2e\` build before running the compiled suites.`,
  );
}

/** Reserves and releases a loopback TCP port so a daemon under test can bind it next. */
export async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

export interface ProcessResult {
  pid: number;
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** SIGKILL the child after this many milliseconds. Default 20 s. */
  timeoutMs?: number;
}

/**
 * Spawns a process with stdin ignored, drains both output streams concurrently, and resolves with
 * the exit code instead of rejecting on it. Rejects only when the process cannot start.
 */
export function runProcess(
  executable: string,
  arguments_: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: options.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error(`Could not start ${executable}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveResult({ pid, code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Asserts the CLI success contract and returns the payload: stdout is exactly one JSON object with
 * a single `data` key. `label` names the command in error messages.
 */
export function unwrapCliEnvelope<T>(stdout: string, label = 'CLI'): T {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${stdout}`, { cause: error });
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    Object.keys(envelope).length !== 1 ||
    !('data' in envelope)
  ) {
    throw new Error(`${label} did not return one data envelope: ${stdout}`);
  }
  return (envelope as { data: T }).data;
}

export interface RunCompiledCliOptions {
  environment: NodeJS.ProcessEnv;
  /** Working directory for the CLI process. Default: the repository root. */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Runs `dist/cli.js` with the given arguments and unwraps its `{data}` envelope. A non-zero exit
 * throws with the exit code and stderr, where the CLI writes its typed error envelope.
 */
export async function runCompiledCli<T>(
  arguments_: readonly string[],
  options: RunCompiledCliOptions,
): Promise<T> {
  const label = `Compiled CLI ${arguments_[0] ?? ''}`;
  const result = await runProcess(process.execPath, [compiledCliPath(), ...arguments_], {
    cwd: options.cwd ?? repositoryRoot,
    environment: options.environment,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (result.code !== 0) {
    throw new Error(`${label} failed (${String(result.code)}): ${result.stderr}`);
  }
  return unwrapCliEnvelope<T>(result.stdout, label);
}

export interface StartCompiledDaemonOptions {
  /** Must carry `PIMPAMPUM_PORT`, `PIMPAMPUM_TOKEN` and `PIMPAMPUM_DATA_DIR`. */
  environment: NodeJS.ProcessEnv;
  /** The port named in `environment`; the health probe targets `http://127.0.0.1:<port>`. */
  port: number;
  cwd?: string;
  /** Health probes before giving up. Default 80 attempts at 50 ms, so four seconds. */
  healthAttempts?: number;
  healthIntervalMs?: number;
}

export interface CompiledDaemon {
  process: ChildProcess;
  baseUrl: string;
  /** Everything the daemon wrote to stderr so far; useful in failure messages. */
  stderr(): string;
}

/**
 * Spawns `dist/cli.js serve` and resolves once `GET /health` answers 200. Rejects with the daemon's
 * stderr if it exits during startup or never becomes healthy.
 */
export async function startCompiledDaemon(
  options: StartCompiledDaemonOptions,
): Promise<CompiledDaemon> {
  assertCompiledBuild();
  const baseUrl = `http://127.0.0.1:${String(options.port)}`;
  const daemon = spawn(process.execPath, [compiledCliPath(), 'serve'], {
    cwd: options.cwd ?? repositoryRoot,
    env: options.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  daemon.stdout?.on('data', () => undefined);
  const attempts = options.healthAttempts ?? 80;
  const interval = options.healthIntervalMs ?? 50;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`Daemon exited during startup: ${stderr}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) {
        return { process: daemon, baseUrl, stderr: () => stderr };
      }
    } catch {
      // The compiled daemon is still binding its loopback port.
    }
    await delay(interval);
  }
  await stopDaemon(daemon);
  throw new Error(`Daemon did not become healthy: ${stderr}`);
}

/**
 * Sends SIGTERM and waits for exit; escalates to SIGKILL after `gracePeriodMs`. A daemon that has
 * already exited, or `undefined`, is a no-op.
 */
export async function stopDaemon(
  daemon: ChildProcess | undefined,
  gracePeriodMs = 2_000,
): Promise<void> {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill('SIGTERM');
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => daemon.kill('SIGKILL'), gracePeriodMs);
    daemon.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}
