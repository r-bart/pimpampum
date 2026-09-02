import path from 'node:path';
import { z } from 'zod';
import {
  createHostConnectorCore,
  planHostConnection,
  type HostConnectorDefinition,
  type HostConnectorIdentity,
  type HostEntryInspection,
} from './core.js';
import {
  detectExecutable,
  readHostConfiguration,
  runBoundedHostCommand,
  type BoundedCommandResult,
} from './process.js';
import type {
  CommandInvocation,
  ConnectionPlan,
  ConnectionReceipt,
  ConnectorDetection,
  ConnectorVerification,
  HostConnector,
  HostEntry,
} from './types.js';
import { isRecord } from '../objects.js';
import { verifyMcpRoute } from './verifier.js';

const connectorId = 'claude-code' as const;
const displayName = 'Claude Code';
const serverName = 'pimpampum';
const ownedScope = 'user' as const;
const defaultTimeoutMilliseconds = 5_000;
const legacyEntries: readonly HostEntry[] = [
  { command: 'npx', arguments: ['pimpampum', 'mcp'], scope: ownedScope },
];
const receiptCapabilities = ['bounded-config', 'add-json', 'remove', 'scope:user'] as const;
const opaqueConflictEntry: HostEntry = {
  command: '[unrecognized Claude Code entry]',
  arguments: [],
  scope: ownedScope,
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

function claudeCodeIdentity(launcherPath: string): HostConnectorIdentity {
  return {
    id: connectorId,
    displayName,
    scope: ownedScope,
    launcherPath,
    legacyEntries,
    addInvocation: (executable, entry) => ({
      executable,
      arguments: [
        'mcp',
        'add-json',
        '--scope',
        ownedScope,
        serverName,
        JSON.stringify({ type: 'stdio', command: entry.command, args: entry.arguments, env: {} }),
      ],
    }),
    removeInvocation: (executable) => ({
      executable,
      arguments: ['mcp', 'remove', '--scope', ownedScope, serverName],
    }),
  };
}

/** Pure planning for Claude Code; the connector core applies the same rules at run time. */
export function planClaudeCodeConnection(input: ClaudeCodePlanInput): ConnectionPlan {
  assertAbsoluteExecutable(input.launcherPath, 'Claude Code launcher');
  return planHostConnection(claudeCodeIdentity(input.launcherPath), {
    executable: input.executable,
    supported: input.supported,
    entry: input.inspection,
    higherPrecedenceEntry: input.higherPrecedenceEntry,
    receipt: input.receipt,
    ...(input.conflictDecision === undefined ? {} : { conflictDecision: input.conflictDecision }),
    ...(input.reviewedEntryFingerprint === undefined
      ? {}
      : { reviewedEntryFingerprint: input.reviewedEntryFingerprint }),
  });
}

const safeArgument = (minimum: number): z.ZodString =>
  z
    .string()
    .min(minimum)
    .max(16_384)
    .refine((value) => !value.includes('\0'));
/** A stdio entry Pimpampum can restore byte for byte; anything else is an opaque conflict. */
const stdioTargetSchema = z
  .object({
    type: z.literal('stdio').optional(),
    command: safeArgument(1),
    args: z.array(safeArgument(0)).max(256).optional(),
    env: z.object({}).strict().optional(),
  })
  .loose();

function parseTargetEntry(value: unknown, scope: HostEntry['scope']): HostEntry | null {
  if (value === undefined) return null;
  const parsed = stdioTargetSchema.safeParse(value);
  if (!parsed.success) return { ...opaqueConflictEntry, scope };
  return { command: parsed.data.command, arguments: [...(parsed.data.args ?? [])], scope };
}

function targetFromConfig(value: unknown, scope: HostEntry['scope']): HostEntry | null {
  if (!isRecord(value)) return { ...opaqueConflictEntry, scope };
  const servers = value.mcpServers;
  if (servers === undefined) return null;
  if (!isRecord(servers)) return { ...opaqueConflictEntry, scope };
  return parseTargetEntry(servers[serverName], scope);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/** Reads one bounded configuration file and only the Pimpampum target inside it. */
function inspectConfigTarget(configPath: string, scope: HostEntry['scope']): InspectedTarget {
  try {
    const configuration = readHostConfiguration(configPath);
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

function firstOutputLine(output: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line?.slice(0, 256) ?? null;
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
  const orderedSources = [...(options.higherPrecedenceConfigSources ?? [])].sort(
    (left, right) => (left.scope === 'local' ? 0 : 1) - (right.scope === 'local' ? 0 : 1),
  );

  const host: HostConnectorDefinition = {
    ...claudeCodeIdentity(options.launcherPath),
    receiptCapabilities,
    async detect(): Promise<ConnectorDetection> {
      const detected = await detectExecutable({
        id: connectorId,
        names: ['claude'],
        boundedLocations: [...(options.boundedExecutableLocations ?? [])],
        path: options.pathValue ?? process.env.PATH ?? '',
        timeoutMilliseconds,
        run,
      });
      if (detected.executable === null) {
        return {
          connectorId,
          executable: null,
          version: null,
          supported: false,
          capabilities: null,
        };
      }
      const executable = detected.executable;
      let probes: BoundedCommandResult[];
      try {
        probes = await Promise.all([
          run({ executable, arguments: ['mcp', 'get', '--help'] }),
          run({ executable, arguments: ['mcp', 'add-json', '--help'] }),
          run({ executable, arguments: ['mcp', 'add', '--help'] }),
          run({ executable, arguments: ['mcp', 'remove', '--help'] }),
        ]);
      } catch {
        return { connectorId, executable, version: null, supported: false, capabilities: null };
      }
      const [getHelp, addJsonHelp, addHelp, removeHelp] = probes as [
        BoundedCommandResult,
        BoundedCommandResult,
        BoundedCommandResult,
        BoundedCommandResult,
      ];
      const canAdd =
        featureHelpSupports(addJsonHelp, '--scope') && featureHelpSupports(addHelp, '--scope');
      const canRemove = featureHelpSupports(removeHelp, '--scope');
      const canInspectJson = featureHelpSupports(getHelp, '--json');
      // The version comes from the single `--version` probe detection already ran.
      const version =
        detected.versionOutput === null ? null : firstOutputLine(detected.versionOutput);
      const recognizedVersion =
        version !== null && /^\d+\.\d+\.\d+(?: \(Claude Code\))?$/u.test(version);
      return {
        connectorId,
        executable,
        version: recognizedVersion ? version : null,
        supported: detected.supported && recognizedVersion && canAdd && canRemove,
        capabilities: {
          inspect: canInspectJson ? 'json' : 'boundedConfig',
          add: canAdd,
          remove: canRemove,
          scopes: canAdd && canRemove ? [ownedScope] : [],
        },
      };
    },
    async inspectEntry(detection): Promise<HostEntryInspection> {
      let user: InspectedTarget | null = null;
      if (detection.executable !== null && detection.capabilities?.inspect === 'json') {
        const result = await run({
          executable: detection.executable,
          arguments: ['mcp', 'get', serverName, '--json'],
        });
        if (result.exitCode === 0) {
          try {
            const parsed = JSON.parse(result.stdout) as unknown;
            user = { entry: parseTargetEntry(parsed, ownedScope), revision: null };
          } catch {
            // Fall through to the bounded target-only config reader.
          }
        }
      }
      user ??= inspectConfigTarget(options.userConfigPath, ownedScope);
      let higherPrecedenceEntry: HostEntry | null = null;
      for (const source of orderedSources) {
        const inspected = inspectConfigTarget(source.path, source.scope);
        if (inspected.entry !== null) {
          higherPrecedenceEntry = inspected.entry;
          break;
        }
      }
      return { entry: user.entry, higherPrecedenceEntry, revision: user.revision };
    },
  };

  return createHostConnectorCore({
    host,
    receipt: options.receiptStore,
    run,
    verify: options.verifyRoute
      ? async () => {
          const verified = await options.verifyRoute!();
          return {
            available: verified.available,
            serverName: verified.serverName ?? '',
            tools: verified.tools,
            diagnostics: verified.diagnostics,
          };
        }
      : verifyMcpRoute,
    requiredTools: options.requiredTools ?? ['project_list', 'work_start'],
    expectedServerName: serverName,
    timeoutMilliseconds,
    now,
  });
}
