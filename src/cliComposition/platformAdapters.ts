/**
 * Which service adapters a host gets, and the health-verified manager over them. macOS pairs the
 * launchd daemon with the desktop app; Linux pairs systemd with the Omarchy plugin when Omarchy
 * owns the desktop; any other host has no adapter and every lifecycle verb says so.
 */
import { join } from 'node:path';
import { verifyServiceHealth } from '../service/health.js';
import { createLaunchdAdapter } from '../service/launchd.js';
import { createMacOSDesktopAdapter } from '../service/macosApp.js';
import { createPlatformServiceManager } from '../service/manager.js';
import { createOmarchyAdapter, isCompatibleOmarchyVersion } from '../service/omarchy.js';
import { createSystemdAdapter } from '../service/systemd.js';
import type {
  CommandResult,
  PlatformServiceManagerInput,
  ServiceManager,
} from '../service/types.js';
import type { CliHost } from './host.js';
import type { CandidateServiceManagerInput } from './packagedUpdateProvider.js';

export function createHealthVerifiedServiceManager(
  input: PlatformServiceManagerInput,
  healthVerifier: typeof verifyServiceHealth = verifyServiceHealth,
): ServiceManager {
  return createPlatformServiceManager({
    ...input,
    postActivationVerifier: async ({ receipt }) => {
      // The service manager already holds its lifecycle lock here and has verified the exact
      // receipt. Re-entering manager.status() would deadlock against that same process-owned lock;
      // the versioned loopback health response is the authoritative running check.
      await healthVerifier({ baseUrl: receipt.baseUrl, version: receipt.version });
    },
  });
}

/** `omarchy version` answers in milliseconds; a hung dispatcher must not stall `status`. */
const OMARCHY_PROBE_TIMEOUT_MS = 5_000;
/**
 * Every verb that installs, verifies or replaces the service must know whether Omarchy owns the
 * desktop, or `setup apply` installs a service without the status plugin.
 */
const SERVICE_LIFECYCLE_VERBS = new Set([
  'install',
  'status',
  'uninstall',
  'setup',
  'update',
  'update:check',
]);

export interface OmarchyProbe {
  omarchyPath: string | null;
  omarchyShellPath: string | null;
  /** Omarchy answered `version` with a compatible release, so the plugin adapter is the active one. */
  useOmarchy: boolean;
}

export async function probeOmarchy(
  host: Pick<CliHost, 'platform' | 'findExecutable' | 'runCommand'>,
  verb: string,
): Promise<OmarchyProbe> {
  const omarchyPath = host.platform === 'linux' ? host.findExecutable('omarchy') : null;
  const omarchyShellPath = host.platform === 'linux' ? host.findExecutable('omarchy-shell') : null;
  if (!SERVICE_LIFECYCLE_VERBS.has(verb) || omarchyPath === null || omarchyShellPath === null) {
    return { omarchyPath, omarchyShellPath, useOmarchy: false };
  }
  const probe = (flag: string): Promise<CommandResult | null> =>
    host
      .runCommand(omarchyPath, [flag], { timeoutMilliseconds: OMARCHY_PROBE_TIMEOUT_MS })
      .catch(() => null);
  let version = await probe('version');
  if (version !== null && version.exitCode !== 0) version = await probe('--version');
  return {
    omarchyPath,
    omarchyShellPath,
    useOmarchy: version?.exitCode === 0 && isCompatibleOmarchyVersion(version.stdout),
  };
}

type AdapterSelection = Pick<PlatformServiceManagerInput, 'adapters' | 'receiptAdapters'>;

interface PlatformAdapterSet {
  /** What `install` activates. */
  primary: AdapterSelection;
  /** macOS only: the daemon without the desktop app, for `install --service-only`. */
  serviceOnly: AdapterSelection | null;
}

function darwinAdapters(appBundlePath: string): PlatformAdapterSet {
  const daemon = createLaunchdAdapter();
  const desktop = createMacOSDesktopAdapter({ appBundlePath, daemonAdapter: daemon });
  const receiptAdapters = { [daemon.id]: daemon, [desktop.id]: desktop };
  return {
    primary: { adapters: { darwin: desktop }, receiptAdapters },
    serviceOnly: { adapters: { darwin: daemon }, receiptAdapters },
  };
}

/**
 * The plugin adapter exists whenever both Omarchy executables do, so a receipt written by it can
 * still be read and removed after Omarchy stops answering; it is the active adapter only when the
 * probe confirmed a compatible release.
 */
function linuxAdapters(omarchy: OmarchyProbe, pluginSourcePath: string): PlatformAdapterSet {
  const daemon = createSystemdAdapter();
  const plugin =
    omarchy.omarchyPath !== null && omarchy.omarchyShellPath !== null
      ? createOmarchyAdapter({
          pluginSourcePath,
          daemonAdapter: daemon,
          omarchyPath: omarchy.omarchyPath,
          omarchyShellPath: omarchy.omarchyShellPath,
        })
      : null;
  return {
    primary: {
      adapters: { linux: plugin !== null && omarchy.useOmarchy ? plugin : daemon },
      receiptAdapters: { [daemon.id]: daemon, ...(plugin === null ? {} : { [plugin.id]: plugin }) },
    },
    serviceOnly: null,
  };
}

export interface PlatformServiceManagers {
  /** The input every manager shares; the update provider derives candidate managers from it. */
  managerInput: PlatformServiceManagerInput;
  serviceManager: ServiceManager;
  serviceOnlyManager: ServiceManager | undefined;
}

export function createPlatformServiceManagers(input: {
  managerInput: PlatformServiceManagerInput;
  macOSAppBundlePath: string;
  omarchy: OmarchyProbe;
  omarchyPluginSourcePath: string;
}): PlatformServiceManagers {
  const { platform } = input.managerInput;
  const adapters: PlatformAdapterSet =
    platform === 'darwin'
      ? darwinAdapters(input.macOSAppBundlePath)
      : platform === 'linux'
        ? linuxAdapters(input.omarchy, input.omarchyPluginSourcePath)
        : { primary: {}, serviceOnly: null };
  return {
    managerInput: input.managerInput,
    serviceManager: createHealthVerifiedServiceManager({
      ...input.managerInput,
      ...adapters.primary,
    }),
    serviceOnlyManager:
      adapters.serviceOnly === null
        ? undefined
        : createHealthVerifiedServiceManager({ ...input.managerInput, ...adapters.serviceOnly }),
  };
}

/** A manager for the staged macOS candidate an update activates; only macOS can host one. */
export function createCandidateServiceManagerFactory(
  managerInput: PlatformServiceManagerInput,
): (candidate: CandidateServiceManagerInput) => ServiceManager {
  return ({ appBundlePath, version, nodePath, cliPath, packagedRuntime }) => {
    if (managerInput.platform !== 'darwin') {
      throw new Error('Packaged macOS candidates can only activate on macOS');
    }
    return createHealthVerifiedServiceManager({
      ...managerInput,
      version,
      nodePath,
      cliPath,
      packagedRuntime,
      ...darwinAdapters(appBundlePath).primary,
    });
  };
}

/** Where the service definition lands, named in the setup plan so the confirmation can show it. */
export function serviceArtifactPath(platform: NodeJS.Platform, homeDirectory: string): string {
  return platform === 'darwin'
    ? join(homeDirectory, 'Library', 'LaunchAgents', 'dev.pimpampum.daemon.plist')
    : join(homeDirectory, '.config', 'systemd', 'user', 'pimpampum.service');
}
