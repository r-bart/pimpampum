import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncState } from '../src/syncContract.js';
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
    await sync.close();

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
    const invalid = join(data, 'invalid.json');
    writeFileSync(invalid, '{}');
    expect(() =>
      (sync as unknown as { readSnapshot(path: string): unknown }).readSnapshot(invalid),
    ).toThrow(/invalid/);

    const target = join(data, 'target.json');
    writeFileSync(target, '{}');
    const link = join(data, 'link.json');
    symlinkSync(target, link);
    expect(() =>
      (sync as unknown as { readSnapshot(path: string): unknown }).readSnapshot(link),
    ).toThrow(/regular file/);
    const tampered = join(data, 'tampered.json');
    writeFileSync(
      tampered,
      JSON.stringify({
        schemaVersion: 1,
        snapshotId: randomUUID(),
        deviceId: 'linux',
        sequence: 1,
        createdAt: '2026-08-26T00:00:00.000Z',
        parentSnapshots: [],
        stateHash: `sha256:${'0'.repeat(64)}`,
        state: empty,
      }),
    );
    expect(() =>
      (sync as unknown as { readSnapshot(path: string): unknown }).readSnapshot(tampered),
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
      (sync as unknown as { readSnapshot(path: string, device: string): unknown }).readSnapshot(
        tampered,
        'other',
      ),
    ).toThrow(/namespace/);
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
    writeSnapshot(3, '2026-08-26T00:00:03.000Z');
    writeSnapshot(3, '2026-08-26T00:00:04.000Z');
    await sync.reconcile();
    expect(sync.getStatus()).toMatchObject({
      state: 'error',
      error: 'Shared device sequence is duplicated',
    });
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
    for (const sequence of [2, 1]) {
      const snapshot = {
        schemaVersion: 1 as const,
        snapshotId: randomUUID(),
        deviceId: 'remote',
        sequence,
        createdAt: `2026-08-26T00:00:0${sequence}.000Z`,
        parentSnapshots: [],
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
