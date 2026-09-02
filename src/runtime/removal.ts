import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runCompensationSync } from '../aggregateRollback.js';
import {
  recoverInterruptedActivation,
  recoverInterruptedRuntimeRemoval,
  writeRemovalJournal,
  type RemovalJournal,
} from './journal.js';
import {
  fail,
  pathEntryExists,
  privateDirectory,
  receiptPath,
  removalJournalPath,
  removeEmptyParents,
  restore,
  snapshot,
} from './ownedFiles.js';
import { layoutFor, readReceipt, verifyOwnedLaunchers, writeReceipt } from './receipt.js';
import type {
  RuntimeHostInput,
  RuntimeInstallReceipt,
  RuntimeLayout,
  RuntimeOwnedVersion,
} from './types.js';

/**
 * Removal of receipt-owned runtimes: pruning of inactive versions and the journaled, two-phase
 * removal of everything the receipt owns. Every export runs under the lifecycle lock.
 */

export interface PruneOwnedRuntimeInput extends RuntimeHostInput {
  keepVersions?: string[];
}

export interface PreparedRuntimeRemoval {
  commit(): void;
  rollback(): void;
}

/** `false` when the owned directory is gone; anything present that is not a plain directory fails. */
function ownedDirectoryPresent(directory: string): boolean {
  if (!pathEntryExists(directory)) return false;
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('owned runtime path is unsafe');
  return true;
}

/** Under the lifecycle lock only: deletes owned versions other than the active and kept ones. */
export function pruneOwnedRuntimeVersions(input: PruneOwnedRuntimeInput): string[] {
  const receipt = readReceipt(input);
  if (receipt === null) return [];
  verifyOwnedLaunchers(receipt);
  const keep = new Set([receipt.currentVersion, ...(input.keepVersions ?? [])]);
  const removed: string[] = [];
  const retained: RuntimeOwnedVersion[] = [];
  for (const owned of receipt.ownedVersions) {
    if (keep.has(owned.version)) {
      retained.push(owned);
      continue;
    }
    if (ownedDirectoryPresent(owned.directory)) {
      rmSync(owned.directory, { recursive: true });
      removeEmptyParents(
        dirname(owned.directory),
        layoutFor(input, owned.version).runtimeDirectory,
      );
    }
    removed.push(owned.version);
  }
  if (removed.length > 0)
    writeReceipt(input.dataDirectory, { ...receipt, ownedVersions: retained });
  return removed;
}

interface RemovalState {
  host: RuntimeHostInput;
  receipt: RuntimeInstallReceipt;
  layout: RuntimeLayout;
  journal: RemovalJournal;
  finished: boolean;
}

/** Snapshots what the removal will destroy and writes the journal; nothing is moved yet. */
function planRemoval(host: RuntimeHostInput, receipt: RuntimeInstallReceipt): RemovalState {
  const receiptSnapshot = snapshot(receiptPath(host.dataDirectory), 'Runtime receipt');
  const controlSnapshot = snapshot(receipt.controlLauncherPath, 'Control launcher');
  const mcpSnapshot = snapshot(receipt.mcpLauncherPath, 'MCP launcher');
  const layout = layoutFor(host, receipt.currentVersion);
  privateDirectory(layout.versionsDirectory);
  const quarantineRoot = join(layout.versionsDirectory, `.pimpampum-remove-${randomUUID()}`);
  privateDirectory(quarantineRoot);
  const moved = receipt.ownedVersions
    .filter((owned) => ownedDirectoryPresent(owned.directory))
    .map((owned, index) => ({
      original: owned.directory,
      quarantined: join(quarantineRoot, String(index)),
    }));
  const journal: RemovalJournal = {
    schemaVersion: 1,
    phase: 'prepared',
    currentVersion: receipt.currentVersion,
    targetId: receipt.targetId,
    quarantineRoot,
    moved,
    controlLauncher: controlSnapshot,
    mcpLauncher: mcpSnapshot,
    receipt: receiptSnapshot,
  };
  try {
    writeRemovalJournal(host.dataDirectory, journal);
  } catch (error) {
    rmSync(quarantineRoot, { recursive: true, force: true });
    throw error;
  }
  return { host, receipt, layout, journal, finished: false };
}

function rollbackRemoval(state: RemovalState): void {
  if (state.finished) return;
  const { host, receipt, journal } = state;
  for (const entry of [...journal.moved].reverse()) {
    if (!pathEntryExists(entry.quarantined)) continue;
    if (pathEntryExists(entry.original)) {
      fail('runtime removal rollback destination already exists');
    }
    renameSync(entry.quarantined, entry.original);
  }
  restore(receipt.controlLauncherPath, journal.controlLauncher);
  restore(receipt.mcpLauncherPath, journal.mcpLauncher);
  restore(receiptPath(host.dataDirectory), journal.receipt);
  rmSync(journal.quarantineRoot, { recursive: true, force: true });
  rmSync(removalJournalPath(host.dataDirectory), { force: true });
  state.finished = true;
}

/** Removes a directory the removal emptied; a non-empty shared directory holds user content. */
function removeDirectoryIfEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Preserve a non-empty launcher or runtime root containing unreceipted or user content.
  }
}

function commitRemoval(state: RemovalState): void {
  if (state.finished) return;
  const { host, layout, journal } = state;
  writeRemovalJournal(host.dataDirectory, { ...journal, phase: 'committed' });
  rmSync(journal.quarantineRoot, { recursive: true });
  for (const entry of journal.moved) {
    removeEmptyParents(dirname(entry.original), layout.runtimeDirectory);
  }
  removeDirectoryIfEmpty(layout.launchersDirectory);
  removeDirectoryIfEmpty(layout.runtimeDirectory);
  rmSync(removalJournalPath(host.dataDirectory), { force: true });
  state.finished = true;
}

/** Quarantines every present owned version and removes launchers and receipt; a fault rolls back. */
function quarantineOwnedVersions(state: RemovalState): void {
  const { host, receipt, journal } = state;
  try {
    for (const entry of journal.moved) renameSync(entry.original, entry.quarantined);
    rmSync(receipt.controlLauncherPath, { force: true });
    rmSync(receipt.mcpLauncherPath, { force: true });
    rmSync(receiptPath(host.dataDirectory), { force: true });
  } catch (error) {
    runCompensationSync(
      error,
      [() => rollbackRemoval(state)],
      'Runtime removal and rollback failed',
    );
  }
}

/**
 * Under the lifecycle lock only. Moves everything the receipt owns into a quarantine and returns a
 * handle: `commit` discards the quarantine, `rollback` renames it back. `null` without a receipt.
 */
export function prepareOwnedRuntimeRemoval(input: RuntimeHostInput): PreparedRuntimeRemoval | null {
  recoverInterruptedRuntimeRemoval(input);
  recoverInterruptedActivation(input);
  const receipt = readReceipt(input);
  if (receipt === null) return null;
  verifyOwnedLaunchers(receipt);
  const state = planRemoval(input, receipt);
  quarantineOwnedVersions(state);
  return {
    commit: () => commitRemoval(state),
    rollback: () => rollbackRemoval(state),
  };
}
