import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClaudeCodeConnector,
  planClaudeCodeConnection,
  type ClaudeCodeConnectorOptions,
} from '../src/connectors/claudeCode.js';
import { fingerprintCommand } from '../src/connectors/receipt.js';
import type {
  CommandInvocation,
  ConnectionReceipt,
  ConnectorVerification,
  HostEntry,
} from '../src/connectors/types.js';

const launcher = '/synthetic/runtime/bin/pimpampum-mcp';
const expected: HostEntry = { command: launcher, arguments: [], scope: 'user' };
const temporaryDirectories: string[] = [];

function receipt(entry: HostEntry = expected): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId: 'claude-code',
    scope: 'user',
    commandFingerprint: fingerprintCommand(entry),
    configuredAt: '2026-08-30T00:00:00.000Z',
    lastVerifiedAt: null,
  };
}

function verification(
  available = true,
  verifiedAt: string | null = '2026-08-31T00:00:00.000Z',
): ConnectorVerification {
  return {
    connectorId: 'claude-code',
    available,
    verifiedAt,
    serverName: available ? 'pimpampum' : null,
    tools: available ? ['project_list'] : [],
    diagnostics: [],
  };
}

interface ClaudeHarnessOptions {
  target?: unknown;
  configValue?: unknown;
  inspectJson?: boolean;
  jsonResult?: { exitCode: number; stdout: string; stderr: string };
  version?: string;
  versionExitCode?: number;
  probeFailure?: boolean;
  mutationFailure?: 'add' | 'remove';
  persistMutations?: boolean;
  verification?: ConnectorVerification;
  storedReceipt?: ConnectionReceipt | null;
  higherPrecedenceTarget?: unknown;
}

function createHarness(options: ClaudeHarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-claude-hostile-'));
  temporaryDirectories.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'claude');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
  const writeTarget = (target: unknown) => {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const servers =
      typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null
        ? ({ ...parsed.mcpServers } as Record<string, unknown>)
        : {};
    if (target === undefined) delete servers.pimpampum;
    else servers.pimpampum = target;
    writeFileSync(configPath, JSON.stringify({ ...parsed, mcpServers: servers }), { mode: 0o600 });
  };
  const run = vi.fn(async (invocation: CommandInvocation) => {
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
    launcherPath: launcher,
    userConfigPath: configPath,
    boundedExecutableLocations: [bin],
    pathValue: bin,
    ...(options.higherPrecedenceTarget === undefined
      ? {}
      : { higherPrecedenceConfigSources: [{ path: higherPath, scope: 'project' }] }),
    runCommand: run,
    now: () => '2026-08-31T01:00:00.000Z',
    verifyRoute: async () => options.verification ?? verification(),
    receiptStore,
  });
  return {
    connector,
    executable,
    configPath,
    run,
    receiptStore,
    readTarget,
    writeTarget,
    storedReceipt: () => storedReceipt,
    setPersistMutations: (value: boolean) => {
      persistMutations = value;
    },
    setMutationFailure: (value: 'add' | 'remove' | undefined) => {
      mutationFailure = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Claude Code hostile parsing, probes, mutation and rollback coverage', () => {
  it('rejects relative/NUL construction paths and scoped config paths', () => {
    const store = {
      read: async () => null,
      write: async () => undefined,
      remove: async () => undefined,
    };
    expect(() =>
      createClaudeCodeConnector({
        launcherPath: 'relative',
        userConfigPath: '/synthetic/config',
        receiptStore: store,
      }),
    ).toThrow(/launcher.*absolute/iu);
    expect(() =>
      createClaudeCodeConnector({
        launcherPath: launcher,
        userConfigPath: 'relative',
        receiptStore: store,
      }),
    ).toThrow(/config.*absolute/iu);
    expect(() =>
      createClaudeCodeConnector({
        launcherPath: launcher,
        userConfigPath: '/synthetic/config',
        higherPrecedenceConfigSources: [{ path: 'relative', scope: 'local' }],
        receiptStore: store,
      }),
    ).toThrow(/scoped config.*absolute/iu);
  });

  it('keeps opaque, changed-review, keep, and cancel conflicts mutation-free', () => {
    const conflict: HostEntry = { command: '/synthetic/other', arguments: [], scope: 'user' };
    const plan = (
      entry: HostEntry,
      decision: 'keep' | 'replace' | 'cancel',
      fingerprint?: string,
    ) =>
      planClaudeCodeConnection({
        executable: '/synthetic/claude',
        supported: true,
        launcherPath: launcher,
        inspection: entry,
        higherPrecedenceEntry: null,
        receipt: null,
        conflictDecision: decision,
        ...(fingerprint === undefined ? {} : { reviewedEntryFingerprint: fingerprint }),
      });
    expect(plan(conflict, 'keep')).toMatchObject({ conflictDecision: 'keep', mutations: [] });
    expect(plan(conflict, 'cancel')).toMatchObject({ conflictDecision: 'cancel', mutations: [] });
    expect(plan(conflict, 'replace', 'changed')).toMatchObject({ mutations: [] });
    expect(plan({ ...conflict, restorable: false }, 'replace')).toMatchObject({ mutations: [] });
    expect(() =>
      planClaudeCodeConnection({
        executable: 'relative',
        supported: true,
        launcherPath: launcher,
        inspection: null,
        higherPrecedenceEntry: null,
        receipt: null,
      }),
    ).toThrow(/executable.*absolute/iu);
  });

  it('detects absent, probe-failed, and unrecognized versions without trusting config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-claude-missing-'));
    temporaryDirectories.push(root);
    const missing = createClaudeCodeConnector({
      launcherPath: launcher,
      userConfigPath: join(root, 'missing.json'),
      boundedExecutableLocations: [root],
      pathValue: '',
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', signal: null }),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(missing.detect()).resolves.toMatchObject({ executable: null, supported: false });
    await expect(missing.inspect()).resolves.toMatchObject({ state: 'notInstalled' });
    await expect(missing.connect(await missing.plan())).resolves.toMatchObject({
      state: 'notInstalled',
      changed: false,
    });
    await expect(
      missing.restore({ connectorId: 'claude-code', revision: null, entry: null }),
    ).rejects.toThrow(/unavailable/iu);

    const failed = createHarness({ probeFailure: true });
    await expect(failed.connector.detect()).resolves.toMatchObject({
      executable: failed.executable,
      version: null,
      supported: false,
      capabilities: null,
    });
    const unrecognized = createHarness({ version: 'Claude Code development build' });
    await expect(unrecognized.connector.detect()).resolves.toMatchObject({
      version: null,
      supported: false,
      capabilities: { scopes: ['user'] },
    });
  });

  it('uses JSON inspection when valid and bounded config fallback when JSON fails', async () => {
    const json = createHarness({
      inspectJson: true,
      target: { command: '/synthetic/config-value', args: [] },
      jsonResult: {
        exitCode: 0,
        stdout: JSON.stringify({ type: 'stdio', command: launcher, args: [], env: {} }),
        stderr: '',
      },
    });
    await expect(json.connector.detect()).resolves.toMatchObject({
      capabilities: { inspect: 'json' },
    });
    await expect(json.connector.inspect()).resolves.toMatchObject({
      state: 'equivalentUnowned',
      entry: expected,
    });

    const malformed = createHarness({
      inspectJson: true,
      target: { command: launcher, args: [], env: {} },
      jsonResult: { exitCode: 0, stdout: '{bad-json', stderr: '' },
    });
    await expect(malformed.connector.inspect()).resolves.toMatchObject({
      state: 'equivalentUnowned',
      entry: expected,
    });
    const failed = createHarness({
      inspectJson: true,
      target: { command: launcher, args: [], env: {} },
      jsonResult: { exitCode: 1, stdout: '', stderr: 'synthetic failure' },
    });
    await expect(failed.connector.inspect()).resolves.toMatchObject({ state: 'equivalentUnowned' });
  });

  it('maps malformed config target shapes and wrong receipts to unavailable or opaque conflict', async () => {
    const malformedValues: unknown[] = [
      [],
      { mcpServers: [] },
      { mcpServers: { pimpampum: 1 } },
      { mcpServers: { pimpampum: { type: 'http', command: launcher } } },
      { mcpServers: { pimpampum: { command: '' } } },
      { mcpServers: { pimpampum: { command: launcher, args: 'bad' } } },
      { mcpServers: { pimpampum: { command: launcher, args: ['bad\0argument'] } } },
      { mcpServers: { pimpampum: { command: launcher, env: { PRIVATE: 'synthetic' } } } },
    ];
    for (const configValue of malformedValues) {
      const harness = createHarness({ configValue });
      await expect(harness.connector.inspect()).resolves.toMatchObject({ state: 'conflict' });
      await expect(harness.connector.plan({ conflictDecision: 'replace' })).resolves.toMatchObject({
        state: 'conflict',
        mutations: [],
      });
    }
    const wrongReceipt = createHarness({
      storedReceipt: { ...receipt(), connectorId: 'codex', scope: 'global' },
    });
    await expect(wrongReceipt.connector.inspect()).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('fails closed for symlinked and higher-precedence configuration targets', async () => {
    const harness = createHarness();
    const victim = join(temporaryDirectories.at(-1)!, 'victim.json');
    writeFileSync(victim, JSON.stringify({ mcpServers: {} }));
    rmSync(harness.configPath);
    symlinkSync(victim, harness.configPath);
    await expect(harness.connector.inspect()).resolves.toMatchObject({ state: 'unavailable' });

    const higher = createHarness({
      higherPrecedenceTarget: { type: 'stdio', command: launcher, args: [], env: {} },
    });
    await expect(higher.connector.inspect()).resolves.toMatchObject({
      state: 'conflict',
      higherPrecedenceEntry: { scope: 'project' },
    });
  });

  it('adopts an equivalent route and preserves receipt time when verification has no timestamp', async () => {
    const previous = receipt();
    const harness = createHarness({
      target: { type: 'stdio', command: launcher, args: [], env: {} },
      storedReceipt: previous,
      verification: verification(true, null),
    });
    await expect(harness.connector.connect(await harness.connector.plan())).resolves.toMatchObject({
      state: 'ownedCurrent',
      changed: false,
    });
    expect(harness.storedReceipt()).toMatchObject({
      configuredAt: previous.configuredAt,
      lastVerifiedAt: '2026-08-31T01:00:00.000Z',
    });
  });

  it('rejects tampered plans, failed mutations, and non-persisted writes with rollback', async () => {
    const tampered = createHarness();
    const plan = await tampered.connector.plan();
    await expect(
      tampered.connector.connect({ ...plan, summary: 'tampered after review' }),
    ).rejects.toThrow(/changed after.*reviewed/iu);

    const rejected = createHarness({ mutationFailure: 'add' });
    await expect(rejected.connector.connect(await rejected.connector.plan())).rejects.toThrow(
      /mutation failed/iu,
    );
    expect(rejected.storedReceipt()).toBeNull();

    const nonPersisted = createHarness({ persistMutations: false });
    await expect(
      nonPersisted.connector.connect(await nonPersisted.connector.plan()),
    ).rejects.toThrow(/did not persist/iu);
    expect(nonPersisted.readTarget()).toBeUndefined();
  });

  it('disconnects owned entries, preserves unowned entries, and rolls back incomplete removal', async () => {
    const unowned = createHarness({ target: { command: launcher, args: [], env: {} } });
    await expect(unowned.connector.disconnect()).resolves.toMatchObject({
      state: 'equivalentUnowned',
      changed: false,
    });

    const owned = createHarness({
      target: { command: launcher, args: [], env: {} },
      storedReceipt: receipt(),
    });
    await expect(owned.connector.disconnect()).resolves.toMatchObject({
      state: 'notConnected',
      changed: true,
    });
    expect(owned.readTarget()).toBeUndefined();

    const incomplete = createHarness({
      target: { command: launcher, args: [], env: {} },
      storedReceipt: receipt(),
      persistMutations: false,
    });
    await expect(incomplete.connector.disconnect()).rejects.toThrow(/did not remove/iu);
    expect(incomplete.readTarget()).toEqual({ command: launcher, args: [], env: {} });

    const rejected = createHarness({
      target: { command: launcher, args: [], env: {} },
      storedReceipt: receipt(),
      mutationFailure: 'remove',
    });
    await expect(rejected.connector.disconnect()).rejects.toThrow(/mutation failed/iu);
  });

  it('restores only matching user snapshots and rejects unowned/concurrent/opaque restoration', async () => {
    const empty = createHarness();
    await expect(
      empty.connector.restore({ connectorId: 'codex', revision: null, entry: null }),
    ).rejects.toThrow(/mismatch/iu);
    await expect(
      empty.connector.restore({ connectorId: 'claude-code', revision: null, entry: null }),
    ).resolves.toBeUndefined();
    await expect(
      empty.connector.restore({
        connectorId: 'claude-code',
        revision: null,
        entry: { command: '/synthetic/prior', arguments: [], scope: 'project' },
      }),
    ).rejects.toThrow(/user-scoped/iu);

    const unowned = createHarness({ target: { command: '/synthetic/unowned', args: [] } });
    await expect(
      unowned.connector.restore({ connectorId: 'claude-code', revision: null, entry: null }),
    ).rejects.toThrow(/unowned/iu);

    const concurrent = createHarness({ target: { command: '/synthetic/concurrent', args: [] } });
    await expect(
      concurrent.connector.restore({
        connectorId: 'claude-code',
        revision: null,
        entry: { command: '/synthetic/prior', arguments: [], scope: 'user' },
      }),
    ).rejects.toThrow(/concurrently/iu);

    const opaque = createHarness({ target: { command: launcher, args: [] } });
    await expect(
      opaque.connector.restore({
        connectorId: 'claude-code',
        revision: null,
        entry: {
          command: '/synthetic/prior',
          arguments: [],
          scope: 'user',
          restorable: false,
        },
      }),
    ).rejects.toThrow(/cannot safely restore/iu);
  });

  it('restores a prior target, removes an owned target for empty snapshots, and is idempotent', async () => {
    const prior: HostEntry = {
      command: '/synthetic/prior',
      arguments: ['--safe'],
      scope: 'user',
    };
    const restore = createHarness({ target: { command: launcher, args: [] } });
    await expect(
      restore.connector.restore({ connectorId: 'claude-code', revision: null, entry: prior }),
    ).resolves.toBeUndefined();
    expect(restore.readTarget()).toEqual({
      type: 'stdio',
      command: prior.command,
      args: prior.arguments,
      env: {},
    });
    await expect(
      restore.connector.restore({ connectorId: 'claude-code', revision: null, entry: prior }),
    ).resolves.toBeUndefined();

    const remove = createHarness({
      target: { command: launcher, args: [] },
      storedReceipt: receipt(),
    });
    await expect(
      remove.connector.restore({ connectorId: 'claude-code', revision: null, entry: null }),
    ).resolves.toBeUndefined();
    expect(remove.readTarget()).toBeUndefined();
  });
});
