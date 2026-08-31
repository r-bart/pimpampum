import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInstallationMigrationStateStore,
  createSetupLifecycleLock,
  createSetupPlanStore,
  createSetupStateStore,
  readSetupState,
} from '../src/setup/state.js';
import type { InstallationMigrationJournal, SetupJournal, SetupPlan } from '../src/setup/types.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'pimpampum-setup-hostile-'));
  temporaryDirectories.push(path);
  return path;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function setupJournal(): SetupJournal {
  return {
    schemaVersion: 1,
    operationId: 'operation',
    revision: 'revision',
    phase: 'connector:codex.verify',
    selectedConnectors: ['codex'],
    conflictDecisions: { codex: 'replace' },
    reviewedConflictFingerprints: { codex: 'a'.repeat(64) },
    completedPhases: ['runtime.install'],
    diagnostics: ['bounded diagnostic'],
    service: { installed: true, running: true, verified: true },
    connectors: [
      {
        id: 'codex',
        configured: true,
        available: false,
        newSessionRequired: true,
        state: 'verificationFailed',
        error: 'bounded error',
      },
    ],
    loginItem: 'enabled',
    status: 'partial',
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
}

function setupPlan(): SetupPlan {
  return {
    operationId: 'operation',
    revision: 'b'.repeat(64),
    selectedConnectors: ['codex'],
    changes: [{ kind: 'connector', summary: 'Connect Codex', path: '/private/launcher' }],
    conflicts: [
      {
        connectorId: 'codex',
        comparison: 'Existing entry differs',
        entryFingerprint: 'c'.repeat(64),
      },
    ],
    requiresConfirmation: true,
  };
}

function migrationJournal(root: string): InstallationMigrationJournal {
  return {
    schemaVersion: 1,
    targetVersion: '2.0.0',
    phase: 'staged',
    previous: {
      runtimeVersion: '1.0.0',
      serviceCommand: ['/old/node', '/old/cli'],
      connectorEntries: { codex: { route: 'owned' } },
      adapter: 'launchd',
      dataDirectory: join(root, 'data'),
      runtimeKind: 'legacy-npm',
    },
    previousReceiptBase64: Buffer.from('{}\n').toString('base64'),
    connectorEntries: { codex: { route: 'owned' } },
    staged: { version: '2.0.0', nodePath: '/new/node', cliPath: '/new/cli' },
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('hostile durable setup state', () => {
  it('round-trips every optional bounded state field and removes idempotently', () => {
    const root = temporaryDirectory();
    const store = createSetupStateStore(join(root, 'data'));
    store.write(setupJournal());
    expect(store.read()).toEqual(setupJournal());
    expect(readSetupState(join(root, 'data'))).toEqual(setupJournal());
    store.remove();
    store.remove();
    expect(store.read()).toBeNull();
  });

  it('rejects malformed state schema, arrays, connector results, and envelopes', () => {
    const root = temporaryDirectory();
    const store = createSetupStateStore(join(root, 'data'));
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => (value.schemaVersion = 2),
      (value) => (value.selectedConnectors = 'codex'),
      (value) => (value.selectedConnectors = ['unknown']),
      (value) => (value.completedPhases = [1]),
      (value) => (value.diagnostics = ['x\0']),
      (value) => (value.conflictDecisions = null),
      (value) => (value.conflictDecisions = { unknown: 'replace' }),
      (value) => (value.conflictDecisions = { codex: 'overwrite' }),
      (value) => (value.reviewedConflictFingerprints = null),
      (value) => (value.reviewedConflictFingerprints = { unknown: 'a'.repeat(64) }),
      (value) => (value.reviewedConflictFingerprints = { codex: 'bad' }),
      (value) => (value.connectors = null),
      (value) => (value.connectors = [null]),
      (value) => (value.connectors = [{ ...setupJournal().connectors[0]!, id: 'unknown' }]),
      (value) => (value.connectors = [{ ...setupJournal().connectors[0]!, configured: 'yes' }]),
      (value) =>
        (value.connectors = [{ ...setupJournal().connectors[0]!, error: 'x'.repeat(321) }]),
      (value) => (value.service = null),
      (value) => (value.service = { installed: true, running: true, verified: 'yes' }),
      (value) => (value.operationId = ''),
      (value) => (value.revision = 'x'.repeat(129)),
      (value) => (value.phase = ''),
      (value) => (value.updatedAt = ''),
      (value) => (value.loginItem = 'unknown'),
      (value) => (value.status = 'unknown'),
    ];
    for (const mutate of mutations) {
      const value = structuredClone(setupJournal()) as unknown as Record<string, unknown>;
      mutate(value);
      writeJson(store.path, value);
      expect(() => store.read()).toThrow(/setup/iu);
    }
  });

  it('rejects malformed plans before or after persistence', () => {
    const root = temporaryDirectory();
    const store = createSetupPlanStore(join(root, 'data'));
    store.write(setupPlan());
    expect(store.read()).toEqual(setupPlan());
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => (value.selectedConnectors = ['codex', 'codex']),
      (value) => (value.changes = null),
      (value) => (value.changes = [null]),
      (value) => (value.changes = [{ kind: '', summary: 'x' }]),
      (value) => (value.changes = [{ kind: 'x', summary: 'x', path: 1 }]),
      (value) => (value.conflicts = null),
      (value) => (value.conflicts = [null]),
      (value) => (value.conflicts = [{ connectorId: 'unknown', comparison: 'x' }]),
      (value) =>
        (value.conflicts = [{ connectorId: 'codex', comparison: '', entryFingerprint: 'bad' }]),
      (value) =>
        (value.conflicts = [{ connectorId: 'codex', comparison: 'x', entryFingerprint: 'bad' }]),
      (value) => (value.revision = 'bad'),
      (value) => (value.requiresConfirmation = false),
      (value) => (value.operationId = ''),
    ];
    for (const mutate of mutations) {
      const value = structuredClone(setupPlan()) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => store.write(value as unknown as SetupPlan)).toThrow(/plan|connector/iu);
    }
    writeJson(store.path, { schemaVersion: 2, plan: setupPlan() });
    expect(() => store.read()).toThrow(/schema/iu);
    writeJson(store.path, []);
    expect(() => store.read()).toThrow(/schema/iu);
    expect(() => store.write(null as unknown as SetupPlan)).toThrow(/durable setup plan/iu);
  });

  it('handles absent plan and migration files and removes their private files idempotently', () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    const planStore = createSetupPlanStore(data);
    const migrationStore = createInstallationMigrationStateStore(data);
    expect(planStore.read()).toBeNull();
    expect(migrationStore.read()).toBeNull();

    const absentRoot = temporaryDirectory();
    expect(() => createSetupPlanStore(join(absentRoot, 'absent')).remove()).not.toThrow();
    expect(() =>
      createInstallationMigrationStateStore(join(absentRoot, 'absent-migration')).remove(),
    ).not.toThrow();
    planStore.write(setupPlan());
    migrationStore.write(migrationJournal(root));
    planStore.remove();
    migrationStore.remove();
    planStore.remove();
    migrationStore.remove();
    expect(planStore.read()).toBeNull();
    expect(migrationStore.read()).toBeNull();
  });

  it('rejects malformed migration journals and receipt snapshots', () => {
    const root = temporaryDirectory();
    const store = createInstallationMigrationStateStore(join(root, 'data'));
    store.write(migrationJournal(root));
    expect(store.read()).toEqual(migrationJournal(root));
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => (value.schemaVersion = 2),
      (value) => (value.targetVersion = ''),
      (value) => (value.phase = 'unknown'),
      (value) => (value.connectorEntries = null),
      (value) => (value.staged = null),
      (value) => (value.updatedAt = ''),
      (value) => (value.previousReceiptBase64 = 'not-base64'),
      (value) => (value.previousReceiptBase64 = ''),
      (value) => (value.previous = null),
      (value) => ((value.previous as Record<string, unknown>).serviceCommand = []),
      (value) => ((value.previous as Record<string, unknown>).connectorEntries = null),
      (value) => ((value.previous as Record<string, unknown>).runtimeVersion = ''),
      (value) => ((value.previous as Record<string, unknown>).adapter = ''),
      (value) => ((value.previous as Record<string, unknown>).dataDirectory = 'bad\0path'),
      (value) => ((value.previous as Record<string, unknown>).runtimeKind = 'unknown'),
    ];
    for (const mutate of mutations) {
      const value = structuredClone(migrationJournal(root)) as unknown as Record<string, unknown>;
      mutate(value);
      writeJson(store.path, value);
      expect(() => store.read()).toThrow(/migration|installation|setup/iu);
    }
  });

  it('fails closed on oversized, malformed JSON, directory, symlink, FIFO, and device state', () => {
    for (const variant of ['oversized', 'json', 'directory', 'symlink', 'fifo'] as const) {
      const root = temporaryDirectory();
      const data = join(root, 'data');
      const store = createSetupStateStore(data);
      mkdirSync(data, { mode: 0o700 });
      if (variant === 'oversized')
        writeFileSync(store.path, Buffer.alloc(1_000_001), { mode: 0o600 });
      if (variant === 'json') writeFileSync(store.path, '{', { mode: 0o600 });
      if (variant === 'directory') mkdirSync(store.path);
      if (variant === 'symlink') symlinkSync('/dev/null', store.path);
      if (variant === 'fifo') execFileSync('/usr/bin/mkfifo', [store.path]);
      expect(() => store.read()).toThrow();
    }
  });

  it('rejects unsafe data-directory and private-file targets on writes and removals', () => {
    const fileRoot = temporaryDirectory();
    const fileData = join(fileRoot, 'data');
    writeFileSync(fileData, 'not a directory');
    expect(() => createSetupStateStore(fileData).write(setupJournal())).toThrow(
      /directory|EEXIST/iu,
    );

    const symlinkRoot = temporaryDirectory();
    const realData = join(symlinkRoot, 'real-data');
    mkdirSync(realData);
    const linkedData = join(symlinkRoot, 'linked-data');
    symlinkSync(realData, linkedData);
    expect(() => createSetupStateStore(linkedData).read()).toThrow(/directory/iu);

    const targetRoot = temporaryDirectory();
    const store = createSetupStateStore(join(targetRoot, 'data'));
    mkdirSync(join(targetRoot, 'data'));
    mkdirSync(store.path);
    expect(() => store.write(setupJournal())).toThrow(/regular file/iu);
    expect(() => store.remove()).toThrow(/regular file/iu);
  });

  it.each(['relative', '/tmp/nul\0path'])('rejects unsafe store root %j', (path) => {
    expect(() => createSetupStateStore(path)).toThrow(/absolute|NUL/iu);
    expect(() => createSetupPlanStore(path)).toThrow(/absolute|NUL/iu);
    expect(() => createInstallationMigrationStateStore(path)).toThrow(/absolute|NUL/iu);
    expect(() => readSetupState(path)).toThrow(/absolute|NUL/iu);
    expect(() => createSetupLifecycleLock(path)).toThrow(/absolute|NUL/iu);
  });
});

describe('hostile setup lifecycle locks', () => {
  it('rejects invalid timing, public owners, malformed owners, symlinks, and FIFOs', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    expect(() => createSetupLifecycleLock(data, { timeoutMilliseconds: 0 })).toThrow(/timing/iu);
    expect(() => createSetupLifecycleLock(data, { retryMilliseconds: 1.5 })).toThrow(/timing/iu);
    for (const variant of ['public', 'malformed', 'symlink', 'fifo'] as const) {
      rmSync(data, { recursive: true, force: true });
      mkdirSync(data, { mode: 0o700 });
      const path = join(data, '.setup-lifecycle.lock');
      if (variant === 'public') {
        writeJson(path, { pid: process.pid, nonce: '0'.repeat(36) });
        chmodSync(path, 0o644);
      }
      if (variant === 'malformed') writeJson(path, { pid: 0, nonce: 'bad' });
      if (variant === 'symlink') symlinkSync('/dev/null', path);
      if (variant === 'fifo') execFileSync('/usr/bin/mkfifo', [path]);
      await expect(
        createSetupLifecycleLock(data, {
          timeoutMilliseconds: 5,
          retryMilliseconds: 1,
        }).run(async () => undefined),
      ).rejects.toThrow(/lock|private|owner|regular/iu);
    }
  });

  it('times out behind a live owner and releases its own lock after operation failure', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    mkdirSync(data, { mode: 0o700 });
    writeJson(join(data, '.setup-lifecycle.lock'), {
      schemaVersion: 1,
      pid: process.pid,
      nonce: '00000000-0000-4000-8000-000000000000',
    });
    await expect(
      createSetupLifecycleLock(data, { timeoutMilliseconds: 5, retryMilliseconds: 1 }).run(
        async () => undefined,
      ),
    ).rejects.toThrow(/timed out/iu);
    rmSync(join(data, '.setup-lifecycle.lock'));
    const lock = createSetupLifecycleLock(data);
    await expect(
      lock.run(async () => {
        throw new Error('killed operation');
      }),
    ).rejects.toThrow('killed operation');
    expect(existsSync(join(data, '.setup-lifecycle.lock'))).toBe(false);
  });

  it('rejects a JSON null lock instead of spinning as though the existing file were absent', async () => {
    const root = temporaryDirectory();
    const data = join(root, 'data');
    mkdirSync(data, { mode: 0o700 });
    writeJson(join(data, '.setup-lifecycle.lock'), null);
    await expect(
      createSetupLifecycleLock(data, { timeoutMilliseconds: 5, retryMilliseconds: 1 }).run(
        async () => undefined,
      ),
    ).rejects.toThrow(/invalid owner/iu);
  });

  it('treats EPERM owners as alive and propagates unexpected process-probe failures', async () => {
    for (const code of ['EPERM', 'EIO'] as const) {
      const root = temporaryDirectory();
      const data = join(root, 'data');
      mkdirSync(data, { mode: 0o700 });
      writeJson(join(data, '.setup-lifecycle.lock'), {
        schemaVersion: 1,
        pid: 123_456,
        nonce: '00000000-0000-4000-8000-000000000000',
      });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error(`probe ${code}`) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      });
      const operation = createSetupLifecycleLock(data, {
        timeoutMilliseconds: 5,
        retryMilliseconds: 1,
      }).run(async () => undefined);
      await expect(operation).rejects.toThrow(code === 'EPERM' ? /timed out/iu : /probe EIO/iu);
      vi.restoreAllMocks();
    }
  });
});
