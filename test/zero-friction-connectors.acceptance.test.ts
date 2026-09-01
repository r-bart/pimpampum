/**
 * @generated-from thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ConnectorState =
  | 'notInstalled'
  | 'unsupportedVersion'
  | 'notConnected'
  | 'ownedCurrent'
  | 'ownedStale'
  | 'equivalentUnowned'
  | 'conflict'
  | 'unavailable';

type CommandInvocation = {
  executable: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
};

type HostEntry = {
  command: string;
  arguments: string[];
  scope: 'user' | 'project' | 'local' | 'global';
};

type ConnectionReceipt = {
  schemaVersion: 1;
  connectorId: 'codex' | 'claude-code';
  scope: 'user' | 'global';
  commandFingerprint: string;
  configuredAt: string;
  lastVerifiedAt: string | null;
};

type ConnectionPlan = {
  connectorId: 'codex' | 'claude-code';
  state: ConnectorState;
  selectedByDefault: boolean;
  mutations: CommandInvocation[];
  requiresConflictDecision: boolean;
  newSessionRequired: boolean;
  approvalPolicy: 'hostDefault' | 'promptForWrites';
  summary: string;
};

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-connectors-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function connectorContract() {
  const receiptUrl = new URL('../src/connectors/receipt.ts', import.meta.url).href;
  const codexUrl = new URL('../src/connectors/codex.ts', import.meta.url).href;
  const claudeUrl = new URL('../src/connectors/claudeCode.ts', import.meta.url).href;
  const registryUrl = new URL('../src/connectors/registry.ts', import.meta.url).href;
  const verifierUrl = new URL('../src/connectors/verifier.ts', import.meta.url).href;
  const [receipt, codex, claude, registry, verifier] = await Promise.all([
    import(receiptUrl),
    import(codexUrl),
    import(claudeUrl),
    import(registryUrl),
    import(verifierUrl),
  ]);
  return {
    fingerprintCommand: receipt.fingerprintCommand as (entry: HostEntry) => string,
    classifyConnectorOwnership: receipt.classifyConnectorOwnership as (input: {
      entry: HostEntry | null;
      receipt: ConnectionReceipt | null;
      expected: HostEntry;
      recognizedLegacyEntries: HostEntry[];
    }) => ConnectorState,
    planCodexConnection: codex.planCodexConnection as (input: {
      executable: string | null;
      supported: boolean;
      launcherPath: string;
      inspection: HostEntry | null;
      receipt: ConnectionReceipt | null;
    }) => ConnectionPlan,
    planClaudeCodeConnection: claude.planClaudeCodeConnection as (input: {
      executable: string | null;
      supported: boolean;
      launcherPath: string;
      inspection: HostEntry | null;
      higherPrecedenceEntry: HostEntry | null;
      receipt: ConnectionReceipt | null;
    }) => ConnectionPlan,
    createConnectorRegistry: registry.createConnectorRegistry as () => Array<{
      id: string;
      displayName: string;
    }>,
    verifyMcpRoute: verifier.verifyMcpRoute as (input: {
      command: string;
      arguments: string[];
      timeoutMilliseconds: number;
      requiredTools: string[];
      expectedServerName: string;
      spawn: (command: string, arguments_: string[]) => unknown;
    }) => Promise<{
      available: boolean;
      serverName: string;
      tools: string[];
      diagnostics: string[];
    }>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Codex and Claude Code connector contract', () => {
  it('US-1/AC-2/AC-3: registry exposes both initial connectors in deterministic order', async () => {
    // Spec: US-1/AC-2, US-1/AC-3, FR-2.1, FR-2.10, FR-3.2
    const { createConnectorRegistry } = await connectorContract();

    expect(createConnectorRegistry()).toEqual([
      { id: 'codex', displayName: 'Codex' },
      { id: 'claude-code', displayName: 'Claude Code' },
    ]);
  });

  it('FR-2.2/FR-3.1: bounded detection does not launch the graphical agent or scan the home tree', async () => {
    // Spec: FR-2.2, FR-3.1, FR-3.6, PERF-2
    const root = temporaryDirectory('detection');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho codex-cli 0.151.0\n', { mode: 0o755 });
    const processUrl = new URL('../src/connectors/process.ts', import.meta.url).href;
    const processContract = (await import(processUrl)) as {
      detectExecutable(input: {
        id: string;
        names: string[];
        boundedLocations: string[];
        path: string;
        timeoutMilliseconds: number;
        run: (invocation: CommandInvocation) => Promise<unknown>;
      }): Promise<{ executable: string | null; supported: boolean; versionOutput: string | null }>;
    };
    const run = vi.fn(async () => ({ exitCode: 0, stdout: 'codex-cli 0.151.0', stderr: '' }));

    const result = await processContract.detectExecutable({
      id: 'codex',
      names: ['codex'],
      boundedLocations: [bin],
      path: bin,
      timeoutMilliseconds: 2_000,
      run,
    });

    expect(result).toEqual({
      executable: join(bin, 'codex'),
      supported: true,
      versionOutput: 'codex-cli 0.151.0',
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ executable: join(bin, 'codex'), arguments: ['--version'] }),
    );
    expect(JSON.stringify(run.mock.calls)).not.toMatch(/\/Applications\/Codex\.app|find\s|mdfind/u);
  });

  it('FR-5.3/FR-5.4: Codex plan uses its official CLI and an absolute tokenless stdio launcher', async () => {
    // Spec: US-1/AC-4, FR-2.3, FR-2.4, FR-5.1, FR-5.3, FR-5.4
    const { planCodexConnection } = await connectorContract();
    const plan = planCodexConnection({
      executable: '/Applications/Codex.app/Contents/Resources/codex',
      supported: true,
      launcherPath: '/Users/roberto/Library/Application Support/Pimpampum/bin/pimpampum-mcp',
      inspection: null,
      receipt: null,
    });

    expect(plan).toMatchObject({
      connectorId: 'codex',
      state: 'notConnected',
      selectedByDefault: true,
      requiresConflictDecision: false,
      newSessionRequired: true,
    });
    expect(['hostDefault', 'promptForWrites']).toContain(plan.approvalPolicy);
    expect(plan.mutations).toEqual([
      {
        executable: '/Applications/Codex.app/Contents/Resources/codex',
        arguments: [
          'mcp',
          'add',
          'pimpampum',
          '--',
          '/Users/roberto/Library/Application Support/Pimpampum/bin/pimpampum-mcp',
        ],
      },
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/bearer|token|npx|sh -c/iu);
  });

  it('FR-5.1: Claude Code plan uses the official CLI at user scope', async () => {
    // Spec: US-1/AC-4, FR-2.3, FR-5.1, FR-5.3, FR-9.1
    const { planClaudeCodeConnection } = await connectorContract();
    const plan = planClaudeCodeConnection({
      executable: '/Users/roberto/.local/bin/claude',
      supported: true,
      launcherPath: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
      inspection: null,
      higherPrecedenceEntry: null,
      receipt: null,
    });

    expect(plan).toMatchObject({
      connectorId: 'claude-code',
      state: 'notConnected',
      selectedByDefault: true,
      requiresConflictDecision: false,
    });
    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]).toMatchObject({
      executable: '/Users/roberto/.local/bin/claude',
    });
    expect(plan.mutations[0]?.arguments).toContain('--scope');
    expect(plan.mutations[0]?.arguments).toContain('user');
    expect(plan.mutations[0]?.arguments).toContain('pimpampum');
    expect(JSON.stringify(plan.mutations[0])).toContain('pimpampum-mcp');
    expect(JSON.stringify(plan)).not.toMatch(/bearer|token|npx|sh -c/iu);
  });

  it('US-3/AC-3: exact owned entries are idempotent and recognized stale entries are repairable', async () => {
    // Spec: US-3/AC-3, FR-2.4, FR-2.7, FR-2.8, EC-6
    const { classifyConnectorOwnership, fingerprintCommand } = await connectorContract();
    const expected: HostEntry = {
      command: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
      arguments: [],
      scope: 'global',
    };
    const receipt: ConnectionReceipt = {
      schemaVersion: 1,
      connectorId: 'codex',
      scope: 'global',
      commandFingerprint: fingerprintCommand(expected),
      configuredAt: '2026-08-31T08:00:00.000Z',
      lastVerifiedAt: '2026-08-31T08:00:02.000Z',
    };
    const legacy: HostEntry = {
      command: 'npx',
      arguments: ['pimpampum', 'mcp'],
      scope: 'global',
    };

    expect(
      classifyConnectorOwnership({
        entry: expected,
        receipt,
        expected,
        recognizedLegacyEntries: [legacy],
      }),
    ).toBe('ownedCurrent');
    expect(
      classifyConnectorOwnership({
        entry: legacy,
        receipt: { ...receipt, commandFingerprint: fingerprintCommand(legacy) },
        expected,
        recognizedLegacyEntries: [legacy],
      }),
    ).toBe('ownedStale');
    expect(
      classifyConnectorOwnership({
        entry: expected,
        receipt: null,
        expected,
        recognizedLegacyEntries: [legacy],
      }),
    ).toBe('equivalentUnowned');
  });

  it('US-3/AC-4: unknown and higher-precedence entries are conflicts with zero implicit mutation', async () => {
    // Spec: US-3/AC-4, FR-2.3, FR-5.6, FR-7.2, EC-7, EC-12
    const { planClaudeCodeConnection } = await connectorContract();
    const unknown: HostEntry = {
      command: '/opt/acme/private-memory-server',
      arguments: ['--workspace', 'critical-client'],
      scope: 'project',
    };
    const plan = planClaudeCodeConnection({
      executable: '/usr/local/bin/claude',
      supported: true,
      launcherPath: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
      inspection: null,
      higherPrecedenceEntry: unknown,
      receipt: null,
    });

    expect(plan.state).toBe('conflict');
    expect(plan.requiresConflictDecision).toBe(true);
    expect(plan.mutations).toEqual([]);
    expect(plan.summary).not.toContain('critical-client');
    expect(JSON.stringify(plan)).not.toContain('/opt/acme/private-memory-server');
  });

  it('US-4/AC-1/AC-2: disconnect is allowed only for receipt-proven ownership', async () => {
    // Spec: US-4/AC-1, US-4/AC-2, FR-2.8, FR-8.3, FR-8.4, EC-15
    const root = temporaryDirectory('disconnect');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const { fingerprintCommand } = await connectorContract();
    const codexUrl = new URL('../src/connectors/codex.ts', import.meta.url).href;
    const { createCodexConnector } = (await import(codexUrl)) as {
      createCodexConnector(input: Record<string, unknown>): {
        disconnect(): Promise<{ state: ConnectorState; changed: boolean }>;
      };
    };
    const entry: HostEntry = {
      command: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
      arguments: [],
      scope: 'global',
    };
    const connectorFor = (receipt: ConnectionReceipt | null) => {
      let stored = receipt;
      let current: HostEntry | null = entry;
      const run = vi.fn(async (invocation: CommandInvocation) => {
        const args = invocation.arguments;
        if (args[0] === '--version') {
          return { exitCode: 0, stdout: 'codex-cli 0.151.0', stderr: '' };
        }
        if (args.at(-1) === '--help') {
          return { exitCode: 0, stdout: args[1] === 'get' ? '--json' : 'Usage', stderr: '' };
        }
        if (args[1] === 'get') {
          return current === null
            ? { exitCode: 1, stdout: '', stderr: "No MCP server named 'pimpampum' found." }
            : {
                exitCode: 0,
                stdout: JSON.stringify({
                  name: 'pimpampum',
                  transport: { type: 'stdio', command: current.command, args: current.arguments },
                }),
                stderr: '',
              };
        }
        if (args[1] === 'remove') current = null;
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      const connector = createCodexConnector({
        launcherPath: entry.command,
        boundedLocations: [bin],
        path: bin,
        requiredTools: [],
        run,
        verify: async () => ({
          available: true,
          serverName: 'pimpampum',
          tools: [],
          diagnostics: [],
        }),
        receipt: {
          read: async () => stored,
          write: async (value: ConnectionReceipt) => {
            stored = value;
          },
          remove: async () => {
            stored = null;
          },
        },
      });
      return { connector, run, current: () => current, stored: () => stored };
    };
    const mutations = (run: ReturnType<typeof vi.fn>) =>
      run.mock.calls.filter(
        ([invocation]) =>
          (invocation as CommandInvocation).arguments[0] === 'mcp' &&
          (invocation as CommandInvocation).arguments.at(-1) !== '--help' &&
          (invocation as CommandInvocation).arguments[1] !== 'get',
      );

    const unknown = connectorFor(null);
    await expect(unknown.connector.disconnect()).resolves.toMatchObject({
      state: 'equivalentUnowned',
      changed: false,
    });
    expect(unknown.current()).toEqual(entry);
    expect(mutations(unknown.run)).toEqual([]);

    const owned = connectorFor({
      schemaVersion: 1,
      connectorId: 'codex',
      scope: 'global',
      commandFingerprint: fingerprintCommand(entry),
      configuredAt: '2026-08-31T08:00:00.000Z',
      lastVerifiedAt: null,
    });
    await expect(owned.connector.disconnect()).resolves.toMatchObject({
      state: 'notConnected',
      changed: true,
    });
    expect(owned.current()).toBeNull();
    expect(owned.stored()).toBeNull();
    expect(mutations(owned.run)).toEqual([
      [{ executable: join(bin, 'codex'), arguments: ['mcp', 'remove', 'pimpampum'] }],
    ]);
    // The daemon and the data directory are never part of a connector removal.
    expect(JSON.stringify(owned.run.mock.calls)).not.toMatch(/launchctl|systemctl|sqlite|rm /u);
  });

  it('US-4/AC-3: missing or unsupported clients stay neutral and never install third-party software', async () => {
    // Spec: US-4/AC-3, FR-3.4, FR-3.5, EC-1, EC-2
    const { planCodexConnection } = await connectorContract();
    const missing = planCodexConnection({
      executable: null,
      supported: false,
      launcherPath: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
      inspection: null,
      receipt: null,
    });
    const unsupported = planCodexConnection({
      executable: '/usr/local/bin/codex',
      supported: false,
      launcherPath: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
      inspection: null,
      receipt: null,
    });

    expect(missing).toMatchObject({
      state: 'notInstalled',
      selectedByDefault: false,
      mutations: [],
    });
    expect(unsupported).toMatchObject({
      state: 'unsupportedVersion',
      selectedByDefault: false,
      mutations: [],
    });
    expect(JSON.stringify([missing, unsupported])).not.toMatch(/brew install|npm install|curl/iu);
  });

  it('US-2/AC-3: verification requires identity, initialization and the bounded tool catalog', async () => {
    // Spec: US-2/AC-1, US-2/AC-3, FR-2.5, FR-6.1, FR-6.2, FR-6.3
    const { verifyMcpRoute } = await connectorContract();
    const child = {
      initialize: vi.fn(async () => ({ serverInfo: { name: 'pimpampum', version: '2.0.0' } })),
      listTools: vi.fn(async () => ({ tools: [{ name: 'project_list' }, { name: 'work_claim' }] })),
      close: vi.fn(async () => undefined),
    };
    const spawn = vi.fn(() => child);

    const result = await verifyMcpRoute({
      command: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
      arguments: [],
      timeoutMilliseconds: 10_000,
      requiredTools: ['project_list', 'work_claim'],
      expectedServerName: 'pimpampum',
      spawn,
    });

    expect(result).toEqual({
      available: true,
      serverName: 'pimpampum',
      tools: ['project_list', 'work_claim'],
      diagnostics: [],
    });
    expect(child.close).toHaveBeenCalledOnce();
  });

  it('FR-6.3/FR-6.4: wrong identity, timeout or secrets fail closed and always reap the bridge', async () => {
    // Spec: FR-6.3, FR-6.4, SEC-4, EC-9
    const { verifyMcpRoute } = await connectorContract();
    const token = 'pimpampum-private-token-never-report';
    const child = {
      initialize: vi.fn(async () => ({ serverInfo: { name: 'another-server', version: '1.0.0' } })),
      listTools: vi.fn(async () => ({ tools: [], stderr: `authorization ${token}` })),
      close: vi.fn(async () => undefined),
    };

    await expect(
      verifyMcpRoute({
        command: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
        arguments: [],
        timeoutMilliseconds: 10,
        requiredTools: ['project_list'],
        expectedServerName: 'pimpampum',
        spawn: () => child,
      }),
    ).rejects.toThrow(/identity|server|timeout|secret/i);
    expect(child.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(child.close.mock.calls)).not.toContain(token);
  });

  it('FR-2.9/US-4/AC-4: diagnostics and manual instructions are useful but redacted', async () => {
    // Spec: US-4/AC-4, FR-2.9, FR-6.5, FR-9.1, SEC-4
    const root = temporaryDirectory('diagnostics');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const codexUrl = new URL('../src/connectors/codex.ts', import.meta.url).href;
    const { createCodexConnector } = (await import(codexUrl)) as {
      createCodexConnector(input: Record<string, unknown>): {
        plan(): Promise<ConnectionPlan>;
        connect(plan: ConnectionPlan): Promise<unknown>;
      };
    };
    const token = 'private-bearer-token-000000000000';
    const run = async (invocation: CommandInvocation) => {
      const args = invocation.arguments;
      if (args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli 0.151.0', stderr: '' };
      if (args.at(-1) === '--help') {
        return { exitCode: 0, stdout: args[1] === 'get' ? '--json' : 'Usage', stderr: '' };
      }
      if (args[1] === 'get') {
        return { exitCode: 1, stdout: '', stderr: "No MCP server named 'pimpampum' found." };
      }
      return {
        exitCode: 7,
        stdout: '',
        stderr: `Could not connect with Bearer ${token} from /Users/roberto/private\n${'x'.repeat(2_000)}`,
      };
    };
    const connector = createCodexConnector({
      launcherPath: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
      boundedLocations: [bin],
      path: bin,
      requiredTools: [],
      run,
      receipt: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });

    const error = await connector
      .connect(await connector.plan())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'unavailable',
      status: 503,
      details: { connectorId: 'codex' },
    });
    const message = (error as Error).message;
    expect(message).toMatch(/^Codex could not update the Pimpampum MCP entry: /u);
    expect(message.length).toBeLessThan(400);
    expect(message).not.toContain(token);
    expect(message).not.toMatch(/Bearer\s+\S+/iu);
    expect(message).not.toContain('/Users/roberto');
  });
});
