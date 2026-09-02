import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLaunchdAdapter } from '../src/service/launchd.js';
import { createMacOSDesktopAdapter } from '../src/service/macosApp.js';
import { createPlatformServiceManager } from '../src/service/manager.js';
import type { RunCommand } from '../src/service/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('macOS embedded runtime source', () => {
  it('copies the embedded payload transactionally without retaining it as service artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-macos-bootstrap-'));
    roots.push(root);
    const home = join(root, 'home');
    const data = join(root, 'data');
    const sourceApp = join(root, 'Downloads', 'Pimpampum.app');
    const runtimeRoot = join(sourceApp, 'Contents/Resources/PimpampumRuntime');
    mkdirSync(join(sourceApp, 'Contents/MacOS'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'payload/bin'), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(sourceApp, 'Contents/Info.plist'), '<plist/>');
    writeFileSync(join(sourceApp, 'Contents/MacOS/PimpampumMenuBar'), 'binary', { mode: 0o755 });
    writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), '{"schemaVersion":1}\n');
    writeFileSync(join(runtimeRoot, 'payload/bin/node'), Buffer.alloc(2 * 1024 * 1024, 7), {
      mode: 0o755,
    });

    const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => {
      if (executable === '/usr/bin/open' && arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        writeFileSync(
          join(data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: 'enabled',
            registrationChanged: false,
          }),
        );
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const adapter = createMacOSDesktopAdapter({
      appBundlePath: sourceApp,
      daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
      now: () => new Date('2026-08-31T10:00:00.000Z'),
      sleep: async () => undefined,
    });
    const context = {
      platform: 'darwin' as const,
      homeDirectory: home,
      dataDirectory: data,
      nodePath: '/private/runtime/bin/node',
      cliPath: '/private/runtime/dist/cli.js',
      version: '2.0.0',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: join(data, 'logs'),
      runCommand,
    };
    expect(adapter.artifacts(context).some(({ path }) => path.includes('PimpampumRuntime'))).toBe(
      false,
    );
    const manager = createPlatformServiceManager({
      ...context,
      adapters: { darwin: adapter },
    });

    await manager.install();
    const installedApp = join(home, 'Applications/Pimpampum.app');
    expect(
      existsSync(join(installedApp, 'Contents/Resources/PimpampumRuntime/payload/bin/node')),
    ).toBe(true);
    const receipt = readFileSync(join(data, 'install-receipt.json'), 'utf8');
    expect(receipt).not.toContain('PimpampumRuntime');
    // The copied bundle is sealed: the marker sits outside it, and its first launches carry the
    // Gatekeeper deadline the default runner would otherwise cut short.
    expect(receipt).not.toContain('installation.json');
    expect(existsSync(join(installedApp, 'Contents/Resources/installation.json'))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(home, 'Library/Application Support/Pimpampum/installation.json'), 'utf8'),
      ),
    ).toEqual({ schemaVersion: 2, dataDirectory: data });
    const launches = runCommand.mock.calls.filter(
      ([executable, arguments_]) =>
        executable === '/usr/bin/open' && arguments_[1] === installedApp,
    );
    expect(launches).toHaveLength(2);
    for (const launch of launches) expect(launch[2]).toEqual({ timeoutMilliseconds: 180_000 });
  });

  it('rolls back the copied runtime when stable app registration fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-macos-bootstrap-rollback-'));
    roots.push(root);
    const home = join(root, 'home');
    const data = join(root, 'data');
    const sourceApp = join(root, 'Downloads', 'Pimpampum.app');
    const runtimeRoot = join(sourceApp, 'Contents/Resources/PimpampumRuntime');
    mkdirSync(join(sourceApp, 'Contents/MacOS'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'payload/bin'), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(sourceApp, 'Contents/Info.plist'), '<plist/>');
    writeFileSync(join(sourceApp, 'Contents/MacOS/PimpampumMenuBar'), 'binary', { mode: 0o755 });
    writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), '{"schemaVersion":1}\n');
    writeFileSync(join(runtimeRoot, 'payload/bin/node'), 'runtime', { mode: 0o755 });

    const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => ({
      exitCode:
        executable === '/usr/bin/open' && arguments_.includes('--register-login-item') ? 42 : 0,
      stdout: '',
      stderr: '',
    }));
    const adapter = createMacOSDesktopAdapter({
      appBundlePath: sourceApp,
      daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
      now: () => new Date('2026-08-31T10:00:00.000Z'),
      sleep: async () => undefined,
    });
    const manager = createPlatformServiceManager({
      platform: 'darwin',
      homeDirectory: home,
      dataDirectory: data,
      nodePath: '/private/runtime/bin/node',
      cliPath: '/private/runtime/dist/cli.js',
      version: '2.0.0',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: join(data, 'logs'),
      runCommand,
      adapters: { darwin: adapter },
    });

    await expect(manager.install()).rejects.toThrow(/registration helper/iu);
    expect(
      existsSync(join(home, 'Applications/Pimpampum.app/Contents/Resources/PimpampumRuntime')),
    ).toBe(false);
    expect(existsSync(join(data, 'install-receipt.json'))).toBe(false);
  });

  it('rejects nested symlinks in the embedded runtime without touching their target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-macos-bootstrap-symlink-'));
    roots.push(root);
    const home = join(root, 'home');
    const data = join(root, 'data');
    const sourceApp = join(root, 'Downloads', 'Pimpampum.app');
    const runtimeRoot = join(sourceApp, 'Contents/Resources/PimpampumRuntime');
    const victim = join(root, 'victim');
    mkdirSync(join(sourceApp, 'Contents/MacOS'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'payload'), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(data, { recursive: true });
    mkdirSync(victim);
    writeFileSync(join(sourceApp, 'Contents/Info.plist'), '<plist/>');
    writeFileSync(join(sourceApp, 'Contents/MacOS/PimpampumMenuBar'), 'binary', { mode: 0o755 });
    writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), '{"schemaVersion":1}\n');
    writeFileSync(join(victim, 'untouched'), 'private');
    symlinkSync(victim, join(runtimeRoot, 'payload/bin'));

    const runCommand = vi.fn<RunCommand>(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const adapter = createMacOSDesktopAdapter({
      appBundlePath: sourceApp,
      daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
      now: () => new Date('2026-08-31T10:00:00.000Z'),
      sleep: async () => undefined,
    });
    const manager = createPlatformServiceManager({
      platform: 'darwin',
      homeDirectory: home,
      dataDirectory: data,
      nodePath: '/private/runtime/bin/node',
      cliPath: '/private/runtime/dist/cli.js',
      version: '2.0.0',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: join(data, 'logs'),
      runCommand,
      adapters: { darwin: adapter },
    });

    await expect(manager.install()).rejects.toThrow(/must not contain symlinks/iu);
    expect(readFileSync(join(victim, 'untouched'), 'utf8')).toBe('private');
    expect(existsSync(join(data, 'install-receipt.json'))).toBe(false);
  });
});
