#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(repositoryRoot, 'platforms/macos/dist/PimpampumMenuBar.app');
const packagePath = join(repositoryRoot, 'package.json');
const repositoryManifestBackup = join(repositoryRoot, '.pimpampum-package.repository.json');

rmSync(join(repositoryRoot, 'dist'), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(repositoryRoot, 'tsconfig.build.json'),
  ],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

execFileSync(
  process.execPath,
  [join(repositoryRoot, 'scripts/check-macos-artifact.mjs'), appRoot],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

if (existsSync(repositoryManifestBackup)) {
  throw new Error(
    `Refusing to overwrite stale package manifest backup: ${repositoryManifestBackup}. Restore or remove it first.`,
  );
}

const repositoryManifestText = readFileSync(packagePath, 'utf8');
const repositoryManifestMode = statSync(packagePath).mode & 0o777;
const repositoryManifest = JSON.parse(repositoryManifestText);
const publishedScriptNames = ['start', 'validate:omarchy', 'check:quattro-evidence', 'postpack'];
const publishedScripts = Object.fromEntries(
  publishedScriptNames.map((name) => {
    const command = repositoryManifest.scripts?.[name];
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error(`Missing required published npm script: ${name}`);
    }
    return [name, command];
  }),
);
const publishedManifest = {
  ...repositoryManifest,
  scripts: publishedScripts,
};
delete publishedManifest.devDependencies;

const temporaryManifest = join(repositoryRoot, `.package.json.${process.pid}.tmp`);
writeFileSync(repositoryManifestBackup, repositoryManifestText, {
  flag: 'wx',
  mode: repositoryManifestMode,
});
try {
  writeFileSync(temporaryManifest, `${JSON.stringify(publishedManifest, null, 2)}\n`, {
    flag: 'wx',
    mode: repositoryManifestMode,
  });
  renameSync(temporaryManifest, packagePath);
} catch (error) {
  rmSync(temporaryManifest, { force: true });
  renameSync(repositoryManifestBackup, packagePath);
  throw error;
}

process.stdout.write('Pimpampum package artifacts and published manifest are ready.\n');
