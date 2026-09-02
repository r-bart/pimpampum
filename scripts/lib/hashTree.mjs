// Symlink-rejecting tree walks and the canonical tree digest shared by the live runners and the
// evidence checkers. Every walker visits directory entries in sorted name order.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

/** The path of `path` below `root` with forward slashes, the way the digests record it. */
export function portableRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function defaultUnsafeEntry(path, kind) {
  return new Error(
    kind === 'symlink'
      ? `Tree contains a symlink: ${path}`
      : `Tree contains a non-regular file: ${path}`,
  );
}

/**
 * Walks `root` depth-first in sorted name order. `visitor.directory(path)` runs for the root and
 * every subdirectory before its entries are read; `visitor.file(path, metadata)` runs for every
 * regular file. Symlinks and special files stop the walk with `options.unsafeEntry(path, kind)`,
 * where `kind` is `'symlink'` or `'non-regular'`. Names in `options.skipNames` are ignored.
 */
export function walkTree(root, visitor, options = {}) {
  const { skipNames = [], unsafeEntry = defaultUnsafeEntry } = options;
  const visit = (directory) => {
    visitor.directory?.(directory);
    for (const name of readdirSync(directory).sort()) {
      if (skipNames.includes(name)) continue;
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw unsafeEntry(path, 'symlink');
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) visitor.file?.(path, metadata);
      else throw unsafeEntry(path, 'non-regular');
    }
  };
  visit(root);
}

/** Every regular file below `root` as `{ path, mode }`, in walk order. */
export function listRegularFiles(root, options = {}) {
  const files = [];
  walkTree(
    root,
    { file: (path, metadata) => files.push({ path, mode: metadata.mode & 0o777 }) },
    options,
  );
  return files;
}

/**
 * Digest of a file list: for each file, `relative path\0[mode\0]length\0contents\0`. The mode is
 * included only with `options.includeMode`. Files are hashed in the order given.
 */
export function hashFileList(root, files, options = {}) {
  const digest = createHash('sha256');
  for (const file of files) {
    const contents = readFileSync(file.path);
    digest.update(portableRelative(root, file.path));
    digest.update('\0');
    if (options.includeMode) {
      digest.update(String(file.mode));
      digest.update('\0');
    }
    digest.update(String(contents.length));
    digest.update('\0');
    digest.update(contents);
    digest.update('\0');
  }
  return digest.digest('hex');
}

/**
 * Canonical digest of a directory tree. Options: `includeMode` hashes each file's permission bits,
 * `sortFiles` orders the files by `localeCompare` of their absolute paths instead of walk order,
 * and `skipNames`/`unsafeEntry` are forwarded to `walkTree`.
 */
export function hashTree(root, options = {}) {
  const files = listRegularFiles(root, options);
  if (options.sortFiles) files.sort((left, right) => left.path.localeCompare(right.path));
  return hashFileList(root, files, options);
}
