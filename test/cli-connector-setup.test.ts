import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionReceiptStore } from '../src/cliComposition/connectionReceipts.js';
import {
  createGuidedSetup,
  createHostConnectors,
  createSetupConnectorAdapters,
  type GuidedSetupInput,
} from '../src/cliComposition/connectorSetup.js';
import { createConnectorRegistry } from '../src/connectors/registry.js';
import type {
  ConnectionPlan,
  ConnectionReceipt,
  ConnectorId,
  ConnectorInspection,
  HostConnector,
  HostEntry,
} from '../src/connectors/types.js';
import { resolveRuntimeLayout } from '../src/runtime/layout.js';
import type { InstallResult } from '../src/service/types.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-connector-setup-'));
  roots.push(root);
  return root;
}

function receipt(overrides: Partial<ConnectionReceipt> = {}): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId: 'codex',
    scope: 'user',
    commandFingerprint: 'fingerprint',
    configuredAt: '2026-08-31T10:00:00.000Z',
    lastVerifiedAt: null,
    ...overrides,
  };
}

describe('connection receipts', () => {
  it('reads null without a directory or a file, and round-trips a written receipt', async () => {
    const root = temporaryRoot();
    const store = createConnectionReceiptStore(root, 'codex');
    await expect(store.read()).resolves.toBeNull();
    await store.write(receipt({ capabilities: ['tools'] }));
    await expect(store.read()).resolves.toEqual(receipt({ capabilities: ['tools'] }));
    await store.write(receipt({ lastVerifiedAt: '2026-09-01T00:00:00.000Z' }));
    await expect(store.read()).resolves.toEqual(
      receipt({ lastVerifiedAt: '2026-09-01T00:00:00.000Z' }),
    );
    await store.remove();
    await expect(store.read()).resolves.toBeNull();
    await store.remove();
  });

  it('refuses corrupt content, a foreign connector, bad capabilities, and a read-only file', async () => {
    const root = temporaryRoot();
    const path = join(root, 'connections', 'codex.json');
    mkdirSync(join(root, 'connections'), { mode: 0o700 });
    const store = createConnectionReceiptStore(root, 'codex');
    writeFileSync(path, JSON.stringify(receipt({ connectorId: 'claude-code' })), { mode: 0o600 });
    await expect(store.read()).rejects.toThrow(/Invalid private connector receipt$/u);
    writeFileSync(path, JSON.stringify({ ...receipt(), capabilities: [1] }), { mode: 0o600 });
    await expect(store.read()).rejects.toThrow(/receipt capabilities/u);
    await expect(store.write({ ...receipt(), commandFingerprint: '' })).rejects.toThrow(
      /Invalid private connector receipt/u,
    );
    chmodSync(path, 0o400);
    await expect(store.write(receipt())).rejects.toThrow(/read-only or managed/u);
  });

  it('accepts a global scope and refuses a receipt path that is not a regular file', async () => {
    const root = temporaryRoot();
    const store = createConnectionReceiptStore(root, 'codex');
    await store.write(receipt({ scope: 'global' }));
    await expect(store.read()).resolves.toMatchObject({ scope: 'global' });

    // A directory where the receipt belongs answers neither ENOENT nor a parsed receipt.
    const other = temporaryRoot();
    mkdirSync(join(other, 'connections', 'codex.json'), { recursive: true });
    await expect(createConnectionReceiptStore(other, 'codex').write(receipt())).rejects.toThrow(
      /regular file/u,
    );
  });

  it('removes nothing when the directory is absent and refuses an unreadable one', async () => {
    await expect(
      createConnectionReceiptStore(temporaryRoot(), 'codex').remove(),
    ).resolves.toBeUndefined();

    const root = temporaryRoot();
    const connections = join(root, 'connections');
    mkdirSync(connections, { mode: 0o700 });
    writeFileSync(join(connections, 'codex.json'), JSON.stringify(receipt()), { mode: 0o600 });
    chmodSync(connections, 0o000);
    try {
      await expect(createConnectionReceiptStore(root, 'codex').remove()).rejects.toThrow(/EACCES/u);
    } finally {
      chmodSync(connections, 0o700);
    }
  });

  it('refuses a symlinked directory and a non-file entry', async () => {
    const root = temporaryRoot();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'connections'));
    const store = createConnectionReceiptStore(root, 'codex');
    await expect(store.read()).rejects.toThrow(/must not be a symlink/u);
    await expect(store.write(receipt())).rejects.toThrow(/must not be a symlink/u);

    const other = temporaryRoot();
    mkdirSync(join(other, 'connections', 'codex.json'), { recursive: true });
    await expect(createConnectionReceiptStore(other, 'codex').remove()).rejects.toThrow(
      /regular file/u,
    );
  });
});

describe('host connectors', () => {
  it('builds both connectors in registry order with their receipt stores', () => {
    const root = temporaryRoot();
    const connectors = createHostConnectors({
      homeDirectory: root,
      dataDirectory: join(root, 'data'),
      launcherPath: join(root, 'bin', 'pimpampum-mcp'),
      pathValue: '/usr/bin',
      cwd: root,
    });
    expect(connectors.ordered.map((connector) => connector.id)).toEqual(
      createConnectorRegistry().map((descriptor) => descriptor.id),
    );
    expect([...connectors.receiptStores.keys()].sort()).toEqual(['claude-code', 'codex']);
    expect(connectors.launcherPath).toBe(join(root, 'bin', 'pimpampum-mcp'));
  });
});

const entry: HostEntry = { command: '/launcher', arguments: [], scope: 'user', restorable: true };

function fakeConnector(
  id: ConnectorId,
  options: {
    state?: ConnectorInspection['state'];
    entry?: HostEntry | null;
    planState?: ConnectionPlan['state'];
    mutations?: ConnectionPlan['mutations'];
    newSessionRequired?: boolean;
    available?: boolean;
  } = {},
) {
  const snapshot = { connectorId: id, entry: null };
  const connector = {
    id,
    displayName: id,
    inspect: vi.fn(async () => ({
      connectorId: id,
      state: options.state ?? 'notConnected',
      entry: options.entry === undefined ? null : options.entry,
    })),
    plan: vi.fn(async (input?: { conflictDecision?: string }) => ({
      connectorId: id,
      state: options.planState ?? 'notConnected',
      mutations: options.mutations ?? [{ executable: '/host', arguments: [] }],
      newSessionRequired: options.newSessionRequired ?? false,
      ...(input?.conflictDecision === undefined
        ? {}
        : { conflictDecision: input.conflictDecision }),
    })),
    connect: vi.fn(async () => ({ connectorId: id, state: 'ownedCurrent', changed: true })),
    verify: vi.fn(async () => ({ available: options.available ?? true })),
    snapshot: vi.fn(async () => snapshot),
    restore: vi.fn(async () => undefined),
  };
  return { connector: connector as unknown as HostConnector, mocks: connector, snapshot };
}

describe('setup connector adapters', () => {
  it('discloses a conflict with its revision and whether it can be replaced', async () => {
    const plain = fakeConnector('codex');
    const restorable = fakeConnector('codex', { state: 'conflict', entry });
    const frozen = fakeConnector('codex', {
      state: 'conflict',
      entry: { ...entry, restorable: false },
    });
    const bare = fakeConnector('codex', { state: 'conflict', entry: null });
    await expect(createSetupConnectorAdapters([plain.connector]).codex.inspect()).resolves.toEqual({
      state: 'notConnected',
    });
    await expect(
      createSetupConnectorAdapters([restorable.connector]).codex.inspect(),
    ).resolves.toEqual({
      state: 'conflict',
      comparison: 'An existing entry differs from the Pimpampum-owned launcher.',
      revision: expect.any(String),
      replacementSupported: true,
    });
    await expect(
      createSetupConnectorAdapters([frozen.connector]).codex.inspect(),
    ).resolves.toMatchObject({
      replacementSupported: false,
    });
    await expect(createSetupConnectorAdapters([bare.connector]).codex.inspect()).resolves.toEqual({
      state: 'conflict',
      comparison: 'An existing entry differs from the Pimpampum-owned launcher.',
    });
  });

  it('snapshots before connecting, reports the session requirement, and restores only after a connect', async () => {
    const codex = fakeConnector('codex', { newSessionRequired: true });
    const adapter = createSetupConnectorAdapters([codex.connector]).codex;
    await expect(adapter.verify()).resolves.toEqual({ available: true, newSessionRequired: false });
    await adapter.restore();
    expect(codex.mocks.restore).not.toHaveBeenCalled();
    await adapter.connect({ conflictDecision: 'replace', reviewedEntryFingerprint: 'r' });
    expect(codex.mocks.plan).toHaveBeenCalledWith({
      conflictDecision: 'replace',
      reviewedEntryFingerprint: 'r',
    });
    expect(codex.mocks.snapshot).toHaveBeenCalledOnce();
    expect(codex.mocks.connect).toHaveBeenCalledOnce();
    await expect(adapter.verify()).resolves.toEqual({ available: true, newSessionRequired: true });
    await adapter.restore();
    expect(codex.mocks.restore).toHaveBeenCalledWith(codex.snapshot);
  });

  it('refuses an undecided or unrestorable conflict with the typed local code', async () => {
    const undecided = fakeConnector('codex', { planState: 'conflict' });
    await expect(
      createSetupConnectorAdapters([undecided.connector]).codex.connect(),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_CONFLICT',
    });
    const unrestorable = fakeConnector('codex', { planState: 'conflict', mutations: [] });
    await expect(
      createSetupConnectorAdapters([unrestorable.connector]).codex.connect({
        conflictDecision: 'replace',
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_CONFLICT' });
    expect(unrestorable.mocks.connect).not.toHaveBeenCalled();
  });
});

describe('guided setup', () => {
  const FIXED_CLOCK = () => '2026-09-02T12:00:00.000Z';

  /** `clock` is `null` for the case that leaves `now` absent, so the setup falls back to the wall clock. */
  function setupFixture(
    overrides: Partial<GuidedSetupInput> = {},
    clock: (() => string) | null = FIXED_CLOCK,
  ) {
    const root = temporaryRoot();
    const homeDirectory = join(root, 'home');
    const dataDirectory = join(root, 'data');
    mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
    const codex = fakeConnector('codex', { newSessionRequired: true });
    const claude = fakeConnector('claude-code');
    const install = vi.fn(async (): Promise<InstallResult> => ({
      installed: true,
      reconciled: false,
      receiptPath: join(dataDirectory, 'install-receipt.json'),
      loginItem: 'requiresApproval',
    }));
    const input: GuidedSetupInput = {
      dataDirectory,
      homeDirectory,
      version: '1.0.0',
      target: {
        supported: true,
        platform: 'darwin',
        architecture: 'arm64',
        packagedRelease: 'darwin-arm64',
      },
      layout: resolveRuntimeLayout({
        homeDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.0.0',
      }),
      bootstrap: null,
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"data":{"version":"1.0.0"}}',
        stderr: '',
      })),
      serviceManager: { install },
      servicePath: join(homeDirectory, 'service.plist'),
      connectors: {
        ordered: [codex.connector, claude.connector],
        receiptStores: new Map(),
        launcherPath: join(homeDirectory, 'pimpampum-mcp'),
      },
      ...(clock === null ? {} : { now: clock }),
      ...overrides,
    };
    return { root, dataDirectory, codex, claude, install, input, setup: createGuidedSetup(input) };
  }

  async function apply(
    setup: ReturnType<typeof createGuidedSetup>,
    selectedConnectors: ConnectorId[] = [],
  ) {
    const plan = (await setup.plan({ selectedConnectors })) as {
      operationId: string;
      revision: string;
    };
    return setup.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
    });
  }

  it('installs the service on an npm runtime, connects the selected agent, and records the journal', async () => {
    const value = setupFixture();
    await expect(apply(value.setup, ['codex'])).resolves.toBeDefined();
    expect(value.install).toHaveBeenCalledOnce();
    expect(value.codex.mocks.connect).toHaveBeenCalledOnce();
    expect(value.claude.mocks.connect).not.toHaveBeenCalled();
    await expect(value.setup.status()).resolves.toMatchObject({ operationId: expect.any(String) });
    expect(existsSync(value.dataDirectory)).toBe(true);
  });

  it('activates and commits the packaged runtime only when the login item registers', async () => {
    const transaction = {
      installation: {
        activated: true,
        version: '1.0.0',
        nodePath: '/n',
        cliPath: '/c',
        mcpLauncherPath: '/m',
        previousVersion: '0.9.0',
      },
      commit: vi.fn(),
      rollback: vi.fn(),
    };
    const prepareInstallation = vi.fn(
      async (smoke: (installation: typeof transaction.installation) => Promise<void>) => {
        await smoke(transaction.installation);
        return transaction;
      },
    );
    const value = setupFixture({
      bootstrap: { prepareInstallation } as unknown as GuidedSetupInput['bootstrap'],
      serviceManager: {
        install: async () => ({
          installed: true,
          reconciled: false,
          receiptPath: '/r',
          loginItem: 'error',
        }),
      },
    });
    await expect(apply(value.setup)).resolves.toBeDefined();
    expect(transaction.commit).toHaveBeenCalledOnce();
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(value.input.runCommand).toHaveBeenCalledWith('/n', ['/c', 'version']);
  });

  it('rolls the packaged runtime back when the service install fails', async () => {
    const transaction = {
      installation: {
        activated: true,
        version: '1.0.0',
        nodePath: '/n',
        cliPath: '/c',
        mcpLauncherPath: '/m',
        previousVersion: null,
      },
      commit: vi.fn(),
      rollback: vi.fn(),
    };
    const value = setupFixture({
      bootstrap: {
        prepareInstallation: async () => transaction,
      } as unknown as GuidedSetupInput['bootstrap'],
      serviceManager: {
        install: async () => {
          throw new Error('launchctl refused');
        },
      },
    });
    await expect(apply(value.setup)).rejects.toThrow();
    expect(transaction.rollback).toHaveBeenCalledOnce();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it('refuses a packaged runtime whose CLI answers another version', async () => {
    const value = setupFixture({
      bootstrap: {
        prepareInstallation: async (smoke: (installation: unknown) => Promise<void>) => {
          await smoke({ nodePath: '/n', cliPath: '/c' });
          throw new Error('unreachable');
        },
      } as unknown as GuidedSetupInput['bootstrap'],
      runCommand: async () => ({ exitCode: 0, stdout: '{"data":{"version":"9.9.9"}}', stderr: '' }),
    });
    await expect(apply(value.setup)).rejects.toThrow();
    expect(value.install).not.toHaveBeenCalled();
  });

  it('uses the wall clock when no clock is injected and reports an enabled login item by default', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-03T08:30:00.000Z'));
    try {
      const value = setupFixture(
        {
          serviceManager: {
            install: async () => ({ installed: true, reconciled: false, receiptPath: '/r' }),
          },
        },
        null,
      );
      await expect(apply(value.setup)).resolves.toBeDefined();
      await expect(value.setup.status()).resolves.toMatchObject({
        updatedAt: '2026-09-03T08:30:00.000Z',
        loginItem: 'enabled',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
