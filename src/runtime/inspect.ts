import { lstatSync } from 'node:fs';

import { assertRegularDirectory } from '../fsGuards.js';
import { fail, journalPath, pathEntryExists } from './ownedFiles.js';
import { layoutFor, readReceipt, verifyOwnedLaunchers } from './receipt.js';
import type {
  RuntimeHostInput,
  RuntimeInstallReceipt,
  RuntimeInstallation,
  RuntimeOwnedVersion,
} from './types.js';

/**
 * Read-only view of the active runtime. It runs on every CLI start, including the `status` polls
 * of the desktop surfaces, so it must never recover a journal: a poll that lands between an
 * installer's journal write and its receipt write would otherwise undo the installation under the
 * installer's feet. This module therefore never imports `journal.ts`; recovery belongs to the
 * lifecycle-locked entry points in `install.ts` and `removal.ts`.
 */

export interface InstalledRuntimeInspection extends RuntimeInstallation {
  targetId: RuntimeOwnedVersion['targetId'];
  runtimeDirectory: string;
}

function verifyActiveLaunchers(receipt: RuntimeInstallReceipt, dataDirectory: string): void {
  try {
    verifyOwnedLaunchers(receipt);
  } catch (error) {
    if (pathEntryExists(journalPath(dataDirectory))) {
      throw new Error(
        'Runtime installation failed: runtime activation is in progress or was interrupted; run `pimpampum install` to finish it',
        { cause: error },
      );
    }
    throw error;
  }
}

function assertActiveEntrypoints(receipt: RuntimeInstallReceipt): void {
  for (const [path, label] of [
    [receipt.nodePath, 'Active Node entrypoint'],
    [receipt.cliPath, 'Active CLI entrypoint'],
    [receipt.mcpPath, 'Active MCP entrypoint'],
  ] as const) {
    if (!pathEntryExists(path)) fail(`${label} is missing`);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
    if (label === 'Active Node entrypoint' && (metadata.mode & 0o111) === 0) {
      fail('active Node entrypoint is not executable');
    }
  }
}

/** No lock needed: reads the receipt and verifies what it points at, mutating nothing. */
export function inspectInstalledRuntime(
  input: RuntimeHostInput,
): InstalledRuntimeInspection | null {
  const receipt = readReceipt(input);
  if (receipt === null) return null;
  verifyActiveLaunchers(receipt, input.dataDirectory);
  const layout = layoutFor(input, receipt.currentVersion);
  const owned = receipt.ownedVersions.find(
    (candidate) =>
      candidate.version === receipt.currentVersion && candidate.targetId === receipt.targetId,
  );
  if (owned?.directory !== layout.versionDirectory) {
    fail('runtime receipt does not own its active version directory');
  }
  assertRegularDirectory(owned.directory, 'Active runtime directory');
  assertActiveEntrypoints(receipt);
  return {
    activated: false,
    version: receipt.currentVersion,
    nodePath: receipt.nodePath,
    cliPath: receipt.cliPath,
    mcpLauncherPath: receipt.mcpLauncherPath,
    previousVersion: receipt.currentVersion,
    targetId: receipt.targetId,
    runtimeDirectory: owned.directory,
  };
}
