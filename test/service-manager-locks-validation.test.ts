import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSetupLifecycleLock } from '../src/lifecycleLock.js';
import { createPlatformServiceManager } from '../src/service/manager.js';
import {
  installReceiptPath,
  readInstallReceipt,
  sha256,
  writeInstallReceipt,
} from '../src/service/receipt.js';
import type {
  InstallReceipt,
  PlatformServiceAdapter,
  RunCommand,
  ServiceArtifact,
} from '../src/service/types.js';
import {
  serviceTestRoot as testRoot,
  serviceManagerInput as managerInput,
  serviceTestAdapter as testAdapter,
  type ServiceTestRoot as TestRoot,
} from './helpers/serviceManager.js';
import { success } from './helpers/service.js';

// Manager-level scenarios for the shared lifecycle lock and for the validation of manager input,
// artifact plans, ownership receipts and adapter-owned roots. Every rejection asserts the exact
// message the manager raises.

describe('platform-neutral service manager: lifecycle lock and validation', () => {
  it('runs adapter preflight inside the lifecycle lock before filesystem mutations', async () => {
    const root = testRoot('adapter-preflight');
    const artifactPath = join(root.homeDirectory, '.config', 'pimpampum', 'service');
    const observations: Array<{ operation: string; artifactExists: boolean }> = [];
    const adapter: PlatformServiceAdapter = {
      id: 'preflight-adapter',
      platform: 'linux',
      artifacts: () => [{ path: artifactPath, content: 'owned', mode: 0o600 }],
      preflight: async (_context, _artifacts, operation) => {
        observations.push({ operation, artifactExists: existsSync(artifactPath) });
      },
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    };
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );

    await manager.install();
    await manager.uninstall();
    expect(observations).toEqual([
      { operation: 'install', artifactExists: false },
      { operation: 'uninstall', artifactExists: true },
    ]);
  });

  it('rejects mismatched and unsafe stale receipt artifacts during reconciliation', async () => {
    for (const variant of ['adapter', 'outside', 'modified'] as const) {
      const root = testRoot(`stale-${variant}`);
      const oldPath = join(root.homeDirectory, '.config', 'pimpampum', 'old');
      const currentPath = join(root.homeDirectory, '.config', 'pimpampum', 'current');
      const oldAdapter: PlatformServiceAdapter = {
        id: 'stale-adapter',
        platform: 'linux',
        artifacts: () => [
          { path: currentPath, content: 'current', mode: 0o600 },
          { path: oldPath, content: 'old', mode: 0o600 },
        ],
        ownedArtifactRoots: () => [join(root.homeDirectory, '.config', 'pimpampum')],
        activate: async () => undefined,
        deactivate: async () => undefined,
        isRunning: async () => true,
      };
      const newAdapter: PlatformServiceAdapter = {
        ...oldAdapter,
        artifacts: () => [{ path: currentPath, content: 'current', mode: 0o600 }],
      };
      const input = managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: oldAdapter },
      });
      await createPlatformServiceManager(input).install();
      const receiptPath = installReceiptPath(root.dataDirectory);
      if (variant === 'adapter') {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as InstallReceipt;
        writeFileSync(receiptPath, JSON.stringify({ ...receipt, adapter: 'other-adapter' }));
        await expect(createPlatformServiceManager(input).install()).rejects.toThrow(
          /does not match/,
        );
        continue;
      }
      if (variant === 'outside') {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as InstallReceipt;
        receipt.artifacts[1]!.path = join(root.root, 'outside');
        writeFileSync(receiptPath, JSON.stringify(receipt));
      } else {
        writeFileSync(oldPath, 'user changed this');
      }
      await expect(
        createPlatformServiceManager({
          ...input,
          version: '0.2.0',
          adapters: { linux: newAdapter },
        }).install(),
      ).rejects.toThrow(variant === 'outside' ? /inside the home/ : /modified stale/);
    }

    const missing = testRoot('stale-missing');
    const stalePath = join(missing.homeDirectory, '.config', 'pimpampum', 'stale');
    const stablePath = join(missing.homeDirectory, '.config', 'pimpampum', 'stable');
    const adapter = (old: boolean): PlatformServiceAdapter => ({
      id: 'missing-stale-adapter',
      platform: 'linux',
      artifacts: () => [
        { path: stablePath, content: 'stable', mode: 0o600 },
        ...(old ? [{ path: stalePath, content: 'stale', mode: 0o600 }] : []),
      ],
      ownedArtifactRoots: () => [join(missing.homeDirectory, '.config', 'pimpampum')],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    });
    const base = managerInput(missing, async () => success(), {
      platform: 'linux',
      adapters: { linux: adapter(true) },
    });
    await createPlatformServiceManager(base).install();
    rmSync(stalePath);
    await expect(
      createPlatformServiceManager({
        ...base,
        version: '0.2.0',
        adapters: { linux: adapter(false) },
      }).install(),
    ).resolves.toMatchObject({ reconciled: true });
  });

  it('rejects unsupported and mismatched adapters before mutation', async () => {
    const root = testRoot('unsupported');
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_.includes('show')
        ? { exitCode: 0, stdout: 'LoadState=not-found\n', stderr: '' }
        : success(),
    );
    const unsupported = createPlatformServiceManager(
      managerInput(root, runCommand, { platform: 'win32' }),
    );
    await expect(unsupported.install()).rejects.toThrow('Unsupported service platform: win32');
    await expect(unsupported.status()).rejects.toThrow('Unsupported service platform: win32');
    await expect(unsupported.uninstall()).rejects.toThrow('Unsupported service platform: win32');
    expect(runCommand).not.toHaveBeenCalled();
    const linux = createPlatformServiceManager(
      managerInput(root, runCommand, { platform: 'linux' }),
    );
    await expect(linux.install()).resolves.toMatchObject({ installed: true });
    const mismatch = createPlatformServiceManager(
      managerInput(root, runCommand, {
        platform: 'linux',
        adapters: { linux: { ...testAdapter(root), platform: 'darwin' } },
      }),
    );
    await expect(mismatch.install()).rejects.toThrow('Service adapter platform mismatch');
    expect(runCommand).toHaveBeenCalled();
  });

  it('rejects a relative data directory when the manager is created', () => {
    const root = testRoot('validation-data-directory');
    expect(() =>
      createPlatformServiceManager(
        managerInput(root, vi.fn<RunCommand>(), { dataDirectory: 'relative' }),
      ),
    ).toThrow('Data directory must be an absolute path');
  });

  it.each([
    {
      overrides: { homeDirectory: 'relative' },
      message: 'Home directory must be an absolute path',
    },
    { overrides: { nodePath: 'relative' }, message: 'Node executable must be an absolute path' },
    { overrides: { cliPath: 'relative' }, message: 'CLI path must be an absolute path' },
    {
      overrides: { nodePath: '/node\0invalid' },
      message: 'Node executable must be an absolute path',
    },
    { overrides: { logDirectory: 'relative' }, message: 'Log directory must be an absolute path' },
    { overrides: { host: '0.0.0.0' }, message: 'Service host must be loopback-only' },
    { overrides: { port: 0 }, message: 'Service port must be between 1 and 65535' },
    { overrides: { port: 1.5 }, message: 'Service port must be an integer' },
    { overrides: { port: 65_536 }, message: 'Service port must be between 1 and 65535' },
  ])(
    'rejects $overrides with "$message" before any command runs',
    async ({ overrides, message }) => {
      const root = testRoot('validation-input');
      const runCommand = vi.fn<RunCommand>();
      const manager = createPlatformServiceManager(managerInput(root, runCommand, overrides));
      await expect(manager.install()).rejects.toThrow(message);
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'the data directory itself', logDirectory: (root: TestRoot) => root.dataDirectory },
    {
      label: 'a directory outside the data directory',
      logDirectory: (root: TestRoot) => join(root.root, 'outside-logs'),
    },
  ])('rejects $label as the log directory', async ({ logDirectory }) => {
    const root = testRoot('validation-log-directory');
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), { logDirectory: logDirectory(root) }),
    );
    await expect(manager.install()).rejects.toThrow(
      'Log directory must be inside the data directory',
    );
  });

  it.each([
    {
      label: 'a missing home directory',
      prepare: (root: TestRoot) => join(root.root, 'missing-home'),
    },
    {
      label: 'a regular file as the home directory',
      prepare: (root: TestRoot) => {
        const path = join(root.root, 'home-file');
        writeFileSync(path, 'not-a-directory');
        return path;
      },
    },
  ])('rejects $label', async ({ prepare }) => {
    const root = testRoot('validation-home');
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), { homeDirectory: prepare(root) }),
    );
    await expect(manager.install()).rejects.toThrow('Home directory must be an existing directory');
  });

  it.each([
    {
      label: 'an empty artifact plan',
      artifacts: (_root: TestRoot): ServiceArtifact[] => [],
      message: 'Service adapter returned no artifacts',
    },
    {
      label: 'an artifact outside the home directory',
      artifacts: (root: TestRoot): ServiceArtifact[] => [
        { path: join(root.root, 'outside'), content: '', mode: 0o600 },
      ],
      message: 'Service artifact must be inside the home directory',
    },
    {
      label: 'two artifacts at one path',
      artifacts: (root: TestRoot): ServiceArtifact[] => [
        { path: join(root.homeDirectory, 'duplicate'), content: 'a', mode: 0o600 },
        { path: join(root.homeDirectory, 'duplicate'), content: 'b', mode: 0o600 },
      ],
      message: 'Service adapter returned a duplicate artifact',
    },
    {
      label: 'an artifact mode above 0o777',
      artifacts: (root: TestRoot): ServiceArtifact[] => [
        { path: join(root.homeDirectory, 'mode'), content: '', mode: 0o1000 },
      ],
      message: 'Service artifact mode is invalid',
    },
  ])('rejects $label with "$message"', async ({ artifacts, message }) => {
    const root = testRoot('validation-plan');
    const adapter = testAdapter(root, { artifacts: () => artifacts(root) });
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), { platform: 'linux', adapters: { linux: adapter } }),
    );
    await expect(manager.install()).rejects.toThrow(message);
  });

  it('rejects an artifact path that is a symbolic link', async () => {
    const root = testRoot('validation-symlink');
    const symlinkPath = join(root.homeDirectory, 'linked-service');
    const symlinkTarget = join(root.root, 'symlink-target');
    writeFileSync(symlinkTarget, 'target');
    symlinkSync(symlinkTarget, symlinkPath);
    const adapter = testAdapter(root, {
      artifacts: () => [{ path: symlinkPath, content: 'new', mode: 0o600 }],
    });
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), { platform: 'linux', adapters: { linux: adapter } }),
    );
    await expect(manager.install()).rejects.toThrow(
      'Service artifact must not traverse symbolic links',
    );
    expect(readFileSync(symlinkTarget, 'utf8')).toBe('target');
  });

  it('rejects an artifact path that is a directory', async () => {
    const root = testRoot('validation-directory');
    const directoryArtifactPath = join(root.homeDirectory, 'directory-artifact');
    mkdirSync(directoryArtifactPath);
    const adapter = testAdapter(root, {
      artifacts: () => [{ path: directoryArtifactPath, content: 'new', mode: 0o600 }],
    });
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), { platform: 'linux', adapters: { linux: adapter } }),
    );
    await expect(manager.install()).rejects.toThrow(
      `Service artifact target is not a regular file: ${directoryArtifactPath}`,
    );
  });

  it('waits for a concurrent install on the shared lifecycle lock instead of failing', async () => {
    const root = testRoot('lifecycle-lock');
    let enterActivation: (() => void) | undefined;
    let releaseActivation: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterActivation = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const adapter = testAdapter(root, {
      activate: async () => {
        enterActivation?.();
        await blocked;
      },
    });
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );

    const installing = manager.install();
    await entered;
    // One lock for every owner of the data directory: the service manager holds the setup lock.
    const lockPath = join(root.dataDirectory, '.setup-lifecycle.lock');
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(root.dataDirectory, '.service-lifecycle.lock'))).toBe(false);
    const events: string[] = [];
    const status = manager.status().then((result) => {
      events.push('status');
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual([]);
    releaseActivation?.();
    await installing;
    await expect(status).resolves.toMatchObject({ installed: true });
    expect(existsSync(lockPath)).toBe(false);

    // A dead owner is recovered; a malformed lock is reported and left in place.
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        nonce: '00000000-0000-4000-8000-000000000000',
      })}\n`,
      { mode: 0o600 },
    );
    await expect(manager.status()).resolves.toMatchObject({ installed: true });
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, '{invalid', { mode: 0o600 });
    await expect(manager.status()).rejects.toThrow(SyntaxError);
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);
  });

  it.each([
    { label: 'removed by someone else', behavior: 'remove' as const, remainsAfterwards: false },
    { label: 'replaced by another owner', behavior: 'replace' as const, remainsAfterwards: true },
  ])(
    'does not remove a lifecycle lock that was $label during the operation',
    async ({ behavior, remainsAfterwards }) => {
      const root = testRoot('lock-release');
      const lockPath = join(root.dataDirectory, '.setup-lifecycle.lock');
      const adapter = testAdapter(root, {
        activate: async () => {
          if (behavior === 'remove') rmSync(lockPath);
          else writeFileSync(lockPath, '{"pid":999,"nonce":"replacement"}\n');
        },
      });
      const manager = createPlatformServiceManager(
        managerInput(root, vi.fn<RunCommand>(), {
          platform: 'linux',
          adapters: { linux: adapter },
        }),
      );

      await manager.install();
      expect(existsSync(lockPath)).toBe(remainsAfterwards);
    },
  );

  it('reports a typed conflict when a live owner holds the lock past the status wait', async () => {
    const root = testRoot('lock-live-owner');
    const manager = createPlatformServiceManager(
      managerInput(
        root,
        vi.fn<RunCommand>(async () => success()),
      ),
    );
    const lockPath = join(root.dataDirectory, '.setup-lifecycle.lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        nonce: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      })}\n`,
      { mode: 0o600 },
    );
    vi.useFakeTimers();
    try {
      const outcome = manager.status().then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(5_100);
      await expect(outcome).resolves.toMatchObject({
        code: 'conflict',
        status: 409,
        retryable: true,
        details: { lockPath },
      });
      expect(String(((await outcome) as Error).message)).toMatch(
        /Timed out waiting for the setup lifecycle lock/u,
      );
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(lockPath)).toBe(true);
  });

  it('re-enters an outer lifecycle-lock run so the coordinator can drive it without deadlock', async () => {
    const root = testRoot('lock-nesting');
    const manager = createPlatformServiceManager(
      managerInput(
        root,
        vi.fn<RunCommand>(async () => success()),
        { platform: 'linux', adapters: { linux: testAdapter(root) } },
      ),
    );
    const outer = createSetupLifecycleLock(root.dataDirectory, {
      timeoutMilliseconds: 500,
      retryMilliseconds: 5,
    });
    const lockPath = join(root.dataDirectory, '.setup-lifecycle.lock');
    await expect(
      outer.run(async () => {
        await manager.install();
        const prepared = await manager.prepareUninstall!();
        expect(prepared).not.toBeNull();
        await prepared!.rollback();
        expect(existsSync(lockPath)).toBe(true);
        return manager.status();
      }),
    ).resolves.toMatchObject({ installed: true, running: true });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('rejects symlinked roots and ancestor directories without writing through them', async () => {
    const root = testRoot('symlink-ancestors');
    const outside = join(root.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root.homeDirectory, 'Library'), 'dir');
    const manager = createPlatformServiceManager(
      managerInput(
        root,
        vi.fn<RunCommand>(async () => success()),
      ),
    );
    await expect(manager.install()).rejects.toThrow(/symbolic links/);
    expect(readdirSync(outside)).toEqual([]);

    rmSync(join(root.homeDirectory, 'Library'));
    symlinkSync(outside, join(root.dataDirectory, 'logs'), 'dir');
    await expect(manager.install()).rejects.toThrow(/symbolic links/);
    expect(readdirSync(outside)).toEqual([]);

    rmSync(join(root.dataDirectory, 'logs'));
    const outsideReceipt = join(outside, 'receipt-target');
    writeFileSync(outsideReceipt, 'do-not-touch');
    symlinkSync(outsideReceipt, installReceiptPath(root.dataDirectory));
    await expect(manager.install()).rejects.toThrow(/symbolic links/);
    expect(readFileSync(outsideReceipt, 'utf8')).toBe('do-not-touch');

    rmSync(installReceiptPath(root.dataDirectory));
    const linkedData = join(root.root, 'linked-data');
    symlinkSync(root.dataDirectory, linkedData, 'dir');
    const linkedManager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), { dataDirectory: linkedData }),
    );
    await expect(linkedManager.install()).rejects.toThrow(/symbolic links/);
  });

  it('rejects mismatched and unsafe ownership receipts', async () => {
    const root = testRoot('receipt-ownership');
    const adapter = testAdapter(root);
    const input = managerInput(root, vi.fn<RunCommand>(), {
      platform: 'linux',
      adapters: { linux: adapter },
    });
    const manager = createPlatformServiceManager(input);
    await manager.install();
    const receiptPath = installReceiptPath(root.dataDirectory);
    const receipt = readInstallReceipt(receiptPath)!;
    writeInstallReceipt(receiptPath, { ...receipt, platform: 'darwin' });
    await expect(manager.status()).rejects.toThrow(/does not match the current platform/);
    await expect(manager.uninstall()).rejects.toThrow(/does not match the current platform/);

    writeInstallReceipt(receiptPath, { ...receipt, adapter: 'another-adapter' });
    await expect(manager.status()).rejects.toThrow(/does not match/);
    await expect(manager.uninstall()).rejects.toThrow(/does not match/);

    writeInstallReceipt(receiptPath, {
      ...receipt,
      artifacts: [{ ...receipt.artifacts[0]!, path: join(root.root, 'outside-owned-file') }],
    });
    await expect(manager.uninstall()).rejects.toThrow(/outside the home/);

    const victimPath = join(root.homeDirectory, 'valuable-user-file');
    writeFileSync(victimPath, 'valuable-bytes');
    writeInstallReceipt(receiptPath, {
      ...receipt,
      artifacts: [
        {
          path: victimPath,
          sha256: sha256('valuable-bytes'),
          mode: statSync(victimPath).mode & 0o777,
        },
      ],
    });
    await expect(manager.uninstall()).rejects.toThrow(/not owned by the platform adapter/);
    expect(readFileSync(victimPath, 'utf8')).toBe('valuable-bytes');

    writeInstallReceipt(receiptPath, { ...receipt, artifacts: [] });
    await expect(manager.uninstall()).rejects.toThrow(/artifact set/);

    writeInstallReceipt(receiptPath, {
      ...receipt,
      artifacts: [receipt.artifacts[0]!, receipt.artifacts[0]!],
    });
    await expect(manager.uninstall()).rejects.toThrow(/duplicate paths/);
  });

  it('rejects unsafe adapter-owned roots and stale files outside those roots', async () => {
    const outsideRoot = testRoot('owned-root-outside');
    const outsideAdapter = testAdapter(outsideRoot, {
      ownedArtifactRoots: () => [join(outsideRoot.root, 'outside')],
    });
    await expect(
      createPlatformServiceManager(
        managerInput(outsideRoot, async () => success(), {
          platform: 'linux',
          adapters: { linux: outsideAdapter },
        }),
      ).install(),
    ).rejects.toThrow(/inside the home/);

    const duplicateRoot = testRoot('owned-root-duplicate');
    const duplicatePath = join(duplicateRoot.homeDirectory, '.config', 'pimpampum');
    const duplicateAdapter = testAdapter(duplicateRoot, {
      ownedArtifactRoots: () => [duplicatePath, duplicatePath],
    });
    await expect(
      createPlatformServiceManager(
        managerInput(duplicateRoot, async () => success(), {
          platform: 'linux',
          adapters: { linux: duplicateAdapter },
        }),
      ).install(),
    ).rejects.toThrow(/duplicate owned/);

    const root = testRoot('stale-outside-owned-root');
    const allowedRoot = join(root.homeDirectory, '.config', 'pimpampum');
    const oldPath = join(allowedRoot, 'old');
    const currentPath = join(allowedRoot, 'current');
    const adapter = (old: boolean): PlatformServiceAdapter => ({
      id: 'strict-owned-root',
      platform: 'linux',
      artifacts: () => [
        { path: currentPath, content: 'current', mode: 0o600 },
        ...(old ? [{ path: oldPath, content: 'old', mode: 0o600 }] : []),
      ],
      ownedArtifactRoots: () => [allowedRoot],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    });
    const input = managerInput(root, async () => success(), {
      platform: 'linux',
      adapters: { linux: adapter(true) },
    });
    await createPlatformServiceManager(input).install();
    const receiptPath = installReceiptPath(root.dataDirectory);
    const receipt = readInstallReceipt(receiptPath)!;
    const unownedPath = join(root.homeDirectory, 'Documents', 'unowned');
    mkdirSync(join(root.homeDirectory, 'Documents'));
    writeFileSync(unownedPath, 'old');
    receipt.artifacts[1]!.path = unownedPath;
    writeInstallReceipt(receiptPath, receipt);
    await expect(
      createPlatformServiceManager({
        ...input,
        version: '0.2.0',
        adapters: { linux: adapter(false) },
      }).install(),
    ).rejects.toThrow(/not inside an adapter-owned root/);
  });
});
