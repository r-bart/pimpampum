import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInstallationLifecycle,
  createSetupCoordinator,
  type InstallationLifecycleDependencies,
  type SetupCoordinatorDependencies,
} from '../src/setup/coordinator.js';
import { createSetupPlanStore, createSetupStateStore } from '../src/setup/state.js';
import {
  SETUP_SCHEMA_VERSION,
  type InstallationSnapshot,
  type SetupJournal,
} from '../src/setup/types.js';

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-setup-branch-${label}-`));
  roots.push(root);
  return root;
}

function connector() {
  return {
    inspect: vi.fn(async () => ({ state: 'notConnected' })),
    connect: vi.fn(async () => undefined),
    verify: vi.fn(async () => ({ available: true, newSessionRequired: false })),
    restore: vi.fn(async () => undefined),
  };
}

function setupDependencies(root: string): SetupCoordinatorDependencies {
  return {
    lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
    changeTargets: {
      runtimeDirectory: '/runtime',
      servicePath: '/service.plist',
      dataDirectory: '/data',
      connectorConfigPaths: { codex: '/codex.toml', 'claude-code': '/claude.json' },
    },
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
    now: () => '2026-08-31T15:00:00.000Z',
  };
}

function journal(operationId: string, overrides: Partial<SetupJournal> = {}): SetupJournal {
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    operationId,
    revision: 'revision',
    phase: 'runtime.install',
    selectedConnectors: [],
    conflictDecisions: {},
    completedPhases: [],
    diagnostics: [],
    service: { installed: false, running: false, verified: false },
    connectors: [],
    loginItem: 'pending',
    status: 'running',
    updatedAt: '2026-08-31T15:00:00.000Z',
    ...overrides,
  };
}

function lifecycleDependencies(root: string): InstallationLifecycleDependencies {
  const previous: InstallationSnapshot = {
    runtimeVersion: '1.0.0',
    serviceCommand: ['/old/node', '/old/cli.js'],
    connectorEntries: {},
    dataDirectory: join(root, 'data'),
    runtimeKind: 'legacy-npm',
  };
  return {
    dataDirectory: join(root, 'data'),
    homeDirectory: join(root, 'home'),
    lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
    runtime: {
      stage: vi.fn(async (version: string) => ({
        version,
        nodePath: join(root, 'runtime', version, 'bin/node'),
        cliPath: join(root, 'runtime', version, 'dist/cli.js'),
      })),
      activate: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined),
      removeOwned: vi.fn(async () => undefined),
    },
    service: {
      stop: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined),
      removeOwned: vi.fn(async () => undefined),
    },
    connectors: {
      reconcileOwned: vi.fn(async () => undefined),
      snapshotOwned: vi.fn(async () => ({})),
      restoreOwned: vi.fn(async () => undefined),
      disconnectOwned: vi.fn(async () => undefined),
    },
    receipt: {
      read: vi.fn(async () => previous),
      commit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('setup coordinator reachable boundary alternatives', () => {
  it('deduplicates selected connectors and rejects an unknown persisted operation', async () => {
    const root = temporaryDirectory('selection');
    const dependencies = setupDependencies(root);
    const planStore = createSetupPlanStore(dependencies.dataDirectory);
    const first = createSetupCoordinator({ ...dependencies, planStore });
    const plan = await first.plan({ selectedConnectors: ['codex', 'codex'] });
    expect(plan.selectedConnectors).toEqual(['codex']);

    const restarted = createSetupCoordinator({ ...dependencies, planStore });
    await expect(
      restarted.apply({
        operationId: 'different-operation',
        expectedRevision: plan.revision,
        confirmed: true,
      }),
    ).rejects.toThrow(/missing|stale|changed/iu);
  });

  it('redacts non-Error failures and omits an empty connector diagnostic', async () => {
    const serviceInput = setupDependencies(temporaryDirectory('non-error'));
    vi.mocked(serviceInput.service.verify).mockRejectedValueOnce('service failed');
    const serviceSetup = createSetupCoordinator(serviceInput);
    const servicePlan = await serviceSetup.plan({ selectedConnectors: [] });
    await expect(
      serviceSetup.apply({
        operationId: servicePlan.operationId,
        expectedRevision: servicePlan.revision,
        confirmed: true,
      }),
    ).rejects.toBe('service failed');

    const connectorInput = setupDependencies(temporaryDirectory('empty-diagnostic'));
    vi.mocked(connectorInput.connectors.codex.connect).mockRejectedValueOnce(new Error(''));
    const connectorSetup = createSetupCoordinator(connectorInput);
    const connectorPlan = await connectorSetup.plan({ selectedConnectors: ['codex'] });
    const result = await connectorSetup.apply({
      operationId: connectorPlan.operationId,
      expectedRevision: connectorPlan.revision,
      confirmed: true,
    });
    expect(result).toMatchObject({
      status: 'partial',
      connectors: [{ id: 'codex', state: 'needsRepair' }],
    });
    expect(result.connectors[0]).not.toHaveProperty('error');
  });

  it('forwards a reviewed fingerprint and handles unsupported replacement without one', async () => {
    const reviewedInput = setupDependencies(temporaryDirectory('reviewed-fingerprint'));
    vi.mocked(reviewedInput.connectors.codex.inspect).mockResolvedValue({
      state: 'conflict',
      revision: 'a'.repeat(64),
    });
    const reviewedSetup = createSetupCoordinator(reviewedInput);
    const reviewedPlan = await reviewedSetup.plan({ selectedConnectors: ['codex'] });
    await reviewedSetup.apply({
      operationId: reviewedPlan.operationId,
      expectedRevision: reviewedPlan.revision,
      confirmed: true,
      conflictDecisions: { codex: 'replace' },
    });
    expect(reviewedInput.connectors.codex.connect).toHaveBeenCalledWith({
      conflictDecision: 'replace',
      reviewedEntryFingerprint: 'a'.repeat(64),
    });

    const unsupportedInput = setupDependencies(temporaryDirectory('unsupported-no-revision'));
    vi.mocked(unsupportedInput.connectors.codex.inspect).mockResolvedValue({
      state: 'conflict',
      replacementSupported: false,
    });
    const unsupportedSetup = createSetupCoordinator(unsupportedInput);
    const unsupportedPlan = await unsupportedSetup.plan({ selectedConnectors: ['codex'] });
    await expect(
      unsupportedSetup.apply({
        operationId: unsupportedPlan.operationId,
        expectedRevision: unsupportedPlan.revision,
        confirmed: true,
        conflictDecisions: { codex: 'replace' },
      }),
    ).resolves.toMatchObject({ status: 'conflict' });
  });

  it('keeps a concurrent observer registered until its serialized apply starts', async () => {
    const input = setupDependencies(temporaryDirectory('concurrent-observers'));
    let tail: Promise<void> = Promise.resolve();
    input.lifecycleLock = {
      run<T>(operation: () => Promise<T>): Promise<T> {
        const result = tail.then(operation);
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    };
    let releaseInstall!: () => void;
    const installHeld = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    vi.mocked(input.runtime.install).mockImplementationOnce(async () => {
      await installHeld;
      return { version: '2.0.0' };
    });
    const setup = createSetupCoordinator(input);
    const plan = await setup.plan({ selectedConnectors: [] });
    const first = setup.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
      onProgress: vi.fn(),
    });
    await vi.waitFor(() => expect(input.runtime.install).toHaveBeenCalledOnce());
    const second = setup.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
      onProgress: vi.fn(),
    });
    releaseInstall();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('resumes completed connector phases and normalizes a directly returned running result', async () => {
    const root = temporaryDirectory('completed-connector');
    const input = setupDependencies(root);
    const store = createSetupStateStore(input.dataDirectory);
    store.write(
      journal('completed-operation', {
        selectedConnectors: ['codex'],
        completedPhases: [
          'runtime.install',
          'service.install',
          'service.verify',
          'login-item.register',
          'connector:codex.connect',
          'connector:codex.verify',
        ],
        service: { installed: true, running: true, verified: true },
        connectors: [
          {
            id: 'codex',
            configured: true,
            available: true,
            newSessionRequired: false,
            state: 'connected',
          },
        ],
        loginItem: 'enabled',
      }),
    );
    const setup = createSetupCoordinator({ ...input, stateStore: store });
    await expect(setup.retryConnector('codex')).resolves.toMatchObject({ status: 'partial' });
    await expect(setup.resume()).resolves.toMatchObject({ status: 'complete' });
    expect(input.connectors.codex.verify).not.toHaveBeenCalled();
  });

  it('repairs inconsistent durable connector phases and remains partial after a failed retry', async () => {
    const reconnectRoot = temporaryDirectory('reconnect-inconsistent');
    const reconnectInput = setupDependencies(reconnectRoot);
    const reconnectStore = createSetupStateStore(reconnectInput.dataDirectory);
    reconnectStore.write(
      journal('reconnect-operation', {
        selectedConnectors: ['codex'],
        completedPhases: [
          'runtime.install',
          'service.install',
          'service.verify',
          'login-item.register',
          'connector:codex.connect',
        ],
        connectors: [
          {
            id: 'codex',
            configured: false,
            available: false,
            newSessionRequired: false,
            state: 'needsRepair',
          },
        ],
        status: 'partial',
      }),
    );
    await createSetupCoordinator({ ...reconnectInput, stateStore: reconnectStore }).retryConnector(
      'codex',
    );
    expect(reconnectInput.connectors.codex.connect).toHaveBeenCalledOnce();

    const partialRoot = temporaryDirectory('partial-retry');
    const partialInput = setupDependencies(partialRoot);
    vi.mocked(partialInput.connectors.codex.verify).mockResolvedValue({
      available: false,
      newSessionRequired: false,
    });
    const partialStore = createSetupStateStore(partialInput.dataDirectory);
    partialStore.write(
      journal('partial-operation', {
        selectedConnectors: ['claude-code', 'codex'],
        completedPhases: [
          'runtime.install',
          'service.install',
          'service.verify',
          'login-item.register',
          'connector:codex.connect',
        ],
        connectors: [
          {
            id: 'claude-code',
            configured: false,
            available: false,
            newSessionRequired: false,
            state: 'keptExisting',
          },
          {
            id: 'codex',
            configured: true,
            available: false,
            newSessionRequired: false,
            state: 'needsRepair',
          },
        ],
        status: 'partial',
      }),
    );
    await expect(
      createSetupCoordinator({ ...partialInput, stateStore: partialStore }).retryConnector('codex'),
    ).resolves.toMatchObject({ status: 'partial' });
  });

  it('clears every impossible base completion marker after a resumed base failure', async () => {
    const root = temporaryDirectory('base-marker-recovery');
    const input = setupDependencies(root);
    vi.mocked(input.runtime.install).mockRejectedValueOnce(new Error('runtime failed'));
    const store = createSetupStateStore(input.dataDirectory);
    store.write(
      journal('base-marker-operation', {
        completedPhases: ['service.verify', 'login-item.register'],
        status: 'failed',
      }),
    );
    await expect(createSetupCoordinator({ ...input, stateStore: store }).resume()).rejects.toThrow(
      'runtime failed',
    );
    expect(store.read()?.completedPhases).toEqual([]);
  });

  it('round-trips a durable conflict without an optional fingerprint', () => {
    const store = createSetupPlanStore(join(temporaryDirectory('fingerprint-optional'), 'data'));
    store.write({
      operationId: 'operation',
      revision: 'a'.repeat(64),
      selectedConnectors: ['codex'],
      changes: [],
      conflicts: [{ connectorId: 'codex', comparison: 'Existing entry differs.' }],
      requiresConfirmation: true,
    });
    expect(store.read()?.conflicts).toEqual([
      { connectorId: 'codex', comparison: 'Existing entry differs.' },
    ]);
  });
});

describe('installation lifecycle non-Error rollback diagnostics', () => {
  it('preserves the triggering Error message when migration rollback also fails', async () => {
    const dependencies = lifecycleDependencies(temporaryDirectory('migration-error'));
    vi.mocked(dependencies.service.stop).mockRejectedValueOnce(new Error('stop failed'));
    vi.mocked(dependencies.runtime.restore).mockRejectedValueOnce(new Error('restore failed'));
    const error = await createInstallationLifecycle(dependencies)
      .migrate({ targetVersion: '2.0.0' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/stop failed.*rollback was incomplete/iu);
  });

  it('uses the migration fallback message for a non-Error failure with rollback faults', async () => {
    const dependencies = lifecycleDependencies(temporaryDirectory('migration-non-error'));
    vi.mocked(dependencies.service.stop).mockRejectedValue('stop failed');
    const error = await createInstallationLifecycle(dependencies)
      .migrate({ targetVersion: '2.0.0' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/migration recovery failed/iu);
  });

  it('uses the update fallback message for a non-Error failure with rollback faults', async () => {
    const dependencies = lifecycleDependencies(temporaryDirectory('update-non-error'));
    vi.mocked(dependencies.receipt.read).mockResolvedValue({
      runtimeVersion: '1.0.0',
      serviceCommand: ['/old/node', '/old/cli.js'],
      connectorEntries: {},
      dataDirectory: dependencies.dataDirectory,
      runtimeKind: 'packaged',
    });
    vi.mocked(dependencies.service.install).mockRejectedValueOnce('install failed');
    vi.mocked(dependencies.runtime.restore).mockRejectedValueOnce(new Error('restore failed'));
    const error = await createInstallationLifecycle(dependencies)
      .update({ targetVersion: '2.0.0' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/installation update failed/iu);
  });

  it('uses the removal fallback message for a non-Error failure with rollback faults', async () => {
    const dependencies = lifecycleDependencies(temporaryDirectory('removal-non-error'));
    vi.mocked(dependencies.receipt.read).mockResolvedValue({
      runtimeVersion: '1.0.0',
      serviceCommand: ['/old/node', '/old/cli.js'],
      connectorEntries: {},
      dataDirectory: dependencies.dataDirectory,
      runtimeKind: 'packaged',
    });
    vi.mocked(dependencies.connectors.disconnectOwned).mockRejectedValueOnce('disconnect failed');
    vi.mocked(dependencies.service.restore).mockRejectedValueOnce(new Error('restore failed'));
    const error = await createInstallationLifecycle(dependencies)
      .remove()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/installation removal failed/iu);
  });
});
