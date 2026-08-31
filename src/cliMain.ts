import { closeSync, lstatSync, openSync, readFileSync, readSync, unlinkSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentCliClient } from './agentClient.js';
import { createHttpClient } from './client.js';
import {
  createCliConnectionsRuntime,
  createCliSetupRuntime,
  MAX_AGENT_INPUT_BYTES,
  runCli,
} from './cliProgram.js';
import { loadConfig } from './config.js';
import { createClaudeCodeConnector } from './connectors/claudeCode.js';
import { createCodexConnector } from './connectors/codex.js';
import {
  configurationRevision,
  readHostConfiguration,
  replaceHostConfigurationEntry,
} from './connectors/process.js';
import { createConnectorRegistry } from './connectors/registry.js';
import type {
  ConnectionReceipt,
  ConnectorId,
  ConnectorSnapshot,
  HostConnector,
} from './connectors/types.js';
import { AppError } from './errors.js';
import { createLaunchdAdapter } from './service/launchd.js';
import { createMacOSDesktopAdapter } from './service/macosApp.js';
import { createPlatformServiceManager } from './service/manager.js';
import { createOmarchyAdapter, isCompatibleOmarchyVersion } from './service/omarchy.js';
import { findExecutable, runServiceCommand } from './service/platform.js';
import { createSystemdAdapter } from './service/systemd.js';
import { startServer } from './server.js';
import { PIMPAMPUM_VERSION } from './version.js';
import { createUpdateManager, resolveNpmPath } from './update.js';
import { resolveRuntimeLayout } from './runtime/layout.js';
import { createSetupCoordinator } from './setup/coordinator.js';
import {
  createSetupLifecycleLock,
  createSetupPlanStore,
  createSetupStateStore,
} from './setup/state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConnectionReceipt(value: unknown, connectorId: ConnectorId): ConnectionReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.connectorId !== connectorId ||
    (value.scope !== 'user' && value.scope !== 'global') ||
    typeof value.commandFingerprint !== 'string' ||
    value.commandFingerprint.length === 0 ||
    value.commandFingerprint.length > 128 ||
    value.commandFingerprint.includes('\0') ||
    typeof value.configuredAt !== 'string' ||
    value.configuredAt.length === 0 ||
    value.configuredAt.length > 128 ||
    (value.lastVerifiedAt !== null && typeof value.lastVerifiedAt !== 'string')
  ) {
    throw new Error('Invalid private connector receipt');
  }
  const capabilities = value.capabilities;
  if (
    capabilities !== undefined &&
    (!Array.isArray(capabilities) ||
      capabilities.length > 32 ||
      capabilities.some(
        (capability) =>
          typeof capability !== 'string' ||
          capability.length === 0 ||
          capability.length > 128 ||
          capability.includes('\0'),
      ))
  ) {
    throw new Error('Invalid private connector receipt capabilities');
  }
  return {
    schemaVersion: 1,
    connectorId,
    scope: value.scope,
    commandFingerprint: value.commandFingerprint,
    configuredAt: value.configuredAt,
    lastVerifiedAt: value.lastVerifiedAt,
    ...(Array.isArray(capabilities) ? { capabilities: [...capabilities] as string[] } : {}),
  };
}

function assertSafeReceiptDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(dirname(path));
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Private connector receipt directory must not be a symlink');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function createConnectionReceiptStore(dataDirectory: string, connectorId: ConnectorId) {
  const path = join(dataDirectory, 'connections', `${connectorId}.json`);
  return {
    async read(): Promise<ConnectionReceipt | null> {
      if (!assertSafeReceiptDirectory(path)) return null;
      try {
        return parseConnectionReceipt(readHostConfiguration(path).value, connectorId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(receipt: ConnectionReceipt): Promise<void> {
      assertSafeReceiptDirectory(path);
      let expectedRevision: string | null = null;
      try {
        expectedRevision = configurationRevision(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await replaceHostConfigurationEntry({
        path,
        expectedRevision,
        mode: 0o600,
        update: () => parseConnectionReceipt(receipt, connectorId),
      });
    },
    async remove(): Promise<void> {
      if (!assertSafeReceiptDirectory(path)) return;
      let metadata: ReturnType<typeof lstatSync>;
      try {
        metadata = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Private connector receipt must be a regular file and not a symlink');
      }
      unlinkSync(path);
    },
  };
}

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

/**
 * The real entry point. It receives the URL of `cli.ts` rather than using its own, so
 * `compiledCliPath` keeps resolving to `dist/cli.js`, which is the bin target and the file the
 * generated LaunchAgent and systemd unit invoke.
 */
export async function runCliEntrypoint(entryUrl: string): Promise<void> {
  const config = loadConfig();
  const tokenFromEnvironment = Boolean(process.env.PIMPAMPUM_TOKEN?.trim());
  const modulePath = fileURLToPath(entryUrl);
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
    version: PIMPAMPUM_VERSION,
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

  const runtimeArchitecture = arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'x64' : null;
  const runtimePlatform =
    hostPlatform === 'darwin' || hostPlatform === 'linux' ? hostPlatform : null;
  const supportedRuntimeTarget =
    runtimeArchitecture !== null &&
    runtimePlatform !== null &&
    !(runtimePlatform === 'darwin' && runtimeArchitecture !== 'arm64');
  let connections: ReturnType<typeof createCliConnectionsRuntime> | undefined;
  let setup: ReturnType<typeof createCliSetupRuntime> | undefined;
  if (supportedRuntimeTarget) {
    const homeDirectory = homedir();
    const layout = resolveRuntimeLayout({
      homeDirectory,
      platform: runtimePlatform,
      architecture: runtimeArchitecture,
      version: PIMPAMPUM_VERSION,
    });
    const codexReceipt = createConnectionReceiptStore(config.dataDirectory, 'codex');
    const claudeReceipt = createConnectionReceiptStore(config.dataDirectory, 'claude-code');
    const codex = createCodexConnector({
      launcherPath: layout.mcpLauncherPath,
      boundedLocations: [
        join(homeDirectory, '.local', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/Applications/Codex.app/Contents/Resources',
      ],
      path: process.env.PATH ?? '',
      requiredTools: ['project_list', 'work_start'],
      receipt: codexReceipt,
    });
    const claudeCode = createClaudeCodeConnector({
      launcherPath: layout.mcpLauncherPath,
      userConfigPath: join(homeDirectory, '.claude.json'),
      boundedExecutableLocations: [
        join(homeDirectory, '.local', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ],
      pathValue: process.env.PATH ?? '',
      higherPrecedenceConfigSources: [{ path: resolve('.mcp.json'), scope: 'project' }],
      requiredTools: ['project_list', 'work_start'],
      receiptStore: claudeReceipt,
    });
    const connectorById = new Map<ConnectorId, HostConnector>([
      ['codex', codex],
      ['claude-code', claudeCode],
    ]);
    const orderedConnectors = createConnectorRegistry().map(({ id }) => connectorById.get(id)!);
    connections = createCliConnectionsRuntime({
      connectors: orderedConnectors,
      launcherPath: layout.mcpLauncherPath,
    });

    const snapshots = new Map<ConnectorId, ConnectorSnapshot>();
    const newSessionRequired = new Map<ConnectorId, boolean>();
    const setupConnectors = Object.fromEntries(
      orderedConnectors.map((connector) => [
        connector.id,
        {
          inspect: async () => {
            const inspected = await connector.inspect();
            return {
              state: inspected.state,
              ...(inspected.state === 'conflict'
                ? { comparison: 'An existing entry differs from the Pimpampum-owned launcher.' }
                : {}),
            };
          },
          connect: async () => {
            const plan = await connector.plan();
            if (plan.state === 'conflict') {
              throw Object.assign(new Error('The existing connector entry requires a decision'), {
                code: 'CONNECTOR_CONFLICT',
              });
            }
            snapshots.set(connector.id, await connector.snapshot());
            newSessionRequired.set(connector.id, plan.newSessionRequired);
            await connector.connect(plan);
          },
          verify: async () => {
            const verified = await connector.verify();
            return {
              available: verified.available,
              newSessionRequired: newSessionRequired.get(connector.id) ?? false,
            };
          },
          restore: async () => {
            const snapshot = snapshots.get(connector.id);
            if (snapshot !== undefined) await connector.restore(snapshot);
          },
        },
      ]),
    ) as Parameters<typeof createSetupCoordinator>[0]['connectors'];
    let lastInstall: Awaited<ReturnType<typeof serviceManager.install>> | null = null;
    const setupState = createSetupStateStore(config.dataDirectory);
    const setupPlan = createSetupPlanStore(config.dataDirectory);
    const setupCoordinator = createSetupCoordinator({
      lifecycleLock: createSetupLifecycleLock(config.dataDirectory),
      runtime: {
        // Embedded/package bootstrap installs the private payload before this stable control CLI runs.
        install: async () => ({ version: PIMPAMPUM_VERSION }),
        rollback: async () => undefined,
      },
      service: {
        install: async () => {
          lastInstall = await serviceManager.install();
        },
        verify: async () => {
          const status = await serviceManager.status();
          if (!status.installed || !status.running) {
            throw new Error('The installed Pimpampum service is not running');
          }
        },
        // Service installation has its own receipt-backed rollback transaction.
        rollback: async () => undefined,
      },
      connectors: setupConnectors,
      loginItem: {
        register: async () =>
          lastInstall?.loginItem === 'requiresApproval'
            ? 'requires-approval'
            : lastInstall?.loginItem === 'error'
              ? 'denied'
              : 'enabled',
      },
      dataDirectory: config.dataDirectory,
      now: () => new Date().toISOString(),
      stateStore: setupState,
      planStore: setupPlan,
    });
    setup = createCliSetupRuntime(setupCoordinator, setupState);
  }

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
    updateManager: createUpdateManager({
      currentVersion: PIMPAMPUM_VERSION,
      npmPath: resolveNpmPath(process.execPath),
      nodePath: process.execPath,
      runCommand: runServiceCommand,
    }),
    ...(connections === undefined ? {} : { connections }),
    ...(setup === undefined ? {} : { setup }),
    ...(serviceOnlyManager ? { serviceOnlyManager } : {}),
    startServer: () => startServer(config),
    // The stdio bridge entry point wires its own signals and runs on import.
    startStdioBridge: async () => {
      await import('./mcpStdio.js');
    },
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
