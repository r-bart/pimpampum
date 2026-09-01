import { describe, expect, it, vi } from 'vitest';
import {
  createCliConnectionsRuntime,
  createCliSetupRuntime,
  runCli,
  type CliRuntime,
} from '../src/cliProgram.js';
import type {
  ConnectionPlan,
  ConnectorInspection,
  ConnectorState,
  HostConnector,
} from '../src/connectors/types.js';
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
  it('delegates every setup runtime operation to its injected boundary', async () => {
    const coordinator = {
      plan: vi.fn(async () => 'plan'),
      apply: vi.fn(async () => 'apply'),
      resume: vi.fn(async () => 'resume'),
      retryConnector: vi.fn(async () => 'retry'),
    };
    const read = vi.fn(async () => 'status');
    const runtime = createCliSetupRuntime(coordinator, { read } as never);
    const progress = vi.fn();

    await expect(runtime.plan({ selectedConnectors: ['codex'] })).resolves.toBe('plan');
    await expect(
      runtime.apply({
        operationId: 'operation',
        expectedRevision: 'revision',
        confirmed: true,
      }),
    ).resolves.toBe('apply');
    await expect(runtime.status()).resolves.toBe('status');
    await expect(runtime.resume({ onProgress: progress })).resolves.toBe('resume');
    await expect(runtime.retryConnector('codex', progress)).resolves.toBe('retry');
    expect(read).toHaveBeenCalledOnce();
  });

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
      expect.objectContaining({ state: 'ownedCurrent', available: true }),
      expect.objectContaining({ state: 'equivalentUnowned', available: false }),
      expect.objectContaining({ state: 'conflict', available: false }),
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

  it('maps plain, conflict-coded, and empty conflict boundary failures', async () => {
    for (const [failure, expectedCode] of [
      [new Error('ordinary failure'), 'internal_error'],
      [new Error(''), 'internal_error'],
      ['primitive failure', 'internal_error'],
      [{ code: 'CONFLICT_STATE' }, 'conflict'],
      [new Error('requires a decision'), 'conflict'],
      [Object.assign(new Error(''), { code: 'CONFLICT_STATE' }), 'conflict'],
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
