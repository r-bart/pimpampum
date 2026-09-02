import { chmodSync, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { collectFailures, runCompensation } from '../aggregateRollback.js';
import { writePrivateFileAtomic } from '../fsAtomic.js';
import { assertNoSymlinkTraversal } from '../fsGuards.js';
import { createSetupLifecycleLock } from '../lifecycleLock.js';
import { createLaunchdAdapter } from './launchd.js';
import { restoreServiceLogs, rotateServiceLogs, snapshotServiceLogs } from './logs.js';
import {
  installReceiptPath,
  installationKey,
  readInstallReceipt,
  receiptArtifacts,
  sha256,
  writeInstallReceipt,
} from './receipt.js';
import { createSystemdAdapter } from './systemd.js';
import type {
  InstallReceipt,
  InstallResult,
  PlatformServiceAdapter,
  PlatformServiceManagerInput,
  PreparedServiceUninstall,
  ReceiptArtifact,
  ServiceAdapterContext,
  ServiceArtifact,
  ServiceArtifactRef,
  ServiceManager,
  ServiceStatus,
  SupportedServicePlatform,
  UninstallResult,
} from './types.js';

type ArtifactSnapshot =
  | { path: string; trustedRoot: string; existed: false }
  | { path: string; trustedRoot: string; existed: true; content: Buffer; mode: number };

/**
 * A read-only `status` must not fail because an install is mid-flight: it waits this long for the
 * shared lifecycle lock before reporting a typed conflict. Mutations keep the lock's default wait.
 */
const STATUS_LOCK_WAIT_MILLISECONDS = 5_000;

async function repairRegistration(
  adapter: PlatformServiceAdapter,
  context: ServiceAdapterContext,
  artifacts: ServiceArtifact[],
): Promise<void> {
  try {
    await adapter.activate(context, artifacts);
  } catch (activationError) {
    await runCompensation(
      activationError,
      adapter.afterRollback ? [() => adapter.afterRollback!(context, artifacts)] : [],
      'Service registration repair and rollback failed',
    );
  }
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes('\0'))
    throw new Error(`${label} must be an absolute path`);
  return normalize(value);
}

function safeExistingDirectory(path: string, label: string): string {
  const resolved = absolutePath(path, label);
  assertNoSymlinkTraversal(resolved, label, resolved);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
    throw new Error(`${label} must be an existing directory`);
  }
  return resolved;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

function supportedPlatform(value: NodeJS.Platform): SupportedServicePlatform | null {
  return value === 'darwin' || value === 'linux' ? value : null;
}

function requireAdapter(
  input: PlatformServiceManagerInput,
  receiptAdapterId?: string,
): PlatformServiceAdapter {
  const platform = supportedPlatform(input.platform);
  if (!platform) throw new Error(`Unsupported service platform: ${input.platform}`);
  const configured = input.adapters?.[platform];
  const defaultAdapter =
    configured ?? (platform === 'darwin' ? createLaunchdAdapter() : createSystemdAdapter());
  if (receiptAdapterId) {
    const receiptAdapter = [defaultAdapter, ...Object.values(input.receiptAdapters ?? {})].find(
      (candidate) => candidate?.id === receiptAdapterId,
    );
    if (!receiptAdapter) {
      throw new Error(
        `Installation receipt does not match an available platform adapter; installed service adapter ${receiptAdapterId} is unavailable, so restore its required platform commands and retry`,
      );
    }
    if (receiptAdapter.platform !== platform) {
      throw new Error('Service adapter platform mismatch');
    }
    return receiptAdapter;
  }
  if (configured) {
    if (configured.platform !== platform) throw new Error('Service adapter platform mismatch');
    return configured;
  }
  return defaultAdapter;
}

function requireReceiptAdapter(
  input: PlatformServiceManagerInput,
  receipt: InstallReceipt,
): PlatformServiceAdapter {
  const platform = supportedPlatform(input.platform);
  if (receipt.platform !== platform) {
    throw new Error('Installation receipt does not match the current platform');
  }
  return requireAdapter(input, receipt.adapter);
}

function adapterForInstall(
  input: PlatformServiceManagerInput,
  existing: InstallReceipt | null,
  defaultAdapter: PlatformServiceAdapter,
): PlatformServiceAdapter {
  if (existing === null) return defaultAdapter;
  const receiptAdapter = requireReceiptAdapter(input, existing);
  const legacyRuntime =
    existing.packagedRuntime === undefined && existing.updateProvider !== 'packaged-release';
  return input.packagedRuntime !== undefined && legacyRuntime ? defaultAdapter : receiptAdapter;
}

function adapterContext(input: PlatformServiceManagerInput): ServiceAdapterContext {
  const dataDirectory = safeExistingDirectory(input.dataDirectory, 'Data directory');
  const host = input.host ?? '127.0.0.1';
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!loopbackHosts.has(host)) throw new Error('Service host must be loopback-only');
  const port = input.port ?? 7337;
  if (!Number.isInteger(port)) throw new Error('Service port must be an integer');
  if (port < 1 || port > 65_535) throw new Error('Service port must be between 1 and 65535');
  const logDirectory = absolutePath(
    input.logDirectory ?? join(dataDirectory, 'logs'),
    'Log directory',
  );
  if (!isPathInside(dataDirectory, logDirectory)) {
    throw new Error('Log directory must be inside the data directory');
  }
  let packagedRuntime: ServiceAdapterContext['packagedRuntime'];
  if (input.packagedRuntime) {
    const runtimeDirectory = absolutePath(
      input.packagedRuntime.runtimeDirectory,
      'Packaged runtime directory',
    );
    if (input.packagedRuntime.version !== input.version) {
      throw new Error('Packaged runtime version must match the service version');
    }
    const targetPlatform = input.packagedRuntime.target.split('-')[0];
    if (targetPlatform !== input.platform) {
      throw new Error('Packaged runtime target must match the service platform');
    }
    if (
      !isPathInside(runtimeDirectory, absolutePath(input.nodePath, 'Node executable')) ||
      !isPathInside(runtimeDirectory, absolutePath(input.cliPath, 'CLI path'))
    ) {
      throw new Error('Packaged runtime executable paths must remain inside the runtime directory');
    }
    assertNoSymlinkTraversal(runtimeDirectory, 'Packaged runtime directory', runtimeDirectory);
    packagedRuntime = { ...input.packagedRuntime, runtimeDirectory };
  }
  return {
    homeDirectory: safeExistingDirectory(input.homeDirectory, 'Home directory'),
    dataDirectory,
    nodePath: absolutePath(input.nodePath, 'Node executable'),
    cliPath: absolutePath(input.cliPath, 'CLI path'),
    version: input.version,
    host,
    port,
    logDirectory,
    runCommand: input.runCommand,
    ...(packagedRuntime ? { packagedRuntime } : {}),
  };
}

function validateArtifacts(context: ServiceAdapterContext, artifacts: ServiceArtifactRef[]): void {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    artifact.path = absolutePath(artifact.path, 'Service artifact');
    if (!isPathInside(context.homeDirectory, artifact.path)) {
      throw new Error('Service artifact must be inside the home directory');
    }
    if (
      context.packagedRuntime &&
      (artifact.path === context.packagedRuntime.runtimeDirectory ||
        isPathInside(context.packagedRuntime.runtimeDirectory, artifact.path))
    ) {
      throw new Error(
        'Runtime payload is owned by the runtime installer and cannot be a service artifact',
      );
    }
    assertNoSymlinkTraversal(artifact.path, 'Service artifact', context.homeDirectory);
    if (seen.has(artifact.path)) throw new Error('Service adapter returned a duplicate artifact');
    if (!Number.isInteger(artifact.mode) || artifact.mode < 0 || artifact.mode > 0o777) {
      throw new Error('Service artifact mode is invalid');
    }
    seen.add(artifact.path);
  }
  if (artifacts.length === 0) throw new Error('Service adapter returned no artifacts');
}

async function verifyPostActivation(
  input: PlatformServiceManagerInput,
  context: ServiceAdapterContext,
  receiptPath: string,
  expectedReceipt: InstallReceipt,
  previousReceipt: InstallReceipt | null,
): Promise<void> {
  if (!input.postActivationVerifier) return;
  const activatedReceipt = readInstallReceipt(receiptPath, context.dataDirectory);
  if (
    !activatedReceipt ||
    activatedReceipt.installationKey !== expectedReceipt.installationKey ||
    activatedReceipt.version !== context.version
  ) {
    throw new Error('Activated service receipt does not match the expected version');
  }
  await input.postActivationVerifier({
    context,
    receipt: activatedReceipt,
    previousReceipt,
    reconciled: previousReceipt !== null,
    ...(context.packagedRuntime ? { packagedRuntime: context.packagedRuntime } : {}),
  });
}

function validateOwnedArtifactRoots(
  adapter: PlatformServiceAdapter,
  context: ServiceAdapterContext,
): string[] {
  const roots = adapter.ownedArtifactRoots?.(context) ?? [];
  const normalized = roots.map((root) => absolutePath(root, 'Owned artifact root'));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Service adapter returned a duplicate owned artifact root');
  }
  for (const root of normalized) {
    if (!isPathInside(context.homeDirectory, root)) {
      throw new Error('Owned artifact root must be inside the home directory');
    }
    assertNoSymlinkTraversal(root, 'Owned artifact root', context.homeDirectory);
  }
  return normalized;
}

function pathIsAdapterOwned(
  path: string,
  allowedPaths: Set<string>,
  ownedRoots: string[],
): boolean {
  return allowedPaths.has(path) || ownedRoots.some((root) => isPathInside(root, path));
}

function snapshotArtifact(path: string, trustedRoot: string): ArtifactSnapshot {
  assertNoSymlinkTraversal(path, 'Service artifact snapshot', trustedRoot);
  if (!existsSync(path)) return { path, trustedRoot, existed: false };
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Service artifact target is not a regular file: ${path}`);
  }
  return {
    path,
    trustedRoot,
    existed: true,
    content: readFileSync(path),
    mode: metadata.mode & 0o777,
  };
}

/**
 * Service artifacts live under the home directory in trees the adapter owns (LaunchAgents, the
 * systemd user directory, the Omarchy plugin checkout). A parent that does not exist yet, or that
 * `omarchy plugin remove` took away before a rollback, is created world-readable like a checkout.
 */
function writeArtifact(path: string, content: string | Buffer, mode: number, root: string): void {
  writePrivateFileAtomic(path, content, {
    mode,
    directoryMode: 0o755,
    trustedRoot: root,
    label: 'Service artifact',
  });
}

function restoreArtifacts(snapshots: ArtifactSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.existed) {
      writeArtifact(snapshot.path, snapshot.content, snapshot.mode, snapshot.trustedRoot);
    } else {
      rmSync(snapshot.path, { force: true });
    }
  }
}

/**
 * Status answers "is the recorded installation still intact?". The receipt already names every
 * owned path, mode, and digest, so verification reads the installed files and never the source the
 * adapter would plan from. An installed CLI runs from the packaged runtime and has no build tree:
 * re-planning there throws, and on macOS it would also read the whole app bundle only to discard
 * every byte, because the digest compared below is always taken from disk.
 */
function receiptMatchesDisk(receipt: InstallReceipt): boolean {
  return receipt.artifacts.every((expected) => {
    if (!existsSync(expected.path)) return false;
    const metadata = lstatSync(expected.path);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (metadata.mode & 0o777) === expected.mode &&
      sha256(readFileSync(expected.path)) === expected.sha256
    );
  });
}

function artifactSetIsCurrent(receipt: InstallReceipt, artifacts: ServiceArtifactRef[]): boolean {
  if (receipt.artifacts.length !== artifacts.length) return false;
  return artifacts.every((artifact, index) => {
    const expected = receipt.artifacts[index]!;
    if (expected.path !== artifact.path || !existsSync(artifact.path)) return false;
    const metadata = lstatSync(artifact.path);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (metadata.mode & 0o777) === expected.mode &&
      sha256(readFileSync(artifact.path)) === expected.sha256
    );
  });
}

function validateOwnedArtifacts(
  context: ServiceAdapterContext,
  receipt: InstallReceipt,
  plannedArtifacts: ServiceArtifact[],
  ownedRoots: string[],
): ServiceArtifact[] {
  const allowedPaths = new Set(plannedArtifacts.map((artifact) => artifact.path));
  const receiptPaths = new Set(receipt.artifacts.map((artifact) => normalize(artifact.path)));
  if (receiptPaths.size !== receipt.artifacts.length)
    throw new Error('Receipt artifact set contains duplicate paths');
  const artifacts = receipt.artifacts.map((artifact) => {
    const path = absolutePath(artifact.path, 'Receipt artifact');
    if (!isPathInside(context.homeDirectory, path)) {
      throw new Error('Receipt contains an artifact outside the home directory');
    }
    assertNoSymlinkTraversal(path, 'Receipt artifact', context.homeDirectory);
    if (!pathIsAdapterOwned(path, allowedPaths, ownedRoots)) {
      throw new Error('Receipt artifact is not owned by the platform adapter');
    }
    return { path, content: Buffer.alloc(0), mode: artifact.mode };
  });
  if ([...allowedPaths].some((path) => !receiptPaths.has(path))) {
    throw new Error('Receipt artifact set does not contain every current adapter artifact');
  }
  return artifacts;
}

function assertOwnedBytes(receipt: InstallReceipt, artifacts: ServiceArtifact[]): void {
  for (const [index, artifact] of artifacts.entries()) {
    if (!existsSync(artifact.path)) continue;
    const metadata = lstatSync(artifact.path);
    const expected = receipt.artifacts[index]!;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      sha256(readFileSync(artifact.path)) !== expected.sha256
    ) {
      throw new Error(`Refusing to remove modified service artifact: ${artifact.path}`);
    }
  }
}

function staleOwnedArtifacts(
  context: ServiceAdapterContext,
  receipt: InstallReceipt | null,
  plannedArtifacts: ServiceArtifact[],
  ownedRoots: string[],
): ServiceArtifact[] {
  if (!receipt) return [];
  const plannedPaths = new Set(plannedArtifacts.map((artifact) => artifact.path));
  return receipt.artifacts
    .filter((artifact) => !plannedPaths.has(normalize(artifact.path)))
    .map((artifact) => {
      const path = absolutePath(artifact.path, 'Stale receipt artifact');
      if (!isPathInside(context.homeDirectory, path)) {
        throw new Error('Stale receipt artifact must be inside the home directory');
      }
      assertNoSymlinkTraversal(path, 'Stale receipt artifact', context.homeDirectory);
      if (!ownedRoots.some((root) => isPathInside(root, path))) {
        throw new Error('Stale receipt artifact is not inside an adapter-owned root');
      }
      if (!existsSync(path)) return { path, content: Buffer.alloc(0), mode: artifact.mode };
      const metadata = lstatSync(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        sha256(readFileSync(path)) !== artifact.sha256
      ) {
        throw new Error(`Refusing to replace modified stale service artifact: ${path}`);
      }
      return { path, content: Buffer.alloc(0), mode: artifact.mode };
    });
}

function repairMissingArtifacts(
  context: ServiceAdapterContext,
  receipt: InstallReceipt,
  plannedArtifacts: ServiceArtifact[],
): void {
  const plannedByPath = new Map(plannedArtifacts.map((artifact) => [artifact.path, artifact]));
  for (const expected of receipt.artifacts) {
    const path = normalize(expected.path);
    if (existsSync(path)) continue;
    const planned = plannedByPath.get(path);
    if (!planned) continue;
    if (sha256(planned.content) !== expected.sha256 || planned.mode !== expected.mode) {
      throw new Error(`Cannot repair missing service artifact from this package: ${path}`);
    }
    writeArtifact(path, planned.content, planned.mode, context.homeDirectory);
  }
}

/** Everything one install run knows once planning and preflight succeeded. */
interface InstallSession {
  input: PlatformServiceManagerInput;
  context: ServiceAdapterContext;
  adapter: PlatformServiceAdapter;
  artifacts: ServiceArtifact[];
  existing: InstallReceipt | null;
  receiptPath: string;
  ownedRoots: string[];
  ownedArtifacts: ReceiptArtifact[];
  key: string;
}

/**
 * The files an install or a reconcile may touch, captured before the first mutation. Restoring
 * puts the artifact bytes and the receipt back in reverse order, then the rotated logs; each is
 * its own compensation step so a failure in one never skips the other.
 */
interface Transaction {
  restoreFiles(): void;
  restoreLogs(): void;
}

function beginTransaction(
  context: ServiceAdapterContext,
  receiptPath: string,
  paths: string[],
): Transaction {
  const snapshots = paths.map((path) => snapshotArtifact(path, context.homeDirectory));
  const receiptSnapshot = snapshotArtifact(receiptPath, context.dataDirectory);
  const logsSnapshot = snapshotServiceLogs(context.logDirectory, 5, context.dataDirectory);
  return {
    restoreFiles: () => restoreArtifacts([...snapshots, receiptSnapshot]),
    restoreLogs: () => restoreServiceLogs(logsSnapshot),
  };
}

function plannedReceipt(session: InstallSession): InstallReceipt {
  const { context, adapter } = session;
  return {
    schemaVersion: 1,
    adapter: adapter.id,
    platform: adapter.platform,
    version: context.version,
    installationKey: session.key,
    installedAt: new Date().toISOString(),
    nodePath: context.nodePath,
    cliPath: context.cliPath,
    dataDirectory: context.dataDirectory,
    baseUrl: `http://${context.host === '::1' ? '[::1]' : context.host}:${context.port}`,
    logDirectory: context.logDirectory,
    artifacts: session.ownedArtifacts,
    ...(context.packagedRuntime
      ? {
          updateProvider: 'packaged-release' as const,
          packagedRuntime: context.packagedRuntime,
        }
      : {}),
  };
}

/**
 * The receipt already describes exactly what this build would write: keep the files, make sure
 * the registration is alive, and — when a verifier is configured — prove the service answers
 * before reporting success, undoing any repair when it does not.
 */
async function reconcileExisting(
  session: InstallSession,
  existing: InstallReceipt,
): Promise<InstallResult> {
  const { input, context, adapter, artifacts, receiptPath } = session;
  chmodSync(receiptPath, 0o600);
  const finish = async (): Promise<InstallResult> => ({
    installed: true,
    reconciled: true,
    receiptPath,
    ...(await adapter.afterInstall?.(context, artifacts)),
  });
  if (!input.postActivationVerifier) {
    if (!(await adapter.isRunning(context, artifacts))) {
      await repairRegistration(adapter, context, artifacts);
    }
    return finish();
  }
  const runningBefore = await adapter.isRunning(context, artifacts);
  const transaction = beginTransaction(
    context,
    receiptPath,
    artifacts.map((artifact) => artifact.path),
  );
  const rollbackRegistration = runningBefore
    ? undefined
    : await adapter.prepareDeactivationRollback?.(context, artifacts);
  const repairIfStopped = async (): Promise<boolean> => {
    if (runningBefore) return false;
    await repairRegistration(adapter, context, artifacts);
    return true;
  };
  let registrationRepaired = false;
  try {
    registrationRepaired = await repairIfStopped();
    await verifyPostActivation(input, context, receiptPath, existing, existing);
  } catch (error) {
    return runCompensation(
      error,
      [
        async () => {
          if (!registrationRepaired) return;
          if (rollbackRegistration) await rollbackRegistration();
          else await adapter.deactivate(context, artifacts);
        },
        () => transaction.restoreFiles(),
        () => transaction.restoreLogs(),
      ],
      'Service health verification and rollback failed',
    );
  }
  return finish();
}

/**
 * Writes the planned artifacts and receipt, activates, verifies, and on any failure restores the
 * snapshot. The compensation order matters: deactivate what this run activated, put the files
 * back, put the logs back, and only then hand the adapter its restored files for its own rollback.
 */
async function installFresh(session: InstallSession): Promise<InstallResult> {
  const { input, context, adapter, artifacts, existing, receiptPath } = session;
  const staleArtifacts = staleOwnedArtifacts(context, existing, artifacts, session.ownedRoots);
  const transaction = beginTransaction(
    context,
    receiptPath,
    [...artifacts, ...staleArtifacts].map((artifact) => artifact.path),
  );
  const receipt = plannedReceipt(session);
  const rollbackActivationState = input.postActivationVerifier
    ? await adapter.prepareDeactivationRollback?.(context, artifacts)
    : undefined;
  let activationCompleted = false;
  try {
    rotateServiceLogs(context.logDirectory, 5, context.dataDirectory);
    for (const artifact of staleArtifacts) rmSync(artifact.path, { force: true });
    for (const artifact of artifacts) {
      writeArtifact(artifact.path, artifact.content, artifact.mode, context.homeDirectory);
    }
    writeInstallReceipt(receiptPath, receipt, context.dataDirectory);
    await adapter.activate(context, artifacts);
    activationCompleted = true;
    await verifyPostActivation(input, context, receiptPath, receipt, existing);
    const integration = await adapter.afterInstall?.(context, artifacts);
    return { installed: true, reconciled: existing !== null, receiptPath, ...integration };
  } catch (error) {
    let filesRestored = false;
    return runCompensation(
      error,
      [
        async () => {
          if (!activationCompleted || rollbackActivationState) return;
          if (adapter.rollbackActivation) await adapter.rollbackActivation(context, artifacts);
          else await adapter.deactivate(context, artifacts);
        },
        () => {
          transaction.restoreFiles();
          filesRestored = true;
        },
        () => transaction.restoreLogs(),
        async () => {
          if (!filesRestored) return;
          if (rollbackActivationState) await rollbackActivationState();
          else if (adapter.afterRollback) await adapter.afterRollback(context, artifacts);
          else if (activationCompleted && existing) await adapter.activate(context, artifacts);
        },
      ],
      'Service installation and rollback failed',
    );
  }
}

async function runInstall(
  input: PlatformServiceManagerInput,
  context: ServiceAdapterContext,
  defaultAdapter: PlatformServiceAdapter,
  receiptPath: string,
): Promise<InstallResult> {
  const existing = readInstallReceipt(receiptPath, context.dataDirectory);
  // A private-runtime setup is also the explicit migration boundary from the legacy npm
  // service. Promote that receipt to the currently selected native adapter so macOS gains
  // the app/login item and Omarchy gains its plugin integration in the same transaction.
  const adapter = adapterForInstall(input, existing, defaultAdapter);
  const artifacts = adapter.artifacts(context);
  validateArtifacts(context, artifacts);
  const ownedRoots = validateOwnedArtifactRoots(adapter, context);
  await adapter.preflight?.(context, artifacts, 'install');
  const ownedArtifacts = receiptArtifacts(artifacts);
  const key = installationKey({
    adapter: adapter.id,
    platform: adapter.platform,
    version: context.version,
    nodePath: context.nodePath,
    cliPath: context.cliPath,
    dataDirectory: context.dataDirectory,
    artifacts: ownedArtifacts,
  });
  const session: InstallSession = {
    input,
    context,
    adapter,
    artifacts,
    existing,
    receiptPath,
    ownedRoots,
    ownedArtifacts,
    key,
  };
  if (
    existing !== null &&
    existing.installationKey === key &&
    artifactSetIsCurrent(existing, artifacts)
  ) {
    return reconcileExisting(session, existing);
  }
  return installFresh(session);
}

async function readServiceStatus(
  input: PlatformServiceManagerInput,
  context: ServiceAdapterContext,
  receiptPath: string,
): Promise<ServiceStatus> {
  const receipt = readInstallReceipt(receiptPath, context.dataDirectory);
  if (!receipt) return { installed: false, running: false, adapter: null, version: null };
  const adapter = requireReceiptAdapter(input, receipt);
  // Planning detects an installation that no longer matches what this build would write. It
  // needs the adapter's source, which an installed CLI does not carry, so fall back to the
  // receipt rather than failing a read-only command.
  const canPlan = adapter.canPlanArtifacts?.(context) ?? true;
  const artifacts: ServiceArtifactRef[] = canPlan
    ? adapter.artifacts(context)
    : receipt.artifacts.map((artifact) => ({ path: artifact.path, mode: artifact.mode }));
  validateArtifacts(context, artifacts);
  const installed = canPlan
    ? artifactSetIsCurrent(receipt, artifacts)
    : receiptMatchesDisk(receipt);
  const integration = await adapter.integrationStatus?.(context, artifacts);
  return {
    installed,
    running: installed ? await adapter.isRunning(context, artifacts) : false,
    adapter: receipt.adapter,
    version: receipt.version,
    ...integration,
  };
}

interface RemovalPlan {
  context: ServiceAdapterContext;
  adapter: PlatformServiceAdapter;
  receipt: InstallReceipt;
  plannedArtifacts: ServiceArtifact[];
  artifacts: ServiceArtifact[];
  receiptPath: string;
  releaseOnce: () => void;
}

/**
 * Deactivates and deletes the owned artifacts while the receipt stays on disk, so a crash before
 * `commit` leaves a state `install` can repair. Any failure puts the files back and, when the
 * service was already stopped, brings it back too; the lock is released once, whatever happens.
 */
async function performOwnedRemoval(plan: RemovalPlan): Promise<PreparedServiceUninstall> {
  const { context, adapter, receipt, plannedArtifacts, artifacts, receiptPath, releaseOnce } = plan;
  const snapshots = artifacts.map((artifact) =>
    snapshotArtifact(artifact.path, context.homeDirectory),
  );
  const receiptSnapshot = snapshotArtifact(receiptPath, context.dataDirectory);
  let rollbackDeactivation: (() => Promise<void>) | undefined;
  let deactivationAttempted = false;
  let manualInstructions: string[] = [];
  let finished = false;
  let committed = false;

  const rollbackPrepared = async (originalError?: unknown): Promise<void> => {
    if (finished) return;
    const failures = await collectFailures([
      () => restoreArtifacts([...snapshots, receiptSnapshot]),
      async () => {
        if (!deactivationAttempted) return;
        if (rollbackDeactivation) {
          await rollbackDeactivation();
        } else {
          await adapter.activate(context, plannedArtifacts);
          await adapter.afterInstall?.(context, plannedArtifacts);
        }
      },
    ]);
    finished = true;
    releaseOnce();
    const errors = originalError === undefined ? failures : [originalError, ...failures];
    if (errors.length === 0) return;
    if (errors.length === 1 && originalError !== undefined) throw originalError;
    throw new AggregateError(errors, 'Service uninstallation and rollback failed');
  };

  try {
    repairMissingArtifacts(context, receipt, plannedArtifacts);
    assertOwnedBytes(receipt, artifacts);
    rollbackDeactivation = await adapter.prepareDeactivationRollback?.(context, plannedArtifacts);
    deactivationAttempted = true;
    await adapter.deactivate(context, artifacts);
    for (const artifact of artifacts) rmSync(artifact.path, { force: true });
    const outcome = await adapter.afterUninstall?.(context, artifacts);
    manualInstructions = outcome ? (outcome.manualInstructions ?? []) : [];
  } catch (error) {
    await rollbackPrepared(error);
  }

  return {
    async commit() {
      if (finished) throw new Error('Prepared service removal is already complete');
      if (committed) throw new Error('Prepared service removal is already committed');
      rmSync(receiptPath, { force: true });
      committed = true;
      return {
        uninstalled: true,
        dataPreserved: true,
        ...(manualInstructions.length > 0 ? { manualInstructions } : {}),
      };
    },
    rollback: () => rollbackPrepared(),
    async finalize() {
      if (finished) return;
      if (!committed) throw new Error('Prepared service removal is not committed');
      finished = true;
      releaseOnce();
    },
  };
}

async function prepareServiceUninstall(
  input: PlatformServiceManagerInput,
  receiptPath: string,
  mutationLock: ReturnType<typeof createSetupLifecycleLock>,
): Promise<PreparedServiceUninstall | null> {
  requireAdapter(input);
  const context = adapterContext(input);
  const releaseOnce = await mutationLock.acquire();
  try {
    const receipt = readInstallReceipt(receiptPath, context.dataDirectory);
    if (!receipt) {
      releaseOnce();
      return null;
    }
    const adapter = requireReceiptAdapter(input, receipt);
    const plannedArtifacts = adapter.artifacts(context);
    validateArtifacts(context, plannedArtifacts);
    const ownedRoots = validateOwnedArtifactRoots(adapter, context);
    await adapter.preflight?.(context, plannedArtifacts, 'uninstall');
    const artifacts = validateOwnedArtifacts(context, receipt, plannedArtifacts, ownedRoots);
    return await performOwnedRemoval({
      context,
      adapter,
      receipt,
      plannedArtifacts,
      artifacts,
      receiptPath,
      releaseOnce,
    });
  } catch (error) {
    releaseOnce();
    throw error;
  }
}

export function createPlatformServiceManager(input: PlatformServiceManagerInput): ServiceManager {
  const dataDirectory = absolutePath(input.dataDirectory, 'Data directory');
  const receiptPath = installReceiptPath(dataDirectory);
  // One lock for every owner of the data directory. Nested acquisitions inside `setup apply` or
  // the packaged removal re-enter it, so the coordinator can drive the manager without deadlock.
  const mutationLock = createSetupLifecycleLock(dataDirectory);
  const statusLock = createSetupLifecycleLock(dataDirectory, {
    timeoutMilliseconds: STATUS_LOCK_WAIT_MILLISECONDS,
  });
  const prepareUninstall = (): Promise<PreparedServiceUninstall | null> =>
    prepareServiceUninstall(input, receiptPath, mutationLock);

  return {
    async install(): Promise<InstallResult> {
      const defaultAdapter = requireAdapter(input);
      const context = adapterContext(input);
      return mutationLock.run(() => runInstall(input, context, defaultAdapter, receiptPath));
    },

    async status(): Promise<ServiceStatus> {
      requireAdapter(input);
      const context = adapterContext(input);
      return statusLock.run(() => readServiceStatus(input, context, receiptPath));
    },

    async uninstall(): Promise<UninstallResult> {
      const prepared = await prepareUninstall();
      if (prepared === null) return { uninstalled: false, dataPreserved: true };
      try {
        const result = await prepared.commit();
        await prepared.finalize();
        return result;
      } catch (error) {
        return runCompensation(
          error,
          [() => prepared.rollback()],
          'Service uninstallation and rollback failed',
        );
      }
    },
    prepareUninstall,
  };
}
