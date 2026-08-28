import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sourcePaths = [
  'platforms/macos/Package.swift',
  'platforms/macos/Sources',
  'platforms/macos/Resources',
  'branding/app-icon',
  'scripts/build-macos-app.sh',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Hashes the reviewed macOS build inputs.
 *
 * Enumeration comes from the Git index, never from a directory walk, so ignored
 * working-tree files such as `.DS_Store` cannot silently rebind the artifact
 * identity to content that was never reviewed.
 */
export function macosSourceHash(repositoryRoot) {
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--', ...sourcePaths], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1_024 * 1_024,
  })
    .split('\0')
    .filter(Boolean);
  invariant(tracked.length > 0, 'No tracked macOS build inputs were found.');
  const hash = createHash('sha256');
  for (const entry of tracked.sort()) {
    const path = join(repositoryRoot, entry);
    const metadata = lstatSync(path);
    invariant(!metadata.isSymbolicLink(), `macOS build input must not be a symlink: ${path}`);
    invariant(metadata.isFile(), `macOS build input must be a regular file: ${path}`);
    hash.update(entry);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}
