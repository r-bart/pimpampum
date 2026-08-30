import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { AppError } from './errors.js';
import { findExecutable } from './service/platform.js';
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

export function resolveNpmPath(
  nodePath: string,
  pathValue = process.env.PATH,
  pathExists: (path: string) => boolean = (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): string | null {
  const siblingNpmPath = join(dirname(nodePath), 'npm');
  const npmPath = pathExists(siblingNpmPath) ? siblingNpmPath : findExecutable('npm', pathValue);
  return npmPath ? realpathSync(npmPath) : null;
}

function versionParts(version: string): { core: number[]; prerelease: string[] } {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new AppError('unavailable', `npm returned an invalid Pimpampum version: ${version}`, 503);
  }
  const [core, prerelease = ''] = version.split('-', 2);
  return {
    core: core!.split('.').map(Number),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! > right.core[index]!;
  }
  if (left.prerelease.length === 0) return right.prerelease.length > 0;
  if (right.prerelease.length === 0) return false;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const candidatePart = left.prerelease[index];
    const currentPart = right.prerelease[index];
    if (candidatePart === undefined) return false;
    if (currentPart === undefined) return true;
    if (candidatePart === currentPart) continue;
    const candidateNumber = /^\d+$/u.test(candidatePart) ? Number(candidatePart) : null;
    const currentNumber = /^\d+$/u.test(currentPart) ? Number(currentPart) : null;
    if (candidateNumber !== null && currentNumber !== null) return candidateNumber > currentNumber;
    if (candidateNumber !== null) return false;
    if (currentNumber !== null) return true;
    return candidatePart > currentPart;
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
      throw new AppError(
        'unavailable',
        'npm is required to update Pimpampum; install Node.js with npm and retry',
        503,
        false,
      );
    }
    const result = await input.runCommand(input.nodePath, [input.npmPath, ...arguments_]);
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
        currentVersion: status.latestVersion,
        latestVersion: status.latestVersion,
        updateAvailable: false,
        updated: status.updateAvailable,
        installedVersion: status.latestVersion,
        serviceReconciled: true,
      };
    },
  };
}
