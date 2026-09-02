import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  assertAbsolutePath,
  assertNoSymlinkTraversal,
  assertRegularDirectory,
  assertRegularFile,
  assertRegularFileMetadata,
} from './fsGuards.js';

/**
 * One atomic private write and one bounded private read for every file Pimpampum owns: receipts,
 * journals, settings, snapshots and connector configurations. The write publishes through an
 * exclusive, unpredictable temporary name and a rename; the read opens with `O_NOFOLLOW`, checks
 * the descriptor it actually holds and never reads more than the caller allows.
 */

export const DEFAULT_PRIVATE_FILE_MODE = 0o600;

const READ_CHUNK_BYTES = 65_536;

export interface WritePrivateFileAtomicOptions {
  /** Permission bits of the published file, applied to the descriptor before it closes. */
  mode?: number;
  /** fsync the file before the rename and its directory after it. Off only for scratch data. */
  fsync?: boolean;
  /** When given, missing parent directories are created with this mode; otherwise the parent must exist. */
  directoryMode?: number;
  /** Names the file in error messages. */
  label?: string;
  /**
   * When given, every segment from this root down to the parent directory must be a regular
   * directory: the check runs before the parent is created, after it, and again right before the
   * rename, so a link planted between validation and publication is refused rather than followed.
   */
  trustedRoot?: string;
}

export interface ReadPrivateFileBoundedOptions {
  /** Refuse a symbolic link at `path`. With `false` the link is followed; the target must still be a regular file. */
  noFollow?: boolean;
  /** Names the file in error messages. */
  label?: string;
}

/** `null` when the target does not exist yet; otherwise its metadata, which must describe a regular file. */
function lstatTarget(path: string, label: string): Stats | null {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  assertRegularFileMetadata(metadata, label, path);
  return metadata;
}

function sameIdentity(previous: Stats | null, current: Stats | null): boolean {
  if (previous === null) return current === null;
  return current !== null && current.dev === previous.dev && current.ino === previous.ino;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Writes `contents` so that `path` holds either its previous bytes or the new ones, never a torn
 * mix. The temporary file is created with `O_CREAT | O_EXCL | O_NOFOLLOW` under a name that carries
 * the pid and a UUID, so two writers never share a partial and a planted link is never followed.
 * The target is re-read right before the rename: a file that appeared, vanished or changed identity
 * since the first look belongs to someone else and the write refuses to clobber it.
 */
export function writePrivateFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: WritePrivateFileAtomicOptions = {},
): void {
  const {
    mode = DEFAULT_PRIVATE_FILE_MODE,
    fsync = true,
    directoryMode,
    label = 'Private file',
    trustedRoot,
  } = options;
  assertAbsolutePath(path, label);
  const directory = dirname(path);
  const guardParent = (): void => {
    if (trustedRoot !== undefined) {
      assertNoSymlinkTraversal(directory, `${label} parent`, trustedRoot);
    }
  };
  guardParent();
  if (directoryMode !== undefined) mkdirSync(directory, { recursive: true, mode: directoryMode });
  assertRegularDirectory(directory, `${label} parent`);
  guardParent();
  const previous = lstatTarget(path, label);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, mode);
    if (fsync) fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (!sameIdentity(previous, lstatTarget(path, label))) {
      throw new Error(`${label} changed concurrently: ${path}`);
    }
    guardParent();
    renameSync(temporaryPath, path);
    if (fsync) fsyncDirectory(directory);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * Reads at most `maxBytes` from a regular file. The size is enforced on the bytes actually read,
 * not on a stat taken earlier, so a file that grows under the reader is still refused. A directory
 * is reported with `code: 'EISDIR'`.
 */
export function readPrivateFileBounded(
  path: string,
  maxBytes: number,
  options: ReadPrivateFileBoundedOptions = {},
): Buffer {
  const { noFollow = true, label = 'Private file' } = options;
  assertAbsolutePath(path, label);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`${label} size limit must be a non-negative integer`);
  }
  if (noFollow) assertRegularFile(path, label);
  const descriptor = openSync(path, constants.O_RDONLY | (noFollow ? constants.O_NOFOLLOW : 0));
  try {
    assertRegularFileMetadata(fstatSync(descriptor), label, path);
    const chunk = Buffer.allocUnsafe(Math.min(maxBytes + 1, READ_CHUNK_BYTES));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`${label} exceeds the size limit: ${path}`);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(descriptor);
  }
}
