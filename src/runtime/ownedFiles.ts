import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { readPrivateFileBounded, writePrivateFileAtomic } from '../fsAtomic.js';

/**
 * The files the runtime installer owns: the receipt and the two journals under the data directory,
 * the launchers, the staging markers. Every helper reads with `lstat`, writes through the shared
 * atomic primitive and forces the owner-only modes the installer promises. Nothing here decides
 * anything about an installation; the receipt, journal, install and removal modules do.
 */

const RECEIPT_NAME = 'runtime-install-receipt.json';
const JOURNAL_NAME = 'runtime-install-journal.json';
const REMOVAL_JOURNAL_NAME = 'runtime-removal-journal.json';
const MAXIMUM_METADATA_BYTES = 256 * 1024;

export type OwnedFileMode = 0o600 | 0o755;

/** Bytes and mode of an owned file before a mutation, or `null` when it did not exist. */
export type FileSnapshot = { content: string; mode: OwnedFileMode } | null;

export function fail(message: string): never {
  throw new Error(`Runtime installation failed: ${message}`);
}

export function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** `lstat`-based: a dangling symbolic link counts as present, which is what every caller wants. */
export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Creates the directory when missing and forces it to a regular, owner-only directory. */
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`private runtime path must be a regular directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

export function receiptPath(dataDirectory: string): string {
  return join(dataDirectory, RECEIPT_NAME);
}

export function journalPath(dataDirectory: string): string {
  return join(dataDirectory, JOURNAL_NAME);
}

export function removalJournalPath(dataDirectory: string): string {
  return join(dataDirectory, REMOVAL_JOURNAL_NAME);
}

/** The file's bytes, or `null` when absent. A link, a directory or anything over the cap fails. */
export function readOwnedMetadata(path: string, label: string): Buffer | null {
  if (!pathEntryExists(path)) return null;
  return readPrivateFileBounded(path, MAXIMUM_METADATA_BYTES, { label });
}

export function parseOwnedJson(path: string, label: string): unknown {
  const content = readOwnedMetadata(path, label);
  if (content === null) return null;
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    fail(`${label} contains invalid JSON`);
  }
}

/** Fails unless the existing owned file is readable by its owner only. */
export function assertPrivateMode(path: string, label: string): void {
  if ((statSync(path).mode & 0o777) !== 0o600) fail(`${label} must be private (0600)`);
}

export function snapshot(path: string, label: string): FileSnapshot {
  const content = readOwnedMetadata(path, label);
  if (content === null) return null;
  const mode = statSync(path).mode & 0o777;
  return { content: content.toString('base64'), mode: mode as OwnedFileMode };
}

/**
 * Atomic owner-only write of a launcher, receipt, journal or staging marker. The parent is forced
 * private first. A symbolic link at the destination is refused rather than replaced: the link is
 * somebody else's, and the installer only ever rewrites files it created.
 */
export function writeOwnedFile(path: string, content: Buffer | string, mode: OwnedFileMode): void {
  privateDirectory(dirname(path));
  if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) {
    fail(`refusing to replace symlink ${path}`);
  }
  writePrivateFileAtomic(path, content, { mode, label: 'Owned runtime file' });
}

/** Puts an owned file back to its snapshot; a `null` snapshot means it must not exist. */
export function restore(path: string, value: FileSnapshot): void {
  if (value === null) {
    rmSync(path, { force: true });
    return;
  }
  writeOwnedFile(path, Buffer.from(value.content, 'base64'), value.mode);
}

export function fsyncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Removes `path` and its ancestors up to (excluding) `stop` while they are empty. */
export function removeEmptyParents(path: string, stop: string): void {
  let current = path;
  while (current !== stop && current.startsWith(`${stop}${sep}`)) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
