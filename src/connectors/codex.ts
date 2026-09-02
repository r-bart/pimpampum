import { z } from 'zod';
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

const commandResultSchema = z
  .object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() })
  .loose();
const stdioTransportSchema = z.object({ type: z.literal('stdio'), command: z.string() }).loose();
const stdioArgumentsSchema = z.array(z.string());
/** Codex may carry an environment block only when it is absent or empty; anything else is private. */
const publicEnvironmentSchema = z.union([z.undefined(), z.null(), z.object({}).strict()]);
const mcpListSchema = z.array(z.unknown());
const namedEntrySchema = z.object({ name: z.literal(SERVER_NAME) }).loose();

function resultShape(value: unknown): HostCommandResult {
  const result = commandResultSchema.safeParse(value);
  if (!result.success) throw new Error('Codex returned an invalid bounded command result');
  const { exitCode, stdout, stderr } = result.data;
  return { exitCode, stdout, stderr };
}

function unrestorable(command: string): HostEntry {
  return { command, arguments: [], scope: CODEX_SCOPE, restorable: false };
}

export function parseCodexMcpEntry(value: unknown): HostEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const transport = stdioTransportSchema.safeParse((value as Record<string, unknown>).transport);
  if (!transport.success) return unrestorable('[unsupported Codex transport]');
  const arguments_ = stdioArgumentsSchema.safeParse(transport.data.args);
  if (!arguments_.success) return unrestorable('[invalid Codex stdio entry]');
  if (!publicEnvironmentSchema.safeParse(transport.data.env).success) {
    return unrestorable('[Codex stdio entry with private environment]');
  }
  return { command: transport.data.command, arguments: arguments_.data, scope: CODEX_SCOPE };
}

function parseTargetFromList(stdout: string): HostEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error('Codex returned invalid JSON while inspecting MCP entries', { cause: error });
  }
  const list = mcpListSchema.safeParse(parsed);
  if (!list.success) throw new Error('Codex returned an invalid MCP list');
  const target = list.data.find((entry) => namedEntrySchema.safeParse(entry).success);
  return target === undefined ? null : parseCodexMcpEntry(target);
}

function parseTargetFromGet(stdout: string): HostEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error('Codex returned invalid JSON for the Pimpampum MCP entry', { cause: error });
  }
  if (!namedEntrySchema.safeParse(parsed).success) {
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
