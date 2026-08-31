/**
 * @generated-from thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ConnectorId = 'codex' | 'claude-code';
type ConnectorResult = {
  id: ConnectorId;
  configured: boolean;
  available: boolean;
  newSessionRequired: boolean;
  state: string;
  error?: string;
};

type SetupPlan = {
  operationId: string;
  revision: string;
  selectedConnectors: ConnectorId[];
  changes: Array<{ kind: string; summary: string; path?: string }>;
  conflicts: Array<{ connectorId: ConnectorId; comparison: string }>;
  requiresConfirmation: boolean;
};

type SetupResult = {
  status: 'complete' | 'partial' | 'conflict' | 'failed';
  service: { installed: boolean; running: boolean; verified: boolean };
  connectors: ConnectorResult[];
  nextAction: 'done' | 'retry' | 'new-session' | 'resolve-conflict' | 'recover-login-item';
};

type SetupDependencies = {
  lifecycleLock: { run<T>(operation: () => Promise<T>): Promise<T> };
  runtime: {
    install(): Promise<{ version: string }>;
    rollback(): Promise<void>;
  };
  service: {
    install(): Promise<void>;
    verify(): Promise<void>;
    rollback(): Promise<void>;
  };
  connectors: Record<
    ConnectorId,
    {
      inspect(): Promise<{ state: string; comparison?: string }>;
      connect(): Promise<void>;
      verify(): Promise<{ available: boolean; newSessionRequired: boolean }>;
      restore(): Promise<void>;
    }
  >;
  loginItem: { register(): Promise<'enabled' | 'requires-approval' | 'denied'> };
  dataDirectory: string;
  now(): string;
};

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-setup-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function dependencies(root: string, overrides: Partial<SetupDependencies> = {}): SetupDependencies {
  const connector = () => ({
    inspect: vi.fn(async () => ({ state: 'notConnected' })),
    connect: vi.fn(async () => undefined),
    verify: vi.fn(async () => ({ available: true, newSessionRequired: true })),
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
    ...overrides,
  };
}

async function setupContract() {
  const coordinatorUrl = new URL('../src/setup/coordinator.ts', import.meta.url).href;
  const stateUrl = new URL('../src/setup/state.ts', import.meta.url).href;
  const [coordinator, state] = await Promise.all([import(coordinatorUrl), import(stateUrl)]);
  return {
    createSetupCoordinator: coordinator.createSetupCoordinator as (
      dependencies: SetupDependencies,
    ) => {
      plan(input: { selectedConnectors: ConnectorId[] }): Promise<SetupPlan>;
      apply(input: {
        operationId: string;
        expectedRevision: string;
        confirmed: boolean;
        conflictDecisions?: Partial<Record<ConnectorId, 'keep' | 'replace' | 'cancel'>>;
      }): Promise<SetupResult>;
      resume(): Promise<SetupResult>;
      retryConnector(id: ConnectorId): Promise<SetupResult>;
    },
    readSetupState: state.readSetupState as (dataDirectory: string) => {
      operationId: string;
      phase: string;
      selectedConnectors: ConnectorId[];
      completedPhases: string[];
      diagnostics: string[];
    } | null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Durable one-confirmation setup coordinator', () => {
  it('FR-4.1/FR-4.4: planning describes bounded changes without mutating anything', async () => {
    // Spec: US-1/AC-3, FR-3.3, FR-4.1, FR-4.4
    const root = temporaryDirectory('plan');
    const deps = dependencies(root);
    const { createSetupCoordinator } = await setupContract();
    const coordinator = createSetupCoordinator(deps);

    const plan = await coordinator.plan({ selectedConnectors: ['codex', 'claude-code'] });

    expect(plan).toMatchObject({
      selectedConnectors: ['codex', 'claude-code'],
      requiresConfirmation: true,
      conflicts: [],
    });
    expect(plan.changes.map((change) => change.kind)).toEqual([
      'runtime',
      'service',
      'login-item',
      'connector:codex',
      'connector:claude-code',
    ]);
    expect(deps.runtime.install).not.toHaveBeenCalled();
    expect(deps.service.install).not.toHaveBeenCalled();
    expect(deps.connectors.codex.connect).not.toHaveBeenCalled();
    expect(deps.connectors['claude-code'].connect).not.toHaveBeenCalled();
  });

  it('US-1/AC-4: one confirmed operation installs service and only selected connectors', async () => {
    // Spec: US-1/AC-4, FR-4.2, FR-4.3, FR-4.4, FR-7.3
    const root = temporaryDirectory('selected');
    const deps = dependencies(root);
    const { createSetupCoordinator } = await setupContract();
    const coordinator = createSetupCoordinator(deps);
    const plan = await coordinator.plan({ selectedConnectors: ['codex'] });

    const result = await coordinator.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
    });

    expect(result).toMatchObject({
      status: 'complete',
      service: { installed: true, running: true, verified: true },
      connectors: [
        {
          id: 'codex',
          configured: true,
          available: true,
          newSessionRequired: true,
        },
      ],
      nextAction: 'new-session',
    });
    expect(deps.connectors.codex.connect).toHaveBeenCalledOnce();
    expect(deps.connectors['claude-code'].connect).not.toHaveBeenCalled();
  });

  it('EC-1: no supported agent still completes the runtime and service successfully', async () => {
    // Spec: EC-1, Success metric: successful setup with no supported agents
    const root = temporaryDirectory('no-agent');
    const deps = dependencies(root);
    const { createSetupCoordinator } = await setupContract();
    const coordinator = createSetupCoordinator(deps);
    const plan = await coordinator.plan({ selectedConnectors: [] });
    const result = await coordinator.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
    });

    expect(result).toMatchObject({
      status: 'complete',
      service: { installed: true, running: true, verified: true },
      connectors: [],
      nextAction: 'done',
    });
  });

  it('US-2/AC-2: one failed connector preserves verified connections and supports focused retry', async () => {
    // Spec: US-2/AC-2, FR-7.3, EC-9
    const root = temporaryDirectory('partial');
    const deps = dependencies(root);
    vi.mocked(deps.connectors['claude-code'].verify).mockRejectedValueOnce(
      new Error('MCP initialization timed out after 10 seconds'),
    );
    const { createSetupCoordinator } = await setupContract();
    const coordinator = createSetupCoordinator(deps);
    const plan = await coordinator.plan({ selectedConnectors: ['codex', 'claude-code'] });

    const partial = await coordinator.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
    });
    expect(partial.status).toBe('partial');
    expect(partial.connectors).toEqual([
      expect.objectContaining({ id: 'codex', configured: true, available: true }),
      expect.objectContaining({
        id: 'claude-code',
        configured: true,
        available: false,
        state: 'needsRepair',
      }),
    ]);
    expect(deps.connectors.codex.restore).not.toHaveBeenCalled();

    const recovered = await coordinator.retryConnector('claude-code');
    expect(recovered.status).toBe('complete');
    expect(deps.connectors.codex.connect).toHaveBeenCalledOnce();
    expect(deps.connectors['claude-code'].verify).toHaveBeenCalledTimes(2);
  });

  it('FR-7.4: broken runtime or daemon verification prevents all host configuration', async () => {
    // Spec: US-3/AC-5, FR-7.4, EC-10
    const root = temporaryDirectory('daemon-failure');
    const deps = dependencies(root);
    vi.mocked(deps.service.verify).mockRejectedValueOnce(
      new Error('Port 7337 belongs to an unknown process'),
    );
    const { createSetupCoordinator } = await setupContract();
    const coordinator = createSetupCoordinator(deps);
    const plan = await coordinator.plan({ selectedConnectors: ['codex', 'claude-code'] });

    await expect(
      coordinator.apply({
        operationId: plan.operationId,
        expectedRevision: plan.revision,
        confirmed: true,
      }),
    ).rejects.toThrow(/7337|daemon|port/i);
    expect(deps.connectors.codex.connect).not.toHaveBeenCalled();
    expect(deps.connectors['claude-code'].connect).not.toHaveBeenCalled();
    expect(deps.service.rollback).toHaveBeenCalledOnce();
    expect(deps.runtime.rollback).toHaveBeenCalledOnce();
  });

  it('FR-7.1: durable state resumes after UI closure without repeating completed phases', async () => {
    // Spec: FR-7.1, EC-13, PERF-4
    const root = temporaryDirectory('resume');
    const deps = dependencies(root);
    let releaseService: (() => void) | undefined;
    vi.mocked(deps.service.verify).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseService = resolve;
        }),
    );
    const { createSetupCoordinator, readSetupState } = await setupContract();
    const firstCoordinator = createSetupCoordinator(deps);
    const plan = await firstCoordinator.plan({ selectedConnectors: ['codex'] });
    const pending = firstCoordinator.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
    });
    await vi.waitFor(() =>
      expect(readSetupState(deps.dataDirectory)?.phase).toBe('service.verify'),
    );
    releaseService?.();
    await pending;

    const resumed = await createSetupCoordinator(deps).resume();
    expect(resumed.status).toBe('complete');
    expect(deps.runtime.install).toHaveBeenCalledOnce();
    expect(deps.service.install).toHaveBeenCalledOnce();
    expect(statSync(join(deps.dataDirectory, 'setup-state.json')).mode & 0o777).toBe(0o600);
  });

  it('FR-7.2: an unknown conflict requires a separate replacement decision', async () => {
    // Spec: US-3/AC-4, FR-4.3, FR-7.2, EC-7
    const root = temporaryDirectory('conflict');
    const deps = dependencies(root);
    vi.mocked(deps.connectors.codex.inspect).mockResolvedValue({
      state: 'conflict',
      comparison: 'Existing: custom local server\nProposed: Pimpampum-owned launcher',
    });
    const { createSetupCoordinator } = await setupContract();
    const coordinator = createSetupCoordinator(deps);
    const plan = await coordinator.plan({ selectedConnectors: ['codex'] });

    expect(plan.conflicts).toHaveLength(1);
    const first = await coordinator.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
    });
    expect(first).toMatchObject({ status: 'conflict', nextAction: 'resolve-conflict' });
    expect(deps.connectors.codex.connect).not.toHaveBeenCalled();

    await coordinator.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
      conflictDecisions: { codex: 'replace' },
    });
    expect(deps.connectors.codex.connect).toHaveBeenCalledOnce();
  });

  it('US-1/AC-5: OS approval is surfaced only when the OS reports it is required', async () => {
    // Spec: US-1/AC-5, FR-7.5, EC-13
    const root = temporaryDirectory('login-item');
    const deps = dependencies(root, {
      loginItem: { register: vi.fn(async () => 'requires-approval' as const) },
    });
    const { createSetupCoordinator } = await setupContract();
    const coordinator = createSetupCoordinator(deps);
    const plan = await coordinator.plan({ selectedConnectors: [] });
    const result = await coordinator.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
    });

    expect(result.nextAction).toBe('recover-login-item');
    expect(result.service.verified).toBe(true);
    expect(readFileSync(join(deps.dataDirectory, 'setup-state.json'), 'utf8')).not.toMatch(
      /bearer|token/iu,
    );
  });

  it('PERF-5: concurrent setup attempts serialize through the lifecycle lock', async () => {
    // Spec: PERF-5, Success metric: duplicate daemon instances after repeated setup/update
    const root = temporaryDirectory('concurrency');
    let active = 0;
    let maximumActive = 0;
    const lifecycleLock = {
      run: async <T>(operation: () => Promise<T>): Promise<T> => {
        while (active > 0) await new Promise((resolve) => setTimeout(resolve, 1));
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await operation();
        } finally {
          active -= 1;
        }
      },
    };
    const deps = dependencies(root, { lifecycleLock });
    const { createSetupCoordinator } = await setupContract();
    const coordinator = createSetupCoordinator(deps);
    const first = await coordinator.plan({ selectedConnectors: [] });
    const second = await coordinator.plan({ selectedConnectors: [] });

    await Promise.all([
      coordinator.apply({
        operationId: first.operationId,
        expectedRevision: first.revision,
        confirmed: true,
      }),
      coordinator.apply({
        operationId: second.operationId,
        expectedRevision: second.revision,
        confirmed: true,
      }),
    ]);
    expect(maximumActive).toBe(1);
  });
});
