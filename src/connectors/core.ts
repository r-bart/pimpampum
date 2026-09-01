import { isAbsolute } from 'node:path';
import { AppError } from '../errors.js';
import { classifyConnectorOwnership, fingerprintCommand } from './receipt.js';
import type {
  CommandInvocation,
  ConnectionPlan,
  ConnectionReceipt,
  ConnectorActionResult,
  ConnectorConflictDecision,
  ConnectorDetection,
  ConnectorId,
  ConnectorInspection,
  ConnectorSnapshot,
  ConnectorVerification,
  HostConnector,
  HostEntry,
  OwnedConnectorScope,
} from './types.js';
import type { McpRouteVerificationResult } from './verifier.js';

/**
 * The connector lifecycle — inspect, plan, connect, verify, disconnect, snapshot, restore and the
 * ownership receipt — lives here once. A host supplies only what differs between agents: how it is
 * detected, how its MCP entry is read, and the exact official CLI invocations that add or remove
 * the entry. Both hosts therefore share one `connect` contract (an unconnectable state throws a
 * typed error), one `inspect` error contract (a typed `unavailable` with a bounded diagnostic),
 * and one memoized detection per connector instance.
 */

const MAX_DIAGNOSTIC_LENGTH = 320;

export interface HostCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HostEntryInspection {
  entry: HostEntry | null;
  higherPrecedenceEntry: HostEntry | null;
  revision: string | null;
}

/** The static half of a host: everything the pure planner needs. */
export interface HostConnectorIdentity {
  readonly id: ConnectorId;
  readonly displayName: string;
  readonly scope: OwnedConnectorScope;
  readonly launcherPath: string;
  readonly legacyEntries: readonly HostEntry[];
  addInvocation(executable: string, entry: HostEntry): CommandInvocation;
  removeInvocation(executable: string): CommandInvocation;
}

/** The live half: probing the host and reading its configuration. */
export interface HostConnectorDefinition extends HostConnectorIdentity {
  readonly receiptCapabilities?: readonly string[];
  detect(): Promise<ConnectorDetection>;
  inspectEntry(detection: ConnectorDetection): Promise<HostEntryInspection>;
}

export interface ConnectionReceiptStore {
  read(): Promise<ConnectionReceipt | null>;
  write(receipt: ConnectionReceipt): Promise<void>;
  remove(): Promise<void>;
}

export type RouteVerifier = (input: {
  command: string;
  arguments: string[];
  timeoutMilliseconds: number;
  requiredTools: string[];
  expectedServerName: string;
}) => Promise<McpRouteVerificationResult>;

export interface HostConnectorCoreOptions {
  host: HostConnectorDefinition;
  receipt: ConnectionReceiptStore;
  run(invocation: CommandInvocation): Promise<HostCommandResult>;
  verify: RouteVerifier;
  requiredTools: readonly string[];
  expectedServerName: string;
  timeoutMilliseconds: number;
  now(): string;
}

export interface HostPlanInput {
  executable: string | null;
  supported: boolean;
  entry: HostEntry | null;
  higherPrecedenceEntry: HostEntry | null;
  receipt: ConnectionReceipt | null;
  conflictDecision?: ConnectorConflictDecision;
  reviewedEntryFingerprint?: string;
}

export function boundedDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'The operation failed';
  return raw
    .replace(/(?:authorization\s*:?\s*)?bearer\s+\S+/giu, '[credential redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/giu, '[credential redacted]')
    .replace(/\/Users\/[^/\s]+/gu, '~')
    .replace(/\/home\/[^/\s]+/gu, '~')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute, NUL-free path`);
  }
}

export function expectedHostEntry(host: HostConnectorIdentity): HostEntry {
  assertAbsolutePath(host.launcherPath, `The ${host.displayName} launcher`);
  return { command: host.launcherPath, arguments: [], scope: host.scope };
}

function sameEntry(left: HostEntry, right: HostEntry): boolean {
  return fingerprintCommand(left) === fingerprintCommand(right);
}

function neutralPlan(
  host: HostConnectorIdentity,
  state: ConnectionPlan['state'],
  summary: string,
): ConnectionPlan {
  return {
    connectorId: host.id,
    state,
    selectedByDefault: false,
    mutations: [],
    requiresConflictDecision: false,
    newSessionRequired: false,
    approvalPolicy: 'hostDefault',
    summary,
  };
}

/**
 * The one planner. It decides from the ownership classification alone; the host contributes the
 * invocations and its display name. A conflict is never pre-selected, and a replacement only
 * mutates when the official CLI can restore the reviewed entry and the reviewer saw this exact
 * entry.
 */
export function planHostConnection(
  host: HostConnectorIdentity,
  input: HostPlanInput,
): ConnectionPlan {
  const expected = expectedHostEntry(host);
  const name = host.displayName;
  if (input.executable === null) {
    return neutralPlan(host, 'notInstalled', `${name} is not installed. No changes will be made.`);
  }
  if (!input.supported) {
    return neutralPlan(
      host,
      'unsupportedVersion',
      `This ${name} version does not expose the required MCP commands. No changes will be made.`,
    );
  }
  assertAbsolutePath(input.executable, `The ${name} executable`);
  if (input.higherPrecedenceEntry !== null) {
    return {
      ...neutralPlan(
        host,
        'conflict',
        `A higher-precedence ${name} MCP entry already uses the Pimpampum server name. Remove it before connecting.`,
      ),
      requiresConflictDecision: true,
    };
  }
  const receipt = input.receipt?.connectorId === host.id ? input.receipt : null;
  const state = classifyConnectorOwnership({
    entry: input.entry,
    receipt,
    expected,
    recognizedLegacyEntries: [...host.legacyEntries],
  });
  const add = host.addInvocation(input.executable, expected);
  const remove = host.removeInvocation(input.executable);
  const selected = { ...neutralPlan(host, state, ''), selectedByDefault: true };
  if (state === 'notConnected') {
    return {
      ...selected,
      mutations: [add],
      newSessionRequired: true,
      summary: `Add the Pimpampum MCP entry to ${name}.`,
    };
  }
  if (state === 'ownedStale') {
    return {
      ...selected,
      mutations: [remove, add],
      newSessionRequired: true,
      summary: `Repair the receipt-owned ${name} MCP entry with the current private launcher.`,
    };
  }
  if (state === 'equivalentUnowned') {
    return {
      ...selected,
      summary: `Verify the equivalent ${name} MCP entry before adopting it.`,
    };
  }
  if (state === 'ownedCurrent') {
    return { ...selected, summary: `${name} is connected through the current private launcher.` };
  }
  // The classifier only reports a conflict for a present entry.
  const entry = input.entry as HostEntry;
  const reviewedEntryFingerprint = fingerprintCommand(entry);
  const decision = input.conflictDecision;
  if (decision === 'replace') {
    if (entry.restorable === false) {
      return {
        ...neutralPlan(
          host,
          'conflict',
          `The ${name} entry cannot be restored through the official CLI, so it is not replaced.`,
        ),
        conflictDecision: 'replace',
        reviewedEntryFingerprint,
      };
    }
    if (
      input.reviewedEntryFingerprint !== undefined &&
      input.reviewedEntryFingerprint !== reviewedEntryFingerprint
    ) {
      return {
        ...neutralPlan(
          host,
          'conflict',
          `The ${name} entry changed after it was reviewed. Inspect it again before replacing.`,
        ),
        conflictDecision: 'replace',
        reviewedEntryFingerprint,
        requiresConflictDecision: true,
      };
    }
    return {
      ...selected,
      conflictDecision: 'replace',
      reviewedEntryFingerprint,
      mutations: [remove, add],
      newSessionRequired: true,
      summary: `Replace the reviewed ${name} MCP entry and preserve it for rollback.`,
    };
  }
  return {
    ...neutralPlan(
      host,
      'conflict',
      `${name} already has a different entry named pimpampum. Review it before replacing.`,
    ),
    ...(decision === undefined ? {} : { conflictDecision: decision }),
    reviewedEntryFingerprint,
    requiresConflictDecision: decision === undefined,
  };
}

function planInput(
  plan: ConnectionPlan,
): Pick<HostPlanInput, 'conflictDecision' | 'reviewedEntryFingerprint'> {
  return {
    ...(plan.conflictDecision === undefined ? {} : { conflictDecision: plan.conflictDecision }),
    ...(plan.reviewedEntryFingerprint === undefined
      ? {}
      : { reviewedEntryFingerprint: plan.reviewedEntryFingerprint }),
  };
}

function connectable(plan: ConnectionPlan): boolean {
  return (
    plan.mutations.length > 0 || plan.state === 'ownedCurrent' || plan.state === 'equivalentUnowned'
  );
}

function unconnectable(name: string, plan: ConnectionPlan): AppError {
  if (plan.state === 'conflict') {
    return new AppError(
      'conflict',
      plan.conflictDecision === 'replace'
        ? `The reviewed ${name} entry cannot be replaced: ${plan.summary}`
        : `The existing ${name} entry requires an explicit replacement decision`,
      409,
      false,
      { connectorId: plan.connectorId, state: plan.state },
    );
  }
  return new AppError(
    'invalid_state',
    `${name} cannot be connected from its current state: ${plan.summary}`,
    409,
    false,
    { connectorId: plan.connectorId, state: plan.state },
  );
}

export function createHostConnectorCore(options: HostConnectorCoreOptions): HostConnector {
  const { host, receipt: receipts, run, verify, now, timeoutMilliseconds } = options;
  const expected = expectedHostEntry(host);
  let detection: Promise<ConnectorDetection> | null = null;

  const detect = (): Promise<ConnectorDetection> => (detection ??= host.detect());

  const hostFailure = (message: string, cause?: unknown): AppError => {
    const error = new AppError(
      'unavailable',
      cause === undefined ? message : `${message}: ${boundedDiagnostic(cause)}`,
      503,
      false,
      { connectorId: host.id },
    );
    if (cause !== undefined) error.cause = cause;
    return error;
  };

  /** Every read of the host entry surfaces a failure as one typed, bounded `unavailable`. */
  const readEntry = async (detected: ConnectorDetection): Promise<HostEntryInspection> => {
    try {
      return await host.inspectEntry(detected);
    } catch (error) {
      throw hostFailure(`${host.displayName} configuration could not be inspected`, error);
    }
  };

  const invoke = async (invocation: CommandInvocation, action: string): Promise<void> => {
    assertAbsolutePath(invocation.executable, `The ${host.displayName} executable`);
    const result = await run(invocation);
    if (result.exitCode !== 0) {
      throw hostFailure(
        `${host.displayName} could not ${action} the Pimpampum MCP entry`,
        new Error(result.stderr.trim() || `exit code ${result.exitCode}`),
      );
    }
  };

  interface Inspected extends ConnectorInspection {
    revision: string | null;
    detection: ConnectorDetection;
  }

  const inspectWith = async (detected: ConnectorDetection): Promise<Inspected> => {
    const base = {
      connectorId: host.id,
      entry: null,
      entryFingerprint: null,
      higherPrecedenceEntry: null,
      receipt: null,
      revision: null,
      detection: detected,
    };
    if (detected.executable === null) return { ...base, state: 'notInstalled' };
    if (!detected.supported) return { ...base, state: 'unsupportedVersion' };
    let receipt: ConnectionReceipt | null;
    try {
      receipt = await receipts.read();
      if (receipt !== null && receipt.connectorId !== host.id) {
        throw new Error(`the stored receipt belongs to ${receipt.connectorId}`);
      }
    } catch (error) {
      throw hostFailure(`${host.displayName} ownership receipt could not be read`, error);
    }
    const inspected = await readEntry(detected);
    const state =
      inspected.higherPrecedenceEntry === null
        ? classifyConnectorOwnership({
            entry: inspected.entry,
            receipt,
            expected,
            recognizedLegacyEntries: [...host.legacyEntries],
          })
        : 'conflict';
    return {
      ...base,
      state,
      entry: inspected.entry,
      entryFingerprint: inspected.entry === null ? null : fingerprintCommand(inspected.entry),
      higherPrecedenceEntry: inspected.higherPrecedenceEntry,
      receipt,
      revision: inspected.revision,
    };
  };

  const inspect = async (): Promise<ConnectorInspection> => {
    const {
      revision: _revision,
      detection: _detection,
      ...inspection
    } = await inspectWith(await detect());
    return inspection;
  };

  const planWith = (
    inspection: Inspected,
    input?: Pick<HostPlanInput, 'conflictDecision' | 'reviewedEntryFingerprint'>,
  ): ConnectionPlan =>
    planHostConnection(host, {
      executable: inspection.detection.executable,
      supported: inspection.detection.supported,
      entry: inspection.entry,
      higherPrecedenceEntry: inspection.higherPrecedenceEntry,
      receipt: inspection.receipt,
      ...(input?.conflictDecision === undefined
        ? {}
        : { conflictDecision: input.conflictDecision }),
      ...(input?.reviewedEntryFingerprint === undefined
        ? {}
        : { reviewedEntryFingerprint: input.reviewedEntryFingerprint }),
    });

  const plan = async (
    input?: Pick<HostPlanInput, 'conflictDecision' | 'reviewedEntryFingerprint'>,
  ): Promise<ConnectionPlan> => planWith(await inspectWith(await detect()), input);

  const runVerification = async (): Promise<{
    verifiedAt: string;
    verification: ConnectorVerification;
  }> => {
    const verifiedAt = now();
    const result = await verify({
      command: host.launcherPath,
      arguments: [],
      timeoutMilliseconds,
      requiredTools: [...options.requiredTools],
      expectedServerName: options.expectedServerName,
    });
    return {
      verifiedAt,
      verification: {
        connectorId: host.id,
        available: result.available,
        verifiedAt,
        serverName: result.serverName,
        tools: result.tools,
        diagnostics: result.diagnostics,
      },
    };
  };

  const verifyRoute = async (): Promise<ConnectorVerification> =>
    (await runVerification()).verification;

  const snapshotOf = (inspection: Inspected): ConnectorSnapshot => ({
    connectorId: host.id,
    revision: inspection.revision,
    entry: inspection.entry,
  });

  /**
   * Puts the host entry back to `snapshot`. It refuses to touch an entry that is neither absent,
   * the snapshot itself, nor the launcher this connector just wrote: rollback must never remove a
   * third party's configuration.
   */
  const restore = async (snapshot: ConnectorSnapshot): Promise<void> => {
    if (snapshot.connectorId !== host.id) throw new Error('Snapshot connector mismatch');
    const detected = await detect();
    if (detected.executable === null || !detected.supported) {
      throw hostFailure(`${host.displayName} is unavailable while restoring its MCP entry`);
    }
    const current = (await readEntry(detected)).entry;
    if (current !== null && snapshot.entry !== null && sameEntry(current, snapshot.entry)) return;
    if (current !== null && !sameEntry(current, expected)) {
      throw new AppError(
        'conflict',
        `${host.displayName} MCP configuration changed concurrently; it was not replaced`,
        409,
        false,
        { connectorId: host.id },
      );
    }
    if (current !== null) await invoke(host.removeInvocation(detected.executable), 'remove');
    if (snapshot.entry === null) return;
    if (snapshot.entry.restorable === false || snapshot.entry.scope !== host.scope) {
      throw new AppError(
        'conflict',
        `${host.displayName} cannot safely restore the reviewed MCP entry`,
        409,
        false,
        { connectorId: host.id },
      );
    }
    await invoke(host.addInvocation(detected.executable, snapshot.entry), 'restore');
  };

  const connect = async (requested: ConnectionPlan): Promise<ConnectorActionResult> => {
    if (requested.connectorId !== host.id) {
      throw new AppError(
        'bad_request',
        `The connection plan is not for ${host.displayName}`,
        400,
        false,
        { connectorId: host.id },
      );
    }
    const detected = await detect();
    const inspection = await inspectWith(detected);
    const current = planWith(inspection, planInput(requested));
    if (JSON.stringify(current) !== JSON.stringify(requested)) {
      throw new AppError(
        'conflict',
        `${host.displayName} MCP configuration changed after the connection plan was reviewed`,
        409,
        false,
        { connectorId: host.id },
      );
    }
    if (!connectable(current)) throw unconnectable(host.displayName, current);
    const before = snapshotOf(inspection);
    const previousReceipt = inspection.receipt;
    let changed = false;
    try {
      for (const mutation of current.mutations) {
        await invoke(mutation, 'update');
        changed = true;
      }
      const configured = (await readEntry(detected)).entry;
      if (configured === null || !sameEntry(configured, expected)) {
        throw hostFailure(`${host.displayName} did not persist the expected Pimpampum MCP entry`);
      }
      const { verifiedAt, verification } = await runVerification();
      if (!verification.available) {
        throw hostFailure('Pimpampum MCP verification failed through the installed launcher');
      }
      await receipts.write({
        schemaVersion: 1,
        connectorId: host.id,
        scope: host.scope,
        commandFingerprint: fingerprintCommand(expected),
        configuredAt: previousReceipt?.configuredAt ?? verifiedAt,
        lastVerifiedAt: verifiedAt,
        ...(host.receiptCapabilities === undefined
          ? {}
          : { capabilities: [...host.receiptCapabilities] }),
      });
      return { connectorId: host.id, state: 'ownedCurrent', changed, verification };
    } catch (error) {
      if (changed) await restore(before).catch(() => undefined);
      if (previousReceipt === null) await receipts.remove().catch(() => undefined);
      else await receipts.write(previousReceipt).catch(() => undefined);
      throw error;
    }
  };

  const disconnect = async (): Promise<ConnectorActionResult> => {
    const detected = await detect();
    const inspection = await inspectWith(detected);
    if (inspection.state !== 'ownedCurrent' && inspection.state !== 'ownedStale') {
      return { connectorId: host.id, state: inspection.state, changed: false, verification: null };
    }
    // Both owned states require a supported executable and a matching receipt.
    const executable = detected.executable as string;
    const previousReceipt = inspection.receipt as ConnectionReceipt;
    const before = snapshotOf(inspection);
    try {
      await invoke(host.removeInvocation(executable), 'remove');
      if ((await readEntry(detected)).entry !== null) {
        throw hostFailure(`${host.displayName} did not remove the owned Pimpampum MCP entry`);
      }
      await receipts.remove();
      return { connectorId: host.id, state: 'notConnected', changed: true, verification: null };
    } catch (error) {
      const errors: unknown[] = [error];
      try {
        await restore(before);
      } catch (restoreError) {
        errors.push(restoreError);
      }
      try {
        await receipts.write(previousReceipt);
      } catch (receiptError) {
        errors.push(receiptError);
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, `${host.displayName} disconnect and rollback failed`);
      }
      throw error;
    }
  };

  const snapshot = async (): Promise<ConnectorSnapshot> =>
    snapshotOf(await inspectWith(await detect()));

  return {
    id: host.id,
    displayName: host.displayName,
    detect,
    inspect,
    plan,
    connect,
    repair: connect,
    verify: verifyRoute,
    disconnect,
    snapshot,
    restore,
  };
}
