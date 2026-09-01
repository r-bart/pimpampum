import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLaunchdAdapter } from '../src/service/launchd.js';
import { createPlatformServiceManager } from '../src/service/manager.js';
import { createMacOSDesktopAdapter } from '../src/service/macosApp.js';
import type { CommandResult, RunCommand, ServiceAdapterContext } from '../src/service/types.js';

const roots: string[] = [];

function fixture(label: string): {
  root: string;
  home: string;
  data: string;
  sourceApp: string;
} {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-macos-${label}-`));
  roots.push(root);
  const home = join(root, 'Home With Spaces ü');
  const data = join(root, 'Data ñ');
  const sourceApp = join(root, 'build', 'Pimpampum.app');
  mkdirSync(join(sourceApp, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(sourceApp, 'Contents', 'Resources'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'token'), 'secret-token');
  writeFileSync(join(sourceApp, 'Contents', 'Info.plist'), '<plist/>', { mode: 0o644 });
  writeFileSync(join(sourceApp, 'Contents', 'MacOS', 'PimpampumMenuBar'), 'binary', {
    mode: 0o755,
  });
  writeFileSync(join(sourceApp, 'Contents', 'Resources', 'asset.txt'), 'asset', {
    mode: 0o640,
  });
  writeFileSync(
    join(sourceApp, 'Contents', 'Resources', 'installation.json'),
    '{"dataDirectory":"must-be-replaced"}',
  );
  return { root, home, data, sourceApp };
}

function success(): CommandResult {
  return { exitCode: 0, stdout: '', stderr: '' };
}

function adapterContext(
  root: ReturnType<typeof fixture>,
  runCommand: RunCommand,
): ServiceAdapterContext {
  return {
    homeDirectory: root.home,
    dataDirectory: root.data,
    nodePath: '/usr/bin/node',
    cliPath: '/opt/pimpampum/cli.js',
    version: '1.0.0',
    host: '127.0.0.1',
    port: 7337,
    logDirectory: join(root.data, 'logs'),
    runCommand,
  };
}

function testDesktopAdapter(
  root: ReturnType<typeof fixture>,
  options: Partial<Parameters<typeof createMacOSDesktopAdapter>[0]> = {},
) {
  return createMacOSDesktopAdapter({
    appBundlePath: root.sourceApp,
    daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
    now: () => new Date('2026-08-26T20:00:00.000Z'),
    sleep: async () => undefined,
    acknowledgementPolls: 1,
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('macOS menu app service integration', () => {
  it('installs, freshly registers, reports, reconciles and precisely uninstalls the app', async () => {
    const root = fixture('lifecycle');
    const requests: string[] = [];
    const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => {
      if (executable === '/usr/bin/open' && arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        requests.push(request.requestId);
        writeFileSync(
          join(root.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: requests.length === 1 ? 'enabled' : 'requiresApproval',
            registrationChanged: requests.length === 1,
          }),
          { mode: 0o600 },
        );
      }
      if (executable === '/usr/bin/open' && arguments_.includes('--unregister-login-item')) {
        writeFileSync(
          join(root.data, 'login-unregistration-acknowledgement.json'),
          JSON.stringify({
            createdAt: '2026-08-26T20:00:00.000Z',
            previousStatus: 'requiresApproval',
            status: 'disabled',
          }),
          { mode: 0o600 },
        );
      }
      if (executable === '/bin/launchctl' && arguments_[0] === 'print') {
        return { exitCode: 0, stdout: 'state = running\npid = 5\n', stderr: '' };
      }
      return success();
    });
    const adapter = createMacOSDesktopAdapter({
      appBundlePath: root.sourceApp,
      daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
      now: () => new Date('2026-08-26T20:00:00.000Z'),
      sleep: async () => undefined,
    });
    const manager = createPlatformServiceManager({
      platform: 'darwin',
      homeDirectory: root.home,
      dataDirectory: root.data,
      nodePath: '/usr/local/bin/node',
      cliPath: '/opt/pimpampum/dist/cli.js',
      version: '1.0.0',
      runCommand,
      adapters: { darwin: adapter },
    });
    const installedApp = join(root.home, 'Applications', 'Pimpampum.app');

    await expect(manager.install()).resolves.toMatchObject({
      installed: true,
      reconciled: false,
      loginItem: 'enabled',
    });
    expect(
      readFileSync(join(installedApp, 'Contents', 'Resources', 'installation.json'), 'utf8'),
    ).toContain(root.data);
    expect(statSync(join(installedApp, 'Contents', 'MacOS', 'PimpampumMenuBar')).mode & 0o777).toBe(
      0o755,
    );
    expect(readFileSync(join(root.data, 'install-receipt.json'), 'utf8')).not.toContain(
      'secret-token',
    );

    await expect(manager.status()).resolves.toMatchObject({
      installed: true,
      running: true,
      adapter: 'launchd-macos-app',
      loginItem: 'enabled',
    });
    await expect(manager.install()).resolves.toMatchObject({
      reconciled: true,
      loginItem: 'requiresApproval',
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);

    await expect(manager.uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    expect(existsSync(installedApp)).toBe(false);
    expect(existsSync(join(root.data, 'login-registration-request.json'))).toBe(false);
    expect(existsSync(join(root.data, 'login-registration-acknowledgement.json'))).toBe(false);
    expect(existsSync(join(root.data, 'login-item-status.json'))).toBe(false);
    expect(existsSync(join(root.data, 'login-unregistration-acknowledgement.json'))).toBe(false);
    expect(readFileSync(join(root.data, 'token'), 'utf8')).toBe('secret-token');
    expect(runCommand.mock.calls).toContainEqual([
      '/usr/bin/open',
      // No `-W`: the helper's acknowledgement file is polled instead. When setup adopts an app
      // the user already placed in an Applications folder, that bundle is also the running
      // menu-bar app and `-W` waits on the wrong instance.
      ['-n', installedApp, '--args', '--unregister-login-item'],
    ]);
    expect(runCommand.mock.calls).toContainEqual(['/usr/bin/open', ['-n', installedApp]]);
  });

  it('migrates receipt-owned historical app bundle names to the stable technical path', async () => {
    const root = fixture('legacy-bundle-migration');
    const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => {
      if (executable === '/usr/bin/open' && arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        writeFileSync(
          join(root.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: 'enabled',
            registrationChanged: false,
          }),
        );
      }
      return success();
    });
    const manager = createPlatformServiceManager({
      platform: 'darwin',
      homeDirectory: root.home,
      dataDirectory: root.data,
      nodePath: '/usr/local/bin/node',
      cliPath: '/opt/pimpampum/dist/cli.js',
      version: '1.0.0',
      runCommand,
      adapters: { darwin: testDesktopAdapter(root) },
    });
    await manager.install();
    const stableRoot = join(root.home, 'Applications', 'Pimpampum.app');
    const legacyRoot = join(root.home, 'Applications', 'PimpampumMenuBar.app');
    const unrelatedLegacyPath = join(root.home, 'Applications', 'pim • pam • pum.app');
    writeFileSync(unrelatedLegacyPath, 'unrelated user file');
    renameSync(stableRoot, legacyRoot);
    const receiptPath = join(root.data, 'install-receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      artifacts: Array<{ path: string }>;
    };
    for (const artifact of receipt.artifacts) {
      artifact.path = artifact.path.replace(stableRoot, legacyRoot);
    }
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    await expect(manager.install()).resolves.toMatchObject({ installed: true, reconciled: true });
    expect(existsSync(stableRoot)).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false);
    expect(readFileSync(unrelatedLegacyPath, 'utf8')).toBe('unrelated user file');
  });

  it('rolls back app, daemon and prior handshake files when registration fails', async () => {
    const root = fixture('rollback');
    for (const name of [
      'login-registration-request.json',
      'login-registration-acknowledgement.json',
      'login-item-status.json',
    ]) {
      writeFileSync(join(root.data, name), `prior-${name}`, { mode: 0o640 });
    }
    const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => {
      if (executable === '/usr/bin/open' && arguments_.includes('--register-login-item')) {
        return success();
      }
      return success();
    });
    const manager = createPlatformServiceManager({
      platform: 'darwin',
      homeDirectory: root.home,
      dataDirectory: root.data,
      nodePath: '/usr/bin/node',
      cliPath: '/opt/pimpampum/cli.js',
      version: '1.0.0',
      runCommand,
      adapters: {
        darwin: createMacOSDesktopAdapter({
          appBundlePath: root.sourceApp,
          daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
          now: () => new Date('2026-08-26T20:00:00.000Z'),
          sleep: async () => undefined,
          acknowledgementPolls: 1,
        }),
      },
    });

    await expect(manager.install()).rejects.toThrow(/timed out/i);
    expect(existsSync(join(root.home, 'Applications', 'Pimpampum.app'))).toBe(false);
    expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(false);
    for (const name of [
      'login-registration-request.json',
      'login-registration-acknowledgement.json',
      'login-item-status.json',
    ]) {
      expect(readFileSync(join(root.data, name), 'utf8')).toBe(`prior-${name}`);
      expect(statSync(join(root.data, name)).mode & 0o777).toBe(0o640);
    }
  });

  it('copies no runtime into an adopted app and records where it lives', async () => {
    // An adopted bundle already carries its embedded runtime: copying it over itself while the app
    // is running would be both pointless and dangerous.
    const root = fixture('adopt-install');
    const userApp = join(root.home, 'Applications', 'Pimpampum.app');
    mkdirSync(join(userApp, 'Contents', 'Resources', 'PimpampumRuntime'), { recursive: true });
    writeFileSync(join(userApp, 'Contents', 'Resources', 'PimpampumRuntime', 'node'), 'runtime', {
      mode: 0o755,
    });
    mkdirSync(root.data, { recursive: true });
    writeFileSync(
      join(root.data, 'login-registration-acknowledgement.json'),
      JSON.stringify({
        requestId: 'ignored',
        createdAt: '2026-08-26T20:00:00.000Z',
        status: 'enabled',
        registrationChanged: false,
      }),
      { mode: 0o600 },
    );

    const adapter = testDesktopAdapter(root, { appBundlePath: userApp });
    await adapter.afterInstall!(
      adapterContext(root, async () => success()),
      [],
    ).catch(() => undefined);

    // The runtime inside the user's app is untouched: no staging or backup directory beside it.
    const resources = readdirSync(join(userApp, 'Contents', 'Resources'));
    expect(resources.filter((name) => name.startsWith('.PimpampumRuntime'))).toEqual([]);
    // And the path is recorded so an installed CLI can find the app later.
    const recorded = JSON.parse(readFileSync(join(root.data, 'application-path.json'), 'utf8')) as {
      schemaVersion: number;
      path: string;
    };
    expect(recorded).toEqual({ schemaVersion: 1, path: userApp });
  });

  it('adopts an app the user already placed in an Applications folder', () => {
    // Copying such a copy into ~/Applications leaves two menu-bar icons: the user's app and the one
    // macOS starts when the login item is registered. Setup registers the copy that is there.
    const root = fixture('adopt');
    const context: ServiceAdapterContext = {
      homeDirectory: root.home,
      dataDirectory: root.data,
      nodePath: '/usr/bin/node',
      cliPath: '/opt/pimpampum/cli.js',
      version: '1.0.0',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: join(root.data, 'logs'),
      runCommand: async () => success(),
    };
    const daemon = createLaunchdAdapter({ guiDomain: 'gui/501' });
    const userApp = join(root.home, 'Applications', 'Pimpampum.app');
    mkdirSync(join(userApp, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(userApp, 'Contents', 'Info.plist'), '<plist/>', { mode: 0o644 });

    const adopted = createMacOSDesktopAdapter({ appBundlePath: userApp, daemonAdapter: daemon });
    // No application files are planned, so nothing is copied and no marker is written inside a
    // bundle that may sit outside the home directory.
    const daemonOnly = daemon.artifacts(context).map((artifact) => artifact.path);
    expect(adopted.artifacts(context).map((artifact) => artifact.path)).toEqual(daemonOnly);
    // And uninstalling must not claim the user's app.
    expect(adopted.ownedArtifactRoots?.(context) ?? []).not.toContain(userApp);

    // A bundle outside an Applications folder is still copied into the managed location.
    const staged = createMacOSDesktopAdapter({
      appBundlePath: root.sourceApp,
      daemonAdapter: daemon,
    });
    const managed = join(root.home, 'Applications', 'Pimpampum.app');
    expect(staged.artifacts(context).some((artifact) => artifact.path.startsWith(managed))).toBe(
      true,
    );
    expect(staged.ownedArtifactRoots?.(context) ?? []).toContain(managed);
  });

  it('ignores a malformed or hostile recorded application path', () => {
    // An installed CLI reads this file to learn where the app is. A bad value must fall back to the
    // managed location rather than pointing the uninstaller at an arbitrary path.
    const root = fixture('recorded-path');
    const context: ServiceAdapterContext = {
      homeDirectory: root.home,
      dataDirectory: root.data,
      nodePath: '/usr/bin/node',
      cliPath: '/opt/pimpampum/cli.js',
      version: '1.0.0',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: join(root.data, 'logs'),
      runCommand: async () => success(),
    };
    const daemon = createLaunchdAdapter({ guiDomain: 'gui/501' });
    const managed = join(root.home, 'Applications', 'Pimpampum.app');
    const recordPath = join(root.data, 'application-path.json');
    mkdirSync(root.data, { recursive: true });

    // The CLI has no bundle of its own to inspect, which is the case this file exists for.
    const installedCli = createMacOSDesktopAdapter({
      appBundlePath: join(root.root, 'runtime', 'platforms', 'macos', 'dist', 'Pimpampum.app'),
      daemonAdapter: daemon,
    });

    for (const invalid of [
      '{"schemaVersion":2,"path":"/Applications/Pimpampum.app"}',
      '{"schemaVersion":1,"path":42}',
      '{"schemaVersion":1,"path":"relative/Pimpampum.app"}',
      '{"schemaVersion":1}',
      'not json at all',
    ]) {
      writeFileSync(recordPath, invalid, { mode: 0o600 });
      expect(installedCli.ownedArtifactRoots?.(context) ?? []).toContain(managed);
    }

    // A well-formed record is trusted, and the app it names is not claimed as ours.
    writeFileSync(recordPath, '{"schemaVersion":1,"path":"/Applications/Pimpampum.app"}', {
      mode: 0o600,
    });
    expect(installedCli.ownedArtifactRoots?.(context) ?? []).not.toContain(managed);
  });

  it('rejects unsafe bundles and invalid adapter options before installation', async () => {
    const root = fixture('validation');
    const context: ServiceAdapterContext = {
      homeDirectory: root.home,
      dataDirectory: root.data,
      nodePath: '/usr/bin/node',
      cliPath: '/opt/pimpampum/cli.js',
      version: '1.0.0',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: join(root.data, 'logs'),
      runCommand: async () => success(),
    };
    const daemon = createLaunchdAdapter({ guiDomain: 'gui/501' });
    expect(() =>
      createMacOSDesktopAdapter({ appBundlePath: 'relative', daemonAdapter: daemon }).artifacts(
        context,
      ),
    ).toThrow(/absolute/);
    // A missing bundle no longer breaks planning: status and uninstall run from the installed
    // runtime, which has no build tree. Install is where the source is required.
    const withoutBundle = createMacOSDesktopAdapter({
      appBundlePath: join(root.root, 'missing.app'),
      daemonAdapter: daemon,
    });
    expect(withoutBundle.canPlanArtifacts?.(context)).toBe(false);
    expect(withoutBundle.artifacts(context)).toEqual(daemon.artifacts(context));
    await expect(withoutBundle.preflight?.(context, [], 'uninstall')).resolves.toBeUndefined();
    await expect(withoutBundle.preflight?.(context, [], 'install')).rejects.toThrow(
      /build the macOS app/i,
    );
    expect(() =>
      createMacOSDesktopAdapter({
        appBundlePath: root.sourceApp,
        daemonAdapter: { ...daemon, platform: 'linux' },
      }),
    ).toThrow(/Darwin/);
    expect(() =>
      createMacOSDesktopAdapter({
        appBundlePath: root.sourceApp,
        daemonAdapter: daemon,
        openPath: 'open',
      }),
    ).toThrow(/absolute/);
    expect(() =>
      createMacOSDesktopAdapter({
        appBundlePath: root.sourceApp,
        daemonAdapter: daemon,
        acknowledgementPolls: 0,
      }),
    ).toThrow(/poll count/);
    expect(() =>
      createMacOSDesktopAdapter({
        appBundlePath: root.sourceApp,
        daemonAdapter: daemon,
        acknowledgementPollIntervalMs: 0,
      }),
    ).toThrow(/poll interval/);

    const linked = join(root.sourceApp, 'Contents', 'Resources', 'linked');
    symlinkSync('/tmp', linked);
    expect(() =>
      createMacOSDesktopAdapter({ appBundlePath: root.sourceApp, daemonAdapter: daemon }).artifacts(
        context,
      ),
    ).toThrow(/symlinks/);
  });

  it('rejects hostile embedded runtime roots and entries before registration', async () => {
    for (const variant of ['root-symlink', 'child-symlink', 'child-fifo'] as const) {
      const root = fixture(`embedded-${variant}`);
      const runtime = join(root.sourceApp, 'Contents', 'Resources', 'PimpampumRuntime');
      if (variant === 'root-symlink') symlinkSync('/tmp', runtime);
      else {
        mkdirSync(runtime);
        if (variant === 'child-symlink') symlinkSync('/tmp', join(runtime, 'linked'));
        else execFileSync('/usr/bin/mkfifo', [join(runtime, 'named-pipe')]);
      }
      await expect(
        testDesktopAdapter(root).afterInstall!(
          adapterContext(root, async () => success()),
          [],
        ),
      ).rejects.toThrow(/embedded macOS runtime/iu);
    }
  });

  it('rejects an unsafe installed runtime and reports unsafe bootstrap rollback', async () => {
    const occupied = fixture('embedded-occupied-destination');
    const occupiedSource = join(occupied.sourceApp, 'Contents', 'Resources', 'PimpampumRuntime');
    mkdirSync(occupiedSource);
    writeFileSync(join(occupiedSource, 'node'), 'runtime');
    const occupiedDestination = join(
      occupied.home,
      'Applications',
      'Pimpampum.app',
      'Contents',
      'Resources',
      'PimpampumRuntime',
    );
    mkdirSync(join(occupiedDestination, '..'), { recursive: true });
    writeFileSync(occupiedDestination, 'not a directory');
    await expect(
      testDesktopAdapter(occupied).afterInstall!(
        adapterContext(occupied, async () => success()),
        [],
      ),
    ).rejects.toThrow(/regular directory/iu);

    const rollback = fixture('embedded-unsafe-rollback');
    const rollbackSource = join(rollback.sourceApp, 'Contents', 'Resources', 'PimpampumRuntime');
    mkdirSync(rollbackSource);
    writeFileSync(join(rollbackSource, 'node'), 'runtime');
    const rollbackDestination = join(
      rollback.home,
      'Applications',
      'Pimpampum.app',
      'Contents',
      'Resources',
      'PimpampumRuntime',
    );
    const runCommand = vi.fn<RunCommand>(async (executable) => {
      if (executable === '/usr/bin/open') {
        rmSync(rollbackDestination, { recursive: true });
        symlinkSync('/tmp', rollbackDestination);
      }
      return success();
    });
    const error = await testDesktopAdapter(rollback).afterInstall!(
      adapterContext(rollback, runCommand),
      [],
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/bootstrap rollback/iu);
  });

  it('refuses to remove an unsafe embedded runtime during uninstall cleanup', async () => {
    const root = fixture('embedded-unsafe-remove');
    const destination = join(
      root.home,
      'Applications',
      'Pimpampum.app',
      'Contents',
      'Resources',
      'PimpampumRuntime',
    );
    mkdirSync(join(destination, '..'), { recursive: true });
    symlinkSync('/tmp', destination);
    await expect(
      testDesktopAdapter(root).afterUninstall!(
        adapterContext(root, async () => success()),
        [],
      ),
    ).rejects.toThrow(/unsafe embedded runtime/iu);
  });

  it('replaces and rolls back an existing embedded runtime transactionally', async () => {
    for (const variant of ['commit', 'rollback'] as const) {
      const root = fixture(`embedded-existing-${variant}`);
      const source = join(root.sourceApp, 'Contents', 'Resources', 'PimpampumRuntime');
      mkdirSync(source);
      writeFileSync(join(source, 'runtime.txt'), 'new runtime');
      const destination = join(
        root.home,
        'Applications',
        'Pimpampum.app',
        'Contents',
        'Resources',
        'PimpampumRuntime',
      );
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'runtime.txt'), 'old runtime');
      const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => {
        if (
          variant === 'commit' &&
          executable === '/usr/bin/open' &&
          arguments_.includes('--register-login-item')
        ) {
          const request = JSON.parse(
            readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
          ) as { requestId: string; requestedAt: string };
          writeFileSync(
            join(root.data, 'login-registration-acknowledgement.json'),
            JSON.stringify({
              requestId: request.requestId,
              createdAt: request.requestedAt,
              status: 'enabled',
              registrationChanged: false,
            }),
          );
        }
        return success();
      });
      const operation = testDesktopAdapter(root).afterInstall!(
        adapterContext(root, runCommand),
        [],
      );
      if (variant === 'commit') {
        await expect(operation).resolves.toMatchObject({ loginItem: 'enabled' });
        expect(readFileSync(join(destination, 'runtime.txt'), 'utf8')).toBe('new runtime');
      } else {
        await expect(operation).rejects.toThrow(/timed out/iu);
        expect(readFileSync(join(destination, 'runtime.txt'), 'utf8')).toBe('old runtime');
      }
    }
  });

  it('removes a regular embedded runtime during uninstall cleanup', async () => {
    const root = fixture('embedded-regular-remove');
    const destination = join(
      root.home,
      'Applications',
      'Pimpampum.app',
      'Contents',
      'Resources',
      'PimpampumRuntime',
    );
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'runtime.txt'), 'runtime');
    await testDesktopAdapter(root).afterUninstall!(
      adapterContext(root, async () => success()),
      [],
    );
    expect(existsSync(destination)).toBe(false);
  });

  it('aggregates login unregistration failure after post-registration cleanup fails', async () => {
    const root = fixture('post-registration-cleanup-failure');
    const applications = join(root.home, 'Applications');
    const legacyRoot = join(applications, 'PimpampumMenuBar.app');
    mkdirSync(legacyRoot, { recursive: true });
    chmodSync(applications, 0o500);
    const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => {
      if (executable === '/usr/bin/open' && arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        writeFileSync(
          join(root.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: 'enabled',
            registrationChanged: true,
          }),
        );
      }
      if (executable === '/usr/bin/open' && arguments_.includes('--unregister-login-item')) {
        return { exitCode: 1, stdout: '', stderr: 'unregistration denied' };
      }
      return success();
    });
    const error = await testDesktopAdapter(root).afterInstall!(
      adapterContext(root, runCommand),
      [],
    ).catch((caught: unknown) => caught);
    chmodSync(applications, 0o700);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/unregister/iu) }),
      ]),
    );
  });

  it('rejects incomplete and non-regular app bundle contents', () => {
    for (const missing of [
      join('Contents', 'MacOS', 'PimpampumMenuBar'),
      join('Contents', 'Info.plist'),
    ]) {
      const root = fixture(`missing-${missing.replaceAll('/', '-')}`);
      rmSync(join(root.sourceApp, missing));
      expect(() =>
        testDesktopAdapter(root).artifacts(adapterContext(root, async () => success())),
      ).toThrow(/missing/);
    }

    const root = fixture('special-file');
    const fifo = join(root.sourceApp, 'Contents', 'Resources', 'named-pipe');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    expect(() =>
      testDesktopAdapter(root).artifacts(adapterContext(root, async () => success())),
    ).toThrow(/regular files/);
  });

  it('rejects unsafe handshake targets and restores newly created control files', async () => {
    const invalidTarget = fixture('invalid-target');
    mkdirSync(join(invalidTarget.data, 'login-registration-request.json'));
    await expect(
      testDesktopAdapter(invalidTarget).afterInstall!(
        adapterContext(invalidTarget, async () => success()),
        [],
      ),
    ).rejects.toThrow(/regular file/);

    const clean = fixture('clean-rollback');
    await expect(
      testDesktopAdapter(clean).afterInstall!(
        adapterContext(clean, async () => success()),
        [],
      ),
    ).rejects.toThrow(/timed out/i);
    for (const name of [
      'login-registration-request.json',
      'login-registration-acknowledgement.json',
      'login-item-status.json',
    ]) {
      expect(existsSync(join(clean.data, name))).toBe(false);
    }
  });

  it('rejects every malformed registration acknowledgement and launch failure', async () => {
    const cases: Array<{ label: string; value: unknown }> = [
      { label: 'json', value: '{' },
      { label: 'primitive', value: 4 },
      {
        label: 'keys',
        value: {
          requestId: 'x',
          createdAt: 'x',
          status: 'enabled',
          registrationChanged: true,
          extra: true,
        },
      },
      {
        label: 'request-type',
        value: { requestId: 4, createdAt: 'x', status: 'enabled', registrationChanged: true },
      },
      {
        label: 'date-type',
        value: { requestId: 'x', createdAt: 4, status: 'enabled', registrationChanged: true },
      },
      {
        label: 'status-type',
        value: { requestId: 'x', createdAt: 'x', status: 4, registrationChanged: true },
      },
      {
        label: 'change-type',
        value: { requestId: 'x', createdAt: 'x', status: 'enabled', registrationChanged: 'yes' },
      },
    ];
    for (const testCase of cases) {
      const root = fixture(`ack-${testCase.label}`);
      const runCommand: RunCommand = async (_executable, arguments_) => {
        if (arguments_.includes('--register-login-item')) {
          writeFileSync(
            join(root.data, 'login-registration-acknowledgement.json'),
            typeof testCase.value === 'string' ? testCase.value : JSON.stringify(testCase.value),
          );
        }
        return success();
      };
      await expect(
        testDesktopAdapter(root).afterInstall!(adapterContext(root, runCommand), []),
      ).rejects.toThrow(/invalid/i);
    }

    const root = fixture('registration-launch-failure');
    await expect(
      testDesktopAdapter(root).afterInstall!(
        adapterContext(root, async () => ({ exitCode: 9, stdout: '', stderr: '' })),
        [],
      ),
    ).rejects.toThrow(/launch.*\(9\)/i);
  });

  it('rejects registration error acknowledgements and failure to open the menu app', async () => {
    for (const status of ['error', 'enabled'] as const) {
      const root = fixture(`registration-${status}`);
      let calls = 0;
      const runCommand: RunCommand = async (_executable, arguments_) => {
        calls += 1;
        if (arguments_.includes('--register-login-item')) {
          const request = JSON.parse(
            readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
          ) as { requestId: string; requestedAt: string };
          writeFileSync(
            join(root.data, 'login-registration-acknowledgement.json'),
            JSON.stringify({
              requestId: request.requestId,
              createdAt: request.requestedAt,
              status,
              registrationChanged: status !== 'error',
            }),
          );
          return success();
        }
        if (arguments_.includes('--unregister-login-item')) {
          writeFileSync(
            join(root.data, 'login-unregistration-acknowledgement.json'),
            JSON.stringify({
              createdAt: '2026-08-26T20:00:00Z',
              previousStatus: 'enabled',
              status: 'disabled',
            }),
          );
          return success();
        }
        return { exitCode: 7, stdout: '', stderr: '' };
      };
      await expect(
        testDesktopAdapter(root).afterInstall!(adapterContext(root, runCommand), []),
      ).rejects.toThrow(/open.*\(7\)/i);
      // A rejected registration changed nothing, so there is no login item to roll back.
      expect(calls).toBe(status === 'error' ? 2 : 3);
    }
  });

  it('completes the install and records a rejected login item registration', async () => {
    const root = fixture('registration-rejected');
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        writeFileSync(
          join(root.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: 'error',
            registrationChanged: false,
          }),
        );
      }
      return success();
    };
    await expect(
      testDesktopAdapter(root).afterInstall!(adapterContext(root, runCommand), []),
    ).resolves.toEqual({ loginItem: 'error' });
    expect(
      JSON.parse(readFileSync(join(root.data, 'login-item-status.json'), 'utf8')) as {
        status: string;
      },
    ).toMatchObject({ status: 'error' });
  });

  it('aggregates a failed login-item compensation after registration changed', async () => {
    const root = fixture('registration-compensation-failure');
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        writeFileSync(
          join(root.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: 'enabled',
            registrationChanged: true,
          }),
        );
        return success();
      }
      return {
        exitCode: arguments_.includes('--unregister-login-item') ? 9 : 7,
        stdout: '',
        stderr: '',
      };
    };

    await expect(
      testDesktopAdapter(root).afterInstall!(adapterContext(root, runCommand), []),
    ).rejects.toThrow(AggregateError);
    expect(existsSync(join(root.data, 'login-registration-request.json'))).toBe(false);
    expect(existsSync(join(root.data, 'login-registration-acknowledgement.json'))).toBe(false);
  });

  it('never unregisters a pre-existing approval-pending login item during compensation', async () => {
    const root = fixture('approval-pending-compensation');
    const calls: string[][] = [];
    const runCommand: RunCommand = async (_executable, arguments_) => {
      calls.push(arguments_);
      if (arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        writeFileSync(
          join(root.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: 'requiresApproval',
            registrationChanged: false,
          }),
        );
        return success();
      }
      return { exitCode: 7, stdout: '', stderr: '' };
    };

    await expect(
      testDesktopAdapter(root).afterInstall!(adapterContext(root, runCommand), []),
    ).rejects.toThrow(/open.*\(7\)/i);
    expect(calls.some((arguments_) => arguments_.includes('--unregister-login-item'))).toBe(false);
  });

  it('restores approval-pending login state and a stopped daemon after uninstall fails', async () => {
    const root = fixture('approval-pending-uninstall-rollback');
    let loginState: 'requiresApproval' | 'error' = 'requiresApproval';
    let daemonRunning = false;
    const daemonAdapter = {
      id: 'stopped-daemon',
      platform: 'darwin' as const,
      artifacts: () => [],
      activate: async () => {
        daemonRunning = true;
      },
      deactivate: async () => {
        throw new Error('daemon deactivation failed before mutation');
      },
      isRunning: async () => daemonRunning,
      prepareDeactivationRollback: async () => {
        const priorRunning = daemonRunning;
        return async () => {
          daemonRunning = priorRunning;
        };
      },
    };
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_.includes('--unregister-login-item')) {
        const previousStatus = loginState;
        loginState = 'error';
        writeFileSync(
          join(root.data, 'login-unregistration-acknowledgement.json'),
          JSON.stringify({
            createdAt: '2026-08-26T20:00:00Z',
            previousStatus,
            status: 'disabled',
          }),
        );
      } else if (arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        loginState = 'requiresApproval';
        writeFileSync(
          join(root.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: loginState,
            registrationChanged: true,
          }),
        );
      }
      return success();
    });
    writeFileSync(
      join(root.data, 'login-item-status.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: loginState,
        updatedAt: '2026-08-26T20:00:00Z',
      }),
    );
    const adapter = testDesktopAdapter(root, { daemonAdapter });
    const context = adapterContext(root, runCommand);
    const artifacts = adapter.artifacts(context);
    const rollback = await adapter.prepareDeactivationRollback!(context, artifacts);

    await expect(adapter.deactivate(context, artifacts)).rejects.toThrow(
      'daemon deactivation failed before mutation',
    );
    expect(loginState).toBe('error');
    await expect(rollback()).resolves.toBeUndefined();
    expect(loginState).toBe('requiresApproval');
    expect(daemonRunning).toBe(false);
  });

  it('reports daemon and login-state restoration failures during uninstall rollback', async () => {
    const daemonRoot = fixture('daemon-uninstall-rollback-failure');
    writeFileSync(
      join(daemonRoot.data, 'login-item-status.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'error',
        updatedAt: '2026-08-26T20:00:00Z',
      }),
    );
    const daemonAdapter = {
      id: 'daemon-without-rollback-hook',
      platform: 'darwin' as const,
      artifacts: () => [],
      activate: async () => {
        throw new Error('daemon restoration failed');
      },
      deactivate: async () => undefined,
      isRunning: async () => false,
    };
    const daemonDesktop = testDesktopAdapter(daemonRoot, { daemonAdapter });
    const daemonContext = adapterContext(daemonRoot, async () => success());
    const daemonRollback = await daemonDesktop.prepareDeactivationRollback!(
      daemonContext,
      daemonDesktop.artifacts(daemonContext),
    );
    await expect(daemonRollback()).rejects.toThrow(/macOS deactivation rollback failed/);

    const loginRoot = fixture('login-uninstall-rollback-mismatch');
    writeFileSync(
      join(loginRoot.data, 'login-item-status.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'enabled',
        updatedAt: '2026-08-26T20:00:00Z',
      }),
    );
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--register-login-item')) {
        const request = JSON.parse(
          readFileSync(join(loginRoot.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        writeFileSync(
          join(loginRoot.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: 'requiresApproval',
            registrationChanged: false,
          }),
        );
      }
      return success();
    };
    const loginDesktop = testDesktopAdapter(loginRoot);
    const loginContext = adapterContext(loginRoot, runCommand);
    const loginRollback = await loginDesktop.prepareDeactivationRollback!(
      loginContext,
      loginDesktop.artifacts(loginContext),
    );
    await expect(loginRollback()).rejects.toThrow(/macOS deactivation rollback failed/);
  });

  it('aggregates control-file restoration failures', async () => {
    const root = fixture('registration-restore-failure');
    const requestPath = join(root.data, 'login-registration-request.json');
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--register-login-item')) {
        const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
          requestId: string;
          requestedAt: string;
        };
        writeFileSync(
          join(root.data, 'login-registration-acknowledgement.json'),
          JSON.stringify({
            requestId: request.requestId,
            createdAt: request.requestedAt,
            status: 'enabled',
            registrationChanged: false,
          }),
        );
        return success();
      }
      rmSync(requestPath);
      mkdirSync(requestPath);
      return { exitCode: 7, stdout: '', stderr: '' };
    };

    await expect(
      testDesktopAdapter(root).afterInstall!(adapterContext(root, runCommand), []),
    ).rejects.toThrow(AggregateError);
  });

  it('uses production clock and sleep defaults without weakening the handshake', async () => {
    const root = fixture('defaults');
    let request: { requestId: string; requestedAt: string } | undefined;
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--register-login-item')) {
        request = JSON.parse(
          readFileSync(join(root.data, 'login-registration-request.json'), 'utf8'),
        ) as { requestId: string; requestedAt: string };
        setTimeout(() => {
          writeFileSync(
            join(root.data, 'login-registration-acknowledgement.json'),
            JSON.stringify({
              requestId: request!.requestId,
              createdAt: new Date().toISOString(),
              status: 'enabled',
              registrationChanged: false,
            }),
          );
        }, 1);
      }
      return success();
    };
    const adapter = createMacOSDesktopAdapter({
      appBundlePath: root.sourceApp,
      daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
      acknowledgementPolls: 2,
      acknowledgementPollIntervalMs: 10,
    });
    await expect(adapter.afterInstall!(adapterContext(root, runCommand), [])).resolves.toEqual({
      loginItem: 'enabled',
    });
  });

  it('validates persisted integration status exhaustively', async () => {
    const values: Array<{ label: string; value: unknown; valid?: boolean }> = [
      { label: 'missing', value: undefined, valid: true },
      { label: 'keys', value: { schemaVersion: 1, status: 'enabled', updatedAt: 'x', extra: 1 } },
      { label: 'schema', value: { schemaVersion: 2, status: 'enabled', updatedAt: 'x' } },
      { label: 'date-type', value: { schemaVersion: 1, status: 'enabled', updatedAt: 4 } },
      { label: 'date-value', value: { schemaVersion: 1, status: 'enabled', updatedAt: 'invalid' } },
      {
        label: 'status',
        value: { schemaVersion: 1, status: 'disabled', updatedAt: '2026-08-26T20:00:00Z' },
      },
      {
        label: 'approval',
        value: { schemaVersion: 1, status: 'requiresApproval', updatedAt: '2026-08-26T20:00:00Z' },
        valid: true,
      },
      {
        label: 'error',
        value: { schemaVersion: 1, status: 'error', updatedAt: '2026-08-26T20:00:00Z' },
        valid: true,
      },
    ];
    for (const testCase of values) {
      const root = fixture(`status-${testCase.label}`);
      if (testCase.value !== undefined) {
        writeFileSync(join(root.data, 'login-item-status.json'), JSON.stringify(testCase.value));
      }
      const status = testDesktopAdapter(root).integrationStatus!(
        adapterContext(root, async () => success()),
        [],
      );
      if (testCase.valid) await expect(status).resolves.toBeDefined();
      else await expect(status).rejects.toThrow(/invalid login item status/i);
    }
  });

  it('rejects missing, malformed, stale, failed and nonzero unregistration', async () => {
    const cases: Array<{
      label: string;
      exitCode?: number;
      acknowledgement?: unknown;
      message: RegExp;
    }> = [
      { label: 'missing', message: /did not acknowledge/ },
      {
        label: 'shape',
        acknowledgement: {
          createdAt: 'x',
          previousStatus: 'enabled',
          status: 'disabled',
          extra: 1,
        },
        message: /invalid/i,
      },
      {
        label: 'date-type',
        acknowledgement: { createdAt: 4, previousStatus: 'enabled', status: 'disabled' },
        message: /invalid/i,
      },
      {
        label: 'status-shape',
        acknowledgement: { createdAt: 'x', previousStatus: 'enabled', status: 'unknown' },
        message: /invalid/i,
      },
      {
        label: 'previous-status',
        acknowledgement: { createdAt: 'x', previousStatus: 'unknown', status: 'disabled' },
        message: /invalid/i,
      },
      {
        label: 'date-value',
        acknowledgement: {
          createdAt: 'invalid',
          previousStatus: 'enabled',
          status: 'disabled',
        },
        message: /stale/i,
      },
      {
        label: 'old',
        acknowledgement: {
          createdAt: '2026-08-26T19:59:59Z',
          previousStatus: 'enabled',
          status: 'disabled',
        },
        message: /stale/i,
      },
      {
        label: 'future',
        acknowledgement: {
          createdAt: '2026-08-26T20:00:01Z',
          previousStatus: 'enabled',
          status: 'disabled',
        },
        message: /stale/i,
      },
      {
        label: 'error',
        acknowledgement: {
          createdAt: '2026-08-26T20:00:00Z',
          previousStatus: 'enabled',
          status: 'error',
        },
        message: /unregistration failed/,
      },
      { label: 'nonzero', exitCode: 8, message: /\(8\)/ },
    ];
    for (const testCase of cases) {
      const root = fixture(`unregister-${testCase.label}`);
      const runCommand: RunCommand = async (_executable, arguments_) => {
        if (arguments_.includes('--unregister-login-item') && testCase.acknowledgement) {
          writeFileSync(
            join(root.data, 'login-unregistration-acknowledgement.json'),
            JSON.stringify(testCase.acknowledgement),
          );
        }
        return { exitCode: testCase.exitCode ?? 0, stdout: '', stderr: '' };
      };
      await expect(
        testDesktopAdapter(root).deactivate!(adapterContext(root, runCommand), []),
      ).rejects.toThrow(testCase.message);
    }
  });

  it('quits the installed menu app as the last step of deactivation', async () => {
    for (const pkillExit of [0, 1] as const) {
      const root = fixture(`quit-menu-app-${pkillExit}`);
      const calls: Array<[string, string[]]> = [];
      const runCommand: RunCommand = async (executable, arguments_) => {
        calls.push([executable, arguments_]);
        if (arguments_.includes('--unregister-login-item')) {
          writeFileSync(
            join(root.data, 'login-unregistration-acknowledgement.json'),
            JSON.stringify({
              createdAt: '2026-08-26T20:00:00Z',
              previousStatus: 'error',
              status: 'disabled',
            }),
          );
          return success();
        }
        if (executable === '/usr/bin/pkill') return { exitCode: pkillExit, stdout: '', stderr: '' };
        return success();
      };
      const adapter = testDesktopAdapter(root);
      const context = adapterContext(root, runCommand);
      await expect(
        adapter.deactivate!(context, adapter.artifacts(context)),
      ).resolves.toBeUndefined();
      const pkill = calls.at(-1);
      expect(pkill?.[0]).toBe('/usr/bin/pkill');
      expect(pkill?.[1]).toEqual([
        '-TERM',
        '-f',
        join(root.home, 'Applications', 'Pimpampum.app', 'Contents/MacOS/PimpampumMenuBar'),
      ]);
    }
  });

  it('reports a pkill failure other than "no process" when quitting the menu app', async () => {
    const root = fixture('quit-menu-app-failure');
    const runCommand: RunCommand = async (executable, arguments_) => {
      if (arguments_.includes('--unregister-login-item')) {
        writeFileSync(
          join(root.data, 'login-unregistration-acknowledgement.json'),
          JSON.stringify({
            createdAt: '2026-08-26T20:00:00Z',
            previousStatus: 'enabled',
            status: 'disabled',
          }),
        );
        return success();
      }
      if (executable === '/usr/bin/pkill') return { exitCode: 3, stdout: '', stderr: '' };
      return success();
    };
    const adapter = testDesktopAdapter(root);
    const context = adapterContext(root, runCommand);
    await expect(adapter.deactivate!(context, adapter.artifacts(context))).rejects.toThrow(
      'Unable to stop the macOS menu app (3)',
    );
    expect(() =>
      createMacOSDesktopAdapter({
        appBundlePath: root.sourceApp,
        daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
        pkillPath: 'pkill',
      }),
    ).toThrow('pkill path must be absolute');
  });

  it('replaces prior unregistration acknowledgement and guards cleanup targets', async () => {
    const root = fixture('unregister-prior');
    const acknowledgementPath = join(root.data, 'login-unregistration-acknowledgement.json');
    writeFileSync(acknowledgementPath, 'stale');
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--unregister-login-item')) {
        expect(existsSync(acknowledgementPath)).toBe(false);
        writeFileSync(
          acknowledgementPath,
          JSON.stringify({
            createdAt: '2026-08-26T20:00:00Z',
            previousStatus: 'enabled',
            status: 'disabled',
          }),
        );
      }
      return success();
    };
    const adapter = testDesktopAdapter(root);
    const context = adapterContext(root, runCommand);
    await expect(adapter.deactivate!(context, adapter.artifacts(context))).resolves.toBeUndefined();

    rmSync(acknowledgementPath);
    mkdirSync(acknowledgementPath);
    await expect(
      testDesktopAdapter(root).deactivate!(adapterContext(root, runCommand), []),
    ).rejects.toThrow(/must be a file/);

    const statusPath = join(root.data, 'login-item-status.json');
    mkdirSync(statusPath);
    await expect(
      testDesktopAdapter(root).integrationStatus!(adapterContext(root, runCommand), []),
    ).rejects.toThrow(/regular file/);
    await expect(
      testDesktopAdapter(root).afterUninstall!(adapterContext(root, runCommand), []),
    ).rejects.toThrow(/must be a file/);
  });

  it('preserves unrelated app files and propagates unexpected directory cleanup errors', async () => {
    const root = fixture('cleanup');
    const app = join(root.home, 'Applications', 'Pimpampum.app');
    const resources = join(app, 'Contents', 'Resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, 'unrelated'), 'keep');
    const artifacts = [{ path: join(resources, 'owned'), content: '', mode: 0o600 }];
    await expect(
      testDesktopAdapter(root).afterUninstall!(
        adapterContext(root, async () => success()),
        artifacts,
      ),
    ).resolves.toBeUndefined();
    expect(existsSync(app)).toBe(true);

    rmSync(join(resources, 'unrelated'));
    mkdirSync(join(resources, 'blocked'), { recursive: true });
    writeFileSync(join(resources, 'blocked', 'file'), 'x');
    await expect(
      testDesktopAdapter(root).afterRollback!(
        adapterContext(root, async () => success()),
        [{ path: join(resources, 'blocked', 'owned'), content: '', mode: 0o600 }],
      ),
    ).resolves.toBeUndefined();

    rmSync(join(resources, 'blocked'), { recursive: true });
    const empty = join(app, 'empty');
    mkdirSync(empty);
    chmodSync(app, 0o500);
    try {
      await expect(
        testDesktopAdapter(root).afterRollback!(
          adapterContext(root, async () => success()),
          [{ path: join(empty, 'owned'), content: '', mode: 0o600 }],
        ),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(app, 0o700);
    }
  });
});
