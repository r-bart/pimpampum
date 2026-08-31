import { userInfo } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  CommandResult,
  PlatformServiceAdapter,
  ServiceAdapterContext,
  ServiceArtifact,
} from './types.js';

export const LAUNCH_AGENT_LABEL = 'dev.pimpampum.daemon';

export interface LaunchAgentInput {
  nodePath: string;
  cliPath: string;
  dataDirectory: string;
  host: string;
  port: number;
  logDirectory: string;
}

export interface LaunchdAdapterOptions {
  guiDomain?: string;
  launchctlPath?: string;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validateAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  if (value.includes('\0')) throw new Error(`${label} must not contain null bytes`);
}

function validateLoopbackHost(host: string): void {
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!loopbackHosts.has(host)) throw new Error('LaunchAgent host must be loopback-only');
}

function validatePort(port: number): void {
  if (!Number.isInteger(port)) throw new Error('LaunchAgent port must be an integer');
  if (port < 1 || port > 65_535) throw new Error('LaunchAgent port must be between 1 and 65535');
}

function validateLogDirectory(dataDirectory: string, logDirectory: string): void {
  const child = relative(dataDirectory, logDirectory);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('LaunchAgent log directory must be inside the data directory');
  }
}

export function renderLaunchAgent(input: LaunchAgentInput): string {
  validateAbsolutePath(input.nodePath, 'Node path');
  validateAbsolutePath(input.cliPath, 'CLI path');
  validateAbsolutePath(input.dataDirectory, 'Data directory');
  validateAbsolutePath(input.logDirectory, 'Log directory');
  validateLoopbackHost(input.host);
  validatePort(input.port);
  validateLogDirectory(input.dataDirectory, input.logDirectory);

  const standardOutputPath = join(input.logDirectory, 'daemon.stdout.log');
  const standardErrorPath = join(input.logDirectory, 'daemon.stderr.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.nodePath)}</string>
    <string>${xml(input.cliPath)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PIMPAMPUM_DATA_DIR</key>
    <string>${xml(input.dataDirectory)}</string>
    <key>PIMPAMPUM_HOST</key>
    <string>${xml(input.host)}</string>
    <key>PIMPAMPUM_PORT</key>
    <string>${input.port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(standardOutputPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(standardErrorPath)}</string>
</dict>
</plist>
`;
}

function launchctlError(operation: string, result: CommandResult): Error {
  return new Error(
    `launchctl ${operation} failed with exit code ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ''}`,
  );
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requireArtifact(artifacts: ServiceArtifact[]): ServiceArtifact {
  const artifact = artifacts[0];
  if (!artifact) throw new Error('Launchd adapter requires its LaunchAgent artifact');
  return artifact;
}

function contextInput(context: ServiceAdapterContext): LaunchAgentInput {
  return {
    nodePath: context.nodePath,
    cliPath: context.cliPath,
    dataDirectory: context.dataDirectory,
    host: context.host,
    port: context.port,
    logDirectory: context.logDirectory,
  };
}

async function bootstrapLaunchAgent(input: {
  context: ServiceAdapterContext;
  launchctlPath: string;
  guiDomain: string;
  artifactPath: string;
  onDisplaced: () => void;
}): Promise<void> {
  const bootstrapArguments = ['bootstrap', input.guiDomain, input.artifactPath];
  const firstBootstrap = await input.context.runCommand(input.launchctlPath, bootstrapArguments);
  if (firstBootstrap.exitCode === 0) return;

  const loaded = await input.context.runCommand(input.launchctlPath, [
    'print',
    `${input.guiDomain}/${LAUNCH_AGENT_LABEL}`,
  ]);
  if (loaded.exitCode !== 0) throw launchctlError('bootstrap', firstBootstrap);

  const bootout = await input.context.runCommand(input.launchctlPath, [
    'bootout',
    input.guiDomain,
    input.artifactPath,
  ]);
  if (bootout.exitCode !== 0) throw launchctlError('reconciliation bootout', bootout);
  input.onDisplaced();

  const reconciledBootstrap = await input.context.runCommand(
    input.launchctlPath,
    bootstrapArguments,
  );
  if (reconciledBootstrap.exitCode !== 0) {
    throw launchctlError('reconciliation bootstrap', reconciledBootstrap);
  }
}

function isMissingRegistration(result: CommandResult): boolean {
  return /(?:no such process|could not find service|service (?:is )?not (?:found|loaded))/i.test(
    result.stderr,
  );
}

interface LaunchdRegistrationState {
  loaded: boolean;
  running: boolean;
}

async function readLaunchdState(
  context: ServiceAdapterContext,
  launchctlPath: string,
  guiDomain: string,
): Promise<LaunchdRegistrationState> {
  const result = await context.runCommand(launchctlPath, [
    'print',
    `${guiDomain}/${LAUNCH_AGENT_LABEL}`,
  ]);
  if (result.exitCode !== 0) {
    if (isMissingRegistration(result)) return { loaded: false, running: false };
    throw launchctlError('print before deactivation', result);
  }
  return {
    loaded: true,
    running: /^\s*state\s*=\s*running\s*$/imu.test(result.stdout),
  };
}

async function restoreLaunchdState(input: {
  context: ServiceAdapterContext;
  launchctlPath: string;
  guiDomain: string;
  artifactPath: string;
  state: LaunchdRegistrationState;
}): Promise<void> {
  const current = await input.context.runCommand(input.launchctlPath, [
    'bootout',
    `${input.guiDomain}/${LAUNCH_AGENT_LABEL}`,
  ]);
  if (current.exitCode !== 0 && !isMissingRegistration(current)) {
    throw launchctlError('rollback bootout', current);
  }
  if (!input.state.loaded) return;
  const bootstrap = await input.context.runCommand(input.launchctlPath, [
    'bootstrap',
    input.guiDomain,
    input.artifactPath,
  ]);
  if (bootstrap.exitCode !== 0) throw launchctlError('rollback bootstrap', bootstrap);
  const operation = input.state.running
    ? ['kickstart', '-k', `${input.guiDomain}/${LAUNCH_AGENT_LABEL}`]
    : ['kill', 'SIGTERM', `${input.guiDomain}/${LAUNCH_AGENT_LABEL}`];
  const restored = await input.context.runCommand(input.launchctlPath, operation);
  if (restored.exitCode !== 0) {
    throw launchctlError(input.state.running ? 'rollback kickstart' : 'rollback stop', restored);
  }
}

async function removePartialRegistration(input: {
  context: ServiceAdapterContext;
  launchctlPath: string;
  guiDomain: string;
  artifactPath: string;
  activationError: Error;
}): Promise<never> {
  let cleanupError: Error | null = null;
  try {
    const cleanup = await input.context.runCommand(input.launchctlPath, [
      'bootout',
      input.guiDomain,
      input.artifactPath,
    ]);
    if (cleanup.exitCode !== 0) cleanupError = launchctlError('bootout', cleanup);
  } catch (error) {
    cleanupError = errorFromUnknown(error);
  }
  if (cleanupError) {
    throw new Error(
      `${input.activationError.message}; partial-registration cleanup also failed: ${cleanupError.message}`,
      { cause: input.activationError },
    );
  }
  throw input.activationError;
}

export function createLaunchdAdapter(options: LaunchdAdapterOptions = {}): PlatformServiceAdapter {
  const guiDomain = options.guiDomain ?? `gui/${userInfo().uid}`;
  const launchctlPath = options.launchctlPath ?? '/bin/launchctl';
  if (!/^gui\/\d+$/.test(guiDomain)) throw new Error('Launchd GUI domain must use gui/<uid>');
  validateAbsolutePath(launchctlPath, 'launchctl path');
  let displacedArtifactPath: string | null = null;

  return {
    id: 'launchd',
    platform: 'darwin',
    artifacts: (context) => [
      {
        path: join(context.homeDirectory, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
        content: renderLaunchAgent(contextInput(context)),
        mode: 0o644,
      },
    ],
    async activate(context, artifacts) {
      const artifact = requireArtifact(artifacts);
      if (displacedArtifactPath !== null) {
        throw new Error('Launchd adapter has a pending external rollback');
      }
      await bootstrapLaunchAgent({
        context,
        launchctlPath,
        guiDomain,
        artifactPath: artifact.path,
        onDisplaced: () => {
          displacedArtifactPath = artifact.path;
        },
      });
      let activationError: Error | null = null;
      try {
        const kickstart = await context.runCommand(launchctlPath, [
          'kickstart',
          '-k',
          `${guiDomain}/${LAUNCH_AGENT_LABEL}`,
        ]);
        if (kickstart.exitCode !== 0) activationError = launchctlError('kickstart', kickstart);
      } catch (error) {
        activationError = errorFromUnknown(error);
      }
      if (activationError) {
        await removePartialRegistration({
          context,
          launchctlPath,
          guiDomain,
          artifactPath: artifact.path,
          activationError,
        });
      }
      displacedArtifactPath = null;
    },
    async afterRollback(context) {
      if (displacedArtifactPath === null) return;
      const artifactPath = displacedArtifactPath;
      const bootstrap = await context.runCommand(launchctlPath, [
        'bootstrap',
        guiDomain,
        artifactPath,
      ]);
      if (bootstrap.exitCode !== 0) throw launchctlError('rollback bootstrap', bootstrap);

      let rollbackError: Error | null = null;
      try {
        const kickstart = await context.runCommand(launchctlPath, [
          'kickstart',
          '-k',
          `${guiDomain}/${LAUNCH_AGENT_LABEL}`,
        ]);
        if (kickstart.exitCode !== 0) {
          rollbackError = launchctlError('rollback kickstart', kickstart);
        }
      } catch (error) {
        rollbackError = errorFromUnknown(error);
      }
      if (rollbackError) {
        await removePartialRegistration({
          context,
          launchctlPath,
          guiDomain,
          artifactPath,
          activationError: rollbackError,
        });
      }
      displacedArtifactPath = null;
    },
    async deactivate(context, artifacts) {
      const artifact = requireArtifact(artifacts);
      const bootout = await context.runCommand(launchctlPath, [
        'bootout',
        guiDomain,
        artifact.path,
      ]);
      if (bootout.exitCode !== 0 && !isMissingRegistration(bootout)) {
        throw launchctlError('bootout', bootout);
      }
    },
    async prepareDeactivationRollback(context, artifacts) {
      const artifact = requireArtifact(artifacts);
      const state = await readLaunchdState(context, launchctlPath, guiDomain);
      return async () =>
        restoreLaunchdState({
          context,
          launchctlPath,
          guiDomain,
          artifactPath: artifact.path,
          state,
        });
    },
    async isRunning(context) {
      const status = await context.runCommand(launchctlPath, [
        'print',
        `${guiDomain}/${LAUNCH_AGENT_LABEL}`,
      ]);
      if (status.exitCode !== 0) {
        if (isMissingRegistration(status)) return false;
        throw launchctlError('print', status);
      }
      return /^\s*state\s*=\s*running\s*$/imu.test(status.stdout);
    },
  };
}
