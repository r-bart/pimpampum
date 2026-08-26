#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = join(packageRoot, 'package.json');
const repositoryManifestBackup = join(packageRoot, '.pimpampum-package.repository.json');

if (existsSync(repositoryManifestBackup)) {
  const metadata = lstatSync(repositoryManifestBackup);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Package manifest backup must be a regular file: ${repositoryManifestBackup}`);
  }
  if (metadata.size <= 0 || metadata.size > 1024 * 1024) {
    throw new Error(`Package manifest backup exceeds its size bounds: ${repositoryManifestBackup}`);
  }
  const backupManifest = JSON.parse(readFileSync(repositoryManifestBackup, 'utf8'));
  const publishedManifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (
    backupManifest.name !== 'pimpampum' ||
    backupManifest.version !== publishedManifest.version ||
    backupManifest.scripts?.prepack !== 'node scripts/prepare-package.mjs' ||
    backupManifest.scripts?.postpack !== 'node scripts/restore-package-manifest.mjs'
  ) {
    throw new Error(
      `Package manifest backup has an unexpected identity: ${repositoryManifestBackup}`,
    );
  }
  renameSync(repositoryManifestBackup, packagePath);
  process.stdout.write('Restored the repository package manifest.\n');
}
