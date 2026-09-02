import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  type SyncSnapshot,
  type SyncState,
} from '../src/syncContract.js';
import { SyncController } from '../src/syncController.js';
import { canonicalJson, syncHash } from '../src/syncState.js';

const empty: SyncState = {
  workspaces: [],
  projects: [],
  specs: [],
  contexts: [],
  tasks: [],
  activity: [],
};
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'pimpampum-sync-controller-'));
  roots.push(value);
  return value;
}

function controller(
  data: string,
  overrides: Partial<ConstructorParameters<typeof SyncController>[0]> = {},
) {
  return new SyncController({
    settingsPath: join(data, 'sync.json'),
    snapshotter: () => empty,
    importer: vi.fn(),
    pollMilliseconds: 60_000,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const value of roots.splice(0)) {
    chmodSync(value, 0o700);
    rmSync(value, { recursive: true, force: true });
  }
});

describe('SyncController safeguards and lifecycle', () => {
  it('validates configuration, supports a Pimpampum folder, pauses, resumes, forgets, and closes idempotently', async () => {
    const data = root();
    const sync = controller(data);
    await sync.start();
    sync.markDirty();
    await expect(sync.reconcile()).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(sync.pause()).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(sync.configure('relative', 'linux')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(sync.configure(data, 'Bad device')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(sync.configure(data, 'linux-')).rejects.toMatchObject({ code: 'bad_request' });
    const file = join(data, 'file');
    writeFileSync(file, 'x');
    await expect(sync.configure(file, 'linux')).rejects.toMatchObject({ code: 'bad_request' });

    const shared = join(data, 'Pimpampum');
    mkdirSync(shared);
    expect(await sync.configure(shared, 'linux')).toMatchObject({
      enabled: true,
      state: 'healthy',
    });
    const filesAfterFirstPublish = readdirSync(join(shared, 'devices/linux'));
    await sync.reconcile();
    expect(readdirSync(join(shared, 'devices/linux'))).toEqual(filesAfterFirstPublish);
    expect(await sync.pause()).toMatchObject({ paused: true, state: 'paused' });
    sync.markDirty();
    expect(await sync.reconcile()).toMatchObject({ state: 'paused' });
    expect(await sync.resume()).toMatchObject({ paused: false, state: 'healthy' });
    expect(await sync.forget()).toMatchObject({ enabled: false, state: 'disabled' });
    writeFileSync(join(shared, 'devices/linux/readme.txt'), 'ignored');
    mkdirSync(join(shared, 'devices/linux/nested'));
    expect(await sync.configure(shared, 'linux')).toMatchObject({
      enabled: true,
      state: 'healthy',
    });
    expect(readdirSync(join(shared, 'devices/linux')).length).toBeGreaterThan(
      filesAfterFirstPublish.length,
    );
    await sync.close();
    await sync.close();
    await expect(sync.configure(data, 'linux')).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('restores valid settings, migrates the optional hash, and rejects corrupt settings', async () => {
    const data = root();
    const settingsPath = join(data, 'sync.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        schemaVersion: 1,
        directory: null,
        deviceId: null,
        paused: false,
        sequence: 0,
        appliedSnapshotIds: [],
        headSnapshotIds: [],
        baseState: null,
        conflicts: [],
      }),
    );
    const restored = controller(data);
    expect(restored.getStatus().state).toBe('disabled');
    await restored.close();
    writeFileSync(
      settingsPath,
      JSON.stringify({
        schemaVersion: 1,
        directory: data,
        deviceId: 'linux',
        paused: true,
        sequence: 0,
        appliedSnapshotIds: [],
        headSnapshotIds: [],
        baseState: empty,
        conflicts: [
          {
            id: 'a'.repeat(64),
            entityType: 'project',
            entityId: 'p',
            local: null,
            remote: {},
            createdAt: '2026-08-26T00:00:00.000Z',
          },
        ],
        lastPublishedHash: null,
      }),
    );
    const paused = controller(data);
    expect(paused.getStatus()).toMatchObject({ paused: true, state: 'conflict' });
    await paused.start();
    await paused.close();
    writeFileSync(settingsPath, '{broken');
    expect(() => controller(data)).toThrow(/sync settings are invalid/);
  });

  it('reports unavailable and sanitized errors without losing local data', async () => {
    const data = root();
    const shared = join(data, 'Drive');
    mkdirSync(shared);
    const sync = controller(data);
    await sync.configure(shared, 'linux');
    rmSync(join(shared, 'Pimpampum'), { recursive: true });
    await sync.reconcile();
    expect(sync.getStatus()).toMatchObject({ state: 'unavailable' });
    expect(sync.getStatus().error).toBeTruthy();
    writeFileSync(join(shared, 'Pimpampum'), 'not a directory');
    await sync.reconcile();
    expect(sync.getStatus()).toMatchObject({ state: 'unavailable' });
    await sync.close();

    rmSync(join(shared, 'Pimpampum'));
    mkdirSync(join(shared, 'Pimpampum/devices/linux'), { recursive: true });
    const throwing = controller(join(data, 'other'), {
      snapshotter: () => {
        throw 'not-an-error\u0000';
      },
    });
    await throwing.configure(shared, 'other');
    expect(throwing.getStatus()).toMatchObject({ state: 'error', error: 'Synchronization failed' });
    await throwing.close();
  });

  it('blocks invalid, oversized, tampered and misnamed snapshots and names the first one', async () => {
    // Every rejection below is observed through `reconcile()`: the file is listed, `readSnapshot`
    // refuses it, the status names it as the blocked snapshot, and the other devices still import.
    const data = root();
    const shared = join(data, 'Pimpampum');
    const remote = join(shared, 'devices/remote');
    mkdirSync(remote, { recursive: true });
    const importer = vi.fn();
    const sync = controller(data, { importer });
    await sync.configure(shared, 'linux');
    const blockedReason = async (name: string, content: string): Promise<string> => {
      const path = join(remote, name);
      writeFileSync(path, content);
      const status = await sync.reconcile();
      expect(status).toMatchObject({
        state: 'error',
        blockedSnapshot: { path: `devices/remote/${name}` },
      });
      expect(status.error).toBe(
        `Blocked snapshot devices/remote/${name}: ${status.blockedSnapshot!.reason}`,
      );
      rmSync(path);
      return status.blockedSnapshot!.reason;
    };

    // Not a snapshot at all.
    await expect(blockedReason(`000000000001-${randomUUID()}.json`, '{}')).resolves.toMatch(
      /invalid/u,
    );
    // Larger than the 20 MiB bound: refused before any parsing.
    await expect(
      blockedReason(`000000000002-${randomUUID()}.json`, 'x'.repeat(20 * 1024 * 1024 + 1)),
    ).resolves.toMatch(/bounded regular file/u);
    // A hash that does not match the state.
    const tamperedId = randomUUID();
    await expect(
      blockedReason(
        `000000000003-${tamperedId}.json`,
        JSON.stringify({
          schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
          snapshotId: tamperedId,
          deviceId: 'remote',
          sequence: 3,
          createdAt: '2026-08-26T00:00:00.000Z',
          parentSnapshots: [],
          stateHash: `sha256:${'0'.repeat(64)}`,
          state: empty,
        }),
      ),
    ).resolves.toMatch(/hash/u);
    // A valid snapshot whose file name claims another device, sequence and id.
    const misnamed = {
      schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
      snapshotId: randomUUID(),
      deviceId: 'linux',
      sequence: 1,
      createdAt: '2026-08-26T00:00:00.000Z',
      parentSnapshots: [],
      stateHash: syncHash(empty),
      state: empty,
    };
    await expect(
      blockedReason(`000000000004-${randomUUID()}.json`, canonicalJson(misnamed)),
    ).resolves.toMatch(/filename tuple/u);
    // A file the process may not open: the failure happens before a descriptor exists.
    const unreadable = {
      schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
      snapshotId: randomUUID(),
      deviceId: 'remote',
      sequence: 5,
      createdAt: '2026-08-26T00:00:00.000Z',
      parentSnapshots: [],
      stateHash: syncHash(empty),
      state: empty,
    };
    const unreadablePath = join(remote, `000000000005-${unreadable.snapshotId}.json`);
    writeFileSync(unreadablePath, canonicalJson(unreadable), { mode: 0o000 });
    try {
      const status = await sync.reconcile();
      expect(status.blockedSnapshot).toMatchObject({
        path: `devices/remote/000000000005-${unreadable.snapshotId}.json`,
        reason: expect.stringMatching(/unreadable: EACCES/u),
      });
    } finally {
      chmodSync(unreadablePath, 0o600);
      rmSync(unreadablePath);
    }
    // With the offending files gone the folder converges again and only the own publish happened.
    expect(await sync.reconcile()).toMatchObject({ state: 'healthy', blockedSnapshot: null });
    expect(importer).not.toHaveBeenCalled();
    await sync.close();
  });

  it('rejects symbolic-link device directories during reconciliation', async () => {
    const data = root();
    const sync = controller(data);
    await sync.configure(data, 'linux');
    const outside = root();
    symlinkSync(outside, join(data, 'Pimpampum/devices/remote'));
    const status = await sync.reconcile();
    expect(status).toMatchObject({ state: 'error' });
    expect(status.error).toMatch(/symlink/);
    await sync.close();
  });

  it('rejects symbolic-link snapshots and duplicate snapshot IDs during discovery', async () => {
    const data = root();
    const sync = controller(data);
    const configured = await sync.configure(data, 'linux');
    const devices = join(configured.directory!, 'devices');
    mkdirSync(join(devices, 'bad-'));
    const remote = join(devices, 'remote');
    mkdirSync(remote);
    const target = join(data, 'outside.json');
    writeFileSync(target, '{}');
    const linkedId = randomUUID();
    symlinkSync(target, join(remote, `000000000001-${linkedId}.json`));
    expect(await sync.reconcile()).toMatchObject({ state: 'error' });
    rmSync(join(remote, `000000000001-${linkedId}.json`));

    const duplicateId = randomUUID();
    for (const deviceId of ['remote', 'remote-two']) {
      const directory = join(devices, deviceId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `000000000001-${duplicateId}.json`), '{}');
    }
    const duplicate = await sync.reconcile();
    expect(duplicate).toMatchObject({ state: 'error' });
    expect(duplicate.error).toMatch(/snapshot ID is duplicated/);
    await sync.close();
  });

  it('coalesces mutations made while an import is running', async () => {
    const data = root();
    const shared = join(data, 'Drive');
    mkdirSync(shared);
    let sync: SyncController;
    let calls = 0;
    sync = controller(data, {
      snapshotter: () => {
        calls += 1;
        if (calls === 1) sync.markDirty();
        return empty;
      },
    });
    await sync.configure(shared, 'linux');
    await sync.drain();
    expect(calls).toBeGreaterThanOrEqual(2);
    await sync.close();
  });

  it('runs configured startup and polling callbacks while ignoring non-device entries', async () => {
    vi.useFakeTimers();
    const data = root();
    const shared = join(data, 'Pimpampum');
    mkdirSync(join(shared, 'devices/linux'), { recursive: true });
    writeFileSync(join(shared, 'devices/not-a-device'), 'ignored');
    writeFileSync(join(shared, 'devices/linux/readme.txt'), 'ignored');
    writeFileSync(
      join(data, 'sync.json'),
      JSON.stringify({
        schemaVersion: 1,
        directory: shared,
        deviceId: 'linux',
        paused: false,
        sequence: 0,
        appliedSnapshotIds: [],
        headSnapshotIds: [],
        baseState: null,
        conflicts: [],
        lastPublishedHash: null,
      }),
    );
    const sync = new SyncController({
      settingsPath: join(data, 'sync.json'),
      snapshotter: () => empty,
      importer: vi.fn(),
      pollMilliseconds: 10,
    });
    await sync.start();
    await vi.advanceTimersByTimeAsync(20);
    await sync.drain();
    expect(sync.getStatus().state).toBe('healthy');
    await sync.close();
  });

  it('polls every five seconds by default and coalesces work marked dirty mid-run', async () => {
    vi.useFakeTimers();
    const data = root();
    const shared = join(data, 'Pimpampum');
    mkdirSync(join(shared, 'devices/linux'), { recursive: true });
    writeFileSync(
      join(data, 'sync.json'),
      JSON.stringify({
        schemaVersion: 1,
        directory: shared,
        deviceId: 'linux',
        paused: false,
        sequence: 0,
        appliedSnapshotIds: [],
        headSnapshotIds: [],
        baseState: null,
        conflicts: [],
        lastPublishedHash: null,
      }),
    );
    let snapshots = 0;
    let sync!: SyncController;
    sync = new SyncController({
      settingsPath: join(data, 'sync.json'),
      snapshotter: () => {
        snapshots += 1;
        // The first export marks the controller dirty again while it runs: the loop must hand
        // off to one more generation instead of dropping the mutation or running twice at once.
        if (snapshots === 1) sync.markDirty();
        return empty;
      },
      importer: vi.fn(),
    });
    await sync.start();
    await sync.drain();
    expect(snapshots).toBe(2);
    expect(sync.getStatus().state).toBe('healthy');

    // No `pollMilliseconds`: the poller wakes after the 5 s default, not before.
    await vi.advanceTimersByTimeAsync(4_999);
    await sync.drain();
    expect(snapshots).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await sync.drain();
    expect(snapshots).toBe(3);

    // Pausing stops the poller; resuming restarts it on the same default cadence.
    await sync.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    await sync.drain();
    expect(snapshots).toBe(3);
    await sync.resume();
    const afterResume = snapshots;
    await vi.advanceTimersByTimeAsync(5_000);
    await sync.drain();
    expect(snapshots).toBe(afterResume + 1);
    await sync.close();
  });

  it('runs once more when a mutation lands after the loop finished but before it released', async () => {
    const data = root();
    const shared = join(data, 'Drive');
    mkdirSync(shared);
    let sync!: SyncController;
    let exports = 0;
    sync = controller(data, {
      snapshotter: () => {
        exports += 1;
        if (exports !== 2) return empty;
        // The failure's message is read while the loop records its result, after the last
        // generation check; the mutation it schedules lands in the gap before the run releases.
        // The scheduler must notice the pending generation and run again instead of dropping it.
        const failure = new Error('store unavailable');
        Object.defineProperty(failure, 'message', {
          get() {
            queueMicrotask(() => sync.markDirty());
            return 'store unavailable';
          },
        });
        throw failure;
      },
    });
    await sync.configure(shared, 'linux');
    expect(exports).toBe(1);
    await sync.reconcile();
    expect(exports).toBe(3);
    expect(sync.getStatus()).toMatchObject({ state: 'healthy', error: null });
    await sync.close();
  });

  it('does not duplicate a conflict already persisted locally', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const remoteDirectory = join(shared, 'devices/remote');
    mkdirSync(remoteDirectory, { recursive: true });
    const original = {
      id: 'one',
      name: 'Original',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const local = { ...original, name: 'Local' };
    const remote = { ...original, name: 'Remote' };
    const baseState = { ...empty, workspaces: [original] };
    const localState = { ...empty, workspaces: [local] };
    const remoteState = { ...empty, workspaces: [remote] };
    const candidate = { entityType: 'workspace' as const, entityId: 'one', local, remote };
    const id = syncHash(candidate).slice('sha256:'.length);
    writeFileSync(
      join(data, 'sync.json'),
      JSON.stringify({
        schemaVersion: 1,
        directory: shared,
        deviceId: 'linux',
        paused: false,
        sequence: 0,
        appliedSnapshotIds: [],
        headSnapshotIds: [],
        baseState,
        conflicts: [{ id, ...candidate, createdAt: '2026-08-26T00:00:00.000Z' }],
        lastPublishedHash: null,
      }),
    );
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotId: randomUUID(),
      deviceId: 'remote',
      sequence: 1,
      createdAt: '2026-08-26T00:00:01.000Z',
      parentSnapshots: [],
      stateHash: syncHash(remoteState),
      state: remoteState,
    };
    writeFileSync(
      join(remoteDirectory, `000000000001-${snapshot.snapshotId}.json`),
      canonicalJson(snapshot),
    );
    const sync = new SyncController({
      settingsPath: join(data, 'sync.json'),
      snapshotter: () => localState,
      importer: vi.fn(),
    });
    await sync.reconcile();
    expect(sync.listConflicts()).toHaveLength(1);
    expect(sync.getConflict(id)).toMatchObject({ id, entityType: 'workspace', entityId: 'one' });
    expect(sync.getConflict('f'.repeat(64))).toBeNull();
    await expect(sync.resolveConflict('f'.repeat(64), 'local')).rejects.toMatchObject({
      code: 'not_found',
    });
    await sync.resolveConflict(id, 'local');
    expect(sync.listConflicts()).toEqual([]);
    await sync.close();
  });

  it('ignores a delayed older sequence from the same device', async () => {
    const data = root();
    const shared = join(data, 'Drive');
    mkdirSync(shared);
    const importer = vi.fn();
    const sync = controller(data, { importer });
    await sync.configure(shared, 'linux');
    const remoteDirectory = join(shared, 'Pimpampum/devices/remote');
    mkdirSync(remoteDirectory, { recursive: true });
    const writeSnapshot = (sequence: number, createdAt: string) => {
      const snapshot = {
        schemaVersion: 1 as const,
        snapshotId: randomUUID(),
        deviceId: 'remote',
        sequence,
        createdAt,
        parentSnapshots: [],
        stateHash: syncHash(empty),
        state: empty,
      };
      writeFileSync(
        join(remoteDirectory, `${String(sequence).padStart(12, '0')}-${snapshot.snapshotId}.json`),
        canonicalJson(snapshot),
      );
    };
    writeSnapshot(2, '2026-08-26T00:00:02.000Z');
    await sync.reconcile();
    expect(importer).toHaveBeenCalledTimes(1);
    writeSnapshot(1, '2026-08-26T00:00:01.000Z');
    await sync.reconcile();
    expect(importer).toHaveBeenCalledTimes(1);
    // Two files with one sequence are siblings left by a recovered device, not a
    // rollback: both are imported in snapshot ID order and nothing wedges.
    writeSnapshot(3, '2026-08-26T00:00:03.000Z');
    writeSnapshot(3, '2026-08-26T00:00:04.000Z');
    await sync.reconcile();
    expect(importer).toHaveBeenCalledTimes(3);
    expect(sync.getStatus()).toMatchObject({ state: 'healthy', error: null });
    writeSnapshot(3, '2026-08-26T00:00:05.000Z');
    await sync.reconcile();
    expect(importer).toHaveBeenCalledTimes(4);
    await sync.close();
  });

  it('keeps a causally incomplete snapshot pending without importing or publishing', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const remoteDirectory = join(shared, 'devices/remote');
    mkdirSync(remoteDirectory, { recursive: true });
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotId: randomUUID(),
      deviceId: 'remote',
      sequence: 1,
      createdAt: '2026-08-26T00:00:01.000Z',
      parentSnapshots: [randomUUID()],
      stateHash: syncHash(empty),
      state: empty,
    };
    writeFileSync(
      join(remoteDirectory, `000000000001-${snapshot.snapshotId}.json`),
      canonicalJson(snapshot),
    );
    const importer = vi.fn();
    const sync = controller(data, { importer });
    await sync.configure(shared, 'linux');
    expect(sync.getStatus()).toMatchObject({ state: 'pending', pendingSnapshotCount: 1 });
    expect(importer).not.toHaveBeenCalled();
    expect(readdirSync(join(shared, 'devices/linux'))).toEqual([]);
    await sync.close();
  });

  it('waits when settings know a parent whose shared snapshot file is missing', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const remoteDirectory = join(shared, 'devices/remote');
    mkdirSync(remoteDirectory, { recursive: true });
    const parentId = randomUUID();
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotId: randomUUID(),
      deviceId: 'remote',
      sequence: 1,
      createdAt: '2026-08-26T00:00:01.000Z',
      parentSnapshots: [parentId],
      stateHash: syncHash(empty),
      state: empty,
    };
    writeFileSync(
      join(remoteDirectory, `000000000001-${snapshot.snapshotId}.json`),
      canonicalJson(snapshot),
    );
    writeFileSync(
      join(data, 'sync.json'),
      JSON.stringify({
        schemaVersion: 1,
        directory: shared,
        deviceId: 'linux',
        paused: false,
        sequence: 0,
        appliedSnapshotIds: [parentId],
        headSnapshotIds: [parentId],
        baseState: empty,
        conflicts: [],
        lastPublishedHash: null,
        deviceSequences: {},
      }),
    );
    const importer = vi.fn();
    const sync = controller(data, { importer });
    await sync.reconcile();
    expect(sync.getStatus().state).toBe('pending');
    expect(importer).not.toHaveBeenCalled();
    await sync.close();
  });

  it('orders multiple pending snapshots from one device by sequence', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const remoteDirectory = join(shared, 'devices/remote');
    mkdirSync(remoteDirectory, { recursive: true });
    const firstId = randomUUID();
    for (const sequence of [2, 1]) {
      const snapshot = {
        schemaVersion: 1 as const,
        snapshotId: sequence === 1 ? firstId : randomUUID(),
        deviceId: 'remote',
        sequence,
        createdAt: `2026-08-26T00:00:0${sequence}.000Z`,
        // The second snapshot names the first as its parent, so the base is
        // served from the snapshots already read in the same cycle.
        parentSnapshots: sequence === 2 ? [firstId] : [],
        stateHash: syncHash(empty),
        state: empty,
      };
      writeFileSync(
        join(remoteDirectory, `${String(sequence).padStart(12, '0')}-${snapshot.snapshotId}.json`),
        canonicalJson(snapshot),
      );
    }
    const importer = vi.fn();
    const sync = controller(data, { importer });
    await sync.configure(shared, 'linux');
    expect(importer).toHaveBeenCalledTimes(2);
    await sync.close();
  });

  it('rolls back its in-memory ledger when the settings directory refuses the import', async () => {
    const data = root();
    const shared = join(data, 'Drive');
    mkdirSync(shared);
    const settingsDirectory = join(data, 'settings');
    mkdirSync(settingsDirectory);
    const importer = vi.fn();
    const sync = controller(data, {
      settingsPath: join(settingsDirectory, 'sync.json'),
      importer,
    });
    await sync.configure(shared, 'linux');
    const remoteDirectory = join(shared, 'Pimpampum/devices/remote');
    mkdirSync(remoteDirectory, { recursive: true });
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotId: randomUUID(),
      deviceId: 'remote',
      sequence: 1,
      createdAt: '2026-08-26T00:00:01.000Z',
      parentSnapshots: [],
      stateHash: syncHash(empty),
      state: empty,
    };
    writeFileSync(
      join(remoteDirectory, `000000000001-${snapshot.snapshotId}.json`),
      canonicalJson(snapshot),
    );
    const ledgerBefore = readFileSync(join(settingsDirectory, 'sync.json'), 'utf8');
    // The ledger lives in a directory that no longer accepts new files, so the atomic
    // partial-then-rename write of the applied snapshot fails after the importer ran.
    chmodSync(settingsDirectory, 0o500);
    try {
      await sync.reconcile();
    } finally {
      chmodSync(settingsDirectory, 0o700);
    }
    expect(importer).toHaveBeenCalledTimes(1);
    expect(sync.getStatus()).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/EACCES|permission/iu),
    });
    // Neither the file nor the in-memory ledger recorded the snapshot: it is imported again.
    expect(readFileSync(join(settingsDirectory, 'sync.json'), 'utf8')).toBe(ledgerBefore);
    await sync.reconcile();
    expect(sync.getStatus().state).toBe('healthy');
    expect(importer).toHaveBeenCalledTimes(2);
    expect(
      (
        JSON.parse(readFileSync(join(settingsDirectory, 'sync.json'), 'utf8')) as {
          appliedSnapshotIds: string[];
        }
      ).appliedSnapshotIds,
    ).toContain(snapshot.snapshotId);
    await sync.close();
  });

  it('applies a remote resolution that intentionally deletes an entity', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const workspace = {
      id: 'gone',
      name: 'Gone',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    // The remote device resolved a conflict on `gone` by deleting it: its snapshot carries the
    // resolution and no such workspace. The local state still has it.
    remoteSnapshot(shared, 'remote', 1, {
      resolutions: [{ entityType: 'workspace', entityId: 'gone' }],
    });
    const importer = vi.fn();
    const sync = controller(data, {
      snapshotter: () => ({ ...empty, workspaces: [workspace] }),
      importer,
    });
    await sync.configure(shared, 'linux');
    expect(importer).toHaveBeenCalledTimes(1);
    expect((importer.mock.calls[0]![0] as SyncState).workspaces).toEqual([]);
    expect(sync.listConflicts()).toEqual([]);
    await sync.close();
  });
});

function remoteSnapshot(
  shared: string,
  deviceId: string,
  sequence: number,
  overrides: Partial<SyncSnapshot> = {},
  content?: string,
): SyncSnapshot {
  const snapshot: SyncSnapshot = {
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: randomUUID(),
    deviceId,
    sequence,
    createdAt: `2026-08-26T00:00:0${sequence}.000Z`,
    parentSnapshots: [],
    stateHash: syncHash(empty),
    state: empty,
    ...overrides,
  };
  const deviceDirectory = join(shared, 'devices', deviceId);
  mkdirSync(deviceDirectory, { recursive: true });
  writeFileSync(
    join(deviceDirectory, `${String(sequence).padStart(12, '0')}-${snapshot.snapshotId}.json`),
    content ?? canonicalJson(snapshot),
  );
  return snapshot;
}

function fileName(snapshot: SyncSnapshot): string {
  return `devices/${snapshot.deviceId}/${String(snapshot.sequence).padStart(12, '0')}-${snapshot.snapshotId}.json`;
}

function ownSnapshots(shared: string, deviceId: string): SyncSnapshot[] {
  const directory = join(shared, 'devices', deviceId);
  return readdirSync(directory)
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as SyncSnapshot);
}

describe('SyncController operability', () => {
  it('names a blocked snapshot, keeps importing other devices, and still publishes', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const invalid = remoteSnapshot(shared, 'remote-a', 1, {}, '{}');
    const valid = remoteSnapshot(shared, 'remote-b', 1);
    const importer = vi.fn();
    const sync = controller(data, { importer });
    const status = await sync.configure(shared, 'linux');
    expect(importer).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      state: 'error',
      pendingSnapshotCount: 1,
      blockedSnapshot: { path: fileName(invalid), reason: expect.stringMatching(/invalid/) },
    });
    expect(status.error).toBe(
      `Blocked snapshot ${fileName(invalid)}: ${status.blockedSnapshot!.reason}`,
    );
    const published = ownSnapshots(shared, 'linux');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
      parentSnapshots: [valid.snapshotId],
      appliedHeads: { 'remote-b': valid.snapshotId },
    });
    expect(published[0]).not.toHaveProperty('baseState');

    writeFileSync(join(shared, fileName(invalid)), canonicalJson(invalid));
    const repaired = await sync.reconcile();
    expect(importer).toHaveBeenCalledTimes(2);
    expect(repaired).toMatchObject({ state: 'healthy', error: null, blockedSnapshot: null });
    await sync.close();
  });

  it('treats descendants of a blocked snapshot as blocked and reports the first path', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const blockedRoot = remoteSnapshot(shared, 'remote', 1, {}, 'not json');
    remoteSnapshot(shared, 'remote', 2, { parentSnapshots: [blockedRoot.snapshotId] });
    const other = remoteSnapshot(shared, 'aaa', 1, {}, '{}');
    const importer = vi.fn();
    const sync = controller(data, { importer });
    const status = await sync.configure(shared, 'linux');
    expect(importer).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      state: 'error',
      pendingSnapshotCount: 3,
      blockedSnapshot: { path: fileName(other) },
    });
    // Nothing waits on the provider, so this device's own state was published.
    expect(ownSnapshots(shared, 'linux')).toHaveLength(1);
    await sync.close();
  });

  it('accepts a version 1 snapshot whose hash matches and blocks the ones that need an upgrade', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    remoteSnapshot(shared, 'legacy', 1, { schemaVersion: 1 });
    const state: SyncState = {
      ...empty,
      workspaces: [
        {
          id: 'one',
          name: 'One',
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
    };
    const localeHashed = remoteSnapshot(shared, 'danish', 1, {
      schemaVersion: 1,
      state,
      stateHash: syncHash({ ...state, workspaces: [] }),
    });
    remoteSnapshot(shared, 'future', 1, { schemaVersion: 3 as unknown as 2 });
    const importer = vi.fn();
    const sync = controller(data, { importer });
    const status = await sync.configure(shared, 'linux');
    expect(importer).toHaveBeenCalledTimes(1);
    expect(status.blockedSnapshot).toEqual({
      path: fileName(localeHashed),
      reason: expect.stringMatching(/upgrade Pimpampum on device "danish" so it republishes/),
    });
    // The legacy file was the one imported: its hash matched, so version 1 needs no upgrade.
    expect(importer.mock.calls[0]![0]).toEqual(expect.objectContaining({ workspaces: [] }));
    await sync.close();

    // The future-format file alone: its block names the format and the device that must upgrade.
    const futureData = root();
    const futureShared = join(futureData, 'Pimpampum');
    const futureOnly = remoteSnapshot(futureShared, 'future', 1, {
      schemaVersion: 3 as unknown as 2,
    });
    const futureSync = controller(futureData);
    expect((await futureSync.configure(futureShared, 'linux')).blockedSnapshot).toEqual({
      path: fileName(futureOnly),
      reason: expect.stringMatching(/uses format 3; upgrade Pimpampum on this device/u),
    });
    expect(futureSync.getStatus().state).toBe('error');
    await futureSync.close();
  });

  it('blocks a child whose applied parent file is corrupt', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const parent = remoteSnapshot(shared, 'remote', 1, {}, 'corrupt');
    remoteSnapshot(shared, 'remote', 2, { parentSnapshots: [parent.snapshotId] });
    writeFileSync(
      join(data, 'sync.json'),
      JSON.stringify({
        schemaVersion: 1,
        directory: shared,
        deviceId: 'linux',
        paused: false,
        sequence: 0,
        appliedSnapshotIds: [parent.snapshotId],
        headSnapshotIds: [parent.snapshotId],
        conflicts: [],
        deviceSequences: { remote: 1 },
      }),
    );
    const importer = vi.fn();
    const sync = controller(data, { importer });
    const status = await sync.reconcile();
    expect(importer).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      state: 'error',
      pendingSnapshotCount: 1,
      blockedSnapshot: { path: fileName(parent), reason: expect.stringMatching(/unreadable/) },
    });
    await sync.close();
  });

  it('skips the export when no mutation was committed and compacts the applied ledger', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    const remote = remoteSnapshot(shared, 'remote', 1);
    const stale = randomUUID();
    const head = randomUUID();
    writeFileSync(
      join(data, 'sync.json'),
      JSON.stringify({
        schemaVersion: 1,
        directory: shared,
        deviceId: 'linux',
        paused: false,
        sequence: 0,
        appliedSnapshotIds: [stale, head],
        headSnapshotIds: [head],
        baseState: empty,
        conflicts: [],
      }),
    );
    let mutations = 0;
    const snapshotter = vi.fn(() => empty);
    const sync = controller(data, { snapshotter, mutationCounter: () => mutations });
    await sync.reconcile();
    const settings = JSON.parse(readFileSync(join(data, 'sync.json'), 'utf8')) as {
      appliedSnapshotIds: string[];
      deviceHeads: Record<string, string>;
      inheritedSequence: number;
    };
    const [published] = ownSnapshots(shared, 'linux');
    // The stale id vanished; the head without a file and the present files stay.
    expect(settings.appliedSnapshotIds).toEqual([head, remote.snapshotId, published!.snapshotId]);
    expect(settings.deviceHeads).toEqual({
      remote: remote.snapshotId,
      linux: published!.snapshotId,
    });
    expect(settings).not.toHaveProperty('baseState');
    expect(published).toMatchObject({ appliedHeads: { remote: remote.snapshotId } });

    const exportsAfterPublish = snapshotter.mock.calls.length;
    await sync.reconcile();
    await sync.reconcile();
    expect(snapshotter).toHaveBeenCalledTimes(exportsAfterPublish);
    mutations += 1;
    await sync.reconcile();
    expect(snapshotter).toHaveBeenCalledTimes(exportsAfterPublish + 1);
    expect(ownSnapshots(shared, 'linux')).toHaveLength(1);
    await sync.reconcile();
    expect(snapshotter).toHaveBeenCalledTimes(exportsAfterPublish + 1);
    await sync.close();

    const restored = controller(data, { snapshotter, mutationCounter: () => mutations });
    expect(restored.getStatus()).toMatchObject({ enabled: true, deviceId: 'linux' });
    await restored.close();
  });

  it('reports another computer publishing as this device and recovers after forget', async () => {
    const data = root();
    const shared = join(data, 'Pimpampum');
    mkdirSync(shared);
    const importer = vi.fn();
    const sync = controller(data, { importer });
    await sync.configure(shared, 'shared');
    expect(ownSnapshots(shared, 'shared')).toHaveLength(1);
    const twin = remoteSnapshot(shared, 'shared', 2);
    const status = await sync.reconcile();
    expect(status).toMatchObject({ state: 'error' });
    expect(status.error).toMatch(/Another computer publishes snapshots as device "shared"/);
    expect(importer).not.toHaveBeenCalled();

    await sync.forget();
    const recovered = await sync.configure(shared, 'shared');
    expect(recovered).toMatchObject({ state: 'healthy', error: null });
    // Both files already in the directory are history now: the own first
    // snapshot and the twin's; the reset ledger imports each once.
    expect(importer).toHaveBeenCalledTimes(2);
    expect(ownSnapshots(shared, 'shared').map((s) => s.snapshotId)).toContain(twin.snapshotId);
    await sync.close();
  });
});
