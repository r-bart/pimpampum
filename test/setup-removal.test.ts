import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInstallationLifecycle,
  type InstallationLifecycleDependencies,
} from '../src/setup/coordinator.js';
import type { InstallationSnapshot } from '../src/setup/types.js';
import { createPlatformServiceManager } from '../src/service/manager.js';
import { installReceiptPath } from '../src/service/receipt.js';
import type { PlatformServiceAdapter } from '../src/service/types.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'pimpampum-removal-'));
  temporaryDirectories.push(path);
  return path;
}

function removalDependencies(root: string): InstallationLifecycleDependencies & {
  events: string[];
  receiptBytes: { value: Buffer };
  previous: InstallationSnapshot;
} {
  const events: string[] = [];
  const dataDirectory = join(root, 'data');
  const previous: InstallationSnapshot = {
    runtimeVersion: '2.0.0',
    serviceCommand: [join(root, 'runtime/bin/node'), join(root, 'runtime/dist/cli.js')],
    connectorEntries: {},
    adapter: 'launchd-macos-app',
    dataDirectory,
    runtimeKind: 'packaged',
  };
  const receiptBytes = { value: Buffer.from('{"exact":"install receipt"}\n') };
  return {
    dataDirectory,
    homeDirectory: join(root, 'home'),
    lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
    runtime: {
      stage: vi.fn(async () => {
        throw new Error('not used');
      }),
      activate: vi.fn(async () => undefined),
      restore: vi.fn(async () => {
        events.push('runtime.restore');
      }),
      removeOwned: vi.fn(async () => {
        events.push('runtime.remove');
      }),
      finalizeRemoval: vi.fn(async () => {
        events.push('runtime.finalize');
      }),
    },
    service: {
      stop: vi.fn(async () => {
        events.push('service.stop');
      }),
      install: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      restore: vi.fn(async () => {
        events.push('service.restore');
      }),
      removeOwned: vi.fn(async () => {
        events.push('service.remove');
      }),
      finalizeRemoval: vi.fn(async () => {
        events.push('service.finalize');
      }),
    },
    connectors: {
      reconcileOwned: vi.fn(async () => undefined),
      snapshotOwned: vi.fn(async () => ({})),
      planRemoval: vi.fn(async () => ({
        ownedEntries: { codex: { snapshot: 'owned-codex-route' } },
        unprovenConnectorIds: ['claude-code', 'invalid connector token=secret'],
      })),
      disconnectOwned: vi.fn(async () => {
        events.push('connectors.disconnect');
      }),
      restoreOwned: vi.fn(async () => {
        events.push('connectors.restore');
      }),
    },
    receipt: {
      read: vi.fn(async () => previous),
      capture: vi.fn(async () => ({ snapshot: previous, contents: receiptBytes.value })),
      commit: vi.fn(async () => {
        events.push('receipt.commit');
      }),
      restore: vi.fn(async ({ contents }) => {
        events.push('receipt.restore');
        receiptBytes.value = Buffer.from(contents);
      }),
      remove: vi.fn(async () => {
        events.push('receipt.remove');
        receiptBytes.value = Buffer.alloc(0);
      }),
    },
    events,
    receiptBytes,
    previous,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('connector-aware reversible installation removal', () => {
  it('rejects an invalid existing receipt before staging or stopping an update', async () => {
    const root = temporaryDirectory();
    const dependencies = removalDependencies(root);
    dependencies.previous.serviceCommand = [join(root, 'runtime/bin/node')];

    await expect(
      createInstallationLifecycle(dependencies).update({ targetVersion: '3.0.0' }),
    ).rejects.toThrow(/service command is incomplete/iu);
    expect(dependencies.runtime.stage).not.toHaveBeenCalled();
    expect(dependencies.service.stop).not.toHaveBeenCalled();
  });

  it('disconnects only proven-owned routes and preserves every canonical data byte', async () => {
    const root = temporaryDirectory();
    const dependencies = removalDependencies(root);
    const preserved = {
      token: Buffer.from([0, 1, 255]),
      'pimpampum.sqlite': Buffer.from('sqlite bytes'),
      'backups/latest.sqlite': Buffer.from('backup bytes'),
      'exports/project.md': Buffer.from('# export\n'),
      'sync/state.json': Buffer.from('{"cursor":1}\n'),
    };
    for (const [relative, contents] of Object.entries(preserved)) {
      const path = join(dependencies.dataDirectory, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, contents);
    }

    await expect(createInstallationLifecycle(dependencies).remove()).resolves.toEqual({
      removed: true,
      dataPreserved: true,
      manualInstructions: [
        "The claude-code entry was left unchanged because Pimpampum could not prove ownership. Review only the Pimpampum entry in that agent's settings.",
      ],
    });
    expect(dependencies.connectors.disconnectOwned).toHaveBeenCalledWith({
      codex: { snapshot: 'owned-codex-route' },
    });
    expect(dependencies.events).toEqual([
      'service.stop',
      'connectors.disconnect',
      'service.remove',
      'runtime.remove',
      'receipt.remove',
      'runtime.finalize',
      'service.finalize',
    ]);
    for (const [relative, contents] of Object.entries(preserved)) {
      expect(readFileSync(join(dependencies.dataDirectory, relative))).toEqual(contents);
    }
  });

  it('rolls back connector, service, and runtime removals after a late runtime failure', async () => {
    const root = temporaryDirectory();
    const dependencies = removalDependencies(root);
    vi.mocked(dependencies.runtime.removeOwned).mockImplementationOnce(async () => {
      dependencies.events.push('runtime.remove');
      throw new Error('runtime directory busy');
    });

    await expect(createInstallationLifecycle(dependencies).remove()).rejects.toThrow(
      'runtime directory busy',
    );

    expect(dependencies.receipt.remove).not.toHaveBeenCalled();
    expect(dependencies.events.slice(-3)).toEqual([
      'runtime.restore',
      'service.restore',
      'connectors.restore',
    ]);
  });

  it('restores exact receipt bytes and aggregates an official host rollback failure', async () => {
    const root = temporaryDirectory();
    const dependencies = removalDependencies(root);
    const originalReceipt = Buffer.from(dependencies.receiptBytes.value);
    vi.mocked(dependencies.receipt.remove).mockImplementationOnce(async () => {
      dependencies.events.push('receipt.remove');
      dependencies.receiptBytes.value = Buffer.from('partial receipt removal');
      throw new Error('receipt unlink failed');
    });
    vi.mocked(dependencies.connectors.restoreOwned).mockImplementationOnce(async () => {
      dependencies.events.push('connectors.restore');
      throw new Error('Codex CLI restore failed');
    });

    const error = await createInstallationLifecycle(dependencies)
      .remove()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/receipt unlink failed.*rollback was incomplete/iu);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'receipt unlink failed' }),
        expect.objectContaining({ message: 'Codex CLI restore failed' }),
      ]),
    );
    expect(dependencies.receiptBytes.value).toEqual(originalReceipt);
  });

  it.each([
    ['service stop', 'service.stop'],
    ['connector disconnect', 'connectors.disconnect'],
    ['service artifact removal', 'service.remove'],
    ['runtime quarantine removal', 'runtime.remove'],
    ['receipt removal', 'receipt.remove'],
    ['runtime quarantine finalization', 'runtime.finalize'],
    ['service removal finalization', 'service.finalize'],
  ] as const)(
    'rolls back a failure during %s without touching preserved data',
    async (_label, phase) => {
      const root = temporaryDirectory();
      const dependencies = removalDependencies(root);
      const preservedPath = join(dependencies.dataDirectory, 'pimpampum.sqlite');
      const preservedBytes = Buffer.from([0, 255, 1, 2, 3]);
      mkdirSync(dependencies.dataDirectory, { recursive: true });
      writeFileSync(preservedPath, preservedBytes);

      const operations = {
        'service.stop': dependencies.service.stop,
        'connectors.disconnect': dependencies.connectors.disconnectOwned,
        'service.remove': dependencies.service.removeOwned,
        'runtime.remove': dependencies.runtime.removeOwned,
        'receipt.remove': dependencies.receipt.remove,
        'runtime.finalize': dependencies.runtime.finalizeRemoval!,
        'service.finalize': dependencies.service.finalizeRemoval!,
      };
      vi.mocked(operations[phase]).mockRejectedValueOnce(new Error(`${phase} fault`));

      await expect(createInstallationLifecycle(dependencies).remove()).rejects.toThrow(
        `${phase} fault`,
      );
      expect(readFileSync(preservedPath)).toEqual(preservedBytes);

      if (phase !== 'service.stop') {
        expect(dependencies.service.restore).toHaveBeenCalledWith(dependencies.previous);
      }
      if (phase !== 'service.stop' && phase !== 'connectors.disconnect') {
        expect(dependencies.connectors.restoreOwned).toHaveBeenCalledWith({
          codex: { snapshot: 'owned-codex-route' },
        });
      }
      if (
        phase === 'runtime.remove' ||
        phase === 'receipt.remove' ||
        phase === 'runtime.finalize' ||
        phase === 'service.finalize'
      ) {
        expect(dependencies.runtime.restore).toHaveBeenCalledWith('2.0.0');
      }
    },
  );
});

describe('prepared service uninstall transaction', () => {
  it('keeps its receipt until commit and can restore removed service bytes exactly', async () => {
    const root = temporaryDirectory();
    const homeDirectory = join(root, 'home');
    const dataDirectory = join(root, 'data');
    const artifactPath = join(homeDirectory, '.config', 'pimpampum.service');
    mkdirSync(homeDirectory, { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    const adapter: PlatformServiceAdapter = {
      id: 'prepared-removal-test',
      platform: 'linux',
      artifacts: () => [{ path: artifactPath, content: 'service bytes\n', mode: 0o600 }],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    };
    const manager = createPlatformServiceManager({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      nodePath: '/opt/pimpampum/bin/node',
      cliPath: '/opt/pimpampum/dist/cli.js',
      version: '2.0.0',
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      adapters: { linux: adapter },
    });
    await manager.install();
    const receiptPath = installReceiptPath(dataDirectory);
    const originalReceipt = readFileSync(receiptPath);
    const prepared = await manager.prepareUninstall!();
    expect(prepared).not.toBeNull();
    expect(existsSync(artifactPath)).toBe(false);
    expect(readFileSync(receiptPath)).toEqual(originalReceipt);

    await prepared!.rollback();
    expect(readFileSync(artifactPath, 'utf8')).toBe('service bytes\n');
    expect(readFileSync(receiptPath)).toEqual(originalReceipt);

    const committed = await manager.prepareUninstall!();
    await expect(committed!.commit()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    await committed!.finalize();
    expect(existsSync(receiptPath)).toBe(false);
  });
});
