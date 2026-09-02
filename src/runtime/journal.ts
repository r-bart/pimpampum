import { renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { assertRegularDirectory } from '../fsGuards.js';
import { isRecord } from '../objects.js';
import {
  assertPrivateMode,
  fail,
  journalPath,
  parseOwnedJson,
  pathEntryExists,
  privateDirectory,
  receiptPath,
  removalJournalPath,
  removeEmptyParents,
  restore,
  writeOwnedFile,
  type FileSnapshot,
} from './ownedFiles.js';
import {
  layoutFor,
  parseReceipt,
  readReceipt,
  repairOwnedLaunchers,
  verifyOwnedLaunchers,
} from './receipt.js';
import type { RuntimeHostInput, RuntimeInstallReceipt, RuntimeLayout } from './types.js';

/**
 * The two durable journals and their recovery. An activation journal is written before the first
 * destructive step of an install and a removal journal before the first quarantine rename; each
 * records what must be restored. Recovery is destructive by design, so it runs only from the
 * lifecycle-locked entry points in `install.ts` and `removal.ts`, never from `inspect.ts`.
 */

export const REMOVAL_QUARANTINE_NAME =
  /^\.pimpampum-remove-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u;

export interface ActivationJournal {
  schemaVersion: 1;
  /**
   * `committed` is written right after the receipt and before the quarantine is discarded. The
   * receipt alone cannot mark the commit point: a same-version repair rewrites it byte for byte.
   * Journals from earlier releases carry no phase and fall back to comparing the receipt.
   */
  phase: 'prepared' | 'committed';
  targetId: string;
  candidateVersion: string;
  finalDirectory: string;
  createdFinal: boolean;
  /**
   * Quarantined copy of a receipt-owned destination whose bytes drifted from the manifest. The
   * staged payload replaces it; rollback and interrupted-activation recovery rename it back.
   */
  replacedFinal: string | null;
  controlLauncher: FileSnapshot;
  mcpLauncher: FileSnapshot;
  receipt: FileSnapshot;
}

export interface RemovalJournal {
  schemaVersion: 1;
  phase: 'prepared' | 'committed';
  currentVersion: string;
  targetId: string;
  quarantineRoot: string;
  moved: { original: string; quarantined: string }[];
  controlLauncher: FileSnapshot;
  mcpLauncher: FileSnapshot;
  receipt: FileSnapshot;
}

export function quarantinedReplacementPath(quarantineRoot: string): string {
  return join(quarantineRoot, 'replaced');
}

export function writeActivationJournal(dataDirectory: string, journal: ActivationJournal): void {
  writeOwnedFile(journalPath(dataDirectory), `${JSON.stringify(journal)}\n`, 0o600);
}

export function writeRemovalJournal(dataDirectory: string, journal: RemovalJournal): void {
  writeOwnedFile(removalJournalPath(dataDirectory), `${JSON.stringify(journal)}\n`, 0o600);
}

/** One parser for the launcher and receipt snapshots of both journals. */
export function parseFileSnapshot(value: unknown, label: string): FileSnapshot {
  if (value === null) return null;
  if (!isRecord(value)) fail(`${label} snapshot is invalid`);
  const { content, mode } = value;
  if (
    typeof content !== 'string' ||
    (mode !== 0o600 && mode !== 0o755) ||
    Buffer.from(content, 'base64').toString('base64') !== content
  ) {
    fail(`${label} snapshot is invalid`);
  }
  return { content, mode };
}

function parseReplacedFinal(value: unknown, layout: RuntimeLayout): string | null {
  // Journals written before repair existed carry no field; treat them as plain activations.
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail('runtime activation journal schema is invalid');
  const quarantineRoot = dirname(value);
  if (
    value !== quarantinedReplacementPath(quarantineRoot) ||
    dirname(quarantineRoot) !== layout.versionsDirectory ||
    !REMOVAL_QUARANTINE_NAME.test(basename(quarantineRoot))
  ) {
    fail('runtime activation journal escapes the owned layout');
  }
  return value;
}

interface ParsedActivationJournal {
  journal: ActivationJournal;
  layout: RuntimeLayout;
  receipt: RuntimeInstallReceipt | null;
}

/** Reads and validates the activation journal in full; `null` when there is none. */
function readActivationJournal(host: RuntimeHostInput): ParsedActivationJournal | null {
  const path = journalPath(host.dataDirectory);
  const exists = pathEntryExists(path);
  const value = parseOwnedJson(path, 'Runtime activation journal');
  if (!exists) return null;
  assertPrivateMode(path, 'Runtime activation journal');
  if (!isRecord(value)) fail('runtime activation journal is invalid');
  const { candidateVersion, createdFinal, phase } = value;
  if (
    value.schemaVersion !== 1 ||
    typeof candidateVersion !== 'string' ||
    typeof createdFinal !== 'boolean' ||
    (phase !== undefined && phase !== 'prepared' && phase !== 'committed')
  ) {
    fail('runtime activation journal schema is invalid');
  }
  const layout = layoutFor(host, candidateVersion);
  if (value.targetId !== layout.targetId || value.finalDirectory !== layout.versionDirectory) {
    fail('runtime activation journal escapes the owned layout');
  }
  const replacedFinal = parseReplacedFinal(value.replacedFinal, layout);
  const receipt = readReceipt(host);
  const committedByReceipt =
    receipt?.currentVersion === candidateVersion && receipt.targetId === layout.targetId;
  const journal: ActivationJournal = {
    schemaVersion: 1,
    phase: phase ?? (committedByReceipt ? 'committed' : 'prepared'),
    targetId: layout.targetId,
    candidateVersion,
    finalDirectory: layout.versionDirectory,
    createdFinal,
    replacedFinal,
    controlLauncher: parseFileSnapshot(value.controlLauncher, 'Runtime activation journal'),
    mcpLauncher: parseFileSnapshot(value.mcpLauncher, 'Runtime activation journal'),
    receipt: parseFileSnapshot(value.receipt, 'Runtime activation journal'),
  };
  return { journal, layout, receipt };
}

/**
 * Undoes a drift repair: the payload that replaced the destination goes, the quarantined copy
 * returns. When the quarantine rename never happened the destination still holds the original
 * bytes and is left alone.
 */
function restoreReplacedFinal(layout: RuntimeLayout, replacedFinal: string): void {
  if (pathEntryExists(replacedFinal)) {
    if (pathEntryExists(layout.versionDirectory)) {
      assertRegularDirectory(layout.versionDirectory, 'Replaced runtime directory');
      rmSync(layout.versionDirectory, { recursive: true });
    }
    privateDirectory(dirname(layout.versionDirectory));
    renameSync(replacedFinal, layout.versionDirectory);
  }
  rmSync(dirname(replacedFinal), { recursive: true, force: true });
}

/** Removes a destination the interrupted activation created, if it got that far. */
function removeCreatedFinal(layout: RuntimeLayout): void {
  if (!pathEntryExists(layout.versionDirectory)) return;
  assertRegularDirectory(layout.versionDirectory, 'Interrupted runtime directory');
  rmSync(layout.versionDirectory, { recursive: true });
  removeEmptyParents(dirname(layout.versionDirectory), layout.runtimeDirectory);
}

/**
 * Undoes a prepared activation from its journal: launchers and receipt return to their snapshots,
 * a quarantined destination comes back or a created one goes, and the journal is removed last so a
 * failure anywhere above leaves it in place for the next locked entry point to retry.
 */
export function undoPreparedActivation(
  dataDirectory: string,
  layout: RuntimeLayout,
  journal: ActivationJournal,
): void {
  restore(layout.controlLauncherPath, journal.controlLauncher);
  restore(layout.mcpLauncherPath, journal.mcpLauncher);
  restore(receiptPath(dataDirectory), journal.receipt);
  if (journal.replacedFinal !== null) restoreReplacedFinal(layout, journal.replacedFinal);
  else if (journal.createdFinal) removeCreatedFinal(layout);
  rmSync(journalPath(dataDirectory), { force: true });
}

function finishCommittedActivation(
  dataDirectory: string,
  journal: ActivationJournal,
  receipt: RuntimeInstallReceipt | null,
): void {
  // The receipt is the commit point. Whatever happens to the launchers below, the journal must
  // go: a journal that survives a launcher fault would fail every later recovery attempt and
  // wedge install, status and uninstall alike.
  try {
    if (journal.replacedFinal !== null) {
      rmSync(dirname(journal.replacedFinal), { recursive: true, force: true });
    }
    if (receipt === null) fail('runtime activation journal committed without a receipt');
    try {
      verifyOwnedLaunchers(receipt);
    } catch {
      repairOwnedLaunchers(receipt);
    }
  } finally {
    rmSync(journalPath(dataDirectory), { force: true });
  }
}

/**
 * Finishes or undoes an activation that a crash interrupted. Destructive by design, so it runs
 * only from the lifecycle-locked entry points (`installRuntime`, `prepareOwnedRuntimeRemoval`),
 * never from a read-only inspection a concurrent `status` may trigger.
 */
export function recoverInterruptedActivation(host: RuntimeHostInput): void {
  const parsed = readActivationJournal(host);
  if (parsed === null) return;
  if (parsed.journal.phase === 'committed') {
    finishCommittedActivation(host.dataDirectory, parsed.journal, parsed.receipt);
  } else {
    undoPreparedActivation(host.dataDirectory, parsed.layout, parsed.journal);
  }
}

function parseRemovalReceipt(
  snapshot: FileSnapshot,
  host: RuntimeHostInput,
  currentVersion: string,
): RuntimeInstallReceipt {
  if (snapshot === null || snapshot.mode !== 0o600) {
    fail('runtime removal receipt snapshot is invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(snapshot.content, 'base64').toString('utf8'));
  } catch {
    fail('runtime removal receipt snapshot contains invalid JSON');
  }
  const receipt = parseReceipt(value, host);
  if (receipt === null || receipt.currentVersion !== currentVersion) {
    fail('runtime removal receipt snapshot does not match its journal');
  }
  return receipt;
}

function parseMovedEntries(
  entries: unknown[],
  quarantineRoot: string,
  ownedDirectories: ReadonlySet<string>,
): RemovalJournal['moved'] {
  const moved = entries.map((entry, index) => {
    const quarantined = join(quarantineRoot, String(index));
    if (
      !isRecord(entry) ||
      typeof entry.original !== 'string' ||
      entry.quarantined !== quarantined ||
      !ownedDirectories.has(entry.original)
    ) {
      fail('runtime removal journal contains an unowned path');
    }
    return { original: entry.original, quarantined };
  });
  if (new Set(moved.map(({ original }) => original)).size !== moved.length) {
    fail('runtime removal journal contains duplicate paths');
  }
  return moved;
}

function parseRemovalJournal(value: unknown, host: RuntimeHostInput): RemovalJournal {
  if (!isRecord(value)) fail('runtime removal journal is invalid');
  const { phase, currentVersion, targetId, quarantineRoot, moved } = value;
  if (
    value.schemaVersion !== 1 ||
    (phase !== 'prepared' && phase !== 'committed') ||
    typeof currentVersion !== 'string' ||
    typeof targetId !== 'string' ||
    typeof quarantineRoot !== 'string' ||
    !Array.isArray(moved)
  ) {
    fail('runtime removal journal schema is invalid');
  }
  const layout = layoutFor(host, currentVersion);
  if (
    targetId !== layout.targetId ||
    dirname(quarantineRoot) !== layout.versionsDirectory ||
    !REMOVAL_QUARANTINE_NAME.test(basename(quarantineRoot))
  ) {
    fail('runtime removal journal escapes the owned layout');
  }
  const receiptSnapshot = parseFileSnapshot(value.receipt, 'Runtime receipt');
  const receipt = parseRemovalReceipt(receiptSnapshot, host, currentVersion);
  const ownedDirectories = new Set(receipt.ownedVersions.map(({ directory }) => directory));
  return {
    schemaVersion: 1,
    phase,
    currentVersion,
    targetId,
    quarantineRoot,
    moved: parseMovedEntries(moved, quarantineRoot, ownedDirectories),
    controlLauncher: parseFileSnapshot(value.controlLauncher, 'Control launcher'),
    mcpLauncher: parseFileSnapshot(value.mcpLauncher, 'MCP launcher'),
    receipt: receiptSnapshot,
  };
}

/** Renames quarantined versions back, newest move first; both or neither present is corruption. */
function restoreQuarantinedVersions(moved: RemovalJournal['moved']): void {
  for (const entry of [...moved].reverse()) {
    if (!pathEntryExists(entry.quarantined)) {
      if (!pathEntryExists(entry.original)) {
        fail('runtime removal recovery found missing active and quarantined bytes');
      }
      continue;
    }
    if (pathEntryExists(entry.original)) {
      fail('runtime removal recovery found both active and quarantined bytes');
    }
    privateDirectory(dirname(entry.original));
    renameSync(entry.quarantined, entry.original);
  }
}

/** Under the lifecycle lock only: rolls back a prepared removal or discards a committed one. */
export function recoverInterruptedRuntimeRemoval(
  host: RuntimeHostInput,
): 'none' | 'rolled-back' | 'committed' {
  const path = removalJournalPath(host.dataDirectory);
  const exists = pathEntryExists(path);
  const value = parseOwnedJson(path, 'Runtime removal journal');
  if (!exists) return 'none';
  assertPrivateMode(path, 'Runtime removal journal');
  const journal = parseRemovalJournal(value, host);
  if (journal.phase === 'prepared') {
    restoreQuarantinedVersions(journal.moved);
    const layout = layoutFor(host, journal.currentVersion);
    restore(layout.controlLauncherPath, journal.controlLauncher);
    restore(layout.mcpLauncherPath, journal.mcpLauncher);
    restore(receiptPath(host.dataDirectory), journal.receipt);
  }
  rmSync(journal.quarantineRoot, { recursive: true, force: true });
  rmSync(path, { force: true });
  return journal.phase === 'prepared' ? 'rolled-back' : 'committed';
}
