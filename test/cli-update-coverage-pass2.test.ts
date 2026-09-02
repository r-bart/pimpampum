import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliConnectionsRuntime, runCli, type CliRuntime } from '../src/cliProgram.js';
import type {
  ConnectionPlan,
  ConnectorInspection,
  ConnectorState,
  HostConnector,
} from '../src/connectors/types.js';
import { installedApplicationPath, readRecordedApplicationPath } from '../src/runtime/bootstrap.js';
import {
  createPackagedReleaseUpdateManager,
  createUpdateManager,
  type PackagedReleaseProviderInput,
  type UpdateInstallReceiptMetadata,
} from '../src/update.js';

function plan(
  state: ConnectorState = 'notConnected',
  mutations: ConnectionPlan['mutations'] = [{ executable: '/host', arguments: [] }],
): ConnectionPlan {
  return {
    connectorId: 'codex',
    state,
    selectedByDefault: true,
    mutations,
    requiresConflictDecision: state === 'conflict',
    newSessionRequired: false,
    approvalPolicy: 'hostDefault',
    summary: 'fixture plan',
  };
}

function connector(
  input: {
    state?: ConnectorState;
    verify?: () => Promise<boolean>;
    mutations?: ConnectionPlan['mutations'];
  } = {},
): HostConnector {
  const state = input.state ?? 'notConnected';
  return {
    id: 'codex',
    displayName: 'Codex',
    inspect: vi.fn(
      async () =>
        ({
          connectorId: 'codex',
          state,
          entry: null,
          entryFingerprint: null,
          higherPrecedenceEntry: null,
          receipt: null,
        }) satisfies ConnectorInspection,
    ),
    plan: vi.fn(async () => plan(state, input.mutations)),
    connect: vi.fn(async () => ({
      connectorId: 'codex',
      state: 'ownedCurrent',
      changed: true,
      verification: null,
    })),
    repair: vi.fn(async () => ({
      connectorId: 'codex',
      state: 'ownedCurrent',
      changed: true,
      verification: null,
    })),
    disconnect: vi.fn(async () => ({
      connectorId: 'codex',
      state: 'notConnected',
      changed: true,
      verification: null,
    })),
    verify: vi.fn(async () => ({
      connectorId: 'codex',
      available: await (input.verify?.() ?? Promise.resolve(false)),
      verifiedAt: null,
      serverName: null,
      tools: [],
      diagnostics: [],
    })),
  } as unknown as HostConnector;
}

function cliFixture(connections?: CliRuntime['connections']) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime = {
    connections,
    stdout: (value: string) => stdout.push(value),
    stderr: (value: string) => stderr.push(value),
    exit: vi.fn(() => undefined as never),
  } as unknown as CliRuntime;
  return { runtime, stdout, stderr };
}

function packagedProvider(
  overrides: Partial<PackagedReleaseProviderInput> = {},
): PackagedReleaseProviderInput {
  return {
    channelManifestUrl: 'https://updates.example.test/stable.json',
    target: 'darwin-arm64',
    fetchManifest: async () =>
      JSON.stringify({
        schemaVersion: 1,
        channel: 'stable',
        issuedAt: '2026-09-01T12:00:00.000Z',
        version: '2.0.0',
        targets: {
          'darwin-arm64': {
            url: 'https://updates.example.test/v2.0.0/pimpampum-darwin-arm64.zip',
            sha256: 'a'.repeat(64),
            signature: 'b'.repeat(64),
            size: 1024,
          },
        },
      }),
    verifySignature: async () => true,
    stageCandidate: async () => ({
      path: '/private/tmp/pimpampum-update/candidate',
      sha256: 'a'.repeat(64),
      size: 1024,
      contains: { app: true, runtime: true, plugin: true },
    }),
    reconcile: async () => undefined,
    ...overrides,
  };
}

describe('CLI setup and connection boundary coverage', () => {
  it('lists verified, failed verification, and unverified connector states', async () => {
    const verified = connector({ state: 'ownedCurrent', verify: async () => true });
    const failed = connector({
      state: 'equivalentUnowned',
      verify: async () => Promise.reject(new Error('offline')),
    });
    const skipped = connector({ state: 'conflict' });
    const runtime = createCliConnectionsRuntime({
      connectors: [verified, failed, skipped],
      launcherPath: '/private/pimpampum-mcp',
    });

    await expect(runtime.list()).resolves.toEqual([
      expect.objectContaining({ state: 'ownedCurrent', available: true, revision: null }),
      expect.objectContaining({ state: 'equivalentUnowned', available: false, revision: null }),
      expect.objectContaining({ state: 'conflict', available: false, revision: null }),
    ]);
    expect(skipped.verify).not.toHaveBeenCalled();
    await expect(runtime.instructions()).resolves.toMatchObject({
      command: '/private/pimpampum-mcp',
      tokenIncluded: false,
    });
  });

  it('covers confirmation, lookup, repair, disconnect, and unrestorable conflict branches', async () => {
    const ordinary = connector();
    const runtime = createCliConnectionsRuntime({
      connectors: [ordinary],
      launcherPath: '/private/pimpampum-mcp',
    });

    await expect(
      runtime.connect('codex', { confirmed: false, conflictDecision: undefined }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(runtime.disconnect('codex', { confirmed: false })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(
      runtime.connect('claude-code', { confirmed: true, conflictDecision: undefined }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      runtime.repair('codex', { confirmed: true, conflictDecision: undefined }),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      runtime.connect('codex', { confirmed: true, conflictDecision: undefined }),
    ).resolves.toMatchObject({ changed: true });
    await expect(runtime.disconnect('codex', { confirmed: true })).resolves.toEqual({
      id: 'codex',
      disconnected: true,
      state: 'notConnected',
      dataPreserved: true,
    });

    const conflict = connector({ state: 'conflict', mutations: [] });
    const conflictRuntime = createCliConnectionsRuntime({
      connectors: [conflict],
      launcherPath: '/private/pimpampum-mcp',
    });
    await expect(
      conflictRuntime.connect('codex', { confirmed: true, conflictDecision: 'replace' }),
    ).rejects.toThrow(/cannot be restored safely/iu);
    await expect(
      conflictRuntime.connect('codex', { confirmed: true, conflictDecision: undefined }),
    ).rejects.toThrow(/explicit replacement decision/iu);
  });

  it.each([
    ['connections', 'unexpected'],
    ['connect', '--instructions', 'codex'],
    ['connect', '--instructions', '--yes'],
    ['connect', '--instructions', '--replace'],
    ['connect', 'invalid', '--yes'],
  ])('rejects malformed connection invocation %#', async (...arguments_: string[]) => {
    const state = cliFixture({
      list: vi.fn(),
      connect: vi.fn(),
      repair: vi.fn(),
      disconnect: vi.fn(),
      instructions: vi.fn(),
    });
    await runCli(arguments_, state.runtime);
    expect(state.runtime.exit).toHaveBeenCalledWith(1);
    expect(state.stderr).toHaveLength(1);
  });

  it('accepts the standalone connection instructions mode', async () => {
    const instructions = vi.fn(async () => ({ transport: 'stdio' }));
    const state = cliFixture({
      list: vi.fn(),
      connect: vi.fn(),
      repair: vi.fn(),
      disconnect: vi.fn(),
      instructions,
    });
    await runCli(['connect', '--instructions'], state.runtime);
    expect(instructions).toHaveBeenCalledOnce();
    expect(state.runtime.exit).not.toHaveBeenCalled();
  });

  // Only the `code` property selects an agent error code. A message that mentions a conflict is a
  // diagnostic, not a classification, so it stays `internal_error` with its cause chain.
  it('maps typed local codes and never classifies by message text', async () => {
    for (const [failure, expectedCode] of [
      [new Error('ordinary failure'), 'internal_error'],
      [new Error(''), 'internal_error'],
      ['primitive failure', 'internal_error'],
      [new Error('requires a decision'), 'internal_error'],
      [new Error('conflict detected'), 'internal_error'],
      [{ code: 'CONNECTOR_CONFLICT' }, 'conflict'],
      [Object.assign(new Error(''), { code: 'CONNECTOR_CONFLICT' }), 'conflict'],
      [Object.assign(new Error('stale'), { code: 'SETUP_PLAN_STALE' }), 'conflict'],
      [Object.assign(new Error('confirm'), { code: 'SETUP_CONFIRMATION_REQUIRED' }), 'bad_request'],
      [Object.assign(new Error('none'), { code: 'SETUP_NOTHING_TO_RESUME' }), 'not_found'],
    ] as const) {
      const state = cliFixture({
        list: vi.fn(async () => Promise.reject(failure)),
        connect: vi.fn(),
        repair: vi.fn(),
        disconnect: vi.fn(),
        instructions: vi.fn(),
      });
      await runCli(['connections'], state.runtime);
      expect(JSON.parse(state.stderr[0]!) as { error: { code: string } }).toMatchObject({
        error: { code: expectedCode },
      });
    }
  });

  it('covers unavailable connection management and both repair decision branches', async () => {
    const unavailable = cliFixture();
    await runCli(['connections'], unavailable.runtime);
    expect(unavailable.stderr.join('')).toContain('Connection management is unavailable');

    const repair = vi.fn(async () => ({}));
    for (const arguments_ of [
      ['repair', 'codex', '--yes'],
      ['repair', 'codex', '--yes', '--replace'],
    ]) {
      const state = cliFixture({
        list: vi.fn(),
        connect: vi.fn(),
        repair,
        disconnect: vi.fn(),
        instructions: vi.fn(),
      });
      await runCli(arguments_, state.runtime);
    }
    expect(repair).toHaveBeenNthCalledWith(1, 'codex', {
      confirmed: true,
      conflictDecision: undefined,
    });
    expect(repair).toHaveBeenNthCalledWith(2, 'codex', {
      confirmed: true,
      conflictDecision: 'replace',
    });
  });
});

describe('reviewed replacement revision', () => {
  const revision = 'b'.repeat(64);

  it('forwards --replace with and without a revision from connect and repair', async () => {
    const connect = vi.fn(async () => ({}));
    const repair = vi.fn(async () => ({}));
    const connections = {
      list: vi.fn(),
      connect,
      repair,
      disconnect: vi.fn(),
      instructions: vi.fn(),
    };
    for (const arguments_ of [
      ['connect', 'codex', '--yes', '--replace', revision],
      ['connect', 'codex', '--yes', '--replace'],
      ['repair', 'codex', '--yes', '--replace', revision],
      ['repair', 'codex', '--yes'],
    ]) {
      const state = cliFixture(connections);
      await runCli(arguments_, state.runtime);
      expect(state.stderr, arguments_.join(' ')).toEqual([]);
    }
    expect(connect).toHaveBeenNthCalledWith(1, 'codex', {
      confirmed: true,
      conflictDecision: 'replace',
      reviewedEntryFingerprint: revision,
    });
    expect(connect).toHaveBeenNthCalledWith(2, 'codex', {
      confirmed: true,
      conflictDecision: 'replace',
    });
    expect(repair).toHaveBeenNthCalledWith(1, 'codex', {
      confirmed: true,
      conflictDecision: 'replace',
      reviewedEntryFingerprint: revision,
    });
    expect(repair).toHaveBeenNthCalledWith(2, 'codex', {
      confirmed: true,
      conflictDecision: undefined,
    });
  });

  it('passes the reviewed revision into the connector plan', async () => {
    const host = connector({ state: 'conflict' });
    const runtime = createCliConnectionsRuntime({ connectors: [host], launcherPath: '/launcher' });

    await runtime.connect('codex', {
      confirmed: true,
      conflictDecision: 'replace',
      reviewedEntryFingerprint: revision,
    });
    await runtime.repair('codex', { confirmed: true, conflictDecision: 'replace' });

    expect(host.plan).toHaveBeenNthCalledWith(1, {
      conflictDecision: 'replace',
      reviewedEntryFingerprint: revision,
    });
    expect(host.plan).toHaveBeenNthCalledWith(2, { conflictDecision: 'replace' });
  });

  it('reports the entry fingerprint as the revision a reviewer passes back', async () => {
    const host = connector({ state: 'conflict' });
    (host.inspect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      connectorId: 'codex',
      state: 'conflict',
      entry: null,
      entryFingerprint: revision,
      higherPrecedenceEntry: null,
      receipt: null,
    });
    const runtime = createCliConnectionsRuntime({ connectors: [host], launcherPath: '/launcher' });
    await expect(runtime.list()).resolves.toEqual([
      { id: 'codex', displayName: 'Codex', state: 'conflict', revision, available: false },
    ]);
  });
});

describe('packaged update residual boundary coverage', () => {
  it.each([null, `https://updates.example.test/v2.0.0/pimpampum-darwin-arm64.zip\0`])(
    'rejects a non-string or NUL asset URL %#',
    async (url) => {
      const provider = packagedProvider({
        fetchManifest: async () => {
          const raw = await packagedProvider().fetchManifest({
            url: '',
            maximumBytes: 1,
            timeoutMilliseconds: 1,
          });
          const manifest = JSON.parse(
            typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'),
          ) as { targets: { 'darwin-arm64': { url: unknown } } };
          manifest.targets['darwin-arm64'].url = url;
          return JSON.stringify(manifest);
        },
      });
      await expect(
        createPackagedReleaseUpdateManager({ currentVersion: '1.0.0', provider }).check(),
      ).rejects.toThrow(/invalid asset URL/iu);
    },
  );

  it('rejects a non-byte manifest response', async () => {
    const provider = packagedProvider({
      fetchManifest: async () => ({ invalid: true }) as unknown as string,
    });
    await expect(
      createPackagedReleaseUpdateManager({ currentVersion: '1.0.0', provider }).check(),
    ).rejects.toThrow(/response is invalid/iu);
  });

  it('accepts a bounded Uint8Array manifest response', async () => {
    const baseline = packagedProvider();
    const provider = packagedProvider({
      fetchManifest: async (input) => Buffer.from(await baseline.fetchManifest(input)),
    });
    await expect(
      createPackagedReleaseUpdateManager({ currentVersion: '1.0.0', provider }).check(),
    ).resolves.toMatchObject({ latestVersion: '2.0.0', updateAvailable: true });
  });

  it('returns without staging when the packaged version is not newer', async () => {
    const stageCandidate = vi.fn();
    const reconcile = vi.fn();
    const manager = createPackagedReleaseUpdateManager({
      currentVersion: '2.0.0',
      provider: packagedProvider({ stageCandidate, reconcile }),
    });
    await expect(manager.update()).resolves.toEqual({
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
      updateAvailable: false,
      updated: false,
      installedVersion: '2.0.0',
      serviceReconciled: false,
    });
    expect(stageCandidate).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    { schemaVersion: 2, adapter: 'systemd' },
    { schemaVersion: 1, adapter: '' },
    { schemaVersion: 1, adapter: 'systemd', updateProvider: 'other' },
    {
      schemaVersion: 1,
      adapter: 'systemd',
      packagedRuntime: { version: 'latest', target: 'linux-x64', runtimeDirectory: '/runtime' },
    },
    {
      schemaVersion: 1,
      adapter: 'systemd',
      packagedRuntime: { version: '1.0.0', target: 'win32-x64', runtimeDirectory: '/runtime' },
    },
    {
      schemaVersion: 1,
      adapter: 'systemd',
      packagedRuntime: { version: '1.0.0', target: 'linux-x64', runtimeDirectory: 'relative' },
    },
  ])('rejects incompatible receipt metadata %#', (installReceipt) => {
    expect(() =>
      createUpdateManager({
        currentVersion: '1.0.0',
        npmPath: '/npm',
        nodePath: '/node',
        runCommand: vi.fn(),
        installReceipt: installReceipt as UpdateInstallReceiptMetadata,
      }),
    ).toThrow(/receipt schema is incompatible/iu);
  });

  it('honors an explicit legacy npm receipt instead of a packaged provider', async () => {
    const packagedRelease = packagedProvider();
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: '"1.0.0"', stderr: '' }));
    const manager = createUpdateManager({
      currentVersion: '1.0.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand,
      installReceipt: { schemaVersion: 1, adapter: 'systemd', updateProvider: 'legacy-npm' },
      packagedRelease,
    });
    await expect(manager.check()).resolves.toMatchObject({ updateAvailable: false });
    expect(runCommand).toHaveBeenCalled();
  });

  it('selects legacy without a receipt and packaged mode for valid absolute runtime metadata', async () => {
    const legacyCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: '"1.0.0"',
      stderr: '',
    }));
    await expect(
      createUpdateManager({
        currentVersion: '1.0.0',
        npmPath: '/npm',
        nodePath: '/node',
        runCommand: legacyCommand,
      }).check(),
    ).resolves.toMatchObject({ updateAvailable: false });

    const packaged = createUpdateManager({
      currentVersion: '1.0.0',
      npmPath: null,
      nodePath: '/node',
      runCommand: vi.fn(),
      installReceipt: {
        schemaVersion: 1,
        adapter: 'systemd',
        packagedRuntime: {
          version: '1.0.0',
          target: 'darwin-arm64',
          runtimeDirectory: '/private/runtime',
        },
      },
      packagedRelease: packagedProvider(),
    });
    await expect(packaged.check()).resolves.toMatchObject({ updateAvailable: true });
  });
});

describe('recorded application path', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function dataDirectory(): string {
    root = mkdtempSync(join(tmpdir(), 'pimpampum-application-path-'));
    return root;
  }

  function record(directory: string, value: unknown): void {
    writeFileSync(
      join(directory, 'application-path.json'),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }

  it('reads schema 2 and schema 1 records and normalizes the path', () => {
    const directory = dataDirectory();
    record(directory, { schemaVersion: 2, path: '/Applications//Pimpampum.app', managed: false });
    expect(readRecordedApplicationPath(directory)).toBe('/Applications/Pimpampum.app');
    expect(installedApplicationPath({ homeDirectory: '/Users/me', dataDirectory: directory })).toBe(
      '/Applications/Pimpampum.app',
    );

    record(directory, { schemaVersion: 1, path: '/Users/me/Applications/Pimpampum.app' });
    expect(readRecordedApplicationPath(directory)).toBe('/Users/me/Applications/Pimpampum.app');
  });

  it('falls back to the managed path when no record exists', () => {
    const directory = dataDirectory();
    expect(readRecordedApplicationPath(directory)).toBeNull();
    expect(installedApplicationPath({ homeDirectory: '/Users/me', dataDirectory: directory })).toBe(
      '/Users/me/Applications/Pimpampum.app',
    );
  });

  it.each([
    [
      'a symlink',
      (directory: string) => symlinkSync('/etc/hosts', join(directory, 'application-path.json')),
    ],
    ['a directory', (directory: string) => mkdirSync(join(directory, 'application-path.json'))],
    ['an oversized file', (directory: string) => record(directory, 'x'.repeat(16 * 1024 + 1))],
    ['invalid JSON', (directory: string) => record(directory, '{not json')],
    ['an array', (directory: string) => record(directory, ['/Applications/Pimpampum.app'])],
    [
      'an unknown schema',
      (directory: string) => record(directory, { schemaVersion: 3, path: '/a' }),
    ],
    [
      'schema 2 without managed',
      (directory: string) => record(directory, { schemaVersion: 2, path: '/Applications/P.app' }),
    ],
    ['a non-string path', (directory: string) => record(directory, { schemaVersion: 1, path: 7 })],
    [
      'a relative path',
      (directory: string) => record(directory, { schemaVersion: 1, path: 'P.app' }),
    ],
    [
      'a NUL byte',
      (directory: string) => record(directory, { schemaVersion: 1, path: '/Applications/P\0.app' }),
    ],
  ])('ignores %s and falls back to the managed path', (_label, corrupt) => {
    const directory = dataDirectory();
    corrupt(directory);
    expect(readRecordedApplicationPath(directory)).toBeNull();
  });
});
