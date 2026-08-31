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
import { join } from 'node:path';
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

afterEach(() => {
  vi.restoreAllMocks();
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
    vi.mocked(lstatSync).mockReturnValueOnce({
      isSymbolicLink: () => true,
      isDirectory: () => false,
    } as ReturnType<typeof lstatSync>);
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

  it('detects replacement appearing before rename and closes a failed temporary descriptor', () => {
    const concurrentRoot = temporaryDirectory();
    const concurrentStore = createSetupStateStore(join(concurrentRoot, 'data'));
    const current = {
      dev: 1,
      ino: 2,
      isSymbolicLink: () => false,
      isFile: () => true,
    } as ReturnType<typeof lstatSync>;
    vi.mocked(lstatSync)
      .mockImplementationOnce(defaultLstat)
      .mockImplementationOnce(defaultLstat)
      .mockReturnValueOnce(current);
    expect(() => concurrentStore.write(journal())).toThrow(/changed concurrently/iu);

    const descriptorRoot = temporaryDirectory();
    const descriptorStore = createSetupStateStore(join(descriptorRoot, 'data'));
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw ioError('temporary write failed');
    });
    expect(() => descriptorStore.write(journal())).toThrow('temporary write failed');
    expect(vi.mocked(closeSync)).toHaveBeenCalled();
  });

  it('propagates unexpected target stat failures during write and removal', () => {
    const writeRoot = temporaryDirectory();
    const writeStore = createSetupStateStore(join(writeRoot, 'data'));
    vi.mocked(lstatSync)
      .mockImplementationOnce(defaultLstat)
      .mockImplementationOnce(defaultLstat)
      .mockImplementationOnce(() => {
        throw ioError('replacement stat failed');
      });
    expect(() => writeStore.write(journal())).toThrow('replacement stat failed');

    const removeRoot = temporaryDirectory();
    const removeData = join(removeRoot, 'data');
    mkdirSync(removeData);
    const removeStore = createSetupStateStore(removeData);
    vi.mocked(lstatSync)
      .mockImplementationOnce(defaultLstat)
      .mockImplementationOnce(() => {
        throw ioError('removal stat failed');
      });
    expect(() => removeStore.remove()).toThrow('removal stat failed');
  });

  it('recovers a lock that disappears before stale-owner inspection', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    vi.mocked(openSync)
      .mockImplementationOnce(() => {
        throw ioError('simulated collision', 'EEXIST');
      })
      .mockImplementation(defaultOpen);
    await expect(createSetupLifecycleLock(data).run(async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });

  it('propagates a stale-lock stat error after a simulated open collision', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw ioError('simulated collision', 'EEXIST');
    });
    vi.mocked(lstatSync)
      .mockImplementationOnce(defaultLstat)
      .mockImplementationOnce(() => {
        throw ioError('stale lock stat failed');
      });
    await expect(createSetupLifecycleLock(data).run(async () => undefined)).rejects.toThrow(
      'stale lock stat failed',
    );
  });

  it('does not unlink a stale owner when its inode changes during inspection', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    const path = join(data, '.setup-lifecycle.lock');
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
    vi.mocked(lstatSync)
      .mockImplementationOnce(defaultLstat)
      .mockImplementationOnce(defaultLstat)
      .mockImplementationOnce(defaultLstat)
      .mockImplementationOnce(defaultLstat)
      .mockReturnValueOnce({
        ...metadata,
        ino: Number(metadata.ino) + 1,
      } as ReturnType<typeof lstatSync>);
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2);
    await expect(
      createSetupLifecycleLock(data, { timeoutMilliseconds: 1, retryMilliseconds: 1 }).run(
        async () => undefined,
      ),
    ).rejects.toThrow(/timed out/iu);
    expect(existsSync(path)).toBe(true);
  });

  it('closes and cleans up a partially written lock without masking the original fault', async () => {
    for (const unlinkFails of [false, true]) {
      const root = temporaryDirectory();
      const data = join(root, `data-${String(unlinkFails)}`);
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw ioError('lock write failed');
      });
      if (unlinkFails) {
        vi.mocked(unlinkSync).mockImplementationOnce(() => {
          throw ioError('lock unlink failed');
        });
      }
      await expect(createSetupLifecycleLock(data).run(async () => undefined)).rejects.toThrow(
        'lock write failed',
      );
      expect(vi.mocked(closeSync)).toHaveBeenCalled();
    }
  });

  it('leaves a lock whose owner nonce changed before operation completion', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    const path = join(data, '.setup-lifecycle.lock');
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
