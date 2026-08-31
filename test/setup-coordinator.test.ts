import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInstallationLifecycle,
  createSetupCoordinator,
  type InstallationLifecycleDependencies,
  type SetupCoordinatorDependencies,
} from '../src/setup/coordinator.js';
import { createSetupStateStore } from '../src/setup/state.js';
import { SETUP_SCHEMA_VERSION, type InstallationSnapshot } from '../src/setup/types.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pimpampum-setup-focused-'));
  temporaryDirectories.push(directory);
  return directory;
}

function setupDependencies(root: string): SetupCoordinatorDependencies {
  const connector = () => ({
    inspect: vi.fn(async () => ({ state: 'notConnected' })),
    connect: vi.fn(async () => undefined),
    verify: vi.fn(async () => ({ available: true, newSessionRequired: false })),
    restore: vi.fn(async () => undefined),
  });
  return {
    lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
    runtime: {
      install: vi.fn(async () => ({ version: '2.0.0' })),
      rollback: vi.fn(async () => undefined),
    },
    service: {
      install: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    },
    connectors: { codex: connector(), 'claude-code': connector() },
    loginItem: { register: vi.fn(async () => 'enabled' as const) },
    dataDirectory: join(root, 'data'),
    now: () => '2026-08-31T09:00:00.000Z',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('setup coordinator hardening', () => {
  it('keeps planning filesystem-neutral and blocks a conflict introduced before apply', async () => {
    const root = temporaryDirectory();
    const dependencies = setupDependencies(root);
    vi.mocked(dependencies.connectors.codex.inspect)
      .mockResolvedValueOnce({ state: 'notConnected' })
      .mockResolvedValueOnce({ state: 'conflict', comparison: 'Different target' });
    const coordinator = createSetupCoordinator(dependencies);
    const plan = await coordinator.plan({ selectedConnectors: ['codex'] });
    expect(existsSync(dependencies.dataDirectory)).toBe(false);

    await expect(
      coordinator.apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ status: 'conflict', nextAction: 'resolve-conflict' });
    expect(dependencies.runtime.install).not.toHaveBeenCalled();
    expect(existsSync(dependencies.dataDirectory)).toBe(false);
  });

  it('resumes a running journal without repeating durable completed phases', async () => {
    const root = temporaryDirectory();
    const dependencies = setupDependencies(root);
    const store = createSetupStateStore(dependencies.dataDirectory);
    store.write({
      schemaVersion: SETUP_SCHEMA_VERSION,
      operationId: 'operation-1',
      revision: 'revision-1',
      phase: 'connector:codex.connect',
      selectedConnectors: ['codex'],
      conflictDecisions: {},
      completedPhases: [
        'runtime.install',
        'service.install',
        'service.verify',
        'login-item.register',
      ],
      diagnostics: [],
      service: { installed: true, running: true, verified: true },
      connectors: [],
      loginItem: 'enabled',
      status: 'running',
      updatedAt: dependencies.now(),
    });

    await expect(createSetupCoordinator(dependencies).resume()).resolves.toMatchObject({
      status: 'complete',
    });
    expect(dependencies.runtime.install).not.toHaveBeenCalled();
    expect(dependencies.service.install).not.toHaveBeenCalled();
    expect(dependencies.connectors.codex.connect).toHaveBeenCalledOnce();
  });

  it('retries reverted base phases when a failed durable operation is resumed', async () => {
    const root = temporaryDirectory();
    const dependencies = setupDependencies(root);
    vi.mocked(dependencies.service.verify).mockRejectedValueOnce(new Error('daemon unhealthy'));
    const coordinator = createSetupCoordinator(dependencies);
    const plan = await coordinator.plan({ selectedConnectors: ['codex'] });

    await expect(
      coordinator.apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: true,
      }),
    ).rejects.toThrow('daemon unhealthy');
    await expect(coordinator.resume()).resolves.toMatchObject({ status: 'complete' });
    expect(dependencies.runtime.install).toHaveBeenCalledTimes(2);
    expect(dependencies.service.install).toHaveBeenCalledTimes(2);
    expect(dependencies.service.verify).toHaveBeenCalledTimes(2);
    expect(dependencies.connectors.codex.connect).toHaveBeenCalledOnce();
  });

  it('resumes the same running operation and refuses to overwrite a different one', async () => {
    const root = temporaryDirectory();
    const dependencies = setupDependencies(root);
    const store = createSetupStateStore(dependencies.dataDirectory);
    const coordinator = createSetupCoordinator({ ...dependencies, stateStore: store });
    const plan = await coordinator.plan({ selectedConnectors: ['codex'] });
    store.write({
      schemaVersion: SETUP_SCHEMA_VERSION,
      operationId: plan.operationId,
      revision: plan.revision,
      phase: 'service.install',
      selectedConnectors: ['codex'],
      conflictDecisions: {},
      completedPhases: ['runtime.install'],
      diagnostics: [],
      service: { installed: false, running: false, verified: false },
      connectors: [],
      loginItem: 'pending',
      status: 'running',
      updatedAt: dependencies.now(),
    });

    await expect(
      coordinator.apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ status: 'complete' });
    expect(dependencies.runtime.install).not.toHaveBeenCalled();

    const second = await coordinator.plan({ selectedConnectors: [] });
    store.write({
      ...store.read()!,
      operationId: 'unfinished-other-operation',
      revision: 'other-revision',
      status: 'running',
      phase: 'service.verify',
    });
    await expect(
      coordinator.apply({
        operationId: second.operationId,
        expectedRevision: second.revision,
        confirmed: true,
      }),
    ).rejects.toThrow(/another durable setup operation/iu);
  });

  it('rejects a symlinked journal instead of following it', () => {
    const root = temporaryDirectory();
    const dataDirectory = join(root, 'data');
    mkdirSync(dataDirectory);
    const outside = join(root, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(dataDirectory, 'setup-state.json'));
    expect(() => createSetupStateStore(dataDirectory).read()).toThrow(/symlink|regular file/iu);
  });
});

describe('installation lifecycle hardening', () => {
  it('finishes staging before stopping the previous daemon', async () => {
    const root = temporaryDirectory();
    const previous: InstallationSnapshot = {
      runtimeVersion: '1.0.0',
      serviceCommand: ['/old/node', '/old/cli'],
      connectorEntries: {},
    };
    const stage = vi.fn(async (version: string) => ({
      version,
      nodePath: join(root, 'runtime/bin/node'),
      cliPath: join(root, 'runtime/dist/cli.js'),
    }));
    const stop = vi.fn(async () => undefined);
    const dependencies: InstallationLifecycleDependencies = {
      dataDirectory: join(root, 'data'),
      homeDirectory: join(root, 'home'),
      lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
      runtime: {
        stage,
        activate: async () => undefined,
        restore: async () => undefined,
        removeOwned: async () => undefined,
      },
      service: {
        stop,
        install: async () => undefined,
        start: async () => undefined,
        verify: async () => undefined,
        restore: async () => undefined,
        removeOwned: async () => undefined,
      },
      connectors: {
        reconcileOwned: async () => undefined,
        snapshotOwned: async () => ({}),
        restoreOwned: async () => undefined,
        disconnectOwned: async () => undefined,
      },
      receipt: {
        read: async () => previous,
        commit: async () => undefined,
        remove: async () => undefined,
      },
    };

    await createInstallationLifecycle(dependencies).migrate({ targetVersion: '2.0.0' });
    expect(stage.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]!);
  });

  it('leaves the running installation untouched when staging fails', async () => {
    const root = temporaryDirectory();
    const previous: InstallationSnapshot = {
      runtimeVersion: '1.0.0',
      serviceCommand: ['/old/node', '/old/cli'],
      connectorEntries: {},
    };
    const stop = vi.fn(async () => undefined);
    const restoreRuntime = vi.fn(async () => undefined);
    const restoreService = vi.fn(async () => undefined);
    const dependencies: InstallationLifecycleDependencies = {
      dataDirectory: join(root, 'data'),
      homeDirectory: join(root, 'home'),
      lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
      runtime: {
        stage: async () => {
          throw new Error('download hash mismatch');
        },
        activate: async () => undefined,
        restore: restoreRuntime,
        removeOwned: async () => undefined,
      },
      service: {
        stop,
        install: async () => undefined,
        start: async () => undefined,
        verify: async () => undefined,
        restore: restoreService,
        removeOwned: async () => undefined,
      },
      connectors: {
        reconcileOwned: async () => undefined,
        snapshotOwned: async () => ({}),
        restoreOwned: async () => undefined,
        disconnectOwned: async () => undefined,
      },
      receipt: {
        read: async () => previous,
        commit: async () => undefined,
        remove: async () => undefined,
      },
    };

    await expect(
      createInstallationLifecycle(dependencies).update({ targetVersion: '2.0.0' }),
    ).rejects.toThrow('download hash mismatch');
    expect(stop).not.toHaveBeenCalled();
    expect(restoreRuntime).not.toHaveBeenCalled();
    expect(restoreService).not.toHaveBeenCalled();
  });

  it('restores the previous receipt and snapshots when the new receipt commit fails', async () => {
    const root = temporaryDirectory();
    const previous: InstallationSnapshot = {
      runtimeVersion: '1.0.0',
      serviceCommand: ['/old/node', '/old/cli'],
      connectorEntries: { codex: { command: '/old/launcher' } },
    };
    const commit = vi
      .fn<(snapshot: InstallationSnapshot) => Promise<void>>()
      .mockRejectedValueOnce(new Error('receipt fsync failed'))
      .mockResolvedValueOnce(undefined);
    const dependencies: InstallationLifecycleDependencies = {
      dataDirectory: join(root, 'data'),
      homeDirectory: join(root, 'home'),
      lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
      runtime: {
        stage: async (version) => ({
          version,
          nodePath: join(root, 'runtime/bin/node'),
          cliPath: join(root, 'runtime/dist/cli.js'),
        }),
        activate: async () => undefined,
        restore: vi.fn(async () => undefined),
        removeOwned: async () => undefined,
      },
      service: {
        stop: async () => undefined,
        install: async () => undefined,
        start: async () => undefined,
        verify: async () => undefined,
        restore: vi.fn(async () => undefined),
        removeOwned: async () => undefined,
      },
      connectors: {
        reconcileOwned: async () => undefined,
        snapshotOwned: async () => previous.connectorEntries,
        restoreOwned: vi.fn(async () => undefined),
        disconnectOwned: async () => undefined,
      },
      receipt: { read: async () => previous, commit, remove: async () => undefined },
    };

    await expect(
      createInstallationLifecycle(dependencies).update({ targetVersion: '2.0.0' }),
    ).rejects.toThrow('receipt fsync failed');
    expect(commit).toHaveBeenLastCalledWith(previous);
    expect(dependencies.runtime.restore).toHaveBeenCalledWith('1.0.0');
    expect(dependencies.connectors.restoreOwned).toHaveBeenCalledWith(previous.connectorEntries);
  });
});
