import { existsSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

/**
 * Filesystem shape guards shared by the setup, service, runtime and sync layers. Every guard reads
 * with `lstat`, so a symbolic link is judged as a link and never as what it points to.
 */

export function assertNoSymlinkTraversal(path: string, label: string, trustedRoot = path): void {
  if (!isAbsolute(path) || path.includes('\0') || !isAbsolute(trustedRoot)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(trustedRoot);
  const child = relative(normalizedRoot, normalizedPath);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} must remain inside its trusted root`);
  }
  let current = normalizedRoot;
  const segments = child.split(sep).filter(Boolean);
  for (const segment of ['', ...segments]) {
    if (segment) current = join(current, segment);
    if (!existsSync(current)) return;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
  }
}

export function assertAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
}

function lstatExisting(path: string, label: string, kind: 'file' | 'directory'): Stats {
  assertAbsolutePath(path, label);
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} must be an existing ${kind}: ${path}`);
    }
    throw error;
  }
}

/**
 * Throws unless `metadata` describes a regular file. A directory carries `code: 'EISDIR'` so a
 * caller can branch on it exactly as on Node's own read error.
 */
export function assertRegularFileMetadata(metadata: Stats, label: string, path: string): void {
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (metadata.isFile()) return;
  const error: NodeJS.ErrnoException = new Error(`${label} must be a regular file: ${path}`);
  if (metadata.isDirectory()) error.code = 'EISDIR';
  throw error;
}

/** The path exists and is a regular file reached without following a link at its last segment. */
export function assertRegularFile(path: string, label: string): Stats {
  const metadata = lstatExisting(path, label, 'file');
  assertRegularFileMetadata(metadata, label, path);
  return metadata;
}

/** The path exists and is a directory, not a link to one. */
export function assertRegularDirectory(path: string, label: string): Stats {
  const metadata = lstatExisting(path, label, 'directory');
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a regular directory: ${path}`);
  return metadata;
}

export interface TreeEntry {
  /** Absolute path of the entry. */
  path: string;
  /** Path relative to the walked root with `/` separators, identical on every platform. */
  relativePath: string;
  name: string;
  kind: 'file' | 'directory';
  metadata: Stats;
}

export interface WalkRegularTreeOptions {
  /** Names the tree in error messages. Defaults to `Tree`. */
  label?: string;
  /** An entry for which this returns `true` is neither visited nor descended into. */
  skip?: (entry: TreeEntry) => boolean;
}

/**
 * Visits every file and directory under `root` in code-unit name order, parents before children.
 * A symbolic link, device, socket or FIFO anywhere in the tree aborts the walk: a payload that is
 * copied, hashed or installed may contain regular files and directories only.
 */
export function walkRegularTree(
  root: string,
  visit: (entry: TreeEntry) => void,
  options: WalkRegularTreeOptions = {},
): void {
  const label = options.label ?? 'Tree';
  assertRegularDirectory(root, label);
  const descend = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      const relativePath = relative(root, path).split(sep).join('/');
      if (metadata.isSymbolicLink()) {
        throw new Error(`${label} must not contain symbolic links: ${relativePath}`);
      }
      const kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : null;
      if (kind === null) {
        throw new Error(
          `${label} must contain only regular files and directories: ${relativePath}`,
        );
      }
      const entry: TreeEntry = { path, relativePath, name, kind, metadata };
      if (options.skip?.(entry)) continue;
      visit(entry);
      if (kind === 'directory') descend(path);
    }
  };
  descend(root);
}
