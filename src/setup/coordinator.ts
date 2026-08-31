import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createSetupStateStore } from './state.js';
import {
  SETUP_CONNECTOR_IDS,
  SETUP_SCHEMA_VERSION,
  type InstallationSnapshot,
  type SetupConflict,
  type SetupConnectorId,
  type SetupConnectorResult,
  type SetupJournal,
  type SetupPlan,
  type SetupProgressEvent,
  type SetupResult,
  type SetupStateStore,
} from './types.js';

type ConflictDecision = 'keep' | 'replace' | 'cancel';

export interface SetupCoordinatorDependencies {
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
    SetupConnectorId,
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
  onProgress?(event: SetupProgressEvent): void | Promise<void>;
  stateStore?: SetupStateStore;
}

export interface InstallationLifecycleDependencies {
  dataDirectory: string;
  homeDirectory: string;
  lifecycleLock: { run<T>(operation: () => Promise<T>): Promise<T> };
  runtime: {
    stage(version: string): Promise<{ version: string; nodePath: string; cliPath: string }>;
    activate(version: string): Promise<void>;
    restore(version: string): Promise<void>;
    removeOwned(): Promise<void>;
  };
  service: {
    stop(): Promise<void>;
    install(input: { nodePath: string; cliPath: string }): Promise<void>;
    start(): Promise<void>;
    verify(): Promise<void>;
    restore(snapshot: InstallationSnapshot): Promise<void>;
    removeOwned(): Promise<void>;
  };
  connectors: {
    reconcileOwned(): Promise<void>;
    snapshotOwned(): Promise<Record<string, unknown>>;
    restoreOwned(entries: Record<string, unknown>): Promise<void>;
    disconnectOwned(): Promise<void>;
  };
  receipt: {
    read(): Promise<InstallationSnapshot>;
    commit(snapshot: InstallationSnapshot): Promise<void>;
    remove(): Promise<void>;
  };
}

function assertPrivatePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute, NUL-free path`);
  }
}

function selectedConnectorIds(values: readonly SetupConnectorId[]): SetupConnectorId[] {
  const result: SetupConnectorId[] = [];
  for (const value of values) {
    if (!SETUP_CONNECTOR_IDS.includes(value)) throw new Error(`Unsupported connector: ${value}`);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function redactDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'The operation failed';
  return raw
    .replace(/(?:authorization\s*:?\s*)?bearer\s+\S+/giu, '[credential redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/giu, '[credential redacted]')
    .replace(/\/Users\/[^/\s]+/gu, '~')
    .replace(/\/home\/[^/\s]+/gu, '~')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, 320);
}

function safeComparison(value: string | undefined): string {
  if (value === undefined) return 'An existing entry differs from the proposed Pimpampum entry.';
  return redactDiagnostic(new Error(value));
}

function planRevision(plan: Omit<SetupPlan, 'revision'>): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function nextAction(state: SetupJournal): SetupResult['nextAction'] {
  if (state.status === 'conflict') return 'resolve-conflict';
  if (state.status === 'partial' || state.status === 'failed') return 'retry';
  if (state.loginItem === 'requires-approval' || state.loginItem === 'denied') {
    return 'recover-login-item';
  }
  if (state.connectors.some((connector) => connector.available && connector.newSessionRequired)) {
    return 'new-session';
  }
  return 'done';
}

function resultFromJournal(state: SetupJournal): SetupResult {
  const status = state.status === 'running' ? 'partial' : state.status;
  return {
    status,
    service: { ...state.service },
    connectors: state.connectors.map((connector) => ({ ...connector })),
    nextAction: nextAction({ ...state, status }),
  };
}

function initialJournal(
  plan: SetupPlan,
  decisions: Partial<Record<SetupConnectorId, ConflictDecision>>,
  now: string,
): SetupJournal {
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    operationId: plan.operationId,
    revision: plan.revision,
    phase: 'runtime.install',
    selectedConnectors: [...plan.selectedConnectors],
    conflictDecisions: { ...decisions },
    completedPhases: [],
    diagnostics: [],
    service: { installed: false, running: false, verified: false },
    connectors: [],
    loginItem: 'pending',
    status: 'running',
    updatedAt: now,
  };
}

export function createSetupCoordinator(dependencies: SetupCoordinatorDependencies): {
  plan(input: { selectedConnectors: SetupConnectorId[] }): Promise<SetupPlan>;
  apply(input: {
    operationId: string;
    expectedRevision: string;
    confirmed: boolean;
    conflictDecisions?: Partial<Record<SetupConnectorId, ConflictDecision>>;
  }): Promise<SetupResult>;
  resume(): Promise<SetupResult>;
  retryConnector(id: SetupConnectorId): Promise<SetupResult>;
} {
  assertPrivatePath(dependencies.dataDirectory, 'Setup data directory');
  const stateStore = dependencies.stateStore ?? createSetupStateStore(dependencies.dataDirectory);
  const plans = new Map<string, SetupPlan>();

  async function progress(
    state: SetupJournal,
    phase: string,
    status: SetupProgressEvent['status'],
    diagnostic?: string,
  ): Promise<void> {
    if (dependencies.onProgress === undefined) return;
    const connector = /^connector:(codex|claude-code)\./u.exec(phase)?.[1] as
      SetupConnectorId | undefined;
    try {
      await dependencies.onProgress({
        schemaVersion: SETUP_SCHEMA_VERSION,
        operationId: state.operationId,
        phase,
        status,
        occurredAt: dependencies.now(),
        ...(connector === undefined ? {} : { connectorId: connector }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      });
    } catch {
      // UI observers are non-owning and must never become part of the setup transaction.
    }
  }

  async function beginPhase(state: SetupJournal, phase: string): Promise<void> {
    state.phase = phase;
    state.updatedAt = dependencies.now();
    stateStore.write(state);
    await progress(state, phase, 'started');
  }

  async function completePhase(state: SetupJournal, phase: string): Promise<void> {
    if (!state.completedPhases.includes(phase)) state.completedPhases.push(phase);
    state.updatedAt = dependencies.now();
    stateStore.write(state);
    await progress(state, phase, 'completed');
  }

  async function failPhase(state: SetupJournal, phase: string, error: unknown): Promise<string> {
    const diagnostic = redactDiagnostic(error);
    state.phase = phase;
    if (diagnostic && !state.diagnostics.includes(diagnostic)) state.diagnostics.push(diagnostic);
    state.updatedAt = dependencies.now();
    stateStore.write(state);
    await progress(state, phase, 'failed', diagnostic);
    return diagnostic;
  }

  async function preflightConflicts(
    selected: SetupConnectorId[],
    decisions: Partial<Record<SetupConnectorId, ConflictDecision>>,
  ): Promise<SetupConflict[]> {
    const conflicts: SetupConflict[] = [];
    for (const id of selected) {
      const inspection = await dependencies.connectors[id].inspect();
      if (inspection.state === 'conflict' && decisions[id] !== 'replace') {
        conflicts.push({ connectorId: id, comparison: safeComparison(inspection.comparison) });
      }
    }
    return conflicts;
  }

  async function runBasePhases(state: SetupJournal): Promise<void> {
    try {
      if (!state.completedPhases.includes('runtime.install')) {
        await beginPhase(state, 'runtime.install');
        await dependencies.runtime.install();
        await completePhase(state, 'runtime.install');
      }
      if (!state.completedPhases.includes('service.install')) {
        await beginPhase(state, 'service.install');
        await dependencies.service.install();
        state.service.installed = true;
        state.service.running = true;
        await completePhase(state, 'service.install');
      }
      if (!state.completedPhases.includes('service.verify')) {
        await beginPhase(state, 'service.verify');
        await dependencies.service.verify();
        state.service.installed = true;
        state.service.running = true;
        state.service.verified = true;
        await completePhase(state, 'service.verify');
      }
    } catch (error) {
      await failPhase(state, state.phase, error);
      await dependencies.service.rollback().catch(() => undefined);
      await dependencies.runtime.rollback().catch(() => undefined);
      state.completedPhases = state.completedPhases.filter(
        (phase) =>
          phase !== 'runtime.install' &&
          phase !== 'service.install' &&
          phase !== 'service.verify' &&
          phase !== 'login-item.register',
      );
      state.service = { installed: false, running: false, verified: false };
      state.loginItem = 'pending';
      state.status = 'failed';
      state.updatedAt = dependencies.now();
      stateStore.write(state);
      throw error;
    }

    if (!state.completedPhases.includes('login-item.register')) {
      await beginPhase(state, 'login-item.register');
      try {
        state.loginItem = await dependencies.loginItem.register();
        await completePhase(state, 'login-item.register');
      } catch (error) {
        await failPhase(state, 'login-item.register', error);
        state.loginItem = 'denied';
      }
    }
  }

  function connectorResult(state: SetupJournal, id: SetupConnectorId): SetupConnectorResult | null {
    return state.connectors.find((connector) => connector.id === id) ?? null;
  }

  function storeConnectorResult(state: SetupJournal, result: SetupConnectorResult): void {
    const index = state.connectors.findIndex((connector) => connector.id === result.id);
    if (index === -1) state.connectors.push(result);
    else state.connectors[index] = result;
    state.connectors.sort(
      (left, right) =>
        state.selectedConnectors.indexOf(left.id) - state.selectedConnectors.indexOf(right.id),
    );
    state.updatedAt = dependencies.now();
    stateStore.write(state);
  }

  async function runConnector(state: SetupJournal, id: SetupConnectorId): Promise<void> {
    const existing = connectorResult(state, id);
    let configured = existing?.configured ?? false;
    const connectPhase = `connector:${id}.connect`;
    const verifyPhase = `connector:${id}.verify`;
    try {
      if (!configured && !state.completedPhases.includes(connectPhase)) {
        await beginPhase(state, connectPhase);
        await dependencies.connectors[id].connect();
        configured = true;
        storeConnectorResult(state, {
          id,
          configured: true,
          available: false,
          newSessionRequired: false,
          state: 'verifying',
        });
        await completePhase(state, connectPhase);
      }
      if (!state.completedPhases.includes(verifyPhase)) {
        await beginPhase(state, verifyPhase);
        const verified = await dependencies.connectors[id].verify();
        if (!verified.available) throw new Error('The connector route is unavailable');
        storeConnectorResult(state, {
          id,
          configured,
          available: true,
          newSessionRequired: verified.newSessionRequired,
          state: 'connected',
        });
        await completePhase(state, verifyPhase);
      }
    } catch (error) {
      const diagnostic = await failPhase(state, state.phase, error);
      storeConnectorResult(state, {
        id,
        configured,
        available: false,
        newSessionRequired: false,
        state: 'needsRepair',
        ...(diagnostic ? { error: diagnostic } : {}),
      });
    }
  }

  async function execute(state: SetupJournal): Promise<SetupResult> {
    await runBasePhases(state);
    for (const id of state.selectedConnectors) await runConnector(state, id);
    state.status = state.connectors.some((connector) => !connector.available)
      ? 'partial'
      : 'complete';
    state.phase = state.status;
    state.updatedAt = dependencies.now();
    stateStore.write(state);
    return resultFromJournal(state);
  }

  return {
    async plan(input) {
      const selectedConnectors = selectedConnectorIds(input.selectedConnectors);
      const conflicts = await preflightConflicts(selectedConnectors, {});
      const operationId = randomUUID();
      const withoutRevision: Omit<SetupPlan, 'revision'> = {
        operationId,
        selectedConnectors,
        changes: [
          { kind: 'runtime', summary: 'Install the private Pimpampum runtime.' },
          { kind: 'service', summary: 'Install and verify the local Pimpampum service.' },
          { kind: 'login-item', summary: 'Register supported background startup.' },
          ...selectedConnectors.map((id) => ({
            kind: `connector:${id}`,
            summary: `Connect ${id === 'codex' ? 'Codex' : 'Claude Code'} to Pimpampum.`,
          })),
        ],
        conflicts,
        requiresConfirmation: true,
      };
      const plan = { ...withoutRevision, revision: planRevision(withoutRevision) };
      plans.set(operationId, plan);
      return plan;
    },

    async apply(input) {
      const plan = plans.get(input.operationId);
      if (plan === undefined || plan.revision !== input.expectedRevision) {
        throw new Error('Setup plan is missing, stale, or changed');
      }
      if (!input.confirmed) throw new Error('Setup requires explicit confirmation');
      const decisions = input.conflictDecisions ?? {};
      return dependencies.lifecycleLock.run(async () => {
        const existing = stateStore.read();
        if (existing?.status === 'running' && existing.operationId !== plan.operationId) {
          throw new Error(
            'Another durable setup operation must be resumed before applying a new plan',
          );
        }
        if (existing?.operationId === plan.operationId) {
          if (existing.revision !== plan.revision) {
            throw new Error('Durable setup journal revision does not match the reviewed plan');
          }
          if (existing.status === 'running' || existing.status === 'conflict') {
            existing.conflictDecisions = {
              ...existing.conflictDecisions,
              ...decisions,
            };
            const conflicts = await preflightConflicts(
              existing.selectedConnectors,
              existing.conflictDecisions,
            );
            if (conflicts.length > 0) {
              existing.status = 'conflict';
              existing.phase = 'conflict';
              existing.updatedAt = dependencies.now();
              stateStore.write(existing);
              return resultFromJournal(existing);
            }
            existing.status = 'running';
            existing.updatedAt = dependencies.now();
            stateStore.write(existing);
            return execute(existing);
          }
          return resultFromJournal(existing);
        }
        const conflicts = await preflightConflicts(plan.selectedConnectors, decisions);
        if (conflicts.length > 0) {
          return {
            status: 'conflict',
            service: { installed: false, running: false, verified: false },
            connectors: conflicts.map((conflict) => ({
              id: conflict.connectorId,
              configured: false,
              available: false,
              newSessionRequired: false,
              state: 'conflict',
            })),
            nextAction: 'resolve-conflict',
          };
        }
        const state = initialJournal(plan, decisions, dependencies.now());
        stateStore.write(state);
        return execute(state);
      });
    },

    async resume() {
      return dependencies.lifecycleLock.run(async () => {
        const state = stateStore.read();
        if (state === null) throw new Error('There is no durable setup operation to resume');
        if (state.status !== 'running' && state.status !== 'failed') {
          return resultFromJournal(state);
        }
        state.status = 'running';
        state.updatedAt = dependencies.now();
        stateStore.write(state);
        const conflicts = await preflightConflicts(
          state.selectedConnectors,
          state.conflictDecisions,
        );
        if (conflicts.length > 0) {
          state.status = 'conflict';
          state.phase = 'conflict';
          stateStore.write(state);
          return resultFromJournal(state);
        }
        return execute(state);
      });
    },

    async retryConnector(id) {
      if (!SETUP_CONNECTOR_IDS.includes(id)) throw new Error(`Unsupported connector: ${id}`);
      return dependencies.lifecycleLock.run(async () => {
        const state = stateStore.read();
        if (state === null || !state.selectedConnectors.includes(id)) {
          throw new Error('Connector is not part of the durable setup operation');
        }
        const existing = connectorResult(state, id);
        if (existing?.available) return resultFromJournal(state);
        state.completedPhases = state.completedPhases.filter(
          (phase) =>
            phase !== `connector:${id}.verify` &&
            (existing?.configured || phase !== `connector:${id}.connect`),
        );
        state.status = 'running';
        await runConnector(state, id);
        state.status = state.connectors.some((connector) => !connector.available)
          ? 'partial'
          : 'complete';
        state.phase = state.status;
        state.updatedAt = dependencies.now();
        stateStore.write(state);
        return resultFromJournal(state);
      });
    },
  };
}

function assertVersion(value: string): void {
  if (!value || value.length > 128 || value.includes('\0')) {
    throw new Error('Target version is invalid');
  }
}

export function createInstallationLifecycle(dependencies: InstallationLifecycleDependencies): {
  migrate(input: { targetVersion: string }): Promise<{ migrated: boolean; dataPreserved: boolean }>;
  update(input: {
    targetVersion: string;
  }): Promise<{ updated: boolean; connectorsPreserved: boolean }>;
  remove(): Promise<{ removed: boolean; dataPreserved: boolean; manualInstructions: string[] }>;
} {
  assertPrivatePath(dependencies.dataDirectory, 'Lifecycle data directory');
  assertPrivatePath(dependencies.homeDirectory, 'Lifecycle home directory');

  async function installTarget(targetVersion: string): Promise<void> {
    assertVersion(targetVersion);
    const previous = await dependencies.receipt.read();
    const connectorEntriesBefore = await dependencies.connectors.snapshotOwned();
    let serviceStopAttempted = false;
    let runtimeActivationAttempted = false;
    let commitAttempted = false;
    try {
      const staged = await dependencies.runtime.stage(targetVersion);
      if (staged.version !== targetVersion) throw new Error('Staged runtime version mismatch');
      assertPrivatePath(staged.nodePath, 'Staged Node path');
      assertPrivatePath(staged.cliPath, 'Staged CLI path');
      serviceStopAttempted = true;
      await dependencies.service.stop();
      runtimeActivationAttempted = true;
      await dependencies.runtime.activate(staged.version);
      await dependencies.service.install({ nodePath: staged.nodePath, cliPath: staged.cliPath });
      await dependencies.service.start();
      await dependencies.service.verify();
      await dependencies.connectors.reconcileOwned();
      const connectorEntries = await dependencies.connectors.snapshotOwned();
      commitAttempted = true;
      await dependencies.receipt.commit({
        runtimeVersion: staged.version,
        serviceCommand: [staged.nodePath, staged.cliPath],
        connectorEntries,
      });
    } catch (error) {
      if (runtimeActivationAttempted) {
        await dependencies.runtime.restore(previous.runtimeVersion).catch(() => undefined);
      }
      if (serviceStopAttempted) {
        await dependencies.service.restore(previous).catch(() => undefined);
      }
      if (serviceStopAttempted) {
        await dependencies.connectors.restoreOwned(connectorEntriesBefore).catch(() => undefined);
      }
      if (commitAttempted) await dependencies.receipt.commit(previous).catch(() => undefined);
      throw error;
    }
  }

  return {
    async migrate(input) {
      return dependencies.lifecycleLock.run(async () => {
        await installTarget(input.targetVersion);
        return { migrated: true, dataPreserved: true };
      });
    },
    async update(input) {
      return dependencies.lifecycleLock.run(async () => {
        await installTarget(input.targetVersion);
        return { updated: true, connectorsPreserved: true };
      });
    },
    async remove() {
      return dependencies.lifecycleLock.run(async () => {
        const previous = await dependencies.receipt.read();
        const connectorEntriesBefore = await dependencies.connectors.snapshotOwned();
        let receiptRemovalAttempted = false;
        try {
          await dependencies.service.stop();
          await dependencies.connectors.disconnectOwned();
          await dependencies.service.removeOwned();
          await dependencies.runtime.removeOwned();
          receiptRemovalAttempted = true;
          await dependencies.receipt.remove();
          return { removed: true, dataPreserved: true, manualInstructions: [] };
        } catch (error) {
          await dependencies.runtime.restore(previous.runtimeVersion).catch(() => undefined);
          await dependencies.service.restore(previous).catch(() => undefined);
          await dependencies.connectors.restoreOwned(connectorEntriesBefore).catch(() => undefined);
          if (receiptRemovalAttempted) {
            await dependencies.receipt.commit(previous).catch(() => undefined);
          }
          throw error;
        }
      });
    },
  };
}
