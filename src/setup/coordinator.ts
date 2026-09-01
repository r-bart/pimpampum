import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createInstallationMigrationStateStore, createSetupStateStore } from './state.js';
import {
  SETUP_CONNECTOR_IDS,
  SETUP_SCHEMA_VERSION,
  type InstallationSnapshot,
  type InstallationMigrationJournal,
  type InstallationMigrationPhase,
  type InstallationMigrationStateStore,
  type InstallationReceiptCapture,
  type SetupConflict,
  type SetupConnectorId,
  type SetupConnectorResult,
  type SetupJournal,
  type SetupPlan,
  type SetupPlanStore,
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
      inspect(): Promise<{
        state: string;
        comparison?: string;
        revision?: string;
        replacementSupported?: boolean;
      }>;
      connect(input?: {
        conflictDecision?: ConflictDecision;
        reviewedEntryFingerprint?: string;
      }): Promise<void>;
      verify(): Promise<{ available: boolean; newSessionRequired: boolean }>;
      restore(): Promise<void>;
    }
  >;
  loginItem: { register(): Promise<'enabled' | 'requires-approval' | 'denied'> };
  /**
   * Where each disclosed change lands, and the address the service listens on. The plan names them
   * so the confirmation screen can state what it is about to touch instead of describing it in
   * prose. `requiresConfirmation` is only honest if the user can see this.
   */
  changeTargets: {
    runtimeDirectory: string;
    servicePath: string;
    dataDirectory: string;
    connectorConfigPaths: Partial<Record<SetupConnectorId, string>>;
  };
  dataDirectory: string;
  now(): string;
  onProgress?(event: SetupProgressEvent): void | Promise<void>;
  stateStore?: SetupStateStore;
  planStore?: SetupPlanStore;
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
    finalizeMigration?(previousVersion: string): Promise<void>;
    finalizeRemoval?(): Promise<void>;
  };
  service: {
    stop(): Promise<void>;
    install(input: { nodePath: string; cliPath: string }): Promise<void>;
    start(): Promise<void>;
    verify(): Promise<void>;
    restore(snapshot: InstallationSnapshot): Promise<void>;
    removeOwned(): Promise<void>;
    finalizeRemoval?(): Promise<void>;
  };
  connectors: {
    reconcileOwned(): Promise<void>;
    snapshotOwned(): Promise<Record<string, unknown>>;
    restoreOwned(entries: Record<string, unknown>): Promise<void>;
    planRemoval?(): Promise<{
      ownedEntries: Record<string, unknown>;
      unprovenConnectorIds: string[];
    }>;
    disconnectOwned(entries?: Record<string, unknown>): Promise<void>;
  };
  receipt: {
    read(): Promise<InstallationSnapshot>;
    commit(snapshot: InstallationSnapshot): Promise<void>;
    remove(): Promise<void>;
    capture?(): Promise<InstallationReceiptCapture>;
    restore?(capture: InstallationReceiptCapture): Promise<void>;
  };
  migrationStateStore?: InstallationMigrationStateStore;
  now?(): string;
}

function safeManualConnectorInstructions(connectorIds: readonly string[]): string[] {
  return [...new Set(connectorIds)]
    .filter((id) => /^[a-z0-9-]{1,64}$/u.test(id))
    .sort()
    .map(
      (id) =>
        `The ${id} entry was left unchanged because Pimpampum could not prove ownership. Review only the Pimpampum entry in that agent's settings.`,
    );
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
    reviewedConflictFingerprints: Object.fromEntries(
      plan.conflicts.flatMap((conflict) =>
        conflict.entryFingerprint === undefined
          ? []
          : [[conflict.connectorId, conflict.entryFingerprint]],
      ),
    ),
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
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>;
  }): Promise<SetupResult>;
  resume(input?: {
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>;
  }): Promise<SetupResult>;
  retryConnector(
    id: SetupConnectorId,
    onProgress?: (event: SetupProgressEvent) => void | Promise<void>,
  ): Promise<SetupResult>;
} {
  assertPrivatePath(dependencies.dataDirectory, 'Setup data directory');
  const stateStore = dependencies.stateStore ?? createSetupStateStore(dependencies.dataDirectory);
  const planStore = dependencies.planStore;
  const plans = new Map<string, SetupPlan>();
  const progressObservers = new Map<
    string,
    Set<(event: SetupProgressEvent) => void | Promise<void>>
  >();

  async function withProgressObserver<T>(
    operationId: string,
    observer: ((event: SetupProgressEvent) => void | Promise<void>) | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (observer === undefined) return operation();
    const observers = progressObservers.get(operationId) ?? new Set();
    observers.add(observer);
    progressObservers.set(operationId, observers);
    try {
      return await operation();
    } finally {
      observers.delete(observer);
      if (observers.size === 0) progressObservers.delete(operationId);
    }
  }

  async function progress(
    state: SetupJournal,
    phase: string,
    status: SetupProgressEvent['status'],
    diagnostic?: string,
  ): Promise<void> {
    const connector = /^connector:(codex|claude-code)\./u.exec(phase)?.[1] as
      SetupConnectorId | undefined;
    const event: SetupProgressEvent = {
      schemaVersion: SETUP_SCHEMA_VERSION,
      operationId: state.operationId,
      phase,
      status,
      occurredAt: dependencies.now(),
      ...(connector === undefined ? {} : { connectorId: connector }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
    const observers = [
      ...(dependencies.onProgress === undefined ? [] : [dependencies.onProgress]),
      ...(progressObservers.get(state.operationId) ?? []),
    ];
    try {
      await Promise.all(observers.map((observer) => observer(event)));
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
    state.completedPhases.push(phase);
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
    reviewed: Partial<Record<SetupConnectorId, string>> = {},
  ): Promise<SetupConflict[]> {
    const conflicts: SetupConflict[] = [];
    for (const id of selected) {
      const inspection = await dependencies.connectors[id].inspect();
      if (decisions[id] === 'replace' && inspection.replacementSupported === false) {
        conflicts.push({
          connectorId: id,
          comparison: 'The reviewed entry cannot be restored through the official host CLI.',
          ...(inspection.revision === undefined ? {} : { entryFingerprint: inspection.revision }),
        });
        continue;
      }
      if (
        decisions[id] === 'replace' &&
        reviewed[id] !== undefined &&
        (inspection.state !== 'conflict' || inspection.revision !== reviewed[id])
      ) {
        conflicts.push({
          connectorId: id,
          comparison: 'The connector entry changed after the replacement was reviewed.',
          entryFingerprint: reviewed[id],
        });
        continue;
      }
      if (
        inspection.state === 'conflict' &&
        decisions[id] !== 'replace' &&
        decisions[id] !== 'keep'
      ) {
        conflicts.push({
          connectorId: id,
          comparison: safeComparison(inspection.comparison),
          ...(inspection.revision === undefined ? {} : { entryFingerprint: inspection.revision }),
        });
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
      const rollbackErrors: unknown[] = [];
      let serviceRolledBack = false;
      try {
        await dependencies.service.rollback();
        serviceRolledBack = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        await dependencies.runtime.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      state.completedPhases = state.completedPhases.filter(
        (phase) =>
          phase !== 'runtime.install' &&
          phase !== 'service.install' &&
          phase !== 'service.verify' &&
          phase !== 'login-item.register',
      );
      for (const rollbackError of rollbackErrors) {
        const diagnostic = redactDiagnostic(rollbackError);
        if (diagnostic && !state.diagnostics.includes(diagnostic)) {
          state.diagnostics.push(diagnostic);
        }
      }
      state.service = {
        installed: !serviceRolledBack,
        running: false,
        verified: false,
      };
      state.loginItem = 'pending';
      state.status = 'failed';
      state.updatedAt = dependencies.now();
      stateStore.write(state);
      if (rollbackErrors.length > 0) {
        const message = redactDiagnostic(error) || 'Setup failed';
        throw new AggregateError(
          [error, ...rollbackErrors],
          `${message}; setup rollback was incomplete`,
        );
      }
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
    const conflictDecision = state.conflictDecisions[id];
    if (conflictDecision === 'keep') {
      storeConnectorResult(state, {
        id,
        configured: false,
        available: false,
        newSessionRequired: false,
        state: 'keptExisting',
      });
      return;
    }
    let configured = existing?.configured ?? false;
    const connectPhase = `connector:${id}.connect`;
    const verifyPhase = `connector:${id}.verify`;
    try {
      if (!configured && !state.completedPhases.includes(connectPhase)) {
        await beginPhase(state, connectPhase);
        await dependencies.connectors[id].connect(
          conflictDecision === undefined
            ? {}
            : {
                conflictDecision,
                ...(state.reviewedConflictFingerprints?.[id] === undefined
                  ? {}
                  : { reviewedEntryFingerprint: state.reviewedConflictFingerprints[id] }),
              },
        );
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
    state.status = state.connectors.some(
      (connector) => !connector.available && connector.state !== 'keptExisting',
    )
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
        // Summaries stay short and plain: the confirmation screen shows them as-is, and the
        // machinery behind each one belongs in its help sheet, not in the consent list.
        changes: [
          {
            kind: 'runtime',
            summary: 'Install everything Pimpampum needs to run.',
            path: dependencies.changeTargets.runtimeDirectory,
          },
          {
            kind: 'service',
            summary: 'Run Pimpampum in the background.',
            path: dependencies.changeTargets.servicePath,
          },
          {
            kind: 'data',
            summary: 'Keep your work on this Mac.',
            path: dependencies.changeTargets.dataDirectory,
          },
          { kind: 'login-item', summary: 'Start when you sign in.' },
          ...selectedConnectors.map((id) => {
            const connectorPath = dependencies.changeTargets.connectorConfigPaths[id];
            return {
              kind: `connector:${id}`,
              summary: `Connect ${id === 'codex' ? 'Codex' : 'Claude Code'}.`,
              ...(connectorPath === undefined ? {} : { path: connectorPath }),
            };
          }),
        ],
        conflicts,
        requiresConfirmation: true,
      };
      const plan = { ...withoutRevision, revision: planRevision(withoutRevision) };
      plans.set(operationId, plan);
      planStore?.write(plan);
      return plan;
    },

    async apply(input) {
      const persistedPlan = planStore?.read() ?? null;
      const plan =
        plans.get(input.operationId) ??
        (persistedPlan?.operationId === input.operationId ? persistedPlan : undefined);
      if (plan === undefined || plan.revision !== input.expectedRevision) {
        throw new Error('Setup plan is missing, stale, or changed');
      }
      if (!input.confirmed) throw new Error('Setup requires explicit confirmation');
      const decisions = input.conflictDecisions ?? {};
      return withProgressObserver(plan.operationId, input.onProgress, () =>
        dependencies.lifecycleLock.run(async () => {
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
                existing.reviewedConflictFingerprints,
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
          const conflicts = await preflightConflicts(
            plan.selectedConnectors,
            decisions,
            Object.fromEntries(
              plan.conflicts.flatMap((conflict) =>
                conflict.entryFingerprint === undefined
                  ? []
                  : [[conflict.connectorId, conflict.entryFingerprint]],
              ),
            ),
          );
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
        }),
      );
    },

    async resume(input) {
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
          state.reviewedConflictFingerprints,
        );
        if (conflicts.length > 0) {
          state.status = 'conflict';
          state.phase = 'conflict';
          stateStore.write(state);
          return resultFromJournal(state);
        }
        return withProgressObserver(state.operationId, input?.onProgress, () => execute(state));
      });
    },

    async retryConnector(id, onProgress) {
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
        await withProgressObserver(state.operationId, onProgress, () => runConnector(state, id));
        state.status = state.connectors.some(
          (connector) => !connector.available && connector.state !== 'keptExisting',
        )
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
  if (
    (dependencies.receipt.capture === undefined) !==
    (dependencies.receipt.restore === undefined)
  ) {
    throw new Error('Receipt capture and byte-preserving restore must be configured together');
  }
  const migrationStateStore =
    dependencies.migrationStateStore ??
    createInstallationMigrationStateStore(dependencies.dataDirectory);
  const now = dependencies.now ?? (() => new Date().toISOString());

  function validatePrevious(previous: InstallationSnapshot): void {
    assertVersion(previous.runtimeVersion);
    if (previous.serviceCommand.length < 2) {
      throw new Error('Existing service command is incomplete');
    }
    assertPrivatePath(previous.serviceCommand[0]!, 'Existing Node path');
    assertPrivatePath(previous.serviceCommand[1]!, 'Existing CLI path');
    if (
      previous.dataDirectory !== undefined &&
      previous.dataDirectory !== dependencies.dataDirectory
    ) {
      throw new Error('Installation receipt does not own the canonical data directory');
    }
    if (previous.adapter !== undefined && previous.adapter.length === 0) {
      throw new Error('Installation receipt adapter is invalid');
    }
  }

  function migrationAlreadyCommitted(
    current: InstallationSnapshot,
    journal: InstallationMigrationJournal,
  ): boolean {
    return (
      current.runtimeKind === 'packaged' &&
      current.runtimeVersion === journal.targetVersion &&
      current.serviceCommand[0] === journal.staged.nodePath &&
      current.serviceCommand[1] === journal.staged.cliPath &&
      (current.dataDirectory === undefined || current.dataDirectory === dependencies.dataDirectory)
    );
  }

  function writeMigrationPhase(
    journal: InstallationMigrationJournal,
    phase: InstallationMigrationPhase,
  ): void {
    journal.phase = phase;
    journal.updatedAt = now();
    migrationStateStore.write(journal);
  }

  async function restoreReceiptExactly(journal: InstallationMigrationJournal): Promise<void> {
    if (journal.previousReceiptBase64 !== undefined && dependencies.receipt.restore) {
      await dependencies.receipt.restore({
        snapshot: journal.previous,
        contents: Buffer.from(journal.previousReceiptBase64, 'base64'),
      });
      return;
    }
    await dependencies.receipt.commit(journal.previous);
  }

  async function rollbackMigration(
    journal: InstallationMigrationJournal,
    originalError?: unknown,
  ): Promise<void> {
    const errors: unknown[] = originalError === undefined ? [] : [originalError];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => dependencies.service.stop());
    await attempt(() => dependencies.runtime.restore(journal.previous.runtimeVersion));
    await attempt(() => dependencies.service.restore(journal.previous));
    await attempt(() => dependencies.connectors.restoreOwned(journal.connectorEntries));
    if (journal.phase === 'committing' || journal.phase === 'committed') {
      await attempt(() => restoreReceiptExactly(journal));
    }
    try {
      migrationStateStore.remove();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) return;
    if (errors.length === 1 && originalError !== undefined) throw originalError;
    const message =
      originalError instanceof Error ? originalError.message : 'Migration recovery failed';
    throw new AggregateError(errors, `${message}; installation rollback was incomplete`);
  }

  async function completeCommittedMigration(journal: InstallationMigrationJournal): Promise<void> {
    await dependencies.runtime.finalizeMigration?.(journal.previous.runtimeVersion);
    migrationStateStore.remove();
  }

  async function executeMigration(journal: InstallationMigrationJournal): Promise<void> {
    let committed = false;
    let mutationStarted = false;
    try {
      writeMigrationPhase(journal, 'stopping');
      mutationStarted = true;
      await dependencies.service.stop();
      writeMigrationPhase(journal, 'activating');
      await dependencies.runtime.activate(journal.staged.version);
      writeMigrationPhase(journal, 'installing');
      await dependencies.service.install({
        nodePath: journal.staged.nodePath,
        cliPath: journal.staged.cliPath,
      });
      writeMigrationPhase(journal, 'starting');
      await dependencies.service.start();
      writeMigrationPhase(journal, 'verifying');
      await dependencies.service.verify();
      writeMigrationPhase(journal, 'reconciling');
      await dependencies.connectors.reconcileOwned();
      const connectorEntries = await dependencies.connectors.snapshotOwned();
      writeMigrationPhase(journal, 'committing');
      await dependencies.receipt.commit({
        runtimeVersion: journal.staged.version,
        serviceCommand: [journal.staged.nodePath, journal.staged.cliPath],
        connectorEntries,
        ...(journal.previous.adapter === undefined ? {} : { adapter: journal.previous.adapter }),
        dataDirectory: dependencies.dataDirectory,
        runtimeKind: 'packaged',
      });
      committed = true;
      writeMigrationPhase(journal, 'committed');
      await completeCommittedMigration(journal);
    } catch (error) {
      if (committed) throw error;
      if (!mutationStarted) throw error;
      await rollbackMigration(journal, error);
    }
  }

  async function capturePreviousInstallation(): Promise<{
    previous: InstallationSnapshot;
    previousReceiptBase64?: string;
  }> {
    if (!dependencies.receipt.capture) {
      return { previous: await dependencies.receipt.read() };
    }
    const capture = await dependencies.receipt.capture();
    if (capture.contents.byteLength === 0 || capture.contents.byteLength > 700_000) {
      throw new Error('Installation receipt snapshot has an invalid migration size');
    }
    return {
      previous: capture.snapshot,
      previousReceiptBase64: Buffer.from(capture.contents).toString('base64'),
    };
  }

  async function migrateLegacyInstallation(targetVersion: string): Promise<boolean> {
    assertVersion(targetVersion);
    const existingJournal = migrationStateStore.read();
    if (existingJournal !== null) {
      validatePrevious(existingJournal.previous);
      assertVersion(existingJournal.targetVersion);
      if (existingJournal.staged.version !== existingJournal.targetVersion) {
        throw new Error('Durable migration runtime version does not match its target');
      }
      assertPrivatePath(existingJournal.staged.nodePath, 'Durable staged Node path');
      assertPrivatePath(existingJournal.staged.cliPath, 'Durable staged CLI path');
      if (existingJournal.targetVersion !== targetVersion) {
        throw new Error('Another installation migration must be recovered before changing target');
      }
      let current: InstallationSnapshot | null = null;
      try {
        current = await dependencies.receipt.read();
      } catch {
        // A torn receipt is recovered from the durable byte snapshot below.
      }
      if (current !== null && migrationAlreadyCommitted(current, existingJournal)) {
        await completeCommittedMigration(existingJournal);
        return false;
      }
      if (existingJournal.phase === 'staged') {
        await executeMigration(existingJournal);
        return true;
      }
      await rollbackMigration(existingJournal);
    }

    const captured = await capturePreviousInstallation();
    validatePrevious(captured.previous);
    if (captured.previous.runtimeKind === 'packaged') return false;

    const staged = await dependencies.runtime.stage(targetVersion);
    if (staged.version !== targetVersion) throw new Error('Staged runtime version mismatch');
    assertPrivatePath(staged.nodePath, 'Staged Node path');
    assertPrivatePath(staged.cliPath, 'Staged CLI path');
    const connectorEntries = await dependencies.connectors.snapshotOwned();
    const journal: InstallationMigrationJournal = {
      schemaVersion: SETUP_SCHEMA_VERSION,
      targetVersion,
      phase: 'staged',
      previous: captured.previous,
      ...(captured.previousReceiptBase64 === undefined
        ? {}
        : { previousReceiptBase64: captured.previousReceiptBase64 }),
      connectorEntries,
      staged,
      updatedAt: now(),
    };
    migrationStateStore.write(journal);
    await executeMigration(journal);
    return true;
  }

  async function installTarget(targetVersion: string): Promise<void> {
    assertVersion(targetVersion);
    const previous = await dependencies.receipt.read();
    validatePrevious(previous);
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
        ...(previous.adapter === undefined ? {} : { adapter: previous.adapter }),
        dataDirectory: dependencies.dataDirectory,
        runtimeKind: 'packaged',
      });
    } catch (error) {
      const rollbackErrors: unknown[] = [error];
      const attempt = async (operation: () => Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      };
      if (runtimeActivationAttempted) {
        await attempt(() => dependencies.runtime.restore(previous.runtimeVersion));
      }
      if (serviceStopAttempted) {
        await attempt(() => dependencies.service.restore(previous));
      }
      if (serviceStopAttempted) {
        await attempt(() => dependencies.connectors.restoreOwned(connectorEntriesBefore));
      }
      if (commitAttempted) await attempt(() => dependencies.receipt.commit(previous));
      if (rollbackErrors.length > 1) {
        const message = error instanceof Error ? error.message : 'Installation update failed';
        throw new AggregateError(
          rollbackErrors,
          `${message}; installation update rollback was incomplete`,
        );
      }
      throw error;
    }
  }

  return {
    async migrate(input) {
      return dependencies.lifecycleLock.run(async () => {
        const migrated = await migrateLegacyInstallation(input.targetVersion);
        return { migrated, dataPreserved: true };
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
        const captured = await capturePreviousInstallation();
        const previous = captured.previous;
        validatePrevious(previous);
        const removalPlan = dependencies.connectors.planRemoval
          ? await dependencies.connectors.planRemoval()
          : {
              ownedEntries: await dependencies.connectors.snapshotOwned(),
              unprovenConnectorIds: [],
            };
        const manualInstructions = safeManualConnectorInstructions(
          removalPlan.unprovenConnectorIds,
        );
        let connectorsAttempted = false;
        let runtimeRemovalAttempted = false;
        let receiptRemovalAttempted = false;
        try {
          await dependencies.service.stop();
          connectorsAttempted = true;
          await dependencies.connectors.disconnectOwned(removalPlan.ownedEntries);
          await dependencies.service.removeOwned();
          runtimeRemovalAttempted = true;
          await dependencies.runtime.removeOwned();
          receiptRemovalAttempted = true;
          await dependencies.receipt.remove();
          await dependencies.runtime.finalizeRemoval?.();
          await dependencies.service.finalizeRemoval?.();
          return { removed: true, dataPreserved: true, manualInstructions };
        } catch (error) {
          const rollbackErrors: unknown[] = [error];
          const attempt = async (operation: () => Promise<void>): Promise<void> => {
            try {
              await operation();
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          };
          if (runtimeRemovalAttempted) {
            await attempt(() => dependencies.runtime.restore(previous.runtimeVersion));
          }
          await attempt(() => dependencies.service.restore(previous));
          if (connectorsAttempted) {
            await attempt(() => dependencies.connectors.restoreOwned(removalPlan.ownedEntries));
          }
          if (receiptRemovalAttempted) {
            if (captured.previousReceiptBase64 !== undefined && dependencies.receipt.restore) {
              await attempt(() =>
                dependencies.receipt.restore!({
                  snapshot: previous,
                  contents: Buffer.from(captured.previousReceiptBase64!, 'base64'),
                }),
              );
            } else {
              await attempt(() => dependencies.receipt.commit(previous));
            }
          }
          if (rollbackErrors.length > 1) {
            const message = error instanceof Error ? error.message : 'Installation removal failed';
            throw new AggregateError(
              rollbackErrors,
              `${message}; installation removal rollback was incomplete`,
            );
          }
          throw error;
        }
      });
    },
  };
}
