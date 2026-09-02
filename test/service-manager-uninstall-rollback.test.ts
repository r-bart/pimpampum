import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformServiceManager } from '../src/service/manager.js';
import { installReceiptPath } from '../src/service/receipt.js';
import type { PlatformServiceAdapter, RunCommand } from '../src/service/types.js';
import {
  serviceTestRoot as testRoot,
  serviceManagerInput as managerInput,
  serviceTestAdapter as testAdapter,
  serviceTestArtifactPath,
} from './helpers/serviceManager.js';
import { success } from './helpers/service.js';

// Manager-level scenarios for uninstall and for every rollback the manager runs when an
// uninstall step fails part-way.

describe('platform-neutral service manager: uninstall and rollback', () => {
  it('directly uninstalls receipt-owned bundle members removed by a package upgrade', async () => {
    const root = testRoot('direct-uninstall-upgrade');
    const bundleRoot = join(root.homeDirectory, 'Applications', 'Pimpampum.app');
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

  it.each([
    { label: 'an empty outcome', value: {}, expected: {} },
    {
      label: 'manual instructions',
      value: { manualInstructions: ['Remove the login item by hand'] },
      expected: { manualInstructions: ['Remove the login item by hand'] },
    },
  ])(
    'forwards $label from afterUninstall into the uninstall result',
    async ({ value, expected }) => {
      const root = testRoot('uninstall-outcome');
      const adapter = testAdapter(root, { afterUninstall: async () => value });
      const manager = createPlatformServiceManager(
        managerInput(root, async () => success(), {
          platform: 'linux',
          adapters: { linux: adapter },
        }),
      );
      await manager.install();
      await expect(manager.uninstall()).resolves.toEqual({
        uninstalled: true,
        dataPreserved: true,
        ...expected,
      });
    },
  );

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

  it.each([
    { label: 'the artifact restore succeeds', restorationFails: false },
    { label: 'the artifact restore also fails', restorationFails: true },
  ])(
    'aggregates the cleanup failure with a reactivation failure when $label',
    async ({ restorationFails }) => {
      const root = testRoot('uninstall-aggregate');
      const artifactPath = serviceTestArtifactPath(root);
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
      const error = await manager.uninstall().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      const messages = (error as AggregateError).errors.map((entry) => (entry as Error).message);
      expect(messages[0]).toBe('cleanup failed');
      expect(messages).toContain('reactivation failed');
      expect(messages).toHaveLength(restorationFails ? 3 : 2);
    },
  );

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
});
