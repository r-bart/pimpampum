import {
  createHostConnectorCore,
  planHostConnection,
  type HostCommandResult,
  type HostConnectorDefinition,
  type HostConnectorIdentity,
  type HostEntryInspection,
  type RouteVerifier,
} from './core.js';
import { detectExecutable, runBoundedHostCommand } from './process.js';
import type {
  CommandInvocation,
  ConnectionPlan,
  ConnectionReceipt,
  ConnectorDetection,
  HostConnector,
  HostEntry,
} from './types.js';
import { verifyMcpRoute } from './verifier.js';

const CODEX_ID = 'codex' as const;
const CODEX_DISPLAY_NAME = 'Codex';
const CODEX_SCOPE = 'global' as const;
const SERVER_NAME = 'pimpampum';
const DEFAULT_TIMEOUT_MILLISECONDS = 2_000;

export const CODEX_LEGACY_ENTRIES: HostEntry[] = [
  { command: 'npx', arguments: ['pimpampum', 'mcp'], scope: CODEX_SCOPE },
];

export interface CodexConnectorDependencies {
  launcherPath: string;
  boundedLocations: string[];
  path: string;
  requiredTools: string[];
  expectedServerName?: string;
  timeoutMilliseconds?: number;
  now?: () => string;
  run?: (invocation: CommandInvocation) => Promise<HostCommandResult>;
  verify?: RouteVerifier;
  receipt: {
    read(): Promise<ConnectionReceipt | null>;
    write(receipt: ConnectionReceipt): Promise<void>;
    remove(): Promise<void>;
  };
}

interface CodexFeatureProbe {
  getJson: boolean;
  listJson: boolean;
  add: boolean;
  remove: boolean;
}

function codexIdentity(launcherPath: string): HostConnectorIdentity {
  return {
    id: CODEX_ID,
    displayName: CODEX_DISPLAY_NAME,
    scope: CODEX_SCOPE,
    launcherPath,
    legacyEntries: CODEX_LEGACY_ENTRIES,
    addInvocation: (executable, entry) => ({
      executable,
      arguments: ['mcp', 'add', SERVER_NAME, '--', entry.command, ...entry.arguments],
    }),
    removeInvocation: (executable) => ({ executable, arguments: ['mcp', 'remove', SERVER_NAME] }),
  };
}

/** Pure planning for Codex; the connector core applies the same rules at run time. */
export function planCodexConnection(input: {
  executable: string | null;
  supported: boolean;
  launcherPath: string;
  inspection: HostEntry | null;
  receipt: ConnectionReceipt | null;
  conflictDecision?: 'keep' | 'replace' | 'cancel';
  reviewedEntryFingerprint?: string;
}): ConnectionPlan {
  return planHostConnection(codexIdentity(input.launcherPath), {
    executable: input.executable,
    supported: input.supported,
    entry: input.inspection,
    higherPrecedenceEntry: null,
    receipt: input.receipt,
    ...(input.conflictDecision === undefined ? {} : { conflictDecision: input.conflictDecision }),
    ...(input.reviewedEntryFingerprint === undefined
      ? {}
      : { reviewedEntryFingerprint: input.reviewedEntryFingerprint }),
  });
}

function resultShape(value: unknown): HostCommandResult {
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

function unrestorable(command: string): HostEntry {
  return { command, arguments: [], scope: CODEX_SCOPE, restorable: false };
}

export function parseCodexMcpEntry(value: unknown): HostEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const transport = candidate.transport;
  if (typeof transport !== 'object' || transport === null) {
    return unrestorable('[unsupported Codex transport]');
  }
  const record = transport as Record<string, unknown>;
  if (record.type !== 'stdio' || typeof record.command !== 'string') {
    return unrestorable('[unsupported Codex transport]');
  }
  const arguments_ = parseStringArray(record.args);
  if (arguments_ === null) return unrestorable('[invalid Codex stdio entry]');
  if (
    record.env !== undefined &&
    record.env !== null &&
    (typeof record.env !== 'object' ||
      Array.isArray(record.env) ||
      Object.keys(record.env).length > 0)
  ) {
    return unrestorable('[Codex stdio entry with private environment]');
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
      typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === SERVER_NAME,
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
    parsed.name !== SERVER_NAME
  ) {
    throw new Error('Codex returned the wrong MCP entry');
  }
  return parseCodexMcpEntry(parsed);
}

export function createCodexConnector(dependencies: CodexConnectorDependencies): HostConnector {
  const timeoutMilliseconds = dependencies.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const run =
    dependencies.run ??
    ((invocation: CommandInvocation) => runBoundedHostCommand(invocation, { timeoutMilliseconds }));
  const invoke = async (invocation: CommandInvocation): Promise<HostCommandResult> =>
    resultShape(await run(invocation));

  // One feature probe per connector instance: detection and inspection read the same answer.
  let featureProbe: Promise<CodexFeatureProbe> | null = null;
  const probeFeatures = (executable: string): Promise<CodexFeatureProbe> =>
    (featureProbe ??= Promise.all(
      [
        ['mcp', 'get', '--help'],
        ['mcp', 'list', '--help'],
        ['mcp', 'add', '--help'],
        ['mcp', 'remove', '--help'],
      ].map((arguments_) => invoke({ executable, arguments: arguments_ })),
    )
      .then((probes) => ({
        getJson: probes[0]?.exitCode === 0 && /--json\b/u.test(probes[0].stdout),
        listJson: probes[1]?.exitCode === 0 && /--json\b/u.test(probes[1].stdout),
        add: probes[2]?.exitCode === 0,
        remove: probes[3]?.exitCode === 0,
      }))
      .catch(() => ({ getJson: false, listJson: false, add: false, remove: false })));

  const host: HostConnectorDefinition = {
    ...codexIdentity(dependencies.launcherPath),
    async detect(): Promise<ConnectorDetection> {
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
      const capabilities = await probeFeatures(detected.executable);
      return {
        connectorId: CODEX_ID,
        executable: detected.executable,
        version:
          detected.versionOutput === null ? null : detected.versionOutput.trim().slice(0, 80),
        supported:
          detected.supported &&
          (capabilities.getJson || capabilities.listJson) &&
          capabilities.add &&
          capabilities.remove,
        capabilities: {
          inspect: 'json',
          add: capabilities.add,
          remove: capabilities.remove,
          scopes: [CODEX_SCOPE],
        },
      };
    },
    async inspectEntry(detection): Promise<HostEntryInspection> {
      // The core only inspects a detected, supported host.
      const executable = detection.executable as string;
      const capabilities = await probeFeatures(executable);
      const neutral = { higherPrecedenceEntry: null, revision: null };
      if (capabilities.getJson) {
        const result = await invoke({
          executable,
          arguments: ['mcp', 'get', SERVER_NAME, '--json'],
        });
        if (result.exitCode === 0) return { ...neutral, entry: parseTargetFromGet(result.stdout) };
        if (/No MCP server named ['"]?pimpampum/iu.test(result.stderr)) {
          return { ...neutral, entry: null };
        }
        throw new Error('Codex could not inspect the Pimpampum MCP entry');
      }
      const result = await invoke({ executable, arguments: ['mcp', 'list', '--json'] });
      if (result.exitCode !== 0) throw new Error('Codex could not list MCP entries');
      return { ...neutral, entry: parseTargetFromList(result.stdout) };
    },
  };

  return createHostConnectorCore({
    host,
    receipt: dependencies.receipt,
    run: invoke,
    verify: dependencies.verify ?? verifyMcpRoute,
    requiredTools: dependencies.requiredTools,
    expectedServerName: dependencies.expectedServerName ?? SERVER_NAME,
    timeoutMilliseconds,
    now,
  });
}
