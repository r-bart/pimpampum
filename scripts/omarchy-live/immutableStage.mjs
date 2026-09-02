// Production candidates are installed from a read-only copy of the repository tree and verified
// byte for byte against the receipt-owned artifacts afterwards, so a source edit between validation
// and install, or an installer transform, cannot pass unnoticed.

import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { executableHelpers } from '../check-omarchy-delivery.mjs';
import { parseJsonObject } from '../lib/cliEnvelope.mjs';
import { sha256, walkTree } from '../lib/hashTree.mjs';
import { ancestorDirectories, isInside, isRealDirectory, requireAbsolute } from '../lib/paths.mjs';
import {
  assertCandidateUnchanged,
  canonicalCandidateHash,
  makeTreeReadOnly,
  makeTreeWritable,
  unsafeEntryError,
} from './artifacts.mjs';

export async function prepareImmutableInstall(
  repositoryRoot,
  { candidatePath, cliPath, expectedCandidateHash },
) {
  const candidateChild = relative(repositoryRoot, candidatePath);
  if (!isInside(repositoryRoot, candidatePath, { allowSame: true })) {
    throw new Error('Candidate must be inside the repository for immutable staging');
  }
  assertCandidateUnchanged(candidatePath, expectedCandidateHash, 'before immutable staging');
  const stageRoot = mkdtempSync(join(tmpdir(), 'pimpampum-quattro-stage-'));
  try {
    const stagedCandidate = join(stageRoot, candidateChild);
    mkdirSync(dirname(stagedCandidate), { recursive: true });
    cpSync(candidatePath, stagedCandidate, { recursive: true });
    if (canonicalCandidateHash(stagedCandidate) !== expectedCandidateHash) {
      throw new Error('Immutable stage changed while it was copied');
    }
    makeTreeReadOnly(stageRoot);
    return {
      cliPath,
      candidatePath: stagedCandidate,
      async dispose() {
        makeTreeWritable(stageRoot);
        rmSync(stageRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    makeTreeWritable(stageRoot);
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function readInstallReceipt(layout, receiptPath) {
  const absoluteReceipt = requireAbsolute(receiptPath, 'Install receipt path');
  if (absoluteReceipt !== layout.receipt) {
    throw new Error('Install returned an unexpected receipt path');
  }
  for (const [label, path, anchor] of [
    ['receipt', absoluteReceipt, layout.dataDirectory],
    ['plugin', layout.plugin, layout.homeDirectory],
  ]) {
    for (const ancestor of ancestorDirectories(anchor, path)) {
      if (!isRealDirectory(ancestor)) {
        throw new Error(`Installed ${label} traverses an unsafe ancestor`);
      }
    }
  }
  const receiptMetadata = lstatSync(absoluteReceipt);
  if (receiptMetadata.isSymbolicLink() || !receiptMetadata.isFile()) {
    throw new Error('Install receipt must be a regular file');
  }
  const receiptContents = readFileSync(absoluteReceipt);
  if (receiptContents.length > 1024 * 1024) throw new Error('Install receipt is too large');
  const installedReceipt = parseJsonObject(receiptContents.toString('utf8'), 'install receipt');
  if (
    installedReceipt.schemaVersion !== 1 ||
    installedReceipt.adapter !== 'systemd-omarchy-quattro' ||
    installedReceipt.dataDirectory !== layout.dataDirectory ||
    !Array.isArray(installedReceipt.artifacts)
  ) {
    throw new Error(
      `Install receipt does not describe the expected Omarchy installation: ${JSON.stringify({
        schemaVersion: installedReceipt.schemaVersion,
        adapter: installedReceipt.adapter,
        dataDirectory: installedReceipt.dataDirectory,
        expectedDataDirectory: layout.dataDirectory,
        artifactsIsArray: Array.isArray(installedReceipt.artifacts),
      })}`,
    );
  }
  return installedReceipt;
}

/**
 * The installer copies every plugin byte verbatim (pluginArtifacts in src/service/omarchy.ts) and
 * marks exactly the delivery checker's helper list executable. Anything else on disk is drift,
 * whether the installer rewrote a helper or a later process touched the tree.
 */
function expectedPluginArtifacts(layout, stagedCandidatePath) {
  const expected = [];
  walkTree(
    stagedCandidatePath,
    {
      file: (source) => {
        const child = relative(stagedCandidatePath, source);
        expected.push({
          child,
          path: join(layout.plugin, child),
          contents: readFileSync(source),
          mode: executableHelpers.includes(child) ? 0o755 : 0o644,
        });
      },
    },
    { unsafeEntry: unsafeEntryError('Immutable candidate', false) },
  );
  return expected;
}

function installedPluginFiles(layout) {
  const actualPaths = [];
  walkTree(
    layout.plugin,
    {
      directory: (directory) => {
        if (!isRealDirectory(directory)) {
          throw new Error('Installed plugin tree contains an unsafe directory');
        }
      },
      file: (path) => actualPaths.push(path),
    },
    { unsafeEntry: unsafeEntryError('Installed plugin tree', false) },
  );
  return actualPaths;
}

function receiptArtifactIndex(installedReceipt) {
  const receiptArtifacts = new Map();
  for (const artifact of installedReceipt.artifacts) {
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      typeof artifact.path !== 'string' ||
      typeof artifact.sha256 !== 'string' ||
      !Number.isInteger(artifact.mode) ||
      receiptArtifacts.has(artifact.path)
    ) {
      throw new Error('Install receipt contains an invalid or duplicate artifact');
    }
    receiptArtifacts.set(artifact.path, artifact);
  }
  return receiptArtifacts;
}

function assertArtifactInstalled(artifact, receiptArtifacts) {
  const installed = lstatSync(artifact.path);
  const contents = readFileSync(artifact.path);
  const digest = sha256(artifact.contents);
  const owned = receiptArtifacts.get(artifact.path);
  if (
    installed.isSymbolicLink() ||
    !installed.isFile() ||
    (installed.mode & 0o777) !== artifact.mode ||
    !contents.equals(artifact.contents) ||
    owned?.sha256 !== digest ||
    owned?.mode !== artifact.mode
  ) {
    throw new Error(
      `Installed receipt-owned plugin differs from the staged candidate at ${artifact.child}`,
    );
  }
}

export async function verifyInstalledCandidate(
  layout,
  { stagedCandidatePath, expectedCandidateHash, receiptPath },
) {
  if (canonicalCandidateHash(stagedCandidatePath) !== expectedCandidateHash) {
    throw new Error('Immutable candidate changed before installed-artifact verification');
  }
  const installedReceipt = readInstallReceipt(layout, receiptPath);
  const expected = expectedPluginArtifacts(layout, stagedCandidatePath);
  const actualPaths = installedPluginFiles(layout);
  const receiptArtifacts = receiptArtifactIndex(installedReceipt);
  if (
    actualPaths.length !== expected.length ||
    !actualPaths.every((path) => expected.some((artifact) => artifact.path === path))
  ) {
    throw new Error('Installed plugin tree differs from the immutable candidate');
  }
  for (const artifact of expected) assertArtifactInstalled(artifact, receiptArtifacts);
}
