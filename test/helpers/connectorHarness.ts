import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi, type Mock } from 'vitest';
import {
  createClaudeCodeConnector,
  type ClaudeCodeConnectorOptions,
} from '../../src/connectors/claudeCode.js';
import {
  createCodexConnector,
  type CodexConnectorDependencies,
} from '../../src/connectors/codex.js';
import type { BoundedCommandResult } from '../../src/connectors/process.js';
import { fingerprintCommand } from '../../src/connectors/receipt.js';
import type {
  CommandInvocation,
  ConnectionReceipt,
  ConnectorVerification,
  HostEntry,
} from '../../src/connectors/types.js';
import { temporaryDirectory } from './tmp.js';

export type ConnectorHost = 'codex' | 'claude-code';

/** The absolute tokenless launcher every harness plans against. */
export const syntheticLauncher = '/synthetic/runtime/bin/pimpampum-mcp';

const hostScope = { codex: 'global', 'claude-code': 'user' } as const;

/** The entry the connector expects to own for `host`. */
export function expectedHostEntry(host: ConnectorHost): HostEntry {
  return { command: syntheticLauncher, arguments: [], scope: hostScope[host] };
}

/** A receipt proving ownership of `entry` (default: the expected entry) for `host`. */
export function connectorReceipt(
  host: ConnectorHost,
  entry: HostEntry = expectedHostEntry(host),
): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId: host,
    scope: hostScope[host],
    commandFingerprint: fingerprintCommand(entry),
    configuredAt: '2026-08-30T00:00:00.000Z',
    lastVerifiedAt: null,
  };
}

/** A verification result for `host`; available by default with the bounded `project_list` tool. */
export function connectorVerification(
  host: ConnectorHost,
  available = true,
  verifiedAt: string | null = '2026-08-31T00:00:00.000Z',
): ConnectorVerification {
  return {
    connectorId: host,
    available,
    verifiedAt,
    serverName: available ? 'pimpampum' : null,
    tools: available ? ['project_list'] : [],
    diagnostics: [],
  };
}

interface SharedHarnessOptions {
  /** Output of `<host> --version`. Default: a supported version. */
  version?: string;
  /** Make the `--help` feature probes throw. */
  probeFailure?: boolean;
  /** Make the named mutation exit non-zero. */
  mutationFailure?: 'add' | 'remove';
  /** Whether successful mutations change the fake host state. Default `true`. */
  persistMutations?: boolean;
  storedReceipt?: ConnectionReceipt | null;
}

export interface CodexHarnessOptions extends SharedHarnessOptions {
  /** The entry `codex mcp get pimpampum` reports. Default: none. */
  entry?: HostEntry | null;
  /** Whether `get` advertises `--json`. Default `true`. */
  getJson?: boolean;
  /** Whether `list` advertises `--json`. Default `false`. */
  listJson?: boolean;
  verificationAvailable?: boolean;
  receiptRemoveFailure?: boolean;
  receiptWriteFailure?: boolean;
}

export interface ClaudeHarnessOptions extends SharedHarnessOptions {
  /** The `mcpServers.pimpampum` value in the user config. Default: none. */
  target?: unknown;
  /** The whole user config value, when the test needs a shape other than `{mcpServers}`. */
  configValue?: unknown;
  /** Whether `claude mcp get` advertises `--json`. Default `false`. */
  inspectJson?: boolean;
  /** Fixed result for `claude mcp get`, bypassing the config file. */
  jsonResult?: { exitCode: number; stdout: string; stderr: string };
  versionExitCode?: number;
  verification?: ConnectorVerification;
  /** A `mcpServers.pimpampum` value in a higher-precedence project config. */
  higherPrecedenceTarget?: unknown;
}

interface SharedHarness {
  /** The temporary root holding the fake executable and configs. Removed after the test. */
  root: string;
  /** The fake host executable on the sanitized PATH. */
  executable: string;
  storedReceipt(): ConnectionReceipt | null;
  setPersistMutations(value: boolean): void;
  setMutationFailure(value: 'add' | 'remove' | undefined): void;
}

export interface CodexHarness extends SharedHarness {
  connector: ReturnType<typeof createCodexConnector>;
  run: Mock<(invocation: CommandInvocation) => Promise<CodexCommandResult>>;
  receiptStore: CodexConnectorDependencies['receipt'];
  entry(): HostEntry | null;
  setEntry(value: HostEntry | null): void;
}

export interface ClaudeHarness extends SharedHarness {
  connector: ReturnType<typeof createClaudeCodeConnector>;
  run: Mock<(invocation: CommandInvocation) => Promise<BoundedCommandResult>>;
  receiptStore: ClaudeCodeConnectorOptions['receiptStore'];
  configPath: string;
  readTarget(): unknown;
  writeTarget(target: unknown): void;
}

interface CodexCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function fakeHost(
  host: ConnectorHost,
  prefix: string,
): { root: string; bin: string; executable: string } {
  const root = temporaryDirectory(prefix);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, host === 'codex' ? 'codex' : 'claude');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, bin, executable };
}

function createCodexHarness(options: CodexHarnessOptions): CodexHarness {
  const { root, bin, executable } = fakeHost('codex', 'pimpampum-codex-harness-');
  let entry = options.entry === undefined ? null : options.entry;
  let storedReceipt = options.storedReceipt ?? null;
  let persistMutations = options.persistMutations ?? true;
  let mutationFailure = options.mutationFailure;
  const getJson = options.getJson ?? true;
  const listJson = options.listJson ?? false;
  const run = vi.fn(async (invocation: CommandInvocation): Promise<CodexCommandResult> => {
    const args = invocation.arguments;
    if (args[0] === '--version') {
      return { exitCode: 0, stdout: options.version ?? 'codex-cli 0.151.0', stderr: '' };
    }
    if (args.at(-1) === '--help') {
      if (options.probeFailure) throw new Error('synthetic feature probe failure');
      const feature = args[1];
      const supported =
        feature === 'get'
          ? getJson
          : feature === 'list'
            ? listJson
            : feature === 'add' || feature === 'remove';
      return {
        exitCode: supported ? 0 : 1,
        stdout: supported && (feature === 'get' || feature === 'list') ? '--json' : '',
        stderr: '',
      };
    }
    if (args[1] === 'get') {
      return entry === null
        ? { exitCode: 1, stdout: '', stderr: "No MCP server named 'pimpampum' found." }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              name: 'pimpampum',
              transport: {
                type: 'stdio',
                command: entry.command,
                args: entry.arguments,
                ...(entry.restorable === false ? { env: { PRIVATE: 'synthetic' } } : {}),
              },
            }),
            stderr: '',
          };
    }
    if (args[1] === 'list') {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          entry === null
            ? [{ name: 'unrelated', transport: { type: 'stdio', command: '/synthetic/other' } }]
            : [
                {
                  name: 'pimpampum',
                  transport: { type: 'stdio', command: entry.command, args: entry.arguments },
                },
              ],
        ),
        stderr: '',
      };
    }
    if (args[1] === 'remove') {
      if (mutationFailure === 'remove') return { exitCode: 9, stdout: '', stderr: 'rejected' };
      if (persistMutations) entry = null;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[1] === 'add') {
      if (mutationFailure === 'add') return { exitCode: 9, stdout: '', stderr: 'rejected' };
      if (persistMutations) {
        const separator = args.indexOf('--');
        entry = {
          command: args[separator + 1]!,
          arguments: args.slice(separator + 2),
          scope: 'global',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected Codex invocation: ${args.join(' ')}`);
  });
  const receiptStore: CodexConnectorDependencies['receipt'] = {
    read: vi.fn(async () => storedReceipt),
    write: vi.fn(async (value) => {
      if (options.receiptWriteFailure) throw new Error('synthetic receipt write failure');
      storedReceipt = value;
    }),
    remove: vi.fn(async () => {
      if (options.receiptRemoveFailure) throw new Error('synthetic receipt removal failure');
      storedReceipt = null;
    }),
  };
  const connector = createCodexConnector({
    launcherPath: syntheticLauncher,
    boundedLocations: [bin],
    path: bin,
    requiredTools: ['project_list'],
    run,
    now: () => '2026-08-31T00:00:00.000Z',
    verify: async () => ({
      available: options.verificationAvailable ?? true,
      serverName: 'pimpampum',
      tools: ['project_list'],
      diagnostics: [],
    }),
    receipt: receiptStore,
  });
  return {
    root,
    connector,
    executable,
    run,
    receiptStore,
    entry: () => entry,
    setEntry: (value) => {
      entry = value;
    },
    storedReceipt: () => storedReceipt,
    setPersistMutations: (value) => {
      persistMutations = value;
    },
    setMutationFailure: (value) => {
      mutationFailure = value;
    },
  };
}

function createClaudeHarness(options: ClaudeHarnessOptions): ClaudeHarness {
  const { root, bin, executable } = fakeHost('claude-code', 'pimpampum-claude-harness-');
  const configPath = join(root, '.claude.json');
  const initial =
    options.configValue === undefined
      ? { mcpServers: options.target === undefined ? {} : { pimpampum: options.target } }
      : options.configValue;
  writeFileSync(configPath, JSON.stringify(initial), { mode: 0o600 });
  const higherPath = join(root, 'project.json');
  if (options.higherPrecedenceTarget !== undefined) {
    writeFileSync(
      higherPath,
      JSON.stringify({ mcpServers: { pimpampum: options.higherPrecedenceTarget } }),
      { mode: 0o600 },
    );
  }
  let storedReceipt = options.storedReceipt ?? null;
  let persistMutations = options.persistMutations ?? true;
  let mutationFailure = options.mutationFailure;
  const readTarget = (): unknown => {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return parsed.mcpServers?.pimpampum;
  };
  const writeTarget = (target: unknown): void => {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const servers =
      typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null
        ? ({ ...parsed.mcpServers } as Record<string, unknown>)
        : {};
    if (target === undefined) delete servers.pimpampum;
    else servers.pimpampum = target;
    writeFileSync(configPath, JSON.stringify({ ...parsed, mcpServers: servers }), { mode: 0o600 });
  };
  const run = vi.fn(async (invocation: CommandInvocation): Promise<BoundedCommandResult> => {
    const args = invocation.arguments;
    if (args[0] === '--version') {
      return {
        exitCode: options.versionExitCode ?? 0,
        stdout: options.version ?? '2.1.251 (Claude Code)',
        stderr: '',
        signal: null,
      };
    }
    if (args.at(-1) === '--help') {
      if (options.probeFailure) throw new Error('synthetic feature probe failure');
      const feature = args[1];
      return {
        exitCode: 0,
        stdout: feature === 'get' && options.inspectJson ? '--json' : '--scope user',
        stderr: '',
        signal: null,
      };
    }
    if (args[1] === 'get') {
      if (options.jsonResult !== undefined) return { ...options.jsonResult, signal: null };
      const target = readTarget();
      return {
        exitCode: target === undefined ? 1 : 0,
        stdout: target === undefined ? '' : JSON.stringify(target),
        stderr: target === undefined ? 'not found' : '',
        signal: null,
      };
    }
    if (args[1] === 'remove') {
      if (mutationFailure === 'remove') {
        return { exitCode: 9, stdout: '', stderr: 'rejected', signal: null };
      }
      if (persistMutations) writeTarget(undefined);
      return { exitCode: 0, stdout: '', stderr: '', signal: null };
    }
    if (args[1] === 'add-json') {
      if (mutationFailure === 'add') {
        return { exitCode: 9, stdout: '', stderr: 'rejected', signal: null };
      }
      if (persistMutations) writeTarget(JSON.parse(args.at(-1)!) as unknown);
      return { exitCode: 0, stdout: '', stderr: '', signal: null };
    }
    throw new Error(`unexpected Claude invocation: ${args.join(' ')}`);
  });
  const receiptStore: ClaudeCodeConnectorOptions['receiptStore'] = {
    read: vi.fn(async () => storedReceipt),
    write: vi.fn(async (value) => {
      storedReceipt = value;
    }),
    remove: vi.fn(async () => {
      storedReceipt = null;
    }),
  };
  const connector = createClaudeCodeConnector({
    launcherPath: syntheticLauncher,
    userConfigPath: configPath,
    boundedExecutableLocations: [bin],
    pathValue: bin,
    ...(options.higherPrecedenceTarget === undefined
      ? {}
      : { higherPrecedenceConfigSources: [{ path: higherPath, scope: 'project' as const }] }),
    runCommand: run,
    now: () => '2026-08-31T01:00:00.000Z',
    verifyRoute: async () => options.verification ?? connectorVerification('claude-code'),
    receiptStore,
  });
  return {
    root,
    connector,
    executable,
    configPath,
    run,
    receiptStore,
    readTarget,
    writeTarget,
    storedReceipt: () => storedReceipt,
    setPersistMutations: (value) => {
      persistMutations = value;
    },
    setMutationFailure: (value) => {
      mutationFailure = value;
    },
  };
}

/**
 * A connector wired to a fake host CLI on a sanitized PATH. The fake answers the official CLI's
 * `--version`, `--help` feature probes and MCP subcommands from in-memory state (Codex) or a
 * private config file (Claude Code), so tests drive inspect, connect, verify, disconnect and
 * rollback without a real agent. The temporary root is removed after the test.
 */
export function createConnectorHarness(host: 'codex', options?: CodexHarnessOptions): CodexHarness;
export function createConnectorHarness(
  host: 'claude-code',
  options?: ClaudeHarnessOptions,
): ClaudeHarness;
export function createConnectorHarness(
  host: ConnectorHost,
  options: CodexHarnessOptions | ClaudeHarnessOptions = {},
): CodexHarness | ClaudeHarness {
  return host === 'codex'
    ? createCodexHarness(options as CodexHarnessOptions)
    : createClaudeHarness(options as ClaudeHarnessOptions);
}
