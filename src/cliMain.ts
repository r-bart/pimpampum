/**
 * The real entry point. `src/cli.ts` loads it dynamically and passes its own URL, so the compiled
 * CLI path keeps resolving to `dist/cli.js`: the bin target, and the file the generated LaunchAgent
 * and systemd unit invoke. Everything process-bound is gathered into the `CliHost` here;
 * `composeCliRuntime` never reads `process` or `node:os` itself.
 */
import { arch, homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLocalErrorEnvelope } from './agentProtocol.js';
import { composeCliRuntime } from './cliComposition/composeCliRuntime.js';
import type { CliHost } from './cliComposition/host.js';
import { runCli, type CliRuntime } from './cliProgram.js';
import { createClientConfigResolver, loadConfig } from './config.js';
import {
  createServiceCommandRunner,
  findExecutable,
  runServiceCommand,
} from './service/platform.js';

export function createProcessHost(entryUrl: string): CliHost {
  return {
    platform: platform(),
    arch: arch(),
    homeDirectory: homedir(),
    execPath: process.execPath,
    entryModulePath: fileURLToPath(entryUrl),
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    uid: process.getuid?.(),
    findExecutable,
    runCommand: runServiceCommand,
    createCommandRunner: createServiceCommandRunner,
    config: { client: createClientConfigResolver(), daemon: () => loadConfig() },
    stdin: process.stdin,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    onSignal: (signal, callback) => void process.once(signal, callback),
    onExit: (callback) => void process.once('exit', callback),
    exit: (code) => process.exit(code),
    // The bridge binds this process's stdin to the MCP transport on import, which no unit test can
    // afford; the compiled E2E drives `pimpampum mcp` through the real binary instead.
    /* v8 ignore next 3 */
    startStdioBridge: async () => {
      await import('./mcpStdio.js');
    },
  };
}

/**
 * A composition failure — the staged app source, a corrupt runtime receipt met on the way — is this
 * command's own failure and prints as one local envelope. Letting it escape would reach the
 * bootstrap in `cli.ts`, which labels every error a startup failure and suggests npm to a packaged
 * install. The exit code stays 1: every consumer branches on non-zero and parses the envelope.
 */
export async function runCliEntrypoint(
  entryUrl: string,
  host: CliHost = createProcessHost(entryUrl),
): Promise<void> {
  let runtime: CliRuntime;
  try {
    runtime = await composeCliRuntime(host);
  } catch (error) {
    host.stderr(`${JSON.stringify(createLocalErrorEnvelope(error), null, 2)}\n`);
    return host.exit(1);
  }
  await runCli([...host.argv], runtime);
}

// Tests outside the CLI area still import these from here; the composition modules are their home.
export { createHealthVerifiedServiceManager } from './cliComposition/platformAdapters.js';
export { createCliUpdateManager } from './cliComposition/packagedUpdateProvider.js';
export { stagePackagedMacOSApplication } from './cliComposition/releaseCandidate.js';
export {
  createBoundedReleaseManifestFetcher,
  createReleaseSignatureVerifier,
} from './cliComposition/releaseChannel.js';
