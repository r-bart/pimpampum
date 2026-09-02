import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPackagedCommandServiceManager } from '../src/cliComposition/packagedLifecycle.js';
import type {
  ConnectionReceipt,
  ConnectorId,
  ConnectorInspection,
  ConnectorSnapshot,
  HostConnector,
  HostEntry,
} from '../src/connectors/types.js';
import { installRuntime } from '../src/runtime/installer.js';
import type { RuntimeInstallation, RuntimeManifest } from '../src/runtime/types.js';
import {
  createPackagedRemovalPhases,
  installPackagedService,
  isPackagedServiceReceipt,
  keepPreviousRuntime,
  packagedCliSmoke,
  packagedUninstallResult,
} from '../src/service/packagedLifecycle.js';
import {
  installReceiptPath,
  readInstallReceipt,
  writeInstallReceipt,
} from '../src/service/receipt.js';
import type {
  InstallReceipt,
  PreparedServiceUninstall,
  ServiceManager,
} from '../src/service/types.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-packaged-lifecycle-'));
  roots.push(root);
  const homeDirectory = join(root, 'home');
  const dataDirectory = join(root, 'data');
  mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const ownedRuntime = {
    homeDirectory,
    dataDirectory,
    platform: 'darwin' as const,
    architecture: 'arm64' as const,
  };
  return { root, homeDirectory, dataDirectory, ownedRuntime };
}

function receiptOf(dataDirectory: string, overrides: Partial<InstallReceipt> = {}): InstallReceipt {
  return {
    schemaVersion: 1,
    adapter: 'launchd-macos-app',
    platform: 'darwin',
    version: '1.0.0',
    installationKey: 'a'.repeat(64),
    installedAt: '2026-08-31T10:00:00.000Z',
    nodePath: '/private/runtime/bin/node',
    cliPath: '/private/runtime/dist/cli.js',
    dataDirectory,
    baseUrl: 'http://127.0.0.1:7337',
    logDirectory: join(dataDirectory, 'logs'),
    artifacts: [],
    ...overrides,
  };
}

function writeReceipt(
  dataDirectory: string,
  overrides: Partial<InstallReceipt> = {},
): InstallReceipt {
  const receipt = receiptOf(dataDirectory, overrides);
  writeInstallReceipt(installReceiptPath(dataDirectory), receipt, dataDirectory);
  return receipt;
}

async function installOwnedRuntime(
  value: ReturnType<typeof fixture>,
): Promise<RuntimeInstallation> {
  const sourceDirectory = join(value.root, 'source', 'payload');
  const contents = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': 'export const version = "1.0.0";\n',
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'addon',
  };
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(sourceDirectory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: path === 'bin/node' ? 0o755 : 0o644 });
  }
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    pimpampumVersion: '1.0.0',
    nodeVersion: '24.19.0',
    target: { platform: 'darwin', architecture: 'arm64' },
    unpackedBytes: Object.values(contents).reduce((total, c) => total + Buffer.byteLength(c), 0),
    entrypoints: { node: 'bin/node', cli: 'dist/cli.js', mcp: 'dist/mcpStdio.js' },
    files: Object.entries(contents).map(([path, content]) => ({
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      mode: path === 'bin/node' ? 0o755 : 0o644,
      size: Buffer.byteLength(content),
    })),
  };
  return installRuntime({
    ...value.ownedRuntime,
    sourceDirectory,
    manifest,
    smoke: async () => undefined,
  });
}

const entry: HostEntry = { command: '/launcher', arguments: [], scope: 'user', restorable: true };
const otherEntry: HostEntry = {
  command: '/other',
  arguments: ['x'],
  scope: 'user',
  restorable: true,
};

function connectorReceipt(connectorId: ConnectorId): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId,
    scope: 'user',
    commandFingerprint: 'fingerprint',
    configuredAt: '2026-08-31T10:00:00.000Z',
    lastVerifiedAt: null,
  };
}

function fakeConnector(
  id: ConnectorId,
  options: {
    state?: ConnectorInspection['state'];
    entry?: HostEntry | null;
    snapshotEntry?: HostEntry | null;
    changed?: boolean;
  } = {},
) {
  const inspection = {
    connectorId: id,
    state: options.state ?? 'ownedCurrent',
    entry: options.entry === undefined ? entry : options.entry,
  } as unknown as ConnectorInspection;
  const snapshot = {
    connectorId: id,
    entry: options.snapshotEntry === undefined ? entry : options.snapshotEntry,
  } as unknown as ConnectorSnapshot;
  const connector = {
    id,
    displayName: id === 'codex' ? 'Codex' : 'Claude Code',
    inspect: vi.fn(async () => inspection),
    snapshot: vi.fn(async () => snapshot),
    disconnect: vi.fn(async () => ({
      connectorId: id,
      state: 'notConnected' as const,
      changed: options.changed ?? true,
      verification: null,
    })),
    restore: vi.fn(async () => undefined),
  } as unknown as HostConnector & {
    disconnect: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
  };
  return { connector, snapshot };
}

function receiptStore(receipt: ConnectionReceipt | null) {
  return { read: vi.fn(async () => receipt), write: vi.fn(async () => undefined) };
}

function preparedUninstall(options: { commitError?: Error } = {}) {
  const prepared = {
    commit: vi.fn(async () => {
      if (options.commitError) throw options.commitError;
      return { uninstalled: true, dataPreserved: true as const, manualInstructions: ['open it'] };
    }),
    rollback: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
  } satisfies PreparedServiceUninstall;
  return prepared;
}

function removalPhases(
  value: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof createPackagedRemovalPhases>[0]> = {},
) {
  const prepared = preparedUninstall();
  const input = {
    serviceManager: { prepareUninstall: vi.fn(async () => prepared) },
    serviceReceipt: receiptOf(value.dataDirectory),
    dataDirectory: value.dataDirectory,
    runtime: value.ownedRuntime,
    connectors: [],
    receiptStores: new Map(),
    ...overrides,
  };
  return { phases: createPackagedRemovalPhases(input), prepared, input };
}

describe('packaged receipt recognition', () => {
  it('recognises provenance, a private runtime, or a packaged adapter', () => {
    const data = '/data';
    expect(isPackagedServiceReceipt(null)).toBe(false);
    expect(isPackagedServiceReceipt(receiptOf(data, { adapter: 'launchd' }))).toBe(false);
    expect(
      isPackagedServiceReceipt(
        receiptOf(data, { adapter: 'launchd', updateProvider: 'packaged-release' }),
      ),
    ).toBe(true);
    expect(
      isPackagedServiceReceipt(
        receiptOf(data, {
          adapter: 'systemd',
          packagedRuntime: { version: '1.0.0', target: 'linux-x64', runtimeDirectory: '/r' },
        }),
      ),
    ).toBe(true);
    expect(isPackagedServiceReceipt(receiptOf(data, { adapter: 'systemd-omarchy-quattro' }))).toBe(
      true,
    );
  });
});

describe('packaged CLI smoke', () => {
  const installation = { nodePath: '/n', cliPath: '/c' } as RuntimeInstallation;

  it('checks the exit code alone, or the reported version when asked', async () => {
    const ok = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"data":{"version":"1.0.0"}}',
      stderr: '',
    }));
    await expect(packagedCliSmoke(ok, { failure: 'boom' })(installation)).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledWith('/n', ['/c', 'version']);
    await expect(
      packagedCliSmoke(ok, { failure: 'boom', expectedVersion: '1.0.0' })(installation),
    ).resolves.toBeUndefined();
    await expect(
      packagedCliSmoke(ok, { failure: 'boom', expectedVersion: '2.0.0' })(installation),
    ).rejects.toThrow(/unexpected version/u);
    const failed = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' }));
    await expect(packagedCliSmoke(failed, { failure: 'boom' })(installation)).rejects.toThrow(
      'boom',
    );
    const bare = vi.fn(async () => ({ exitCode: 0, stdout: 'null', stderr: '' }));
    await expect(
      packagedCliSmoke(bare, { failure: 'boom', expectedVersion: '1.0.0' })(installation),
    ).rejects.toThrow(/unexpected version/u);
  });

  it('keeps the previous runtime version out of the prune', () => {
    expect(keepPreviousRuntime(null)).toEqual({});
    expect(keepPreviousRuntime('1.0.0')).toEqual({ keepVersions: ['1.0.0'] });
  });
});

describe('packaged install transaction', () => {
  function bootstrapOf(installation: Partial<RuntimeInstallation> = {}) {
    const transaction = {
      installation: {
        activated: true,
        version: '1.0.0',
        nodePath: '/n',
        cliPath: '/c',
        mcpLauncherPath: '/m',
        previousVersion: null,
        ...installation,
      },
      commit: vi.fn(),
      rollback: vi.fn(),
    };
    return {
      transaction,
      bootstrap: {
        prepareInstallation: vi.fn(async (smoke: (i: RuntimeInstallation) => Promise<void>) => {
          await smoke(transaction.installation);
          return transaction;
        }),
      },
    };
  }

  it('activates, installs, prunes and commits under the lock', async () => {
    const value = fixture();
    const { bootstrap, transaction } = bootstrapOf({ previousVersion: '0.9.0' });
    // A generic signature survives `vi.fn` only by losing its type parameter, so this lock counts
    // its own calls instead of being a spy.
    let lockRuns = 0;
    const run = async <T>(operation: () => Promise<T>): Promise<T> => {
      lockRuns += 1;
      return operation();
    };
    const install = vi.fn(async () => ({
      installed: true as const,
      reconciled: false,
      receiptPath: '/r',
    }));
    await expect(
      installPackagedService({
        lock: { run },
        bootstrap,
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        manager: { install },
        runtime: value.ownedRuntime,
      }),
    ).resolves.toMatchObject({ installed: true });
    expect(lockRuns).toBe(1);
    expect(transaction.commit).toHaveBeenCalledOnce();
    expect(transaction.rollback).not.toHaveBeenCalled();
  });

  it('rolls the runtime back when the service install fails, and never opens it on a failed smoke', async () => {
    const value = fixture();
    const { bootstrap, transaction } = bootstrapOf();
    const input = {
      lock: { run: async <T>(operation: () => Promise<T>) => operation() },
      bootstrap,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      manager: {
        install: async () => {
          throw new Error('launchctl refused');
        },
      },
      runtime: value.ownedRuntime,
    };
    await expect(installPackagedService(input)).rejects.toThrow('launchctl refused');
    expect(transaction.rollback).toHaveBeenCalledOnce();
    await expect(
      installPackagedService({
        ...input,
        runCommand: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      }),
    ).rejects.toThrow(/smoke failed/u);
    expect(transaction.rollback).toHaveBeenCalledOnce();
  });
});

describe('packaged removal phases', () => {
  it('refuses the phases that only an install or update may run', async () => {
    const { phases } = removalPhases(fixture());
    await expect(phases.runtime.stage('1.0.0')).rejects.toThrow(/staging is unavailable/u);
    await expect(phases.service.install({ nodePath: '/n', cliPath: '/c' })).rejects.toThrow(
      /installation is unavailable/u,
    );
    await expect(
      phases.receipt.commit({ runtimeVersion: '1.0.0', serviceCommand: [], connectorEntries: {} }),
    ).rejects.toThrow(/cannot rewrite/u);
    await expect(phases.runtime.activate('1.0.0')).resolves.toBeUndefined();
    await expect(phases.service.stop()).resolves.toBeUndefined();
    await expect(phases.connectors.snapshotOwned()).resolves.toEqual({});
  });

  it('removes or restores an owned private runtime, and tolerates having none', async () => {
    const value = fixture();
    const { phases } = removalPhases(value);
    await phases.runtime.removeOwned();
    await phases.runtime.finalizeRemoval!();
    await phases.runtime.restore('1.0.0');

    const installation = await installOwnedRuntime(value);
    expect(existsSync(installation.nodePath)).toBe(true);
    await phases.runtime.removeOwned();
    expect(existsSync(installation.nodePath)).toBe(false);
    await phases.runtime.restore('1.0.0');
    expect(existsSync(installation.nodePath)).toBe(true);
    await phases.runtime.removeOwned();
    await phases.runtime.finalizeRemoval!();
    expect(existsSync(installation.nodePath)).toBe(false);
  });

  it('drives the prepared service removal through remove, finalize and rollback', async () => {
    const value = fixture();
    const { phases, prepared } = removalPhases(value);
    await phases.service.restore({
      runtimeVersion: '1.0.0',
      serviceCommand: [],
      connectorEntries: {},
    });
    await phases.service.finalizeRemoval!();
    await expect(phases.receipt.remove()).rejects.toThrow(/was not prepared/u);

    await phases.service.removeOwned();
    await expect(phases.receipt.remove()).resolves.toMatchObject({
      manualInstructions: ['open it'],
    });
    await phases.service.finalizeRemoval!();
    expect(prepared.finalize).toHaveBeenCalledOnce();

    await phases.service.removeOwned();
    await phases.service.restore({
      runtimeVersion: '1.0.0',
      serviceCommand: [],
      connectorEntries: {},
    });
    expect(prepared.rollback).toHaveBeenCalledOnce();

    const missing = removalPhases(value, {
      serviceManager: { prepareUninstall: async () => null },
    });
    await expect(missing.phases.service.removeOwned()).rejects.toThrow(
      /disappeared during removal/u,
    );
  });

  it('classifies connector entries as owned, unproven, or absent', async () => {
    const value = fixture();
    const owned = fakeConnector('codex');
    const unproven = fakeConnector('claude-code', { snapshotEntry: otherEntry });
    const { phases } = removalPhases(value, {
      connectors: [owned.connector, unproven.connector],
      receiptStores: new Map([
        ['codex', receiptStore(connectorReceipt('codex'))],
        ['claude-code', receiptStore(connectorReceipt('claude-code'))],
      ]),
    });
    await expect(phases.connectors.planRemoval!()).resolves.toEqual({
      ownedEntries: { codex: { snapshot: owned.snapshot, receipt: connectorReceipt('codex') } },
      unprovenConnectorIds: ['claude-code'],
    });

    const noReceipt = fakeConnector('codex');
    const absent = fakeConnector('claude-code', { state: 'notConnected', entry: null });
    const other = removalPhases(value, {
      connectors: [noReceipt.connector, absent.connector],
      receiptStores: new Map([
        ['codex', receiptStore(null)],
        ['claude-code', receiptStore(null)],
      ]),
    });
    await expect(other.phases.connectors.planRemoval!()).resolves.toEqual({
      ownedEntries: {},
      unprovenConnectorIds: ['codex'],
    });
  });

  it('disconnects only the owned entries and restores them in reverse on rollback', async () => {
    const value = fixture();
    const codex = fakeConnector('codex');
    const claude = fakeConnector('claude-code');
    const stores = new Map([
      ['codex', receiptStore(connectorReceipt('codex'))],
      ['claude-code', receiptStore(connectorReceipt('claude-code'))],
    ] as const);
    const { phases } = removalPhases(value, {
      connectors: [codex.connector, claude.connector],
      receiptStores: stores,
    });
    const entries = {
      codex: { snapshot: codex.snapshot, receipt: connectorReceipt('codex') },
      'claude-code': { snapshot: claude.snapshot, receipt: connectorReceipt('claude-code') },
    };
    await phases.connectors.disconnectOwned();
    expect(codex.connector.disconnect).not.toHaveBeenCalled();
    await phases.connectors.disconnectOwned({ codex: entries.codex });
    expect(codex.connector.disconnect).toHaveBeenCalledOnce();
    expect(claude.connector.disconnect).not.toHaveBeenCalled();
    await phases.connectors.restoreOwned(entries);
    expect(codex.connector.restore).toHaveBeenCalledWith(codex.snapshot);
    expect(stores.get('codex')!.write).toHaveBeenCalledWith(connectorReceipt('codex'));
    expect(claude.connector.restore).not.toHaveBeenCalled();

    await phases.connectors.disconnectOwned(entries);
    await expect(phases.connectors.restoreOwned({ codex: 'garbage' })).rejects.toMatchObject({
      message: 'Agent connection removal rollback failed',
      errors: [
        expect.objectContaining({ message: 'Invalid claude-code removal snapshot' }),
        expect.objectContaining({ message: 'Invalid codex removal snapshot' }),
      ],
    });
    claude.connector.restore.mockRejectedValueOnce(new Error('host refused'));
    await expect(phases.connectors.restoreOwned(entries)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'host refused' })],
    });
  });

  it('stops when an owned entry changed under it', async () => {
    const value = fixture();
    const changed = fakeConnector('codex', { changed: false });
    const { phases } = removalPhases(value, { connectors: [changed.connector] });
    await expect(phases.connectors.disconnectOwned({ codex: {} })).rejects.toThrow(
      /Codex owned entry changed during removal/u,
    );
  });

  it('captures the receipt bytes and restores them only when unchanged', async () => {
    const value = fixture();
    const { phases } = removalPhases(value);
    await expect(phases.receipt.read()).resolves.toMatchObject({
      runtimeVersion: '1.0.0',
      serviceCommand: ['/private/runtime/bin/node', '/private/runtime/dist/cli.js'],
      adapter: 'launchd-macos-app',
      runtimeKind: 'packaged',
    });
    await expect(phases.receipt.capture!()).rejects.toThrow(/disappeared during removal planning/u);
    await expect(
      phases.receipt.restore!({
        snapshot: await phases.receipt.read(),
        contents: Buffer.from('x'),
      }),
    ).rejects.toThrow(/rollback snapshot changed/u);

    writeReceipt(value.dataDirectory);
    const capture = await phases.receipt.capture!();
    expect(capture.snapshot.runtimeVersion).toBe('1.0.0');
    await expect(
      phases.receipt.restore!({ snapshot: capture.snapshot, contents: Buffer.from('tampered') }),
    ).rejects.toThrow(/rollback snapshot changed/u);
    rmSync(installReceiptPath(value.dataDirectory));
    await phases.receipt.restore!(capture);
    expect(
      readInstallReceipt(installReceiptPath(value.dataDirectory), value.dataDirectory),
    ).toMatchObject({
      version: '1.0.0',
    });
  });

  it('shapes the uninstall result', () => {
    expect(packagedUninstallResult({ removed: true, manualInstructions: [] })).toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    expect(packagedUninstallResult({ removed: false, manualInstructions: ['a'] })).toEqual({
      uninstalled: false,
      dataPreserved: true,
      manualInstructions: ['a'],
    });
  });
});

describe('packaged command service manager', () => {
  function managerFixture(
    value: ReturnType<typeof fixture>,
    options: { prepared?: PreparedServiceUninstall | null; withPrepare?: boolean } = {},
  ) {
    const serviceManager: ServiceManager = {
      install: vi.fn(async () => ({
        installed: true as const,
        reconciled: false,
        receiptPath: '/r',
      })),
      status: vi.fn(async () => ({
        installed: true,
        running: true,
        adapter: 'launchd',
        version: '1.0.0',
      })),
      uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
      ...(options.withPrepare === false
        ? {}
        : { prepareUninstall: vi.fn(async () => options.prepared ?? preparedUninstall()) }),
    };
    const connectors = { ordered: [], receiptStores: new Map(), launcherPath: '/launcher' };
    const build = (
      bootstrap: Parameters<typeof createPackagedCommandServiceManager>[0]['bootstrap'],
    ) =>
      createPackagedCommandServiceManager({
        serviceManager,
        bootstrap,
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        target: {
          supported: true,
          platform: 'darwin',
          architecture: 'arm64',
          packagedRelease: 'darwin-arm64',
        },
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        connectors,
      });
    return { serviceManager, build };
  }

  it('passes install, status and prepareUninstall through on an npm install', async () => {
    const value = fixture();
    const { serviceManager, build } = managerFixture(value);
    const manager = build(null);
    await expect(manager.install()).resolves.toMatchObject({ installed: true });
    await expect(manager.status()).resolves.toMatchObject({ running: true });
    await manager.prepareUninstall!();
    expect(serviceManager.prepareUninstall).toHaveBeenCalledOnce();
    expect('prepareUninstall' in managerFixture(value, { withPrepare: false }).build(null)).toBe(
      false,
    );
  });

  it('activates the private runtime before installing on a packaged runtime', async () => {
    const value = fixture();
    const { serviceManager, build } = managerFixture(value);
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
    const manager = build({
      prepareInstallation: vi.fn(async () => transaction),
    } as unknown as NonNullable<Parameters<typeof build>[0]>);
    await expect(manager.install()).resolves.toMatchObject({ installed: true });
    expect(serviceManager.install).toHaveBeenCalledOnce();
    expect(transaction.commit).toHaveBeenCalledOnce();
  });

  it('keeps the plain uninstall for a missing or legacy receipt', async () => {
    const value = fixture();
    const { serviceManager, build } = managerFixture(value);
    await expect(build(null).uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    writeReceipt(value.dataDirectory, { adapter: 'launchd' });
    await build(null).uninstall();
    expect(serviceManager.uninstall).toHaveBeenCalledTimes(2);
  });

  it('refuses a packaged removal without a prepared transaction', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory);
    await expect(
      managerFixture(value, { withPrepare: false }).build(null).uninstall(),
    ).rejects.toThrow(/removal transaction is unavailable/u);
  });

  it('removes a packaged install through the lifecycle engine and merges manual instructions', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory);
    const prepared = preparedUninstall();
    const { build } = managerFixture(value, { prepared });
    await expect(build(null).uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
      manualInstructions: ['open it'],
    });
    expect(prepared.commit).toHaveBeenCalledOnce();
    expect(prepared.finalize).toHaveBeenCalledOnce();
  });

  it('rolls the receipt back byte for byte when the removal fails after preparation', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory);
    const prepared = preparedUninstall({ commitError: new Error('launchctl bootout failed') });
    const { build } = managerFixture(value, { prepared });
    await expect(build(null).uninstall()).rejects.toThrow(/launchctl bootout failed/u);
    expect(prepared.rollback).toHaveBeenCalledOnce();
    expect(
      readInstallReceipt(installReceiptPath(value.dataDirectory), value.dataDirectory),
    ).toMatchObject({
      version: '1.0.0',
    });
  });
});
