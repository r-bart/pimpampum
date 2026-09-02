/**
 * Builds the `CliRuntime` the verbs run against, from a `CliHost` and nothing else.
 *
 * Composition is lazy. The configuration is a pure read; the packaged-runtime bootstrap, the
 * service managers, the connectors, the guided setup and the update manager each resolve on first
 * use; and the two asynchronous preparations — staging the macOS app and probing Omarchy — run only
 * for the verbs that need them. `help` with a read-only home therefore succeeds, and a corrupt
 * receipt fails `status` with its own remedy instead of every verb with npm advice.
 */
import { resolve } from 'node:path';
import { createAgentCliClient } from '../agentClient.js';
import { localErrorDetails } from '../agentProtocol.js';
import { createHttpClient } from '../client.js';
import { MAX_BODY_FILE_BYTES, readBoundedStdin, readBoundedUtf8File } from '../cliInput.js';
import {
  createCliConnectionsRuntime,
  type CliConnectionsRuntime,
  type CliRuntime,
  type CliSetupRuntime,
} from '../cliProgram.js';
import {
  ensureDataDirectory,
  missingDaemonTokenError,
  tokenPathOf,
  type RuntimeConfig,
} from '../config.js';
import { AppError } from '../errors.js';
import { MAX_AGENT_INPUT_BYTES } from '../limits.js';
import {
  resolvePackagedRuntimeBootstrap,
  type PackagedRuntimeBootstrap,
} from '../runtime/bootstrap.js';
import { resolveRuntimeLayout } from '../runtime/layout.js';
import { startServer } from '../server.js';
import type { PlatformServiceManagerInput, ServiceManager } from '../service/types.js';
import { resolveNpmPath, type UpdateManager } from '../update.js';
import { PIMPAMPUM_VERSION } from '../version.js';
import { createGuidedSetup, createHostConnectors } from './connectorSetup.js';
import {
  describeRuntimeTarget,
  resolveEntryPaths,
  type CliHost,
  type EntryPaths,
  type RuntimeTarget,
} from './host.js';
import { createPackagedCommandServiceManager } from './packagedLifecycle.js';
import { createCliUpdateManager } from './packagedUpdateProvider.js';
import {
  createCandidateServiceManagerFactory,
  createPlatformServiceManagers,
  probeOmarchy,
  serviceArtifactPath,
  type OmarchyProbe,
} from './platformAdapters.js';
import {
  pathEntryExists,
  stagePackagedMacOSApplication,
  type StagedMacOSApplication,
} from './releaseCandidate.js';

/** `npm install --global` fetches a tarball and runs no scripts; ten minutes covers a slow network. */
const NPM_INSTALL_TIMEOUT_MS = 600_000;

type InstallKind = 'packaged' | 'npm';

/** Resolves once on first use, so a verb pays only for the composition it needs. */
function lazy<T>(build: () => T): () => T {
  let resolved: { value: T } | null = null;
  return () => {
    if (resolved === null) resolved = { value: build() };
    return resolved.value;
  };
}

/** The reinstall that fits how this CLI was installed, so the remedy never names the wrong tool. */
function compositionRemedy(installKind: InstallKind, platform: string): string {
  if (installKind === 'npm') {
    return 'Reinstall with `npm install --global pimpampum`, then run `pimpampum status`.';
  }
  return platform === 'darwin'
    ? 'Reinstall the Pimpampum app and run its guided setup, then run `pimpampum status`.'
    : 'Reinstall the Pimpampum Status plugin and run `pimpampum-bootstrap` from its directory, then run `pimpampum status`.';
}

/**
 * A packaged-runtime or receipt failure met while composing the lifecycle managers. It surfaces
 * only for the verbs that resolve those managers, typed, with the remedy for this install kind.
 * `help`, `version`, `commands` and `config` never reach the composition, and nothing here escapes
 * to `cli.ts`, which would label it a startup failure and suggest npm to a packaged install.
 */
export function compositionFailure(
  error: unknown,
  installKind: InstallKind,
  platform: string,
): AppError {
  if (error instanceof AppError) return error;
  const remedy = compositionRemedy(installKind, platform);
  const message = error instanceof Error ? error.message : 'Lifecycle composition failed';
  return new AppError('unavailable', `${message}. ${remedy}`, 503, false, {
    phase: 'composition',
    installKind,
    remedy,
    ...(error instanceof Error ? localErrorDetails(error) : {}),
  });
}

/**
 * The one operation the composition delegates that neither the host nor a unit test can supply:
 * downloading the signed macOS app. Tests inject a stager; the CLI keeps the default.
 */
export interface CompositionDependencies {
  stageMacOSApplication: typeof stagePackagedMacOSApplication;
}

const DEFAULT_DEPENDENCIES: CompositionDependencies = {
  stageMacOSApplication: stagePackagedMacOSApplication,
};

interface CompositionContext {
  host: CliHost;
  dependencies: CompositionDependencies;
  verb: string;
  paths: EntryPaths;
  target: RuntimeTarget;
  /** A client's configuration read; the data directory may not exist yet. */
  clientConfig(): RuntimeConfig;
  /** The same read, failing typed while the daemon has not minted its token. */
  daemonClientConfig(): RuntimeConfig;
  packagedRuntimeBootstrap(): PackagedRuntimeBootstrap | null;
  installKind(): InstallKind;
  /** The app bundle a checkout or a packaged runtime carries; may not exist on disk. */
  builtMacOSApp(): string;
}

function createContext(host: CliHost, dependencies: CompositionDependencies): CompositionContext {
  const paths = resolveEntryPaths(host.entryModulePath);
  const target = describeRuntimeTarget(host.platform, host.arch);
  const clientConfig = (): RuntimeConfig => host.config.client();
  const packagedRuntimeBootstrap = lazy((): PackagedRuntimeBootstrap | null => {
    if (!target.supported) return null;
    try {
      return resolvePackagedRuntimeBootstrap({
        homeDirectory: host.homeDirectory,
        dataDirectory: clientConfig().dataDirectory,
        platform: target.platform,
        architecture: target.architecture,
        version: PIMPAMPUM_VERSION,
        nodePath: host.execPath,
        cliPath: paths.compiledCliPath,
      });
    } catch (error) {
      // Only a packaged runtime can fail here: a manifest beside the CLI or an active runtime
      // receipt that names this exact CLI.
      throw compositionFailure(error, 'packaged', host.platform);
    }
  });
  return {
    host,
    dependencies,
    verb: host.argv[0] ?? '',
    paths,
    target,
    clientConfig,
    daemonClientConfig: () => {
      const config = clientConfig();
      if (config.token === '') throw missingDaemonTokenError(config.dataDirectory);
      return config;
    },
    packagedRuntimeBootstrap,
    // Only asked after the lifecycle resolved, so the bootstrap has already succeeded once.
    installKind: () => (packagedRuntimeBootstrap() === null ? 'npm' : 'packaged'),
    builtMacOSApp: lazy(
      () => packagedRuntimeBootstrap()?.sourceApplicationPath ?? paths.builtMacOSAppPath,
    ),
  };
}

/**
 * An npm install has no app bundle next to the CLI. Only the two commands that copy the app need
 * one, so only they pay for the download; status and uninstall keep working without a source.
 */
async function prepareMacOSAppSource(
  context: CompositionContext,
): Promise<StagedMacOSApplication | null> {
  const { host, target, verb } = context;
  const requested =
    target.supported &&
    target.platform === 'darwin' &&
    ((verb === 'install' && !host.argv.includes('--service-only')) ||
      (verb === 'setup' && host.argv[1] === 'apply'));
  if (!requested || pathEntryExists(context.builtMacOSApp())) return null;
  const staged = await context.dependencies.stageMacOSApplication({
    homeDirectory: host.homeDirectory,
    dataDirectory: context.clientConfig().dataDirectory,
    version: PIMPAMPUM_VERSION,
    runCommand: host.runCommand,
    environment: host.env,
    currentUid: host.uid,
  });
  // `runCli` leaves through the host's `exit`, so a `finally` would not run; the exit hook does.
  host.onExit(() => staged.cleanup());
  return staged;
}

interface ComposedLifecycle {
  managerInput: PlatformServiceManagerInput;
  serviceManager: ServiceManager;
  /** What `install` and `uninstall` call: the packaged transactions where the runtime ships. */
  commandServiceManager: ServiceManager;
  serviceOnlyManager: ServiceManager | undefined;
  connections: CliConnectionsRuntime | undefined;
  setup: CliSetupRuntime | undefined;
}

function composeLifecycle(
  context: CompositionContext,
  stagedApp: StagedMacOSApplication | null,
  omarchy: OmarchyProbe,
): ComposedLifecycle {
  const { host, target } = context;
  const config = context.clientConfig();
  const bootstrap = context.packagedRuntimeBootstrap();
  // Receipts, lifecycle locks and setup journals live here; the daemon has not necessarily run.
  ensureDataDirectory(config.dataDirectory);
  const managerInput: PlatformServiceManagerInput = {
    platform: host.platform,
    homeDirectory: host.homeDirectory,
    dataDirectory: config.dataDirectory,
    nodePath: bootstrap?.nodePath ?? host.execPath,
    cliPath: bootstrap?.cliPath ?? context.paths.compiledCliPath,
    version: PIMPAMPUM_VERSION,
    host: config.host,
    port: config.port,
    runCommand: host.runCommand,
    ...(bootstrap === null ? {} : { packagedRuntime: bootstrap.packagedRuntime }),
  };
  const managers = createPlatformServiceManagers({
    managerInput,
    macOSAppBundlePath: stagedApp?.appBundlePath ?? context.builtMacOSApp(),
    omarchy,
    omarchyPluginSourcePath: context.paths.bundledOmarchyPluginPath,
  });
  if (!target.supported) {
    return {
      ...managers,
      commandServiceManager: managers.serviceManager,
      connections: undefined,
      setup: undefined,
    };
  }
  const layout = resolveRuntimeLayout({
    homeDirectory: host.homeDirectory,
    platform: target.platform,
    architecture: target.architecture,
    version: PIMPAMPUM_VERSION,
  });
  const connectors = createHostConnectors({
    homeDirectory: host.homeDirectory,
    dataDirectory: config.dataDirectory,
    launcherPath: layout.mcpLauncherPath,
    pathValue: host.env.PATH ?? '',
    cwd: host.cwd,
  });
  return {
    ...managers,
    commandServiceManager: createPackagedCommandServiceManager({
      serviceManager: managers.serviceManager,
      bootstrap,
      homeDirectory: host.homeDirectory,
      dataDirectory: config.dataDirectory,
      target,
      runCommand: host.runCommand,
      connectors,
    }),
    connections: createCliConnectionsRuntime({
      connectors: connectors.ordered,
      launcherPath: layout.mcpLauncherPath,
    }),
    setup: createGuidedSetup({
      dataDirectory: config.dataDirectory,
      homeDirectory: host.homeDirectory,
      version: PIMPAMPUM_VERSION,
      target,
      layout,
      bootstrap,
      runCommand: host.runCommand,
      serviceManager: managers.serviceManager,
      servicePath: serviceArtifactPath(host.platform, host.homeDirectory),
      connectors,
    }),
  };
}

function composeUpdateManager(
  context: CompositionContext,
  lifecycle: () => ComposedLifecycle,
): UpdateManager {
  const { host, target } = context;
  const composed = lifecycle();
  try {
    return createCliUpdateManager({
      currentVersion: PIMPAMPUM_VERSION,
      dataDirectory: context.clientConfig().dataDirectory,
      homeDirectory: host.homeDirectory,
      target: target.supported ? target.packagedRelease : null,
      npmPath: resolveNpmPath(host.execPath),
      nodePath: host.execPath,
      runCommand: host.createCommandRunner({ timeoutMilliseconds: NPM_INSTALL_TIMEOUT_MS }),
      currentServiceManager: composed.serviceManager,
      createCandidateServiceManager: createCandidateServiceManagerFactory(composed.managerInput),
      environment: host.env,
      currentUid: host.uid,
    });
  } catch (error) {
    // `readUpdateReceipt` refuses an invalid receipt; that is this verb's failure, typed.
    throw compositionFailure(error, context.installKind(), host.platform);
  }
}

function createRuntime(
  context: CompositionContext,
  lifecycle: () => ComposedLifecycle,
  updateManager: () => UpdateManager,
): CliRuntime {
  const { host, paths } = context;
  const tokenFromEnvironment = Boolean(host.env.PIMPAMPUM_TOKEN?.trim());
  return {
    createClient: () => createHttpClient(context.daemonClientConfig()),
    // `async` so a missing token rejects instead of throwing synchronously from a method the
    // contract declares as returning a promise.
    createAgentClient: async () => createAgentCliClient(context.daemonClientConfig()),
    describeConfig: () => {
      const config = context.clientConfig();
      return {
        dataDirectory: config.dataDirectory,
        databasePath: config.databasePath,
        baseUrl: config.baseUrl,
        tokenPath: tokenFromEnvironment ? null : tokenPathOf(config.dataDirectory),
        tokenSource: tokenFromEnvironment ? 'environment' : 'file',
        tokenConfigured: config.token.length > 0,
        mcp: {
          streamableHttpUrl: `${config.baseUrl}/mcp`,
          stdio: { command: host.execPath, args: [paths.compiledMcpStdioPath] },
        },
      };
    },
    get serviceManager() {
      return lifecycle().commandServiceManager;
    },
    get serviceOnlyManager() {
      return lifecycle().serviceOnlyManager;
    },
    get updateManager() {
      return updateManager();
    },
    get connections() {
      return lifecycle().connections;
    },
    get setup() {
      return lifecycle().setup;
    },
    // The daemon is the one process that creates the data directory and mints the token.
    startServer: () => startServer(host.config.daemon()),
    startStdioBridge: () => host.startStdioBridge(),
    readFile: (path, maxBytes = MAX_BODY_FILE_BYTES) => readBoundedUtf8File(path, maxBytes, 'File'),
    readStdin: (maxBytes = MAX_AGENT_INPUT_BYTES) => readBoundedStdin(host.stdin, maxBytes),
    resolvePath: (path) => resolve(host.cwd, path),
    stdout: (text) => host.stdout(text),
    stderr: (text) => host.stderr(text),
    onSignal: (signal, callback) => host.onSignal(signal, callback),
    exit: (code) => host.exit(code),
  };
}

export async function composeCliRuntime(
  host: CliHost,
  dependencies: CompositionDependencies = DEFAULT_DEPENDENCIES,
): Promise<CliRuntime> {
  const context = createContext(host, dependencies);
  const stagedApp = await prepareMacOSAppSource(context);
  const omarchy = await probeOmarchy(host, context.verb);
  const lifecycle = lazy(() => composeLifecycle(context, stagedApp, omarchy));
  const updateManager = lazy(() => composeUpdateManager(context, lifecycle));
  return createRuntime(context, lifecycle, updateManager);
}
