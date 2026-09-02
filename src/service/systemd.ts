import { isAbsolute, join } from 'node:path';
import { runCompensation } from '../aggregateRollback.js';
import { asError } from '../objects.js';
import type { CommandResult, PlatformServiceAdapter, ServiceAdapterContext } from './types.js';

export const SYSTEMD_UNIT_NAME = 'pimpampum.service';

export interface SystemdUnitInput {
  nodePath: string;
  cliPath: string;
  dataDirectory: string;
  host: string;
  port: number;
}

export interface SystemdAdapterOptions {
  systemctlPath?: string;
}

function validateAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  if (/[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must not contain null bytes or line breaks`);
  }
}

function validateLoopbackHost(host: string): void {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('systemd service host must be loopback-only');
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port)) throw new Error('systemd service port must be an integer');
  if (port < 1 || port > 65_535) {
    throw new Error('systemd service port must be between 1 and 65535');
  }
}

/**
 * Escapes one double-quoted unit-file string. Backslash, quote and tab follow the unit file
 * lexer; `%` is doubled because systemd resolves specifiers (`%h`, `%i`) in every setting.
 */
function escapeUnitString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('\t', '\\t');
}

/** `ExecStart=` expands `$VARIABLE` and `${VARIABLE}`, so a literal dollar must be doubled. */
function quoteExecStartArgument(value: string): string {
  return `"${escapeUnitString(value).replaceAll('$', () => '$$')}"`;
}

/**
 * `Environment=` takes each assignment literally: specifiers still resolve, but systemd performs
 * no variable expansion there, so doubling `$` would leave `$$` in the daemon's environment.
 */
function quoteEnvironmentAssignment(name: string, value: string): string {
  return `"${name}=${escapeUnitString(value)}"`;
}

export function renderSystemdUnit(input: SystemdUnitInput): string {
  validateAbsolutePath(input.nodePath, 'Node path');
  validateAbsolutePath(input.cliPath, 'CLI path');
  validateAbsolutePath(input.dataDirectory, 'Data directory');
  validateLoopbackHost(input.host);
  validatePort(input.port);

  return `[Unit]
Description=Pimpampum local daemon
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
Environment=${quoteEnvironmentAssignment('PIMPAMPUM_DATA_DIR', input.dataDirectory)}
Environment=${quoteEnvironmentAssignment('PIMPAMPUM_HOST', input.host)}
Environment=${quoteEnvironmentAssignment('PIMPAMPUM_PORT', String(input.port))}
ExecStart=${quoteExecStartArgument(input.nodePath)} ${quoteExecStartArgument(input.cliPath)} serve
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pimpampum
UMask=0077

[Install]
WantedBy=default.target
`;
}

function systemctlError(operation: string, result: CommandResult): Error {
  return new Error(
    `systemctl ${operation} failed with exit code ${result.exitCode}; stderr=${JSON.stringify(result.stderr.trim())}`,
  );
}

type UnitMutationOperation = 'disable --now' | 'reset-failed';

const ABSENT_UNIT_MESSAGES: Record<UnitMutationOperation, ReadonlySet<string>> = {
  'disable --now': new Set([
    `Failed to disable unit: Unit file ${SYSTEMD_UNIT_NAME} does not exist.`,
    `Failed to disable unit: Unit ${SYSTEMD_UNIT_NAME} does not exist.`,
  ]),
  'reset-failed': new Set([
    `Failed to reset failed state of unit ${SYSTEMD_UNIT_NAME}: Unit ${SYSTEMD_UNIT_NAME} not loaded.`,
  ]),
};

async function runSystemctl(
  context: ServiceAdapterContext,
  systemctlPath: string,
  operation: string,
  arguments_: string[],
): Promise<CommandResult> {
  const result = await context.runCommand(systemctlPath, ['--user', ...arguments_]);
  if (result.exitCode !== 0) throw systemctlError(operation, result);
  return result;
}

async function runSystemctlAllowAbsent(
  context: ServiceAdapterContext,
  systemctlPath: string,
  operation: UnitMutationOperation,
  arguments_: string[],
): Promise<CommandResult> {
  const result = await context.runCommand(systemctlPath, ['--user', ...arguments_]);
  if (result.exitCode === 0) return result;
  const recognizedMessages = ABSENT_UNIT_MESSAGES[operation];
  if (
    recognizedMessages.has(result.stdout.trim()) ||
    recognizedMessages.has(result.stderr.trim())
  ) {
    return result;
  }
  throw systemctlError(operation, result);
}

function contextInput(context: ServiceAdapterContext): SystemdUnitInput {
  return {
    nodePath: context.nodePath,
    cliPath: context.cliPath,
    dataDirectory: context.dataDirectory,
    host: context.host,
    port: context.port,
  };
}

interface PreviousSystemdState {
  enabled: boolean;
  running: boolean;
}

function systemctlProperty(stdout: string, name: string): string {
  const prefix = `${name}=`;
  const value = stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`systemctl show did not return ${name}`);
  return value;
}

async function readPreviousSystemdState(
  context: ServiceAdapterContext,
  systemctlPath: string,
): Promise<PreviousSystemdState> {
  const result = await runSystemctl(context, systemctlPath, 'show before activation', [
    'show',
    SYSTEMD_UNIT_NAME,
    '--property=LoadState',
    '--property=UnitFileState',
    '--property=ActiveState',
    '--no-pager',
  ]);
  if (systemctlProperty(result.stdout, 'LoadState') === 'not-found') {
    return { enabled: false, running: false };
  }
  const unitFileState = systemctlProperty(result.stdout, 'UnitFileState');
  const activeState = systemctlProperty(result.stdout, 'ActiveState');
  return {
    enabled: ['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias'].includes(
      unitFileState,
    ),
    running: activeState === 'active',
  };
}

async function compensateFailedActivation(
  context: ServiceAdapterContext,
  systemctlPath: string,
  activationError: unknown,
): Promise<never> {
  const original = asError(activationError);
  return runCompensation(
    original,
    (
      [
        ['disable --now', ['disable', '--now', SYSTEMD_UNIT_NAME]],
        ['reset-failed', ['reset-failed', SYSTEMD_UNIT_NAME]],
      ] as const
    ).map(([operation, arguments_]) => async () => {
      await runSystemctlAllowAbsent(context, systemctlPath, operation, [...arguments_]);
    }),
    `systemd activation compensation failed after: ${original.message}`,
  );
}

async function restoreSystemdState(
  context: ServiceAdapterContext,
  systemctlPath: string,
  previousState: PreviousSystemdState,
): Promise<void> {
  await runSystemctlAllowAbsent(context, systemctlPath, 'disable --now', [
    'disable',
    '--now',
    SYSTEMD_UNIT_NAME,
  ]);
  await runSystemctlAllowAbsent(context, systemctlPath, 'reset-failed', [
    'reset-failed',
    SYSTEMD_UNIT_NAME,
  ]);
  await runSystemctl(context, systemctlPath, 'daemon-reload after deactivation rollback', [
    'daemon-reload',
  ]);
  if (previousState.enabled) {
    await runSystemctl(context, systemctlPath, 'restore enabled state', [
      'enable',
      ...(previousState.running ? ['--now'] : []),
      SYSTEMD_UNIT_NAME,
    ]);
  } else if (previousState.running) {
    await runSystemctl(context, systemctlPath, 'restore running state', [
      'start',
      SYSTEMD_UNIT_NAME,
    ]);
  }
}

export function createSystemdAdapter(options: SystemdAdapterOptions = {}): PlatformServiceAdapter {
  const systemctlPath = options.systemctlPath ?? '/usr/bin/systemctl';
  validateAbsolutePath(systemctlPath, 'systemctl path');
  let rollbackState: PreviousSystemdState | null = null;

  return {
    id: 'systemd',
    platform: 'linux',
    artifacts: (context) => [
      {
        path: join(context.homeDirectory, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME),
        content: renderSystemdUnit(contextInput(context)),
        mode: 0o600,
      },
    ],
    async activate(context) {
      rollbackState = null;
      await runSystemctl(context, systemctlPath, 'daemon-reload', ['daemon-reload']);
      const previousState = await readPreviousSystemdState(context, systemctlPath);
      try {
        await runSystemctl(context, systemctlPath, 'enable --now', [
          'enable',
          '--now',
          SYSTEMD_UNIT_NAME,
        ]);
        // `enable --now` leaves an already-active unit running its old ExecStart. Restart it so
        // an update serves the new version before health verification asks for it, the way the
        // launchd adapter's `kickstart -k` does.
        if (previousState.running) {
          await runSystemctl(context, systemctlPath, 'restart', ['restart', SYSTEMD_UNIT_NAME]);
        }
      } catch (error) {
        rollbackState = previousState;
        await compensateFailedActivation(context, systemctlPath, error);
      }
      rollbackState = null;
    },
    async afterRollback(context) {
      const previousState = rollbackState;
      rollbackState = null;
      await runSystemctl(context, systemctlPath, 'daemon-reload after rollback', ['daemon-reload']);
      if (!previousState) return;
      if (previousState.enabled) {
        await runSystemctl(context, systemctlPath, 'restore enabled state', [
          'enable',
          ...(previousState.running ? ['--now'] : []),
          SYSTEMD_UNIT_NAME,
        ]);
      } else if (previousState.running) {
        await runSystemctl(context, systemctlPath, 'restore running state', [
          'start',
          SYSTEMD_UNIT_NAME,
        ]);
      }
    },
    async deactivate(context) {
      await runSystemctlAllowAbsent(context, systemctlPath, 'disable --now', [
        'disable',
        '--now',
        SYSTEMD_UNIT_NAME,
      ]);
      await runSystemctlAllowAbsent(context, systemctlPath, 'reset-failed', [
        'reset-failed',
        SYSTEMD_UNIT_NAME,
      ]);
    },
    async prepareDeactivationRollback(context) {
      const previousState = await readPreviousSystemdState(context, systemctlPath);
      return async () => restoreSystemdState(context, systemctlPath, previousState);
    },
    async isRunning(context) {
      const result = await runSystemctl(context, systemctlPath, 'show', [
        'show',
        SYSTEMD_UNIT_NAME,
        '--property=LoadState',
        '--property=ActiveState',
        '--no-pager',
      ]);
      return (
        /^LoadState=loaded$/mu.test(result.stdout) && /^ActiveState=active$/mu.test(result.stdout)
      );
    },
  };
}
