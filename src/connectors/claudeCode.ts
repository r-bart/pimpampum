import path from 'node:path';

import {
  detectExecutable,
  readHostConfiguration,
  runBoundedHostCommand,
  type BoundedCommandResult,
} from './process.js';
import { classifyConnectorOwnership, fingerprintCommand } from './receipt.js';
import type {
  CommandInvocation,
  ConnectionPlan,
  ConnectionReceipt,
  ConnectorActionResult,
  ConnectorDetection,
  ConnectorInspection,
  ConnectorSnapshot,
  ConnectorVerification,
  HostConnector,
  HostEntry,
} from './types.js';
import { verifyMcpRoute } from './verifier.js';

const connectorId = 'claude-code' as const;
const serverName = 'pimpampum';
const defaultTimeoutMilliseconds = 5_000;
const legacyEntries: readonly HostEntry[] = [
  { command: 'npx', arguments: ['pimpampum', 'mcp'], scope: 'user' },
];
const opaqueConflictEntry: HostEntry = {
  command: '[unrecognized Claude Code entry]',
  arguments: [],
  scope: 'user',
  restorable: false,
};

export interface ClaudeCodePlanInput {
  executable: string | null;
  supported: boolean;
  launcherPath: string;
  inspection: HostEntry | null;
  higherPrecedenceEntry: HostEntry | null;
  receipt: ConnectionReceipt | null;
  conflictDecision?: 'keep' | 'replace' | 'cancel';
  reviewedEntryFingerprint?: string;
}

export interface ClaudeCodeReceiptStore {
  read(): Promise<ConnectionReceipt | null>;
  write(receipt: ConnectionReceipt): Promise<void>;
  remove(): Promise<void>;
}

export interface ClaudeCodeConfigSource {
  path: string;
  scope: 'project' | 'local';
}

export interface ClaudeCodeConnectorOptions {
  launcherPath: string;
  userConfigPath: string;
  receiptStore: ClaudeCodeReceiptStore;
  boundedExecutableLocations?: readonly string[];
  pathValue?: string;
  higherPrecedenceConfigSources?: readonly ClaudeCodeConfigSource[];
  timeoutMilliseconds?: number;
  now?: () => string;
  runCommand?: (invocation: CommandInvocation) => Promise<BoundedCommandResult>;
  verifyRoute?: () => Promise<ConnectorVerification>;
  requiredTools?: readonly string[];
}

interface InspectedTarget {
  entry: HostEntry | null;
  revision: string | null;
}

function assertAbsoluteExecutable(value: string, label: string): void {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute, NUL-free path`);
  }
}

function expectedEntry(launcherPath: string): HostEntry {
  return { command: launcherPath, arguments: [], scope: 'user' };
}

function addInvocation(executable: string, launcherPath: string): CommandInvocation {
  return {
    executable,
    arguments: [
      'mcp',
      'add-json',
      '--scope',
      'user',
      serverName,
      JSON.stringify({ type: 'stdio', command: launcherPath, args: [], env: {} }),
    ],
  };
}

function removeInvocation(executable: string): CommandInvocation {
  return {
    executable,
    arguments: ['mcp', 'remove', '--scope', 'user', serverName],
  };
}

function neutralPlan(state: ConnectorInspection['state'], summary: string): ConnectionPlan {
  return {
    connectorId,
    state,
    selectedByDefault: false,
    requiresConflictDecision: state === 'conflict',
    mutations: [],
    approvalPolicy: 'hostDefault',
    newSessionRequired: false,
    summary,
  };
}

export function planClaudeCodeConnection(input: ClaudeCodePlanInput): ConnectionPlan {
  assertAbsoluteExecutable(input.launcherPath, 'Claude Code launcher');

  if (input.executable === null) {
    return neutralPlan('notInstalled', 'Claude Code is not installed; no changes are planned.');
  }

  if (!input.supported) {
    return neutralPlan(
      'unsupportedVersion',
      'This Claude Code version does not expose the required MCP commands; no changes are planned.',
    );
  }
  assertAbsoluteExecutable(input.executable, 'Claude Code executable');

  if (input.higherPrecedenceEntry !== null) {
    return neutralPlan(
      'conflict',
      'A higher-precedence Claude Code MCP entry already uses the Pimpampum server name; explicit resolution is required.',
    );
  }

  const state = classifyConnectorOwnership({
    entry: input.inspection,
    receipt: input.receipt?.connectorId === connectorId ? input.receipt : null,
    expected: expectedEntry(input.launcherPath),
    recognizedLegacyEntries: [...legacyEntries],
  });

  if (state === 'conflict') {
    const plan = neutralPlan(
      state,
      'Claude Code already has a different MCP entry with this name; explicit resolution is required.',
    );
    const reviewedEntryFingerprint =
      input.inspection === null ? undefined : fingerprintCommand(input.inspection);
    if (
      input.conflictDecision === 'replace' &&
      input.inspection?.restorable !== false &&
      (input.reviewedEntryFingerprint === undefined ||
        input.reviewedEntryFingerprint === reviewedEntryFingerprint)
    ) {
      return {
        ...plan,
        conflictDecision: 'replace',
        ...(reviewedEntryFingerprint === undefined ? {} : { reviewedEntryFingerprint }),
        selectedByDefault: true,
        requiresConflictDecision: false,
        mutations: [
          removeInvocation(input.executable),
          addInvocation(input.executable, input.launcherPath),
        ],
        newSessionRequired: true,
        summary: 'Replace the reviewed Claude Code MCP entry and preserve it for rollback.',
      };
    }
    return {
      ...plan,
      ...(input.conflictDecision === undefined ? {} : { conflictDecision: input.conflictDecision }),
      ...(reviewedEntryFingerprint === undefined ? {} : { reviewedEntryFingerprint }),
      requiresConflictDecision: input.conflictDecision === undefined,
      summary:
        input.conflictDecision === 'replace'
          ? 'Claude Code entry cannot be restored safely through the official CLI; no changes are planned.'
          : plan.summary,
    };
  }

  if (state === 'equivalentUnowned') {
    return {
      ...neutralPlan(
        state,
        'Claude Code already has an equivalent MCP entry; verify it before adopting ownership.',
      ),
      selectedByDefault: true,
    };
  }

  if (state === 'ownedCurrent') {
    return {
      ...neutralPlan(state, 'The owned Claude Code MCP entry is already current.'),
      selectedByDefault: true,
    };
  }

  if (state === 'notConnected' || state === 'ownedStale') {
    return {
      connectorId,
      state,
      selectedByDefault: true,
      requiresConflictDecision: false,
      mutations:
        state === 'ownedStale'
          ? [
              removeInvocation(input.executable),
              addInvocation(input.executable, input.launcherPath),
            ]
          : [addInvocation(input.executable, input.launcherPath)],
      approvalPolicy: 'hostDefault',
      newSessionRequired: true,
      summary:
        state === 'ownedStale'
          ? 'The owned Claude Code MCP entry will be repaired through the Claude Code CLI.'
          : 'Pimpampum will be added to Claude Code through the Claude Code CLI.',
    };
  }

  return neutralPlan(state, 'Claude Code configuration is unavailable; no changes are planned.');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeArgument(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 16_384 && !value.includes('\0');
}

function parseTargetEntry(value: unknown, scope: HostEntry['scope']): HostEntry | null {
  if (value === undefined) return null;
  if (!isPlainRecord(value)) return { ...opaqueConflictEntry, scope };
  if (value.type !== undefined && value.type !== 'stdio') {
    return { ...opaqueConflictEntry, scope };
  }
  if (!isSafeArgument(value.command) || value.command.length === 0) {
    return { ...opaqueConflictEntry, scope };
  }
  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.length > 256 || !args.every(isSafeArgument)) {
    return { ...opaqueConflictEntry, scope };
  }
  if (value.env !== undefined) {
    if (!isPlainRecord(value.env) || Object.keys(value.env).length > 0) {
      return { ...opaqueConflictEntry, scope };
    }
  }
  return { command: value.command, arguments: [...args], scope };
}

function targetFromConfig(value: unknown, scope: HostEntry['scope']): HostEntry | null {
  if (!isPlainRecord(value)) return { ...opaqueConflictEntry, scope };
  const servers = value.mcpServers;
  if (servers === undefined) return null;
  if (!isPlainRecord(servers)) return { ...opaqueConflictEntry, scope };
  return parseTargetEntry(servers[serverName], scope);
}

function isMissingFile(error: unknown): boolean {
  return isPlainRecord(error) && error.code === 'ENOENT';
}

async function inspectConfigTarget(
  configPath: string,
  scope: HostEntry['scope'],
): Promise<InspectedTarget> {
  try {
    const configuration = await readHostConfiguration(configPath);
    return {
      entry: targetFromConfig(configuration.value, scope),
      revision: configuration.revision,
    };
  } catch (error) {
    if (isMissingFile(error)) return { entry: null, revision: null };
    throw error;
  }
}

function featureHelpSupports(result: BoundedCommandResult, token: string): boolean {
  return result.exitCode === 0 && `${result.stdout}\n${result.stderr}`.includes(token);
}

function firstOutputLine(result: BoundedCommandResult): string | null {
  const line = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line?.slice(0, 256) ?? null;
}

function createReceipt(
  launcherPath: string,
  previous: ConnectionReceipt | null,
  verification: ConnectorVerification,
  timestamp: string,
): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId,
    scope: 'user',
    commandFingerprint: fingerprintCommand(expectedEntry(launcherPath)),
    configuredAt: previous?.configuredAt ?? timestamp,
    lastVerifiedAt: verification.verifiedAt ?? timestamp,
    capabilities: ['bounded-config', 'add-json', 'remove', 'scope:user'],
  };
}

export function createClaudeCodeConnector(options: ClaudeCodeConnectorOptions): HostConnector {
  assertAbsoluteExecutable(options.launcherPath, 'Claude Code launcher');
  assertAbsoluteExecutable(options.userConfigPath, 'Claude Code user config');
  for (const source of options.higherPrecedenceConfigSources ?? []) {
    assertAbsoluteExecutable(source.path, 'Claude Code scoped config');
  }

  const timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
  const now = options.now ?? (() => new Date().toISOString());
  const run =
    options.runCommand ??
    ((invocation: CommandInvocation) => runBoundedHostCommand(invocation, { timeoutMilliseconds }));

  async function detect(): Promise<ConnectorDetection> {
    const detected = await detectExecutable({
      id: connectorId,
      names: ['claude'],
      boundedLocations: [...(options.boundedExecutableLocations ?? [])],
      path: options.pathValue ?? process.env.PATH ?? '',
      timeoutMilliseconds,
      run,
    });

    if (detected.executable === null) {
      return { connectorId, executable: null, version: null, supported: false, capabilities: null };
    }

    const executable = detected.executable;
    let probes: BoundedCommandResult[];
    try {
      probes = await Promise.all([
        run({ executable, arguments: ['--version'] }),
        run({ executable, arguments: ['mcp', 'get', '--help'] }),
        run({ executable, arguments: ['mcp', 'add-json', '--help'] }),
        run({ executable, arguments: ['mcp', 'add', '--help'] }),
        run({ executable, arguments: ['mcp', 'remove', '--help'] }),
      ]);
    } catch {
      return { connectorId, executable, version: null, supported: false, capabilities: null };
    }
    const [versionResult, getHelp, addJsonHelp, addHelp, removeHelp] = probes as [
      BoundedCommandResult,
      BoundedCommandResult,
      BoundedCommandResult,
      BoundedCommandResult,
      BoundedCommandResult,
    ];
    const canAdd =
      featureHelpSupports(addJsonHelp, '--scope') && featureHelpSupports(addHelp, '--scope');
    const canRemove = featureHelpSupports(removeHelp, '--scope');
    const canInspectJson = featureHelpSupports(getHelp, '--json');
    const version = firstOutputLine(versionResult);
    const recognizedVersion =
      version !== null && /^\d+\.\d+\.\d+(?: \(Claude Code\))?$/u.test(version);
    const supported = versionResult.exitCode === 0 && recognizedVersion && canAdd && canRemove;

    return {
      connectorId,
      executable,
      version: recognizedVersion ? version : null,
      supported,
      capabilities: {
        inspect: canInspectJson ? 'json' : 'boundedConfig',
        add: canAdd,
        remove: canRemove,
        scopes: canAdd && canRemove ? ['user'] : [],
      },
    };
  }

  async function inspectUserTarget(detection: ConnectorDetection): Promise<InspectedTarget> {
    if (detection.executable !== null && detection.capabilities?.inspect === 'json') {
      const result = await run({
        executable: detection.executable,
        arguments: ['mcp', 'get', serverName, '--json'],
      });
      if (result.exitCode === 0) {
        try {
          const parsed = JSON.parse(result.stdout) as unknown;
          return { entry: parseTargetEntry(parsed, 'user'), revision: null };
        } catch {
          // Fall through to the bounded target-only config reader.
        }
      }
    }
    return inspectConfigTarget(options.userConfigPath, 'user');
  }

  async function inspectWithDetection(detection: ConnectorDetection): Promise<ConnectorInspection> {
    if (detection.executable === null) {
      return {
        connectorId,
        state: 'notInstalled',
        entry: null,
        higherPrecedenceEntry: null,
        receipt: null,
      };
    }
    if (!detection.supported) {
      return {
        connectorId,
        state: 'unsupportedVersion',
        entry: null,
        higherPrecedenceEntry: null,
        receipt: null,
      };
    }

    try {
      const receipt = await options.receiptStore.read();
      if (receipt !== null && receipt.connectorId !== connectorId) {
        throw new Error('Unexpected connector receipt');
      }
      const user = await inspectUserTarget(detection);
      const orderedSources = [...(options.higherPrecedenceConfigSources ?? [])].sort(
        (left, right) => (left.scope === 'local' ? 0 : 1) - (right.scope === 'local' ? 0 : 1),
      );
      let higherPrecedenceEntry: HostEntry | null = null;
      for (const source of orderedSources) {
        const inspected = await inspectConfigTarget(source.path, source.scope);
        if (inspected.entry !== null) {
          higherPrecedenceEntry = inspected.entry;
          break;
        }
      }
      const state =
        higherPrecedenceEntry === null
          ? classifyConnectorOwnership({
              entry: user.entry,
              receipt,
              expected: expectedEntry(options.launcherPath),
              recognizedLegacyEntries: [...legacyEntries],
            })
          : 'conflict';
      return {
        connectorId,
        state,
        entry: user.entry,
        higherPrecedenceEntry,
        receipt,
      };
    } catch {
      return {
        connectorId,
        state: 'unavailable',
        entry: null,
        higherPrecedenceEntry: null,
        receipt: null,
      };
    }
  }

  async function inspect(): Promise<ConnectorInspection> {
    return inspectWithDetection(await detect());
  }

  async function planConnection(input?: {
    conflictDecision?: 'keep' | 'replace' | 'cancel';
    reviewedEntryFingerprint?: string;
  }): Promise<ConnectionPlan> {
    const detection = await detect();
    const inspection = await inspectWithDetection(detection);
    if (inspection.state === 'unavailable') {
      return neutralPlan(
        'unavailable',
        'Claude Code configuration could not be inspected safely; no changes are planned.',
      );
    }
    return planClaudeCodeConnection({
      executable: detection.executable,
      supported: detection.supported,
      launcherPath: options.launcherPath,
      inspection: inspection.entry,
      higherPrecedenceEntry: inspection.higherPrecedenceEntry,
      receipt: inspection.receipt,
      ...(input?.conflictDecision === undefined
        ? {}
        : { conflictDecision: input.conflictDecision }),
      ...(input?.reviewedEntryFingerprint === undefined
        ? {}
        : { reviewedEntryFingerprint: input.reviewedEntryFingerprint }),
    });
  }

  async function verify(): Promise<ConnectorVerification> {
    if (options.verifyRoute) return options.verifyRoute();
    const result = await verifyMcpRoute({
      command: options.launcherPath,
      arguments: [],
      expectedServerName: serverName,
      requiredTools: [...(options.requiredTools ?? ['project_list', 'work_start'])],
      timeoutMilliseconds,
    });
    return {
      connectorId,
      available: result.available,
      verifiedAt: now(),
      serverName: result.serverName,
      tools: result.tools,
      diagnostics: result.diagnostics,
    };
  }

  async function runMutation(invocation: CommandInvocation): Promise<void> {
    assertAbsoluteExecutable(invocation.executable, 'Claude Code executable');
    const result = await run(invocation);
    if (result.exitCode !== 0) {
      throw new Error('Claude Code CLI mutation failed');
    }
  }

  async function restoreUnchecked(
    snapshotValue: ConnectorSnapshot,
    executable: string,
  ): Promise<void> {
    if (snapshotValue.entry === null) {
      await runMutation(removeInvocation(executable));
      return;
    }
    if (snapshotValue.entry.restorable === false) {
      throw new Error('Claude Code cannot safely restore the reviewed MCP entry');
    }
    const current = await inspectConfigTarget(options.userConfigPath, 'user');
    if (
      current.entry !== null &&
      fingerprintCommand(current.entry) === fingerprintCommand(snapshotValue.entry)
    ) {
      return;
    }
    if (
      current.entry !== null &&
      fingerprintCommand(current.entry) !== fingerprintCommand(expectedEntry(options.launcherPath))
    ) {
      throw new Error('Claude Code MCP configuration changed concurrently; it was not replaced');
    }
    if (current.entry !== null) await runMutation(removeInvocation(executable));
    await runMutation({
      executable,
      arguments: [
        'mcp',
        'add-json',
        '--scope',
        'user',
        serverName,
        JSON.stringify({
          type: 'stdio',
          command: snapshotValue.entry.command,
          args: snapshotValue.entry.arguments,
          env: {},
        }),
      ],
    });
  }

  async function applyConnection(requestedPlan: ConnectionPlan): Promise<ConnectorActionResult> {
    const currentPlan = await planConnection(
      requestedPlan.conflictDecision === undefined
        ? {}
        : {
            conflictDecision: requestedPlan.conflictDecision,
            ...(requestedPlan.reviewedEntryFingerprint === undefined
              ? {}
              : { reviewedEntryFingerprint: requestedPlan.reviewedEntryFingerprint }),
          },
    );
    if (
      requestedPlan.connectorId !== connectorId ||
      JSON.stringify(requestedPlan) !== JSON.stringify(currentPlan)
    ) {
      throw new Error(
        'Claude Code MCP configuration changed after the connection plan was reviewed',
      );
    }
    if (
      currentPlan.state !== 'notConnected' &&
      currentPlan.state !== 'ownedStale' &&
      currentPlan.state !== 'ownedCurrent' &&
      currentPlan.state !== 'equivalentUnowned' &&
      !(currentPlan.state === 'conflict' && currentPlan.conflictDecision === 'replace')
    ) {
      return {
        connectorId,
        state: currentPlan.state,
        changed: false,
        verification: null,
      };
    }

    const before = await snapshot();
    const previous = await options.receiptStore.read();
    let changed = false;
    try {
      for (const mutation of currentPlan.mutations) {
        await runMutation(mutation);
        changed = true;
      }
      const configured = await inspectConfigTarget(options.userConfigPath, 'user');
      if (
        configured.entry === null ||
        fingerprintCommand(configured.entry) !==
          fingerprintCommand(expectedEntry(options.launcherPath))
      ) {
        throw new Error('Claude Code did not persist the expected MCP entry');
      }
      const verification = await verify();
      if (!verification.available) throw new Error('Pimpampum MCP verification failed');
      await options.receiptStore.write(
        createReceipt(options.launcherPath, previous, verification, now()),
      );
      return { connectorId, state: 'ownedCurrent', changed, verification };
    } catch (error) {
      const executable = currentPlan.mutations[0]?.executable;
      if (changed && executable !== undefined) {
        await restoreUnchecked(before, executable).catch(() => undefined);
      }
      if (previous === null) await options.receiptStore.remove().catch(() => undefined);
      else await options.receiptStore.write(previous).catch(() => undefined);
      throw error;
    }
  }

  async function disconnect(): Promise<ConnectorActionResult> {
    const detection = await detect();
    const current = await inspectWithDetection(detection);
    if (
      detection.executable === null ||
      !detection.supported ||
      (current.state !== 'ownedCurrent' && current.state !== 'ownedStale')
    ) {
      return { connectorId, state: current.state, changed: false, verification: null };
    }

    const before = await snapshot();
    try {
      await runMutation(removeInvocation(detection.executable));
      const after = await inspectConfigTarget(options.userConfigPath, 'user');
      if (after.entry !== null) throw new Error('Claude Code did not remove the owned MCP entry');
      await options.receiptStore.remove();
      return { connectorId, state: 'notConnected', changed: true, verification: null };
    } catch (error) {
      await restoreUnchecked(before, detection.executable).catch(() => undefined);
      throw error;
    }
  }

  async function snapshot(): Promise<ConnectorSnapshot> {
    const current = await inspectConfigTarget(options.userConfigPath, 'user');
    return { connectorId, entry: current.entry, revision: current.revision };
  }

  async function restore(snapshotValue: ConnectorSnapshot): Promise<void> {
    if (snapshotValue.connectorId !== connectorId) throw new Error('Snapshot connector mismatch');
    const detection = await detect();
    if (detection.executable === null || !detection.supported) {
      throw new Error('Claude Code CLI is unavailable for restore');
    }
    if (snapshotValue.entry === null) {
      const current = await inspectWithDetection(detection);
      if (current.state === 'notConnected') return;
      if (current.state !== 'ownedCurrent' && current.state !== 'ownedStale') {
        throw new Error('Refusing to remove an unowned Claude Code MCP entry during restore');
      }
      await runMutation(removeInvocation(detection.executable));
      return;
    }
    if (snapshotValue.entry.scope !== 'user') {
      throw new Error('Claude Code restore only supports user-scoped snapshots');
    }
    await restoreUnchecked(snapshotValue, detection.executable);
  }

  return {
    id: connectorId,
    displayName: 'Claude Code',
    detect,
    inspect,
    plan: planConnection,
    connect: applyConnection,
    repair: applyConnection,
    disconnect,
    verify,
    snapshot,
    restore,
  };
}
