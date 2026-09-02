/**
 * The update manager of a packaged install. The signed channel says which version exists,
 * `releaseCandidate.ts` stages and validates it, and the reconcile here activates it as one
 * transaction of the installation lifecycle engine: private runtime, app bundle, service receipt,
 * each restored in reverse when a later phase fails.
 */
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
  sep,
} from 'node:path';
import { installedApplicationPath } from '../runtime/bootstrap.js';
import {
  installRuntimeTransaction,
  pruneOwnedRuntimeVersions,
  type RuntimeInstallationTransaction,
} from '../runtime/installer.js';
import { resolveRuntimeLayout } from '../runtime/layout.js';
import { parseRuntimeManifest } from '../runtime/manifest.js';
import type { RuntimeManifest } from '../runtime/types.js';
import { packagedCliSmoke } from '../service/packagedLifecycle.js';
import {
  installReceiptPath,
  readInstallReceipt,
  restoreInstallReceiptSnapshot,
  snapshotInstallReceipt,
} from '../service/receipt.js';
import type {
  InstallReceipt,
  InstallReceiptFileSnapshot,
  PackagedRuntimeMetadata,
  RunCommand,
  ServiceManager,
} from '../service/types.js';
import {
  createInstallationLifecycle,
  type InstallationLifecycleDependencies,
} from '../setup/coordinator.js';
import { createSetupLifecycleLock } from '../setup/state.js';
import type { InstallationSnapshot } from '../setup/types.js';
import {
  createUpdateManager,
  receiptUsesPackagedRelease,
  resolveNpmPath,
  type PackagedReleaseProviderInput,
  type PackagedReleaseTarget,
  type UpdateInstallReceiptMetadata,
  type UpdateManager,
} from '../update.js';
import {
  createPackagedReleaseStager,
  linuxPackagedUpdateUnavailable,
  pathEntryExists,
  validateCandidateInventory,
} from './releaseCandidate.js';
import {
  DEFAULT_RELEASE_CHANNEL_URL,
  releaseChannelTransport,
  type ReleaseChannelTransportInput,
} from './releaseChannel.js';

const CANDIDATE_RUNTIME_LIMIT_BYTES = 175 * 1024 * 1024;

export interface CandidateServiceManagerInput {
  appBundlePath: string;
  version: string;
  nodePath: string;
  cliPath: string;
  packagedRuntime: PackagedRuntimeMetadata;
}

export interface CliUpdateManagerInput extends ReleaseChannelTransportInput {
  currentVersion: string;
  dataDirectory: string;
  homeDirectory: string;
  target: PackagedReleaseTarget | null;
  nodePath: string;
  runCommand: RunCommand;
  currentServiceManager: ServiceManager;
  createCandidateServiceManager(input: CandidateServiceManagerInput): ServiceManager;
  npmPath?: string | null;
  packagedRelease?: PackagedReleaseProviderInput;
}

function pathInside(root: string, candidate: string): boolean {
  const child = relativePath(resolve(root), resolve(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function readUpdateReceipt(dataDirectory: string): UpdateInstallReceiptMetadata | undefined {
  const receipt = readInstallReceipt(installReceiptPath(dataDirectory), dataDirectory);
  return receipt
    ? {
        schemaVersion: 1,
        adapter: receipt.adapter,
        ...(receipt.updateProvider === undefined ? {} : { updateProvider: receipt.updateProvider }),
        ...(receipt.packagedRuntime === undefined
          ? {}
          : { packagedRuntime: receipt.packagedRuntime }),
      }
    : undefined;
}

/** Everything the activation of one staged candidate needs, resolved before any phase runs. */
export interface CandidateActivation {
  version: string;
  stagedAppPath: string;
  /** The bundle setup recorded, so an adopted `/Applications` copy is the one replaced. */
  installedApp: string;
  applicationsDirectory: string;
  candidateRuntimeRoot: string;
  candidateManifest: RuntimeManifest;
  runtimeDirectory: string;
  nodePath: string;
  cliPath: string;
  candidateManager: ServiceManager;
}

/** Exported for the transaction tests, which drive the phases out of order to prove each guard. */
export function resolveCandidateActivation(
  input: CliUpdateManagerInput,
  version: string,
  candidatePath: string,
): CandidateActivation {
  const stagedAppPath = validateCandidateInventory(candidatePath, 'darwin-arm64', version);
  /* v8 ignore next 3 -- the walk never leaves its root and rejects symlinks; belt and braces. */
  if (!pathInside(candidatePath, stagedAppPath)) {
    throw new Error('Staged app escaped its candidate root');
  }
  const candidateRuntimeRoot = join(stagedAppPath, 'Contents', 'Resources', 'PimpampumRuntime');
  const candidateManifest = parseRuntimeManifest(
    JSON.parse(
      readFileSync(join(candidateRuntimeRoot, 'runtime-manifest.json'), 'utf8'),
    ) as unknown,
    {
      platform: 'darwin',
      architecture: 'arm64',
      maximumUnpackedBytes: CANDIDATE_RUNTIME_LIMIT_BYTES,
    },
  );
  /* v8 ignore next 4 -- `validateCandidateInventory` parsed this same manifest and already refused
     another version; the re-check only guards a future divergence between the two readers, which
     no input to this function can produce. The tighter byte bound above is why the parse repeats. */
  if (candidateManifest.pimpampumVersion !== version) {
    throw new Error('Candidate runtime version does not match the packaged update');
  }
  const layout = resolveRuntimeLayout({
    homeDirectory: input.homeDirectory,
    platform: 'darwin',
    architecture: 'arm64',
    version,
  });
  const nodePath = join(layout.versionDirectory, ...candidateManifest.entrypoints.node.split('/'));
  const cliPath = join(layout.versionDirectory, ...candidateManifest.entrypoints.cli.split('/'));
  const packagedRuntime: PackagedRuntimeMetadata = {
    version,
    target: 'darwin-arm64',
    runtimeDirectory: layout.versionDirectory,
  };
  return {
    version,
    stagedAppPath,
    installedApp: installedApplicationPath(input),
    applicationsDirectory: join(input.homeDirectory, 'Applications'),
    candidateRuntimeRoot,
    candidateManifest,
    runtimeDirectory: layout.versionDirectory,
    nodePath,
    cliPath,
    candidateManager: input.createCandidateServiceManager({
      appBundlePath: stagedAppPath,
      version,
      nodePath,
      cliPath,
      packagedRuntime,
    }),
  };
}

export interface UpdateTransactionState {
  currentReceipt: InstallReceipt | null;
  currentReceiptSnapshot: InstallReceiptFileSnapshot | null;
  /** The private directory the previous app bundle is moved into while the new one installs. */
  backupRoot: string | null;
  backupApp: string | null;
  appBackedUp: boolean;
  runtimeTransaction: RuntimeInstallationTransaction | null;
}

export type PackagedUpdatePhases = Pick<
  InstallationLifecycleDependencies,
  'runtime' | 'service' | 'connectors' | 'receipt'
>;

const nothing = async (): Promise<void> => undefined;

/** Puts the previous app bundle back; safe to call when nothing was moved. */
function restoreApplication(candidate: CandidateActivation, state: UpdateTransactionState): void {
  if (pathEntryExists(candidate.installedApp)) {
    const metadata = lstatSync(candidate.installedApp);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Updated application path is unsafe to roll back');
    }
    rmSync(candidate.installedApp, { recursive: true });
  }
  if (!state.appBackedUp) return;
  if (state.backupApp === null) throw new Error('Application rollback snapshot is missing');
  renameSync(state.backupApp, candidate.installedApp);
  state.appBackedUp = false;
}

function discardBackup(state: UpdateTransactionState): void {
  if (state.backupRoot !== null) rmSync(state.backupRoot, { recursive: true, force: true });
}

function updateRuntimePhase(
  input: CliUpdateManagerInput,
  candidate: CandidateActivation,
  state: UpdateTransactionState,
): PackagedUpdatePhases['runtime'] {
  return {
    stage: async () => ({
      version: candidate.version,
      nodePath: candidate.nodePath,
      cliPath: candidate.cliPath,
    }),
    activate: async () => {
      state.runtimeTransaction = await installRuntimeTransaction({
        homeDirectory: input.homeDirectory,
        dataDirectory: input.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        sourceDirectory: join(candidate.candidateRuntimeRoot, 'payload'),
        manifest: candidate.candidateManifest,
        smoke: packagedCliSmoke(input.runCommand, {
          failure: 'Candidate packaged runtime CLI smoke failed',
        }),
      });
    },
    restore: async () => {
      state.runtimeTransaction?.rollback();
      state.runtimeTransaction = null;
    },
    removeOwned: nothing,
  };
}

function updateServicePhase(
  input: CliUpdateManagerInput,
  candidate: CandidateActivation,
  state: UpdateTransactionState,
): PackagedUpdatePhases['service'] {
  return {
    stop: nothing,
    install: async () => {
      const currentApp = lstatSync(candidate.installedApp);
      if (currentApp.isSymbolicLink() || !currentApp.isDirectory()) {
        throw new Error('Installed application must be a regular directory');
      }
      if (state.backupApp === null) throw new Error('Application backup was not staged');
      renameSync(candidate.installedApp, state.backupApp);
      state.appBackedUp = true;
      await candidate.candidateManager.install();
    },
    start: nothing,
    verify: async () => {
      const status = await candidate.candidateManager.status();
      if (!status.installed || !status.running || status.version !== candidate.version) {
        throw new Error('Updated packaged service failed health verification');
      }
    },
    restore: async () => {
      restoreApplication(candidate, state);
      if (state.currentReceiptSnapshot === null) {
        throw new Error('Service receipt rollback snapshot is missing');
      }
      restoreInstallReceiptSnapshot(
        installReceiptPath(input.dataDirectory),
        state.currentReceiptSnapshot,
        input.dataDirectory,
      );
      await input.currentServiceManager.install();
    },
    removeOwned: nothing,
  };
}

function assertPreviousReceiptRestored(
  installed: InstallReceipt | null,
  snapshot: InstallationSnapshot,
): void {
  if (
    !installed ||
    installed.version !== snapshot.runtimeVersion ||
    installed.nodePath !== snapshot.serviceCommand[0] ||
    installed.cliPath !== snapshot.serviceCommand[1]
  ) {
    throw new Error('Previous service receipt was not restored exactly');
  }
}

function assertUpdatedReceiptCommitted(
  installed: InstallReceipt | null,
  candidate: CandidateActivation,
  snapshot: InstallationSnapshot,
): void {
  if (
    !installed ||
    installed.version !== snapshot.runtimeVersion ||
    installed.nodePath !== candidate.nodePath ||
    installed.cliPath !== candidate.cliPath ||
    installed.updateProvider !== 'packaged-release' ||
    installed.packagedRuntime?.version !== candidate.version ||
    installed.packagedRuntime.target !== 'darwin-arm64' ||
    installed.packagedRuntime.runtimeDirectory !== candidate.runtimeDirectory
  ) {
    throw new Error('Updated service receipt did not commit the expected version');
  }
}

function updateReceiptPhase(
  input: CliUpdateManagerInput,
  candidate: CandidateActivation,
  state: UpdateTransactionState,
): PackagedUpdatePhases['receipt'] {
  const receiptPath = installReceiptPath(input.dataDirectory);
  return {
    read: async () => {
      // One read serves both the semantic receipt and the exact bytes a rollback puts back.
      const snapshot = snapshotInstallReceipt(receiptPath, input.dataDirectory);
      if (snapshot === null) throw new Error('Packaged update requires an installation receipt');
      state.currentReceipt = snapshot.receipt;
      state.currentReceiptSnapshot = snapshot;
      state.backupRoot = mkdtempSync(
        join(candidate.applicationsDirectory, '.pimpampum-app-backup-'),
      );
      state.backupApp = join(state.backupRoot, basename(candidate.installedApp));
      return {
        runtimeVersion: state.currentReceipt.version,
        serviceCommand: [state.currentReceipt.nodePath, state.currentReceipt.cliPath],
        connectorEntries: {},
      };
    },
    commit: async (snapshot) => {
      const installed = readInstallReceipt(receiptPath, input.dataDirectory);
      if (snapshot.runtimeVersion !== candidate.version) {
        assertPreviousReceiptRestored(installed, snapshot);
        return;
      }
      assertUpdatedReceiptCommitted(installed, candidate, snapshot);
      if (state.currentReceipt === null || state.runtimeTransaction === null) {
        throw new Error('Packaged update committed before its runtime was activated');
      }
      pruneOwnedRuntimeVersions({
        homeDirectory: input.homeDirectory,
        dataDirectory: input.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        keepVersions: [state.currentReceipt.version],
      });
      state.runtimeTransaction.commit();
      state.runtimeTransaction = null;
    },
    remove: nothing,
  };
}

/**
 * The phases of one packaged update, sharing one state. Exported for the transaction tests, which
 * drive a phase out of order to prove each guard; the CLI only reaches them through `reconcile`.
 */
export function createPackagedUpdatePhases(
  input: CliUpdateManagerInput,
  candidate: CandidateActivation,
): { phases: PackagedUpdatePhases; state: UpdateTransactionState } {
  const state: UpdateTransactionState = {
    currentReceipt: null,
    currentReceiptSnapshot: null,
    backupRoot: null,
    backupApp: null,
    appBackedUp: false,
    runtimeTransaction: null,
  };
  const phases: PackagedUpdatePhases = {
    runtime: updateRuntimePhase(input, candidate, state),
    service: updateServicePhase(input, candidate, state),
    connectors: {
      reconcileOwned: nothing,
      snapshotOwned: async () => ({}),
      restoreOwned: nothing,
      disconnectOwned: nothing,
    },
    receipt: updateReceiptPhase(input, candidate, state),
  };
  return { phases, state };
}

function removeStagingRoot(homeDirectory: string, candidatePath: string): void {
  const stagingRoot = dirname(candidatePath);
  if (stagingRoot.startsWith(join(homeDirectory, 'Applications', '.pimpampum-update-'))) {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function reconcilePackagedUpdate(
  input: CliUpdateManagerInput,
  activation: { version: string; candidatePath: string; target: PackagedReleaseTarget },
): Promise<void> {
  const { version, candidatePath, target } = activation;
  try {
    if (target !== 'darwin-arm64') throw linuxPackagedUpdateUnavailable(version);
    const candidate = resolveCandidateActivation(input, version, candidatePath);
    const { phases, state } = createPackagedUpdatePhases(input, candidate);
    const lifecycle = createInstallationLifecycle({
      dataDirectory: input.dataDirectory,
      homeDirectory: input.homeDirectory,
      lifecycleLock: createSetupLifecycleLock(input.dataDirectory),
      ...phases,
    });
    try {
      await lifecycle.update({ targetVersion: version });
      state.appBackedUp = false;
      discardBackup(state);
    } catch (error) {
      if (state.appBackedUp) restoreApplication(candidate, state);
      discardBackup(state);
      throw error;
    }
  } finally {
    removeStagingRoot(input.homeDirectory, candidatePath);
  }
}

export function createConcretePackagedProvider(
  input: CliUpdateManagerInput,
): PackagedReleaseProviderInput {
  if (input.target === null) throw new Error('Packaged release target is unsupported');
  const transport = releaseChannelTransport(input);
  return {
    channelManifestUrl: transport.channelManifestUrl ?? DEFAULT_RELEASE_CHANNEL_URL,
    target: input.target,
    allowInsecureLoopback: transport.allowInsecureLoopback,
    fetchManifest: transport.fetchManifest,
    verifySignature: transport.verifySignature,
    stageCandidate: createPackagedReleaseStager({
      homeDirectory: input.homeDirectory,
      runCommand: input.runCommand,
      fetchImplementation: transport.fetchImplementation,
      allowInsecureLoopback: transport.allowInsecureLoopback,
    }),
    reconcile: (activation) => reconcilePackagedUpdate(input, activation),
  };
}

export function createCliUpdateManager(input: CliUpdateManagerInput): UpdateManager {
  const installReceipt = readUpdateReceipt(input.dataDirectory);
  return createUpdateManager({
    currentVersion: input.currentVersion,
    npmPath: input.npmPath === undefined ? resolveNpmPath(input.nodePath) : input.npmPath,
    nodePath: input.nodePath,
    runCommand: input.runCommand,
    // The trust store persists the newest `issuedAt` accepted, so the replay check outlives
    // this process instead of restarting from nothing on every `update:check`.
    dataDirectory: input.dataDirectory,
    ...(installReceipt ? { installReceipt } : {}),
    ...(input.packagedRelease
      ? { packagedRelease: input.packagedRelease }
      : // Every packaged install — the macOS app and the Omarchy runtime alike — reads the signed
        // channel. Linux receives a real `check` and a typed refusal on `update`.
        receiptUsesPackagedRelease(installReceipt) && input.target !== null
        ? { packagedRelease: createConcretePackagedProvider(input) }
        : {}),
  });
}
