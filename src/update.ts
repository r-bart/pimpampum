import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { AppError } from './errors.js';
import type { RunCommand } from './service/types.js';

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export interface UpdateResult extends UpdateStatus {
  updated: boolean;
  installedVersion: string;
  serviceReconciled: boolean;
}

export interface UpdateManager {
  check(): Promise<UpdateStatus>;
  update(): Promise<UpdateResult>;
}

function versionParts(version: string): number[] {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new AppError('unavailable', `npm returned an invalid Pimpampum version: ${version}`, 503);
  }
  return version.split('-', 1)[0]!.split('.').map(Number);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

export function createUpdateManager(input: {
  currentVersion: string;
  npmPath: string | null;
  nodePath: string;
  runCommand: RunCommand;
  pathExists?: (path: string) => boolean;
}): UpdateManager {
  async function npm(arguments_: string[], operation: string): Promise<string> {
    if (!input.npmPath) {
      throw new AppError('unavailable', 'npm is required to update Pimpampum', 503, false, {});
    }
    const result = await input.runCommand(input.npmPath, arguments_);
    if (result.exitCode !== 0) {
      throw new AppError('unavailable', `${operation} failed`, 503, true);
    }
    return result.stdout.trim();
  }

  async function check(): Promise<UpdateStatus> {
    const latestVersion = await npm(['view', 'pimpampum', 'version', '--json'], 'Update check');
    let parsed: unknown;
    try {
      parsed = JSON.parse(latestVersion);
    } catch {
      parsed = latestVersion.replace(/^"|"$/gu, '');
    }
    if (typeof parsed !== 'string') {
      throw new AppError('unavailable', 'npm returned an invalid update response', 503);
    }
    return {
      currentVersion: input.currentVersion,
      latestVersion: parsed,
      updateAvailable: isNewerVersion(parsed, input.currentVersion),
    };
  }

  return {
    check,
    async update() {
      const status = await check();
      if (status.updateAvailable) {
        await npm(['install', '--global', `pimpampum@${status.latestVersion}`], 'Pimpampum update');
      }
      const globalRoot = await npm(['root', '--global'], 'Global npm path lookup');
      const cliPath = join(globalRoot, 'pimpampum', 'dist', 'cli.js');
      if (!isAbsolute(globalRoot) || !(input.pathExists ?? existsSync)(cliPath)) {
        throw new AppError('unavailable', 'The updated Pimpampum CLI was not found', 503);
      }
      const installed = await input.runCommand(input.nodePath, [cliPath, 'install']);
      if (installed.exitCode !== 0) {
        throw new AppError(
          'unavailable',
          'Pimpampum updated but service reconciliation failed',
          503,
          true,
        );
      }
      return {
        ...status,
        updated: status.updateAvailable,
        installedVersion: status.latestVersion,
        serviceReconciled: true,
      };
    },
  };
}
