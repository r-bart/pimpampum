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
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLaunchdAdapter } from '../src/service/launchd.js';
import { createPlatformServiceManager } from '../src/service/manager.js';
import {
  GATEKEEPER_OPEN_TIMEOUT_MS,
  createMacOSDesktopAdapter,
  installationMarkerPath,
} from '../src/service/macosApp.js';
import type { PlatformServiceAdapter, RunCommand } from '../src/service/types.js';
import { acknowledgingOpen, adapterContext, commandResult, success } from './helpers/service.js';

const roots: string[] = [];
const FROZEN_NOW = '2026-08-26T20:00:00.000Z';
/** The bound the adapter passes to the launches of the installed app, and to nothing else. */
const GATEKEEPER_OPEN = { timeoutMilliseconds: GATEKEEPER_OPEN_TIMEOUT_MS };
const LOGIN_ITEM_INSTRUCTION = 'Remove Pimpampum from System Settings › Login Items';

interface Fixture {
  root: string;
  home: string;
  data: string;
  sourceApp: string;
}

function fixture(label: string, options: { home?: string; sourceParent?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-macos-${label}-`));
  roots.push(root);
  const home = join(root, options.home ?? 'Home With Spaces ü');
  const data = join(root, 'Data ñ');
  const sourceApp = join(root, options.sourceParent ?? 'build', 'Pimpampum.app');
  writeBundle(sourceApp);
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'token'), 'secret-token');
  writeFileSync(
    join(sourceApp, 'Contents', 'Resources', 'installation.json'),
    '{"dataDirectory":"must-be-replaced"}',
  );
  return { root, home, data, sourceApp };
}

/** A minimal but complete bundle: executable, Info.plist, one resource. */
function writeBundle(bundle: string): void {
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist/>', { mode: 0o644 });
  writeFileSync(join(bundle, 'Contents', 'MacOS', 'PimpampumMenuBar'), 'binary', { mode: 0o755 });
  writeFileSync(join(bundle, 'Contents', 'Resources', 'asset.txt'), 'asset', { mode: 0o640 });
}

function writeEmbeddedRuntime(bundle: string, content = 'runtime'): string {
  const runtime = join(bundle, 'Contents', 'Resources', 'PimpampumRuntime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'node'), content, { mode: 0o755 });
  return runtime;
}

/** The managed copy an earlier install left in `~/Applications`; hook-level tests need it present. */
function installedBundle(root: Fixture): string {
  const bundle = join(root.home, 'Applications', 'Pimpampum.app');
  writeBundle(bundle);
  return bundle;
}

/** A daemon adapter with nothing to activate, deactivate or roll back. */
function idleDaemon(): PlatformServiceAdapter {
  return {
    id: 'idle-daemon',
    platform: 'darwin',
    artifacts: () => [],
    activate: async () => undefined,
    deactivate: async () => undefined,
    isRunning: async () => false,
  };
}

/** Every path under `root` with its bytes and mode, so two trees can be compared exactly. */
function treeSnapshot(root: string): Array<[string, string, number]> {
  const entries: Array<[string, string, number]> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const mode = statSync(path).mode & 0o777;
      if (entry.isDirectory()) {
        entries.push([relative(root, path), '<directory>', mode]);
        visit(path);
      } else {
        entries.push([relative(root, path), readFileSync(path).toString('base64'), mode]);
      }
    }
  };
  visit(root);
  return entries;
}

function context(root: Fixture, runCommand: RunCommand = async () => success()) {
  return adapterContext({ homeDirectory: root.home, dataDirectory: root.data, runCommand });
}

/** `launchctl print` reports a running daemon; everything else succeeds. */
const launchdRunning: RunCommand = async (executable, arguments_) =>
  executable === '/bin/launchctl' && arguments_[0] === 'print'
    ? commandResult({ stdout: 'state = running\npid = 5\n' })
    : success();

function testDesktopAdapter(
  root: Fixture,
  options: Partial<Parameters<typeof createMacOSDesktopAdapter>[0]> = {},
): PlatformServiceAdapter {
  return createMacOSDesktopAdapter({
    appBundlePath: root.sourceApp,
    daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
    now: () => new Date(FROZEN_NOW),
    sleep: async () => undefined,
    ...options,
  });
}

function manager(root: Fixture, runCommand: RunCommand, adapter: PlatformServiceAdapter) {
  return createPlatformServiceManager({
    platform: 'darwin',
    homeDirectory: root.home,
    dataDirectory: root.data,
    nodePath: '/usr/local/bin/node',
    cliPath: '/opt/pimpampum/dist/cli.js',
    version: '1.0.0',
    runCommand,
    adapters: { darwin: adapter },
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function receiptPaths(root: Fixture): string[] {
  const receipt = readJson(join(root.data, 'install-receipt.json')) as {
    artifacts: Array<{ path: string }>;
  };
  return receipt.artifacts.map((artifact) => artifact.path);
}

const CONTROL_FILES = [
  'login-registration-request.json',
  'login-registration-acknowledgement.json',
  'login-item-status.json',
  'login-unregistration-acknowledgement.json',
  'application-path.json',
];

/** A clock that only moves when the adapter sleeps, so the handshake window is measured, not real. */
function tickingClock(start = FROZEN_NOW): {
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  slept: () => number;
} {
  let current = Date.parse(start);
  let slept = 0;
  return {
    now: () => new Date(current),
    sleep: async (milliseconds) => {
      current += milliseconds;
      slept += milliseconds;
    },
    slept: () => slept,
  };
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
        const request = readJson(join(root.data, 'login-registration-request.json')) as {
          requestId: string;
          requestedAt: string;
        };
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
            createdAt: FROZEN_NOW,
            previousStatus: 'requiresApproval',
            status: 'disabled',
          }),
          { mode: 0o600 },
        );
      }
      return launchdRunning(executable, arguments_);
    });
    const lifecycle = manager(root, runCommand, testDesktopAdapter(root));
    const installedApp = join(root.home, 'Applications', 'Pimpampum.app');

    await expect(lifecycle.install()).resolves.toMatchObject({
      installed: true,
      reconciled: false,
      loginItem: 'enabled',
    });
    // The marker lives outside the bundle (L-21): a file added under `Contents/Resources` broke the
    // code seal of the signed copy. It names the data directory and is private to the account.
    const marker = installationMarkerPath({ homeDirectory: root.home });
    expect(marker).toBe(
      join(root.home, 'Library', 'Application Support', 'Pimpampum', 'installation.json'),
    );
    expect(readJson(marker)).toEqual({ schemaVersion: 2, dataDirectory: root.data });
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(existsSync(join(installedApp, 'Contents', 'Resources', 'installation.json'))).toBe(
      false,
    );
    expect(statSync(join(installedApp, 'Contents', 'MacOS', 'PimpampumMenuBar')).mode & 0o777).toBe(
      0o755,
    );
    expect(readFileSync(join(root.data, 'install-receipt.json'), 'utf8')).not.toContain(
      'secret-token',
    );
    expect(readJson(join(root.data, 'application-path.json'))).toEqual({
      schemaVersion: 2,
      path: installedApp,
      managed: true,
    });

    await expect(lifecycle.status()).resolves.toMatchObject({
      installed: true,
      running: true,
      adapter: 'launchd-macos-app',
      loginItem: 'enabled',
    });
    await expect(lifecycle.install()).resolves.toMatchObject({
      reconciled: true,
      loginItem: 'requiresApproval',
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);

    await expect(lifecycle.uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    expect(existsSync(installedApp)).toBe(false);
    for (const name of CONTROL_FILES) expect(existsSync(join(root.data, name))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(root.data, 'token'), 'utf8')).toBe('secret-token');
    expect(runCommand.mock.calls).toContainEqual([
      '/usr/bin/open',
      // No `-W`: the helper's acknowledgement file is polled instead. When setup adopts an app
      // the user already placed in an Applications folder, that bundle is also the running
      // menu-bar app and `-W` waits on the wrong instance.
      ['-n', installedApp, '--args', '--unregister-login-item'],
    ]);
    expect(runCommand.mock.calls).toContainEqual([
      '/usr/bin/open',
      ['-n', installedApp],
      GATEKEEPER_OPEN,
    ]);
  });

  it('writes nothing inside the managed copy beyond the signed source files', async () => {
    // A Developer ID bundle is sealed over `Contents`; `codesign --verify --deep --strict` fails
    // with "file added" for anything setup puts there. The installed copy must therefore hold the
    // source files and only the source files, the pre-1.2.12 marker of the source excluded.
    const root = fixture('sealed-copy');
    writeEmbeddedRuntime(root.sourceApp);
    const installer = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
    await manager(root, installer, testDesktopAdapter(root)).install();

    const files = (bundle: string) =>
      treeSnapshot(bundle).filter(([, content]) => content !== '<directory>');
    const expected = files(root.sourceApp).filter(
      ([path]) => path !== join('Contents', 'Resources', 'installation.json'),
    );
    expect(files(join(root.home, 'Applications', 'Pimpampum.app'))).toEqual(expected);
    expect(receiptPaths(root)).not.toContain(installationMarkerPath({ homeDirectory: root.home }));
  });

  it('bounds only the launches of the installed app by the Gatekeeper deadline', async () => {
    // The first `open -n` of a freshly copied signed app waits on Gatekeeper, often for more than
    // the runner's 60 s default. Every other command keeps the default.
    const root = fixture('gatekeeper');
    const runCommand = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
    const lifecycle = manager(root, runCommand, testDesktopAdapter(root));
    const installedApp = join(root.home, 'Applications', 'Pimpampum.app');

    await lifecycle.install();
    await lifecycle.uninstall();

    expect(GATEKEEPER_OPEN_TIMEOUT_MS).toBe(180_000);
    const bounded = runCommand.mock.calls.filter((call) => call.length === 3);
    expect(bounded).toEqual([
      [
        '/usr/bin/open',
        ['-n', installedApp, '--args', '--register-login-item', expect.any(String)],
        GATEKEEPER_OPEN,
      ],
      ['/usr/bin/open', ['-n', installedApp], GATEKEEPER_OPEN],
    ]);
    const unbounded = runCommand.mock.calls.filter((call) => call.length === 2);
    expect(unbounded).toContainEqual([
      '/usr/bin/open',
      ['-n', installedApp, '--args', '--unregister-login-item'],
    ]);
    expect(unbounded.some(([executable]) => executable === '/usr/bin/pkill')).toBe(true);
    expect(unbounded.some(([executable]) => executable === '/bin/launchctl')).toBe(true);
  });

  it('serves status, reinstall and uninstall of a managed copy from the installed CLI', async () => {
    // Topology: setup ran from Downloads and copied the app into ~/Applications. Later the
    // installed CLI runs with that managed copy as its only bundle. Its parent directory says
    // "adopted"; the record written at install says "managed", and the record wins.
    const root = fixture('installed-cli-managed', { sourceParent: 'Downloads' });
    writeEmbeddedRuntime(root.sourceApp);
    const managed = join(root.home, 'Applications', 'Pimpampum.app');
    const installer = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
    await expect(
      manager(root, installer, testDesktopAdapter(root)).install(),
    ).resolves.toMatchObject({ installed: true, reconciled: false, loginItem: 'enabled' });
    expect(installer.mock.calls).toContainEqual([
      '/usr/bin/open',
      ['-n', managed, '--args', '--register-login-item', expect.any(String)],
      GATEKEEPER_OPEN,
    ]);
    expect(installer.mock.calls).toContainEqual([
      '/usr/bin/open',
      ['-n', managed],
      GATEKEEPER_OPEN,
    ]);
    expect(receiptPaths(root)).toEqual(
      expect.arrayContaining([
        join(managed, 'Contents', 'Info.plist'),
        join(managed, 'Contents', 'MacOS', 'PimpampumMenuBar'),
      ]),
    );
    expect(receiptPaths(root)).not.toContain(
      join(managed, 'Contents', 'Resources', 'installation.json'),
    );
    expect(readJson(installationMarkerPath({ homeDirectory: root.home }))).toEqual({
      schemaVersion: 2,
      dataDirectory: root.data,
    });
    expect(existsSync(join(managed, 'Contents', 'Resources', 'PimpampumRuntime', 'node'))).toBe(
      true,
    );
    expect(readJson(join(root.data, 'application-path.json'))).toEqual({
      schemaVersion: 2,
      path: managed,
      managed: true,
    });

    const runCommand = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
    const installedCli = manager(
      root,
      runCommand,
      testDesktopAdapter(root, { appBundlePath: managed }),
    );
    await expect(installedCli.status()).resolves.toMatchObject({
      installed: true,
      running: true,
      loginItem: 'enabled',
    });
    // Re-running setup from the installed CLI reconciles in place: no second runtime copy.
    await expect(installedCli.install()).resolves.toMatchObject({
      installed: true,
      reconciled: true,
    });
    expect(
      readdirSync(join(managed, 'Contents', 'Resources')).filter((name) =>
        name.startsWith('.PimpampumRuntime'),
      ),
    ).toEqual([]);
    expect(readJson(join(root.data, 'application-path.json'))).toMatchObject({ managed: true });

    await expect(installedCli.uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    expect(existsSync(managed)).toBe(false);
    expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(false);
    for (const name of CONTROL_FILES) expect(existsSync(join(root.data, name))).toBe(false);
    expect(runCommand.mock.calls).toContainEqual([
      '/usr/bin/open',
      ['-n', managed, '--args', '--unregister-login-item'],
    ]);
    const pkill = runCommand.mock.calls.find(([executable]) => executable === '/usr/bin/pkill');
    expect(pkill?.[1].slice(0, 2)).toEqual(['-TERM', '-f']);
    expect(new RegExp(pkill![1][2]!).test(join(managed, 'Contents/MacOS/PimpampumMenuBar'))).toBe(
      true,
    );
  });

  it('adopts a bundle the user placed in Applications and leaves it byte-identical', async () => {
    // Copying such a copy into ~/Applications leaves two menu-bar icons: the user's app and the one
    // macOS starts when the login item is registered. Setup registers the copy that is there and
    // owns nothing inside it — not the marker, not the embedded runtime.
    const root = fixture('adopted');
    const userApp = join(root.home, 'Applications', 'Pimpampum.app');
    writeBundle(userApp);
    writeEmbeddedRuntime(userApp, 'the user runtime');
    const before = treeSnapshot(userApp);
    const plist = join(root.home, 'Library', 'LaunchAgents');

    const installer = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
    const setup = manager(root, installer, testDesktopAdapter(root, { appBundlePath: userApp }));
    await expect(setup.install()).resolves.toMatchObject({ installed: true, loginItem: 'enabled' });
    expect(installer.mock.calls).toContainEqual([
      '/usr/bin/open',
      ['-n', userApp, '--args', '--register-login-item', expect.any(String)],
      GATEKEEPER_OPEN,
    ]);
    expect(installer.mock.calls).toContainEqual([
      '/usr/bin/open',
      ['-n', userApp],
      GATEKEEPER_OPEN,
    ]);
    const receipt = receiptPaths(root);
    expect(receipt).toHaveLength(1);
    expect(receipt[0]!.startsWith(plist)).toBe(true);
    // The adopted app still learns its data directory: the marker sits outside every bundle now.
    const marker = installationMarkerPath({ homeDirectory: root.home });
    expect(readJson(marker)).toEqual({ schemaVersion: 2, dataDirectory: root.data });
    expect(readJson(join(root.data, 'application-path.json'))).toEqual({
      schemaVersion: 2,
      path: userApp,
      managed: false,
    });
    expect(treeSnapshot(userApp)).toEqual(before);
    await expect(setup.status()).resolves.toMatchObject({ installed: true, running: true });

    // The installed CLI later sees the same bundle as its source and the packaged runtime as its
    // build tree; both read the record and neither claims the user's app.
    for (const appBundlePath of [
      userApp,
      join(root.root, 'Library', 'Runtime', 'platforms', 'macos', 'dist', 'Pimpampum.app'),
    ]) {
      const runCommand = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
      const cli = manager(root, runCommand, testDesktopAdapter(root, { appBundlePath }));
      await expect(cli.status()).resolves.toMatchObject({
        installed: true,
        running: true,
        loginItem: 'enabled',
      });
      const prepared = await cli.prepareUninstall!();
      expect(prepared).not.toBeNull();
      await prepared!.rollback();
      expect(treeSnapshot(userApp)).toEqual(before);
      expect(runCommand.mock.calls).toContainEqual([
        '/usr/bin/open',
        ['-n', userApp, '--args', '--unregister-login-item'],
      ]);
    }

    const runCommand = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
    const cli = manager(root, runCommand, testDesktopAdapter(root, { appBundlePath: userApp }));
    await expect(cli.uninstall()).resolves.toEqual({ uninstalled: true, dataPreserved: true });
    expect(treeSnapshot(userApp)).toEqual(before);
    expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(false);
    for (const name of CONTROL_FILES) expect(existsSync(join(root.data, name))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('uninstalls a managed copy from an installed CLI without a build tree and rolls back control files', async () => {
    // Topology: the installed CLI runs from the packaged runtime, where the bundle path does not
    // exist. Only the receipt and the record say what to remove and which bundle to ask.
    const root = fixture('installed-cli-runtime', { sourceParent: 'Downloads' });
    writeEmbeddedRuntime(root.sourceApp);
    const managed = join(root.home, 'Applications', 'Pimpampum.app');
    const installer = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
    await manager(root, installer, testDesktopAdapter(root)).install();
    const controlBefore = new Map(
      ['application-path.json', 'login-item-status.json'].map((name) => [
        name,
        [readFileSync(join(root.data, name)), statSync(join(root.data, name)).mode & 0o777],
      ]),
    );
    const appBefore = treeSnapshot(managed);

    let pkillExit = 3;
    const runCommand = acknowledgingOpen({
      dataDirectory: root.data,
      fallback: async (executable, arguments_) =>
        executable === '/usr/bin/pkill'
          ? commandResult({ exitCode: pkillExit })
          : launchdRunning(executable, arguments_),
    });
    const adapter = testDesktopAdapter(root, {
      appBundlePath: join(
        root.root,
        'Library',
        'Runtime',
        'platforms',
        'macos',
        'dist',
        'Pimpampum.app',
      ),
    });
    const cli = manager(root, runCommand, adapter);
    await expect(cli.status()).resolves.toMatchObject({
      installed: true,
      running: true,
      loginItem: 'enabled',
    });

    // The menu app refuses to quit: everything the uninstall removed or changed comes back.
    await expect(cli.uninstall()).rejects.toThrow('Unable to stop the macOS menu app (3)');
    expect(treeSnapshot(managed)).toEqual(appBefore);
    expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(true);
    for (const [name, [content, mode]] of controlBefore) {
      expect(readFileSync(join(root.data, name))).toEqual(content);
      expect(statSync(join(root.data, name)).mode & 0o777).toBe(mode);
    }
    expect(existsSync(join(root.data, 'login-unregistration-acknowledgement.json'))).toBe(false);
    await expect(cli.status()).resolves.toMatchObject({ installed: true, loginItem: 'enabled' });

    pkillExit = 0;
    await expect(cli.uninstall()).resolves.toEqual({ uninstalled: true, dataPreserved: true });
    expect(existsSync(managed)).toBe(false);
    expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(false);
    for (const name of CONTROL_FILES) expect(existsSync(join(root.data, name))).toBe(false);
    expect(runCommand.mock.calls).toContainEqual([
      '/usr/bin/open',
      ['-n', managed, '--args', '--unregister-login-item'],
    ]);
    expect(runCommand.mock.calls).toContainEqual([
      '/bin/launchctl',
      ['bootout', 'gui/501', expect.stringContaining('LaunchAgents')],
    ]);
  });

  it('uninstalls without the helper when the app is already gone and tells the user about the login item', async () => {
    const root = fixture('trashed-app', { sourceParent: 'Downloads' });
    const managed = join(root.home, 'Applications', 'Pimpampum.app');
    await manager(
      root,
      acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning }),
      testDesktopAdapter(root),
    ).install();
    rmSync(managed, { recursive: true });

    const runCommand = acknowledgingOpen({ dataDirectory: root.data, fallback: launchdRunning });
    const cli = manager(
      root,
      runCommand,
      testDesktopAdapter(root, {
        appBundlePath: join(
          root.root,
          'Library',
          'Runtime',
          'platforms',
          'macos',
          'dist',
          'Pimpampum.app',
        ),
      }),
    );
    await expect(cli.uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
      manualInstructions: [LOGIN_ITEM_INSTRUCTION],
    });
    expect(
      runCommand.mock.calls.some(([, arguments_]) =>
        arguments_.includes('--unregister-login-item'),
      ),
    ).toBe(false);
    expect(runCommand.mock.calls).toContainEqual([
      '/bin/launchctl',
      ['bootout', 'gui/501', expect.stringContaining('LaunchAgents')],
    ]);
    expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(false);
    for (const name of CONTROL_FILES) expect(existsSync(join(root.data, name))).toBe(false);
  });

  it('keeps the install and records an error when the registration helper never answers', async () => {
    const root = fixture('registration-timeout');
    const clock = tickingClock();
    const runCommand = vi.fn<RunCommand>(launchdRunning);
    const lifecycle = manager(
      root,
      runCommand,
      testDesktopAdapter(root, { now: clock.now, sleep: clock.sleep }),
    );
    const installedApp = join(root.home, 'Applications', 'Pimpampum.app');

    await expect(lifecycle.install()).resolves.toMatchObject({
      installed: true,
      loginItem: 'error',
    });
    // The helper got the whole window the request itself carries, not a shorter one.
    const request = readJson(join(root.data, 'login-registration-request.json')) as {
      requestedAt: string;
      expiresAt: string;
    };
    expect(Date.parse(request.expiresAt) - Date.parse(request.requestedAt)).toBe(30_000);
    expect(clock.slept()).toBeGreaterThanOrEqual(30_000);
    expect(clock.slept()).toBeLessThan(30_000 + 1_000);
    expect(readJson(join(root.data, 'login-item-status.json'))).toMatchObject({ status: 'error' });
    expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(true);
    expect(existsSync(join(installedApp, 'Contents', 'Info.plist'))).toBe(true);
    // The menu app still opens so its notice can offer the retry.
    expect(runCommand.mock.calls).toContainEqual([
      '/usr/bin/open',
      ['-n', installedApp],
      GATEKEEPER_OPEN,
    ]);
    await expect(lifecycle.status()).resolves.toMatchObject({
      installed: true,
      running: true,
      loginItem: 'error',
    });
  });

  it('completes deactivation and asks for manual removal when unregistration is never acknowledged', async () => {
    const root = fixture('unregistration-timeout');
    installedBundle(root);
    const clock = tickingClock();
    const adapter = testDesktopAdapter(root, { now: clock.now, sleep: clock.sleep });
    const runCommand = vi.fn<RunCommand>(async () => success());
    const testContext = context(root, runCommand);
    const artifacts = adapter.artifacts(testContext);
    await expect(adapter.deactivate(testContext, artifacts)).resolves.toBeUndefined();
    expect(clock.slept()).toBeGreaterThanOrEqual(30_000);
    expect(runCommand.mock.calls.at(-1)?.[0]).toBe('/usr/bin/pkill');
    await expect(adapter.afterUninstall!(testContext, artifacts)).resolves.toEqual({
      manualInstructions: [LOGIN_ITEM_INSTRUCTION],
    });
    // The instruction belongs to that one uninstall, not to the next.
    await expect(adapter.afterUninstall!(testContext, artifacts)).resolves.toBeUndefined();

    // Without a bundle there is nobody to ask: no `open` at all, the daemon still stops.
    const trashed = fixture('unregistration-trashed');
    const trashedAdapter = testDesktopAdapter(trashed);
    const trashedCommand = vi.fn<RunCommand>(async () => success());
    const trashedContext = context(trashed, trashedCommand);
    const trashedArtifacts = trashedAdapter.artifacts(trashedContext);
    await expect(
      trashedAdapter.deactivate(trashedContext, trashedArtifacts),
    ).resolves.toBeUndefined();
    expect(trashedCommand.mock.calls.some(([executable]) => executable === '/usr/bin/open')).toBe(
      false,
    );
    expect(trashedCommand.mock.calls.some(([, arguments_]) => arguments_[0] === 'bootout')).toBe(
      true,
    );
    await expect(trashedAdapter.afterUninstall!(trashedContext, trashedArtifacts)).resolves.toEqual(
      {
        manualInstructions: [LOGIN_ITEM_INSTRUCTION],
      },
    );
  });

  it('bounds the handshake poll when the injected clock never advances', async () => {
    // A frozen clock never reaches the deadline; the poll count the window admits ends the wait.
    const root = fixture('frozen-clock');
    installedBundle(root);
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
    const adapter = testDesktopAdapter(root, { sleep });
    const testContext = context(root);
    const artifacts = adapter.artifacts(testContext);
    await expect(adapter.deactivate(testContext, artifacts)).resolves.toBeUndefined();
    expect(sleep.mock.calls.length).toBeGreaterThan(0);
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(30_000 / 100 + 1);
    await expect(adapter.afterUninstall!(testContext, artifacts)).resolves.toEqual({
      manualInstructions: [LOGIN_ITEM_INSTRUCTION],
    });
  });

  it('restores the control files an interrupted uninstall already removed', async () => {
    const root = fixture('control-file-rollback');
    const files = new Map<string, [string, number]>([
      [
        'application-path.json',
        ['{"schemaVersion":2,"path":"/Applications/Pimpampum.app","managed":false}', 0o640],
      ],
      [
        'login-item-status.json',
        [JSON.stringify({ schemaVersion: 1, status: 'error', updatedAt: FROZEN_NOW }), 0o600],
      ],
      ['login-registration-request.json', ['{"requestId":"prior"}', 0o644]],
    ]);
    for (const [name, [content, mode]] of files) {
      writeFileSync(join(root.data, name), content, { mode });
    }
    const adapter = testDesktopAdapter(root, { daemonAdapter: idleDaemon() });
    const testContext = context(root);
    const rollback = await adapter.prepareDeactivationRollback!(testContext, []);
    for (const name of CONTROL_FILES) rmSync(join(root.data, name), { force: true });
    writeFileSync(join(root.data, 'login-unregistration-acknowledgement.json'), 'created later');

    await expect(rollback()).resolves.toBeUndefined();
    for (const [name, [content, mode]] of files) {
      expect(readFileSync(join(root.data, name), 'utf8')).toBe(content);
      expect(statSync(join(root.data, name)).mode & 0o777).toBe(mode);
    }
    expect(existsSync(join(root.data, 'login-unregistration-acknowledgement.json'))).toBe(false);

    // A control path that turned into a directory cannot be restored, and the rollback says so.
    const blocked = await adapter.prepareDeactivationRollback!(testContext, []);
    rmSync(join(root.data, 'application-path.json'));
    mkdirSync(join(root.data, 'application-path.json'));
    await expect(blocked()).rejects.toThrow(/macOS deactivation rollback failed/);
  });

  it('migrates receipt-owned historical app bundle names to the stable technical path', async () => {
    const root = fixture('legacy-bundle-migration');
    const lifecycle = manager(
      root,
      acknowledgingOpen({ dataDirectory: root.data, registrationChanged: false }),
      testDesktopAdapter(root),
    );
    await lifecycle.install();
    const stableRoot = join(root.home, 'Applications', 'Pimpampum.app');
    const legacyRoot = join(root.home, 'Applications', 'PimpampumMenuBar.app');
    const unrelatedLegacyPath = join(root.home, 'Applications', 'pim • pam • pum.app');
    writeFileSync(unrelatedLegacyPath, 'unrelated user file');
    renameSync(stableRoot, legacyRoot);
    const receiptPath = join(root.data, 'install-receipt.json');
    const receipt = readJson(receiptPath) as { artifacts: Array<{ path: string }> };
    for (const artifact of receipt.artifacts) {
      artifact.path = artifact.path.replace(stableRoot, legacyRoot);
    }
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    await expect(lifecycle.install()).resolves.toMatchObject({ installed: true, reconciled: true });
    expect(existsSync(stableRoot)).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false);
    expect(readFileSync(unrelatedLegacyPath, 'utf8')).toBe('unrelated user file');
  });

  it('rolls back app, daemon, record and prior handshake files when registration fails', async () => {
    const root = fixture('rollback');
    for (const name of [
      'login-registration-request.json',
      'login-registration-acknowledgement.json',
      'login-item-status.json',
    ]) {
      writeFileSync(join(root.data, name), `prior-${name}`, { mode: 0o640 });
    }
    const marker = installationMarkerPath({ homeDirectory: root.home });
    mkdirSync(join(marker, '..'), { recursive: true });
    writeFileSync(marker, 'prior-marker', { mode: 0o640 });
    // The helper answers, then the menu app itself refuses to open.
    const runCommand = acknowledgingOpen({
      dataDirectory: root.data,
      registrationChanged: false,
      fallback: async (executable, arguments_) =>
        executable === '/usr/bin/open' && arguments_.length === 2
          ? commandResult({ exitCode: 7 })
          : success(),
    });
    const lifecycle = manager(root, runCommand, testDesktopAdapter(root));

    await expect(lifecycle.install()).rejects.toThrow(/open the macOS menu app \(7\)/i);
    expect(existsSync(join(root.home, 'Applications', 'Pimpampum.app'))).toBe(false);
    expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(false);
    expect(existsSync(join(root.data, 'application-path.json'))).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('prior-marker');
    expect(statSync(marker).mode & 0o777).toBe(0o640);
    for (const name of [
      'login-registration-request.json',
      'login-registration-acknowledgement.json',
      'login-item-status.json',
    ]) {
      expect(readFileSync(join(root.data, name), 'utf8')).toBe(`prior-${name}`);
      expect(statSync(join(root.data, name)).mode & 0o777).toBe(0o640);
    }
  });

  it('reads the location record before the parent directory heuristic', () => {
    const root = fixture('location-record');
    const testContext = context(root);
    const daemon = createLaunchdAdapter({ guiDomain: 'gui/501' });
    const managed = join(root.home, 'Applications', 'Pimpampum.app');
    const recordPath = join(root.data, 'application-path.json');
    const ownedRoots = (appBundlePath: string): string[] =>
      createMacOSDesktopAdapter({ appBundlePath, daemonAdapter: daemon }).ownedArtifactRoots!(
        testContext,
      );
    const runtimeBundle = join(root.root, 'runtime', 'platforms', 'macos', 'dist', 'Pimpampum.app');

    // No record: the parent directory decides, for a bundle that exists or not.
    expect(ownedRoots(root.sourceApp)).toContain(managed);
    expect(ownedRoots(runtimeBundle)).toContain(managed);
    writeBundle(managed);
    expect(ownedRoots(managed)).not.toContain(managed);
    expect(ownedRoots('/Applications/Pimpampum.app')).not.toContain(managed);
    // ...unless the bundle at the managed path carries the in-bundle marker only a managed install
    // by a release before 1.2.12 wrote. That legacy marker is still read for one release, because
    // those installs have no record yet.
    writeFileSync(
      join(managed, 'Contents', 'Resources', 'installation.json'),
      JSON.stringify({ dataDirectory: join(root.root, 'another data directory') }),
    );
    expect(ownedRoots(managed)).not.toContain(managed);
    writeFileSync(join(managed, 'Contents', 'Resources', 'installation.json'), 'not json');
    expect(ownedRoots(managed)).not.toContain(managed);
    writeFileSync(
      join(managed, 'Contents', 'Resources', 'installation.json'),
      JSON.stringify({ dataDirectory: root.data }),
    );
    expect(ownedRoots(managed)).toContain(managed);
    // The fixed-path marker never drives this heuristic: every install that writes it also writes
    // the record, so a marker without a record says nothing about who put the bundle there.
    rmSync(join(managed, 'Contents', 'Resources', 'installation.json'));
    const fixedMarker = installationMarkerPath({ homeDirectory: root.home });
    mkdirSync(join(fixedMarker, '..'), { recursive: true });
    writeFileSync(fixedMarker, JSON.stringify({ schemaVersion: 2, dataDirectory: root.data }));
    expect(ownedRoots(managed)).not.toContain(managed);
    rmSync(fixedMarker);
    writeFileSync(
      join(managed, 'Contents', 'Resources', 'installation.json'),
      JSON.stringify({ dataDirectory: root.data }),
    );

    // A schema 2 record overrides the heuristic in both directions.
    writeFileSync(recordPath, JSON.stringify({ schemaVersion: 2, path: managed, managed: true }));
    expect(ownedRoots(managed)).toContain(managed);
    expect(ownedRoots(runtimeBundle)).toContain(managed);
    writeFileSync(recordPath, JSON.stringify({ schemaVersion: 2, path: managed, managed: false }));
    expect(ownedRoots(root.sourceApp)).not.toContain(managed);
    // Schema 1 is read once: only the managed path ever meant a managed copy.
    writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, path: managed }));
    expect(ownedRoots(managed)).toContain(managed);
    writeFileSync(
      recordPath,
      JSON.stringify({ schemaVersion: 1, path: '/Applications/Pimpampum.app' }),
    );
    expect(ownedRoots(runtimeBundle)).not.toContain(managed);
    expect(ownedRoots(runtimeBundle)).toEqual(
      expect.arrayContaining([join(root.home, 'Applications', 'PimpampumMenuBar.app')]),
    );

    // A record with keys this release does not know is still a record, exactly as the Swift
    // reader treats it; the reader is the one `runtime/bootstrap.ts` shares with the updater.
    writeFileSync(
      recordPath,
      '{"schemaVersion":2,"path":"/Applications/Pimpampum.app","managed":false,"extra":1}',
    );
    expect(ownedRoots(runtimeBundle)).not.toContain(managed);
    // A malformed or hostile record is ignored rather than pointing the uninstaller anywhere.
    rmSync(join(managed, 'Contents', 'Resources', 'installation.json'));
    for (const invalid of [
      '{"schemaVersion":3,"path":"/Applications/Pimpampum.app","managed":true}',
      '{"schemaVersion":2,"path":"/Applications/Pimpampum.app"}',
      '{"schemaVersion":2,"path":"/Applications/Pimpampum.app","managed":"yes"}',
      '{"schemaVersion":2,"path":"relative/Pimpampum.app","managed":false}',
      '{"schemaVersion":2,"path":"/Applications/Pim\\u0000pampum.app","managed":false}',
      '{"schemaVersion":1,"path":42}',
      '{"schemaVersion":1}',
      '["/Applications/Pimpampum.app"]',
      'not json at all',
    ]) {
      writeFileSync(recordPath, invalid, { mode: 0o600 });
      expect(ownedRoots(runtimeBundle)).toContain(managed);
      expect(ownedRoots(managed)).not.toContain(managed);
    }
    rmSync(recordPath);
    symlinkSync(join(root.root, 'elsewhere.json'), recordPath);
    expect(ownedRoots(runtimeBundle)).toContain(managed);
  });

  it('rewrites a schema 1 record as schema 2 on the next install', async () => {
    const root = fixture('record-migration');
    const managed = join(root.home, 'Applications', 'Pimpampum.app');
    writeFileSync(
      join(root.data, 'application-path.json'),
      JSON.stringify({ schemaVersion: 1, path: managed }),
      { mode: 0o600 },
    );
    await manager(
      root,
      acknowledgingOpen({ dataDirectory: root.data, registrationChanged: false }),
      testDesktopAdapter(root),
    ).install();
    expect(readJson(join(root.data, 'application-path.json'))).toEqual({
      schemaVersion: 2,
      path: managed,
      managed: true,
    });
  });

  it('rejects unsafe bundles and invalid adapter options before installation', async () => {
    const root = fixture('validation');
    const testContext = context(root);
    const daemon = createLaunchdAdapter({ guiDomain: 'gui/501' });
    expect(() =>
      createMacOSDesktopAdapter({ appBundlePath: 'relative', daemonAdapter: daemon }).artifacts(
        testContext,
      ),
    ).toThrow(/absolute/);
    // A missing bundle no longer breaks planning: status and uninstall run from the installed
    // runtime, which has no build tree. Install is where the source is required.
    const withoutBundle = createMacOSDesktopAdapter({
      appBundlePath: join(root.root, 'missing.app'),
      daemonAdapter: daemon,
    });
    expect(withoutBundle.canPlanArtifacts?.(testContext)).toBe(false);
    expect(withoutBundle.artifacts(testContext)).toEqual(daemon.artifacts(testContext));
    await expect(withoutBundle.preflight?.(testContext, [], 'uninstall')).resolves.toBeUndefined();
    await expect(withoutBundle.preflight?.(testContext, [], 'install')).rejects.toThrow(
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
        acknowledgementPollIntervalMs: 0,
      }),
    ).toThrow(/poll interval/);

    const linked = join(root.sourceApp, 'Contents', 'Resources', 'linked');
    symlinkSync('/tmp', linked);
    expect(() =>
      createMacOSDesktopAdapter({ appBundlePath: root.sourceApp, daemonAdapter: daemon }).artifacts(
        testContext,
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
      await expect(testDesktopAdapter(root).afterInstall!(context(root), [])).rejects.toThrow(
        /embedded macOS runtime/iu,
      );
    }
  });

  it('rejects an unsafe installed runtime and reports unsafe bootstrap rollback', async () => {
    const occupied = fixture('embedded-occupied-destination');
    writeEmbeddedRuntime(occupied.sourceApp);
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
    await expect(testDesktopAdapter(occupied).afterInstall!(context(occupied), [])).rejects.toThrow(
      /regular directory/iu,
    );

    const rollback = fixture('embedded-unsafe-rollback');
    writeEmbeddedRuntime(rollback.sourceApp);
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
        return commandResult({ exitCode: 7 });
      }
      return success();
    });
    const error = await testDesktopAdapter(rollback).afterInstall!(
      context(rollback, runCommand),
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
    await expect(testDesktopAdapter(root).afterUninstall!(context(root), [])).rejects.toThrow(
      /unsafe embedded runtime/iu,
    );
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
      const runCommand = acknowledgingOpen({
        dataDirectory: root.data,
        registrationChanged: false,
        fallback: async (executable, arguments_) =>
          variant === 'rollback' && executable === '/usr/bin/open' && arguments_.length === 2
            ? commandResult({ exitCode: 7 })
            : success(),
      });
      const operation = testDesktopAdapter(root).afterInstall!(context(root, runCommand), []);
      if (variant === 'commit') {
        await expect(operation).resolves.toMatchObject({ loginItem: 'enabled' });
        expect(readFileSync(join(destination, 'runtime.txt'), 'utf8')).toBe('new runtime');
      } else {
        await expect(operation).rejects.toThrow(/open the macOS menu app \(7\)/iu);
        expect(readFileSync(join(destination, 'runtime.txt'), 'utf8')).toBe('old runtime');
      }
    }
  });

  it('removes a regular embedded runtime during uninstall cleanup of a managed copy', async () => {
    const managed = fixture('embedded-regular-remove');
    const destination = writeEmbeddedRuntime(join(managed.home, 'Applications', 'Pimpampum.app'));
    await testDesktopAdapter(managed).afterUninstall!(context(managed), []);
    expect(existsSync(destination)).toBe(false);
  });

  it('keeps the runtime inside an adopted user bundle when a failed install rolls back', async () => {
    const adopted = fixture('embedded-adopted-keep-rollback');
    const userApp = join(adopted.home, 'Applications', 'Pimpampum.app');
    const kept = writeEmbeddedRuntime(userApp, 'the user runtime');
    writeFileSync(
      join(adopted.data, 'application-path.json'),
      JSON.stringify({ schemaVersion: 2, path: userApp, managed: false }),
    );
    await testDesktopAdapter(adopted).afterRollback!(context(adopted), []);
    expect(readFileSync(join(kept, 'node'), 'utf8')).toBe('the user runtime');
  });

  it('keeps the runtime inside an adopted user bundle when the service is uninstalled', async () => {
    const adopted = fixture('embedded-adopted-keep-uninstall');
    const userApp = join(adopted.home, 'Applications', 'Pimpampum.app');
    const kept = writeEmbeddedRuntime(userApp, 'the user runtime');
    writeFileSync(
      join(adopted.data, 'application-path.json'),
      JSON.stringify({ schemaVersion: 2, path: userApp, managed: false }),
    );
    await testDesktopAdapter(adopted).afterUninstall!(context(adopted), []);
    expect(readFileSync(join(kept, 'node'), 'utf8')).toBe('the user runtime');
    expect(existsSync(join(adopted.data, 'application-path.json'))).toBe(false);
  });

  it('aggregates login unregistration failure after post-registration cleanup fails', async () => {
    const root = fixture('post-registration-cleanup-failure');
    const applications = join(root.home, 'Applications');
    const legacyRoot = join(applications, 'PimpampumMenuBar.app');
    mkdirSync(legacyRoot, { recursive: true });
    chmodSync(applications, 0o500);
    const runCommand = acknowledgingOpen({
      dataDirectory: root.data,
      registrationChanged: true,
      fallback: async (executable, arguments_) =>
        arguments_.includes('--unregister-login-item')
          ? commandResult({ exitCode: 1, stderr: 'unregistration denied' })
          : launchdRunning(executable, arguments_),
    });
    // The helper's own unregistration branch must not answer: replace it with the denial.
    const denying: RunCommand = async (executable, arguments_) =>
      arguments_.includes('--unregister-login-item')
        ? commandResult({ exitCode: 1, stderr: 'unregistration denied' })
        : runCommand(executable, arguments_);
    const error = await testDesktopAdapter(root).afterInstall!(context(root, denying), []).catch(
      (caught: unknown) => caught,
    );
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
      expect(() => testDesktopAdapter(root).artifacts(context(root))).toThrow(/missing/);
    }

    const root = fixture('special-file');
    const fifo = join(root.sourceApp, 'Contents', 'Resources', 'named-pipe');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    expect(() => testDesktopAdapter(root).artifacts(context(root))).toThrow(/regular files/);
  });

  it('rejects unsafe handshake targets and restores newly created control files', async () => {
    const invalidTarget = fixture('invalid-target');
    mkdirSync(join(invalidTarget.data, 'login-registration-request.json'));
    await expect(
      testDesktopAdapter(invalidTarget).afterInstall!(context(invalidTarget), []),
    ).rejects.toThrow(/regular file/);

    const clean = fixture('clean-rollback');
    const runCommand = acknowledgingOpen({
      dataDirectory: clean.data,
      registrationChanged: false,
      fallback: async (executable, arguments_) =>
        executable === '/usr/bin/open' && arguments_.length === 2
          ? commandResult({ exitCode: 7 })
          : success(),
    });
    await expect(
      testDesktopAdapter(clean).afterInstall!(context(clean, runCommand), []),
    ).rejects.toThrow(/open the macOS menu app \(7\)/i);
    for (const name of CONTROL_FILES) expect(existsSync(join(clean.data, name))).toBe(false);
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
        testDesktopAdapter(root).afterInstall!(context(root, runCommand), []),
      ).rejects.toThrow(/invalid/i);
    }

    const root = fixture('registration-launch-failure');
    await expect(
      testDesktopAdapter(root).afterInstall!(
        context(root, async () => commandResult({ exitCode: 9 })),
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
          const request = readJson(join(root.data, 'login-registration-request.json')) as {
            requestId: string;
            requestedAt: string;
          };
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
        return commandResult({ exitCode: 7 });
      };
      await expect(
        testDesktopAdapter(root).afterInstall!(context(root, runCommand), []),
      ).rejects.toThrow(/open.*\(7\)/i);
      // A rejected registration changed nothing, so there is no login item to roll back.
      expect(calls).toBe(status === 'error' ? 2 : 3);
    }
  });

  it('completes the install and records a rejected login item registration', async () => {
    const root = fixture('registration-rejected');
    const runCommand = acknowledgingOpen({
      dataDirectory: root.data,
      status: 'error',
      registrationChanged: false,
    });
    await expect(
      testDesktopAdapter(root).afterInstall!(context(root, runCommand), []),
    ).resolves.toEqual({ loginItem: 'error' });
    expect(readJson(join(root.data, 'login-item-status.json'))).toMatchObject({ status: 'error' });
  });

  it('aggregates a failed login-item compensation after registration changed', async () => {
    const root = fixture('registration-compensation-failure');
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--register-login-item')) {
        const request = readJson(join(root.data, 'login-registration-request.json')) as {
          requestId: string;
          requestedAt: string;
        };
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
      return commandResult({ exitCode: arguments_.includes('--unregister-login-item') ? 9 : 7 });
    };

    await expect(
      testDesktopAdapter(root).afterInstall!(context(root, runCommand), []),
    ).rejects.toThrow(AggregateError);
    expect(existsSync(join(root.data, 'login-registration-request.json'))).toBe(false);
    expect(existsSync(join(root.data, 'login-registration-acknowledgement.json'))).toBe(false);
  });

  it('reports an unanswered unregistration while compensating a changed registration', async () => {
    // The helper registered the login item, the menu app failed to open, and the compensating
    // unregistration never answered: the caller must learn about the item it may have left behind.
    const root = fixture('compensation-timeout');
    const clock = tickingClock();
    const runCommand = acknowledgingOpen({
      dataDirectory: root.data,
      registrationChanged: true,
      fallback: async (executable, arguments_) =>
        executable === '/usr/bin/open' && arguments_.length === 2
          ? commandResult({ exitCode: 7 })
          : success(),
    });
    const silent: RunCommand = async (executable, arguments_) =>
      arguments_.includes('--unregister-login-item')
        ? success()
        : runCommand(executable, arguments_);
    const error = await testDesktopAdapter(root, { now: clock.now, sleep: clock.sleep })
      .afterInstall!(context(root, silent), []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual(
      expect.arrayContaining([expect.stringMatching(/did not acknowledge unregistration/u)]),
    );
  });

  it('never unregisters a pre-existing approval-pending login item during compensation', async () => {
    const root = fixture('approval-pending-compensation');
    const calls: string[][] = [];
    const runCommand: RunCommand = async (_executable, arguments_) => {
      calls.push(arguments_);
      if (arguments_.includes('--register-login-item')) {
        const request = readJson(join(root.data, 'login-registration-request.json')) as {
          requestId: string;
          requestedAt: string;
        };
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
      return commandResult({ exitCode: 7 });
    };

    await expect(
      testDesktopAdapter(root).afterInstall!(context(root, runCommand), []),
    ).rejects.toThrow(/open.*\(7\)/i);
    expect(calls.some((arguments_) => arguments_.includes('--unregister-login-item'))).toBe(false);
  });

  it('restores approval-pending login state and a stopped daemon after uninstall fails', async () => {
    const root = fixture('approval-pending-uninstall-rollback');
    installedBundle(root);
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
        const request = readJson(join(root.data, 'login-registration-request.json')) as {
          requestId: string;
          requestedAt: string;
        };
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
    const testContext = context(root, runCommand);
    const artifacts = adapter.artifacts(testContext);
    const rollback = await adapter.prepareDeactivationRollback!(testContext, artifacts);

    await expect(adapter.deactivate(testContext, artifacts)).rejects.toThrow(
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
    const daemonContext = context(daemonRoot);
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
    const loginDesktop = testDesktopAdapter(loginRoot);
    const loginContext = context(
      loginRoot,
      acknowledgingOpen({
        dataDirectory: loginRoot.data,
        status: 'requiresApproval',
        registrationChanged: false,
      }),
    );
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
        const request = readJson(requestPath) as { requestId: string; requestedAt: string };
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
      return commandResult({ exitCode: 7 });
    };

    await expect(
      testDesktopAdapter(root).afterInstall!(context(root, runCommand), []),
    ).rejects.toThrow(AggregateError);

    // The location record has its own snapshot; a directory in its place blocks that restore too.
    const record = fixture('record-restore-failure');
    const recordPath = join(record.data, 'application-path.json');
    const blockRecord = acknowledgingOpen({
      dataDirectory: record.data,
      registrationChanged: false,
      fallback: async (executable, arguments_) => {
        if (executable === '/usr/bin/open' && arguments_.length === 2) {
          rmSync(recordPath);
          mkdirSync(recordPath);
          return commandResult({ exitCode: 7 });
        }
        return success();
      },
    });
    const error = await testDesktopAdapter(record).afterInstall!(
      context(record, blockRecord),
      [],
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/bootstrap rollback failed/u);
  });

  it('uses production clock and sleep defaults without weakening the handshake', async () => {
    const root = fixture('defaults');
    let request: { requestId: string; requestedAt: string } | undefined;
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--register-login-item')) {
        request = readJson(join(root.data, 'login-registration-request.json')) as {
          requestId: string;
          requestedAt: string;
        };
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
      acknowledgementPollIntervalMs: 10,
    });
    await expect(adapter.afterInstall!(context(root, runCommand), [])).resolves.toEqual({
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
      const status = testDesktopAdapter(root).integrationStatus!(context(root), []);
      if (testCase.valid) await expect(status).resolves.toBeDefined();
      else await expect(status).rejects.toThrow(/invalid login item status/i);
    }
  });

  it('rejects malformed, stale, failed and nonzero unregistration', async () => {
    const cases: Array<{
      label: string;
      exitCode?: number;
      acknowledgement?: unknown;
      message: RegExp;
    }> = [
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
      installedBundle(root);
      const runCommand: RunCommand = async (_executable, arguments_) => {
        if (arguments_.includes('--unregister-login-item') && testCase.acknowledgement) {
          writeFileSync(
            join(root.data, 'login-unregistration-acknowledgement.json'),
            JSON.stringify(testCase.acknowledgement),
          );
        }
        return commandResult({ exitCode: testCase.exitCode ?? 0 });
      };
      await expect(
        testDesktopAdapter(root).deactivate(context(root, runCommand), []),
      ).rejects.toThrow(testCase.message);
    }
  });

  it('quits the installed menu app last, matching its path literally', async () => {
    for (const pkillExit of [0, 1] as const) {
      // A home directory full of regex metacharacters must still match only itself.
      const root = fixture(`quit-menu-app-${pkillExit}`, { home: 'Home (1)+[x].$' });
      installedBundle(root);
      const calls: Array<[string, string[]]> = [];
      const runCommand = acknowledgingOpen({
        dataDirectory: root.data,
        previousStatus: 'error',
        fallback: async (executable, arguments_) => {
          calls.push([executable, arguments_]);
          return executable === '/usr/bin/pkill'
            ? commandResult({ exitCode: pkillExit })
            : success();
        },
      });
      const adapter = testDesktopAdapter(root);
      const testContext = context(root, runCommand);
      await expect(
        adapter.deactivate(testContext, adapter.artifacts(testContext)),
      ).resolves.toBeUndefined();
      const pkill = calls.at(-1);
      expect(pkill?.[0]).toBe('/usr/bin/pkill');
      expect(pkill?.[1].slice(0, 2)).toEqual(['-TERM', '-f']);
      const executable = join(
        root.home,
        'Applications',
        'Pimpampum.app',
        'Contents/MacOS/PimpampumMenuBar',
      );
      const pattern = new RegExp(pkill![1][2]!);
      expect(pkill![1][2]).not.toBe(executable);
      expect(pattern.test(executable)).toBe(true);
      expect(pattern.test(executable.replace('Pimpampum.app', 'PimpampumXapp'))).toBe(false);
      expect(pattern.test(executable.replace('(1)', '1'))).toBe(false);
    }
  });

  it('reports a pkill failure other than "no process" when quitting the menu app', async () => {
    const root = fixture('quit-menu-app-failure');
    installedBundle(root);
    const runCommand = acknowledgingOpen({
      dataDirectory: root.data,
      fallback: async (executable) =>
        executable === '/usr/bin/pkill' ? commandResult({ exitCode: 3 }) : success(),
    });
    const adapter = testDesktopAdapter(root);
    const testContext = context(root, runCommand);
    await expect(adapter.deactivate(testContext, adapter.artifacts(testContext))).rejects.toThrow(
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

  it('replaces a stale unregistration acknowledgement before asking the helper to unregister', async () => {
    const root = fixture('unregister-prior');
    installedBundle(root);
    const acknowledgementPath = join(root.data, 'login-unregistration-acknowledgement.json');
    writeFileSync(acknowledgementPath, 'stale');
    let staleSeenByHelper: boolean | null = null;
    const runCommand: RunCommand = async (_executable, arguments_) => {
      if (arguments_.includes('--unregister-login-item')) {
        staleSeenByHelper = existsSync(acknowledgementPath);
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
    const testContext = context(root, runCommand);
    await expect(
      adapter.deactivate(testContext, adapter.artifacts(testContext)),
    ).resolves.toBeUndefined();
    expect(staleSeenByHelper).toBe(false);
  });

  it('refuses to deactivate when a directory sits where the unregistration acknowledgement goes', async () => {
    const root = fixture('unregister-directory');
    installedBundle(root);
    mkdirSync(join(root.data, 'login-unregistration-acknowledgement.json'));
    await expect(testDesktopAdapter(root).deactivate(context(root), [])).rejects.toThrow(
      /must be a file/,
    );
  });

  it.each([
    {
      hook: 'integrationStatus',
      run: (root: Fixture) => testDesktopAdapter(root).integrationStatus!(context(root), []),
      message: /regular file/,
    },
    {
      hook: 'afterUninstall',
      run: (root: Fixture) => testDesktopAdapter(root).afterUninstall!(context(root), []),
      message: /must be a file/,
    },
    {
      hook: 'prepareDeactivationRollback',
      run: (root: Fixture) =>
        testDesktopAdapter(root, { daemonAdapter: idleDaemon() }).prepareDeactivationRollback!(
          context(root),
          [],
        ),
      message: /regular file/,
    },
  ])('$hook rejects a directory where login-item-status.json belongs', async ({ run, message }) => {
    const root = fixture('status-directory');
    installedBundle(root);
    mkdirSync(join(root.data, 'login-item-status.json'));
    await expect(run(root)).rejects.toThrow(message);
  });

  it('afterUninstall removes only its owned resource and keeps an unrelated file and the app', async () => {
    const root = fixture('cleanup-unrelated');
    const app = join(root.home, 'Applications', 'Pimpampum.app');
    const resources = join(app, 'Contents', 'Resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, 'unrelated'), 'keep');
    const artifacts = [{ path: join(resources, 'owned'), content: '', mode: 0o600 }];
    await expect(
      testDesktopAdapter(root).afterUninstall!(context(root), artifacts),
    ).resolves.toBeUndefined();
    expect(readFileSync(join(resources, 'unrelated'), 'utf8')).toBe('keep');
    expect(existsSync(app)).toBe(true);
  });

  it('afterRollback leaves a parent directory that still holds another file', async () => {
    const root = fixture('cleanup-blocked');
    const resources = join(root.home, 'Applications', 'Pimpampum.app', 'Contents', 'Resources');
    mkdirSync(join(resources, 'blocked'), { recursive: true });
    writeFileSync(join(resources, 'blocked', 'file'), 'x');
    await expect(
      testDesktopAdapter(root).afterRollback!(context(root), [
        { path: join(resources, 'blocked', 'owned'), content: '', mode: 0o600 },
      ]),
    ).resolves.toBeUndefined();
    expect(readFileSync(join(resources, 'blocked', 'file'), 'utf8')).toBe('x');
  });

  it('afterRollback propagates a permission error while pruning an empty owned directory', async () => {
    const root = fixture('cleanup-eacces');
    const app = join(root.home, 'Applications', 'Pimpampum.app');
    const empty = join(app, 'empty');
    mkdirSync(empty, { recursive: true });
    chmodSync(app, 0o500);
    try {
      await expect(
        testDesktopAdapter(root).afterRollback!(context(root), [
          { path: join(empty, 'owned'), content: '', mode: 0o600 },
        ]),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(app, 0o700);
    }
  });
});
