import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { acceptLoginAcknowledgement } from './loginHandshake.js';
import { assertNoSymlinkTraversal, writePrivateFileAtomic } from './receipt.js';
import type {
  LoginAcknowledgement,
  LoginAcknowledgementStatus,
  LoginRequest,
} from './loginHandshake.js';
import type {
  PlatformServiceAdapter,
  ServiceAdapterContext,
  ServiceArtifact,
  ServiceIntegrationStatus,
} from './types.js';

const APP_NAME = 'PimpampumMenuBar.app';
const LEGACY_APP_NAMES = ['pim • pam • pum.app', 'Pimpampum.app'] as const;
const APP_EXECUTABLE = 'Contents/MacOS/PimpampumMenuBar';
const INSTALLATION_CONFIGURATION = 'Contents/Resources/installation.json';
const REQUEST_FILE = 'login-registration-request.json';
const ACKNOWLEDGEMENT_FILE = 'login-registration-acknowledgement.json';
const STATUS_FILE = 'login-item-status.json';
const UNREGISTRATION_ACKNOWLEDGEMENT_FILE = 'login-unregistration-acknowledgement.json';

interface FileSnapshot {
  path: string;
  content: Buffer | null;
  mode: number;
}

interface MacOSLoginAcknowledgement extends LoginAcknowledgement {
  registrationChanged: boolean;
}

export interface MacOSDesktopAdapterOptions {
  appBundlePath: string;
  daemonAdapter: PlatformServiceAdapter;
  openPath?: string;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  acknowledgementPolls?: number;
  acknowledgementPollIntervalMs?: number;
}

function ensureAbsoluteDirectory(path: string): void {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('macOS app bundle path must be absolute');
  }
  assertNoSymlinkTraversal(path, 'macOS app bundle', path);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new Error('Build the macOS app before installing Pimpampum');
  }
}

function sourceFiles(root: string): Array<{ relativePath: string; content: Buffer; mode: number }> {
  const files: Array<{ relativePath: string; content: Buffer; mode: number }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('macOS app bundle must not contain symlinks');
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error('macOS app bundle may contain only regular files');
      const relativePath = relative(root, path);
      if (relativePath === INSTALLATION_CONFIGURATION) continue;
      files.push({
        relativePath,
        content: readFileSync(path),
        mode: relativePath === APP_EXECUTABLE ? 0o755 : lstatSync(path).mode & 0o777,
      });
    }
  };
  visit(root);
  if (!files.some((file) => file.relativePath === APP_EXECUTABLE)) {
    throw new Error('macOS app bundle is missing its executable');
  }
  if (!files.some((file) => file.relativePath === 'Contents/Info.plist')) {
    throw new Error('macOS app bundle is missing Info.plist');
  }
  return files;
}

function appRoot(context: ServiceAdapterContext): string {
  return join(context.homeDirectory, 'Applications', APP_NAME);
}

function legacyAppRoots(context: ServiceAdapterContext): string[] {
  return LEGACY_APP_NAMES.map((name) => join(context.homeDirectory, 'Applications', name));
}

function controlPath(context: ServiceAdapterContext, name: string): string {
  return join(context.dataDirectory, name);
}

function snapshot(path: string, trustedRoot: string): FileSnapshot {
  assertNoSymlinkTraversal(path, 'Login item control file', trustedRoot);
  if (!existsSync(path)) return { path, content: null, mode: 0o600 };
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Login item control path must be a regular file');
  }
  return { path, content: readFileSync(path), mode: metadata.mode & 0o777 };
}

function restoreSnapshots(snapshots: FileSnapshot[], trustedRoot: string): void {
  for (const item of snapshots) {
    if (item.content === null) rmSync(item.path, { force: true });
    else writePrivateFileAtomic(item.path, item.content, item.mode, trustedRoot);
  }
}

function readJsonObject(path: string, trustedRoot: string): Record<string, unknown> {
  assertNoSymlinkTraversal(path, 'Login item control file', trustedRoot);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Login item control path must be a regular file');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error('Invalid login item acknowledgement JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid login item acknowledgement');
  }
  return value as Record<string, unknown>;
}

function acknowledgement(path: string, trustedRoot: string): MacOSLoginAcknowledgement {
  const value = readJsonObject(path, trustedRoot);
  if (
    Object.keys(value).sort().join(',') !== 'createdAt,registrationChanged,requestId,status' ||
    typeof value.requestId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.registrationChanged !== 'boolean'
  ) {
    throw new Error('Invalid login item acknowledgement');
  }
  return {
    requestId: value.requestId,
    createdAt: value.createdAt,
    status: value.status,
    registrationChanged: value.registrationChanged,
  };
}

function integrationStatus(path: string, trustedRoot: string): ServiceIntegrationStatus {
  if (!existsSync(path)) return { loginItem: 'error' };
  const value = readJsonObject(path, trustedRoot);
  if (
    Object.keys(value).sort().join(',') !== 'schemaVersion,status,updatedAt' ||
    value.schemaVersion !== 1 ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt as string)) ||
    (value.status !== 'enabled' && value.status !== 'requiresApproval' && value.status !== 'error')
  ) {
    throw new Error('Invalid login item status');
  }
  return { loginItem: value.status };
}

function assertSuccessfulUnregistration(
  path: string,
  trustedRoot: string,
  startedAt: number,
  completedAt: number,
): LoginAcknowledgementStatus {
  if (!existsSync(path)) throw new Error('macOS login item did not acknowledge unregistration');
  const value = readJsonObject(path, trustedRoot);
  if (
    Object.keys(value).sort().join(',') !== 'createdAt,previousStatus,status' ||
    typeof value.createdAt !== 'string' ||
    (value.previousStatus !== 'enabled' &&
      value.previousStatus !== 'requiresApproval' &&
      value.previousStatus !== 'error') ||
    (value.status !== 'disabled' && value.status !== 'error')
  ) {
    throw new Error('Invalid login item unregistration acknowledgement');
  }
  const createdAt = Date.parse(value.createdAt);
  if (!Number.isFinite(createdAt) || createdAt < startedAt || createdAt > completedAt) {
    throw new Error('Stale login item unregistration acknowledgement');
  }
  if (value.status !== 'disabled') throw new Error('macOS login item unregistration failed');
  return value.previousStatus;
}

async function unregisterLoginItem(
  context: ServiceAdapterContext,
  openPath: string,
  installedApp: string,
  now: () => Date,
): Promise<LoginAcknowledgementStatus> {
  const acknowledgementPath = controlPath(context, UNREGISTRATION_ACKNOWLEDGEMENT_FILE);
  if (existsSync(acknowledgementPath)) {
    assertNoSymlinkTraversal(acknowledgementPath, 'Login item control file', context.dataDirectory);
    if (!lstatSync(acknowledgementPath).isFile()) {
      throw new Error('Login item control path must be a file');
    }
    rmSync(acknowledgementPath);
  }
  const startedAt = Math.floor(now().getTime() / 1000) * 1000;
  const unregister = await context.runCommand(openPath, [
    '-W',
    '-n',
    installedApp,
    '--args',
    '--unregister-login-item',
  ]);
  if (unregister.exitCode !== 0) {
    throw new Error(`Unable to unregister the macOS login item (${unregister.exitCode})`);
  }
  return assertSuccessfulUnregistration(
    acknowledgementPath,
    context.dataDirectory,
    startedAt,
    now().getTime(),
  );
}

function removeEmptyAppDirectories(root: string, artifacts: ServiceArtifact[]): void {
  const directories = new Set(
    artifacts
      .map((artifact) => dirname(artifact.path))
      .filter((path) => path === root || path.startsWith(`${root}${sep}`)),
  );
  directories.add(root);
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
    }
  }
}

function removeEmptyLegacyAppDirectories(root: string): void {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
  removeEmptyAppDirectories(
    root,
    [
      'Contents/Info.plist',
      'Contents/MacOS/PimpampumMenuBar',
      'Contents/Resources/placeholder',
    ].map((relativePath) => ({ path: join(root, relativePath), content: '', mode: 0o600 })),
  );
}

export function createMacOSDesktopAdapter(
  options: MacOSDesktopAdapterOptions,
): PlatformServiceAdapter {
  if (options.daemonAdapter.platform !== 'darwin') {
    throw new Error('macOS desktop adapter requires a Darwin daemon adapter');
  }
  const openPath = options.openPath ?? '/usr/bin/open';
  if (!isAbsolute(openPath) || openPath.includes('\0'))
    throw new Error('open path must be absolute');
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const acknowledgementPolls = options.acknowledgementPolls ?? 100;
  const acknowledgementPollIntervalMs = options.acknowledgementPollIntervalMs ?? 100;
  if (!Number.isInteger(acknowledgementPolls) || acknowledgementPolls < 1) {
    throw new Error('Acknowledgement poll count must be positive');
  }
  if (!Number.isInteger(acknowledgementPollIntervalMs) || acknowledgementPollIntervalMs < 1) {
    throw new Error('Acknowledgement poll interval must be positive');
  }

  const appArtifacts = (context: ServiceAdapterContext): ServiceArtifact[] => {
    ensureAbsoluteDirectory(options.appBundlePath);
    const destination = appRoot(context);
    const files: ServiceArtifact[] = sourceFiles(options.appBundlePath).map((file) => ({
      path: join(destination, file.relativePath),
      content: file.content,
      mode: file.mode,
    }));
    files.push({
      path: join(destination, INSTALLATION_CONFIGURATION),
      content: `${JSON.stringify({ dataDirectory: context.dataDirectory }, null, 2)}\n`,
      mode: 0o644,
    });
    return files;
  };

  const registerLoginItem = async (
    context: ServiceAdapterContext,
  ): Promise<ServiceIntegrationStatus | undefined> => {
    const requestPath = controlPath(context, REQUEST_FILE);
    const acknowledgementPath = controlPath(context, ACKNOWLEDGEMENT_FILE);
    const statusPath = controlPath(context, STATUS_FILE);
    const snapshots = [requestPath, acknowledgementPath, statusPath].map((path) =>
      snapshot(path, context.dataDirectory),
    );
    const requestedAt = new Date(Math.floor(now().getTime() / 1000) * 1000);
    const request: LoginRequest = {
      requestId: randomUUID(),
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + 30_000).toISOString(),
    };
    let registrationChanged = false;
    try {
      rmSync(acknowledgementPath, { force: true });
      writePrivateFileAtomic(
        requestPath,
        `${JSON.stringify(request, null, 2)}\n`,
        0o600,
        context.dataDirectory,
      );
      const installedApp = appRoot(context);
      const launch = await context.runCommand(openPath, [
        '-n',
        installedApp,
        '--args',
        '--register-login-item',
        request.requestId,
      ]);
      if (launch.exitCode !== 0) {
        throw new Error(
          `Unable to launch the macOS login registration helper (${launch.exitCode})`,
        );
      }
      let accepted: { requestId: string; status: LoginAcknowledgementStatus } | null = null;
      for (let attempt = 0; attempt < acknowledgementPolls; attempt += 1) {
        if (existsSync(acknowledgementPath)) {
          const received = acknowledgement(acknowledgementPath, context.dataDirectory);
          accepted = acceptLoginAcknowledgement(request, received, now().toISOString());
          registrationChanged = received.registrationChanged;
          break;
        }
        await sleep(acknowledgementPollIntervalMs);
      }
      if (!accepted) throw new Error('Timed out waiting for macOS login item registration');
      writePrivateFileAtomic(
        statusPath,
        `${JSON.stringify(
          { schemaVersion: 1, status: accepted.status, updatedAt: now().toISOString() },
          null,
          2,
        )}\n`,
        0o600,
        context.dataDirectory,
      );
      if (accepted.status === 'error') throw new Error('macOS login item registration failed');
      const open = await context.runCommand(openPath, [installedApp]);
      if (open.exitCode !== 0)
        throw new Error(`Unable to open the macOS menu app (${open.exitCode})`);
      return { loginItem: accepted.status };
    } catch (error) {
      const rollbackErrors: unknown[] = [error];
      if (registrationChanged) {
        try {
          await unregisterLoginItem(context, openPath, appRoot(context), now);
        } catch (unregisterError) {
          rollbackErrors.push(unregisterError);
        }
      }
      try {
        restoreSnapshots(snapshots, context.dataDirectory);
      } catch (restoreError) {
        rollbackErrors.push(restoreError);
      }
      if (rollbackErrors.length > 1) {
        throw new AggregateError(rollbackErrors, 'macOS login registration and rollback failed');
      }
      throw error;
    }
  };
  let pendingLoginRollbackState: { previousStatus: LoginAcknowledgementStatus | null } | null =
    null;

  return {
    id: 'launchd-macos-app',
    platform: 'darwin',
    artifacts(context) {
      return [...options.daemonAdapter.artifacts(context), ...appArtifacts(context)];
    },
    ownedArtifactRoots(context) {
      return [appRoot(context), ...legacyAppRoots(context)];
    },
    async activate(context, artifacts) {
      await options.daemonAdapter.activate(context, artifacts);
    },
    async afterInstall(context) {
      const integration = await registerLoginItem(context);
      for (const legacyRoot of legacyAppRoots(context)) removeEmptyLegacyAppDirectories(legacyRoot);
      return integration;
    },
    async deactivate(context, artifacts) {
      const installedApp = appRoot(context);
      const previousStatus = await unregisterLoginItem(context, openPath, installedApp, now);
      if (pendingLoginRollbackState) pendingLoginRollbackState.previousStatus = previousStatus;
      await options.daemonAdapter.deactivate(context, artifacts);
    },
    async prepareDeactivationRollback(context, artifacts) {
      const daemonRollback = await options.daemonAdapter.prepareDeactivationRollback?.(
        context,
        artifacts,
      );
      const priorLoginItem = integrationStatus(
        controlPath(context, STATUS_FILE),
        context.dataDirectory,
      ).loginItem;
      const loginRollbackState: { previousStatus: LoginAcknowledgementStatus | null } = {
        previousStatus:
          priorLoginItem === 'enabled' || priorLoginItem === 'requiresApproval'
            ? priorLoginItem
            : null,
      };
      pendingLoginRollbackState = loginRollbackState;
      return async () => {
        const errors: unknown[] = [];
        try {
          if (daemonRollback) await daemonRollback();
          else await options.daemonAdapter.activate(context, artifacts);
        } catch (error) {
          errors.push(error);
        }
        if (
          loginRollbackState.previousStatus === 'enabled' ||
          loginRollbackState.previousStatus === 'requiresApproval'
        ) {
          try {
            const restored = await registerLoginItem(context);
            if (restored?.loginItem !== loginRollbackState.previousStatus) {
              throw new Error('macOS login item rollback did not restore its previous state');
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0)
          throw new AggregateError(errors, 'macOS deactivation rollback failed');
      };
    },
    async isRunning(context, artifacts) {
      return options.daemonAdapter.isRunning(context, artifacts);
    },
    async afterRollback(context, artifacts) {
      await options.daemonAdapter.afterRollback?.(context, artifacts);
      removeEmptyAppDirectories(appRoot(context), artifacts);
    },
    async rollbackActivation(context, artifacts) {
      await options.daemonAdapter.deactivate(context, artifacts);
    },
    async afterUninstall(context, artifacts) {
      for (const name of [
        REQUEST_FILE,
        ACKNOWLEDGEMENT_FILE,
        STATUS_FILE,
        UNREGISTRATION_ACKNOWLEDGEMENT_FILE,
      ]) {
        const path = controlPath(context, name);
        if (existsSync(path)) {
          assertNoSymlinkTraversal(path, 'Login item control file', context.dataDirectory);
          if (!lstatSync(path).isFile()) throw new Error('Login item control path must be a file');
          rmSync(path);
        }
      }
      removeEmptyAppDirectories(appRoot(context), artifacts);
    },
    async integrationStatus(context) {
      return integrationStatus(controlPath(context, STATUS_FILE), context.dataDirectory);
    },
  };
}
