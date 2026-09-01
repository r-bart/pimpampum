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

  it('rejects invalid, tampered, and symbolic-link snapshots', async () => {
    const data = root();
    const sync = controller(data);
    const configured = await sync.configure(data, 'linux');
    const deviceDirectory = join(configured.directory!, 'devices/linux');
    const invalidId = randomUUID();
    const invalid = join(deviceDirectory, `000000000002-${invalidId}.json`);
    writeFileSync(invalid, '{}');
    expect(() =>
      (
        sync as unknown as {
          readSnapshot(path: string, expected: object): unknown;
        }
      ).readSnapshot(invalid, { deviceId: 'linux', sequence: 2, snapshotId: invalidId }),
    ).toThrow(/invalid/);

    const target = join(deviceDirectory, 'target.json');
    writeFileSync(target, '{}');
    const linkId = randomUUID();
    const link = join(deviceDirectory, `000000000003-${linkId}.json`);
    symlinkSync(target, link);
    expect(() =>
      (
        sync as unknown as {
          readSnapshot(path: string, expected: object): unknown;
        }
      ).readSnapshot(link, { deviceId: 'linux', sequence: 3, snapshotId: linkId }),
    ).toThrow(/symbolic links/);
    expect(() =>
      (
        sync as unknown as {
          readSnapshot(path: string, expected: object): unknown;
        }
      ).readSnapshot(deviceDirectory, {
        deviceId: 'linux',
        sequence: 3,
        snapshotId: linkId,
      }),
    ).toThrow(/bounded regular file/);
    const missingId = randomUUID();
    expect(() =>
      (
        sync as unknown as {
          readSnapshot(path: string, expected: object): unknown;
        }
      ).readSnapshot(join(deviceDirectory, `000000000005-${missingId}.json`), {
        deviceId: 'linux',
        sequence: 5,
        snapshotId: missingId,
      }),
    ).toThrow();
    const tamperedId = randomUUID();
    const tampered = join(deviceDirectory, `000000000004-${tamperedId}.json`);
    writeFileSync(
      tampered,
      JSON.stringify({
        schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
        snapshotId: tamperedId,
        deviceId: 'linux',
        sequence: 4,
        createdAt: '2026-08-26T00:00:00.000Z',
        parentSnapshots: [],
        stateHash: `sha256:${'0'.repeat(64)}`,
        state: empty,
      }),
    );
    expect(() =>
      (
        sync as unknown as {
          readSnapshot(path: string, expected: object): unknown;
        }
      ).readSnapshot(tampered, {
        deviceId: 'linux',
        sequence: 4,
        snapshotId: tamperedId,
      }),
    ).toThrow(/hash/);
    const valid = {
      schemaVersion: 1 as const,
      snapshotId: randomUUID(),
      deviceId: 'linux',
      sequence: 1,
      createdAt: '2026-08-26T00:00:00.000Z',
      parentSnapshots: [],
      stateHash: syncHash(empty),
      state: empty,
    };
    writeFileSync(tampered, canonicalJson(valid));
    expect(() =>
      (
        sync as unknown as {
          readSnapshot(path: string, expected: object): unknown;
        }
      ).readSnapshot(tampered, {
        deviceId: 'linux',
        sequence: 4,
        snapshotId: tamperedId,
      }),
    ).toThrow(/filename tuple/);
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

  it('covers scheduler handoff and default polling defensively', async () => {
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
    const sync = new SyncController({
      settingsPath: join(data, 'sync.json'),
      snapshotter: () => empty,
      importer: vi.fn(),
    });
    await sync.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await sync.drain();
    const internals = sync as unknown as {
      completedGeneration: number;
      dirtyGeneration: number;
      running: Promise<void> | null;
      runLoop(): Promise<void>;
      ensureRun(): void;
      settings: { paused: boolean };
      restartPolling(): void;
    };
    await sync.drain();
    internals.completedGeneration = 0;
    internals.dirtyGeneration = 1;
    let handoffs = 0;
    internals.runLoop = async () => {
      handoffs += 1;
      internals.completedGeneration = internals.dirtyGeneration;
      if (handoffs === 1) internals.dirtyGeneration = 2;
    };
    internals.ensureRun();
    await sync.drain();
    internals.restartPolling();
    await vi.advanceTimersByTimeAsync(5_000);
    await sync.drain();
    internals.settings.paused = true;
    internals.restartPolling();
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

  it('rolls back its in-memory ledger when persisting an import fails', async () => {
    const data = root();
    const shared = join(data, 'Drive');
    mkdirSync(shared);
    const importer = vi.fn();
    const sync = controller(data, { importer });
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
    const internals = sync as unknown as { writeSettings(): void };
    const originalWrite = internals.writeSettings.bind(sync);
    internals.writeSettings = () => {
      throw new Error('ledger unavailable');
    };
    await sync.reconcile();
    expect(sync.getStatus()).toMatchObject({ state: 'error', error: 'ledger unavailable' });
    internals.writeSettings = originalWrite;
    await sync.reconcile();
    expect(sync.getStatus().state).toBe('healthy');
    expect(importer).toHaveBeenCalledTimes(2);
    await sync.close();
  });

  it('applies a resolution that intentionally deletes an entity', () => {
    const data = root();
    const sync = controller(data);
    const workspace = {
      id: 'gone',
      name: 'Gone',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const result = (
      sync as unknown as {
        applyResolutions(
          target: SyncState,
          source: SyncState,
          resolutions: Array<{ entityType: 'workspace'; entityId: string }>,
        ): SyncState;
      }
    ).applyResolutions({ ...empty, workspaces: [workspace] }, empty, [
      { entityType: 'workspace', entityId: 'gone' },
    ]);
    expect(result.workspaces).toEqual([]);
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
    const legacy = remoteSnapshot(shared, 'legacy', 1, { schemaVersion: 1 });
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
    const future = remoteSnapshot(shared, 'future', 1, {
      schemaVersion: 3 as unknown as 2,
    });
    const importer = vi.fn();
    const sync = controller(data, { importer });
    const status = await sync.configure(shared, 'linux');
    expect(importer).toHaveBeenCalledTimes(1);
    expect(status.blockedSnapshot).toEqual({
      path: fileName(localeHashed),
      reason: expect.stringMatching(/upgrade Pimpampum on device "danish" so it republishes/),
    });
    const internals = sync as unknown as {
      readSnapshot(path: string, expected: object): unknown;
    };
    // The configured directory is the realpath; the temporary root may not be.
    const directory = status.directory!;
    expect(() =>
      internals.readSnapshot(join(directory, fileName(future)), {
        deviceId: 'future',
        sequence: 1,
        snapshotId: future.snapshotId,
      }),
    ).toThrow(/uses format 3; upgrade Pimpampum on this device/);
    expect(() =>
      internals.readSnapshot(join(directory, fileName(legacy)), {
        deviceId: 'legacy',
        sequence: 1,
        snapshotId: legacy.snapshotId,
      }),
    ).not.toThrow();
    await sync.close();
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
