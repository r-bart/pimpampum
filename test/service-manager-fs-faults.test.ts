import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformServiceManager } from '../src/service/manager.js';
import { installReceiptPath } from '../src/service/receipt.js';
import type { PlatformServiceAdapter } from '../src/service/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const roots: string[] = [];
const defaultRemove = vi.mocked(rmSync).getMockImplementation()!;

afterEach(() => {
  vi.mocked(rmSync).mockClear();
  vi.mocked(rmSync).mockImplementation(defaultRemove);
  for (const root of roots.splice(0)) defaultRemove(root, { recursive: true, force: true });
});

function fixture(label: string): {
  root: string;
  homeDirectory: string;
  dataDirectory: string;
  artifactPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-manager-fault-${label}-`));
  roots.push(root);
  const homeDirectory = join(root, 'home');
  const dataDirectory = join(root, 'data');
  mkdirSync(homeDirectory);
  mkdirSync(dataDirectory);
  return {
    root,
    homeDirectory,
    dataDirectory,
    artifactPath: join(homeDirectory, '.config', 'pimpampum.service'),
  };
}

function adapter(artifactPath: string, rollback?: () => Promise<void>): PlatformServiceAdapter {
  return {
    id: 'fs-fault-adapter',
    platform: 'linux',
    artifacts: () => [{ path: artifactPath, content: 'service', mode: 0o600 }],
    activate: async () => undefined,
    deactivate: async () => undefined,
    ...(rollback === undefined ? {} : { prepareDeactivationRollback: async () => rollback }),
    isRunning: async () => true,
  };
}

async function installedManager(root: ReturnType<typeof fixture>, rollback?: () => Promise<void>) {
  const manager = createPlatformServiceManager({
    platform: 'linux',
    homeDirectory: root.homeDirectory,
    dataDirectory: root.dataDirectory,
    nodePath: '/opt/pimpampum/node',
    cliPath: '/opt/pimpampum/cli.js',
    version: '2.0.0',
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    adapters: { linux: adapter(root.artifactPath, rollback) },
  });
  await manager.install();
  return manager;
}

function failReceiptRemovalOnce(receiptPath: string): void {
  let failed = false;
  vi.mocked(rmSync).mockImplementation(
    (...arguments_: Parameters<typeof rmSync>): ReturnType<typeof rmSync> => {
      if (!failed && arguments_[0] === receiptPath) {
        failed = true;
        throw new Error('receipt unlink failed');
      }
      return defaultRemove(...arguments_);
    },
  );
}

describe('service manager uninstall filesystem faults', () => {
  it('restores a prepared uninstall when receipt removal fails', async () => {
    const root = fixture('commit');
    const manager = await installedManager(root);
    const receiptPath = installReceiptPath(root.dataDirectory);
    const receiptBytes = readFileSync(receiptPath);
    failReceiptRemovalOnce(receiptPath);
    await expect(manager.uninstall()).rejects.toThrow('receipt unlink failed');
    expect(readFileSync(root.artifactPath, 'utf8')).toBe('service');
    expect(readFileSync(receiptPath)).toEqual(receiptBytes);
  });

  it('aggregates receipt removal with official registration rollback failure', async () => {
    const root = fixture('aggregate');
    const manager = await installedManager(root, async () => {
      throw new Error('registration rollback failed');
    });
    failReceiptRemovalOnce(installReceiptPath(root.dataDirectory));
    const error = await manager.uninstall().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toEqual(
      expect.objectContaining({ message: 'receipt unlink failed' }),
    );
    expect((error as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
    expect(((error as AggregateError).errors[1] as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'registration rollback failed' }),
    ]);
  });
});
