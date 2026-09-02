import {
  chmodSync,
  copyFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { assertRegularDirectory, walkRegularTree } from '../fsGuards.js';
import { isRecord } from '../objects.js';
import {
  fail,
  fsyncPath,
  hash,
  parseOwnedJson,
  pathEntryExists,
  privateDirectory,
  writeOwnedFile,
} from './ownedFiles.js';
import type { RuntimeManifest } from './types.js';

/**
 * The runtime payload as a tree on disk: manifest verification of a source, a staged copy or an
 * installed destination, the copy itself, its durability before the activating rename, and the
 * cleanup of staging directories an earlier installer left behind.
 */

export const STAGING_PREFIX = '.pimpampum-stage-';
const STAGING_MARKER_NAME = 'staging-owner.json';
const STAGING_OWNER = 'pimpampum-runtime-installer';

export interface RuntimeEntrypointPaths {
  nodePath: string;
  cliPath: string;
  mcpPath: string;
}

export function entrypointPaths(root: string, manifest: RuntimeManifest): RuntimeEntrypointPaths {
  return {
    nodePath: join(root, ...manifest.entrypoints.node.split('/')),
    cliPath: join(root, ...manifest.entrypoints.cli.split('/')),
    mcpPath: join(root, ...manifest.entrypoints.mcp.split('/')),
  };
}

/** Every regular file under `root`; a link or special file anywhere in the tree aborts the walk. */
function listRegularFiles(root: string): { path: string; relativePath: string }[] {
  const files: { path: string; relativePath: string }[] = [];
  walkRegularTree(
    root,
    (entry) => {
      if (entry.kind === 'file') files.push({ path: entry.path, relativePath: entry.relativePath });
    },
    { label: 'Runtime tree' },
  );
  return files;
}

/** The tree holds exactly the manifest's files with the listed modes, sizes and hashes. */
export function validateRuntimeTree(root: string, manifest: RuntimeManifest): void {
  const actual = listRegularFiles(root);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const actualPaths = actual.map(({ relativePath }) => relativePath).sort();
  const expectedPaths = [...expected.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail('runtime contains missing or unexpected files');
  }
  for (const { path, relativePath } of actual) {
    const expectedFile = expected.get(relativePath)!;
    const metadata = statSync(path);
    const content = readFileSync(path);
    if ((metadata.mode & 0o777) !== expectedFile.mode) fail(`mode drift for ${relativePath}`);
    if (content.length !== expectedFile.size) fail(`size drift for ${relativePath}`);
    if (hash(content) !== expectedFile.sha256) fail(`hash drift for ${relativePath}`);
  }
}

export function runtimeTreeDrifted(root: string, manifest: RuntimeManifest): boolean {
  try {
    validateRuntimeTree(root, manifest);
    return false;
  } catch {
    return true;
  }
}

export function copyRuntimeTree(
  source: string,
  destination: string,
  manifest: RuntimeManifest,
): void {
  privateDirectory(destination);
  for (const file of manifest.files) {
    const sourcePath = join(source, ...file.path.split('/'));
    const destinationPath = join(destination, ...file.path.split('/'));
    privateDirectory(dirname(destinationPath));
    copyFileSync(sourcePath, destinationPath);
    chmodSync(destinationPath, file.mode);
  }
  validateRuntimeTree(destination, manifest);
}

/**
 * Makes every copied byte durable before the payload is renamed into place. The receipt that
 * follows is fsynced, so without this step a crash could leave a durable receipt vouching for a
 * truncated `bin/node` or native addon.
 */
export function fsyncRuntimeTree(root: string, manifest: RuntimeManifest): void {
  const directories = new Set<string>([root]);
  for (const file of manifest.files) {
    const path = join(root, ...file.path.split('/'));
    fsyncPath(path);
    let directory = dirname(path);
    while (directory !== root && directory.startsWith(`${root}${sep}`)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of directories) fsyncPath(directory);
}

/** Marks a staging directory as this installer's so a later run may delete it. */
export function writeStagingMarker(stagingRoot: string): void {
  writeOwnedFile(
    join(stagingRoot, STAGING_MARKER_NAME),
    `${JSON.stringify({ schemaVersion: 1, owner: STAGING_OWNER })}\n`,
    0o600,
  );
}

function isOwnedStagingMarker(marker: unknown): boolean {
  return (
    isRecord(marker) &&
    Object.keys(marker).sort().join(',') === 'owner,schemaVersion' &&
    marker.schemaVersion === 1 &&
    marker.owner === STAGING_OWNER
  );
}

/** Deletes staging directories under the version root that carry this installer's marker. */
export function cleanOwnedStaging(versionRoot: string): void {
  if (!pathEntryExists(versionRoot)) return;
  assertRegularDirectory(versionRoot, 'Runtime version directory');
  for (const name of readdirSync(versionRoot)) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const path = join(versionRoot, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail('runtime staging path is unsafe');
    }
    const marker = parseOwnedJson(join(path, STAGING_MARKER_NAME), 'Runtime staging marker');
    if (!isOwnedStagingMarker(marker)) fail('runtime staging directory is not receipt-owned');
    rmSync(path, { recursive: true });
  }
}
