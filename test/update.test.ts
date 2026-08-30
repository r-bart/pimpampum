import { describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { createUpdateManager, isNewerVersion, resolveNpmPath } from '../src/update.js';

describe('update manager', () => {
  it('finds npm next to Node when a graphical session has a sparse PATH', () => {
    expect(resolveNpmPath('/mise/bin/node', '', () => false)).toBeNull();
    expect(resolveNpmPath(process.execPath, '')).toMatch(/\/npm-cli\.js$/u);
    expect(resolveNpmPath('/path/that/does/not/exist/node', '')).toBeNull();
  });

  it("prefers Node's sibling npm over a version-manager shim on PATH", () => {
    expect(resolveNpmPath(process.execPath, `${process.env.HOME}/.local/share/mise/shims`)).toMatch(
      /\/npm-cli\.js$/u,
    );
  });

  it('compares stable semantic versions', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.0.9', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.1.0', '1.1.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.1.0-beta.10', '1.1.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.1.0-beta.2', '1.1.0-beta.10')).toBe(false);
    expect(isNewerVersion('1.1.0-beta', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.1.0-beta', '1.1.0-beta')).toBe(false);
    expect(isNewerVersion('1.1.0-beta', '1.1.0-beta.1')).toBe(false);
    expect(isNewerVersion('1.1.0-beta.1', '1.1.0-beta')).toBe(true);
    expect(isNewerVersion('1.1.0-1', '1.1.0-beta')).toBe(false);
    expect(isNewerVersion('1.1.0-beta', '1.1.0-1')).toBe(true);
    expect(isNewerVersion('1.1.0-rc', '1.1.0-beta')).toBe(true);
    expect(isNewerVersion('1.1.0-beta', '1.1.0-rc')).toBe(false);
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
    expect(runCommand).toHaveBeenCalledWith('/node', [
      '/npm',
      'view',
      'pimpampum',
      'version',
      '--json',
    ]);
  });

  it('updates globally and reconciles through the newly installed CLI', async () => {
    const runCommand = vi.fn(async (_executable: string, args: string[]) => {
      if (args[1] === 'view') return { exitCode: 0, stdout: '"1.2.0"', stderr: '' };
      if (args[1] === 'root')
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
      currentVersion: '1.2.0',
      latestVersion: '1.2.0',
      updateAvailable: false,
      updated: true,
      installedVersion: '1.2.0',
      serviceReconciled: true,
    });
    expect(runCommand).toHaveBeenCalledWith(process.execPath, [
      '/npm',
      'install',
      '--global',
      'pimpampum@1.2.0',
    ]);
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
      args[1] === 'view'
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
        args[1] === 'view'
          ? { exitCode: 0, stdout: '"1.1.0"', stderr: '' }
          : args[1] === 'root'
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
        args[1] === 'view'
          ? { exitCode: 0, stdout: '"1.1.0"', stderr: '' }
          : args[1] === 'root'
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
