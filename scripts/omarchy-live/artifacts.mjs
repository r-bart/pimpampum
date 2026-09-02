// Filesystem helpers of the Quattro live smoke: the canonical candidate digest, the read-only
// staging tree, PNG checks, and the atomic artifact writes that keep the evidence directory safe
// against symlinks and half-written files.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hashTree, walkTree } from '../lib/hashTree.mjs';
import { isInside, isRealDirectory } from '../lib/paths.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A `walkTree` unsafe-entry factory whose message names `subject`, with or without the path. */
export function unsafeEntryError(subject, withPath = true) {
  return (path, kind) => {
    const what = kind === 'symlink' ? 'a symlink' : 'a non-regular file';
    return new Error(
      withPath ? `${subject} contains ${what}: ${path}` : `${subject} contains ${what}`,
    );
  };
}

/** The digest `check-quattro-evidence.mjs` recomputes: sorted paths, `.git` skipped, no modes. */
export function canonicalCandidateHash(directory) {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Quattro candidate must be a real directory');
  }
  return hashTree(directory, {
    skipNames: ['.git'],
    sortFiles: true,
    unsafeEntry: unsafeEntryError('Candidate'),
  });
}

export function assertCandidateUnchanged(candidatePath, expectedHash, stage) {
  const actualHash = canonicalCandidateHash(candidatePath);
  if (actualHash !== expectedHash) {
    throw new Error(`Quattro candidate changed ${stage}`);
  }
}

export function makeTreeReadOnly(root) {
  const directories = [];
  walkTree(
    root,
    {
      directory: (directory) => directories.push(directory),
      file: (path) => chmodSync(path, 0o400),
    },
    { unsafeEntry: unsafeEntryError('Immutable stage') },
  );
  for (const directory of directories.reverse()) chmodSync(directory, 0o500);
}

export function makeTreeWritable(root) {
  if (!existsSync(root)) return;
  const visit = (directory) => {
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) visit(path);
    }
  };
  visit(root);
}

/** Moves stale canonical evidence aside before the run mutates the host; returns the new path. */
export function invalidateExistingEvidence(evidencePath) {
  if (!existsSync(evidencePath)) return null;
  const metadata = lstatSync(evidencePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Existing canonical evidence is unsafe: ${evidencePath}`);
  }
  const archivedPath = `${evidencePath}.invalidated-${Date.now()}-${randomUUID()}`;
  renameSync(evidencePath, archivedPath);
  return archivedPath;
}

export function readPng(path, label) {
  const metadata = lstatSync(path);
  const contents = readFileSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    contents.length < 1_000 ||
    !contents.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`${label} is not a substantial regular PNG: ${path}`);
  }
  return contents;
}

export function ensurePng(path, artifactRoot) {
  const absolute = realpathSync(path);
  if (!isInside(realpathSync(artifactRoot), absolute)) {
    throw new Error(`Screenshot escaped its artifact directory: ${path}`);
  }
  return readPng(path, 'Screenshot');
}

export function ensureRealDirectory(path, label) {
  if (existsSync(path)) {
    if (!isRealDirectory(path)) throw new Error(`${label} must be a regular directory`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

export function writeArtifactAtomic(path, contents) {
  const directory = dirname(path);
  ensureRealDirectory(directory, 'Artifact directory');
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Refusing to replace an unsafe artifact: ${path}`);
    }
  }
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function writeEvidenceAtomic(path, evidence) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, json(evidence), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
