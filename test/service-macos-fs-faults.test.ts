import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMacOSDesktopAdapter } from '../src/service/macosApp.js';
import type { PlatformServiceAdapter, ServiceAdapterContext } from '../src/service/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const roots: string[] = [];
const defaultRename = vi.mocked(renameSync).getMockImplementation()!;

afterEach(() => {
  vi.mocked(renameSync).mockClear();
  vi.mocked(renameSync).mockImplementation(defaultRename);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('macOS embedded runtime filesystem faults', () => {
  it('restores the previous runtime when final staging rename fails after backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-macos-runtime-fault-'));
    roots.push(root);
    const homeDirectory = join(root, 'home');
    const dataDirectory = join(root, 'data');
    const sourceApp = join(root, 'source.app');
    const sourceRuntime = join(sourceApp, 'Contents', 'Resources', 'PimpampumRuntime');
    const installedRuntime = join(
      homeDirectory,
      'Applications',
      'PimpampumMenuBar.app',
      'Contents',
      'Resources',
      'PimpampumRuntime',
    );
    mkdirSync(sourceRuntime, { recursive: true });
    mkdirSync(installedRuntime, { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(join(sourceRuntime, 'runtime.txt'), 'new runtime');
    writeFileSync(join(installedRuntime, 'runtime.txt'), 'old runtime');
    const daemonAdapter: PlatformServiceAdapter = {
      id: 'launchd-test',
      platform: 'darwin',
      artifacts: () => [],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    };
    const context: ServiceAdapterContext = {
      homeDirectory,
      dataDirectory,
      nodePath: '/opt/node',
      cliPath: '/opt/cli.js',
      version: '2.0.0',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: join(dataDirectory, 'logs'),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    let renames = 0;
    vi.mocked(renameSync).mockImplementation((...arguments_: Parameters<typeof renameSync>) => {
      renames += 1;
      if (renames === 2) throw new Error('final runtime rename failed');
      return defaultRename(...arguments_);
    });
    const adapter = createMacOSDesktopAdapter({
      appBundlePath: sourceApp,
      daemonAdapter,
      sleep: async () => undefined,
      acknowledgementPolls: 1,
    });
    await expect(adapter.afterInstall!(context, [])).rejects.toThrow('final runtime rename failed');
    expect(readFileSync(join(installedRuntime, 'runtime.txt'), 'utf8')).toBe('old runtime');
  });
});
