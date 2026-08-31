import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformServiceManager } from '../src/service/manager.js';
import {
  installReceiptPath,
  restoreInstallReceiptSnapshot,
  sha256,
  snapshotInstallReceipt,
  writeInstallReceipt,
} from '../src/service/receipt.js';
import type {
  InstallReceipt,
  PlatformServiceAdapter,
  PlatformServiceManagerInput,
} from '../src/service/types.js';

const roots: string[] = [];

function fixture(label: string): { root: string; home: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-service-hostile-${label}-`));
  const home = join(root, 'home');
  const data = join(root, 'data');
  mkdirSync(home);
  mkdirSync(data);
  roots.push(root);
  return { root, home, data };
}

function receipt(data: string, artifacts: InstallReceipt['artifacts'] = []): InstallReceipt {
  return {
    schemaVersion: 1,
    adapter: 'hostile-test',
    platform: 'linux',
    version: '1.0.0',
    installationKey: sha256('installation'),
    installedAt: '2026-08-31T00:00:00.000Z',
    nodePath: '/opt/pimpampum/node',
    cliPath: '/opt/pimpampum/cli.js',
    dataDirectory: data,
    baseUrl: 'http://127.0.0.1:7337',
    logDirectory: join(data, 'logs'),
    artifacts,
  };
}

function adapter(artifactPath: string): PlatformServiceAdapter {
  return {
    id: 'hostile-test',
    platform: 'linux',
    artifacts: () => [{ path: artifactPath, content: 'service', mode: 0o600 }],
    activate: async () => undefined,
    deactivate: async () => undefined,
    isRunning: async () => true,
  };
}

function managerInput(
  root: ReturnType<typeof fixture>,
  overrides: Partial<PlatformServiceManagerInput> = {},
): PlatformServiceManagerInput {
  const artifactPath = join(root.home, '.config', 'pimpampum.service');
  return {
    platform: 'linux',
    homeDirectory: root.home,
    dataDirectory: root.data,
    nodePath: '/opt/pimpampum/node',
    cliPath: '/opt/pimpampum/cli.js',
    version: '1.0.0',
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    adapters: { linux: adapter(artifactPath) },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('hostile installation receipt snapshots', () => {
  it('returns no snapshot when there is no receipt', () => {
    const root = fixture('missing-receipt');
    expect(snapshotInstallReceipt(installReceiptPath(root.data), root.data)).toBeNull();
  });

  it('rejects an oversized otherwise-valid receipt before retaining migration bytes', () => {
    const root = fixture('oversized-receipt');
    const artifacts = Array.from({ length: 5_000 }, (_, index) => ({
      path: join(root.home, 'artifacts', `${index}-${'x'.repeat(80)}`),
      sha256: sha256(String(index)),
      mode: 0o600,
    }));
    const path = installReceiptPath(root.data);
    writeInstallReceipt(path, receipt(root.data, artifacts), root.data);
    expect(statSync(path).size).toBeGreaterThan(700_000);
    expect(() => snapshotInstallReceipt(path, root.data)).toThrow(/snapshot size limit/);
  });

  it('rejects malformed and metadata-mismatched byte snapshots', () => {
    const root = fixture('invalid-restore');
    const path = installReceiptPath(root.data);
    const expected = receipt(root.data);
    expect(() =>
      restoreInstallReceiptSnapshot(
        path,
        { receipt: expected, contents: Buffer.from('{') },
        root.data,
      ),
    ).toThrow(/Invalid installation receipt byte snapshot/);

    const different = { ...expected, version: '2.0.0' };
    expect(() =>
      restoreInstallReceiptSnapshot(
        path,
        { receipt: expected, contents: Buffer.from(JSON.stringify(different)) },
        root.data,
      ),
    ).toThrow(/does not match its metadata/);
  });

  it('restores exact private receipt bytes and mode', () => {
    const root = fixture('valid-restore');
    const path = installReceiptPath(root.data);
    const expected = receipt(root.data);
    const contents = Buffer.from(`${JSON.stringify(expected)}\n`);
    restoreInstallReceiptSnapshot(path, { receipt: expected, contents }, root.data);
    chmodSync(path, 0o644);
    restoreInstallReceiptSnapshot(path, { receipt: expected, contents }, root.data);
    expect(readFileSync(path)).toEqual(contents);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('hostile service manager transitions', () => {
  it.each([
    [
      'a packaged runtime version mismatch',
      { version: '1.0.0', target: 'linux-x64' as const, runtimeDirectory: '/opt/runtime' },
      '2.0.0',
      /version must match/,
    ],
    [
      'a packaged runtime platform mismatch',
      { version: '1.0.0', target: 'darwin-arm64' as const, runtimeDirectory: '/opt/runtime' },
      '1.0.0',
      /target must match/,
    ],
  ])('rejects %s', async (_label, packagedRuntime, version, message) => {
    const root = fixture('runtime-metadata');
    const manager = createPlatformServiceManager(
      managerInput(root, {
        version,
        nodePath: '/opt/runtime/bin/node',
        cliPath: '/opt/runtime/dist/cli.js',
        packagedRuntime,
      }),
    );
    await expect(manager.status()).rejects.toThrow(message);
  });

  it('rejects packaged executables that escape their runtime directory', async () => {
    const root = fixture('runtime-escape');
    const manager = createPlatformServiceManager(
      managerInput(root, {
        nodePath: '/opt/other/node',
        cliPath: '/opt/runtime/dist/cli.js',
        packagedRuntime: {
          version: '1.0.0',
          target: 'linux-x64',
          runtimeDirectory: '/opt/runtime',
        },
      }),
    );
    await expect(manager.status()).rejects.toThrow(/must remain inside/);
  });

  it('enforces the prepared removal state machine and keeps rollback idempotent', async () => {
    const root = fixture('prepared-state');
    const manager = createPlatformServiceManager(managerInput(root));
    await manager.install();
    const prepared = await manager.prepareUninstall?.();
    expect(prepared).not.toBeNull();
    await expect(prepared!.finalize()).rejects.toThrow(/not committed/);
    await expect(prepared!.commit()).resolves.toMatchObject({ uninstalled: true });
    await expect(prepared!.commit()).rejects.toThrow(/already committed/);
    await expect(prepared!.finalize()).resolves.toBeUndefined();
    await expect(prepared!.finalize()).resolves.toBeUndefined();
    await expect(prepared!.commit()).rejects.toThrow(/already complete/);
    await expect(prepared!.rollback()).resolves.toBeUndefined();
  });

  it('rolls a prepared removal back and restores service bytes exactly', async () => {
    const root = fixture('prepared-rollback');
    const artifactPath = join(root.home, '.config', 'pimpampum.service');
    const manager = createPlatformServiceManager(managerInput(root));
    await manager.install();
    const receiptBytes = readFileSync(installReceiptPath(root.data));
    const prepared = await manager.prepareUninstall?.();
    expect(prepared).not.toBeNull();
    await prepared!.rollback();
    await prepared!.rollback();
    expect(readFileSync(artifactPath, 'utf8')).toBe('service');
    expect(readFileSync(installReceiptPath(root.data))).toEqual(receiptBytes);
  });

  it('allows a failed receipt commit to be repaired through rollback', async () => {
    const root = fixture('commit-failure');
    const manager = createPlatformServiceManager(managerInput(root));
    await manager.install();
    const path = installReceiptPath(root.data);
    const prepared = await manager.prepareUninstall?.();
    rmSync(path);
    mkdirSync(path);
    await expect(prepared!.commit()).rejects.toThrow();
    rmSync(path, { recursive: true });
    await expect(prepared!.rollback()).resolves.toBeUndefined();
    expect(readFileSync(path, 'utf8')).toContain('hostile-test');
  });

  it('rejects an activated receipt changed before health verification', async () => {
    const root = fixture('activated-receipt-drift');
    const path = installReceiptPath(root.data);
    const artifactPath = join(root.home, '.config', 'pimpampum.service');
    const hostileAdapter = adapter(artifactPath);
    hostileAdapter.activate = async () => {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...value, version: '9.9.9' })}\n`, { mode: 0o600 });
    };
    const manager = createPlatformServiceManager(
      managerInput(root, {
        adapters: { linux: hostileAdapter },
        postActivationVerifier: async () => undefined,
      }),
    );
    await expect(manager.install()).rejects.toThrow(/receipt does not match/iu);
  });

  it('aggregates a packaged activation verification failure with rollback hook failure', async () => {
    const root = fixture('activation-rollback-failure');
    const artifactPath = join(root.home, '.config', 'pimpampum.service');
    const hostileAdapter = adapter(artifactPath);
    hostileAdapter.prepareDeactivationRollback = async () => async () => {
      throw new Error('previous registration restore failed');
    };
    const manager = createPlatformServiceManager(
      managerInput(root, {
        adapters: { linux: hostileAdapter },
        postActivationVerifier: async () => {
          throw new Error('occupied health port');
        },
      }),
    );
    const error = await manager.install().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'occupied health port' }),
        expect.objectContaining({ message: 'previous registration restore failed' }),
      ]),
    );
  });

  it('repairs an unhealthy existing registration and deactivates it after verification failure', async () => {
    const root = fixture('reconcile-registration-rollback');
    await createPlatformServiceManager(managerInput(root)).install();
    const artifactPath = join(root.home, '.config', 'pimpampum.service');
    const deactivate = vi.fn(async () => undefined);
    const activate = vi.fn(async () => undefined);
    const reconcileAdapter: PlatformServiceAdapter = {
      ...adapter(artifactPath),
      activate,
      deactivate,
      isRunning: async () => false,
    };
    const manager = createPlatformServiceManager(
      managerInput(root, {
        adapters: { linux: reconcileAdapter },
        postActivationVerifier: async () => {
          throw new Error('reconciled service unhealthy');
        },
      }),
    );
    await expect(manager.install()).rejects.toThrow('reconciled service unhealthy');
    expect(activate).toHaveBeenCalledOnce();
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('aggregates an existing registration rollback failure', async () => {
    const root = fixture('reconcile-hook-failure');
    await createPlatformServiceManager(managerInput(root)).install();
    const artifactPath = join(root.home, '.config', 'pimpampum.service');
    const rollback = vi.fn(async () => {
      throw new Error('registration rollback failed');
    });
    const reconcileAdapter: PlatformServiceAdapter = {
      ...adapter(artifactPath),
      isRunning: async () => false,
      prepareDeactivationRollback: async () => rollback,
    };
    const manager = createPlatformServiceManager(
      managerInput(root, {
        adapters: { linux: reconcileAdapter },
        postActivationVerifier: async () => {
          throw new Error('verification failed');
        },
      }),
    );
    const error = await manager.install().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('aggregates artifact replacement races during existing-service rollback', async () => {
    const root = fixture('reconcile-artifact-race');
    await createPlatformServiceManager(managerInput(root)).install();
    const artifactPath = join(root.home, '.config', 'pimpampum.service');
    const manager = createPlatformServiceManager(
      managerInput(root, {
        postActivationVerifier: async () => {
          rmSync(artifactPath);
          mkdirSync(artifactPath);
          throw new Error('verification raced replacement');
        },
      }),
    );
    const error = await manager.install().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'verification raced replacement' }),
      ]),
    );
  });

  it('aggregates a log-directory replacement race during existing-service rollback', async () => {
    const root = fixture('reconcile-log-race');
    await createPlatformServiceManager(managerInput(root)).install();
    const logDirectory = join(root.data, 'logs');
    const manager = createPlatformServiceManager(
      managerInput(root, {
        postActivationVerifier: async () => {
          rmSync(logDirectory, { recursive: true });
          writeFileSync(logDirectory, 'not a directory');
          throw new Error('verification raced log replacement');
        },
      }),
    );
    const error = await manager.install().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'verification raced log replacement' }),
      ]),
    );
  });

  it('returns integration state after successful verification of an existing service', async () => {
    const root = fixture('reconcile-success');
    await createPlatformServiceManager(managerInput(root)).install();
    const artifactPath = join(root.home, '.config', 'pimpampum.service');
    const verified = vi.fn(async () => undefined);
    const reconcileAdapter: PlatformServiceAdapter = {
      ...adapter(artifactPath),
      afterInstall: async () => ({ loginItem: 'enabled' }),
    };
    await expect(
      createPlatformServiceManager(
        managerInput(root, {
          adapters: { linux: reconcileAdapter },
          postActivationVerifier: verified,
        }),
      ).install(),
    ).resolves.toMatchObject({ reconciled: true, loginItem: 'enabled' });
    expect(verified).toHaveBeenCalledOnce();
  });
});
