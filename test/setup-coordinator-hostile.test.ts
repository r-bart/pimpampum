import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSetupCoordinator,
  type SetupCoordinatorDependencies,
} from '../src/setup/coordinator.js';
import { createSetupStateStore } from '../src/setup/state.js';
import type { SetupConnectorId, SetupJournal } from '../src/setup/types.js';

const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-setup-coordinator-hostile-'));
  roots.push(root);
  return root;
}

function dependencies(root: string): SetupCoordinatorDependencies {
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
    now: () => '2026-08-31T12:00:00.000Z',
  };
}

async function reviewedApply(
  setup: ReturnType<typeof createSetupCoordinator>,
  selectedConnectors: SetupConnectorId[] = [],
) {
  const plan = await setup.plan({ selectedConnectors });
  return setup.apply({
    operationId: plan.operationId,
    expectedRevision: plan.revision,
    confirmed: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('hostile setup coordinator boundaries', () => {
  it('rejects unsafe roots, unknown connectors, stale plans, and implicit confirmation', async () => {
    expect(() =>
      createSetupCoordinator({ ...dependencies(temporaryDirectory()), dataDirectory: '.' }),
    ).toThrow(/absolute/iu);
    const setup = createSetupCoordinator(dependencies(temporaryDirectory()));
    await expect(
      setup.plan({ selectedConnectors: ['unknown' as SetupConnectorId] }),
    ).rejects.toThrow(/unsupported connector/iu);
    const plan = await setup.plan({ selectedConnectors: [] });
    await expect(
      setup.apply({ operationId: plan.operationId, expectedRevision: 'stale', confirmed: true }),
    ).rejects.toThrow(/stale|changed/iu);
    await expect(
      setup.apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: false,
      }),
    ).rejects.toThrow(/confirmation/iu);
  });

  it('ignores observer faults and exposes login recovery without leaking its diagnostic', async () => {
    const input = dependencies(temporaryDirectory());
    input.onProgress = async () => {
      throw new Error('observer must be non-owning');
    };
    vi.mocked(input.loginItem.register).mockRejectedValueOnce(
      new Error('Bearer login-secret-value\n/home/alice/private'),
    );
    const result = await reviewedApply(createSetupCoordinator(input));
    expect(result).toMatchObject({ status: 'complete', nextAction: 'recover-login-item' });
    const persisted = createSetupStateStore(input.dataDirectory).read();
    expect(persisted?.diagnostics.join(' ')).not.toMatch(/login-secret-value|alice/iu);
  });

  it('rolls back both base owners on service failure even when rollback hooks also fail', async () => {
    const input = dependencies(temporaryDirectory());
    vi.mocked(input.service.verify).mockRejectedValueOnce(new Error('occupied service port'));
    vi.mocked(input.service.rollback).mockRejectedValueOnce(new Error('service rollback failed'));
    vi.mocked(input.runtime.rollback).mockRejectedValueOnce(new Error('runtime rollback failed'));
    const setup = createSetupCoordinator(input);
    const plan = await setup.plan({ selectedConnectors: ['codex'] });
    const error = await setup
      .apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: true,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/occupied service port.*rollback was incomplete/iu);
    expect(input.service.rollback).toHaveBeenCalledOnce();
    expect(input.runtime.rollback).toHaveBeenCalledOnce();
    expect(input.connectors.codex.connect).not.toHaveBeenCalled();
    const journal = createSetupStateStore(input.dataDirectory).read();
    expect(journal).toMatchObject({
      status: 'failed',
      service: { installed: true, running: false, verified: false },
      completedPhases: [],
    });
    expect(journal?.diagnostics.join(' ')).toMatch(
      /occupied service port.*service rollback failed.*runtime rollback failed/iu,
    );
  });

  it('deduplicates and safely labels empty rollback diagnostics', async () => {
    const duplicateInput = dependencies(temporaryDirectory());
    vi.mocked(duplicateInput.service.verify).mockRejectedValueOnce(new Error('same failure'));
    vi.mocked(duplicateInput.service.rollback).mockRejectedValueOnce(new Error('same failure'));
    const duplicateError = await reviewedApply(createSetupCoordinator(duplicateInput)).catch(
      (caught: unknown) => caught,
    );
    expect(duplicateError).toBeInstanceOf(AggregateError);
    expect(createSetupStateStore(duplicateInput.dataDirectory).read()?.diagnostics).toEqual([
      'same failure',
    ]);

    const emptyInput = dependencies(temporaryDirectory());
    vi.mocked(emptyInput.service.verify).mockRejectedValueOnce(new Error(''));
    vi.mocked(emptyInput.service.rollback).mockRejectedValueOnce(new Error(''));
    const emptyError = await reviewedApply(createSetupCoordinator(emptyInput)).catch(
      (caught: unknown) => caught,
    );
    expect(emptyError).toBeInstanceOf(AggregateError);
    expect(String(emptyError)).toMatch(/setup failed.*rollback was incomplete/iu);
    expect(createSetupStateStore(emptyInput.dataDirectory).read()?.diagnostics).toEqual([]);
  });

  it('keeps a configured connector repairable when verification is unavailable', async () => {
    const input = dependencies(temporaryDirectory());
    vi.mocked(input.connectors.codex.verify)
      .mockResolvedValueOnce({ available: false, newSessionRequired: false })
      .mockResolvedValueOnce({ available: true, newSessionRequired: true });
    const setup = createSetupCoordinator(input);
    const first = await reviewedApply(setup, ['codex']);
    expect(first).toMatchObject({
      status: 'partial',
      connectors: [{ id: 'codex', configured: true, state: 'needsRepair' }],
    });
    const repaired = await setup.retryConnector('codex');
    expect(repaired).toMatchObject({ status: 'complete', nextAction: 'new-session' });
    expect(input.connectors.codex.connect).toHaveBeenCalledOnce();
    expect(input.connectors.codex.verify).toHaveBeenCalledTimes(2);
    await expect(setup.retryConnector('codex')).resolves.toMatchObject({ status: 'complete' });
  });

  it('requires a reviewed replacement when the official host cannot restore the entry', async () => {
    const input = dependencies(temporaryDirectory());
    vi.mocked(input.connectors.codex.inspect).mockResolvedValue({
      state: 'conflict',
      revision: 'a'.repeat(64),
      replacementSupported: false,
    });
    const setup = createSetupCoordinator(input);
    const plan = await setup.plan({ selectedConnectors: ['codex'] });
    const result = await setup.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
      conflictDecisions: { codex: 'replace' },
    });
    expect(result).toMatchObject({ status: 'conflict', nextAction: 'resolve-conflict' });
    expect(input.runtime.install).not.toHaveBeenCalled();
  });

  it('rejects absent resumes, unrelated retries, and a mismatched durable revision', async () => {
    const root = temporaryDirectory();
    const input = dependencies(root);
    const store = createSetupStateStore(input.dataDirectory);
    const setup = createSetupCoordinator({ ...input, stateStore: store });
    await expect(setup.resume()).rejects.toThrow(/no durable setup operation/iu);
    await expect(setup.retryConnector('codex')).rejects.toThrow(/not part/iu);
    await expect(setup.retryConnector('unknown' as SetupConnectorId)).rejects.toThrow(
      /unsupported connector/iu,
    );

    const plan = await setup.plan({ selectedConnectors: [] });
    const journal: SetupJournal = {
      schemaVersion: 1,
      operationId: plan.operationId,
      revision: 'different-revision',
      phase: 'runtime.install',
      selectedConnectors: [],
      conflictDecisions: {},
      completedPhases: [],
      diagnostics: [],
      service: { installed: false, running: false, verified: false },
      connectors: [],
      loginItem: 'pending',
      status: 'running',
      updatedAt: input.now(),
    };
    store.write(journal);
    await expect(
      setup.apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: true,
      }),
    ).rejects.toThrow(/journal revision/iu);
  });

  it('persists conflicts discovered while applying or resuming an existing journal', async () => {
    const applyRoot = temporaryDirectory();
    const applyInput = dependencies(applyRoot);
    const applyStore = createSetupStateStore(applyInput.dataDirectory);
    const applySetup = createSetupCoordinator({ ...applyInput, stateStore: applyStore });
    const plan = await applySetup.plan({ selectedConnectors: ['codex'] });
    applyStore.write({
      schemaVersion: 1,
      operationId: plan.operationId,
      revision: plan.revision,
      phase: 'runtime.install',
      selectedConnectors: ['codex'],
      conflictDecisions: {},
      completedPhases: [],
      diagnostics: [],
      service: { installed: false, running: false, verified: false },
      connectors: [],
      loginItem: 'pending',
      status: 'running',
      updatedAt: applyInput.now(),
    });
    vi.mocked(applyInput.connectors.codex.inspect).mockResolvedValue({ state: 'conflict' });
    await expect(
      applySetup.apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(applyStore.read()?.phase).toBe('conflict');

    const resumeRoot = temporaryDirectory();
    const resumeInput = dependencies(resumeRoot);
    const resumeStore = createSetupStateStore(resumeInput.dataDirectory);
    resumeStore.write({
      ...applyStore.read()!,
      operationId: 'resume-operation',
      revision: 'resume',
      status: 'failed',
    });
    vi.mocked(resumeInput.connectors.codex.inspect).mockResolvedValue({ state: 'conflict' });
    await expect(
      createSetupCoordinator({ ...resumeInput, stateStore: resumeStore }).resume(),
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(resumeStore.read()?.phase).toBe('conflict');
  });

  it('returns the durable completed result without repeating mutation', async () => {
    const input = dependencies(temporaryDirectory());
    const setup = createSetupCoordinator(input);
    const plan = await setup.plan({ selectedConnectors: [] });
    await setup.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
    });
    await expect(
      setup.apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ status: 'complete' });
    expect(input.runtime.install).toHaveBeenCalledOnce();
  });
});
