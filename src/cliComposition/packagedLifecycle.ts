/**
 * Wires the packaged install and removal transactions around the platform service manager, so
 * `pimpampum install` activates the private runtime first and `pimpampum uninstall` removes
 * runtime, service, agent entries and receipt as one lifecycle. The transactions themselves live in
 * `src/service/packagedLifecycle.ts`; this module only hands them the engine, the lock and the
 * connectors the composition built.
 */
import type { PackagedRuntimeBootstrap } from '../runtime/bootstrap.js';
import {
  createPackagedRemovalPhases,
  installPackagedService,
  isPackagedServiceReceipt,
  packagedUninstallResult,
} from '../service/packagedLifecycle.js';
import { installReceiptPath, readInstallReceipt } from '../service/receipt.js';
import type { RunCommand, ServiceManager, UninstallResult } from '../service/types.js';
import { createInstallationLifecycle } from '../setup/coordinator.js';
import { createSetupLifecycleLock } from '../setup/state.js';
import type { HostConnectorSet } from './connectorSetup.js';
import type { SupportedRuntimeTarget } from './host.js';

export interface PackagedCommandManagerInput {
  serviceManager: ServiceManager;
  /** `null` on an npm install: `install` then activates no runtime. */
  bootstrap: PackagedRuntimeBootstrap | null;
  homeDirectory: string;
  dataDirectory: string;
  target: SupportedRuntimeTarget;
  runCommand: RunCommand;
  connectors: HostConnectorSet;
}

function ownedRuntimeOf(input: PackagedCommandManagerInput) {
  return {
    homeDirectory: input.homeDirectory,
    dataDirectory: input.dataDirectory,
    platform: input.target.platform,
    architecture: input.target.architecture,
  };
}

/** A legacy npm receipt keeps the manager's own uninstall; a packaged one runs the full removal. */
async function uninstallPackaged(input: PackagedCommandManagerInput): Promise<UninstallResult> {
  const { serviceManager } = input;
  const serviceReceipt = readInstallReceipt(
    installReceiptPath(input.dataDirectory),
    input.dataDirectory,
  );
  if (!isPackagedServiceReceipt(serviceReceipt)) return serviceManager.uninstall();
  if (serviceManager.prepareUninstall === undefined) {
    throw new Error('Packaged service removal transaction is unavailable');
  }
  const removal = createInstallationLifecycle({
    dataDirectory: input.dataDirectory,
    homeDirectory: input.homeDirectory,
    lifecycleLock: createSetupLifecycleLock(input.dataDirectory),
    ...createPackagedRemovalPhases({
      serviceManager: { prepareUninstall: () => serviceManager.prepareUninstall!() },
      serviceReceipt,
      dataDirectory: input.dataDirectory,
      runtime: ownedRuntimeOf(input),
      connectors: input.connectors.ordered,
      receiptStores: input.connectors.receiptStores,
    }),
  });
  return packagedUninstallResult(await removal.remove());
}

/** The manager `install`, `status` and `uninstall` see on a host the packaged runtime ships for. */
export function createPackagedCommandServiceManager(
  input: PackagedCommandManagerInput,
): ServiceManager {
  const { serviceManager, bootstrap } = input;
  return {
    install: () =>
      bootstrap === null
        ? serviceManager.install()
        : installPackagedService({
            lock: createSetupLifecycleLock(input.dataDirectory),
            bootstrap,
            runCommand: input.runCommand,
            manager: serviceManager,
            runtime: ownedRuntimeOf(input),
          }),
    status: () => serviceManager.status(),
    uninstall: () => uninstallPackaged(input),
    ...(serviceManager.prepareUninstall
      ? { prepareUninstall: () => serviceManager.prepareUninstall!() }
      : {}),
  };
}
