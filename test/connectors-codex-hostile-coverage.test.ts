import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCodexConnector,
  parseCodexMcpEntry,
  planCodexConnection,
  type CodexConnectorDependencies,
} from '../src/connectors/codex.js';
import { fingerprintCommand } from '../src/connectors/receipt.js';
import type {
  CommandInvocation,
  ConnectionPlan,
  ConnectionReceipt,
  HostEntry,
} from '../src/connectors/types.js';

const launcher = '/synthetic/runtime/bin/pimpampum-mcp';
const expected: HostEntry = { command: launcher, arguments: [], scope: 'global' };
const temporaryDirectories: string[] = [];

function receipt(entry: HostEntry = expected): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId: 'codex',
    scope: 'global',
    commandFingerprint: fingerprintCommand(entry),
    configuredAt: '2026-08-30T00:00:00.000Z',
    lastVerifiedAt: null,
  };
}

interface CodexHarnessOptions {
  entry?: HostEntry | null;
  getJson?: boolean;
  listJson?: boolean;
  version?: string;
  probeFailure?: boolean;
  mutationFailure?: 'add' | 'remove';
  persistMutations?: boolean;
  verificationAvailable?: boolean;
  storedReceipt?: ConnectionReceipt | null;
}

function createHarness(options: CodexHarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-codex-hostile-'));
  temporaryDirectories.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'codex');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let entry = options.entry === undefined ? null : options.entry;
  let storedReceipt = options.storedReceipt ?? null;
  let persistMutations = options.persistMutations ?? true;
  let mutationFailure = options.mutationFailure;
  const getJson = options.getJson ?? true;
  const listJson = options.listJson ?? false;
  const run = vi.fn(async (invocation: CommandInvocation) => {
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
      storedReceipt = value;
    }),
    remove: vi.fn(async () => {
      storedReceipt = null;
    }),
  };
  const connector = createCodexConnector({
    launcherPath: launcher,
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
    connector,
    executable,
    run,
    receiptStore,
    entry: () => entry,
    setEntry: (value: HostEntry | null) => {
      entry = value;
    },
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

describe('Codex hostile parsing, probes, mutation and rollback coverage', () => {
  it('rejects non-absolute launchers/executables and keeps unreviewed conflicts neutral', () => {
    expect(() =>
      planCodexConnection({
        executable: '/synthetic/codex',
        supported: true,
        launcherPath: 'relative',
        inspection: null,
        receipt: null,
      }),
    ).toThrow(/launcher.*absolute/iu);
    expect(() =>
      planCodexConnection({
        executable: 'relative',
        supported: true,
        launcherPath: launcher,
        inspection: null,
        receipt: null,
      }),
    ).toThrow(/executable.*absolute/iu);
    const conflict: HostEntry = { command: '/synthetic/other', arguments: [], scope: 'global' };
    expect(
      planCodexConnection({
        executable: '/synthetic/codex',
        supported: true,
        launcherPath: launcher,
        inspection: conflict,
        receipt: null,
        conflictDecision: 'keep',
      }),
    ).toMatchObject({ state: 'conflict', conflictDecision: 'keep', mutations: [] });
    expect(
      planCodexConnection({
        executable: '/synthetic/codex',
        supported: true,
        launcherPath: launcher,
        inspection: conflict,
        receipt: null,
        conflictDecision: 'replace',
        reviewedEntryFingerprint: 'changed-after-review',
      }),
    ).toMatchObject({ state: 'conflict', mutations: [] });
    expect(
      planCodexConnection({
        executable: '/synthetic/codex',
        supported: true,
        launcherPath: launcher,
        inspection: { ...conflict, restorable: false },
        receipt: null,
        conflictDecision: 'replace',
      }),
    ).toMatchObject({ state: 'conflict', mutations: [] });
  });

  it('maps every malformed Codex transport to a non-restorable opaque entry', () => {
    expect(parseCodexMcpEntry(null)).toBeNull();
    expect(parseCodexMcpEntry({})).toMatchObject({ restorable: false });
    expect(parseCodexMcpEntry({ transport: { type: 'http', command: launcher } })).toMatchObject({
      restorable: false,
    });
    expect(
      parseCodexMcpEntry({ transport: { type: 'stdio', command: launcher, args: [1] } }),
    ).toMatchObject({ command: '[invalid Codex stdio entry]', restorable: false });
    for (const env of ['KEY=value', [], { PRIVATE: 'synthetic' }]) {
      expect(
        parseCodexMcpEntry({ transport: { type: 'stdio', command: launcher, args: [], env } }),
      ).toMatchObject({
        command: '[Codex stdio entry with private environment]',
        restorable: false,
      });
    }
  });

  it('reports missing and feature-probe-failed installations without inspecting configuration', async () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'pimpampum-codex-missing-'));
    temporaryDirectories.push(missingRoot);
    const missing = createCodexConnector({
      launcherPath: launcher,
      boundedLocations: [missingRoot],
      path: '',
      requiredTools: [],
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      receipt: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(missing.detect()).resolves.toMatchObject({
      executable: null,
      supported: false,
      capabilities: null,
    });
    await expect(missing.inspect()).resolves.toMatchObject({ state: 'notInstalled' });
    await expect(missing.disconnect()).resolves.toMatchObject({
      state: 'notInstalled',
      changed: false,
    });

    const failed = createHarness({ probeFailure: true });
    await expect(failed.connector.detect()).resolves.toMatchObject({
      executable: failed.executable,
      supported: false,
      capabilities: { add: false, remove: false },
    });
    await expect(failed.connector.inspect()).resolves.toMatchObject({
      state: 'unsupportedVersion',
    });
  });

  it('uses bounded list JSON fallback and fails closed on malformed or failing catalogs', async () => {
    const listed = createHarness({ getJson: false, listJson: true, entry: expected });
    await expect(listed.connector.inspect()).resolves.toMatchObject({
      state: 'equivalentUnowned',
      entry: expected,
    });
    listed.setEntry(null);
    await expect(listed.connector.inspect()).resolves.toMatchObject({ state: 'notConnected' });

    // A direct invalid bounded result must not be accepted as a host result.
    const invalid = createHarness();
    invalid.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'codex-cli 0.151.0', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: undefined, stderr: '' } as never);
    await expect(invalid.connector.detect()).rejects.toThrow(/invalid bounded command result/iu);
  });

  it('verifies/adopts an equivalent entry while preserving the original configuredAt receipt', async () => {
    const previous = receipt(expected);
    const harness = createHarness({ entry: expected, storedReceipt: previous });
    const plan = await harness.connector.plan();
    await expect(harness.connector.connect(plan)).resolves.toMatchObject({
      state: 'ownedCurrent',
      changed: false,
      verification: { available: true },
    });
    expect(harness.storedReceipt()?.configuredAt).toBe(previous.configuredAt);
    await expect(harness.connector.verify()).resolves.toMatchObject({
      connectorId: 'codex',
      verifiedAt: '2026-08-31T00:00:00.000Z',
    });
  });

  it('rejects wrong, stale, neutral, and non-persisted reviewed plans without recording ownership', async () => {
    const harness = createHarness();
    const plan = await harness.connector.plan();
    await expect(
      harness.connector.connect({ ...plan, connectorId: 'claude-code' }),
    ).rejects.toThrow(/not for Codex/iu);
    await expect(
      harness.connector.connect({ ...plan, summary: 'tampered after review' }),
    ).rejects.toThrow(/changed after.*reviewed/iu);

    const unavailablePlan: ConnectionPlan = {
      ...plan,
      state: 'unavailable',
      mutations: [],
    };
    // The mismatch is caught before a neutral state can mutate.
    await expect(harness.connector.connect(unavailablePlan)).rejects.toThrow(/changed/iu);

    const nonPersisted = createHarness({ persistMutations: false });
    await expect(
      nonPersisted.connector.connect(await nonPersisted.connector.plan()),
    ).rejects.toThrow(/did not persist/iu);
    expect(nonPersisted.storedReceipt()).toBeNull();
  });

  it('rolls back mutation rejection and restores a prior receipt best-effort', async () => {
    const previous = receipt(expected);
    const legacy: HostEntry = {
      command: 'npx',
      arguments: ['pimpampum', 'mcp'],
      scope: 'global',
    };
    const harness = createHarness({
      entry: legacy,
      storedReceipt: { ...previous, commandFingerprint: fingerprintCommand(legacy) },
      mutationFailure: 'add',
    });
    const plan = await harness.connector.plan();
    await expect(harness.connector.repair(plan)).rejects.toThrow(/rejected/iu);
    expect(harness.storedReceipt()?.configuredAt).toBe(previous.configuredAt);
  });

  it('disconnects only owned entries and reports failed official removal', async () => {
    const unowned = createHarness({ entry: expected });
    await expect(unowned.connector.disconnect()).resolves.toMatchObject({
      state: 'equivalentUnowned',
      changed: false,
    });
    expect(unowned.entry()).toEqual(expected);

    const owned = createHarness({ entry: expected, storedReceipt: receipt() });
    await expect(owned.connector.disconnect()).resolves.toMatchObject({
      state: 'notConnected',
      changed: true,
    });
    expect(owned.entry()).toBeNull();
    expect(owned.storedReceipt()).toBeNull();

    const rejected = createHarness({
      entry: expected,
      storedReceipt: receipt(),
      mutationFailure: 'remove',
    });
    await expect(rejected.connector.disconnect()).rejects.toThrow(/could not remove/iu);
    expect(rejected.entry()).toEqual(expected);
  });

  it('restores absent/current/prior entries and refuses unavailable, opaque, or concurrent targets', async () => {
    const current = createHarness({ entry: expected, storedReceipt: receipt() });
    await expect(
      current.connector.restore(await current.connector.snapshot()),
    ).resolves.toBeUndefined();
    await expect(
      current.connector.restore({ connectorId: 'codex', revision: null, entry: null }),
    ).resolves.toBeUndefined();
    expect(current.entry()).toBeNull();

    const prior: HostEntry = {
      command: '/synthetic/prior-mcp',
      arguments: ['--safe'],
      scope: 'global',
    };
    const restorePrior = createHarness({ entry: expected });
    await expect(
      restorePrior.connector.restore({ connectorId: 'codex', revision: null, entry: prior }),
    ).resolves.toBeUndefined();
    expect(restorePrior.entry()).toEqual(prior);

    const concurrent = createHarness({ entry: prior });
    await expect(
      concurrent.connector.restore({ connectorId: 'codex', revision: null, entry: expected }),
    ).rejects.toThrow(/concurrently/iu);
    const opaque = createHarness({ entry: expected });
    await expect(
      opaque.connector.restore({
        connectorId: 'codex',
        revision: null,
        entry: { ...prior, restorable: false },
      }),
    ).rejects.toThrow(/cannot safely restore/iu);
  });
});
