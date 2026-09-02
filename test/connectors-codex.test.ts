import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createCodexConnector,
  parseCodexMcpEntry,
  planCodexConnection,
} from '../src/connectors/codex.js';
import { fingerprintCommand } from '../src/connectors/receipt.js';
import type { ConnectionReceipt, HostEntry } from '../src/connectors/types.js';
import {
  createFixtureRun,
  loadCapabilities,
  loadScenarios,
  readConnectorFixture,
  readConnectorJson,
  type CommandOutputFixture,
  type FixtureRunOptions,
  type ProcessFailureFixture,
} from './fixtures/connectors/load.js';
import { temporaryDirectory } from './helpers/tmp.js';

const capabilities = loadCapabilities('codex');
const scenarios = loadScenarios('codex');
const launcher = scenarios.launcherPath;
const expected: HostEntry = { command: launcher, arguments: [], scope: 'global' };

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

/** The Pimpampum entry a recorded `codex mcp get --json` output describes. */
function recordedEntry(output: CommandOutputFixture): HostEntry | null {
  if (output.stdoutFixture === undefined) return null;
  return parseCodexMcpEntry(readConnectorJson<unknown>('codex', output.stdoutFixture));
}

/**
 * A connector wired to a fake `codex` on a sanitized PATH whose every answer is a recorded
 * fixture. `installed: false` leaves the PATH empty so detection reports no executable.
 */
function harness(
  options: FixtureRunOptions & {
    installed?: boolean;
    receipt?: ConnectionReceipt | null;
    verificationAvailable?: boolean;
  } = {},
) {
  const bin = join(temporaryDirectory('pimpampum-codex-'), 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'codex');
  if (options.installed !== false)
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let storedReceipt: ConnectionReceipt | null = options.receipt ?? null;
  const run = vi.fn(createFixtureRun('codex', options));
  const verify = vi.fn(async () => ({
    available: options.verificationAvailable ?? true,
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
      read: async () => storedReceipt,
      write: async (value) => {
        storedReceipt = value;
      },
      remove: async () => {
        storedReceipt = null;
      },
    },
  });
  return { connector, executable, run, verify, storedReceipt: () => storedReceipt };
}

/**
 * A fake host whose `mcp get` answer follows the entry `add`/`remove` leave behind. The state is
 * the name of the recorded `get-*.json` output that describes the current entry, or `null`.
 */
function statefulHost(initial: string | null) {
  let current: string | null | undefined = initial;
  const getResult = (): CommandOutputFixture =>
    current == null
      ? { exitCode: 1, stderrFixture: 'get-absent.txt' }
      : { exitCode: 0, stdoutFixture: current };
  const onMutation = (arguments_: string[]) => {
    if (arguments_[1] === 'remove') current = null;
    if (arguments_[1] === 'add') {
      const added = arguments_.slice(arguments_.indexOf('--') + 1);
      // The host now holds whichever recorded entry the invocation wrote; an unrecorded one is a
      // test mistake, not a state.
      const recorded = [
        'get-owned-current.json',
        'get-legacy-npm.json',
        'get-unknown-conflict.json',
      ];
      current = recorded.find((name) => {
        const entry = recordedEntry({ exitCode: 0, stdoutFixture: name });
        return (
          entry !== null &&
          entry.command === added[0] &&
          JSON.stringify(entry.arguments) === JSON.stringify(added.slice(1))
        );
      });
      if (current === undefined) throw new Error(`unrecorded Codex entry: ${added.join(' ')}`);
    }
    return undefined;
  };
  return {
    getResult,
    onMutation,
    entry: (): HostEntry | null => (current == null ? null : recordedEntry(getResult())),
    set: (value: string | null) => {
      current = value;
    },
  };
}

describe('Codex connector planning', () => {
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
    const legacy: HostEntry = { command: 'npx', arguments: ['pimpampum', 'mcp'], scope: 'global' };
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
    ).toMatchObject({ state: 'conflict', mutations: [], requiresConflictDecision: true });
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

  it('parses only stdio command and arguments from the recorded JSON shape', () => {
    // The recorded `codex mcp get --json` output carries fields the connector must ignore.
    const recorded = readConnectorJson<Record<string, unknown>>('codex', 'get-owned-current.json');
    expect(Object.keys(recorded)).toEqual(
      expect.arrayContaining([
        'enabled',
        'disabled_reason',
        'startup_timeout_sec',
        'tool_timeout_sec',
      ]),
    );
    expect(parseCodexMcpEntry(recorded)).toEqual(expected);
    expect(parseCodexMcpEntry({ ...recorded, unrelated: { private: 'ignored' } })).toEqual(
      expected,
    );
  });
});

describe(`Codex connector against the recorded ${capabilities.observedCliVersion} surface`, () => {
  it('detects the recorded release from its --version and --help output', async () => {
    const { connector, executable, run } = harness();
    await expect(connector.detect()).resolves.toEqual({
      connectorId: 'codex',
      executable,
      ...capabilities.expectedDetection,
    });
    // One version probe and exactly the four recorded help probes, nothing else.
    expect(run.mock.calls.map(([call]) => call.arguments.join(' ')).sort()).toEqual(
      [
        '--version',
        ...Object.values(capabilities.probes).map((probe) => probe.arguments.join(' ')),
      ].sort(),
    );
  });

  it.each(Object.entries(capabilities.probes))(
    'the recorded help of %s advertises the token exactly as capabilities.json claims',
    (_name, probe) => {
      const help = readConnectorFixture('codex', probe.helpFixture);
      expect(help.includes(probe.token)).toBe(probe.supported);
    },
  );

  it.each(Object.entries(scenarios.scenarios))('scenario %s', async (_name, scenario) => {
    if (scenario.processFixture !== undefined) {
      const missing = readConnectorJson<{ executable: null; errorCode: string }>(
        'codex',
        scenario.processFixture,
      );
      expect(missing).toMatchObject({ executable: null, errorCode: 'ENOENT' });
      const { connector, run } = harness({ installed: false });
      await expect(connector.detect()).resolves.toMatchObject({
        executable: null,
        supported: false,
      });
      await expect(connector.inspect()).resolves.toMatchObject({ state: scenario.expectedState });
      expect(run).not.toHaveBeenCalled();
      return;
    }
    const getResult = scenario.getResult!;
    const entry = recordedEntry(getResult);
    const host = harness({
      getResult,
      ...(scenario.listResult === undefined ? {} : { listResult: scenario.listResult }),
      ...(scenario.mutationFailure === undefined
        ? {}
        : { mutationFailure: scenario.mutationFailure }),
      receipt: scenario.receipt === 'matching' ? receipt(entry as HostEntry) : null,
    });
    if (scenario.expectedState !== undefined) {
      await expect(host.connector.inspect()).resolves.toMatchObject({
        state: scenario.expectedState,
        entry,
      });
      return;
    }
    if (scenario.mutationFailure !== undefined) {
      const failure = readConnectorJson<ProcessFailureFixture>('codex', scenario.mutationFailure);
      const plan = await host.connector.plan();
      expect(plan.state).toBe('notConnected');
      const error = await host.connector.connect(plan).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: scenario.expectedError,
        details: { connectorId: 'codex' },
      });
      expect((error as Error).message).toContain(failure.stderr);
      expect(failure.mutationCommitted).toBe(false);
      expect(host.storedReceipt()).toBeNull();
      expect(host.verify).not.toHaveBeenCalled();
      return;
    }
    // The recorded rejection of `--json` by an older release, behind help that advertises it.
    const error = await host.connector.inspect().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: scenario.expectedError,
      details: { connectorId: 'codex' },
    });
    expect((error as Error).message).toMatch(/could not be inspected/u);
  });
});

describe('Codex connector lifecycle on the recorded surface', () => {
  it('feature-probes, inspects, connects, verifies, and records ownership', async () => {
    const fake = statefulHost(null);
    const host = harness({ getResult: fake.getResult, onMutation: fake.onMutation });
    await expect(host.connector.detect()).resolves.toMatchObject({ supported: true });
    const connectionPlan = await host.connector.plan();
    expect(connectionPlan.state).toBe('notConnected');
    await expect(host.connector.connect(connectionPlan)).resolves.toMatchObject({
      state: 'ownedCurrent',
      changed: true,
    });
    expect(host.verify).toHaveBeenCalledOnce();
    expect(fake.entry()).toEqual(expected);
    expect(host.storedReceipt()).toMatchObject({
      connectorId: 'codex',
      scope: 'global',
      commandFingerprint: fingerprintCommand(expected),
    });
    expect(JSON.stringify(host.run.mock.calls)).not.toMatch(/sh -c|bearer|token/iu);
  });

  it('rolls back and records no ownership when installed-route verification fails', async () => {
    const fake = statefulHost(null);
    const host = harness({
      getResult: fake.getResult,
      onMutation: fake.onMutation,
      verificationAvailable: false,
    });
    await expect(host.connector.connect(await host.connector.plan())).rejects.toThrow(
      /verification/iu,
    );
    expect(fake.entry()).toBeNull();
    expect(host.storedReceipt()).toBeNull();
  });

  it('replaces only a reviewed conflict and restores it when verification fails', async () => {
    const previous = recordedEntry({
      exitCode: 0,
      stdoutFixture: 'get-unknown-conflict.json',
    }) as HostEntry;
    const fake = statefulHost('get-unknown-conflict.json');
    const host = harness({
      getResult: fake.getResult,
      onMutation: fake.onMutation,
      verificationAvailable: false,
    });
    await expect(host.connector.plan()).resolves.toMatchObject({
      state: 'conflict',
      mutations: [],
      requiresConflictDecision: true,
    });
    let replacement = await host.connector.plan({ conflictDecision: 'replace' });
    expect(replacement).toMatchObject({
      state: 'conflict',
      conflictDecision: 'replace',
      requiresConflictDecision: false,
      mutations: [{ arguments: ['mcp', 'remove', 'pimpampum'] }, expect.any(Object)],
    });
    // The entry changes between review and connect (another recorded entry): nothing is removed.
    fake.set('get-legacy-npm.json');
    await expect(host.connector.connect(replacement)).rejects.toThrow(/changed/iu);
    expect(
      host.run.mock.calls.filter(
        ([call]) => call.arguments[1] === 'remove' && call.arguments.at(-1) !== '--help',
      ),
    ).toHaveLength(0);
    // Verification fails after the replacement: the reviewed entry comes back.
    fake.set('get-unknown-conflict.json');
    replacement = await host.connector.plan({ conflictDecision: 'replace' });
    await expect(host.connector.connect(replacement)).rejects.toThrow(/verification/iu);
    expect(fake.entry()).toEqual(previous);
  });

  it('spawns at most twelve host processes for one plan, snapshot, and connect', async () => {
    const fake = statefulHost(null);
    const host = harness({ getResult: fake.getResult, onMutation: fake.onMutation });
    // The guided setup plans, snapshots, then connects; count every host process it costs.
    const plan = await host.connector.plan();
    await host.connector.snapshot();
    await expect(host.connector.connect(plan)).resolves.toMatchObject({ changed: true });
    const versionProbes = host.run.mock.calls.filter(([call]) => call.arguments[0] === '--version');
    const helpProbes = host.run.mock.calls.filter(([call]) => call.arguments.at(-1) === '--help');
    expect(versionProbes).toHaveLength(1);
    expect(helpProbes).toHaveLength(4);
    expect(host.run.mock.calls.length + host.verify.mock.calls.length).toBe(11);
    expect(host.run.mock.calls.length + host.verify.mock.calls.length).toBeLessThanOrEqual(12);
  });
});
