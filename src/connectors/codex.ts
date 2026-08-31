import { isAbsolute } from 'node:path';
import { detectExecutable, runBoundedHostCommand, type BoundedCommandResult } from './process.js';
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

const CODEX_ID = 'codex' as const;
const CODEX_DISPLAY_NAME = 'Codex';
const CODEX_SCOPE = 'global' as const;
const DEFAULT_TIMEOUT_MILLISECONDS = 2_000;

export const CODEX_LEGACY_ENTRIES: HostEntry[] = [
  { command: 'npx', arguments: ['pimpampum', 'mcp'], scope: CODEX_SCOPE },
];

interface CodexCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexConnectorDependencies {
  launcherPath: string;
  boundedLocations: string[];
  path: string;
  requiredTools: string[];
  expectedServerName?: string;
  timeoutMilliseconds?: number;
  now?: () => string;
  run?: (invocation: CommandInvocation) => Promise<CodexCommandResult>;
  verify?: typeof verifyMcpRoute;
  receipt: {
    read(): Promise<ConnectionReceipt | null>;
    write(receipt: ConnectionReceipt): Promise<void>;
    remove(): Promise<void>;
  };
}

function expectedEntry(launcherPath: string): HostEntry {
  if (!isAbsolute(launcherPath)) throw new Error('The Pimpampum MCP launcher must be absolute');
  return { command: launcherPath, arguments: [], scope: CODEX_SCOPE };
}

function basePlan(
  state: ConnectionPlan['state'],
  summary: string,
  selectedByDefault: boolean,
): ConnectionPlan {
  return {
    connectorId: CODEX_ID,
    state,
    selectedByDefault,
    mutations: [],
    requiresConflictDecision: false,
    newSessionRequired: false,
    approvalPolicy: 'hostDefault',
    summary,
  };
}

function addInvocation(executable: string, launcherPath: string): CommandInvocation {
  return {
    executable,
    arguments: ['mcp', 'add', 'pimpampum', '--', launcherPath],
  };
}

function removeInvocation(executable: string): CommandInvocation {
  return { executable, arguments: ['mcp', 'remove', 'pimpampum'] };
}

export function planCodexConnection(input: {
  executable: string | null;
  supported: boolean;
  launcherPath: string;
  inspection: HostEntry | null;
  receipt: ConnectionReceipt | null;
}): ConnectionPlan {
  const expected = expectedEntry(input.launcherPath);
  if (input.executable === null) {
    return basePlan('notInstalled', 'Codex is not installed. No changes will be made.', false);
  }
  if (!input.supported) {
    return basePlan(
      'unsupportedVersion',
      'This Codex version does not expose the required MCP commands. No changes will be made.',
      false,
    );
  }
  if (!isAbsolute(input.executable)) throw new Error('The Codex executable must be absolute');

  const state = classifyConnectorOwnership({
    entry: input.inspection,
    receipt: input.receipt,
    expected,
    recognizedLegacyEntries: CODEX_LEGACY_ENTRIES,
  });
  const plan = basePlan(state, 'Codex is ready to use the private Pimpampum MCP launcher.', true);
  if (state === 'notConnected') {
    return {
      ...plan,
      mutations: [addInvocation(input.executable, input.launcherPath)],
      newSessionRequired: true,
      summary: 'Add one global Pimpampum MCP entry to Codex.',
    };
  }
  if (state === 'ownedStale') {
    return {
      ...plan,
      mutations: [
        removeInvocation(input.executable),
        addInvocation(input.executable, input.launcherPath),
      ],
      newSessionRequired: true,
      summary: 'Repair the receipt-owned Codex MCP entry with the current private launcher.',
    };
  }
  if (state === 'equivalentUnowned') {
    return {
      ...plan,
      newSessionRequired: true,
      summary: 'Verify the equivalent Codex MCP entry before adopting it.',
    };
  }
  if (state === 'conflict') {
    return {
      ...plan,
      requiresConflictDecision: true,
      summary: 'Codex already has a different entry named pimpampum. Review it before replacing.',
    };
  }
  return { ...plan, summary: 'Codex is connected through the current private launcher.' };
}

function resultShape(value: unknown): CodexCommandResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('exitCode' in value) ||
    typeof value.exitCode !== 'number' ||
    !('stdout' in value) ||
    typeof value.stdout !== 'string' ||
    !('stderr' in value) ||
    typeof value.stderr !== 'string'
  ) {
    throw new Error('Codex returned an invalid bounded command result');
  }
  return { exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return [...value] as string[];
}

export function parseCodexMcpEntry(value: unknown): HostEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const transport = candidate.transport;
  if (typeof transport !== 'object' || transport === null) {
    return { command: '[unsupported Codex transport]', arguments: [], scope: CODEX_SCOPE };
  }
  const record = transport as Record<string, unknown>;
  if (record.type !== 'stdio' || typeof record.command !== 'string') {
    return { command: '[unsupported Codex transport]', arguments: [], scope: CODEX_SCOPE };
  }
  const arguments_ = parseStringArray(record.args);
  if (arguments_ === null) {
    return { command: '[invalid Codex stdio entry]', arguments: [], scope: CODEX_SCOPE };
  }
  return { command: record.command, arguments: arguments_, scope: CODEX_SCOPE };
}

function parseTargetFromList(stdout: string): HostEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error('Codex returned invalid JSON while inspecting MCP entries', { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error('Codex returned an invalid MCP list');
  const target = parsed.find(
    (entry) =>
      typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === 'pimpampum',
  );
  return target === undefined ? null : parseCodexMcpEntry(target);
}

function parseTargetFromGet(stdout: string): HostEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error('Codex returned invalid JSON for the Pimpampum MCP entry', { cause: error });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('name' in parsed) ||
    parsed.name !== 'pimpampum'
  ) {
    throw new Error('Codex returned the wrong MCP entry');
  }
  return parseCodexMcpEntry(parsed);
}

function verificationResult(
  result: Awaited<ReturnType<typeof verifyMcpRoute>>,
  verifiedAt: string,
): ConnectorVerification {
  return {
    connectorId: CODEX_ID,
    available: result.available,
    verifiedAt,
    serverName: result.serverName,
    tools: result.tools,
    diagnostics: result.diagnostics,
  };
}

export function createCodexConnector(dependencies: CodexConnectorDependencies): HostConnector {
  const timeoutMilliseconds = dependencies.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const run =
    dependencies.run ??
    (async (invocation: CommandInvocation) => {
      const result: BoundedCommandResult = await runBoundedHostCommand(invocation, {
        timeoutMilliseconds,
      });
      return result;
    });
  const verify = dependencies.verify ?? verifyMcpRoute;
  const expected = expectedEntry(dependencies.launcherPath);

  const invoke = async (invocation: CommandInvocation): Promise<CodexCommandResult> =>
    resultShape(await run(invocation));

  const featureProbe = async (
    executable: string,
  ): Promise<{ getJson: boolean; listJson: boolean; add: boolean; remove: boolean }> => {
    const probes = await Promise.all(
      [
        ['mcp', 'get', '--help'],
        ['mcp', 'list', '--help'],
        ['mcp', 'add', '--help'],
        ['mcp', 'remove', '--help'],
      ].map((arguments_) => invoke({ executable, arguments: arguments_ })),
    );
    return {
      getJson: probes[0]?.exitCode === 0 && /--json\b/u.test(probes[0].stdout),
      listJson: probes[1]?.exitCode === 0 && /--json\b/u.test(probes[1].stdout),
      add: probes[2]?.exitCode === 0,
      remove: probes[3]?.exitCode === 0,
    };
  };

  const detect = async (): Promise<ConnectorDetection> => {
    const detected = await detectExecutable({
      id: CODEX_ID,
      names: ['codex'],
      boundedLocations: dependencies.boundedLocations,
      path: dependencies.path,
      timeoutMilliseconds,
      run,
    });
    if (detected.executable === null) {
      return {
        connectorId: CODEX_ID,
        executable: null,
        version: null,
        supported: false,
        capabilities: null,
      };
    }
    const version = await invoke({ executable: detected.executable, arguments: ['--version'] });
    const capabilities = await featureProbe(detected.executable).catch(() => ({
      getJson: false,
      listJson: false,
      add: false,
      remove: false,
    }));
    const supported =
      detected.supported &&
      version.exitCode === 0 &&
      (capabilities.getJson || capabilities.listJson) &&
      capabilities.add &&
      capabilities.remove;
    return {
      connectorId: CODEX_ID,
      executable: detected.executable,
      version: version.exitCode === 0 ? version.stdout.trim().slice(0, 80) : null,
      supported,
      capabilities: {
        inspect: 'json',
        add: capabilities.add,
        remove: capabilities.remove,
        scopes: [CODEX_SCOPE],
      },
    };
  };

  const inspectEntry = async (executable: string): Promise<HostEntry | null> => {
    const capabilities = await featureProbe(executable);
    if (capabilities.getJson) {
      const result = await invoke({
        executable,
        arguments: ['mcp', 'get', 'pimpampum', '--json'],
      });
      if (result.exitCode === 0) return parseTargetFromGet(result.stdout);
      if (/No MCP server named ['"]?pimpampum/iu.test(result.stderr)) return null;
      throw new Error('Codex could not inspect the Pimpampum MCP entry');
    }
    if (capabilities.listJson) {
      const result = await invoke({ executable, arguments: ['mcp', 'list', '--json'] });
      if (result.exitCode !== 0) throw new Error('Codex could not list MCP entries');
      return parseTargetFromList(result.stdout);
    }
    throw new Error('This Codex version does not support bounded JSON MCP inspection');
  };

  const inspect = async (): Promise<ConnectorInspection> => {
    const detected = await detect();
    const receipt = await dependencies.receipt.read();
    if (detected.executable === null) {
      return {
        connectorId: CODEX_ID,
        state: 'notInstalled',
        entry: null,
        higherPrecedenceEntry: null,
        receipt,
      };
    }
    if (!detected.supported) {
      return {
        connectorId: CODEX_ID,
        state: 'unsupportedVersion',
        entry: null,
        higherPrecedenceEntry: null,
        receipt,
      };
    }
    const entry = await inspectEntry(detected.executable);
    return {
      connectorId: CODEX_ID,
      state: classifyConnectorOwnership({
        entry,
        receipt,
        expected,
        recognizedLegacyEntries: CODEX_LEGACY_ENTRIES,
      }),
      entry,
      higherPrecedenceEntry: null,
      receipt,
    };
  };

  const plan = async (): Promise<ConnectionPlan> => {
    const detected = await detect();
    const receipt = await dependencies.receipt.read();
    const entry =
      detected.executable !== null && detected.supported
        ? await inspectEntry(detected.executable)
        : null;
    return planCodexConnection({
      executable: detected.executable,
      supported: detected.supported,
      launcherPath: dependencies.launcherPath,
      inspection: entry,
      receipt,
    });
  };

  const verifyConnection = async (): Promise<ConnectorVerification> => {
    const verifiedAt = now();
    const result = await verify({
      command: dependencies.launcherPath,
      arguments: [],
      timeoutMilliseconds,
      requiredTools: dependencies.requiredTools,
      expectedServerName: dependencies.expectedServerName ?? 'pimpampum',
    });
    return verificationResult(result, verifiedAt);
  };

  const restore = async (snapshot: ConnectorSnapshot): Promise<void> => {
    const detected = await detect();
    if (detected.executable === null || !detected.supported) {
      throw new Error('Codex is unavailable while restoring its MCP entry');
    }
    const current = await inspectEntry(detected.executable);
    if (current !== null && fingerprintCommand(current) !== fingerprintCommand(expected)) {
      throw new Error('Codex MCP configuration changed concurrently; it was not replaced');
    }
    if (current !== null) {
      const removed = await invoke(removeInvocation(detected.executable));
      if (removed.exitCode !== 0) throw new Error('Codex could not restore its previous MCP entry');
    }
    if (snapshot.entry !== null) {
      const restored = await invoke({
        executable: detected.executable,
        arguments: [
          'mcp',
          'add',
          'pimpampum',
          '--',
          snapshot.entry.command,
          ...snapshot.entry.arguments,
        ],
      });
      if (restored.exitCode !== 0)
        throw new Error('Codex could not restore its previous MCP entry');
    }
  };

  const applyPlan = async (connectionPlan: ConnectionPlan): Promise<ConnectorActionResult> => {
    if (connectionPlan.connectorId !== CODEX_ID)
      throw new Error('The connection plan is not for Codex');
    const currentPlan = await plan();
    if (
      currentPlan.state !== connectionPlan.state ||
      JSON.stringify(currentPlan.mutations) !== JSON.stringify(connectionPlan.mutations)
    ) {
      throw new Error('Codex MCP configuration changed after the connection plan was reviewed');
    }
    connectionPlan = currentPlan;
    if (
      connectionPlan.state === 'notInstalled' ||
      connectionPlan.state === 'unsupportedVersion' ||
      connectionPlan.state === 'conflict' ||
      connectionPlan.state === 'unavailable'
    ) {
      throw new Error('Codex cannot be connected from its current state');
    }
    const detected = await detect();
    if (detected.executable === null || !detected.supported) {
      throw new Error('Codex became unavailable after the connection plan was reviewed');
    }
    const snapshot = await connector.snapshot();
    const previousReceipt = await dependencies.receipt.read();
    let changed = false;
    try {
      for (const mutation of connectionPlan.mutations) {
        const result = await invoke(mutation);
        if (result.exitCode !== 0) throw new Error('Codex rejected the Pimpampum MCP update');
        changed = true;
      }
      const configured = await inspectEntry(detected.executable);
      if (configured === null || fingerprintCommand(configured) !== fingerprintCommand(expected)) {
        throw new Error('Codex did not persist the expected Pimpampum MCP entry');
      }
      const verification = await verifyConnection();
      if (!verification.available) throw new Error('Pimpampum MCP verification failed');
      const configuredAt = previousReceipt?.configuredAt ?? now();
      await dependencies.receipt.write({
        schemaVersion: 1,
        connectorId: CODEX_ID,
        scope: CODEX_SCOPE,
        commandFingerprint: fingerprintCommand(expected),
        configuredAt,
        lastVerifiedAt: verification.verifiedAt,
      });
      return {
        connectorId: CODEX_ID,
        state: 'ownedCurrent',
        changed,
        verification,
      };
    } catch (error) {
      if (changed) await restore(snapshot).catch(() => undefined);
      if (previousReceipt === null) await dependencies.receipt.remove().catch(() => undefined);
      else await dependencies.receipt.write(previousReceipt).catch(() => undefined);
      throw error;
    }
  };

  const connector: HostConnector = {
    id: CODEX_ID,
    displayName: CODEX_DISPLAY_NAME,
    detect,
    inspect,
    plan,
    connect: applyPlan,
    verify: verifyConnection,
    repair: applyPlan,
    async disconnect() {
      const detected = await detect();
      const current = await inspect();
      if (
        detected.executable === null ||
        (current.state !== 'ownedCurrent' && current.state !== 'ownedStale')
      ) {
        return {
          connectorId: CODEX_ID,
          state: current.state,
          changed: false,
          verification: null,
        };
      }
      const result = await invoke(removeInvocation(detected.executable));
      if (result.exitCode !== 0)
        throw new Error('Codex could not remove the owned Pimpampum MCP entry');
      await dependencies.receipt.remove();
      return {
        connectorId: CODEX_ID,
        state: 'notConnected',
        changed: true,
        verification: null,
      };
    },
    async snapshot() {
      const current = await inspect();
      return { connectorId: CODEX_ID, revision: null, entry: current.entry };
    },
    restore,
  };
  return connector;
}
