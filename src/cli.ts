#!/usr/bin/env node
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentCliClient } from './agentClient.js';
import { createLocalErrorEnvelope } from './agentProtocol.js';
import { createHttpClient } from './client.js';
import { MAX_AGENT_INPUT_BYTES, runCli } from './cliProgram.js';
import { loadConfig } from './config.js';
import { AppError } from './errors.js';
import { createLaunchdAdapter } from './service/launchd.js';
import { createMacOSDesktopAdapter } from './service/macosApp.js';
import { createPlatformServiceManager } from './service/manager.js';
import { createOmarchyAdapter, isCompatibleOmarchyVersion } from './service/omarchy.js';
import { findExecutable, runServiceCommand } from './service/platform.js';
import { createSystemdAdapter } from './service/systemd.js';
import { startServer } from './server.js';

function decodeToolInput(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new AppError('bad_request', 'Tool input must be valid UTF-8', 400);
  }
}

function inputTooLarge(maxBytes: number): AppError {
  return new AppError(
    'payload_too_large',
    `Tool input exceeds ${String(maxBytes)} UTF-8 bytes`,
    413,
  );
}

function readBoundedUtf8File(path: string, maxBytes: number): string {
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
  if (total > maxBytes) throw inputTooLarge(maxBytes);
  return decodeToolInput(Buffer.concat(chunks, total));
}

async function readBoundedStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > maxBytes) throw inputTooLarge(maxBytes);
    chunks.push(bytes);
  }
  return decodeToolInput(Buffer.concat(chunks, total));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const tokenFromEnvironment = Boolean(process.env.PIMPAMPUM_TOKEN?.trim());
  const modulePath = fileURLToPath(import.meta.url);
  const sourceMode = modulePath.endsWith('.ts');
  const compiledCliPath = sourceMode
    ? resolve(dirname(modulePath), '..', 'dist', 'cli.js')
    : modulePath;
  const compiledMcpStdioPath = sourceMode
    ? resolve(dirname(modulePath), '..', 'dist', 'mcpStdio.js')
    : resolve(dirname(modulePath), 'mcpStdio.js');
  const hostPlatform = platform();
  const bundledMacOSApp = resolve(
    dirname(modulePath),
    '..',
    'platforms',
    'macos',
    'dist',
    'PimpampumMenuBar.app',
  );
  const bundledOmarchyPlugin = resolve(
    dirname(modulePath),
    '..',
    'integrations',
    'omarchy',
    'pimpampum-status',
  );
  const omarchyPath = hostPlatform === 'linux' ? findExecutable('omarchy') : null;
  const omarchyShellPath = hostPlatform === 'linux' ? findExecutable('omarchy-shell') : null;
  const serviceLifecycleRequested = new Set(['install', 'status', 'uninstall']).has(
    process.argv[2] ?? '',
  );
  let omarchyVersion = null;
  if (serviceLifecycleRequested && omarchyPath && omarchyShellPath) {
    omarchyVersion = await runServiceCommand(omarchyPath, ['version']).catch(() => null);
    if (omarchyVersion && omarchyVersion.exitCode !== 0) {
      omarchyVersion = await runServiceCommand(omarchyPath, ['--version']).catch(() => null);
    }
  }
  const useOmarchy =
    omarchyVersion?.exitCode === 0 && isCompatibleOmarchyVersion(omarchyVersion.stdout);
  const linuxSystemdAdapter = hostPlatform === 'linux' ? createSystemdAdapter() : null;
  const linuxOmarchyAdapter =
    hostPlatform === 'linux' && omarchyPath && omarchyShellPath && linuxSystemdAdapter
      ? createOmarchyAdapter({
          pluginSourcePath: bundledOmarchyPlugin,
          daemonAdapter: linuxSystemdAdapter,
          omarchyPath,
          omarchyShellPath,
        })
      : null;
  const macOSLaunchdAdapter = hostPlatform === 'darwin' ? createLaunchdAdapter() : null;
  const macOSDesktopAdapter =
    hostPlatform === 'darwin' && macOSLaunchdAdapter
      ? createMacOSDesktopAdapter({
          appBundlePath: bundledMacOSApp,
          daemonAdapter: macOSLaunchdAdapter,
        })
      : null;

  const managerInput = {
    platform: hostPlatform,
    homeDirectory: homedir(),
    dataDirectory: config.dataDirectory,
    nodePath: process.execPath,
    cliPath: compiledCliPath,
    version: '1.0.0',
    host: config.host,
    port: config.port,
    runCommand: runServiceCommand,
  };
  const serviceManager = createPlatformServiceManager({
    ...managerInput,
    ...(macOSLaunchdAdapter && macOSDesktopAdapter
      ? {
          adapters: { darwin: macOSDesktopAdapter },
          receiptAdapters: {
            [macOSLaunchdAdapter.id]: macOSLaunchdAdapter,
            [macOSDesktopAdapter.id]: macOSDesktopAdapter,
          },
        }
      : hostPlatform === 'linux' && linuxSystemdAdapter
        ? {
            adapters: {
              linux: useOmarchy && linuxOmarchyAdapter ? linuxOmarchyAdapter : linuxSystemdAdapter,
            },
            receiptAdapters: {
              [linuxSystemdAdapter.id]: linuxSystemdAdapter,
              ...(linuxOmarchyAdapter ? { [linuxOmarchyAdapter.id]: linuxOmarchyAdapter } : {}),
            },
          }
        : {}),
  });
  const serviceOnlyManager =
    macOSLaunchdAdapter && macOSDesktopAdapter
      ? createPlatformServiceManager({
          ...managerInput,
          adapters: { darwin: macOSLaunchdAdapter },
          receiptAdapters: {
            [macOSLaunchdAdapter.id]: macOSLaunchdAdapter,
            [macOSDesktopAdapter.id]: macOSDesktopAdapter,
          },
        })
      : null;

  await runCli(process.argv.slice(2), {
    createClient: () => createHttpClient(config),
    createAgentClient: () => createAgentCliClient(config),
    describeConfig: () => ({
      dataDirectory: config.dataDirectory,
      databasePath: config.databasePath,
      baseUrl: config.baseUrl,
      tokenPath: tokenFromEnvironment ? null : join(config.dataDirectory, 'token'),
      tokenSource: tokenFromEnvironment ? 'environment' : 'file',
      tokenConfigured: config.token.length > 0,
      mcp: {
        streamableHttpUrl: `${config.baseUrl}/mcp`,
        stdio: {
          command: process.execPath,
          args: [compiledMcpStdioPath],
        },
      },
    }),
    serviceManager,
    ...(serviceOnlyManager ? { serviceOnlyManager } : {}),
    startServer: () => startServer(config),
    readFile: (path, maxBytes) =>
      maxBytes === undefined ? readFileSync(path, 'utf8') : readBoundedUtf8File(path, maxBytes),
    readStdin: (maxBytes = MAX_AGENT_INPUT_BYTES) => readBoundedStdin(maxBytes),
    resolvePath: resolve,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    onSignal: (signal, callback) => process.once(signal, callback),
    exit: (code) => process.exit(code),
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(createLocalErrorEnvelope(error), null, 2)}\n`);
  process.exit(1);
});
