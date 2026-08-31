import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256, snapshotInstallReceipt } from '../src/service/receipt.js';
import type { InstallReceipt } from '../src/service/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const roots: string[] = [];

function receipt(dataDirectory: string, version = '1.0.0'): InstallReceipt {
  return {
    schemaVersion: 1,
    adapter: 'launchd',
    platform: 'darwin',
    version,
    installationKey: sha256(`installation-${version}`),
    installedAt: '2026-08-31T00:00:00.000Z',
    nodePath: '/opt/pimpampum/node',
    cliPath: '/opt/pimpampum/cli.js',
    dataDirectory,
    baseUrl: 'http://127.0.0.1:7337',
    logDirectory: join(dataDirectory, 'logs'),
    artifacts: [],
  };
}

function fixture(): { root: string; data: string; path: string; current: InstallReceipt } {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-receipt-race-'));
  roots.push(root);
  const data = join(root, 'data');
  const path = join(data, 'install-receipt.json');
  const current = receipt(data);
  mkdirSync(data);
  writeFileSync(path, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  return { root, data, path, current };
}

afterEach(() => {
  vi.mocked(readFileSync).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installation receipt capture races', () => {
  it('rejects malformed bytes observed after initial validation', () => {
    const { data, path, current } = fixture();
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify(current))
      .mockReturnValueOnce(Buffer.from('{'));
    expect(() => snapshotInstallReceipt(path, data)).toThrow(/changed while.*captured/iu);
  });

  it('rejects valid bytes whose metadata changed after initial validation', () => {
    const { data, path, current } = fixture();
    const changed = receipt(data, '2.0.0');
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify(current))
      .mockReturnValueOnce(Buffer.from(JSON.stringify(changed)));
    expect(() => snapshotInstallReceipt(path, data)).toThrow(/changed while.*captured/iu);
  });
});
