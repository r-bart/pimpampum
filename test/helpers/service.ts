import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi, type Mock } from 'vitest';
import type { LoginAcknowledgementStatus } from '../../src/service/loginHandshake.js';
import type { CommandResult, RunCommand, ServiceAdapterContext } from '../../src/service/types.js';

/** A command that exited 0 with nothing on either stream. */
export function success(): CommandResult {
  return { exitCode: 0, stdout: '', stderr: '' };
}

/** A command result with explicit fields; unspecified fields are those of `success()`. */
export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ...success(), ...overrides };
}

export type AdapterContextOverrides = Partial<ServiceAdapterContext> &
  Pick<ServiceAdapterContext, 'homeDirectory' | 'dataDirectory'>;

/**
 * A `ServiceAdapterContext` with the defaults the adapter suites share. Only the two directories
 * are required; `logDirectory` defaults to `<dataDirectory>/logs` and `runCommand` to a runner that
 * answers `success()` to everything.
 */
export function adapterContext(overrides: AdapterContextOverrides): ServiceAdapterContext {
  return {
    nodePath: '/usr/bin/node',
    cliPath: '/opt/pimpampum/cli.js',
    version: '1.0.0',
    host: '127.0.0.1',
    port: 7337,
    logDirectory: join(overrides.dataDirectory, 'logs'),
    runCommand: async () => success(),
    ...overrides,
  };
}

export interface AcknowledgingOpenOptions {
  /** The data directory where the macOS adapter writes its login control files. */
  dataDirectory: string;
  /** Status the helper app reports for a registration request. Default `enabled`. */
  status?: LoginAcknowledgementStatus;
  /** Whether the registration changed the login item. Default `true`. */
  registrationChanged?: boolean;
  /** File mode of the acknowledgement files. Default `0o600`, the mode the real helper uses. */
  mode?: number;
  /** Status reported as `previousStatus` on unregistration. Default `enabled`. */
  previousStatus?: LoginAcknowledgementStatus;
  /**
   * Clock for the unregistration acknowledgement. The adapter rejects a `createdAt` outside its
   * own start/completion window, so it must agree with the adapter's injected `now`. Default: the
   * fixed instant the macOS adapter suites inject.
   */
  now?: () => string;
  /** Handles every other command. Default: answers `success()`. */
  fallback?: RunCommand;
}

/**
 * A `RunCommand` that stands in for the macOS helper app during login registration. When the
 * adapter runs `/usr/bin/open … --register-login-item`, it reads the request the adapter wrote and
 * answers with a matching acknowledgement; on `--unregister-login-item` it writes the unregistration
 * acknowledgement. Every other command goes to `fallback`. Returned as a `vi.fn` so suites can
 * assert the calls.
 */
export function acknowledgingOpen(options: AcknowledgingOpenOptions): Mock<RunCommand> {
  const status = options.status ?? 'enabled';
  const registrationChanged = options.registrationChanged ?? true;
  const mode = options.mode ?? 0o600;
  const previousStatus = options.previousStatus ?? 'enabled';
  const now = options.now ?? (() => '2026-08-26T20:00:00.000Z');
  const fallback: RunCommand = options.fallback ?? (async () => success());
  return vi.fn<RunCommand>(async (executable, arguments_) => {
    if (executable === '/usr/bin/open' && arguments_.includes('--register-login-item')) {
      const request = JSON.parse(
        readFileSync(join(options.dataDirectory, 'login-registration-request.json'), 'utf8'),
      ) as { requestId: string; requestedAt: string };
      writeFileSync(
        join(options.dataDirectory, 'login-registration-acknowledgement.json'),
        JSON.stringify({
          requestId: request.requestId,
          createdAt: request.requestedAt,
          status,
          registrationChanged,
        }),
        { mode },
      );
      return success();
    }
    if (executable === '/usr/bin/open' && arguments_.includes('--unregister-login-item')) {
      writeFileSync(
        join(options.dataDirectory, 'login-unregistration-acknowledgement.json'),
        JSON.stringify({ createdAt: now(), previousStatus, status: 'disabled' }),
        { mode },
      );
      return success();
    }
    return fallback(executable, arguments_);
  });
}
