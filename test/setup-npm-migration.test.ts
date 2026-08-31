import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstallationLifecycle } from '../src/setup/coordinator.js';
import { createInstallationMigrationStateStore } from '../src/setup/state.js';
import type { InstallationLifecycleDependencies } from '../src/setup/coordinator.js';
import type { InstallationMigrationJournal, InstallationSnapshot } from '../src/setup/types.js';
import {
  restoreInstallReceiptSnapshot,
  snapshotInstallReceipt,
  writeInstallReceipt,
} from '../src/service/receipt.js';
import type { InstallReceipt } from '../src/service/types.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'pimpampum-npm-migration-'));
  temporaryDirectories.push(path);
  return path;
}

function dependencies(root: string): InstallationLifecycleDependencies & {
  receiptBytes: { value: Buffer };
  current: { value: InstallationSnapshot };
  events: string[];
} {
  const dataDirectory = join(root, 'data');
  const previous: InstallationSnapshot = {
    runtimeVersion: '1.4.0',
    serviceCommand: ['/usr/local/bin/node', '/usr/local/lib/node_modules/pimpampum/dist/cli.js'],
    connectorEntries: { codex: { command: 'npx', args: ['pimpampum', 'mcp'] } },
    adapter: 'launchd',
    dataDirectory,
    runtimeKind: 'legacy-npm',
  };
  const current = { value: previous };
  const receiptBytes = { value: Buffer.from('{"legacy":"receipt bytes"}\n') };
  const events: string[] = [];
  return {
    dataDirectory,
    homeDirectory: join(root, 'home'),
    lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
    runtime: {
      stage: vi.fn(async (version) => {
        events.push('runtime.stage');
        return {
          version,
          nodePath: join(root, 'runtime', version, 'bin/node'),
          cliPath: join(root, 'runtime', version, 'dist/cli.js'),
        };
      }),
      activate: vi.fn(async () => {
        events.push('runtime.activate');
      }),
      restore: vi.fn(async () => {
        events.push('runtime.restore');
      }),
      removeOwned: vi.fn(async () => undefined),
      finalizeMigration: vi.fn(async () => {
        events.push('runtime.finalize');
      }),
    },
    service: {
      stop: vi.fn(async () => {
        events.push('service.stop');
      }),
      install: vi.fn(async () => {
        events.push('service.install');
      }),
      start: vi.fn(async () => {
        events.push('service.start');
      }),
      verify: vi.fn(async () => {
        events.push('service.verify');
      }),
      restore: vi.fn(async (snapshot) => {
        events.push('service.restore');
        current.value = snapshot;
      }),
      removeOwned: vi.fn(async () => undefined),
    },
    connectors: {
      reconcileOwned: vi.fn(async () => {
        events.push('connectors.reconcile');
      }),
      snapshotOwned: vi.fn(async () => current.value.connectorEntries),
      restoreOwned: vi.fn(async (entries) => {
        events.push('connectors.restore');
        current.value = { ...current.value, connectorEntries: entries };
      }),
      disconnectOwned: vi.fn(async () => undefined),
    },
    receipt: {
      read: vi.fn(async () => current.value),
      capture: vi.fn(async () => ({
        snapshot: current.value,
        contents: Buffer.from(receiptBytes.value),
      })),
      commit: vi.fn(async (snapshot) => {
        events.push('receipt.commit');
        current.value = snapshot;
        receiptBytes.value = Buffer.from(JSON.stringify(snapshot));
      }),
      restore: vi.fn(async (capture) => {
        events.push('receipt.restore');
        current.value = capture.snapshot;
        receiptBytes.value = Buffer.from(capture.contents);
      }),
      remove: vi.fn(async () => undefined),
    },
    receiptBytes,
    current,
    events,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('transactional legacy npm migration', () => {
  it('stages first, runs one daemon at a time, preserves canonical data, and commits provenance last', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    mkdirSync(deps.dataDirectory, { recursive: true });
    const canonicalFiles = {
      token: Buffer.from([0, 1, 2, 255]),
      'pimpampum.sqlite': Buffer.from('sqlite bytes'),
      'logs/daemon.log': Buffer.from('log bytes'),
      'exports/project.md': Buffer.from('# export\n'),
    };
    for (const [path, contents] of Object.entries(canonicalFiles)) {
      const target = join(deps.dataDirectory, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    }

    await expect(
      createInstallationLifecycle(deps).migrate({ targetVersion: '2.0.0' }),
    ).resolves.toEqual({ migrated: true, dataPreserved: true });

    expect(deps.events).toEqual([
      'runtime.stage',
      'service.stop',
      'runtime.activate',
      'service.install',
      'service.start',
      'service.verify',
      'connectors.reconcile',
      'receipt.commit',
      'runtime.finalize',
    ]);
    expect(deps.current.value).toMatchObject({
      runtimeVersion: '2.0.0',
      adapter: 'launchd',
      dataDirectory: deps.dataDirectory,
      runtimeKind: 'packaged',
    });
    for (const [path, contents] of Object.entries(canonicalFiles)) {
      expect(readFileSync(join(deps.dataDirectory, path))).toEqual(contents);
    }
    expect(existsSync(join(deps.dataDirectory, 'installation-migration-state.json'))).toBe(false);
  });

  it('does not stop or restore the working daemon when staging fails', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    vi.mocked(deps.runtime.stage).mockRejectedValueOnce(new Error('candidate hash mismatch'));

    await expect(
      createInstallationLifecycle(deps).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow('candidate hash mismatch');

    expect(deps.service.stop).not.toHaveBeenCalled();
    expect(deps.service.restore).not.toHaveBeenCalled();
    expect(deps.runtime.restore).not.toHaveBeenCalled();
  });

  it('rejects a receipt for another data directory before staging or stopping', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    deps.current.value = { ...deps.current.value, dataDirectory: join(root, 'other-data') };

    await expect(
      createInstallationLifecycle(deps).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow(/canonical data directory/u);

    expect(deps.runtime.stage).not.toHaveBeenCalled();
    expect(deps.service.stop).not.toHaveBeenCalled();
  });

  it('restores the exact npm receipt and recognized route after a partial commit failure', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    const originalReceipt = Buffer.from(deps.receiptBytes.value);
    vi.mocked(deps.receipt.commit).mockImplementationOnce(async () => {
      deps.events.push('receipt.commit');
      deps.receiptBytes.value = Buffer.from('partial replacement');
      throw new Error('receipt fsync failed');
    });

    await expect(
      createInstallationLifecycle(deps).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow('receipt fsync failed');

    expect(deps.receiptBytes.value).toEqual(originalReceipt);
    expect(deps.current.value.runtimeKind).toBe('legacy-npm');
    expect(deps.connectors.restoreOwned).toHaveBeenCalledWith(deps.current.value.connectorEntries);
    expect(deps.events.slice(-5)).toEqual([
      'service.stop',
      'runtime.restore',
      'service.restore',
      'connectors.restore',
      'receipt.restore',
    ]);
  });

  it('resumes a durable staged migration without downloading the runtime again', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    const store = createInstallationMigrationStateStore(deps.dataDirectory);
    const journal: InstallationMigrationJournal = {
      schemaVersion: 1,
      targetVersion: '2.0.0',
      phase: 'staged',
      previous: deps.current.value,
      previousReceiptBase64: deps.receiptBytes.value.toString('base64'),
      connectorEntries: deps.current.value.connectorEntries,
      staged: {
        version: '2.0.0',
        nodePath: join(root, 'runtime/2.0.0/bin/node'),
        cliPath: join(root, 'runtime/2.0.0/dist/cli.js'),
      },
      updatedAt: new Date().toISOString(),
    };
    store.write(journal);

    await expect(
      createInstallationLifecycle({ ...deps, migrationStateStore: store }).migrate({
        targetVersion: '2.0.0',
      }),
    ).resolves.toEqual({ migrated: true, dataPreserved: true });

    expect(deps.runtime.stage).not.toHaveBeenCalled();
    expect(deps.service.stop).toHaveBeenCalledOnce();
    expect(store.read()).toBeNull();
  });

  it('is a no-op when the receipt already identifies the target packaged runtime', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    deps.current.value = {
      ...deps.current.value,
      runtimeVersion: '2.0.0',
      runtimeKind: 'packaged',
    };

    await expect(
      createInstallationLifecycle(deps).migrate({ targetVersion: '2.0.0' }),
    ).resolves.toEqual({ migrated: false, dataPreserved: true });
    expect(deps.runtime.stage).not.toHaveBeenCalled();
    expect(deps.service.stop).not.toHaveBeenCalled();
  });

  it.each([
    ['service stop', 'service.stop'],
    ['runtime activation', 'runtime.activate'],
    ['service install', 'service.install'],
    ['service start', 'service.start'],
    ['service verification', 'service.verify'],
    ['connector reconciliation', 'connectors.reconcile'],
  ] as const)('restores the legacy installation after a fault during %s', async (_label, phase) => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    const operations = {
      'service.stop': deps.service.stop,
      'runtime.activate': deps.runtime.activate,
      'service.install': deps.service.install,
      'service.start': deps.service.start,
      'service.verify': deps.service.verify,
      'connectors.reconcile': deps.connectors.reconcileOwned,
    };
    vi.mocked(operations[phase]).mockRejectedValueOnce(new Error(`${phase} fault`));

    await expect(
      createInstallationLifecycle(deps).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow(`${phase} fault`);
    expect(deps.runtime.restore).toHaveBeenCalledWith('1.4.0');
    expect(deps.service.restore).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeKind: 'legacy-npm' }),
    );
    expect(deps.connectors.restoreOwned).toHaveBeenCalled();
    expect(existsSync(join(deps.dataDirectory, 'installation-migration-state.json'))).toBe(false);
  });

  it('keeps a committed journal after finalization failure and completes it idempotently', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    vi.mocked(deps.runtime.finalizeMigration!).mockRejectedValueOnce(
      new Error('old runtime quarantine busy'),
    );
    const lifecycle = createInstallationLifecycle(deps);
    await expect(lifecycle.migrate({ targetVersion: '2.0.0' })).rejects.toThrow(
      'old runtime quarantine busy',
    );
    const store = createInstallationMigrationStateStore(deps.dataDirectory);
    expect(store.read()?.phase).toBe('committed');
    await expect(lifecycle.migrate({ targetVersion: '2.0.0' })).resolves.toEqual({
      migrated: false,
      dataPreserved: true,
    });
    expect(store.read()).toBeNull();
    expect(deps.runtime.stage).toHaveBeenCalledOnce();
  });

  it('rejects invalid and conflicting durable migration targets before mutation', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    const store = createInstallationMigrationStateStore(deps.dataDirectory);
    const base: InstallationMigrationJournal = {
      schemaVersion: 1,
      targetVersion: '2.0.0',
      phase: 'staged',
      previous: deps.current.value,
      connectorEntries: deps.current.value.connectorEntries,
      staged: {
        version: '2.0.0',
        nodePath: join(root, 'runtime/2.0.0/bin/node'),
        cliPath: join(root, 'runtime/2.0.0/dist/cli.js'),
      },
      updatedAt: new Date().toISOString(),
    };
    store.write({ ...base, staged: { ...base.staged, version: '1.0.0' } });
    await expect(
      createInstallationLifecycle({ ...deps, migrationStateStore: store }).migrate({
        targetVersion: '2.0.0',
      }),
    ).rejects.toThrow(/runtime version does not match/iu);
    store.write(base);
    await expect(
      createInstallationLifecycle({ ...deps, migrationStateStore: store }).migrate({
        targetVersion: '3.0.0',
      }),
    ).rejects.toThrow(/another installation migration/iu);
    expect(deps.service.stop).not.toHaveBeenCalled();
  });

  it('rejects invalid targets, staged versions, captures, and receipt metadata before mutation', async () => {
    const invalidTarget = dependencies(temporaryDirectory());
    await expect(
      createInstallationLifecycle(invalidTarget).migrate({ targetVersion: '' }),
    ).rejects.toThrow(/target version/iu);

    const stagedMismatch = dependencies(temporaryDirectory());
    vi.mocked(stagedMismatch.runtime.stage).mockResolvedValueOnce({
      version: 'wrong',
      nodePath: '/new/node',
      cliPath: '/new/cli',
    });
    await expect(
      createInstallationLifecycle(stagedMismatch).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow(/staged runtime version mismatch/iu);

    const emptyCapture = dependencies(temporaryDirectory());
    vi.mocked(emptyCapture.receipt.capture!).mockResolvedValueOnce({
      snapshot: emptyCapture.current.value,
      contents: new Uint8Array(),
    });
    await expect(
      createInstallationLifecycle(emptyCapture).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow(/snapshot.*size/iu);

    const invalidAdapter = dependencies(temporaryDirectory());
    invalidAdapter.current.value = { ...invalidAdapter.current.value, adapter: '' };
    await expect(
      createInstallationLifecycle(invalidAdapter).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow(/adapter/iu);
  });

  it('recovers a non-staged interrupted journal before beginning a fresh migration', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    const store = createInstallationMigrationStateStore(deps.dataDirectory);
    store.write({
      schemaVersion: 1,
      targetVersion: '2.0.0',
      phase: 'verifying',
      previous: deps.current.value,
      connectorEntries: deps.current.value.connectorEntries,
      staged: {
        version: '2.0.0',
        nodePath: join(root, 'runtime/2.0.0/bin/node'),
        cliPath: join(root, 'runtime/2.0.0/dist/cli.js'),
      },
      updatedAt: new Date().toISOString(),
    });
    await expect(
      createInstallationLifecycle({ ...deps, migrationStateStore: store }).migrate({
        targetVersion: '2.0.0',
      }),
    ).resolves.toEqual({ migrated: true, dataPreserved: true });
    expect(deps.runtime.restore).toHaveBeenCalledWith('1.4.0');
    expect(deps.runtime.stage).toHaveBeenCalledOnce();
  });

  it('uses the snapshot receipt fallback when capture support is not configured', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    delete deps.receipt.capture;
    delete deps.receipt.restore;
    vi.mocked(deps.receipt.commit)
      .mockRejectedValueOnce(new Error('replacement receipt failed'))
      .mockResolvedValueOnce(undefined);
    await expect(
      createInstallationLifecycle(deps).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow('replacement receipt failed');
    expect(deps.receipt.commit).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeKind: 'legacy-npm' }),
    );
  });

  it('aggregates every migration recovery failure including durable journal cleanup', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    const store = createInstallationMigrationStateStore(deps.dataDirectory);
    const stateStore = {
      path: store.path,
      read: () => store.read(),
      write: (state: InstallationMigrationJournal) => store.write(state),
      remove: vi.fn(() => {
        throw new Error('journal cleanup failed');
      }),
    };
    vi.mocked(deps.service.verify).mockRejectedValueOnce('non-error verification fault');
    vi.mocked(deps.service.stop)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rollback stop failed'));
    vi.mocked(deps.runtime.restore).mockRejectedValueOnce(new Error('runtime restore failed'));
    vi.mocked(deps.service.restore).mockRejectedValueOnce(new Error('service restore failed'));
    vi.mocked(deps.connectors.restoreOwned).mockRejectedValueOnce(
      new Error('connector restore failed'),
    );
    const error = await createInstallationLifecycle({
      ...deps,
      migrationStateStore: stateStore,
    })
      .migrate({ targetVersion: '2.0.0' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/migration recovery failed.*rollback was incomplete/iu);
    expect((error as AggregateError).errors).toHaveLength(6);
  });

  it('does not roll back when durable phase persistence fails before mutation begins', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    const store = createInstallationMigrationStateStore(deps.dataDirectory);
    let writes = 0;
    const stateStore = {
      path: store.path,
      read: () => store.read(),
      write(state: InstallationMigrationJournal) {
        writes += 1;
        if (writes === 2) throw new Error('stopping phase fsync failed');
        store.write(state);
      },
      remove: () => store.remove(),
    };
    await expect(
      createInstallationLifecycle({ ...deps, migrationStateStore: stateStore }).migrate({
        targetVersion: '2.0.0',
      }),
    ).rejects.toThrow('stopping phase fsync failed');
    expect(deps.service.stop).not.toHaveBeenCalled();
    expect(deps.runtime.restore).not.toHaveBeenCalled();
  });
});

describe('service receipt migration snapshots', () => {
  it('restores the validated receipt byte-for-byte with private atomic writing', () => {
    const root = temporaryDirectory();
    const path = join(root, 'data', 'install-receipt.json');
    const receipt: InstallReceipt = {
      schemaVersion: 1,
      adapter: 'launchd',
      platform: 'darwin',
      version: '1.4.0',
      installationKey: 'a'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      nodePath: '/usr/local/bin/node',
      cliPath: '/usr/local/lib/node_modules/pimpampum/dist/cli.js',
      dataDirectory: join(root, 'data'),
      baseUrl: 'http://127.0.0.1:7337',
      logDirectory: join(root, 'data', 'logs'),
      artifacts: [],
      updateProvider: 'legacy-npm',
    };
    writeInstallReceipt(path, receipt);
    const snapshot = snapshotInstallReceipt(path)!;
    writeFileSync(path, '{"partial":true}\n');

    restoreInstallReceiptSnapshot(path, snapshot);

    expect(readFileSync(path)).toEqual(snapshot.contents);
  });
});

describe('packaged update rollback hardening', () => {
  it('aggregates every failed update rollback owner after a receipt commit fault', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    vi.mocked(deps.receipt.commit).mockRejectedValue(new Error('new receipt commit failed'));
    vi.mocked(deps.runtime.restore).mockRejectedValueOnce(new Error('runtime restore failed'));
    vi.mocked(deps.service.restore).mockRejectedValueOnce(new Error('service restore failed'));
    vi.mocked(deps.connectors.restoreOwned).mockRejectedValueOnce(
      new Error('host CLI restore failed'),
    );

    const error = await createInstallationLifecycle(deps)
      .update({ targetVersion: '2.0.0' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/new receipt commit failed.*rollback was incomplete/iu);
    expect((error as AggregateError).errors).toHaveLength(5);
  });

  it('uses receipt commit rollback during removal when byte capture is unavailable', async () => {
    const root = temporaryDirectory();
    const deps = dependencies(root);
    delete deps.receipt.capture;
    delete deps.receipt.restore;
    vi.mocked(deps.receipt.remove).mockRejectedValueOnce(new Error('receipt unlink failed'));
    await expect(createInstallationLifecycle(deps).remove()).rejects.toThrow(
      'receipt unlink failed',
    );
    expect(deps.receipt.commit).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeKind: 'legacy-npm' }),
    );
  });

  it('requires receipt capture and exact restore to be configured as a pair', () => {
    const deps = dependencies(temporaryDirectory());
    delete deps.receipt.restore;
    expect(() => createInstallationLifecycle(deps)).toThrow(/configured together/iu);
  });

  it('rejects an update candidate whose staged version differs from the reviewed target', async () => {
    const deps = dependencies(temporaryDirectory());
    vi.mocked(deps.runtime.stage).mockResolvedValueOnce({
      version: 'wrong',
      nodePath: '/new/node',
      cliPath: '/new/cli',
    });
    await expect(
      createInstallationLifecycle(deps).update({ targetVersion: '2.0.0' }),
    ).rejects.toThrow(/staged runtime version mismatch/iu);
    expect(deps.service.stop).not.toHaveBeenCalled();
  });
});
