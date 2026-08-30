import { describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { createUpdateManager, isNewerVersion } from '../src/update.js';

describe('update manager', () => {
  it('compares stable semantic versions', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.0.9', '1.1.0')).toBe(false);
    expect(() => isNewerVersion('latest', '1.1.0')).toThrow('invalid Pimpampum version');
  });

  it('checks without changing the installation', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: '"1.2.0"\n', stderr: '' }));
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand,
    });
    await expect(manager.check()).resolves.toEqual({
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      updateAvailable: true,
    });
    expect(runCommand).toHaveBeenCalledWith('/npm', ['view', 'pimpampum', 'version', '--json']);
  });

  it('updates globally and reconciles through the newly installed CLI', async () => {
    const runCommand = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === 'view') return { exitCode: 0, stdout: '"1.2.0"', stderr: '' };
      if (args[0] === 'root')
        return { exitCode: 0, stdout: '/global/lib/node_modules\n', stderr: '' };
      return { exitCode: 0, stdout: '{}', stderr: '' };
    });
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: process.execPath,
      runCommand,
      pathExists: () => true,
    });
    await expect(manager.update()).resolves.toMatchObject({
      updated: true,
      installedVersion: '1.2.0',
      serviceReconciled: true,
    });
    expect(runCommand).toHaveBeenCalledWith('/npm', ['install', '--global', 'pimpampum@1.2.0']);
    expect(runCommand).toHaveBeenCalledWith(process.execPath, [
      '/global/lib/node_modules/pimpampum/dist/cli.js',
      'install',
    ]);
  });

  it('reports registry failures as retryable unavailable errors', async () => {
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'network down' })),
    });
    await expect(manager.check()).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
  });

  it('rejects missing npm and malformed registry envelopes', async () => {
    const missing = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: null,
      nodePath: '/node',
      runCommand: vi.fn(),
    });
    await expect(missing.check()).rejects.toThrow('npm is required');
    const malformed = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '' })),
    });
    await expect(malformed.check()).rejects.toThrow('invalid update response');
    const invalidJson = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'not-json', stderr: '' })),
    });
    await expect(invalidJson.check()).rejects.toThrow('invalid Pimpampum version');
  });

  it('rejects missing updated CLIs and failed reconciliation', async () => {
    const responses = async (_executable: string, args: string[]) =>
      args[0] === 'view'
        ? { exitCode: 0, stdout: '"1.1.0"', stderr: '' }
        : { exitCode: 0, stdout: '/missing', stderr: '' };
    const missing = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: responses,
      pathExists: () => false,
    });
    await expect(missing.update()).rejects.toThrow('updated Pimpampum CLI was not found');

    const failed = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      pathExists: () => true,
      runCommand: vi.fn(async (_executable, args) =>
        args[0] === 'view'
          ? { exitCode: 0, stdout: '"1.1.0"', stderr: '' }
          : args[0] === 'root'
            ? { exitCode: 0, stdout: '/global', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'install failed' },
      ),
    });
    await expect(failed.update()).rejects.toThrow('service reconciliation failed');
  });

  it('uses the filesystem check by default for an existing installed CLI', async () => {
    const root = dirname(process.cwd());
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async (_executable, args) =>
        args[0] === 'view'
          ? { exitCode: 0, stdout: '"1.1.0"', stderr: '' }
          : args[0] === 'root'
            ? { exitCode: 0, stdout: root, stderr: '' }
            : { exitCode: 0, stdout: '{}', stderr: '' },
      ),
    });
    await expect(manager.update()).resolves.toMatchObject({
      updated: false,
      serviceReconciled: true,
    });
  });
});
