import { randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { runCompensationSync } from '../aggregateRollback.js';
import { assertRegularDirectory } from '../fsGuards.js';
import {
  quarantinedReplacementPath,
  recoverInterruptedActivation,
  recoverInterruptedRuntimeRemoval,
  undoPreparedActivation,
  writeActivationJournal,
  type ActivationJournal,
} from './journal.js';
import { createRuntimeLaunchers } from './launchers.js';
import { parseRuntimeManifest } from './manifest.js';
import {
  fail,
  fsyncPath,
  hash,
  journalPath,
  pathEntryExists,
  privateDirectory,
  receiptPath,
  removeEmptyParents,
  restore,
  snapshot,
  writeOwnedFile,
} from './ownedFiles.js';
import {
  STAGING_PREFIX,
  cleanOwnedStaging,
  copyRuntimeTree,
  entrypointPaths,
  fsyncRuntimeTree,
  runtimeTreeDrifted,
  validateRuntimeTree,
  writeStagingMarker,
  type RuntimeEntrypointPaths,
} from './payload.js';
import {
  assertLauncherOwnership,
  layoutFor,
  ownedVersionsWith,
  readReceipt,
  verifyOwnedLaunchers,
  writeReceipt,
} from './receipt.js';
import type {
  RuntimeHostInput,
  RuntimeInstallReceipt,
  RuntimeInstallation,
  RuntimeLaunchers,
  RuntimeLayout,
  RuntimeManifest,
} from './types.js';

/**
 * Installation of a validated runtime payload. Every export runs under the lifecycle lock: the
 * entry points recover interrupted journals first, and the activation is journaled so a crash at
 * any point leaves either the previous installation or the new one, never a mix.
 */

const MAXIMUM_UNPACKED_BYTES = 175 * 1024 * 1024;

export interface InstallRuntimeInput extends RuntimeHostInput {
  sourceDirectory: string;
  manifest: RuntimeManifest;
  smoke(installation: RuntimeInstallation): Promise<void>;
}

export interface RuntimeInstallationTransaction {
  installation: RuntimeInstallation;
  commit(): void;
  rollback(): void;
}

/** Everything `installRuntime` decides before it stages a single byte. */
interface InstallPlan {
  host: RuntimeHostInput;
  manifest: RuntimeManifest;
  layout: RuntimeLayout;
  sourceDirectory: string;
  previousReceipt: RuntimeInstallReceipt | null;
  finalExists: boolean;
  finalDrifted: boolean;
  final: RuntimeEntrypointPaths;
  finalLaunchers: RuntimeLaunchers;
}

interface StagedPayload {
  payload: string;
  entrypoints: RuntimeEntrypointPaths;
  mcpLauncherPath: string;
}

function parseManifest(
  input: Pick<InstallRuntimeInput, 'manifest' | 'platform' | 'architecture'>,
): RuntimeManifest {
  return parseRuntimeManifest(input.manifest, {
    platform: input.platform,
    architecture: input.architecture,
    maximumUnpackedBytes: MAXIMUM_UNPACKED_BYTES,
  });
}

/**
 * Preflight, recovery and identity inputs. The on-disk destination is hashed in full here so that
 * drift is never mistaken for identity, and before anything is copied so that a no-op reinstall
 * costs no 175 MB copy and no smoke run.
 */
function planInstall(input: InstallRuntimeInput): InstallPlan {
  assertRegularDirectory(resolve(input.sourceDirectory), 'Runtime source');
  if (!isAbsolute(input.dataDirectory)) fail('Data directory must be absolute');
  privateDirectory(input.dataDirectory);
  recoverInterruptedRuntimeRemoval(input);
  recoverInterruptedActivation(input);
  const manifest = parseManifest(input);
  const layout = layoutFor(input, manifest.pimpampumVersion);
  const sourceDirectory = resolve(input.sourceDirectory);
  validateRuntimeTree(sourceDirectory, manifest);
  const previousReceipt = readReceipt(input);
  assertLauncherOwnership(layout, previousReceipt);
  cleanOwnedStaging(dirname(layout.versionDirectory));
  const finalExists = pathEntryExists(layout.versionDirectory);
  const previouslyOwned =
    previousReceipt?.ownedVersions.some(
      (owned) => owned.version === manifest.pimpampumVersion && owned.targetId === layout.targetId,
    ) ?? false;
  let finalDrifted = false;
  if (finalExists) {
    if (!previouslyOwned) fail('runtime destination exists without an ownership receipt');
    assertRegularDirectory(layout.versionDirectory, 'Runtime destination');
    finalDrifted = runtimeTreeDrifted(layout.versionDirectory, manifest);
  }
  const final = entrypointPaths(layout.versionDirectory, manifest);
  return {
    host: input,
    manifest,
    layout,
    sourceDirectory,
    previousReceipt,
    finalExists,
    finalDrifted,
    final,
    finalLaunchers: createRuntimeLaunchers(final),
  };
}

/** A destination holding the manifest's exact bytes behind the receipt's exact launchers is a no-op. */
function identicalInstallation(plan: InstallPlan): RuntimeInstallation | null {
  const { previousReceipt, manifest, finalLaunchers } = plan;
  if (
    !plan.finalExists ||
    plan.finalDrifted ||
    previousReceipt?.currentVersion !== manifest.pimpampumVersion ||
    hash(finalLaunchers.control) !== previousReceipt.controlLauncherSha256 ||
    hash(finalLaunchers.mcp) !== previousReceipt.mcpLauncherSha256
  ) {
    return null;
  }
  return {
    activated: false,
    version: manifest.pimpampumVersion,
    nodePath: plan.final.nodePath,
    cliPath: plan.final.cliPath,
    mcpLauncherPath: plan.layout.mcpLauncherPath,
    previousVersion: previousReceipt.currentVersion,
  };
}

/** Copies the validated tree beside the destination, renders launchers against it, runs the smoke. */
async function stagePayload(
  plan: InstallPlan,
  stagingRoot: string,
  smoke: InstallRuntimeInput['smoke'],
): Promise<StagedPayload> {
  privateDirectory(stagingRoot);
  writeStagingMarker(stagingRoot);
  const payload = join(stagingRoot, 'payload');
  copyRuntimeTree(plan.sourceDirectory, payload, plan.manifest);
  const entrypoints = entrypointPaths(payload, plan.manifest);
  const launchers = createRuntimeLaunchers(entrypoints);
  const launcherDirectory = join(stagingRoot, 'launchers');
  privateDirectory(launcherDirectory);
  const mcpLauncherPath = join(launcherDirectory, 'pimpampum-mcp');
  writeOwnedFile(join(launcherDirectory, 'pimpampum-control'), launchers.control, 0o755);
  writeOwnedFile(mcpLauncherPath, launchers.mcp, 0o755);
  await smoke({
    activated: false,
    version: plan.manifest.pimpampumVersion,
    nodePath: entrypoints.nodePath,
    cliPath: entrypoints.cliPath,
    mcpLauncherPath,
    previousVersion: plan.previousReceipt?.currentVersion ?? null,
  });
  return { payload, entrypoints, mcpLauncherPath };
}

/**
 * Moves the smoked payload into place behind a journal. A receipt-owned destination whose bytes
 * drifted is repaired, not refused: it moves into a quarantine the journal records, the payload
 * takes its place, and any failure before the receipt commits renames the quarantined copy back.
 */
function activateStaged(plan: InstallPlan, staged: StagedPayload): RuntimeInstallation {
  const { host, layout, manifest, previousReceipt, final, finalLaunchers } = plan;
  const replaceFinal = plan.finalExists && plan.finalDrifted;
  const quarantineRoot = replaceFinal
    ? join(layout.versionsDirectory, `.pimpampum-remove-${randomUUID()}`)
    : null;
  privateDirectory(layout.launchersDirectory);
  const journal: ActivationJournal = {
    schemaVersion: 1,
    phase: 'prepared',
    targetId: layout.targetId,
    candidateVersion: manifest.pimpampumVersion,
    finalDirectory: layout.versionDirectory,
    createdFinal: !plan.finalExists || replaceFinal,
    replacedFinal: quarantineRoot === null ? null : quarantinedReplacementPath(quarantineRoot),
    controlLauncher: snapshot(layout.controlLauncherPath, 'Control launcher'),
    mcpLauncher: snapshot(layout.mcpLauncherPath, 'MCP launcher'),
    receipt: snapshot(receiptPath(host.dataDirectory), 'Runtime receipt'),
  };
  writeActivationJournal(host.dataDirectory, journal);
  try {
    if (journal.replacedFinal !== null) {
      privateDirectory(dirname(journal.replacedFinal));
      renameSync(layout.versionDirectory, journal.replacedFinal);
    }
    if (journal.createdFinal) {
      fsyncRuntimeTree(staged.payload, manifest);
      renameSync(staged.payload, layout.versionDirectory);
      fsyncPath(dirname(layout.versionDirectory));
    }
    writeOwnedFile(layout.controlLauncherPath, finalLaunchers.control, 0o755);
    writeOwnedFile(layout.mcpLauncherPath, finalLaunchers.mcp, 0o755);
    writeReceipt(host.dataDirectory, {
      schemaVersion: 1,
      currentVersion: manifest.pimpampumVersion,
      targetId: layout.targetId,
      ...final,
      controlLauncherPath: layout.controlLauncherPath,
      controlLauncherSha256: hash(finalLaunchers.control),
      mcpLauncherPath: layout.mcpLauncherPath,
      mcpLauncherSha256: hash(finalLaunchers.mcp),
      ownedVersions: ownedVersionsWith(
        previousReceipt,
        manifest.pimpampumVersion,
        layout.targetId,
        layout.versionDirectory,
      ),
    });
    writeActivationJournal(host.dataDirectory, { ...journal, phase: 'committed' });
    if (quarantineRoot !== null) rmSync(quarantineRoot, { recursive: true, force: true });
    rmSync(journalPath(host.dataDirectory), { force: true });
  } catch (error) {
    runCompensationSync(
      error,
      [() => undoPreparedActivation(host.dataDirectory, layout, journal)],
      'Runtime activation and its rollback failed',
    );
  }
  return {
    activated: true,
    version: manifest.pimpampumVersion,
    nodePath: final.nodePath,
    cliPath: final.cliPath,
    mcpLauncherPath: layout.mcpLauncherPath,
    previousVersion: previousReceipt?.currentVersion ?? null,
  };
}

/** Under the lifecycle lock only. */
export async function installRuntime(input: InstallRuntimeInput): Promise<RuntimeInstallation> {
  const plan = planInstall(input);
  const identical = identicalInstallation(plan);
  if (identical !== null) return identical;
  const versionRoot = dirname(plan.layout.versionDirectory);
  privateDirectory(versionRoot);
  const stagingRoot = join(versionRoot, `${STAGING_PREFIX}${randomUUID()}`);
  try {
    const staged = await stagePayload(plan, stagingRoot, input.smoke);
    return activateStaged(plan, staged);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    removeEmptyParents(versionRoot, plan.layout.runtimeDirectory);
  }
}

/**
 * Under the lifecycle lock only. Wraps `installRuntime` in a handle whose `rollback` restores the
 * launchers and receipt captured before the install and removes a version directory it created.
 */
export async function installRuntimeTransaction(
  input: InstallRuntimeInput,
): Promise<RuntimeInstallationTransaction> {
  const manifest = parseManifest(input);
  const layout = layoutFor(input, manifest.pimpampumVersion);
  recoverInterruptedRuntimeRemoval(input);
  recoverInterruptedActivation(input);
  const previousReceipt = readReceipt(input);
  assertLauncherOwnership(layout, previousReceipt);
  const previousControlLauncher = snapshot(layout.controlLauncherPath, 'Control launcher');
  const previousMcpLauncher = snapshot(layout.mcpLauncherPath, 'MCP launcher');
  const previousReceiptFile = snapshot(receiptPath(input.dataDirectory), 'Runtime receipt');
  const candidateExisted = pathEntryExists(layout.versionDirectory);
  const installation = await installRuntime(input);
  let finished = false;
  const rollbackActivation = (): void => {
    const current = readReceipt(input);
    if (current === null || current.currentVersion !== installation.version) {
      fail('runtime changed before activation rollback');
    }
    verifyOwnedLaunchers(current);
    restore(layout.controlLauncherPath, previousControlLauncher);
    restore(layout.mcpLauncherPath, previousMcpLauncher);
    restore(receiptPath(input.dataDirectory), previousReceiptFile);
    if (!candidateExisted && pathEntryExists(layout.versionDirectory)) {
      assertRegularDirectory(layout.versionDirectory, 'Rolled back runtime directory');
      rmSync(layout.versionDirectory, { recursive: true });
      removeEmptyParents(dirname(layout.versionDirectory), layout.runtimeDirectory);
    }
  };
  return {
    installation,
    commit() {
      finished = true;
    },
    rollback() {
      if (finished) return;
      if (installation.activated) rollbackActivation();
      finished = true;
    },
  };
}
