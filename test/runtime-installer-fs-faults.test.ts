import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installRuntime,
  prepareOwnedRuntimeRemoval,
  recoverInterruptedRuntimeRemoval,
} from '../src/runtime/installer.js';
import type { RuntimeManifest } from '../src/runtime/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const roots: string[] = [];
const defaultClose = vi.mocked(closeSync).getMockImplementation()!;
const defaultLstat = vi.mocked(lstatSync).getMockImplementation()!;
const defaultOpen = vi.mocked(openSync).getMockImplementation()!;
const defaultRename = vi.mocked(renameSync).getMockImplementation()!;
const defaultWrite = vi.mocked(writeFileSync).getMockImplementation()!;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function input(root: string, version: string) {
  const sourceDirectory = join(root, `source-${version}`);
  const contents = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': `export const version = ${JSON.stringify(version)};\n`,
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'addon',
  };
  for (const [relativePath, content] of Object.entries(contents)) {
    const path = join(sourceDirectory, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: relativePath === 'bin/node' ? 0o755 : 0o644 });
  }
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    pimpampumVersion: version,
    nodeVersion: '24.19.0',
    target: { platform: 'darwin', architecture: 'arm64' },
    unpackedBytes: Object.values(contents).reduce(
      (total, content) => total + Buffer.byteLength(content),
      0,
    ),
    entrypoints: { node: 'bin/node', cli: 'dist/cli.js', mcp: 'dist/mcpStdio.js' },
    files: Object.entries(contents).map(([path, content]) => ({
      path,
      sha256: sha256(content),
      mode: path === 'bin/node' ? 0o755 : 0o644,
      size: Buffer.byteLength(content),
    })),
  };
  return {
    homeDirectory: join(root, 'home'),
    dataDirectory: join(root, 'data'),
    platform: 'darwin' as const,
    architecture: 'arm64' as const,
    sourceDirectory,
    manifest,
  };
}

function temporaryDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-runtime-fault-${label}-`));
  roots.push(root);
  return root;
}

function ioError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EIO';
  return error;
}

afterEach(() => {
  for (const mock of [closeSync, lstatSync, openSync, renameSync, writeFileSync]) {
    vi.mocked(mock).mockClear();
  }
  vi.mocked(closeSync).mockImplementation(defaultClose);
  vi.mocked(lstatSync).mockImplementation(defaultLstat);
  vi.mocked(openSync).mockImplementation(defaultOpen);
  vi.mocked(renameSync).mockImplementation(defaultRename);
  vi.mocked(writeFileSync).mockImplementation(defaultWrite);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime installer filesystem fault injection', () => {
  it('propagates non-ENOENT ownership path probe errors', () => {
    const root = temporaryDirectory('probe');
    const runtimeInput = input(root, '2.0.0');
    mkdirSync(runtimeInput.dataDirectory);
    vi.mocked(lstatSync).mockImplementationOnce(() => {
      throw ioError('ownership probe failed');
    });
    expect(() => recoverInterruptedRuntimeRemoval(runtimeInput)).toThrow('ownership probe failed');
  });

  it('closes an atomic metadata descriptor when its first write fails', async () => {
    const root = temporaryDirectory('metadata-write');
    const runtimeInput = input(root, '2.0.0');
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw ioError('metadata write failed');
    });
    await expect(installRuntime({ ...runtimeInput, smoke: async () => undefined })).rejects.toThrow(
      'metadata write failed',
    );
    expect(vi.mocked(closeSync)).toHaveBeenCalled();
  });

  it('rolls activation state back when the stable launcher write fails', async () => {
    const root = temporaryDirectory('activation-write');
    const runtimeInput = input(root, '2.0.0');
    let writes = 0;
    vi.mocked(writeFileSync).mockImplementation(
      (...arguments_: Parameters<typeof writeFileSync>) => {
        writes += 1;
        if (writes === 5) throw ioError('launcher write failed');
        return defaultWrite(...arguments_);
      },
    );
    await expect(installRuntime({ ...runtimeInput, smoke: async () => undefined })).rejects.toThrow(
      'launcher write failed',
    );
    expect(existsSync(join(runtimeInput.dataDirectory, 'runtime-install-journal.json'))).toBe(
      false,
    );
    expect(existsSync(join(runtimeInput.dataDirectory, 'runtime-install-receipt.json'))).toBe(
      false,
    );
  });

  it('preserves an already-owned inactive runtime when reactivation fails', async () => {
    const root = temporaryDirectory('inactive-reactivation-write');
    const first = input(root, '1.0.0');
    await installRuntime({ ...first, smoke: async () => undefined });
    const second = input(root, '2.0.0');
    await installRuntime({ ...second, smoke: async () => undefined });
    let writes = 0;
    vi.mocked(writeFileSync).mockImplementation(
      (...arguments_: Parameters<typeof writeFileSync>) => {
        writes += 1;
        if (writes === 5) throw ioError('inactive launcher write failed');
        return defaultWrite(...arguments_);
      },
    );

    await expect(installRuntime({ ...first, smoke: async () => undefined })).rejects.toThrow(
      'inactive launcher write failed',
    );
    expect(
      JSON.parse(readFileSync(join(first.dataDirectory, 'runtime-install-receipt.json'), 'utf8')),
    ).toMatchObject({ currentVersion: '2.0.0' });
  });

  it('fails closed when the activation journal is replaced with a symlink', async () => {
    const root = temporaryDirectory('activation-journal-symlink');
    const runtimeInput = input(root, '2.0.0');
    await expect(
      installRuntime({
        ...runtimeInput,
        smoke: async () => {
          symlinkSync(
            '/dev/null',
            join(runtimeInput.dataDirectory, 'runtime-install-journal.json'),
          );
        },
      }),
    ).rejects.toThrow(/refusing to replace symlink/iu);
  });

  it('removes quarantine when the durable removal journal write fails', async () => {
    const root = temporaryDirectory('removal-journal-write');
    const runtimeInput = input(root, '2.0.0');
    await installRuntime({ ...runtimeInput, smoke: async () => undefined });
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw ioError('removal journal write failed');
    });
    expect(() => prepareOwnedRuntimeRemoval(runtimeInput)).toThrow('removal journal write failed');
  });

  it('aggregates a removal mutation fault with rollback rename failure', async () => {
    const root = temporaryDirectory('removal-aggregate');
    const first = input(root, '1.0.0');
    await installRuntime({ ...first, smoke: async () => undefined });
    const second = input(root, '2.0.0');
    await installRuntime({ ...second, smoke: async () => undefined });
    let renames = 0;
    vi.mocked(renameSync).mockImplementation((...arguments_: Parameters<typeof renameSync>) => {
      renames += 1;
      if (renames === 2) throw ioError('second quarantine rename failed');
      if (renames === 3) throw ioError('rollback rename failed');
      return defaultRename(...arguments_);
    });
    const error = (() => {
      try {
        prepareOwnedRuntimeRemoval(second);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'second quarantine rename failed' }),
        expect.objectContaining({ message: 'rollback rename failed' }),
      ]),
    );
    expect(
      readFileSync(join(second.dataDirectory, 'runtime-removal-journal.json'), 'utf8'),
    ).toContain('prepared');
  });

  it('rethrows a removal mutation fault after a successful rollback', async () => {
    const root = temporaryDirectory('removal-rollback-success');
    const runtimeInput = input(root, '2.0.0');
    const installed = await installRuntime({ ...runtimeInput, smoke: async () => undefined });
    let failed = false;
    vi.mocked(renameSync).mockImplementation((...arguments_: Parameters<typeof renameSync>) => {
      if (!failed && String(arguments_[1]).endsWith('/0')) {
        failed = true;
        throw ioError('quarantine rename failed');
      }
      return defaultRename(...arguments_);
    });

    expect(() => prepareOwnedRuntimeRemoval(runtimeInput)).toThrow('quarantine rename failed');
    expect(existsSync(installed.nodePath)).toBe(true);
    expect(existsSync(join(runtimeInput.dataDirectory, 'runtime-removal-journal.json'))).toBe(
      false,
    );
  });
});
