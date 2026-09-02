import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createClaudeCodeConnector,
  planClaudeCodeConnection,
} from '../src/connectors/claudeCode.js';
import { fingerprintCommand } from '../src/connectors/receipt.js';
import type {
  ConnectionReceipt,
  ConnectorVerification,
  HostEntry,
} from '../src/connectors/types.js';
import {
  createFixtureRun,
  loadCapabilities,
  loadScenarios,
  readConnectorFixture,
  readConnectorJson,
  type FixtureRunOptions,
  type ProcessFailureFixture,
} from './fixtures/connectors/load.js';
import { temporaryDirectory } from './helpers/tmp.js';

const capabilities = loadCapabilities('claude-code');
const scenarios = loadScenarios('claude-code');
const launcher = scenarios.launcherPath;
const expected: HostEntry = { command: launcher, arguments: [], scope: 'user' };

interface TargetEntry {
  type?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
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

/** The `mcpServers.pimpampum` value of a recorded `entry-*.json` fixture. */
function recordedTarget(name: string): TargetEntry {
  return readConnectorJson<{ mcpServers: { pimpampum: TargetEntry } }>('claude-code', name)
    .mcpServers.pimpampum;
}

function hostEntryOf(target: TargetEntry, scope: HostEntry['scope'] = 'user'): HostEntry {
  return { command: target.command, arguments: target.args ?? [], scope };
}

/**
 * A connector wired to a fake `claude` on a sanitized PATH whose probes answer with the recorded
 * fixtures and whose `add-json`/`remove` edit a private user config file, exactly the file the
 * bounded reader inspects.
 */
function harness(
  options: FixtureRunOptions & {
    installed?: boolean;
    target?: TargetEntry | null;
    config?: unknown;
    higherPrecedence?: Partial<Record<'project' | 'local', TargetEntry>>;
    receipt?: ConnectionReceipt | null;
    verification?: ConnectorVerification;
  } = {},
) {
  const root = temporaryDirectory('pimpampum-claude-code-');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'claude');
  if (options.installed !== false)
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const configPath = join(root, '.claude.json');
  writeFileSync(
    configPath,
    options.config === undefined
      ? JSON.stringify({ mcpServers: options.target ? { pimpampum: options.target } : {} })
      : JSON.stringify(options.config),
    { mode: 0o600 },
  );
  const sources: Array<{ path: string; scope: 'project' | 'local' }> = [];
  for (const scope of ['project', 'local'] as const) {
    const target = options.higherPrecedence?.[scope];
    if (target === undefined) continue;
    const path = join(root, `${scope}.json`);
    writeFileSync(path, JSON.stringify({ mcpServers: { pimpampum: target } }), { mode: 0o600 });
    sources.push({ path, scope });
  }
  const readConfig = () =>
    JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, unknown> };
  const writeTarget = (target: unknown) => {
    const servers = { ...readConfig().mcpServers };
    if (target === undefined) delete servers.pimpampum;
    else servers.pimpampum = target;
    writeFileSync(configPath, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  };
  let storedReceipt: ConnectionReceipt | null = options.receipt ?? null;
  const run = vi.fn(
    createFixtureRun('claude-code', {
      ...options,
      onMutation: (arguments_) => {
        if (arguments_[1] === 'add-json') writeTarget(JSON.parse(arguments_.at(-1)!) as unknown);
        else writeTarget(undefined);
        return undefined;
      },
    }),
  );
  const verifyRoute = vi.fn(async () => options.verification ?? verification());
  const connector = createClaudeCodeConnector({
    launcherPath: launcher,
    userConfigPath: configPath,
    boundedExecutableLocations: [bin],
    pathValue: bin,
    ...(sources.length === 0 ? {} : { higherPrecedenceConfigSources: sources }),
    runCommand: run,
    now: () => '2026-08-31T08:00:02.000Z',
    verifyRoute,
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
  return {
    connector,
    executable,
    configPath,
    run,
    verifyRoute,
    readTarget: () => readConfig().mcpServers.pimpampum,
    writeTarget,
    storedReceipt: () => storedReceipt,
  };
}

describe('Claude Code connector planning', () => {
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
    // The JSON the CLI receives is the exact recorded shape of an owned entry.
    expect(JSON.parse(plan.mutations[0]!.arguments.at(-1)!)).toEqual(
      recordedTarget('entry-owned-current.json'),
    );
    expect(JSON.stringify(plan)).not.toMatch(/bearer|token|npx|sh -c/iu);
  });

  it('classifies exact, legacy, equivalent and conflicting entries without replacing unowned data', () => {
    const legacy = hostEntryOf(recordedTarget('entry-legacy-npm.json'));
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
    const privateEntry = hostEntryOf(recordedTarget('entry-unknown-conflict.json'), 'local');
    const conflict = plan(null, null, privateEntry);
    expect(conflict).toMatchObject({
      state: 'conflict',
      requiresConflictDecision: true,
      mutations: [],
    });
    expect(JSON.stringify(conflict)).not.toMatch(/synthetic-project|private-memory-server/u);
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
});

describe(`Claude Code connector against the recorded ${capabilities.observedCliVersion} surface`, () => {
  it('detects the recorded release from its --version and --help output', async () => {
    const host = harness();
    await expect(host.connector.detect()).resolves.toEqual({
      connectorId: 'claude-code',
      executable: host.executable,
      ...capabilities.expectedDetection,
    });
    expect(host.run.mock.calls.map(([call]) => call.arguments.join(' ')).sort()).toEqual(
      [
        '--version',
        ...Object.values(capabilities.probes).map((probe) => probe.arguments.join(' ')),
      ].sort(),
    );
  });

  it.each(Object.entries(capabilities.probes))(
    'the recorded help of %s advertises the token exactly as capabilities.json claims',
    (_name, probe) => {
      const help = readConnectorFixture('claude-code', probe.helpFixture);
      expect(help.includes(probe.token)).toBe(probe.supported);
    },
  );

  it('records that `--json` is rejected, so inspection stays on the bounded config reader', () => {
    const rejected = capabilities.probes.getJson as unknown as {
      rejectedInvocation: { exitCode: number; stderrFixture: string };
    };
    expect(rejected.rejectedInvocation.exitCode).toBe(1);
    expect(readConnectorFixture('claude-code', rejected.rejectedInvocation.stderrFixture)).toMatch(
      /unknown option '--json'/u,
    );
    expect(capabilities.expectedDetection.capabilities.inspect).toBe('boundedConfig');
  });

  it.each(Object.entries(scenarios.scenarios))('scenario %s', async (_name, scenario) => {
    if (scenario.processFixture !== undefined) {
      expect(readConnectorJson('claude-code', scenario.processFixture)).toMatchObject({
        executable: null,
        errorCode: 'ENOENT',
      });
      const host = harness({ installed: false });
      await expect(host.connector.detect()).resolves.toMatchObject({
        executable: null,
        supported: false,
      });
      await expect(host.connector.inspect()).resolves.toMatchObject({
        state: scenario.expectedState,
      });
      expect(host.run).not.toHaveBeenCalled();
      return;
    }
    const target = scenario.targetEntryFixture ? recordedTarget(scenario.targetEntryFixture) : null;
    const scopes = scenario.scopeFixture
      ? readConnectorJson<{ user: TargetEntry; project: TargetEntry; local: TargetEntry }>(
          'claude-code',
          scenario.scopeFixture,
        )
      : null;
    const host = harness({
      target: scopes ? scopes.user : target,
      ...(scopes ? { higherPrecedence: { project: scopes.project, local: scopes.local } } : {}),
      ...(scenario.mutationFailure === undefined
        ? {}
        : { mutationFailure: scenario.mutationFailure }),
      receipt: scenario.receipt === 'matching' && target ? receipt(hostEntryOf(target)) : null,
    });
    if (scenario.expectedState !== undefined) {
      await expect(host.connector.inspect()).resolves.toMatchObject({
        state: scenario.expectedState,
        entry: scopes ? hostEntryOf(scopes.user) : target ? hostEntryOf(target) : null,
        // The local scope wins over the project one, as recorded in the collision fixture.
        higherPrecedenceEntry: scopes ? hostEntryOf(scopes.local, 'local') : null,
      });
      // Inspection never spawned anything beyond the probes: the config is read, not queried.
      expect(
        host.run.mock.calls.filter(
          ([call]) => call.arguments.at(-1) !== '--help' && call.arguments[0] !== '--version',
        ),
      ).toEqual([]);
      return;
    }
    if (scenario.mutationFailure !== undefined) {
      const failure = readConnectorJson<ProcessFailureFixture>(
        'claude-code',
        scenario.mutationFailure,
      );
      const plan = await host.connector.plan();
      expect(plan.state).toBe('notConnected');
      const error = await host.connector.connect(plan).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: scenario.expectedError,
        details: { connectorId: 'claude-code' },
      });
      expect((error as Error).message).toContain(failure.stderr);
      expect(host.readTarget()).toBeUndefined();
      expect(host.storedReceipt()).toBeNull();
      expect(host.verifyRoute).not.toHaveBeenCalled();
      return;
    }
    // concurrentRevision: the user config changes between review and connect.
    const revision = readConnectorJson<{ expectedOutcome: string }>(
      'claude-code',
      scenario.revisionFixture!,
    );
    expect(revision.expectedOutcome).toBe('abortWithoutMutation');
    const plan = await host.connector.plan();
    host.writeTarget(recordedTarget('entry-unknown-conflict.json'));
    const error = await host.connector.connect(plan).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: scenario.expectedError,
      details: { connectorId: 'claude-code' },
    });
    expect((error as Error).message).toMatch(/changed after the connection plan was reviewed/u);
    expect(host.readTarget()).toEqual(recordedTarget('entry-unknown-conflict.json'));
    expect(
      host.run.mock.calls.filter(
        ([call]) =>
          call.arguments.at(-1) !== '--help' &&
          (call.arguments[1] === 'add-json' || call.arguments[1] === 'remove'),
      ),
    ).toEqual([]);
  });
});

describe('Claude Code connector lifecycle on the recorded surface', () => {
  it('feature-probes, reads only the bounded target, connects, verifies and disconnects', async () => {
    const host = harness({
      config: {
        mcpServers: { unrelated: { bearer: 'must-not-be-observed' } },
        privateSibling: 'must-not-be-observed',
      },
    });
    await expect(host.connector.detect()).resolves.toMatchObject({
      executable: host.executable,
      supported: true,
      capabilities: { inspect: 'boundedConfig', scopes: ['user'] },
    });
    const connectionPlan = await host.connector.plan();
    expect(connectionPlan.state).toBe('notConnected');
    await expect(host.connector.connect(connectionPlan)).resolves.toMatchObject({
      state: 'ownedCurrent',
      changed: true,
      verification: { available: true },
    });
    expect(host.readTarget()).toEqual(recordedTarget('entry-owned-current.json'));
    expect(host.storedReceipt()).toMatchObject({
      connectorId: 'claude-code',
      scope: 'user',
      commandFingerprint: fingerprintCommand(expected),
    });
    await expect(host.connector.disconnect()).resolves.toMatchObject({
      state: 'notConnected',
      changed: true,
    });
    expect(host.storedReceipt()).toBeNull();
    expect(host.readTarget()).toBeUndefined();
    expect(JSON.stringify(host.run.mock.calls)).not.toMatch(
      /must-not-be-observed|bearer|token|sh -c/iu,
    );
  });

  it('reports a typed unavailable error with a bounded diagnostic when the configuration cannot be parsed', async () => {
    const host = harness();
    writeFileSync(host.configPath, '{not-json');
    const error = await host.connector.plan().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'unavailable',
      status: 503,
      retryable: false,
      details: { connectorId: 'claude-code' },
    });
    expect((error as Error).message).toBe(
      'Claude Code configuration could not be inspected: Host configuration must contain valid JSON',
    );
    await expect(host.connector.inspect()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rolls back a just-added entry and leaves no receipt when route verification fails', async () => {
    const host = harness({ verification: verification(false) });
    await expect(host.connector.connect(await host.connector.plan())).rejects.toThrow(
      /verification/iu,
    );
    expect(host.readTarget()).toBeUndefined();
    expect(host.storedReceipt()).toBeNull();
  });

  it('restores a reviewed unknown entry when explicit replacement verification fails', async () => {
    const previous = recordedTarget('entry-unknown-conflict.json');
    const host = harness({ target: previous, verification: verification(false) });
    await expect(host.connector.plan()).resolves.toMatchObject({
      state: 'conflict',
      mutations: [],
    });
    const replacement = await host.connector.plan({ conflictDecision: 'replace' });
    expect(replacement).toMatchObject({
      conflictDecision: 'replace',
      mutations: [
        { arguments: ['mcp', 'remove', '--scope', 'user', 'pimpampum'] },
        { arguments: ['mcp', 'add-json', '--scope', 'user', 'pimpampum', expect.any(String)] },
      ],
    });
    await expect(host.connector.connect(replacement)).rejects.toThrow(/verification/iu);
    expect(host.readTarget()).toEqual(previous);
  });

  it('spawns at most twelve host processes for one plan, snapshot, and connect', async () => {
    const host = harness();
    const plan = await host.connector.plan();
    await host.connector.snapshot();
    await expect(host.connector.connect(plan)).resolves.toMatchObject({ changed: true });
    const versionProbes = host.run.mock.calls.filter(([call]) => call.arguments[0] === '--version');
    const helpProbes = host.run.mock.calls.filter(([call]) => call.arguments.at(-1) === '--help');
    expect(versionProbes).toHaveLength(1);
    expect(helpProbes).toHaveLength(4);
    expect(host.run.mock.calls.length + host.verifyRoute.mock.calls.length).toBeLessThanOrEqual(12);
  });
});
