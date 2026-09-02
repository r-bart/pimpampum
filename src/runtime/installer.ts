/**
 * Public entry of the private runtime installer. Its import path is shared by the CLI, the setup
 * coordinator, the service adapters and the packaged bootstrap, so it re-exports the same names
 * with the same signatures while the work lives in modules split along the lifecycle-lock
 * boundary that Task 4.3 introduced:
 *
 * - `inspect.ts` is read-only and runs without the lock (every `status` poll does). It never
 *   imports `journal.ts`, so an inspection cannot recover, undo or finish an activation.
 * - `install.ts`, `removal.ts` and `journal.ts` mutate the receipt, the launchers and the version
 *   directories, and recover interrupted journals first. Their exports must run inside the
 *   lifecycle lock (`createSetupLifecycleLock(dataDirectory).run(...)`), which the composition
 *   layer acquires; this layer receives no lock handle and cannot check it.
 * - `receipt.ts`, `payload.ts` and `ownedFiles.ts` are the vocabulary both sides share.
 */

export type { RuntimeHostInput } from './types.js';
export { inspectInstalledRuntime, type InstalledRuntimeInspection } from './inspect.js';
export {
  installRuntime,
  installRuntimeTransaction,
  type InstallRuntimeInput,
  type RuntimeInstallationTransaction,
} from './install.js';
export {
  prepareOwnedRuntimeRemoval,
  pruneOwnedRuntimeVersions,
  type PreparedRuntimeRemoval,
  type PruneOwnedRuntimeInput,
} from './removal.js';
export { recoverInterruptedRuntimeRemoval } from './journal.js';
