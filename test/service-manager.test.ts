import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptLoginAcknowledgement } from '../src/service/loginHandshake.js';
import { createPlatformServiceManager } from '../src/service/manager.js';
import {
  assertNoSymlinkTraversal,
  installReceiptPath,
  installationKey,
  readInstallReceipt,
  receiptArtifacts,
  sha256,
  writeInstallReceipt,
  writePrivateFileAtomic,
} from '../src/service/receipt.js';
import type {
  CommandResult,
  InstallReceipt,
  PlatformServiceAdapter,
  PlatformServiceManagerInput,
  RunCommand,
  ServiceArtifact,
} from '../src/service/types.js';

interface TestRoot {
  root: string;
  homeDirectory: string;
  dataDirectory: string;
}

const roots: TestRoot[] = [];

function testRoot(label: string): TestRoot {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-service-${label}-`));
  const homeDirectory = join(root, 'Home & Spaces ü');
  const dataDirectory = join(root, 'Pimpampum Data ñ');
  mkdirSync(homeDirectory, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(dataDirectory, 'token'), 'private-token-value');
  writeFileSync(join(dataDirectory, 'pimpampum.sqlite'), 'database-bytes');
  const created = { root, homeDirectory, dataDirectory };
  roots.push(created);
  return created;
}

function success(): CommandResult {
  return { exitCode: 0, stdout: '', stderr: '' };
}

function managerInput(
  root: TestRoot,
  runCommand: RunCommand,
  overrides: Partial<PlatformServiceManagerInput> = {},
): PlatformServiceManagerInput {
  return {
    platform: 'darwin',
    homeDirectory: root.homeDirectory,
    dataDirectory: root.dataDirectory,
    nodePath: '/opt/Pimpampum & Runtime/bin/node',
    cliPath: '/opt/Pimpampum Runtime/dist/<cli>.js',
    version: '1.0.0',
    runCommand,
    ...overrides,
  };
}

function testAdapter(
  root: TestRoot,
  overrides: Partial<PlatformServiceAdapter> = {},
): PlatformServiceAdapter {
  return {
    id: 'test-systemd',
    platform: 'linux',
    artifacts: () => [
      {
        path: join(root.homeDirectory, '.config', 'systemd', 'user', 'pimpampum.service'),
        content: 'service-v1',
        mode: 0o600,
      },
    ],
    activate: async () => undefined,
    deactivate: async () => undefined,
    isRunning: async () => true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root.root, { recursive: true, force: true });
});

describe('platform-neutral service manager', () => {
  it('installs, reconciles, reports, and precisely uninstalls the default Darwin service', async () => {
    const root = testRoot('darwin');
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_[0] === 'print'
        ? { exitCode: 0, stdout: 'state = running\npid = 123\n', stderr: '' }
        : success(),
    );
    const manager = createPlatformServiceManager(managerInput(root, runCommand));
    const plistPath = join(
      root.homeDirectory,
      'Library',
      'LaunchAgents',
      'dev.pimpampum.daemon.plist',
    );
    const receiptPath = installReceiptPath(root.dataDirectory);

    await expect(manager.status()).resolves.toEqual({
      installed: false,
      running: false,
      adapter: null,
      version: null,
    });
    await expect(manager.uninstall()).resolves.toEqual({
      uninstalled: false,
      dataPreserved: true,
    });
    const installed = await manager.install();
    expect(installed).toEqual({ installed: true, reconciled: false, receiptPath });
    expect(readFileSync(plistPath, 'utf8')).toMatch(/Pimpampum &amp; Runtime|&lt;cli&gt;/);
    expect(readFileSync(plistPath, 'utf8')).not.toMatch(/private-token-value|bearer/i);
    expect(statSync(plistPath).mode & 0o777).toBe(0o644);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(receiptPath, 'utf8')).not.toMatch(/token|bearer/i);
    const receiptBytes = readFileSync(receiptPath);
    const plistBytes = readFileSync(plistPath);

    chmodSync(receiptPath, 0o644);
    await expect(manager.install()).resolves.toMatchObject({
      installed: true,
      reconciled: true,
    });
    expect(readFileSync(receiptPath)).toEqual(receiptBytes);
    expect(readFileSync(plistPath)).toEqual(plistBytes);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(runCommand).toHaveBeenCalledTimes(3);

    await expect(manager.status()).resolves.toMatchObject({
      installed: true,
      running: true,
      adapter: 'launchd',
      version: '1.0.0',
    });
    await expect(manager.uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(receiptPath)).toBe(false);
    expect(readFileSync(join(root.dataDirectory, 'token'), 'utf8')).toBe('private-token-value');
    expect(readFileSync(join(root.dataDirectory, 'pimpampum.sqlite'), 'utf8')).toBe(
      'database-bytes',
    );
    expect(
      runCommand.mock.calls.map(([executable, arguments_]) => [executable, arguments_[0]]),
    ).toEqual([
      ['/bin/launchctl', 'bootstrap'],
      ['/bin/launchctl', 'kickstart'],
      ['/bin/launchctl', 'print'],
      ['/bin/launchctl', 'print'],
      ['/bin/launchctl', 'print'],
      ['/bin/launchctl', 'bootout'],
    ]);
  });

  it('removes obsolete receipt-owned files during a version reconciliation', async () => {
    const root = testRoot('stale-upgrade');
    const oldPath = join(root.homeDirectory, '.config', 'pimpampum', 'removed-in-v2');
    const currentPath = join(root.homeDirectory, '.config', 'pimpampum', 'current');
    const adapter = (includeOld: boolean): PlatformServiceAdapter => ({
      id: 'upgrade-adapter',
      platform: 'linux',
      artifacts: () => [
        { path: currentPath, content: 'current', mode: 0o600 },
        ...(includeOld ? [{ path: oldPath, content: 'old', mode: 0o600 }] : []),
      ],
      ownedArtifactRoots: () => [join(root.homeDirectory, '.config', 'pimpampum')],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    });
    const first = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: adapter(true) },
      }),
    );
    const second = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        version: '0.2.0',
        adapters: { linux: adapter(false) },
      }),
    );

    await first.install();
    expect(existsSync(oldPath)).toBe(true);
    await expect(second.install()).resolves.toMatchObject({ reconciled: true });
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(currentPath)).toBe(true);
  });

  it('directly uninstalls receipt-owned bundle members removed by a package upgrade', async () => {
    const root = testRoot('direct-uninstall-upgrade');
    const bundleRoot = join(root.homeDirectory, 'Applications', 'PimpampumMenuBar.app');
    const currentPath = join(bundleRoot, 'Contents', 'MacOS', 'PimpampumMenuBar');
    const removedPath = join(bundleRoot, 'Contents', 'Resources', 'removed-in-v2');
    const alreadyMissingPath = join(bundleRoot, 'Contents', 'Resources', 'already-missing-in-v2');
    const adapter = (includeRemoved: boolean): PlatformServiceAdapter => ({
      id: 'bundle-upgrade-adapter',
      platform: 'darwin',
      artifacts: () => [
        { path: currentPath, content: 'binary', mode: 0o755 },
        ...(includeRemoved
          ? [
              { path: removedPath, content: 'old-resource', mode: 0o600 },
              { path: alreadyMissingPath, content: 'old-missing-resource', mode: 0o600 },
            ]
          : []),
      ],
      ownedArtifactRoots: () => [bundleRoot],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    });
    const input = managerInput(root, async () => success(), {
      adapters: { darwin: adapter(true) },
    });
    await createPlatformServiceManager(input).install();
    rmSync(alreadyMissingPath);

    await expect(
      createPlatformServiceManager({
        ...input,
        version: '0.2.0',
        adapters: { darwin: adapter(false) },
      }).uninstall(),
    ).resolves.toMatchObject({ uninstalled: true });
    expect(existsSync(currentPath)).toBe(false);
    expect(existsSync(removedPath)).toBe(false);
    expect(existsSync(alreadyMissingPath)).toBe(false);
  });

  it('repairs a missing owned helper before uninstalling', async () => {
    const root = testRoot('uninstall-repair');
    const artifactPath = join(
      root.homeDirectory,
      '.config',
      'systemd',
      'user',
      'pimpampum.service',
    );
    let sawRepairedArtifact = false;
    const adapter = testAdapter(root, {
      deactivate: async () => {
        sawRepairedArtifact = readFileSync(artifactPath, 'utf8') === 'service-v1';
      },
    });
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );

    await manager.install();
    rmSync(artifactPath);
    await expect(manager.uninstall()).resolves.toMatchObject({ uninstalled: true });
    expect(sawRepairedArtifact).toBe(true);
    expect(existsSync(artifactPath)).toBe(false);
  });

  it('restores files and external state when uninstall cleanup fails, then retries', async () => {
    const root = testRoot('uninstall-rollback');
    let cleanupAttempts = 0;
    let activations = 0;
    let finalizations = 0;
    const adapter = testAdapter(root, {
      activate: async () => {
        activations += 1;
      },
      afterInstall: async () => {
        finalizations += 1;
        return undefined;
      },
      afterUninstall: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('cleanup failed');
      },
    });
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );

    await manager.install();
    const receiptPath = installReceiptPath(root.dataDirectory);
    const artifactPath = join(
      root.homeDirectory,
      '.config',
      'systemd',
      'user',
      'pimpampum.service',
    );
    await expect(manager.uninstall()).rejects.toThrow('cleanup failed');
    expect(existsSync(receiptPath)).toBe(true);
    expect(readFileSync(artifactPath, 'utf8')).toBe('service-v1');
    expect(activations).toBe(2);
    expect(finalizations).toBe(2);
    await expect(manager.uninstall()).resolves.toMatchObject({ uninstalled: true });
  });

  it('compensates an uninstall deactivation failure and preserves the original error', async () => {
    const root = testRoot('uninstall-deactivate');
    let deactivateAttempts = 0;
    let activations = 0;
    const adapter = testAdapter(root, {
      activate: async () => {
        activations += 1;
      },
      deactivate: async () => {
        deactivateAttempts += 1;
        if (deactivateAttempts === 1) throw new Error('deactivation failed');
      },
    });
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );

    await manager.install();
    await expect(manager.uninstall()).rejects.toThrow('deactivation failed');
    expect(activations).toBe(2);
    await expect(manager.status()).resolves.toMatchObject({ installed: true, running: true });
    await expect(manager.uninstall()).resolves.toMatchObject({ uninstalled: true });
  });

  it('uses the adapter rollback snapshot to preserve a stopped service on early failure', async () => {
    const root = testRoot('uninstall-stopped-snapshot');
    let running = false;
    let activationCount = 0;
    let rollbackCount = 0;
    const adapter = testAdapter(root, {
      activate: async () => {
        activationCount += 1;
        running = true;
      },
      isRunning: async () => running,
      prepareDeactivationRollback: async () => {
        const priorRunning = running;
        return async () => {
          rollbackCount += 1;
          running = priorRunning;
        };
      },
      deactivate: async () => {
        throw new Error('failed before external mutation');
      },
    });
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );

    await manager.install();
    running = false;
    const artifactPath = adapter.artifacts({} as never)[0]!.path;
    rmSync(artifactPath);
    await expect(manager.uninstall()).rejects.toThrow('failed before external mutation');
    expect(running).toBe(false);
    expect(existsSync(artifactPath)).toBe(false);
    expect(activationCount).toBe(1);
    expect(rollbackCount).toBe(1);
  });

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

  it('refuses to repair a missing artifact from nonmatching package bytes', async () => {
    const root = testRoot('uninstall-unrepairable');
    const artifactPath = join(root.homeDirectory, '.config', 'pimpampum', 'artifact');
    const repairablePath = join(root.homeDirectory, '.config', 'pimpampum', 'repairable');
    let activations = 0;
    let deactivations = 0;
    const adapter = (content: string): PlatformServiceAdapter => ({
      id: 'repair-adapter',
      platform: 'linux',
      artifacts: () => [
        { path: repairablePath, content: 'stable', mode: 0o600 },
        { path: artifactPath, content, mode: 0o600 },
      ],
      activate: async () => {
        activations += 1;
      },
      deactivate: async () => {
        deactivations += 1;
      },
      isRunning: async () => true,
    });
    const input = managerInput(root, async () => success(), {
      platform: 'linux',
      adapters: { linux: adapter('v1') },
    });
    await createPlatformServiceManager(input).install();
    rmSync(artifactPath);
    rmSync(repairablePath);
    await expect(
      createPlatformServiceManager({ ...input, adapters: { linux: adapter('v2') } }).uninstall(),
    ).rejects.toThrow(/cannot repair/i);
    expect(existsSync(artifactPath)).toBe(false);
    expect(existsSync(repairablePath)).toBe(false);
    expect(activations).toBe(1);
    expect(deactivations).toBe(0);
  });

  it('aggregates uninstall restore and reactivation failures', async () => {
    for (const restorationFails of [false, true]) {
      const root = testRoot(`uninstall-aggregate-${String(restorationFails)}`);
      const artifactPath = join(
        root.homeDirectory,
        '.config',
        'systemd',
        'user',
        'pimpampum.service',
      );
      let activationCount = 0;
      const adapter = testAdapter(root, {
        activate: async () => {
          activationCount += 1;
          if (activationCount > 1) throw new Error('reactivation failed');
        },
        afterUninstall: async () => {
          if (restorationFails) mkdirSync(artifactPath, { recursive: true });
          throw new Error('cleanup failed');
        },
      });
      const manager = createPlatformServiceManager(
        managerInput(root, async () => success(), {
          platform: 'linux',
          adapters: { linux: adapter },
        }),
      );
      await manager.install();
      await expect(manager.uninstall()).rejects.toThrow(AggregateError);
      if (restorationFails) rmSync(artifactPath, { recursive: true, force: true });
    }
  });

  it('deactivates a newly activated service when install finalization fails', async () => {
    const root = testRoot('install-finalization-cleanup');
    let deactivations = 0;
    const adapter = testAdapter(root, {
      afterInstall: async () => {
        throw new Error('finalization failed');
      },
      deactivate: async () => {
        deactivations += 1;
      },
    });
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );

    await expect(manager.install()).rejects.toThrow('finalization failed');
    expect(deactivations).toBe(1);
    expect(existsSync(installReceiptPath(root.dataDirectory))).toBe(false);
  });

  it('reactivates the restored service after changed-install finalization fails', async () => {
    const root = testRoot('install-finalization-restore');
    const artifactPath = join(
      root.homeDirectory,
      '.config',
      'systemd',
      'user',
      'pimpampum.service',
    );
    let finalizations = 0;
    let activations = 0;
    let deactivations = 0;
    const adapter = (content: string): PlatformServiceAdapter =>
      testAdapter(root, {
        artifacts: () => [{ path: artifactPath, content, mode: 0o600 }],
        activate: async () => {
          activations += 1;
        },
        deactivate: async () => {
          deactivations += 1;
        },
        afterInstall: async () => {
          finalizations += 1;
          if (finalizations > 1) throw new Error('replacement finalization failed');
          return undefined;
        },
      });
    const input = managerInput(root, async () => success(), {
      platform: 'linux',
      adapters: { linux: adapter('v1') },
    });
    await createPlatformServiceManager(input).install();
    await expect(
      createPlatformServiceManager({
        ...input,
        version: '0.2.0',
        adapters: { linux: adapter('v2') },
      }).install(),
    ).rejects.toThrow('replacement finalization failed');

    expect(readFileSync(artifactPath, 'utf8')).toBe('v1');
    expect(activations).toBe(3);
    expect(deactivations).toBe(1);
  });

  it('aggregates install deactivation and restored-service reactivation failures', async () => {
    const freshRoot = testRoot('install-deactivation-failure');
    const freshAdapter = testAdapter(freshRoot, {
      afterInstall: async () => {
        throw new Error('finalization failed');
      },
      deactivate: async () => {
        throw new Error('deactivation failed');
      },
    });
    await expect(
      createPlatformServiceManager(
        managerInput(freshRoot, async () => success(), {
          platform: 'linux',
          adapters: { linux: freshAdapter },
        }),
      ).install(),
    ).rejects.toThrow(AggregateError);

    const existingRoot = testRoot('install-reactivation-failure');
    const artifactPath = join(
      existingRoot.homeDirectory,
      '.config',
      'systemd',
      'user',
      'pimpampum.service',
    );
    let activationCount = 0;
    let finalizationCount = 0;
    const adapter = (content: string): PlatformServiceAdapter =>
      testAdapter(existingRoot, {
        artifacts: () => [{ path: artifactPath, content, mode: 0o600 }],
        activate: async () => {
          activationCount += 1;
          if (activationCount === 3) throw new Error('reactivation failed');
        },
        afterInstall: async () => {
          finalizationCount += 1;
          if (finalizationCount === 2) throw new Error('replacement finalization failed');
          return undefined;
        },
      });
    const input = managerInput(existingRoot, async () => success(), {
      platform: 'linux',
      adapters: { linux: adapter('v1') },
    });
    await createPlatformServiceManager(input).install();
    await expect(
      createPlatformServiceManager({
        ...input,
        version: '0.2.0',
        adapters: { linux: adapter('v2') },
      }).install(),
    ).rejects.toThrow(AggregateError);
  });

  it('repairs a loaded-but-inactive registration on an otherwise current repeat install', async () => {
    const root = testRoot('repair-registration');
    let bootstrapCount = 0;
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'bootstrap') {
        bootstrapCount += 1;
        if (bootstrapCount === 2) {
          return { exitCode: 5, stdout: '', stderr: 'service already loaded' };
        }
      }
      if (arguments_[0] === 'print') {
        return { exitCode: 0, stdout: 'state = exited\nlast exit code = 1\n', stderr: '' };
      }
      return success();
    });
    const manager = createPlatformServiceManager(managerInput(root, runCommand));
    await manager.install();

    await expect(manager.install()).resolves.toMatchObject({ reconciled: true });
    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_[0])).toEqual([
      'bootstrap',
      'kickstart',
      'print',
      'bootstrap',
      'print',
      'bootout',
      'bootstrap',
      'kickstart',
    ]);
  });

  it('restores a displaced registration when fast-path launchd repair fails', async () => {
    const root = testRoot('repair-registration-rollback');
    let bootstrapCount = 0;
    let restored = false;
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'bootstrap') {
        bootstrapCount += 1;
        if (bootstrapCount === 2) {
          return { exitCode: 5, stdout: '', stderr: 'service already loaded' };
        }
        if (bootstrapCount === 3) {
          return { exitCode: 78, stdout: '', stderr: 'repair definition invalid' };
        }
        if (bootstrapCount === 4) restored = true;
      }
      if (arguments_[0] === 'print') {
        return {
          exitCode: 0,
          stdout: restored ? 'state = running\npid = 321\n' : 'state = exited\n',
          stderr: '',
        };
      }
      return success();
    });
    const manager = createPlatformServiceManager(managerInput(root, runCommand));
    await manager.install();
    const receiptBefore = readFileSync(installReceiptPath(root.dataDirectory));

    await expect(manager.install()).rejects.toThrow(/repair definition invalid/);
    expect(readFileSync(installReceiptPath(root.dataDirectory))).toEqual(receiptBefore);
    await expect(manager.status()).resolves.toMatchObject({ installed: true, running: true });
    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_[0])).toEqual([
      'bootstrap',
      'kickstart',
      'print',
      'bootstrap',
      'print',
      'bootout',
      'bootstrap',
      'bootstrap',
      'kickstart',
      'print',
    ]);
  });

  it('preserves fast-path activation and rollback errors', async () => {
    for (const withRollbackFailure of [false, true]) {
      const root = testRoot(`repair-errors-${String(withRollbackFailure)}`);
      let activationCount = 0;
      const adapter = testAdapter(root, {
        activate: async () => {
          activationCount += 1;
          if (activationCount > 1) throw new Error('repair activation failed');
        },
        isRunning: async () => false,
        ...(withRollbackFailure
          ? {
              afterRollback: async () => {
                throw new Error('repair rollback failed');
              },
            }
          : {}),
      });
      const manager = createPlatformServiceManager(
        managerInput(root, vi.fn<RunCommand>(), {
          platform: 'linux',
          adapters: { linux: adapter },
        }),
      );
      await manager.install();
      if (withRollbackFailure) {
        await expect(manager.install()).rejects.toThrow(AggregateError);
      } else {
        await expect(manager.install()).rejects.toThrow('repair activation failed');
      }
    }
  });

  it('rolls back created and pre-existing artifacts after activation errors', async () => {
    const createdRoot = testRoot('rollback-created');
    const logDirectory = join(createdRoot.dataDirectory, 'logs');
    mkdirSync(logDirectory, { mode: 0o750 });
    for (const name of ['daemon.stdout.log', 'daemon.stderr.log']) {
      writeFileSync(join(logDirectory, name), `${name}-current`, { mode: 0o640 });
      writeFileSync(join(logDirectory, `${name}.5`), `${name}-oldest`, { mode: 0o620 });
    }
    const nonzero = vi.fn<RunCommand>(async () => ({
      exitCode: 7,
      stdout: '',
      stderr: 'activation denied',
    }));
    const createdManager = createPlatformServiceManager(managerInput(createdRoot, nonzero));
    const createdPath = join(
      createdRoot.homeDirectory,
      'Library/LaunchAgents/dev.pimpampum.daemon.plist',
    );
    await expect(createdManager.install()).rejects.toThrow(
      'launchctl bootstrap failed with exit code 7: activation denied',
    );
    expect(existsSync(createdPath)).toBe(false);
    expect(existsSync(installReceiptPath(createdRoot.dataDirectory))).toBe(false);
    expect(statSync(logDirectory).mode & 0o777).toBe(0o750);
    for (const name of ['daemon.stdout.log', 'daemon.stderr.log']) {
      expect(readFileSync(join(logDirectory, name), 'utf8')).toBe(`${name}-current`);
      expect(readFileSync(join(logDirectory, `${name}.5`), 'utf8')).toBe(`${name}-oldest`);
      expect(statSync(join(logDirectory, name)).mode & 0o777).toBe(0o640);
    }

    const existingRoot = testRoot('rollback-existing');
    const existingPath = join(
      existingRoot.homeDirectory,
      'Library/LaunchAgents/dev.pimpampum.daemon.plist',
    );
    mkdirSync(join(existingRoot.homeDirectory, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(existingPath, 'original-service-bytes', { mode: 0o600 });
    const thrown = vi.fn<RunCommand>(async () => {
      throw new Error('activation exploded');
    });
    const existingManager = createPlatformServiceManager(managerInput(existingRoot, thrown));
    await expect(existingManager.install()).rejects.toThrow('activation exploded');
    expect(readFileSync(existingPath, 'utf8')).toBe('original-service-bytes');
    expect(statSync(existingPath).mode & 0o777).toBe(0o600);
  });

  it('restores the previous receipt and owned bytes when reconciliation activation fails', async () => {
    const root = testRoot('rollback-reconcile');
    const artifactPath = join(root.homeDirectory, 'reconciled-service');
    let content = 'service-v1';
    let failActivation = false;
    const adapter = testAdapter(root, {
      artifacts: () => [{ path: artifactPath, content, mode: 0o600 }],
      activate: async () => {
        if (failActivation) throw new Error('reconciliation activation failed');
      },
    });
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );
    await manager.install();
    const receiptPath = installReceiptPath(root.dataDirectory);
    const receiptBefore = readFileSync(receiptPath);
    const artifactBefore = readFileSync(artifactPath);

    content = 'service-v2';
    failActivation = true;
    await expect(manager.install()).rejects.toThrow('reconciliation activation failed');
    expect(readFileSync(receiptPath)).toEqual(receiptBefore);
    expect(readFileSync(artifactPath)).toEqual(artifactBefore);
  });

  it('surfaces nonzero deactivation and offline status without deleting ownership records', async () => {
    const root = testRoot('command-errors');
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'print') {
        return { exitCode: 3, stdout: '', stderr: 'service not found' };
      }
      if (arguments_[0] === 'bootout') return { exitCode: 4, stdout: '', stderr: '' };
      return success();
    });
    const manager = createPlatformServiceManager(managerInput(root, runCommand));
    await manager.install();
    await expect(manager.status()).resolves.toMatchObject({ installed: true, running: false });
    await expect(manager.uninstall()).rejects.toThrow(AggregateError);
    expect(existsSync(installReceiptPath(root.dataDirectory))).toBe(true);
  });

  it('accepts an injected Linux adapter and reconciles drift', async () => {
    const root = testRoot('linux');
    const activate = vi.fn(async () => undefined);
    const deactivate = vi.fn(async () => undefined);
    const isRunning = vi.fn(async () => true);
    const adapter = testAdapter(root, { activate, deactivate, isRunning });
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );
    const artifactPath = adapter.artifacts({
      homeDirectory: root.homeDirectory,
      dataDirectory: root.dataDirectory,
      nodePath: '/node',
      cliPath: '/cli',
      version: '1.0.0',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: join(root.dataDirectory, 'logs'),
      runCommand: vi.fn<RunCommand>(),
    })[0]!.path;

    await manager.install();
    writeFileSync(artifactPath, 'drifted');
    await expect(manager.status()).resolves.toMatchObject({ installed: false, running: false });
    expect(isRunning).not.toHaveBeenCalled();
    await expect(manager.uninstall()).rejects.toThrow(/modified service artifact/);

    await expect(manager.install()).resolves.toMatchObject({ reconciled: true });
    expect(readFileSync(artifactPath, 'utf8')).toBe('service-v1');
    await expect(manager.status()).resolves.toMatchObject({ installed: true, running: true });
    expect(activate).toHaveBeenCalledTimes(2);
    expect(isRunning).toHaveBeenCalledOnce();
    await manager.uninstall();
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('records an IPv6 loopback base URL without exposing credentials', async () => {
    const root = testRoot('ipv6');
    const adapter = testAdapter(root);
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), {
        platform: 'linux',
        host: '::1',
        adapters: { linux: adapter },
      }),
    );

    const result = await manager.install();
    expect(readInstallReceipt(result.receiptPath)).toMatchObject({
      baseUrl: 'http://[::1]:7337',
    });
    expect(readFileSync(result.receiptPath, 'utf8')).not.toContain('private-token-value');
  });

  it('detects changed artifact plans and safely forgets already-missing owned files', async () => {
    const root = testRoot('artifact-shape');
    const originalPath = join(root.homeDirectory, 'service-original');
    const changedPath = join(root.homeDirectory, 'service-changed');
    let plannedArtifacts: ServiceArtifact[] = [
      { path: originalPath, content: 'owned', mode: 0o600 },
    ];
    const adapter = testAdapter(root, { artifacts: () => plannedArtifacts });
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );
    await manager.install();

    plannedArtifacts = [{ path: changedPath, content: 'owned', mode: 0o600 }];
    await expect(manager.status()).resolves.toMatchObject({ installed: false, running: false });
    plannedArtifacts = [
      { path: originalPath, content: 'owned', mode: 0o600 },
      { path: changedPath, content: 'second', mode: 0o600 },
    ];
    await expect(manager.status()).resolves.toMatchObject({ installed: false, running: false });

    plannedArtifacts = [{ path: originalPath, content: 'owned', mode: 0o600 }];
    rmSync(originalPath);
    await expect(manager.status()).resolves.toMatchObject({ installed: false, running: false });
    await expect(manager.uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
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
    await expect(unsupported.install()).rejects.toThrow(/unsupported/i);
    await expect(unsupported.status()).rejects.toThrow(/unsupported/i);
    await expect(unsupported.uninstall()).rejects.toThrow(/unsupported/i);
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
    await expect(mismatch.install()).rejects.toThrow(/platform mismatch/i);
    expect(runCommand).toHaveBeenCalled();
  });

  it('validates manager paths and adapter artifact plans', async () => {
    const root = testRoot('validation');
    const runCommand = vi.fn<RunCommand>();
    expect(() =>
      createPlatformServiceManager(managerInput(root, runCommand, { dataDirectory: 'relative' })),
    ).toThrow(/absolute path/);

    for (const overrides of [
      { homeDirectory: 'relative' },
      { nodePath: 'relative' },
      { cliPath: 'relative' },
      { nodePath: '/node\0invalid' },
      { logDirectory: 'relative' },
    ]) {
      const manager = createPlatformServiceManager(managerInput(root, runCommand, overrides));
      await expect(manager.install()).rejects.toThrow(/absolute path/);
    }
    const missingHome = createPlatformServiceManager(
      managerInput(root, runCommand, { homeDirectory: join(root.root, 'missing-home') }),
    );
    await expect(missingHome.install()).rejects.toThrow(/existing directory/);
    const fileHomePath = join(root.root, 'home-file');
    writeFileSync(fileHomePath, 'not-a-directory');
    const fileHome = createPlatformServiceManager(
      managerInput(root, runCommand, { homeDirectory: fileHomePath }),
    );
    await expect(fileHome.install()).rejects.toThrow(/existing directory/);
    for (const overrides of [
      { host: '0.0.0.0' },
      { port: 0 },
      { port: 1.5 },
      { port: 65_536 },
      { logDirectory: root.dataDirectory },
      { logDirectory: join(root.root, 'outside-logs') },
    ]) {
      const manager = createPlatformServiceManager(managerInput(root, runCommand, overrides));
      await expect(manager.install()).rejects.toThrow(/loopback|port|Log directory/);
    }

    const plans: Array<{ artifacts: () => ServiceArtifact[]; message: RegExp }> = [
      {
        artifacts: () => [],
        message: /no artifacts/,
      },
      {
        artifacts: () => [{ path: join(root.root, 'outside'), content: '', mode: 0o600 }],
        message: /inside the home/,
      },
      {
        artifacts: () => [
          { path: join(root.homeDirectory, 'duplicate'), content: 'a', mode: 0o600 },
          { path: join(root.homeDirectory, 'duplicate'), content: 'b', mode: 0o600 },
        ],
        message: /duplicate/,
      },
      {
        artifacts: () => [{ path: join(root.homeDirectory, 'mode'), content: '', mode: 0o1000 }],
        message: /mode is invalid/,
      },
    ];
    for (const plan of plans) {
      const adapter = testAdapter(root, { artifacts: plan.artifacts });
      const manager = createPlatformServiceManager(
        managerInput(root, runCommand, { platform: 'linux', adapters: { linux: adapter } }),
      );
      await expect(manager.install()).rejects.toThrow(plan.message);
    }

    const symlinkPath = join(root.homeDirectory, 'linked-service');
    const symlinkTarget = join(root.root, 'symlink-target');
    writeFileSync(symlinkTarget, 'target');
    symlinkSync(symlinkTarget, symlinkPath);
    const symlinkAdapter = testAdapter(root, {
      artifacts: () => [{ path: symlinkPath, content: 'new', mode: 0o600 }],
    });
    const symlinkManager = createPlatformServiceManager(
      managerInput(root, runCommand, {
        platform: 'linux',
        adapters: { linux: symlinkAdapter },
      }),
    );
    await expect(symlinkManager.install()).rejects.toThrow(/symbolic links|not a regular file/);

    const directoryArtifactPath = join(root.homeDirectory, 'directory-artifact');
    mkdirSync(directoryArtifactPath);
    const directoryAdapter = testAdapter(root, {
      artifacts: () => [{ path: directoryArtifactPath, content: 'new', mode: 0o600 }],
    });
    const directoryManager = createPlatformServiceManager(
      managerInput(root, runCommand, {
        platform: 'linux',
        adapters: { linux: directoryAdapter },
      }),
    );
    await expect(directoryManager.install()).rejects.toThrow(/not a regular file/);
  });

  it('serializes lifecycle operations and safely recovers only dead-owner locks', async () => {
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
    await expect(manager.status()).rejects.toThrow(/operation is in progress/);
    releaseActivation?.();
    await installing;

    const lockPath = join(root.dataDirectory, '.service-lifecycle.lock');
    writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647, nonce: 'stale' })}\n`);
    await expect(manager.status()).resolves.toMatchObject({ installed: true });
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, '{invalid');
    await expect(manager.status()).rejects.toThrow(/invalid.*lock/i);
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);

    writeFileSync(lockPath, `${JSON.stringify({ pid: 123, nonce: 'permission' })}\n`);
    vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    await expect(manager.status()).rejects.toThrow(/operation is in progress/);
  });

  it('does not remove a lifecycle lock that disappeared or changed ownership', async () => {
    for (const behavior of ['remove', 'replace'] as const) {
      const root = testRoot(`lock-release-${behavior}`);
      const lockPath = join(root.dataDirectory, '.service-lifecycle.lock');
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
      expect(existsSync(lockPath)).toBe(behavior === 'replace');
    }
  });

  it('propagates lifecycle-lock filesystem errors', async () => {
    const root = testRoot('lock-permissions');
    const manager = createPlatformServiceManager(
      managerInput(
        root,
        vi.fn<RunCommand>(async () => success()),
      ),
    );
    chmodSync(root.dataDirectory, 0o500);
    try {
      await expect(manager.status()).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(root.dataDirectory, 0o700);
    }
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

  it('reports activation plus filesystem or adapter rollback failures together', async () => {
    const filesystemRoot = testRoot('rollback-filesystem-failure');
    const artifactParent = join(filesystemRoot.homeDirectory, 'service-parent');
    const artifactPath = join(artifactParent, 'service');
    const outside = join(filesystemRoot.root, 'outside-rollback');
    mkdirSync(artifactParent);
    mkdirSync(outside);
    writeFileSync(artifactPath, 'old-service');
    const filesystemAdapter = testAdapter(filesystemRoot, {
      artifacts: () => [{ path: artifactPath, content: 'new-service', mode: 0o600 }],
      activate: async () => {
        rmSync(artifactPath);
        rmSync(artifactParent, { recursive: true });
        symlinkSync(outside, artifactParent, 'dir');
        throw new Error('activation failed');
      },
    });
    const filesystemManager = createPlatformServiceManager(
      managerInput(filesystemRoot, vi.fn<RunCommand>(), {
        platform: 'linux',
        adapters: { linux: filesystemAdapter },
      }),
    );
    await expect(filesystemManager.install()).rejects.toThrow(AggregateError);

    const adapterRoot = testRoot('rollback-adapter-failure');
    const afterRollback = vi.fn(async () => {
      throw new Error('adapter rollback failed');
    });
    const adapter = testAdapter(adapterRoot, {
      activate: async () => {
        throw new Error('activation failed');
      },
      afterRollback,
    });
    const adapterManager = createPlatformServiceManager(
      managerInput(adapterRoot, vi.fn<RunCommand>(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );
    await expect(adapterManager.install()).rejects.toThrow(AggregateError);
    expect(afterRollback).toHaveBeenCalledOnce();

    const logsRoot = testRoot('rollback-logs-failure');
    const logsPath = join(logsRoot.dataDirectory, 'logs');
    const logsOutside = join(logsRoot.root, 'logs-outside');
    mkdirSync(logsOutside);
    const logsAdapter = testAdapter(logsRoot, {
      activate: async () => {
        rmSync(logsPath, { recursive: true });
        symlinkSync(logsOutside, logsPath, 'dir');
        throw new Error('activation failed');
      },
    });
    const logsManager = createPlatformServiceManager(
      managerInput(logsRoot, vi.fn<RunCommand>(), {
        platform: 'linux',
        adapters: { linux: logsAdapter },
      }),
    );
    await expect(logsManager.install()).rejects.toThrow(AggregateError);
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
  it('runs the injected packaged-runtime health gate before adapter finalization', async () => {
    const root = testRoot('post-activation-order');
    const runtimeDirectory = join(
      root.homeDirectory,
      '.local',
      'share',
      'pimpampum',
      'runtime',
      '1.0.0',
    );
    mkdirSync(join(runtimeDirectory, 'dist'), { recursive: true });
    writeFileSync(join(runtimeDirectory, 'node'), 'node');
    writeFileSync(join(runtimeDirectory, 'dist', 'cli.js'), 'cli');
    const order: string[] = [];
    const adapter = testAdapter(root, {
      activate: async () => {
        order.push('activate');
      },
      afterInstall: async () => {
        order.push('afterInstall');
        return undefined;
      },
    });
    const postActivationVerifier = vi.fn(async (verification) => {
      order.push('verify');
      expect(verification.receipt.version).toBe('1.0.0');
      expect(verification.receipt.baseUrl).toBe('http://127.0.0.1:7337');
      expect(verification.context.nodePath).toBe(join(runtimeDirectory, 'node'));
      expect(verification.packagedRuntime).toEqual({
        version: '1.0.0',
        target: 'linux-x64',
        runtimeDirectory,
      });
    });
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        nodePath: join(runtimeDirectory, 'node'),
        cliPath: join(runtimeDirectory, 'dist', 'cli.js'),
        packagedRuntime: { version: '1.0.0', target: 'linux-x64', runtimeDirectory },
        postActivationVerifier,
        adapters: { linux: adapter },
      }),
    );

    await expect(manager.install()).resolves.toMatchObject({ installed: true });
    expect(order).toEqual(['activate', 'verify', 'afterInstall']);
    expect(postActivationVerifier).toHaveBeenCalledOnce();

    order.length = 0;
    await expect(manager.install()).resolves.toMatchObject({ installed: true, reconciled: true });
    expect(order).toEqual(['verify', 'afterInstall']);
    expect(postActivationVerifier).toHaveBeenCalledTimes(2);
  });

  it('restores receipt, artifacts, logs and external state when health verification fails', async () => {
    const root = testRoot('post-activation-rollback');
    const artifactPath = join(root.homeDirectory, '.config', 'pimpampum', 'service');
    let externalVersion: string | null = null;
    let shouldFail = false;
    const adapter = (content: string): PlatformServiceAdapter => ({
      id: 'health-adapter',
      platform: 'linux',
      artifacts: () => [{ path: artifactPath, content, mode: 0o600 }],
      prepareDeactivationRollback: async () => {
        const previous = externalVersion;
        return async () => {
          externalVersion = previous;
        };
      },
      activate: async (context) => {
        externalVersion = context.version;
      },
      deactivate: async () => {
        externalVersion = null;
      },
      isRunning: async () => externalVersion !== null,
    });
    const base = managerInput(root, async () => success(), {
      platform: 'linux',
      adapters: { linux: adapter('v1') },
      postActivationVerifier: async () => {
        if (shouldFail) throw new Error('daemon identity mismatch');
      },
    });
    await createPlatformServiceManager(base).install();
    const receiptPath = installReceiptPath(root.dataDirectory);
    const previousReceipt = readFileSync(receiptPath);
    mkdirSync(join(root.dataDirectory, 'logs'), { recursive: true });
    writeFileSync(join(root.dataDirectory, 'logs', 'pimpampum.log'), 'old log');
    shouldFail = true;

    await expect(
      createPlatformServiceManager({
        ...base,
        version: '2.0.0',
        adapters: { linux: adapter('v2') },
      }).install(),
    ).rejects.toThrow('daemon identity mismatch');

    expect(readFileSync(artifactPath, 'utf8')).toBe('v1');
    expect(readFileSync(receiptPath)).toEqual(previousReceipt);
    expect(readFileSync(join(root.dataDirectory, 'logs', 'pimpampum.log'), 'utf8')).toBe('old log');
    expect(externalVersion).toBe('1.0.0');
  });

  it('health-checks idempotent registration repair and restores the prior stopped state', async () => {
    const root = testRoot('post-activation-fast-repair');
    let running = false;
    let failVerification = false;
    const rollback = vi.fn(async () => {
      running = false;
    });
    const adapter = testAdapter(root, {
      prepareDeactivationRollback: async () => rollback,
      activate: async () => {
        running = true;
      },
      deactivate: async () => {
        running = false;
      },
      isRunning: async () => running,
    });
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: adapter },
        postActivationVerifier: async () => {
          if (failVerification) throw new Error('more than one daemon owns the receipt');
        },
      }),
    );
    await manager.install();
    running = false;
    failVerification = true;

    await expect(manager.install()).rejects.toThrow('more than one daemon owns the receipt');
    expect(running).toBe(false);
    expect(rollback).toHaveBeenCalledOnce();
    expect(readInstallReceipt(installReceiptPath(root.dataDirectory))?.version).toBe('1.0.0');
  });

  it('never treats packaged runtime payload files as service snapshots', async () => {
    const root = testRoot('runtime-not-artifact');
    const runtimeDirectory = join(
      root.homeDirectory,
      '.local',
      'share',
      'pimpampum',
      'runtime',
      '1.0.0',
    );
    const nodePath = join(runtimeDirectory, 'bin', 'node');
    const cliPath = join(runtimeDirectory, 'dist', 'cli.js');
    mkdirSync(join(runtimeDirectory, 'bin'), { recursive: true });
    mkdirSync(join(runtimeDirectory, 'dist'), { recursive: true });
    writeFileSync(nodePath, 'node');
    writeFileSync(cliPath, 'cli');
    const adapter = testAdapter(root, {
      artifacts: () => [
        { path: join(runtimeDirectory, 'payload-file'), content: 'large', mode: 0o600 },
      ],
    });
    const postActivationVerifier = vi.fn(async () => undefined);

    await expect(
      createPlatformServiceManager(
        managerInput(root, async () => success(), {
          platform: 'linux',
          nodePath,
          cliPath,
          packagedRuntime: { version: '1.0.0', target: 'linux-x64', runtimeDirectory },
          postActivationVerifier,
          adapters: { linux: adapter },
        }),
      ).install(),
    ).rejects.toThrow(/runtime installer/iu);
    expect(postActivationVerifier).not.toHaveBeenCalled();
    expect(existsSync(join(runtimeDirectory, 'payload-file'))).toBe(false);
  });
});

describe('installation receipts', () => {
  it('validates trusted path roots and rejects non-file atomic targets', () => {
    const root = testRoot('receipt-path-safety');
    expect(() => assertNoSymlinkTraversal('relative', 'Test path')).toThrow(/absolute path/);
    expect(() => assertNoSymlinkTraversal('/absolute', 'Test path', 'relative')).toThrow(
      /absolute path/,
    );
    expect(() => assertNoSymlinkTraversal('/absolute\0unsafe', 'Test path')).toThrow(
      /absolute path/,
    );
    expect(() =>
      assertNoSymlinkTraversal(root.root, 'Test path', join(root.root, 'nested')),
    ).toThrow(/trusted root/);
    expect(() =>
      assertNoSymlinkTraversal(join(root.root, 'sibling'), 'Test path', root.homeDirectory),
    ).toThrow(/trusted root/);

    const receiptDirectory = installReceiptPath(root.dataDirectory);
    mkdirSync(receiptDirectory);
    expect(() => readInstallReceipt(receiptDirectory, root.dataDirectory)).toThrow(/regular file/);
    expect(() =>
      writePrivateFileAtomic(receiptDirectory, 'bytes', 0o600, root.dataDirectory),
    ).toThrow(/regular file/);
  });

  it('hashes deterministic plans and round-trips a private atomic receipt', () => {
    const root = testRoot('receipt');
    const artifacts: ServiceArtifact[] = [
      { path: join(root.homeDirectory, 'service'), content: 'service-content', mode: 0o640 },
    ];
    const owned = receiptArtifacts(artifacts);
    expect(owned).toEqual([
      {
        path: artifacts[0]!.path,
        sha256: sha256('service-content'),
        mode: 0o640,
      },
    ]);
    const keyInput = {
      adapter: 'test',
      platform: 'linux',
      version: '1.0.0',
      nodePath: '/node',
      cliPath: '/cli',
      dataDirectory: root.dataDirectory,
      artifacts: owned,
    };
    expect(installationKey(keyInput)).toBe(installationKey(keyInput));
    const receipt: InstallReceipt = {
      schemaVersion: 1,
      adapter: 'test',
      platform: 'linux',
      version: '1.0.0',
      installationKey: installationKey(keyInput),
      installedAt: '2026-08-26T00:00:00.000Z',
      nodePath: '/node',
      cliPath: '/cli',
      dataDirectory: root.dataDirectory,
      baseUrl: 'http://127.0.0.1:7337',
      logDirectory: join(root.dataDirectory, 'logs'),
      artifacts: owned,
    };
    const path = installReceiptPath(root.dataDirectory);
    expect(readInstallReceipt(path)).toBeNull();
    writeInstallReceipt(path, receipt);
    expect(readInstallReceipt(path)).toEqual(receipt);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const bufferPath = join(root.homeDirectory, 'buffer-file');
    writePrivateFileAtomic(bufferPath, Buffer.from('buffer-content'), 0o620);
    expect(readFileSync(bufferPath, 'utf8')).toBe('buffer-content');
    expect(statSync(bufferPath).mode & 0o777).toBe(0o620);
  });

  it('rejects invalid JSON and invalid receipt schemas', () => {
    const root = testRoot('invalid-receipt');
    const path = installReceiptPath(root.dataDirectory);
    writeFileSync(path, '{invalid-json');
    expect(() => readInstallReceipt(path)).toThrow(/receipt JSON/);
    writeFileSync(path, JSON.stringify({ schemaVersion: 999 }));
    expect(() => readInstallReceipt(path)).toThrow(/installation receipt/);
  });
});

describe('macOS login acknowledgement validation', () => {
  const request = {
    requestId: 'current-request',
    requestedAt: '2026-08-26T20:00:00.000Z',
    expiresAt: '2026-08-26T20:00:30.000Z',
  };

  it('accepts every supported acknowledgement status', () => {
    for (const status of ['enabled', 'requiresApproval', 'error'] as const) {
      expect(
        acceptLoginAcknowledgement(
          request,
          {
            requestId: request.requestId,
            createdAt: '2026-08-26T20:00:05.000Z',
            status,
          },
          '2026-08-26T20:00:06.000Z',
        ),
      ).toEqual({ requestId: request.requestId, status });
    }
  });

  it('rejects mismatches, malformed times, stale/future acknowledgements, and expiry', () => {
    expect(() =>
      acceptLoginAcknowledgement(
        request,
        { requestId: 'other', createdAt: request.requestedAt, status: 'enabled' },
        request.requestedAt,
      ),
    ).toThrow(/request does not match/);

    const invalidCases: Array<{
      request: typeof request;
      createdAt: string;
      now: string;
      status?: string;
      message: RegExp;
    }> = [
      {
        request: { ...request, requestedAt: 'invalid' },
        createdAt: request.requestedAt,
        now: request.requestedAt,
        message: /request time/,
      },
      {
        request: { ...request, expiresAt: 'invalid' },
        createdAt: request.requestedAt,
        now: request.requestedAt,
        message: /expiry time/,
      },
      { request, createdAt: 'invalid', now: request.requestedAt, message: /acknowledgement time/ },
      { request, createdAt: request.requestedAt, now: 'invalid', message: /current time/ },
      {
        request: { ...request, expiresAt: '2026-08-26T19:59:59.000Z' },
        createdAt: request.requestedAt,
        now: request.requestedAt,
        message: /time window/,
      },
      {
        request,
        createdAt: '2026-08-26T19:59:59.000Z',
        now: request.requestedAt,
        message: /stale/i,
      },
      {
        request,
        createdAt: '2026-08-26T20:00:31.000Z',
        now: '2026-08-26T20:00:10.000Z',
        message: /expired/,
      },
      {
        request,
        createdAt: '2026-08-26T20:00:05.000Z',
        now: '2026-08-26T20:00:31.000Z',
        message: /expired/,
      },
      {
        request,
        createdAt: '2026-08-26T20:00:10.000Z',
        now: '2026-08-26T20:00:05.000Z',
        message: /future/,
      },
      {
        request,
        createdAt: '2026-08-26T20:00:05.000Z',
        now: '2026-08-26T20:00:06.000Z',
        status: 'unknown',
        message: /status/,
      },
    ];
    for (const testCase of invalidCases) {
      expect(() =>
        acceptLoginAcknowledgement(
          testCase.request,
          {
            requestId: request.requestId,
            createdAt: testCase.createdAt,
            status: testCase.status ?? 'enabled',
          },
          testCase.now,
        ),
      ).toThrow(testCase.message);
    }
  });
});
