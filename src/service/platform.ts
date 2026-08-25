import { execFile } from 'node:child_process';
import type { RunCommand } from './types.js';

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
