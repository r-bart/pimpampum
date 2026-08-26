#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(repositoryRoot, 'platforms/macos/dist/PimpampumMenuBar.app');

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

if (process.platform === 'darwin') {
  execFileSync(join(repositoryRoot, 'scripts/build-macos-app.sh'), [], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
}

execFileSync(
  process.execPath,
  [
    join(repositoryRoot, 'scripts/check-macos-artifact.mjs'),
    appRoot,
    ...(process.platform === 'darwin' ? ['--approve'] : []),
  ],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

process.stdout.write('Pimpampum package artifacts are ready.\n');
