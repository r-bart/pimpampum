import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClaudeCodeConnector,
  planClaudeCodeConnection,
} from '../src/connectors/claudeCode.js';
import { fingerprintCommand } from '../src/connectors/receipt.js';
import type {
  CommandInvocation,
  ConnectionReceipt,
  ConnectorVerification,
  HostEntry,
} from '../src/connectors/types.js';

const temporaryDirectories: string[] = [];
const launcher = '/Users/example/.local/share/pimpampum/bin/pimpampum-mcp';
const expected: HostEntry = { command: launcher, arguments: [], scope: 'user' };

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pimpampum-claude-code-'));
  temporaryDirectories.push(directory);
  return directory;
}

function receipt(entry = expected): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId: 'claude-code',
    scope: 'user',
    commandFingerprint: fingerprintCommand(entry),
    configuredAt: '2026-08-31T08:00:00.000Z',
    lastVerifiedAt: null,
  };
}

function verification(available = true): ConnectorVerification {
  return {
    connectorId: 'claude-code',
    available,
    verifiedAt: '2026-08-31T08:00:02.000Z',
    serverName: available ? 'pimpampum' : null,
    tools: available ? ['project_list', 'work_start'] : [],
    diagnostics: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Claude Code connector', () => {
  it('plans the exact official user-scoped CLI mutation with a stable tokenless launcher', () => {
    const plan = planClaudeCodeConnection({
      executable: '/Users/example/.local/bin/claude',
      supported: true,
      launcherPath: launcher,
      inspection: null,
      higherPrecedenceEntry: null,
      receipt: null,
    });

    expect(plan).toMatchObject({
      connectorId: 'claude-code',
      state: 'notConnected',
      selectedByDefault: true,
      requiresConflictDecision: false,
      approvalPolicy: 'hostDefault',
      mutations: [
        {
          executable: '/Users/example/.local/bin/claude',
          arguments: ['mcp', 'add-json', '--scope', 'user', 'pimpampum', expect.any(String)],
        },
      ],
    });
    expect(JSON.parse(plan.mutations[0]!.arguments.at(-1)!)).toEqual({
      type: 'stdio',
      command: launcher,
      args: [],
      env: {},
    });
    expect(JSON.stringify(plan)).not.toMatch(/bearer|token|npx|sh -c/iu);
  });

  it('classifies exact, legacy, equivalent and conflicting entries without replacing unowned data', () => {
    const legacy: HostEntry = {
      command: 'npx',
      arguments: ['pimpampum', 'mcp'],
      scope: 'user',
    };
    const plan = (
      inspection: HostEntry | null,
      proof: ConnectionReceipt | null,
      higherPrecedenceEntry: HostEntry | null = null,
    ) =>
      planClaudeCodeConnection({
        executable: '/usr/local/bin/claude',
        supported: true,
        launcherPath: launcher,
        inspection,
        higherPrecedenceEntry,
        receipt: proof,
      });

    expect(plan(expected, receipt())).toMatchObject({ state: 'ownedCurrent', mutations: [] });
    expect(plan(legacy, receipt(legacy))).toMatchObject({
      state: 'ownedStale',
      mutations: [
        { arguments: ['mcp', 'remove', '--scope', 'user', 'pimpampum'] },
        { arguments: ['mcp', 'add-json', '--scope', 'user', 'pimpampum', expect.any(String)] },
      ],
    });
    expect(plan(expected, null)).toMatchObject({
      state: 'equivalentUnowned',
      mutations: [],
      selectedByDefault: true,
    });

    const privateEntry: HostEntry = {
      command: '/opt/acme/private-memory-server',
      arguments: ['--workspace', 'critical-client'],
      scope: 'local',
    };
    const conflict = plan(null, null, privateEntry);
    expect(conflict).toMatchObject({
      state: 'conflict',
      requiresConflictDecision: true,
      mutations: [],
    });
    expect(JSON.stringify(conflict)).not.toMatch(/critical-client|private-memory-server/u);
    expect(
      planClaudeCodeConnection({
        executable: null,
        supported: false,
        launcherPath: launcher,
        inspection: null,
        higherPrecedenceEntry: null,
        receipt: null,
      }),
    ).toMatchObject({ state: 'notInstalled', selectedByDefault: false, mutations: [] });
    expect(
      planClaudeCodeConnection({
        executable: 'unsupported-relative-cli',
        supported: false,
        launcherPath: launcher,
        inspection: null,
        higherPrecedenceEntry: null,
        receipt: null,
      }),
    ).toMatchObject({ state: 'unsupportedVersion', selectedByDefault: false, mutations: [] });
  });

  it('feature-probes, reads only the bounded target, connects, verifies and disconnects', async () => {
    const root = temporaryDirectory();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'claude');
    const configPath = join(root, '.claude.json');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { unrelated: { bearer: 'must-not-be-observed' } },
        privateSibling: 'must-not-be-observed',
      }),
    );

    let storedReceipt: ConnectionReceipt | null = null;
    const run = vi.fn(async (invocation: CommandInvocation) => {
      if (invocation.arguments[0] === '--version') {
        return { exitCode: 0, stdout: '2.1.251 (Claude Code)', stderr: '', signal: null };
      }
      if (invocation.arguments.at(-1) === '--help') {
        return { exitCode: 0, stdout: '--scope user', stderr: '', signal: null };
      }
      if (invocation.arguments[1] === 'add-json') {
        const target = JSON.parse(invocation.arguments.at(-1)!) as unknown;
        writeFileSync(configPath, JSON.stringify({ mcpServers: { pimpampum: target } }));
      } else if (invocation.arguments[1] === 'remove') {
        writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
      }
      return { exitCode: 0, stdout: '', stderr: '', signal: null };
    });
    const connector = createClaudeCodeConnector({
      launcherPath: launcher,
      userConfigPath: configPath,
      boundedExecutableLocations: [bin],
      pathValue: bin,
      runCommand: run,
      now: () => '2026-08-31T08:00:02.000Z',
      verifyRoute: async () => verification(),
      receiptStore: {
        read: async () => storedReceipt,
        write: async (value) => {
          storedReceipt = value;
        },
        remove: async () => {
          storedReceipt = null;
        },
      },
    });

    await expect(connector.detect()).resolves.toMatchObject({
      executable,
      supported: true,
      capabilities: { inspect: 'boundedConfig', scopes: ['user'] },
    });
    const connectionPlan = await connector.plan();
    expect(connectionPlan.state).toBe('notConnected');
    await expect(connector.connect(connectionPlan)).resolves.toMatchObject({
      state: 'ownedCurrent',
      changed: true,
      verification: { available: true },
    });
    expect(storedReceipt).toMatchObject({
      connectorId: 'claude-code',
      scope: 'user',
      commandFingerprint: fingerprintCommand(expected),
    });
    await expect(connector.disconnect()).resolves.toMatchObject({
      state: 'notConnected',
      changed: true,
    });
    expect(storedReceipt).toBeNull();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ mcpServers: {} });
    expect(JSON.stringify(run.mock.calls)).not.toMatch(/must-not-be-observed|bearer|token|sh -c/iu);
  });

  it('treats higher-precedence target collisions as conflicts even when entries are equivalent', async () => {
    const root = temporaryDirectory();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'claude');
    const userConfigPath = join(root, 'user.json');
    const projectConfigPath = join(root, 'project.json');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(userConfigPath, JSON.stringify({ mcpServers: {} }));
    writeFileSync(
      projectConfigPath,
      JSON.stringify({ mcpServers: { pimpampum: { command: launcher, args: [], env: {} } } }),
    );
    const run = vi.fn(async (invocation: CommandInvocation) => ({
      exitCode: 0,
      stdout: invocation.arguments[0] === '--version' ? '2.1.251' : '--scope user',
      stderr: '',
      signal: null,
    }));
    const connector = createClaudeCodeConnector({
      launcherPath: launcher,
      userConfigPath,
      higherPrecedenceConfigSources: [{ path: projectConfigPath, scope: 'project' }],
      boundedExecutableLocations: [bin],
      pathValue: bin,
      runCommand: run,
      verifyRoute: async () => verification(),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });

    await expect(connector.plan()).resolves.toMatchObject({
      state: 'conflict',
      requiresConflictDecision: true,
      mutations: [],
    });
    expect(
      run.mock.calls.filter(
        ([invocation]) =>
          invocation.arguments.at(-1) !== '--help' && invocation.arguments[0] !== '--version',
      ),
    ).toEqual([]);
  });

  it('stays neutral when the bounded configuration cannot be parsed safely', async () => {
    const root = temporaryDirectory();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'claude');
    const configPath = join(root, '.claude.json');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(configPath, '{not-json');
    const run = vi.fn(async (invocation: CommandInvocation) => ({
      exitCode: 0,
      stdout: invocation.arguments[0] === '--version' ? '2.1.251 (Claude Code)' : '--scope user',
      stderr: '',
      signal: null,
    }));
    const connector = createClaudeCodeConnector({
      launcherPath: launcher,
      userConfigPath: configPath,
      boundedExecutableLocations: [bin],
      pathValue: bin,
      runCommand: run,
      verifyRoute: async () => verification(),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });

    await expect(connector.plan()).resolves.toMatchObject({
      state: 'unavailable',
      selectedByDefault: false,
      mutations: [],
    });
  });

  it('rolls back a just-added entry and leaves no receipt when route verification fails', async () => {
    const root = temporaryDirectory();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'claude');
    const configPath = join(root, '.claude.json');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    let storedReceipt: ConnectionReceipt | null = null;
    const run = vi.fn(async (invocation: CommandInvocation) => {
      if (invocation.arguments[0] === '--version') {
        return { exitCode: 0, stdout: '2.1.251', stderr: '', signal: null };
      }
      if (invocation.arguments.at(-1) === '--help') {
        return { exitCode: 0, stdout: '--scope user', stderr: '', signal: null };
      }
      if (invocation.arguments[1] === 'add-json') {
        writeFileSync(
          configPath,
          JSON.stringify({
            mcpServers: { pimpampum: JSON.parse(invocation.arguments.at(-1)!) as unknown },
          }),
        );
      } else if (invocation.arguments[1] === 'remove') {
        writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
      }
      return { exitCode: 0, stdout: '', stderr: '', signal: null };
    });
    const connector = createClaudeCodeConnector({
      launcherPath: launcher,
      userConfigPath: configPath,
      boundedExecutableLocations: [bin],
      pathValue: bin,
      runCommand: run,
      verifyRoute: async () => verification(false),
      receiptStore: {
        read: async () => storedReceipt,
        write: async (value) => {
          storedReceipt = value;
        },
        remove: async () => {
          storedReceipt = null;
        },
      },
    });

    const connectionPlan = await connector.plan();
    await expect(connector.connect(connectionPlan)).rejects.toThrow(/verification/iu);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ mcpServers: {} });
    expect(storedReceipt).toBeNull();
  });

  it('restores a reviewed unknown entry when explicit replacement verification fails', async () => {
    const root = temporaryDirectory();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'claude');
    const configPath = join(root, '.claude.json');
    const previous = { command: '/opt/acme/private-memory', args: ['--reviewed'], env: {} };
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { pimpampum: previous } }));
    const run = vi.fn(async (invocation: CommandInvocation) => {
      if (invocation.arguments[0] === '--version') {
        return { exitCode: 0, stdout: '2.1.251', stderr: '', signal: null };
      }
      if (invocation.arguments.at(-1) === '--help') {
        return { exitCode: 0, stdout: '--scope user', stderr: '', signal: null };
      }
      if (invocation.arguments[1] === 'remove') {
        writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
      }
      if (invocation.arguments[1] === 'add-json') {
        writeFileSync(
          configPath,
          JSON.stringify({
            mcpServers: { pimpampum: JSON.parse(invocation.arguments.at(-1)!) as unknown },
          }),
        );
      }
      return { exitCode: 0, stdout: '', stderr: '', signal: null };
    });
    const connector = createClaudeCodeConnector({
      launcherPath: launcher,
      userConfigPath: configPath,
      boundedExecutableLocations: [bin],
      pathValue: bin,
      runCommand: run,
      verifyRoute: async () => verification(false),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });

    await expect(connector.plan()).resolves.toMatchObject({
      state: 'conflict',
      mutations: [],
    });
    const replacement = await connector.plan({ conflictDecision: 'replace' });
    expect(replacement).toMatchObject({
      conflictDecision: 'replace',
      mutations: [
        { arguments: ['mcp', 'remove', '--scope', 'user', 'pimpampum'] },
        { arguments: ['mcp', 'add-json', '--scope', 'user', 'pimpampum', expect.any(String)] },
      ],
    });
    await expect(connector.connect(replacement)).rejects.toThrow(/verification/iu);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: { pimpampum: { type: 'stdio', ...previous } },
    });
  });
});
