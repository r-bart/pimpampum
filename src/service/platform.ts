import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { RunCommand } from './types.js';

export function findExecutable(
  name: string,
  pathValue: string | undefined = process.env.PATH,
): string | null {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Executable name must be a simple file name');
  }
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Graphical sessions often have sparse PATH entries, so keep searching.
    }
  }
  return null;
}

export const runServiceCommand: RunCommand = (executable, arguments_) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      { encoding: 'utf8', maxBuffer: 1_000_000, shell: false },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ exitCode: error.code, stdout, stderr });
      },
    );
  });
