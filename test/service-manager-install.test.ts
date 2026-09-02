import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformServiceManager } from '../src/service/manager.js';
import { installReceiptPath, readInstallReceipt } from '../src/service/receipt.js';
import type { PlatformServiceAdapter, RunCommand, ServiceArtifact } from '../src/service/types.js';
import {
  serviceTestRoot as testRoot,
  serviceManagerInput as managerInput,
  serviceTestAdapter as testAdapter,
} from './helpers/serviceManager.js';
import { success } from './helpers/service.js';

// Manager-level scenarios for install, reconciliation, repair and status. Each drives the real
// `createPlatformServiceManager` against an in-memory adapter, so hook order is the manager's own.

describe('platform-neutral service manager: install, reconcile and status', () => {
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

  it.each([
    { label: 'the adapter has no afterRollback hook', withRollbackFailure: false },
    { label: 'afterRollback also fails', withRollbackFailure: true },
  ])(
    'reports a fast-path repair activation failure when $label',
    async ({ withRollbackFailure }) => {
      const root = testRoot('repair-errors');
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
        const error = await manager.install().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors.map((entry) => (entry as Error).message)).toEqual([
          'repair activation failed',
          'repair rollback failed',
        ]);
      } else {
        await expect(manager.install()).rejects.toThrow('repair activation failed');
      }
    },
  );

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

  it('verifies the receipt when the adapter cannot plan its artifacts', async () => {
    // An installed macOS CLI runs from the packaged runtime and has no app bundle to plan from.
    // Status must still answer from the receipt instead of failing the whole read-only command.
    const root = testRoot('unplannable');
    const ownedPath = join(root.homeDirectory, 'service-owned');
    let canPlan = true;
    const adapter = testAdapter(root, {
      artifacts: () => {
        if (!canPlan) throw new Error('Build the macOS app before installing Pimpampum');
        return [{ path: ownedPath, content: 'owned', mode: 0o600 }];
      },
      canPlanArtifacts: () => canPlan,
    });
    const manager = createPlatformServiceManager(
      managerInput(root, vi.fn<RunCommand>(), {
        platform: 'linux',
        adapters: { linux: adapter },
      }),
    );
    await manager.install();

    canPlan = false;
    await expect(manager.status()).resolves.toMatchObject({ installed: true, running: true });

    writeFileSync(ownedPath, 'tampered', { mode: 0o600 });
    await expect(manager.status()).resolves.toMatchObject({ installed: false, running: false });

    rmSync(ownedPath);
    await expect(manager.status()).resolves.toMatchObject({ installed: false, running: false });
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

  it('verifies an already running reconciled service without repairing its registration', async () => {
    const root = testRoot('post-activation-running');
    const order: string[] = [];
    let running = false;
    const adapter = testAdapter(root, {
      activate: async () => {
        order.push('activate');
        running = true;
      },
      isRunning: async () => running,
    });
    const postActivationVerifier = vi.fn(async (verification: { reconciled: boolean }) => {
      order.push(`verify:${verification.reconciled}`);
    });
    const manager = createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        postActivationVerifier,
        adapters: { linux: adapter },
      }),
    );

    await expect(manager.install()).resolves.toMatchObject({ installed: true, reconciled: false });
    expect(order).toEqual(['activate', 'verify:false']);

    order.length = 0;
    await expect(manager.install()).resolves.toMatchObject({ installed: true, reconciled: true });
    expect(order).toEqual(['verify:true']);
    expect(postActivationVerifier).toHaveBeenCalledTimes(2);
  });

  it('promotes a legacy service receipt to the selected packaged adapter', async () => {
    const root = testRoot('legacy-packaged-adapter-migration');
    const servicePath = join(root.homeDirectory, '.config', 'pimpampum', 'service');
    const applicationPath = join(root.homeDirectory, '.local', 'share', 'pimpampum', 'app');
    const legacyActivate = vi.fn(async () => undefined);
    const packagedActivate = vi.fn(async () => undefined);
    const legacyAdapter = testAdapter(root, {
      id: 'legacy-daemon',
      artifacts: () => [{ path: servicePath, content: 'legacy-service', mode: 0o600 }],
      activate: legacyActivate,
    });
    await createPlatformServiceManager(
      managerInput(root, async () => success(), {
        platform: 'linux',
        adapters: { linux: legacyAdapter },
      }),
    ).install();

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
    const packagedAdapter = testAdapter(root, {
      id: 'packaged-desktop',
      artifacts: () => [
        { path: servicePath, content: 'packaged-service', mode: 0o600 },
        { path: applicationPath, content: 'packaged-app', mode: 0o600 },
      ],
      activate: packagedActivate,
    });
    const dataBefore = readFileSync(join(root.dataDirectory, 'pimpampum.sqlite'));

    await expect(
      createPlatformServiceManager(
        managerInput(root, async () => success(), {
          platform: 'linux',
          nodePath,
          cliPath,
          packagedRuntime: { version: '1.0.0', target: 'linux-x64', runtimeDirectory },
          adapters: { linux: packagedAdapter },
          receiptAdapters: { [legacyAdapter.id]: legacyAdapter },
        }),
      ).install(),
    ).resolves.toMatchObject({ installed: true, reconciled: true });

    expect(legacyActivate).toHaveBeenCalledOnce();
    expect(packagedActivate).toHaveBeenCalledOnce();
    expect(readFileSync(servicePath, 'utf8')).toBe('packaged-service');
    expect(readFileSync(applicationPath, 'utf8')).toBe('packaged-app');
    expect(readFileSync(join(root.dataDirectory, 'pimpampum.sqlite'))).toEqual(dataBefore);
    expect(
      readInstallReceipt(installReceiptPath(root.dataDirectory), root.dataDirectory),
    ).toMatchObject({
      adapter: 'packaged-desktop',
      nodePath,
      cliPath,
      packagedRuntime: { version: '1.0.0', target: 'linux-x64', runtimeDirectory },
    });
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
