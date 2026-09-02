import {
  fsyncSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRIVATE_FILE_MODE,
  readPrivateFileBounded,
  writePrivateFileAtomic,
} from '../src/fsAtomic.js';
import { temporaryDirectory } from './helpers/tmp.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

type WriteArguments = Parameters<typeof writeFileSync>;
const actualWrite = vi.mocked(writeFileSync).getMockImplementation()! as (
  ...args: WriteArguments
) => void;

/** Runs `during` while the outer writer holds its open partial, then lets the write proceed. */
function interleave(during: () => void): void {
  vi.mocked(writeFileSync).mockImplementationOnce((...args: WriteArguments) => {
    during();
    actualWrite(...args);
  });
}

function partials(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.tmp'));
}

afterEach(() => {
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(writeFileSync).mockImplementation(actualWrite);
  vi.mocked(fsyncSync).mockClear();
});

describe('writePrivateFileAtomic', () => {
  it('creates the file with the requested mode and fsyncs the file and its directory', () => {
    const root = temporaryDirectory();
    const path = join(root, 'state.json');
    writePrivateFileAtomic(path, '{"a":1}\n', { mode: 0o640 });
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(vi.mocked(fsyncSync)).toHaveBeenCalledTimes(2);
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('defaults to 0o600, accepts bytes and skips fsync when asked', () => {
    const root = temporaryDirectory();
    const path = join(root, 'bytes.bin');
    writePrivateFileAtomic(path, new Uint8Array([1, 2, 3]), { fsync: false });
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
    expect(statSync(path).mode & 0o777).toBe(DEFAULT_PRIVATE_FILE_MODE);
    expect(vi.mocked(fsyncSync)).not.toHaveBeenCalled();
  });

  it('replaces an existing regular file and keeps the mode it was given', () => {
    const root = temporaryDirectory();
    const path = join(root, 'state.json');
    writeFileSync(path, 'old', { mode: 0o644 });
    writePrivateFileAtomic(path, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(partials(root)).toEqual([]);
  });

  it('creates missing parents with directoryMode and otherwise requires them to exist', () => {
    const root = temporaryDirectory();
    const nested = join(root, 'a', 'b');
    writePrivateFileAtomic(join(nested, 'file'), 'x', { directoryMode: 0o700 });
    expect(readFileSync(join(nested, 'file'), 'utf8')).toBe('x');
    expect(statSync(nested).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'a')).mode & 0o777).toBe(0o700);
    expect(() => writePrivateFileAtomic(join(root, 'missing', 'file'), 'x')).toThrow(
      /Private file parent must be an existing directory/u,
    );
  });

  it('rejects a relative path, a symlinked parent and a parent that is not a directory', () => {
    const root = temporaryDirectory();
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    writeFileSync(join(root, 'plain'), 'x');
    expect(() => writePrivateFileAtomic('relative/file', 'x')).toThrow(/must be an absolute path/u);
    expect(() => writePrivateFileAtomic(join(root, 'link', 'file'), 'x')).toThrow(
      /Private file parent must not be a symbolic link/u,
    );
    expect(() => writePrivateFileAtomic(join(root, 'plain', 'file'), 'x')).toThrow(
      /Private file parent must be a regular directory/u,
    );
    expect(readdirSync(real)).toEqual([]);
  });

  it('rejects a symlinked or directory target and propagates other lstat failures', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'victim'), 'keep');
    symlinkSync(join(root, 'victim'), join(root, 'link'));
    mkdirSync(join(root, 'dir'));
    expect(() => writePrivateFileAtomic(join(root, 'link'), 'x', { label: 'Receipt' })).toThrow(
      /Receipt must not be a symbolic link/u,
    );
    expect(readFileSync(join(root, 'victim'), 'utf8')).toBe('keep');
    let caught: NodeJS.ErrnoException | null = null;
    try {
      writePrivateFileAtomic(join(root, 'dir'), 'x');
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }
    expect(caught?.code).toBe('EISDIR');
    expect(() => writePrivateFileAtomic(join(root, 'n'.repeat(300)), 'x')).toThrow(/ENAMETOOLONG/u);
    expect(partials(root)).toEqual([]);
  });

  it('gives two interleaved writers distinct partials and refuses to clobber the one that won', () => {
    const root = temporaryDirectory();
    const path = join(root, 'state.json');
    let seen: string[] = [];
    interleave(() => writePrivateFileAtomic(path, 'second'));
    interleave(() => {
      seen = partials(root);
    });
    expect(() => writePrivateFileAtomic(path, 'first')).toThrow(
      /Private file changed concurrently/u,
    );
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    for (const name of seen) {
      expect(name).toMatch(
        new RegExp(`^\\.state\\.json\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`, 'u'),
      );
    }
    expect(readFileSync(path, 'utf8')).toBe('second');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('refuses to publish when the existing target was replaced or removed meanwhile', () => {
    const root = temporaryDirectory();
    const path = join(root, 'state.json');
    writeFileSync(path, 'original');
    interleave(() => writePrivateFileAtomic(path, 'replaced'));
    expect(() => writePrivateFileAtomic(path, 'outer')).toThrow(/changed concurrently/u);
    expect(readFileSync(path, 'utf8')).toBe('replaced');
    interleave(() => rmSync(path));
    expect(() => writePrivateFileAtomic(path, 'outer')).toThrow(/changed concurrently/u);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a link between the trusted root and the parent before creating it and before the rename', () => {
    const root = temporaryDirectory();
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    expect(() =>
      writePrivateFileAtomic(join(root, 'link', 'sub', 'file'), 'x', {
        trustedRoot: root,
        directoryMode: 0o700,
        label: 'Receipt',
      }),
    ).toThrow(/Receipt parent must not traverse symbolic links/u);
    expect(readdirSync(real)).toEqual([]);
    const directory = join(root, 'dir');
    mkdirSync(directory);
    interleave(() => {
      rmSync(directory, { recursive: true });
      symlinkSync(real, directory);
    });
    expect(() =>
      writePrivateFileAtomic(join(directory, 'file'), 'x', { trustedRoot: root }),
    ).toThrow(/Private file parent must not traverse symbolic links/u);
    expect(readdirSync(real)).toEqual([]);
    writePrivateFileAtomic(join(root, 'plain'), 'ok', { trustedRoot: root });
    expect(readFileSync(join(root, 'plain'), 'utf8')).toBe('ok');
  });

  it('closes the partial and removes it when the write itself fails', () => {
    const root = temporaryDirectory();
    const path = join(root, 'state.json');
    writeFileSync(path, 'original');
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => writePrivateFileAtomic(path, 'outer')).toThrow(/disk full/u);
    expect(readFileSync(path, 'utf8')).toBe('original');
    expect(readdirSync(root)).toEqual(['state.json']);
  });
});

describe('readPrivateFileBounded', () => {
  it('returns the exact bytes up to and including the limit', () => {
    const root = temporaryDirectory();
    const path = join(root, 'file');
    writeFileSync(path, 'exact');
    expect(readPrivateFileBounded(path, 5).toString('utf8')).toBe('exact');
    expect(readPrivateFileBounded(path, 1_000).toString('utf8')).toBe('exact');
    writeFileSync(join(root, 'empty'), '');
    expect(readPrivateFileBounded(join(root, 'empty'), 0)).toHaveLength(0);
  });

  it('reassembles a file larger than one read chunk', () => {
    const root = temporaryDirectory();
    const path = join(root, 'large');
    const content = Buffer.alloc(200_000, 7);
    writeFileSync(path, content);
    expect(readPrivateFileBounded(path, 300_000).equals(content)).toBe(true);
  });

  it('refuses a file over the limit after reading at most one byte past it', () => {
    const root = temporaryDirectory();
    const path = join(root, 'file');
    writeFileSync(path, 'six by');
    expect(() => readPrivateFileBounded(path, 5, { label: 'Snapshot' })).toThrow(
      /Snapshot exceeds the size limit/u,
    );
    expect(() => readPrivateFileBounded(path, 0)).toThrow(/exceeds the size limit/u);
    writeFileSync(join(root, 'large'), Buffer.alloc(70_000));
    expect(() => readPrivateFileBounded(join(root, 'large'), 65_536)).toThrow(
      /exceeds the size limit/u,
    );
  });

  it('validates the path and the limit before touching the filesystem', () => {
    const root = temporaryDirectory();
    const path = join(root, 'file');
    writeFileSync(path, 'x');
    expect(() => readPrivateFileBounded('relative', 1)).toThrow(/must be an absolute path/u);
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => readPrivateFileBounded(path, limit)).toThrow(
        /size limit must be a non-negative integer/u,
      );
    }
  });

  it('rejects a symbolic link by default and follows it only when asked', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'target'), 'linked');
    symlinkSync(join(root, 'target'), join(root, 'link'));
    expect(() => readPrivateFileBounded(join(root, 'link'), 100)).toThrow(
      /must not be a symbolic link/u,
    );
    expect(readPrivateFileBounded(join(root, 'link'), 100, { noFollow: false }).toString()).toBe(
      'linked',
    );
    expect(lstatSync(join(root, 'link')).isSymbolicLink()).toBe(true);
  });

  it('reports a directory as EISDIR whether seen through lstat or the open descriptor', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'dir'));
    symlinkSync(join(root, 'dir'), join(root, 'dir-link'));
    for (const [path, options] of [
      [join(root, 'dir'), {}],
      [join(root, 'dir-link'), { noFollow: false }],
    ] as const) {
      let caught: NodeJS.ErrnoException | null = null;
      try {
        readPrivateFileBounded(path, 100, options);
      } catch (error) {
        caught = error as NodeJS.ErrnoException;
      }
      expect(caught?.code).toBe('EISDIR');
      expect(caught?.message).toMatch(/must be a regular file/u);
    }
  });

  it('rejects a device reached through a followed link', () => {
    const root = temporaryDirectory();
    symlinkSync('/dev/null', join(root, 'null-link'));
    let caught: NodeJS.ErrnoException | null = null;
    try {
      readPrivateFileBounded(join(root, 'null-link'), 100, { noFollow: false });
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }
    expect(caught?.message).toMatch(/must be a regular file/u);
    expect(caught?.code).toBeUndefined();
  });

  it('reads back what writePrivateFileAtomic published', () => {
    const root = temporaryDirectory();
    const path = join(root, 'round-trip.json');
    writePrivateFileAtomic(path, '{"ok":true}\n');
    expect(readPrivateFileBounded(path, 64).toString('utf8')).toBe('{"ok":true}\n');
  });
});
