// Path containment and evidence-location safety shared by the live runners and checkers.

import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * True when `child` lies below `parent`. The same path counts only with `options.allowSame`.
 * Both paths must already be absolute; nothing is resolved against the filesystem.
 */
export function isInside(parent, child, options = {}) {
  const fromParent = relative(parent, child);
  if (fromParent === '') return options.allowSame === true;
  return !(fromParent === '..' || fromParent.startsWith(`..${sep}`) || isAbsolute(fromParent));
}

export function requireAbsolute(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error(`${label} must be absolute`);
  }
  return resolve(path);
}

/**
 * The directories from `anchor` down to the parent of `path`, inclusive: `[anchor, anchor/a,
 * anchor/a/b]` for `anchor/a/b/file`. `path` must lie inside `anchor`.
 */
export function ancestorDirectories(anchor, path) {
  const directories = [anchor];
  let current = anchor;
  for (const segment of relative(anchor, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, segment);
    directories.push(current);
  }
  return directories;
}

/** True when `path` exists and is a directory that is not a symlink. Throws when it is missing. */
export function isRealDirectory(path) {
  const metadata = lstatSync(path);
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

/** True when `path` exists and is a regular file that is not a symlink. Throws when it is missing. */
export function isRealFile(path) {
  const metadata = lstatSync(path);
  return metadata.isFile() && !metadata.isSymbolicLink();
}

/**
 * Proves an evidence file may be written: the allowed root sits inside the trusted anchor, the
 * evidence path sits strictly inside the allowed root, and every existing ancestor from the anchor
 * down is a real directory. Missing ancestors are created only below the allowed root.
 */
export function ensureSafeEvidencePath(evidencePath, allowedRoot, trustedAnchor) {
  const root = requireAbsolute(allowedRoot, 'Allowed evidence root');
  const anchor = requireAbsolute(trustedAnchor, 'Trusted evidence anchor');
  if (!isInside(anchor, root, { allowSame: true })) {
    throw new Error('Allowed evidence root must be contained by the trusted anchor');
  }
  if (!isInside(root, evidencePath)) {
    throw new Error('Evidence path must be contained by the allowed evidence root');
  }
  for (const current of ancestorDirectories(anchor, evidencePath)) {
    if (!existsSync(current)) {
      if (!isInside(root, current, { allowSame: true })) {
        throw new Error(`Trusted evidence ancestor does not exist: ${current}`);
      }
      mkdirSync(current);
      continue;
    }
    if (!isRealDirectory(current)) {
      throw new Error(`Evidence ancestor must be a real directory: ${current}`);
    }
  }
}
