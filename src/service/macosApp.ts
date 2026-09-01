import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
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
  ServiceUninstallOutcome,
} from './types.js';

const SYSTEM_APPLICATIONS = '/Applications';
const APP_NAME = 'Pimpampum.app';
const LEGACY_APP_NAMES = ['pim • pam • pum.app', 'PimpampumMenuBar.app'] as const;
const APP_EXECUTABLE = 'Contents/MacOS/PimpampumMenuBar';
const INSTALLATION_CONFIGURATION = 'Contents/Resources/installation.json';
const EMBEDDED_RUNTIME = 'Contents/Resources/PimpampumRuntime';
const REQUEST_FILE = 'login-registration-request.json';
const ACKNOWLEDGEMENT_FILE = 'login-registration-acknowledgement.json';
const STATUS_FILE = 'login-item-status.json';
const UNREGISTRATION_ACKNOWLEDGEMENT_FILE = 'login-unregistration-acknowledgement.json';
const APPLICATION_PATH_FILE = 'application-path.json';
/** Every control file the adapter keeps in the data directory. Uninstall removes them last. */
const CONTROL_FILES = [
  REQUEST_FILE,
  ACKNOWLEDGEMENT_FILE,
  STATUS_FILE,
  UNREGISTRATION_ACKNOWLEDGEMENT_FILE,
  APPLICATION_PATH_FILE,
] as const;
/** How long the helper app gets to answer a handshake. Registration requests carry it as `expiresAt`. */
const LOGIN_HANDSHAKE_WINDOW_MS = 30_000;
/** What the user must do when uninstall cannot reach the helper that owns the login item. */
export const LOGIN_ITEM_MANUAL_INSTRUCTION = 'Remove Pimpampum from System Settings › Login Items';

interface FileSnapshot {
  path: string;
  content: Buffer | null;
  mode: number;
}

interface MacOSLoginAcknowledgement extends LoginAcknowledgement {
  registrationChanged: boolean;
}

/** Where the app lives once setup finishes, and whether Pimpampum put it there. */
export interface ApplicationLocation {
  path: string;
  managed: boolean;
}

interface HandshakeClock {
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
}

export interface MacOSDesktopAdapterOptions {
  appBundlePath: string;
  daemonAdapter: PlatformServiceAdapter;
  openPath?: string;
  pkillPath?: string;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  acknowledgementPollIntervalMs?: number;
}

/**
 * Path shape is always wrong when it is wrong, so it is checked on every operation. Presence is
 * checked separately: an installed CLI legitimately has no build tree, and only install needs one.
 */
function ensureBundlePathShape(path: string): void {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('macOS app bundle path must be absolute');
  }
}

function ensureAbsoluteDirectory(path: string): void {
  ensureBundlePathShape(path);
  assertNoSymlinkTraversal(path, 'macOS app bundle', path);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new Error('Build the macOS app before installing Pimpampum');
  }
}

function isDirectory(path: string): boolean {
  return existsSync(path) && lstatSync(path).isDirectory();
}

/** Quotes a path for `pkill -f`, whose pattern is an extended regular expression. */
function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceFiles(root: string): Array<{ relativePath: string; content: Buffer; mode: number }> {
  const files: Array<{ relativePath: string; content: Buffer; mode: number }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (entry.isSymbolicLink()) throw new Error('macOS app bundle must not contain symlinks');
      if (entry.isDirectory()) {
        // The private runtime is copied transactionally as a directory after the small app
        // artifacts land. Keeping its large native payload out of ServiceArtifact prevents the
        // service receipt and rollback snapshots from retaining hundreds of megabytes in memory.
        if (relativePath === EMBEDDED_RUNTIME) continue;
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error('macOS app bundle may contain only regular files');
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

interface RuntimeSourceTransaction {
  commit(): void;
  rollback(): void;
}

function copyRegularTree(source: string, destination: string): void {
  const sourceMetadata = lstatSync(source);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
    throw new Error('Embedded macOS runtime must be a regular directory');
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Embedded macOS runtime must not contain symlinks');
    if (entry.isDirectory()) {
      copyRegularTree(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) throw new Error('Embedded macOS runtime may contain only regular files');
    copyFileSync(sourcePath, destinationPath);
    chmodSync(destinationPath, lstatSync(sourcePath).mode & 0o777);
  }
}

function installEmbeddedRuntimeSource(
  sourceApp: string,
  installedApp: string,
): RuntimeSourceTransaction | null {
  const source = join(sourceApp, EMBEDDED_RUNTIME);
  if (!existsSync(source)) return null;
  const destination = join(installedApp, EMBEDDED_RUNTIME);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const suffix = randomUUID();
  const staging = join(parent, `.PimpampumRuntime.stage-${suffix}`);
  const backup = join(parent, `.PimpampumRuntime.backup-${suffix}`);
  let backedUp = false;
  try {
    copyRegularTree(source, staging);
    if (existsSync(destination)) {
      const current = lstatSync(destination);
      if (current.isSymbolicLink() || !current.isDirectory()) {
        throw new Error('Installed embedded runtime must be a regular directory');
      }
      renameSync(destination, backup);
      backedUp = true;
    }
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    /* v8 ignore next -- restoring the previous runtime needs `renameSync` to fail mid-transaction,
       which only a mocked filesystem can force; test/service-macos-runtime-rollback.test.ts proves
       the behaviour. */
    if (backedUp && !existsSync(destination)) renameSync(backup, destination);
    throw error;
  }
  return {
    commit() {
      rmSync(backup, { recursive: true, force: true });
    },
    rollback() {
      const current = lstatSync(destination);
      if (current.isSymbolicLink() || !current.isDirectory()) {
        throw new Error('Refusing to roll back an unsafe embedded runtime path');
      }
      rmSync(destination, { recursive: true });
      if (backedUp) renameSync(backup, destination);
    },
  };
}

function removeEmbeddedRuntimeSource(installedApp: string): void {
  const runtime = join(installedApp, EMBEDDED_RUNTIME);
  if (!existsSync(runtime)) return;
  const metadata = lstatSync(runtime);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Refusing to remove an unsafe embedded runtime path');
  }
  rmSync(runtime, { recursive: true });
}

const applicationPathSchema = z
  .string()
  .refine(
    (value) => isAbsolute(value) && !value.includes('\0'),
    'Application path must be absolute',
  );

/**
 * `application-path.json`. Schema 1 recorded only the path; schema 2 also says whether setup put
 * the bundle there. Swift reads the same file to find the copy it must relaunch.
 */
const applicationRecordSchema = z.union([
  z.strictObject({ schemaVersion: z.literal(1), path: applicationPathSchema }),
  z.strictObject({
    schemaVersion: z.literal(2),
    path: applicationPathSchema,
    managed: z.boolean(),
  }),
]);

const installationMarkerSchema = z.object({ dataDirectory: z.string() });

function managedApplicationPath(context: ServiceAdapterContext): string {
  return join(context.homeDirectory, 'Applications', APP_NAME);
}

function recordedApplicationLocation(context: ServiceAdapterContext): ApplicationLocation | null {
  const file = controlPath(context, APPLICATION_PATH_FILE);
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = readJsonObject(file, context.dataDirectory);
  } catch {
    return null;
  }
  const record = applicationRecordSchema.safeParse(value);
  if (!record.success) return null;
  const path = normalize(record.data.path);
  // Schema 1 predates `managed`. The only path it ever recorded for a copy setup made is the
  // managed one; anything else was an adopted bundle.
  const managed =
    record.data.schemaVersion === 2
      ? record.data.managed
      : path === managedApplicationPath(context);
  return { path, managed };
}

function recordApplicationLocation(
  context: ServiceAdapterContext,
  location: ApplicationLocation,
): void {
  writePrivateFileAtomic(
    controlPath(context, APPLICATION_PATH_FILE),
    `${JSON.stringify(
      { schemaVersion: 2, path: location.path, managed: location.managed },
      null,
      2,
    )}\n`,
    0o600,
    context.dataDirectory,
  );
}

/**
 * Only a managed install writes the installation marker, and it names the data directory that
 * wrote it. An adopted bundle never receives one, so the marker tells a managed copy installed
 * before the location record existed apart from a bundle the user placed at the same path.
 */
function carriesInstallationMarker(bundlePath: string, context: ServiceAdapterContext): boolean {
  const marker = join(bundlePath, INSTALLATION_CONFIGURATION);
  try {
    if (!existsSync(marker) || !lstatSync(marker).isFile()) return false;
    const parsed = installationMarkerSchema.safeParse(
      JSON.parse(readFileSync(marker, 'utf8')) as unknown,
    );
    return parsed.success && normalize(parsed.data.dataDirectory) === context.dataDirectory;
  } catch {
    return false;
  }
}

/**
 * Where the app lives once setup finishes, and whether Pimpampum put it there.
 *
 * The record written at install is the authority: an installed CLI later runs `status` and
 * `uninstall` with the managed copy as its only bundle, and the bundle's parent directory alone
 * cannot say who put it there. Without a record — the first install, or one that predates the
 * record — the parent directory decides.
 *
 * A bundle the user already placed in an Applications folder is the app. Copying it into a second
 * managed location leaves two menu-bar icons — the user's copy and the one macOS starts when the
 * login item is registered — and hides the real app from the user. In that case setup registers the
 * copy that is already there and owns no application files at all, so uninstalling leaves the app
 * for the user to drag to the Trash, exactly like any other macOS app.
 *
 * A bundle running from Downloads or a mounted image can vanish, so that one is still copied into
 * the managed location under the home directory.
 */
function applicationLocation(
  context: ServiceAdapterContext,
  sourceBundlePath: string,
): ApplicationLocation {
  const recorded = recordedApplicationLocation(context);
  if (recorded !== null) return recorded;
  const managedPath = managedApplicationPath(context);
  const source = normalize(sourceBundlePath);
  const applicationFolders = [SYSTEM_APPLICATIONS, join(context.homeDirectory, 'Applications')];
  if (applicationFolders.includes(dirname(source))) {
    if (source === managedPath && carriesInstallationMarker(source, context)) {
      return { path: managedPath, managed: true };
    }
    return { path: source, managed: false };
  }
  return { path: managedPath, managed: true };
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

/**
 * Waits for the helper app to write a control file. Bounded twice: by the wall-clock deadline the
 * handshake itself carries, and by the number of polls that window admits, so an injected clock
 * that never advances cannot spin forever.
 */
async function awaitControlFile(
  path: string,
  deadline: number,
  clock: HandshakeClock,
): Promise<boolean> {
  const maxPolls = Math.ceil(LOGIN_HANDSHAKE_WINDOW_MS / clock.pollIntervalMs) + 1;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    if (existsSync(path)) return true;
    if (clock.now().getTime() >= deadline) return false;
    await clock.sleep(clock.pollIntervalMs);
  }
  return existsSync(path);
}

/**
 * Asks the helper to unregister the login item. Resolves with the status it replaced, or `null`
 * when the helper never answered inside the handshake window.
 */
async function unregisterLoginItem(
  context: ServiceAdapterContext,
  openPath: string,
  installedApp: string,
  clock: HandshakeClock,
): Promise<LoginAcknowledgementStatus | null> {
  const acknowledgementPath = controlPath(context, UNREGISTRATION_ACKNOWLEDGEMENT_FILE);
  if (existsSync(acknowledgementPath)) {
    assertNoSymlinkTraversal(acknowledgementPath, 'Login item control file', context.dataDirectory);
    if (!lstatSync(acknowledgementPath).isFile()) {
      throw new Error('Login item control path must be a file');
    }
    rmSync(acknowledgementPath);
  }
  const startedAt = Math.floor(clock.now().getTime() / 1000) * 1000;
  const unregister = await context.runCommand(openPath, [
    '-n',
    installedApp,
    '--args',
    '--unregister-login-item',
  ]);
  if (unregister.exitCode !== 0) {
    throw new Error(`Unable to unregister the macOS login item (${unregister.exitCode})`);
  }
  // Wait for the helper's acknowledgement file rather than for the process, the way registration
  // already does. `open -W` waits on the bundle, and when setup adopted an app the user had already
  // placed in an Applications folder that bundle is also the running menu-bar app, so `-W` blocks
  // on the wrong instance and reports a failure for work that succeeded.
  const answered = await awaitControlFile(
    acknowledgementPath,
    startedAt + LOGIN_HANDSHAKE_WINDOW_MS,
    clock,
  );
  if (!answered) return null;
  return assertSuccessfulUnregistration(
    acknowledgementPath,
    context.dataDirectory,
    startedAt,
    clock.now().getTime(),
  );
}

/** Unregistration inside a compensation path, where an unanswered helper is a failure to report. */
async function confirmUnregistration(
  context: ServiceAdapterContext,
  openPath: string,
  installedApp: string,
  clock: HandshakeClock,
): Promise<LoginAcknowledgementStatus> {
  const previous = await unregisterLoginItem(context, openPath, installedApp, clock);
  if (previous === null) throw new Error('macOS login item did not acknowledge unregistration');
  return previous;
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
  const pkillPath = options.pkillPath ?? '/usr/bin/pkill';
  if (!isAbsolute(pkillPath) || pkillPath.includes('\0'))
    throw new Error('pkill path must be absolute');
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.acknowledgementPollIntervalMs ?? 100;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error('Acknowledgement poll interval must be positive');
  }
  const clock: HandshakeClock = {
    now,
    sleep:
      options.sleep ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    pollIntervalMs,
  };

  const bundleIsPresent = (): boolean => {
    ensureBundlePathShape(options.appBundlePath);
    return isDirectory(options.appBundlePath);
  };

  const appArtifacts = (context: ServiceAdapterContext): ServiceArtifact[] => {
    // Status and uninstall run from the installed runtime, which carries no build tree. The bundle
    // is already covered by `ownedArtifactRoots`, so an empty source plan still removes every file.
    // Install is the one operation that genuinely needs the source, and `preflight` rejects it.
    if (!bundleIsPresent()) return [];
    const location = applicationLocation(context, options.appBundlePath);
    // The app is already where it belongs: setup owns no file inside it, not even the installation
    // marker, which would land outside the home directory. The app falls back to `~/.pimpampum`.
    if (!location.managed) return [];
    ensureAbsoluteDirectory(options.appBundlePath);
    const destination = location.path;
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
  ): Promise<ServiceIntegrationStatus> => {
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
      expiresAt: new Date(requestedAt.getTime() + LOGIN_HANDSHAKE_WINDOW_MS).toISOString(),
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
      const installedApp = applicationLocation(context, options.appBundlePath).path;
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
      let status: LoginAcknowledgementStatus;
      if (await awaitControlFile(acknowledgementPath, Date.parse(request.expiresAt), clock)) {
        const received = acknowledgement(acknowledgementPath, context.dataDirectory);
        status = acceptLoginAcknowledgement(request, received, now().toISOString()).status;
        registrationChanged = received.registrationChanged;
      } else {
        // A helper that never answers inside the window the request itself carries is a
        // recoverable login-item state, exactly like a rejection: record it, keep the install, and
        // let the menu app's notice offer the retry. Tearing down a working daemon over it would
        // leave the user with nothing.
        status = 'error';
      }
      writePrivateFileAtomic(
        statusPath,
        `${JSON.stringify({ schemaVersion: 1, status, updatedAt: now().toISOString() }, null, 2)}\n`,
        0o600,
        context.dataDirectory,
      );
      // A rejected registration is a recoverable state, not an installation failure: the status
      // file above records it, the menu app shows a notice with a retry, and the receipt carries
      // it as `loginItem: 'error'`. Aborting here would leave a working daemon uninstalled over a
      // Login Items policy the user can only fix from System Settings anyway.
      // The registration helper exits immediately. Force a fresh instance at the exact stable
      // path so LaunchServices cannot reuse that terminating process or another bundle with the
      // same identifier (for example the copy the user launched from Downloads).
      const open = await context.runCommand(openPath, ['-n', installedApp]);
      if (open.exitCode !== 0)
        throw new Error(`Unable to open the macOS menu app (${open.exitCode})`);
      return { loginItem: status };
    } catch (error) {
      const rollbackErrors: unknown[] = [error];
      if (registrationChanged) {
        try {
          await confirmUnregistration(
            context,
            openPath,
            applicationLocation(context, options.appBundlePath).path,
            clock,
          );
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
  // What `deactivate` had to leave to the user; `afterUninstall` reports it once the files are gone.
  let pendingManualInstructions: string[] = [];

  return {
    id: 'launchd-macos-app',
    platform: 'darwin',
    artifacts(context) {
      return [...options.daemonAdapter.artifacts(context), ...appArtifacts(context)];
    },
    canPlanArtifacts() {
      // The app bundle ships in the build tree. Once installed, the CLI runs from the packaged
      // runtime, where that path does not exist and the plan omits every app file.
      return bundleIsPresent();
    },
    async preflight(_context, _artifacts, operation) {
      if (operation === 'install') ensureAbsoluteDirectory(options.appBundlePath);
    },
    ownedArtifactRoots(context) {
      // Only claim the app directory when setup put it there. A copy the user placed in an
      // Applications folder is theirs, and uninstalling must not delete it — nor could it, since
      // owned roots must stay inside the home directory.
      const location = applicationLocation(context, options.appBundlePath);
      return location.managed
        ? [location.path, ...legacyAppRoots(context)]
        : legacyAppRoots(context);
    },
    async activate(context, artifacts) {
      await options.daemonAdapter.activate(context, artifacts);
    },
    async afterInstall(context) {
      const location = applicationLocation(context, options.appBundlePath);
      // Record it before registering, so a later uninstall run from the installed CLI knows which
      // bundle to ask and whether it owns it, instead of guessing from the managed path. A failed
      // install puts the previous record back.
      const recordSnapshot = snapshot(
        controlPath(context, APPLICATION_PATH_FILE),
        context.dataDirectory,
      );
      recordApplicationLocation(context, location);
      // Nothing to copy when the app is already in place — an adopted bundle, or the managed copy
      // itself running setup again from the installed CLI: its embedded runtime is the source.
      const runtime =
        location.managed && normalize(options.appBundlePath) !== location.path
          ? installEmbeddedRuntimeSource(options.appBundlePath, location.path)
          : null;
      let registered = false;
      try {
        const integration = await registerLoginItem(context);
        registered = true;
        runtime?.commit();
        for (const legacyRoot of legacyAppRoots(context))
          removeEmptyLegacyAppDirectories(legacyRoot);
        return integration;
      } catch (error) {
        const errors: unknown[] = [error];
        if (registered) {
          try {
            await confirmUnregistration(context, openPath, location.path, clock);
          } catch (unregisterError) {
            errors.push(unregisterError);
          }
        }
        try {
          runtime?.rollback();
        } catch (rollbackError) {
          errors.push(rollbackError);
        }
        try {
          restoreSnapshots([recordSnapshot], context.dataDirectory);
        } catch (restoreError) {
          errors.push(restoreError);
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, 'macOS app runtime bootstrap rollback failed');
        }
        throw error;
      }
    },
    async deactivate(context, artifacts) {
      const location = applicationLocation(context, options.appBundlePath);
      const manualInstructions: string[] = [];
      pendingManualInstructions = manualInstructions;
      if (isDirectory(location.path)) {
        const previousStatus = await unregisterLoginItem(context, openPath, location.path, clock);
        if (previousStatus === null) {
          // The helper never confirmed. The login item may or may not be gone; the user can check
          // System Settings, and the uninstall must not stall on it.
          manualInstructions.push(LOGIN_ITEM_MANUAL_INSTRUCTION);
        } else if (pendingLoginRollbackState) {
          pendingLoginRollbackState.previousStatus = previousStatus;
        }
      } else {
        // The user already trashed the app, so there is no helper left to unregister the login
        // item. Nothing changed, so a rollback must not try to register it again either.
        if (pendingLoginRollbackState) pendingLoginRollbackState.previousStatus = null;
        manualInstructions.push(LOGIN_ITEM_MANUAL_INSTRUCTION);
      }
      await options.daemonAdapter.deactivate(context, artifacts);
      // Quit the menu app this installation launched. The Swift side only terminates running
      // instances after a successful SMAppService unregistration, which never happens when the
      // registration was rejected (hosted CI, or a Login Items policy), so uninstall must do it.
      // Last step on purpose: a failure before this point rolls back with the app still open.
      const stopped = await context.runCommand(pkillPath, [
        '-TERM',
        '-f',
        regexLiteral(join(location.path, APP_EXECUTABLE)),
      ]);
      // pkill: 0 = signalled, 1 = no matching process.
      if (stopped.exitCode !== 0 && stopped.exitCode !== 1) {
        throw new Error(`Unable to stop the macOS menu app (${stopped.exitCode})`);
      }
    },
    async prepareDeactivationRollback(context, artifacts) {
      const daemonRollback = await options.daemonAdapter.prepareDeactivationRollback?.(
        context,
        artifacts,
      );
      // Uninstall deletes every control file, and re-registering the login item afterwards needs
      // the record to know which bundle to ask. Bytes and modes come back exactly as they were.
      const controlSnapshots = CONTROL_FILES.map((name) =>
        snapshot(controlPath(context, name), context.dataDirectory),
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
        try {
          restoreSnapshots(controlSnapshots, context.dataDirectory);
        } catch (error) {
          errors.push(error);
        }
        if (
          loginRollbackState.previousStatus === 'enabled' ||
          loginRollbackState.previousStatus === 'requiresApproval'
        ) {
          try {
            const restored = await registerLoginItem(context);
            if (restored.loginItem !== loginRollbackState.previousStatus) {
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
      const location = applicationLocation(context, options.appBundlePath);
      if (location.managed) removeEmptyAppDirectories(location.path, artifacts);
    },
    async rollbackActivation(context, artifacts) {
      await options.daemonAdapter.deactivate(context, artifacts);
    },
    async afterUninstall(context, artifacts): Promise<ServiceUninstallOutcome | undefined> {
      const location = applicationLocation(context, options.appBundlePath);
      const manualInstructions = pendingManualInstructions;
      pendingManualInstructions = [];
      // An adopted bundle is the user's app: its embedded runtime and its directories stay, exactly
      // as they were before setup registered it.
      if (location.managed) {
        removeEmbeddedRuntimeSource(location.path);
        removeEmptyAppDirectories(location.path, artifacts);
      }
      // Last on purpose: a failure above leaves the record that names the bundle for the retry,
      // and the rollback prepared earlier restores whatever this loop already removed.
      for (const name of CONTROL_FILES) {
        const path = controlPath(context, name);
        if (existsSync(path)) {
          assertNoSymlinkTraversal(path, 'Login item control file', context.dataDirectory);
          if (!lstatSync(path).isFile()) throw new Error('Login item control path must be a file');
          rmSync(path);
        }
      }
      return manualInstructions.length > 0 ? { manualInstructions } : undefined;
    },
    async integrationStatus(context) {
      return integrationStatus(controlPath(context, STATUS_FILE), context.dataDirectory);
    },
  };
}
