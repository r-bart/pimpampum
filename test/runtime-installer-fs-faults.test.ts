import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
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
  inspectInstalledRuntime,
  installRuntime,
  prepareOwnedRuntimeRemoval,
  recoverInterruptedRuntimeRemoval,
} from '../src/runtime/installer.js';
import { resolveRuntimeLayout } from '../src/runtime/layout.js';
import type { RuntimeManifest } from '../src/runtime/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const roots: string[] = [];
const defaultClose = vi.mocked(closeSync).getMockImplementation()!;
const defaultFsync = vi.mocked(fsyncSync).getMockImplementation()!;
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

/**
 * `writeOwnedFile` opens `<directory>/.<name>.<pid>.<uuid>.tmp` exclusively and writes through the
 * descriptor, so
 * a fault cannot be bound to the final path directly. This records the temporary path of every
 * descriptor `openSync` returns and lets a test name the write it fails by its directory and
 * content (M-T5): the control launcher, the receipt, the removal journal.
 */
interface AtomicWriteTarget {
  descriptor: number;
  temporaryPath: string;
  directory: string;
  content: string;
}

function observeAtomicWrites(onWrite: (target: AtomicWriteTarget) => void): {
  descriptorOf(match: (target: AtomicWriteTarget) => boolean): number | null;
} {
  const paths = new Map<number, string>();
  const seen: AtomicWriteTarget[] = [];
  vi.mocked(openSync).mockImplementation((...arguments_: Parameters<typeof openSync>) => {
    const descriptor = defaultOpen(...arguments_);
    paths.set(descriptor, String(arguments_[0]));
    return descriptor;
  });
  vi.mocked(writeFileSync).mockImplementation((...arguments_: Parameters<typeof writeFileSync>) => {
    const temporaryPath = typeof arguments_[0] === 'number' ? paths.get(arguments_[0]) : undefined;
    if (temporaryPath !== undefined) {
      const target: AtomicWriteTarget = {
        descriptor: arguments_[0] as number,
        temporaryPath,
        directory: dirname(temporaryPath),
        content: String(arguments_[1]),
      };
      seen.push(target);
      onWrite(target);
    }
    return defaultWrite(...arguments_);
  });
  return {
    descriptorOf: (match) => seen.find(match)?.descriptor ?? null,
  };
}

/**
 * Fails the first atomic write that matches and lets every later one through, including the
 * rollback that rewrites the same file from its snapshot.
 */
function failFirstAtomicWrite(
  match: (target: AtomicWriteTarget) => boolean,
  error: Error,
): ReturnType<typeof observeAtomicWrites> {
  let failed = false;
  return observeAtomicWrites((target) => {
    if (!failed && match(target)) {
      failed = true;
      throw error;
    }
  });
}

/** The stable `pimpampum-control` launcher for `version`: written into the shared launchers directory. */
function isControlLauncherWrite(
  target: AtomicWriteTarget,
  layout: ReturnType<typeof resolveRuntimeLayout>,
): boolean {
  return (
    target.directory === layout.launchersDirectory &&
    target.content.includes(layout.versionDirectory) &&
    target.content.includes('dist/cli.js')
  );
}

function isReceiptWrite(target: AtomicWriteTarget, dataDirectory: string): boolean {
  return target.directory === dataDirectory && target.content.includes('"currentVersion"');
}

function isRemovalJournalWrite(target: AtomicWriteTarget, dataDirectory: string): boolean {
  return target.directory === dataDirectory && target.content.includes('"quarantineRoot"');
}

function layoutOf(runtimeInput: ReturnType<typeof input>, version: string) {
  return resolveRuntimeLayout({
    homeDirectory: runtimeInput.homeDirectory,
    platform: runtimeInput.platform,
    architecture: runtimeInput.architecture,
    version,
  });
}

afterEach(() => {
  for (const mock of [closeSync, fsyncSync, lstatSync, openSync, renameSync, writeFileSync]) {
    vi.mocked(mock).mockClear();
  }
  vi.mocked(closeSync).mockImplementation(defaultClose);
  vi.mocked(fsyncSync).mockImplementation(defaultFsync);
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

  it('closes the staging-owner descriptor and leaves no stage when its write fails', async () => {
    const root = temporaryDirectory('metadata-write');
    const runtimeInput = input(root, '2.0.0');
    const layout = layoutOf(runtimeInput, '2.0.0');
    const writes = failFirstAtomicWrite(
      (target) => target.content.includes('pimpampum-runtime-installer'),
      ioError('metadata write failed'),
    );
    await expect(installRuntime({ ...runtimeInput, smoke: async () => undefined })).rejects.toThrow(
      'metadata write failed',
    );
    const descriptor = writes.descriptorOf((target) =>
      target.content.includes('pimpampum-runtime-installer'),
    );
    expect(descriptor).not.toBeNull();
    expect(vi.mocked(closeSync)).toHaveBeenCalledWith(descriptor);
    // The staging root lives beside the destination, one level below the versions root. Before
    // the marker write moved inside the cleanup boundary, a failed marker left an empty stage
    // that the next install refused as not receipt-owned.
    expect(existsSync(dirname(layout.versionDirectory))).toBe(false);
    expect(
      readdirSync(layout.versionsDirectory).filter((name) => name.startsWith('.pimpampum-stage-')),
    ).toEqual([]);
  });

  it('leaves no journal, receipt or launcher when the stable control launcher write fails', async () => {
    const root = temporaryDirectory('activation-write');
    const runtimeInput = input(root, '2.0.0');
    const layout = layoutOf(runtimeInput, '2.0.0');
    failFirstAtomicWrite(
      (target) => isControlLauncherWrite(target, layout),
      ioError('launcher write failed'),
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
    expect(existsSync(layout.controlLauncherPath)).toBe(false);
    expect(existsSync(layout.mcpLauncherPath)).toBe(false);
  });

  it('keeps the active receipt when the control launcher write of a reactivated version fails', async () => {
    const root = temporaryDirectory('inactive-reactivation-write');
    const first = input(root, '1.0.0');
    await installRuntime({ ...first, smoke: async () => undefined });
    const second = input(root, '2.0.0');
    const active = await installRuntime({ ...second, smoke: async () => undefined });
    const firstLayout = layoutOf(first, '1.0.0');
    failFirstAtomicWrite(
      (target) => isControlLauncherWrite(target, firstLayout),
      ioError('inactive launcher write failed'),
    );

    await expect(installRuntime({ ...first, smoke: async () => undefined })).rejects.toThrow(
      'inactive launcher write failed',
    );
    expect(
      JSON.parse(readFileSync(join(first.dataDirectory, 'runtime-install-receipt.json'), 'utf8')),
    ).toMatchObject({ currentVersion: '2.0.0' });
    expect(inspectInstalledRuntime(second)).toMatchObject({
      version: '2.0.0',
      nodePath: active.nodePath,
    });
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

  it('removes the quarantine root and keeps the runtime when the removal journal write fails', async () => {
    const root = temporaryDirectory('removal-journal-write');
    const runtimeInput = input(root, '2.0.0');
    const installed = await installRuntime({ ...runtimeInput, smoke: async () => undefined });
    const layout = layoutOf(runtimeInput, '2.0.0');
    failFirstAtomicWrite(
      (target) => isRemovalJournalWrite(target, runtimeInput.dataDirectory),
      ioError('removal journal write failed'),
    );
    expect(() => prepareOwnedRuntimeRemoval(runtimeInput)).toThrow('removal journal write failed');
    expect(
      readdirSync(layout.versionsDirectory).filter((name) => name.startsWith('.pimpampum-remove-')),
    ).toEqual([]);
    expect(existsSync(installed.nodePath)).toBe(true);
    expect(existsSync(join(runtimeInput.dataDirectory, 'runtime-removal-journal.json'))).toBe(
      false,
    );
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

  it('fsyncs every payload file and directory before renaming the staged payload into place', async () => {
    const root = temporaryDirectory('fsync-before-rename');
    const runtimeInput = input(root, '2.0.0');
    const layout = resolveRuntimeLayout({
      homeDirectory: runtimeInput.homeDirectory,
      platform: runtimeInput.platform,
      architecture: runtimeInput.architecture,
      version: '2.0.0',
    });
    const openPaths = new Map<number, string>();
    const fsyncedPaths: string[] = [];
    let activationRenameIndex: number | null = null;
    vi.mocked(openSync).mockImplementation((...arguments_: Parameters<typeof openSync>) => {
      const descriptor = defaultOpen(...arguments_);
      openPaths.set(descriptor, String(arguments_[0]));
      return descriptor;
    });
    vi.mocked(fsyncSync).mockImplementation((descriptor: number) => {
      fsyncedPaths.push(openPaths.get(descriptor) ?? `fd:${descriptor}`);
      return defaultFsync(descriptor);
    });
    vi.mocked(renameSync).mockImplementation((...arguments_: Parameters<typeof renameSync>) => {
      if (String(arguments_[1]) === layout.versionDirectory) {
        activationRenameIndex = fsyncedPaths.length;
      }
      return defaultRename(...arguments_);
    });

    await installRuntime({ ...runtimeInput, smoke: async () => undefined });

    expect(activationRenameIndex).not.toBeNull();
    const fsyncedBeforeActivation = fsyncedPaths.slice(0, activationRenameIndex ?? 0);
    const fsyncedAfterActivation = fsyncedPaths.slice(activationRenameIndex ?? 0);
    const stagedPayloads = new Set(
      fsyncedBeforeActivation.filter(
        (path) => path.includes('/.pimpampum-stage-') && path.endsWith('/payload'),
      ),
    );
    expect(stagedPayloads.size).toBe(1);
    const [payload] = [...stagedPayloads];
    for (const relativePath of [
      'bin/node',
      'dist/cli.js',
      'dist/mcpStdio.js',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'bin',
      'dist',
      'node_modules',
      'node_modules/better-sqlite3',
      'node_modules/better-sqlite3/build',
      'node_modules/better-sqlite3/build/Release',
    ]) {
      expect(fsyncedBeforeActivation, relativePath).toContain(join(payload!, relativePath));
    }
    expect(fsyncedAfterActivation).toContain(dirname(layout.versionDirectory));
  });

  it('leaves the installed runtime untouched when a status inspection runs mid-activation', async () => {
    const root = temporaryDirectory('concurrent-inspect');
    const first = input(root, '1.0.0');
    const installedFirst = await installRuntime({ ...first, smoke: async () => undefined });
    const second = input(root, '2.0.0');
    const observed: unknown[] = [];
    const secondLayout = layoutOf(second, '2.0.0');
    observeAtomicWrites((target) => {
      // At the control launcher write the journal is durable and the candidate directory has been
      // renamed in, but launchers and receipt still describe 1.0.0. At the receipt write both
      // launchers already point at 2.0.0.
      if (
        isControlLauncherWrite(target, secondLayout) ||
        isReceiptWrite(target, second.dataDirectory)
      ) {
        try {
          observed.push(inspectInstalledRuntime(second));
        } catch (error) {
          observed.push(error);
        }
      }
    });

    const installedSecond = await installRuntime({ ...second, smoke: async () => undefined });

    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({ version: '1.0.0', nodePath: installedFirst.nodePath });
    expect(observed[1]).toBeInstanceOf(Error);
    expect((observed[1] as Error).message).toMatch(/in progress or was interrupted/iu);
    expect(installedSecond).toMatchObject({ activated: true, version: '2.0.0' });
    expect(existsSync(installedSecond.nodePath)).toBe(true);
    expect(existsSync(join(second.dataDirectory, 'runtime-install-journal.json'))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(second.dataDirectory, 'runtime-install-receipt.json'), 'utf8')),
    ).toMatchObject({ currentVersion: '2.0.0' });
    expect(inspectInstalledRuntime(second)).toMatchObject({
      version: '2.0.0',
      nodePath: installedSecond.nodePath,
    });
  });

  it('restores the quarantined drifted copy when a repair fails before its receipt commits', async () => {
    const root = temporaryDirectory('repair-rollback');
    const runtimeInput = input(root, '2.0.0');
    const installed = await installRuntime({ ...runtimeInput, smoke: async () => undefined });
    const layout = resolveRuntimeLayout({
      homeDirectory: runtimeInput.homeDirectory,
      platform: runtimeInput.platform,
      architecture: runtimeInput.architecture,
      version: '2.0.0',
    });
    const receiptPath = join(runtimeInput.dataDirectory, 'runtime-install-receipt.json');
    writeFileSync(installed.cliPath, 'corrupt bytes the receipt still owns');
    const driftedBytes = readFileSync(installed.cliPath);
    const receiptBytes = readFileSync(receiptPath);
    // The rollback rewrites the same launcher from its snapshot, so only the first write fails.
    failFirstAtomicWrite(
      (target) => isControlLauncherWrite(target, layout),
      ioError('launcher write failed during repair'),
    );

    await expect(installRuntime({ ...runtimeInput, smoke: async () => undefined })).rejects.toThrow(
      'launcher write failed during repair',
    );

    expect(readFileSync(installed.cliPath)).toEqual(driftedBytes);
    expect(readFileSync(receiptPath)).toEqual(receiptBytes);
    expect(
      readdirSync(layout.versionsDirectory).filter((name) => name.startsWith('.pimpampum-')),
    ).toEqual([]);
    expect(existsSync(join(runtimeInput.dataDirectory, 'runtime-install-journal.json'))).toBe(
      false,
    );
    expect(inspectInstalledRuntime(runtimeInput)).toMatchObject({ version: '2.0.0' });
  });
});
