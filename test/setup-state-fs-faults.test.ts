import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInstallationMigrationStateStore,
  createSetupLifecycleLock,
  createSetupStateStore,
} from '../src/setup/state.js';
import type { InstallationMigrationJournal, SetupJournal } from '../src/setup/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    fstatSync: vi.fn(actual.fstatSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const roots: string[] = [];
const defaultLstat = vi.mocked(lstatSync).getMockImplementation()!;
const defaultOpen = vi.mocked(openSync).getMockImplementation()!;
const defaultWrite = vi.mocked(writeFileSync).getMockImplementation()!;
const defaultUnlink = vi.mocked(unlinkSync).getMockImplementation()!;
const LOCK_NAME = '.setup-lifecycle.lock';

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-setup-fs-fault-'));
  roots.push(root);
  return root;
}

function journal(): SetupJournal {
  return {
    schemaVersion: 1,
    operationId: 'operation',
    revision: 'revision',
    phase: 'runtime.install',
    selectedConnectors: [],
    conflictDecisions: {},
    completedPhases: [],
    diagnostics: [],
    service: { installed: false, running: false, verified: false },
    connectors: [],
    loginItem: 'pending',
    status: 'running',
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
}

function ioError(message: string, code = 'EIO'): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

// Faults are bound to the path they hit (M-T5), never to the n-th call of a primitive across every
// path: a test that fails "the second lstat of the state file" survives an unrelated lstat added
// elsewhere, and its title can name the file whose post-condition it asserts.
type LstatResult = ReturnType<typeof lstatSync>;
const lstatFaults = new Map<string, Array<{ occurrence: number; behave: () => LstatResult }>>();
const lstatCounts = new Map<string, number>();

function onLstatOf(path: string, occurrence: number, behave: () => LstatResult): void {
  const faults = lstatFaults.get(path) ?? [];
  faults.push({ occurrence, behave });
  lstatFaults.set(path, faults);
  vi.mocked(lstatSync).mockImplementation((...arguments_: Parameters<typeof lstatSync>) => {
    const target = String(arguments_[0]);
    const count = (lstatCounts.get(target) ?? 0) + 1;
    lstatCounts.set(target, count);
    const fault = lstatFaults.get(target)?.find((candidate) => candidate.occurrence === count);
    return fault ? fault.behave() : defaultLstat(...arguments_);
  });
}

/** The descriptor `openSync` returned for the first path `match` accepts, once it exists. */
function trackDescriptor(match: (path: string) => boolean): { descriptor: () => number | null } {
  let descriptor: number | null = null;
  vi.mocked(openSync).mockImplementation((...arguments_: Parameters<typeof openSync>) => {
    const opened = defaultOpen(...arguments_);
    if (descriptor === null && match(String(arguments_[0]))) descriptor = opened;
    return opened;
  });
  return { descriptor: () => descriptor };
}

/** Fails `writeFileSync` on the descriptor `tracked` holds; every other write proceeds. */
function failWriteThrough(tracked: { descriptor: () => number | null }, error: Error): void {
  vi.mocked(writeFileSync).mockImplementation((...arguments_: Parameters<typeof writeFileSync>) => {
    const descriptor = tracked.descriptor();
    if (descriptor !== null && arguments_[0] === descriptor) throw error;
    return defaultWrite(...arguments_);
  });
}

function isSetupStateTemporary(path: string): boolean {
  return basename(path).startsWith('.setup-state.') && path.endsWith('.tmp');
}

afterEach(() => {
  vi.restoreAllMocks();
  lstatFaults.clear();
  lstatCounts.clear();
  // `vi.fn(impl)` keeps a replaced implementation across tests; put the real primitives back.
  vi.mocked(lstatSync).mockImplementation(defaultLstat);
  vi.mocked(openSync).mockImplementation(defaultOpen);
  vi.mocked(writeFileSync).mockImplementation(defaultWrite);
  vi.mocked(unlinkSync).mockImplementation(defaultUnlink);
  for (const mock of [
    closeSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
  ]) {
    vi.mocked(mock).mockClear();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable setup filesystem fault injection', () => {
  it('rejects a directory swapped to a symlink after creation', () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    onLstatOf(
      data,
      1,
      () => ({ isSymbolicLink: () => true, isDirectory: () => false }) as LstatResult,
    );
    expect(() => createSetupStateStore(data).write(journal())).toThrow(
      /regular private directory/iu,
    );
  });

  it('rejects a file identity changed between lstat and descriptor open', () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    const store = createSetupStateStore(data);
    store.write(journal());
    const metadata = defaultLstat(store.path)!;
    vi.mocked(fstatSync).mockReturnValueOnce({
      ...metadata,
      ino: Number(metadata.ino) + 1,
      isFile: () => true,
    } as ReturnType<typeof fstatSync>);
    expect(() => store.read()).toThrow(/changed while.*opened/iu);
  });

  it('rejects content that grows beyond the limit after metadata validation', () => {
    const root = temporaryDirectory();
    const store = createSetupStateStore(join(root, 'data'));
    store.write(journal());
    vi.mocked(readFileSync).mockReturnValueOnce('x'.repeat(1_000_001));
    expect(() => store.read()).toThrow(/size limit/iu);
  });

  it('bounds deeply nested connector snapshots before atomic persistence', () => {
    const root = temporaryDirectory();
    const store = createInstallationMigrationStateStore(join(root, 'data'));
    const state: InstallationMigrationJournal = {
      schemaVersion: 1,
      targetVersion: '2.0.0',
      phase: 'staged',
      previous: {
        runtimeVersion: '1.0.0',
        serviceCommand: ['/old/node', '/old/cli'],
        connectorEntries: { huge: 'x'.repeat(1_000_001) },
      },
      connectorEntries: {},
      staged: { version: '2.0.0', nodePath: '/new/node', cliPath: '/new/cli' },
      updatedAt: '2026-08-31T00:00:00.000Z',
    };
    expect(() => store.write(state)).toThrow(/size limit/iu);
  });

  it('refuses to rename over a state file that appeared between the identity check and the rename', () => {
    const root = temporaryDirectory();
    const store = createSetupStateStore(join(root, 'data'));
    // The write reads the target once before creating the temporary file and once right before
    // the rename; a file that exists only at the second read was created by someone else.
    onLstatOf(
      store.path,
      2,
      () => ({ dev: 1, ino: 2, isSymbolicLink: () => false, isFile: () => true }) as LstatResult,
    );
    expect(() => store.write(journal())).toThrow(/changed concurrently/iu);
    expect(existsSync(store.path)).toBe(false);
  });

  it('closes the descriptor of the .setup-state temporary file and leaves no state when its write fails', () => {
    const root = temporaryDirectory();
    const store = createSetupStateStore(join(root, 'data'));
    const temporary = trackDescriptor(isSetupStateTemporary);
    failWriteThrough(temporary, ioError('temporary write failed'));
    expect(() => store.write(journal())).toThrow('temporary write failed');
    expect(temporary.descriptor()).not.toBeNull();
    expect(vi.mocked(closeSync)).toHaveBeenCalledWith(temporary.descriptor());
    expect(existsSync(store.path)).toBe(false);
  });

  it('propagates a non-ENOENT stat failure of the state file before the rename', () => {
    const root = temporaryDirectory();
    const store = createSetupStateStore(join(root, 'data'));
    onLstatOf(store.path, 2, () => {
      throw ioError('replacement stat failed');
    });
    expect(() => store.write(journal())).toThrow('replacement stat failed');
    expect(existsSync(store.path)).toBe(false);
  });

  it('propagates a non-ENOENT stat failure of the state file during removal', () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    mkdirSync(data);
    const store = createSetupStateStore(data);
    onLstatOf(store.path, 1, () => {
      throw ioError('removal stat failed');
    });
    expect(() => store.remove()).toThrow('removal stat failed');
  });

  it('recovers a lock that disappears before stale-owner inspection', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    const lockPath = join(data, LOCK_NAME);
    let collided = false;
    vi.mocked(openSync).mockImplementation((...arguments_: Parameters<typeof openSync>) => {
      if (!collided && String(arguments_[0]) === lockPath) {
        collided = true;
        throw ioError('simulated collision', 'EEXIST');
      }
      return defaultOpen(...arguments_);
    });
    await expect(createSetupLifecycleLock(data).run(async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    expect(collided).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('propagates a stale-lock stat error after an open collision on the lock file', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    const lockPath = join(data, LOCK_NAME);
    vi.mocked(openSync).mockImplementationOnce((...arguments_: Parameters<typeof openSync>) => {
      expect(String(arguments_[0])).toBe(lockPath);
      throw ioError('simulated collision', 'EEXIST');
    });
    onLstatOf(lockPath, 1, () => {
      throw ioError('stale lock stat failed');
    });
    await expect(createSetupLifecycleLock(data).run(async () => undefined)).rejects.toThrow(
      'stale lock stat failed',
    );
  });

  it('does not unlink a stale owner when the lock inode changes during inspection', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    const path = join(data, LOCK_NAME);
    mkdirSync(data);
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        nonce: '00000000-0000-4000-8000-000000000000',
      })}\n`,
      { mode: 0o600 },
    );
    const metadata = defaultLstat(path)!;
    // Lock reads: the owner probe, the private-file read, then the identity recheck before unlink.
    onLstatOf(path, 3, () => ({ ...metadata, ino: Number(metadata.ino) + 1 }) as LstatResult);
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2);
    await expect(
      createSetupLifecycleLock(data, { timeoutMilliseconds: 1, retryMilliseconds: 1 }).run(
        async () => undefined,
      ),
    ).rejects.toThrow(/timed out/iu);
    expect(existsSync(path)).toBe(true);
    expect(vi.mocked(unlinkSync)).not.toHaveBeenCalledWith(path);
  });

  it.each([
    { label: 'unlink succeeds', unlinkFails: false },
    { label: 'unlink also fails', unlinkFails: true },
  ])(
    'closes the lock descriptor and reports the write fault when $label',
    async ({ unlinkFails }) => {
      const root = temporaryDirectory();
      const data = join(root, 'data');
      const lockPath = join(data, LOCK_NAME);
      const lock = trackDescriptor((path) => path === lockPath);
      failWriteThrough(lock, ioError('lock write failed'));
      if (unlinkFails) {
        vi.mocked(unlinkSync).mockImplementation((...arguments_: Parameters<typeof unlinkSync>) => {
          if (String(arguments_[0]) === lockPath) throw ioError('lock unlink failed');
          return defaultUnlink(...arguments_);
        });
      }
      await expect(createSetupLifecycleLock(data).run(async () => undefined)).rejects.toThrow(
        'lock write failed',
      );
      expect(lock.descriptor()).not.toBeNull();
      expect(vi.mocked(closeSync)).toHaveBeenCalledWith(lock.descriptor());
      expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(lockPath);
      expect(existsSync(lockPath)).toBe(unlinkFails);
    },
  );

  it('leaves a lock whose owner nonce changed before operation completion', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    const path = join(data, LOCK_NAME);
    await expect(
      createSetupLifecycleLock(data).run(async () => {
        writeFileSync(
          path,
          `${JSON.stringify({
            schemaVersion: 1,
            pid: process.pid,
            nonce: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          })}\n`,
          { mode: 0o600 },
        );
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });
});
