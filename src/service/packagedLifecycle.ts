/**
 * The two transactions a packaged install adds around the service manager: activating the private
 * runtime before the service is installed, and removing runtime, service, agent entries and
 * receipt together on uninstall. The removal is expressed as the phases of the installation
 * lifecycle engine, which owns the order and the compensation; the composition wires them to the
 * engine, the lock and the connectors it built.
 */
import { collectFailures } from '../aggregateRollback.js';
import { fingerprintCommand } from '../connectors/receipt.js';
import type {
  ConnectionReceipt,
  ConnectorId,
  ConnectorSnapshot,
  HostConnector,
} from '../connectors/types.js';
import { isRecord } from '../objects.js';
import type { PackagedRuntimeBootstrap } from '../runtime/bootstrap.js';
import {
  prepareOwnedRuntimeRemoval,
  pruneOwnedRuntimeVersions,
  type PreparedRuntimeRemoval,
  type PruneOwnedRuntimeInput,
} from '../runtime/installer.js';
import type { RuntimeInstallation } from '../runtime/types.js';
import type { InstallationLifecycleDependencies } from '../setup/coordinator.js';
import type { InstallationSnapshot } from '../setup/types.js';
import {
  installReceiptPath,
  restoreInstallReceiptSnapshot,
  snapshotInstallReceipt,
} from './receipt.js';
import type {
  InstallReceipt,
  InstallReceiptFileSnapshot,
  InstallResult,
  PreparedServiceUninstall,
  RunCommand,
  ServiceManager,
  UninstallResult,
} from './types.js';

const PACKAGED_ADAPTERS = new Set(['launchd-macos-app', 'macos-app', 'systemd-omarchy-quattro']);

/** A receipt the packaged transactions own: explicit provenance, a private runtime, or a packaged adapter. */
export function isPackagedServiceReceipt(
  receipt: InstallReceipt | null,
): receipt is InstallReceipt {
  return (
    receipt !== null &&
    (receipt.updateProvider === 'packaged-release' ||
      receipt.packagedRuntime !== undefined ||
      PACKAGED_ADAPTERS.has(receipt.adapter))
  );
}

/**
 * The check every activated runtime passes before the service points at it: its own CLI answers
 * `version`. With `expectedVersion` the answer must also name this release, which is the guided
 * setup's stricter reading.
 */
export function packagedCliSmoke(
  runCommand: RunCommand,
  options: { failure: string; expectedVersion?: string },
): (installation: RuntimeInstallation) => Promise<void> {
  return async (installation) => {
    const smoke = await runCommand(installation.nodePath, [installation.cliPath, 'version']);
    if (smoke.exitCode !== 0) throw new Error(options.failure);
    if (options.expectedVersion === undefined) return;
    const envelope = JSON.parse(smoke.stdout) as unknown;
    if (
      !isRecord(envelope) ||
      !isRecord(envelope.data) ||
      envelope.data.version !== options.expectedVersion
    ) {
      throw new Error('Packaged runtime CLI smoke returned an unexpected version');
    }
  };
}

/** The prune input that keeps the version that was active, so a rollback still has it. */
export function keepPreviousRuntime(
  previousVersion: string | null,
): Pick<PruneOwnedRuntimeInput, 'keepVersions'> {
  return previousVersion === null ? {} : { keepVersions: [previousVersion] };
}

export interface PackagedInstallInput {
  lock: { run<T>(operation: () => Promise<T>): Promise<T> };
  bootstrap: Pick<PackagedRuntimeBootstrap, 'prepareInstallation'>;
  runCommand: RunCommand;
  manager: Pick<ServiceManager, 'install'>;
  runtime: Omit<PruneOwnedRuntimeInput, 'keepVersions'>;
}

/**
 * `pimpampum install` on a packaged runtime: activate the private runtime, install the service on
 * it, prune every other owned version but the one that was active, commit. A failure after the
 * activation rolls the runtime back before the error surfaces.
 */
export async function installPackagedService(input: PackagedInstallInput): Promise<InstallResult> {
  return input.lock.run(async () => {
    const transaction = await input.bootstrap.prepareInstallation(
      packagedCliSmoke(input.runCommand, { failure: 'Packaged runtime CLI smoke failed' }),
    );
    try {
      const result = await input.manager.install();
      pruneOwnedRuntimeVersions({
        ...input.runtime,
        ...keepPreviousRuntime(transaction.installation.previousVersion),
      });
      transaction.commit();
      return result;
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  });
}

interface ConnectorReceiptStore {
  read(): Promise<ConnectionReceipt | null>;
  write(receipt: ConnectionReceipt): Promise<void>;
}

export interface PackagedRemovalInput {
  serviceManager: { prepareUninstall(): Promise<PreparedServiceUninstall | null> };
  /** The receipt that proved the install is packaged; the removal plans from it. */
  serviceReceipt: InstallReceipt;
  dataDirectory: string;
  runtime: Omit<PruneOwnedRuntimeInput, 'keepVersions'>;
  connectors: readonly HostConnector[];
  receiptStores: ReadonlyMap<ConnectorId, ConnectorReceiptStore>;
}

export type PackagedRemovalPhases = Pick<
  InstallationLifecycleDependencies,
  'runtime' | 'service' | 'connectors' | 'receipt'
>;

interface RemovalState {
  preparedService: PreparedServiceUninstall | null;
  preparedRuntime: PreparedRuntimeRemoval | null;
  capturedServiceReceipt: InstallReceiptFileSnapshot | null;
  disconnectedConnectorIds: ConnectorId[];
}

const nothing = async (): Promise<void> => undefined;

function runtimeRemovalPhase(
  input: PackagedRemovalInput,
  state: RemovalState,
): PackagedRemovalPhases['runtime'] {
  return {
    stage: async () => {
      throw new Error('Runtime staging is unavailable during removal');
    },
    activate: nothing,
    restore: async () => {
      state.preparedRuntime?.rollback();
      state.preparedRuntime = null;
    },
    removeOwned: async () => {
      state.preparedRuntime = prepareOwnedRuntimeRemoval(input.runtime);
    },
    finalizeRemoval: async () => {
      state.preparedRuntime?.commit();
      state.preparedRuntime = null;
    },
  };
}

function serviceRemovalPhase(
  input: PackagedRemovalInput,
  state: RemovalState,
): PackagedRemovalPhases['service'] {
  return {
    // prepareUninstall deactivates the native registration inside its rollback boundary.
    stop: nothing,
    install: async () => {
      throw new Error('Service installation is unavailable during removal');
    },
    start: nothing,
    verify: nothing,
    restore: async () => {
      if (state.preparedService === null) return;
      const transaction = state.preparedService;
      state.preparedService = null;
      await transaction.rollback();
    },
    removeOwned: async () => {
      state.preparedService = await input.serviceManager.prepareUninstall();
      if (state.preparedService === null) {
        throw new Error('Packaged service receipt disappeared during removal');
      }
    },
    finalizeRemoval: async () => {
      if (state.preparedService === null) return;
      const transaction = state.preparedService;
      await transaction.finalize();
      state.preparedService = null;
    },
  };
}

interface OwnedRemovalEntry {
  snapshot: ConnectorSnapshot;
  receipt: ConnectionReceipt;
}

/**
 * Owned when the inspection, the private receipt and a fresh snapshot all name the same command;
 * unproven when an entry or a receipt is left but ownership cannot be shown, so the removal leaves
 * it alone and says so.
 */
async function classifyConnectorRemoval(
  connector: HostConnector,
  receiptStore: ConnectorReceiptStore,
): Promise<{ owned: OwnedRemovalEntry } | { unproven: true } | null> {
  const inspection = await connector.inspect();
  const receipt = await receiptStore.read();
  if (
    (inspection.state === 'ownedCurrent' || inspection.state === 'ownedStale') &&
    inspection.entry !== null &&
    receipt !== null
  ) {
    const snapshot = await connector.snapshot();
    if (
      snapshot.entry !== null &&
      fingerprintCommand(snapshot.entry) === fingerprintCommand(inspection.entry)
    ) {
      return { owned: { snapshot, receipt } };
    }
  }
  return inspection.entry !== null || receipt !== null ? { unproven: true } : null;
}

function connectorRemovalPhase(
  input: PackagedRemovalInput,
  state: RemovalState,
): PackagedRemovalPhases['connectors'] {
  const connectorById = new Map(input.connectors.map((connector) => [connector.id, connector]));
  const restoreEntry = async (connectorId: ConnectorId, value: unknown): Promise<void> => {
    if (!isRecord(value) || !isRecord(value.snapshot) || !isRecord(value.receipt)) {
      throw new Error(`Invalid ${connectorId} removal snapshot`);
    }
    await connectorById.get(connectorId)!.restore(value.snapshot as unknown as ConnectorSnapshot);
    await input.receiptStores
      .get(connectorId)!
      .write(value.receipt as unknown as ConnectionReceipt);
  };
  return {
    reconcileOwned: nothing,
    snapshotOwned: async () => ({}),
    planRemoval: async () => {
      const ownedEntries: Record<string, unknown> = {};
      const unprovenConnectorIds: string[] = [];
      for (const connector of input.connectors) {
        const classified = await classifyConnectorRemoval(
          connector,
          input.receiptStores.get(connector.id)!,
        );
        if (classified === null) continue;
        if ('owned' in classified) ownedEntries[connector.id] = classified.owned;
        else unprovenConnectorIds.push(connector.id);
      }
      return { ownedEntries, unprovenConnectorIds };
    },
    disconnectOwned: async (entries = {}) => {
      state.disconnectedConnectorIds = [];
      for (const connector of input.connectors) {
        if (!Object.hasOwn(entries, connector.id)) continue;
        state.disconnectedConnectorIds.push(connector.id);
        const result = await connector.disconnect();
        if (!result.changed) {
          throw new Error(`${connector.displayName} owned entry changed during removal`);
        }
      }
    },
    restoreOwned: async (entries) => {
      const failures = await collectFailures(
        [...state.disconnectedConnectorIds]
          .reverse()
          .map((connectorId) => () => restoreEntry(connectorId, entries[connectorId])),
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Agent connection removal rollback failed');
      }
    },
  };
}

function receiptRemovalPhase(
  input: PackagedRemovalInput,
  state: RemovalState,
): PackagedRemovalPhases['receipt'] {
  const receiptPath = installReceiptPath(input.dataDirectory);
  const snapshotOf = (receipt: InstallReceipt): InstallationSnapshot => ({
    runtimeVersion: receipt.version,
    serviceCommand: [receipt.nodePath, receipt.cliPath],
    connectorEntries: {},
    adapter: receipt.adapter,
    dataDirectory: receipt.dataDirectory,
    runtimeKind: 'packaged',
  });
  return {
    read: async () => snapshotOf(input.serviceReceipt),
    capture: async () => {
      state.capturedServiceReceipt = snapshotInstallReceipt(receiptPath, input.dataDirectory);
      if (state.capturedServiceReceipt === null) {
        throw new Error('Packaged service receipt disappeared during removal planning');
      }
      return {
        snapshot: snapshotOf(state.capturedServiceReceipt.receipt),
        contents: state.capturedServiceReceipt.contents,
      };
    },
    commit: async () => {
      throw new Error('Packaged removal cannot rewrite a semantic receipt snapshot');
    },
    restore: async ({ contents }) => {
      if (
        state.capturedServiceReceipt === null ||
        !Buffer.from(contents).equals(state.capturedServiceReceipt.contents)
      ) {
        throw new Error('Packaged service receipt rollback snapshot changed');
      }
      restoreInstallReceiptSnapshot(receiptPath, state.capturedServiceReceipt, input.dataDirectory);
    },
    remove: async () => {
      if (state.preparedService === null) {
        throw new Error('Packaged service removal was not prepared');
      }
      // The lifecycle engine merges these manual instructions with the connector ones.
      return state.preparedService.commit();
    },
  };
}

/**
 * The phases of `pimpampum uninstall` on a packaged install, sharing one state so a phase can undo
 * what an earlier one prepared. The engine calls them in this order: capture, plan, stop,
 * disconnect owned entries, remove the service, remove the runtime, remove the receipt, finalize;
 * and compensates in reverse.
 */
export function createPackagedRemovalPhases(input: PackagedRemovalInput): PackagedRemovalPhases {
  const state: RemovalState = {
    preparedService: null,
    preparedRuntime: null,
    capturedServiceReceipt: null,
    disconnectedConnectorIds: [],
  };
  return {
    runtime: runtimeRemovalPhase(input, state),
    service: serviceRemovalPhase(input, state),
    connectors: connectorRemovalPhase(input, state),
    receipt: receiptRemovalPhase(input, state),
  };
}

export function packagedUninstallResult(removed: {
  removed: boolean;
  manualInstructions: string[];
}): UninstallResult {
  return {
    uninstalled: removed.removed,
    dataPreserved: true,
    ...(removed.manualInstructions.length === 0
      ? {}
      : { manualInstructions: removed.manualInstructions }),
  };
}
