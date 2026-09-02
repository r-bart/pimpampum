import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAbsolutePath,
  assertNoSymlinkTraversal,
  assertRegularDirectory,
  assertRegularFile,
  assertRegularFileMetadata,
  walkRegularTree,
  type TreeEntry,
} from '../src/fsGuards.js';
import { temporaryDirectory } from './helpers/tmp.js';

function makeFifo(path: string): void {
  execFileSync('/usr/bin/mkfifo', [path]);
}

describe('assertNoSymlinkTraversal', () => {
  it('rejects relative paths, NUL bytes and relative roots', () => {
    const root = temporaryDirectory();
    expect(() => assertNoSymlinkTraversal('relative/file', 'Thing', root)).toThrow(
      /must be an absolute path/u,
    );
    expect(() => assertNoSymlinkTraversal(`${root}/a\0b`, 'Thing', root)).toThrow(
      /must be an absolute path/u,
    );
    expect(() => assertNoSymlinkTraversal(join(root, 'file'), 'Thing', 'relative')).toThrow(
      /must be an absolute path/u,
    );
  });

  it('rejects a path that escapes its trusted root', () => {
    const root = temporaryDirectory();
    expect(() => assertNoSymlinkTraversal(join(root, '..'), 'Thing', root)).toThrow(
      /must remain inside its trusted root/u,
    );
    expect(() => assertNoSymlinkTraversal(join(root, '..', 'sibling'), 'Thing', root)).toThrow(
      /must remain inside its trusted root/u,
    );
  });

  it('rejects a symbolic link at any existing segment and the root itself', () => {
    const root = temporaryDirectory();
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    expect(() => assertNoSymlinkTraversal(join(root, 'link', 'file'), 'Thing', root)).toThrow(
      /must not traverse symbolic links/u,
    );
    expect(() => assertNoSymlinkTraversal(join(root, 'link'), 'Thing')).toThrow(
      /must not traverse symbolic links/u,
    );
  });

  it('accepts regular segments and stops at the first missing one', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'file'), 'x');
    expect(() =>
      assertNoSymlinkTraversal(join(root, 'a', 'b', 'file'), 'Thing', root),
    ).not.toThrow();
    expect(() =>
      assertNoSymlinkTraversal(join(root, 'a', 'missing', 'file'), 'Thing', root),
    ).not.toThrow();
    expect(() => assertNoSymlinkTraversal(root, 'Thing')).not.toThrow();
  });
});

describe('assertAbsolutePath', () => {
  it('accepts absolute NUL-free paths and rejects the rest', () => {
    expect(() => assertAbsolutePath('/absolute', 'Thing')).not.toThrow();
    expect(() => assertAbsolutePath('relative', 'Thing')).toThrow(
      /Thing must be an absolute path/u,
    );
    expect(() => assertAbsolutePath('/abs\0olute', 'Thing')).toThrow(/must be an absolute path/u);
  });
});

describe('assertRegularFile and assertRegularDirectory', () => {
  it('return the metadata of a regular file or directory', () => {
    const root = temporaryDirectory();
    const file = join(root, 'file');
    writeFileSync(file, 'content');
    expect(assertRegularFile(file, 'File').size).toBe(7);
    expect(assertRegularDirectory(root, 'Directory').isDirectory()).toBe(true);
  });

  it('name the missing entry and its kind', () => {
    const root = temporaryDirectory();
    expect(() => assertRegularFile(join(root, 'missing'), 'File')).toThrow(
      /File must be an existing file: .*missing/u,
    );
    expect(() => assertRegularDirectory(join(root, 'missing'), 'Directory')).toThrow(
      /Directory must be an existing directory: .*missing/u,
    );
  });

  it('propagate lstat failures other than a missing entry', () => {
    const root = temporaryDirectory();
    const file = join(root, 'file');
    writeFileSync(file, 'x');
    expect(() => assertRegularFile(join(file, 'child'), 'File')).toThrow(/ENOTDIR/u);
    expect(() => assertRegularDirectory(join(file, 'child'), 'Directory')).toThrow(/ENOTDIR/u);
  });

  it('reject relative paths', () => {
    expect(() => assertRegularFile('relative', 'File')).toThrow(/must be an absolute path/u);
    expect(() => assertRegularDirectory('relative', 'Directory')).toThrow(
      /must be an absolute path/u,
    );
  });

  it('reject symbolic links even when they point at the right kind', () => {
    const root = temporaryDirectory();
    const file = join(root, 'file');
    writeFileSync(file, 'x');
    symlinkSync(file, join(root, 'file-link'));
    symlinkSync(root, join(root, 'dir-link'));
    expect(() => assertRegularFile(join(root, 'file-link'), 'File')).toThrow(
      /File must not be a symbolic link/u,
    );
    expect(() => assertRegularDirectory(join(root, 'dir-link'), 'Directory')).toThrow(
      /Directory must not be a symbolic link/u,
    );
  });

  it('reject the wrong kind and tag a directory read as EISDIR', () => {
    const root = temporaryDirectory();
    const file = join(root, 'file');
    writeFileSync(file, 'x');
    makeFifo(join(root, 'fifo'));
    let caught: NodeJS.ErrnoException | null = null;
    try {
      assertRegularFile(root, 'File');
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }
    expect(caught?.message).toMatch(/File must be a regular file/u);
    expect(caught?.code).toBe('EISDIR');
    let fifoError: NodeJS.ErrnoException | null = null;
    try {
      assertRegularFile(join(root, 'fifo'), 'File');
    } catch (error) {
      fifoError = error as NodeJS.ErrnoException;
    }
    expect(fifoError?.message).toMatch(/File must be a regular file/u);
    expect(fifoError?.code).toBeUndefined();
    expect(() => assertRegularDirectory(file, 'Directory')).toThrow(
      /Directory must be a regular directory/u,
    );
  });

  it('checks already-read metadata the same way', () => {
    const root = temporaryDirectory();
    const file = join(root, 'file');
    writeFileSync(file, 'x');
    const metadata = assertRegularFile(file, 'File');
    expect(() => assertRegularFileMetadata(metadata, 'File', file)).not.toThrow();
  });
});

describe('walkRegularTree', () => {
  function tree(): string {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'b-dir', 'nested'), { recursive: true });
    mkdirSync(join(root, 'a-dir'));
    writeFileSync(join(root, 'b-dir', 'nested', 'deep.txt'), 'deep');
    writeFileSync(join(root, 'b-dir', 'file.txt'), 'file');
    writeFileSync(join(root, 'Zeta.txt'), 'zeta');
    writeFileSync(join(root, 'alpha.txt'), 'alpha');
    return root;
  }

  it('visits directories before their children in code-unit order with POSIX relative paths', () => {
    const root = tree();
    const visited: Array<[string, string, string]> = [];
    walkRegularTree(root, (entry) => {
      visited.push([entry.kind, entry.relativePath, entry.name]);
      expect(entry.path).toBe(join(root, ...entry.relativePath.split('/')));
      expect(entry.metadata.isSymbolicLink()).toBe(false);
    });
    expect(visited).toEqual([
      ['file', 'Zeta.txt', 'Zeta.txt'],
      ['directory', 'a-dir', 'a-dir'],
      ['file', 'alpha.txt', 'alpha.txt'],
      ['directory', 'b-dir', 'b-dir'],
      ['file', 'b-dir/file.txt', 'file.txt'],
      ['directory', 'b-dir/nested', 'nested'],
      ['file', 'b-dir/nested/deep.txt', 'deep.txt'],
    ]);
  });

  it('skips an entry without visiting it and does not descend into a skipped directory', () => {
    const root = tree();
    const visited: string[] = [];
    walkRegularTree(root, (entry) => visited.push(entry.relativePath), {
      skip: (entry: TreeEntry) => entry.relativePath === 'b-dir' || entry.name === 'alpha.txt',
    });
    expect(visited).toEqual(['Zeta.txt', 'a-dir']);
  });

  it('rejects a symbolic link anywhere in the tree with the default label', () => {
    const root = tree();
    symlinkSync(join(root, 'alpha.txt'), join(root, 'b-dir', 'link'));
    expect(() => walkRegularTree(root, () => undefined)).toThrow(
      /^Tree must not contain symbolic links: b-dir\/link$/u,
    );
  });

  it('rejects FIFOs and other special files with the caller label', () => {
    const root = tree();
    makeFifo(join(root, 'a-dir', 'pipe'));
    expect(() => walkRegularTree(root, () => undefined, { label: 'Plugin source' })).toThrow(
      /^Plugin source must contain only regular files and directories: a-dir\/pipe$/u,
    );
  });

  it('requires the root to be a regular directory', () => {
    const root = tree();
    symlinkSync(root, join(root, 'root-link'));
    expect(() => walkRegularTree(join(root, 'alpha.txt'), () => undefined)).toThrow(
      /Tree must be a regular directory/u,
    );
    expect(() => walkRegularTree(join(root, 'root-link'), () => undefined)).toThrow(
      /Tree must not be a symbolic link/u,
    );
    expect(() => walkRegularTree(join(root, 'missing'), () => undefined)).toThrow(
      /Tree must be an existing directory/u,
    );
  });
});
