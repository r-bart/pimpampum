import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { createLaunchdAdapter } from './launchd.js';
import { restoreServiceLogs, rotateServiceLogs, snapshotServiceLogs } from './logs.js';
import {
  installReceiptPath,
  installationKey,
  assertNoSymlinkTraversal,
  readInstallReceipt,
  receiptArtifacts,
  sha256,
  writeInstallReceipt,
  writePrivateFileAtomic,
} from './receipt.js';
import { createSystemdAdapter } from './systemd.js';
import type {
  InstallReceipt,
  InstallResult,
  PlatformServiceAdapter,
  PlatformServiceManagerInput,
  PreparedServiceUninstall,
  ServiceAdapterContext,
  ServiceArtifact,
  ServiceManager,
  ServiceStatus,
  SupportedServicePlatform,
  UninstallResult,
} from './types.js';

type ArtifactSnapshot =
  | { path: string; trustedRoot: string; existed: false }
  | { path: string; trustedRoot: string; existed: true; content: Buffer; mode: number };

const SERVICE_LIFECYCLE_LOCK_NAME = '.service-lifecycle.lock';

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function acquireLifecycleLock(dataDirectory: string): () => void {
  const lockPath = join(dataDirectory, SERVICE_LIFECYCLE_LOCK_NAME);
  const lock = `${JSON.stringify({ pid: process.pid, nonce: randomUUID() })}\n`;
  while (true) {
    assertNoSymlinkTraversal(dataDirectory, 'Data directory', dataDirectory);
    try {
      writeFileSync(lockPath, lock, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return () => {
        if (existsSync(lockPath)) {
          assertNoSymlinkTraversal(lockPath, 'Service lifecycle lock', dataDirectory);
          if (readFileSync(lockPath, 'utf8') === lock) rmSync(lockPath);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assertNoSymlinkTraversal(lockPath, 'Service lifecycle lock', dataDirectory);
      let owner: unknown;
      try {
        owner = JSON.parse(readFileSync(lockPath, 'utf8')) as unknown;
      } catch (parseError) {
        throw new Error('Invalid Pimpampum service lifecycle lock', { cause: parseError });
      }
      const pid = (owner as { pid?: unknown }).pid;
      if (!Number.isInteger(pid) || (pid as number) < 1 || processIsAlive(pid as number)) {
        throw new Error('Another Pimpampum service lifecycle operation is in progress');
      }
      rmSync(lockPath);
    }
  }
}

async function withLifecycleLock<T>(
  context: ServiceAdapterContext,
  action: () => Promise<T>,
): Promise<T> {
  const release = acquireLifecycleLock(context.dataDirectory);
  try {
    return await action();
  } finally {
    release();
  }
}

async function repairRegistration(
  adapter: PlatformServiceAdapter,
  context: ServiceAdapterContext,
  artifacts: ServiceArtifact[],
): Promise<void> {
  try {
    await adapter.activate(context, artifacts);
  } catch (activationError) {
    if (!adapter.afterRollback) throw activationError;
    try {
      await adapter.afterRollback(context, artifacts);
    } catch (rollbackError) {
      throw new AggregateError(
        [activationError, rollbackError],
        'Service registration repair and rollback failed',
      );
    }
    throw activationError;
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

function validateArtifacts(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): void {
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

function restoreArtifacts(snapshots: ArtifactSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.existed) {
      writePrivateFileAtomic(snapshot.path, snapshot.content, snapshot.mode, snapshot.trustedRoot);
    } else {
      rmSync(snapshot.path, { force: true });
    }
  }
}

function artifactSetIsCurrent(receipt: InstallReceipt, artifacts: ServiceArtifact[]): boolean {
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
    writePrivateFileAtomic(path, planned.content, planned.mode, context.homeDirectory);
  }
}

export function createPlatformServiceManager(input: PlatformServiceManagerInput): ServiceManager {
  const receiptPath = installReceiptPath(absolutePath(input.dataDirectory, 'Data directory'));

  async function prepareUninstall(): Promise<PreparedServiceUninstall | null> {
    requireAdapter(input);
    const context = adapterContext(input);
    const release = acquireLifecycleLock(context.dataDirectory);
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };
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
      const snapshots = artifacts.map((artifact) =>
        snapshotArtifact(artifact.path, context.homeDirectory),
      );
      const receiptSnapshot = snapshotArtifact(receiptPath, context.dataDirectory);
      let rollbackDeactivation: (() => Promise<void>) | undefined;
      let deactivationAttempted = false;
      let finished = false;
      let committed = false;

      const rollbackPrepared = async (originalError?: unknown): Promise<void> => {
        if (finished) return;
        const rollbackErrors: unknown[] = originalError === undefined ? [] : [originalError];
        try {
          restoreArtifacts([...snapshots, receiptSnapshot]);
        } catch (restoreError) {
          rollbackErrors.push(restoreError);
        }
        if (deactivationAttempted) {
          try {
            if (rollbackDeactivation) {
              await rollbackDeactivation();
            } else {
              await adapter.activate(context, plannedArtifacts);
              await adapter.afterInstall?.(context, plannedArtifacts);
            }
          } catch (activationError) {
            rollbackErrors.push(activationError);
          }
        }
        finished = true;
        releaseOnce();
        if (rollbackErrors.length === 0) return;
        if (rollbackErrors.length === 1 && originalError !== undefined) throw originalError;
        throw new AggregateError(rollbackErrors, 'Service uninstallation and rollback failed');
      };

      try {
        repairMissingArtifacts(context, receipt, plannedArtifacts);
        assertOwnedBytes(receipt, artifacts);
        rollbackDeactivation = await adapter.prepareDeactivationRollback?.(
          context,
          plannedArtifacts,
        );
        deactivationAttempted = true;
        await adapter.deactivate(context, artifacts);
        for (const artifact of artifacts) rmSync(artifact.path, { force: true });
        await adapter.afterUninstall?.(context, artifacts);
      } catch (error) {
        await rollbackPrepared(error);
      }

      return {
        async commit() {
          if (finished) throw new Error('Prepared service removal is already complete');
          if (committed) throw new Error('Prepared service removal is already committed');
          rmSync(receiptPath, { force: true });
          committed = true;
          return { uninstalled: true, dataPreserved: true };
        },
        rollback: () => rollbackPrepared(),
        async finalize() {
          if (finished) return;
          if (!committed) throw new Error('Prepared service removal is not committed');
          finished = true;
          releaseOnce();
        },
      };
    } catch (error) {
      releaseOnce();
      throw error;
    }
  }

  return {
    async install(): Promise<InstallResult> {
      const defaultAdapter = requireAdapter(input);
      const context = adapterContext(input);
      return withLifecycleLock(context, async () => {
        const existing = readInstallReceipt(receiptPath, context.dataDirectory);
        const adapter = existing ? requireReceiptAdapter(input, existing) : defaultAdapter;
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
        if (existing?.installationKey === key && artifactSetIsCurrent(existing, artifacts)) {
          chmodSync(receiptPath, 0o600);
          if (!input.postActivationVerifier) {
            if (!(await adapter.isRunning(context, artifacts))) {
              await repairRegistration(adapter, context, artifacts);
            }
            const integration = await adapter.afterInstall?.(context, artifacts);
            return { installed: true, reconciled: true, receiptPath, ...integration };
          }
          const runningBefore = await adapter.isRunning(context, artifacts);
          const snapshots = artifacts.map((artifact) =>
            snapshotArtifact(artifact.path, context.homeDirectory),
          );
          const receiptSnapshot = snapshotArtifact(receiptPath, context.dataDirectory);
          const logsSnapshot = snapshotServiceLogs(context.logDirectory, 5, context.dataDirectory);
          let registrationRepaired = false;
          const rollbackRegistration = runningBefore
            ? undefined
            : await adapter.prepareDeactivationRollback?.(context, artifacts);
          try {
            if (runningBefore) {
              registrationRepaired = false;
            } else {
              await repairRegistration(adapter, context, artifacts);
              registrationRepaired = true;
            }
            await verifyPostActivation(input, context, receiptPath, existing, existing);
          } catch (error) {
            const rollbackErrors: unknown[] = [error];
            if (registrationRepaired) {
              try {
                if (rollbackRegistration) await rollbackRegistration();
                else await adapter.deactivate(context, artifacts);
              } catch (registrationRollbackError) {
                rollbackErrors.push(registrationRollbackError);
              }
            }
            try {
              restoreArtifacts([...snapshots, receiptSnapshot]);
            } catch (restoreError) {
              rollbackErrors.push(restoreError);
            }
            try {
              restoreServiceLogs(logsSnapshot);
            } catch (logsRestoreError) {
              rollbackErrors.push(logsRestoreError);
            }
            if (rollbackErrors.length > 1) {
              throw new AggregateError(
                rollbackErrors,
                'Service health verification and rollback failed',
              );
            }
            throw error;
          }
          const integration = await adapter.afterInstall?.(context, artifacts);
          return { installed: true, reconciled: true, receiptPath, ...integration };
        }

        const staleArtifacts = staleOwnedArtifacts(context, existing, artifacts, ownedRoots);
        const snapshots = [...artifacts, ...staleArtifacts].map((artifact) =>
          snapshotArtifact(artifact.path, context.homeDirectory),
        );
        const receiptSnapshot = snapshotArtifact(receiptPath, context.dataDirectory);
        const logsSnapshot = snapshotServiceLogs(context.logDirectory, 5, context.dataDirectory);
        const receipt: InstallReceipt = {
          schemaVersion: 1,
          adapter: adapter.id,
          platform: adapter.platform,
          version: context.version,
          installationKey: key,
          installedAt: new Date().toISOString(),
          nodePath: context.nodePath,
          cliPath: context.cliPath,
          dataDirectory: context.dataDirectory,
          baseUrl: `http://${context.host === '::1' ? '[::1]' : context.host}:${context.port}`,
          logDirectory: context.logDirectory,
          artifacts: ownedArtifacts,
          ...(context.packagedRuntime
            ? {
                updateProvider: 'packaged-release' as const,
                packagedRuntime: context.packagedRuntime,
              }
            : {}),
        };
        const rollbackActivationState = input.postActivationVerifier
          ? await adapter.prepareDeactivationRollback?.(context, artifacts)
          : undefined;
        let activationCompleted = false;
        try {
          rotateServiceLogs(context.logDirectory, 5, context.dataDirectory);
          for (const artifact of staleArtifacts) rmSync(artifact.path, { force: true });
          for (const artifact of artifacts) {
            writePrivateFileAtomic(
              artifact.path,
              artifact.content,
              artifact.mode,
              context.homeDirectory,
            );
          }
          writeInstallReceipt(receiptPath, receipt, context.dataDirectory);
          await adapter.activate(context, artifacts);
          activationCompleted = true;
          await verifyPostActivation(input, context, receiptPath, receipt, existing);
          const integration = await adapter.afterInstall?.(context, artifacts);
          return {
            installed: true,
            reconciled: existing !== null,
            receiptPath,
            ...integration,
          };
        } catch (error) {
          const rollbackErrors: unknown[] = [error];
          let serviceArtifactsRestored = false;
          if (activationCompleted && !rollbackActivationState) {
            try {
              if (adapter.rollbackActivation) {
                await adapter.rollbackActivation(context, artifacts);
              } else {
                await adapter.deactivate(context, artifacts);
              }
            } catch (deactivationError) {
              rollbackErrors.push(deactivationError);
            }
          }
          try {
            restoreArtifacts([...snapshots, receiptSnapshot]);
            serviceArtifactsRestored = true;
          } catch (restoreError) {
            rollbackErrors.push(restoreError);
          }
          try {
            restoreServiceLogs(logsSnapshot);
          } catch (logsRestoreError) {
            rollbackErrors.push(logsRestoreError);
          }
          if (serviceArtifactsRestored && rollbackActivationState) {
            try {
              await rollbackActivationState();
            } catch (activationRollbackError) {
              rollbackErrors.push(activationRollbackError);
            }
          } else if (serviceArtifactsRestored && adapter.afterRollback) {
            try {
              await adapter.afterRollback(context, artifacts);
            } catch (adapterRollbackError) {
              rollbackErrors.push(adapterRollbackError);
            }
          } else if (serviceArtifactsRestored && activationCompleted && existing) {
            try {
              await adapter.activate(context, artifacts);
            } catch (reactivationError) {
              rollbackErrors.push(reactivationError);
            }
          }
          if (rollbackErrors.length > 1) {
            throw new AggregateError(rollbackErrors, 'Service installation and rollback failed');
          }
          throw error;
        }
      });
    },

    async status(): Promise<ServiceStatus> {
      requireAdapter(input);
      const context = adapterContext(input);
      return withLifecycleLock(context, async () => {
        const receipt = readInstallReceipt(receiptPath, context.dataDirectory);
        if (!receipt) return { installed: false, running: false, adapter: null, version: null };
        const adapter = requireReceiptAdapter(input, receipt);
        const artifacts = adapter.artifacts(context);
        validateArtifacts(context, artifacts);
        const installed = artifactSetIsCurrent(receipt, artifacts);
        const integration = await adapter.integrationStatus?.(context, artifacts);
        return {
          installed,
          running: installed ? await adapter.isRunning(context, artifacts) : false,
          adapter: receipt.adapter,
          version: receipt.version,
          ...integration,
        };
      });
    },

    async uninstall(): Promise<UninstallResult> {
      const prepared = await prepareUninstall();
      if (prepared === null) return { uninstalled: false, dataPreserved: true };
      try {
        const result = await prepared.commit();
        await prepared.finalize();
        return result;
      } catch (error) {
        try {
          await prepared.rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Service uninstallation and rollback failed',
          );
        }
        throw error;
      }
    },
    prepareUninstall,
  };
}
