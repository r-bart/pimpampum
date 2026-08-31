import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCodexConnector,
  parseCodexMcpEntry,
  planCodexConnection,
} from '../src/connectors/codex.js';
import { fingerprintCommand } from '../src/connectors/receipt.js';
import type { ConnectionReceipt, HostEntry } from '../src/connectors/types.js';

const temporaryDirectories: string[] = [];
const launcher = '/Users/example/.local/share/pimpampum/bin/pimpampum-mcp';
const expected: HostEntry = { command: launcher, arguments: [], scope: 'global' };

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pimpampum-codex-'));
  temporaryDirectories.push(directory);
  return directory;
}

function receipt(entry = expected): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId: 'codex',
    scope: 'global',
    commandFingerprint: fingerprintCommand(entry),
    configuredAt: '2026-08-31T08:00:00.000Z',
    lastVerifiedAt: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Codex connector', () => {
  it('plans the exact official global CLI mutation for a supported absent entry', () => {
    expect(
      planCodexConnection({
        executable: '/Applications/Codex.app/Contents/Resources/codex',
        supported: true,
        launcherPath: launcher,
        inspection: null,
        receipt: null,
      }),
    ).toMatchObject({
      state: 'notConnected',
      selectedByDefault: true,
      newSessionRequired: true,
      mutations: [
        {
          executable: '/Applications/Codex.app/Contents/Resources/codex',
          arguments: ['mcp', 'add', 'pimpampum', '--', launcher],
        },
      ],
    });
  });

  it('classifies current, legacy, equivalent, conflict, missing and unsupported states safely', () => {
    const legacy: HostEntry = {
      command: 'npx',
      arguments: ['pimpampum', 'mcp'],
      scope: 'global',
    };
    const plan = (inspection: HostEntry | null, proof: ConnectionReceipt | null) =>
      planCodexConnection({
        executable: '/usr/local/bin/codex',
        supported: true,
        launcherPath: launcher,
        inspection,
        receipt: proof,
      });
    expect(plan(expected, receipt()).state).toBe('ownedCurrent');
    expect(plan(legacy, receipt(legacy)).state).toBe('ownedStale');
    expect(plan(expected, null).state).toBe('equivalentUnowned');
    expect(
      plan({ command: '/synthetic/other', arguments: [], scope: 'global' }, null),
    ).toMatchObject({
      state: 'conflict',
      mutations: [],
      requiresConflictDecision: true,
    });
    expect(
      planCodexConnection({
        executable: null,
        supported: false,
        launcherPath: launcher,
        inspection: null,
        receipt: null,
      }),
    ).toMatchObject({ state: 'notInstalled', selectedByDefault: false, mutations: [] });
    expect(
      planCodexConnection({
        executable: '/usr/local/bin/codex',
        supported: false,
        launcherPath: launcher,
        inspection: null,
        receipt: null,
      }),
    ).toMatchObject({ state: 'unsupportedVersion', selectedByDefault: false, mutations: [] });
  });

  it('parses only stdio command and arguments from the targeted JSON shape', () => {
    expect(
      parseCodexMcpEntry({
        name: 'pimpampum',
        transport: { type: 'stdio', command: launcher, args: [], env: null },
        unrelated: { private: 'ignored' },
      }),
    ).toEqual(expected);
  });

  it('feature-probes, inspects, connects, verifies, and records ownership', async () => {
    const root = temporaryDirectory();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'codex');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const writes: ConnectionReceipt[] = [];
    let configured = false;
    const run = vi.fn(async (invocation: { arguments: string[] }) => {
      if (invocation.arguments[0] === '--version') {
        return { exitCode: 0, stdout: 'codex-cli 0.151.0', stderr: '' };
      }
      if (invocation.arguments.at(-1) === '--help') {
        const stdout =
          invocation.arguments.includes('get') || invocation.arguments.includes('list')
            ? '--json'
            : 'Usage';
        return { exitCode: 0, stdout, stderr: '' };
      }
      if (invocation.arguments.includes('get')) {
        if (configured) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              name: 'pimpampum',
              transport: { type: 'stdio', command: launcher, args: [] },
            }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: "No MCP server named 'pimpampum' found." };
      }
      if (invocation.arguments.includes('add')) configured = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const verify = vi.fn(async () => ({
      available: true,
      serverName: 'pimpampum',
      tools: ['project_list', 'work_claim'],
      diagnostics: [],
    }));
    const connector = createCodexConnector({
      launcherPath: launcher,
      boundedLocations: [bin],
      path: bin,
      requiredTools: ['project_list', 'work_claim'],
      run,
      verify,
      now: () => '2026-08-31T08:00:02.000Z',
      receipt: {
        read: async () => writes.at(-1) ?? null,
        write: async (value) => {
          writes.push(value);
        },
        remove: async () => undefined,
      },
    });
    await expect(connector.detect()).resolves.toMatchObject({ supported: true });
    const connectionPlan = await connector.plan();
    expect(connectionPlan.state).toBe('notConnected');
    await expect(connector.connect(connectionPlan)).resolves.toMatchObject({
      state: 'ownedCurrent',
      changed: true,
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(writes.at(-1)).toMatchObject({
      connectorId: 'codex',
      scope: 'global',
      commandFingerprint: fingerprintCommand(expected),
    });
    expect(JSON.stringify(run.mock.calls)).not.toMatch(/sh -c|bearer|token/iu);
  });

  it('rolls back and records no ownership when installed-route verification fails', async () => {
    const root = temporaryDirectory();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'codex');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    let configured = false;
    let storedReceipt: ConnectionReceipt | null = null;
    const run = vi.fn(async (invocation: { arguments: string[] }) => {
      if (invocation.arguments[0] === '--version') {
        return { exitCode: 0, stdout: 'codex-cli 0.151.0', stderr: '' };
      }
      if (invocation.arguments.at(-1) === '--help') {
        return {
          exitCode: 0,
          stdout:
            invocation.arguments.includes('get') || invocation.arguments.includes('list')
              ? '--json'
              : 'Usage',
          stderr: '',
        };
      }
      if (invocation.arguments.includes('get')) {
        return configured
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                name: 'pimpampum',
                transport: { type: 'stdio', command: launcher, args: [] },
              }),
              stderr: '',
            }
          : { exitCode: 1, stdout: '', stderr: "No MCP server named 'pimpampum' found." };
      }
      if (invocation.arguments.includes('add')) configured = true;
      if (invocation.arguments.includes('remove')) configured = false;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const connector = createCodexConnector({
      launcherPath: launcher,
      boundedLocations: [bin],
      path: bin,
      requiredTools: ['project_list'],
      run,
      verify: async () => ({
        available: false,
        serverName: 'pimpampum',
        tools: [],
        diagnostics: ['route unavailable'],
      }),
      receipt: {
        read: async () => storedReceipt,
        write: async (value) => {
          storedReceipt = value;
        },
        remove: async () => {
          storedReceipt = null;
        },
      },
    });

    await expect(connector.connect(await connector.plan())).rejects.toThrow(/verification/iu);
    expect(configured).toBe(false);
    expect(storedReceipt).toBeNull();
  });
});
