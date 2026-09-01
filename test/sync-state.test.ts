import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  parseSyncSnapshot,
  type SyncState,
} from '../src/syncContract.js';
import {
  canonicalJson,
  compareCodeUnits,
  mergeSyncStates,
  normalizedSyncState,
  preserveConflictedEntities,
  syncHash,
} from '../src/syncState.js';

const empty = (): SyncState => ({
  workspaces: [],
  projects: [],
  specs: [],
  contexts: [],
  tasks: [],
  activity: [],
});

/**
 * Keys a locale-aware collation reorders: Danish sorts `aa` after `å` and `z`,
 * Czech sorts `ch` after `ci`, Turkish pairs `İ` with `i`. Code-unit order is
 * `I` (0x49) < `aa` < `ab` < `ch` < `ci` < `i` (0x69) < `å` (0xE5) < `İ` (0x130).
 */
const LOCALE_SENSITIVE_KEYS = ['aa', 'ab', 'å', 'ch', 'ci', 'I', 'i', 'İ'] as const;
const CODE_UNIT_ORDER = ['I', 'aa', 'ab', 'ch', 'ci', 'i', 'å', 'İ'] as const;

function withDanishLocaleCompare<T>(run: () => T): T {
  const collator = new Intl.Collator('da');
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function danish(this: string, other: string): number {
    return collator.compare(String(this), String(other));
  } as typeof String.prototype.localeCompare;
  try {
    return run();
  } finally {
    String.prototype.localeCompare = original;
  }
}

function localeSensitiveState(): SyncState {
  const state = empty();
  state.workspaces = LOCALE_SENSITIVE_KEYS.map((id) => ({
    id,
    name: id,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  }));
  return state;
}

describe('sync state', () => {
  it('canonicalizes object keys and state collections deterministically', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 1 } })).toBe('{"a":{"b":1,"d":2},"z":1}');
    const state = empty();
    state.workspaces = [
      {
        id: 'z',
        name: 'Z',
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
      {
        id: 'a',
        name: 'A',
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
    ];
    expect(normalizedSyncState(state).workspaces.map((workspace) => workspace.id)).toEqual([
      'a',
      'z',
    ]);
    expect(syncHash({ a: 1, b: 2 })).toBe(syncHash({ b: 2, a: 1 }));
    expect(syncHash({ a: 1 })).not.toBe(syncHash({ a: 2 }));
  });

  it('merges unrelated changes and reports same-base divergence', () => {
    const base = empty();
    const workspace = {
      id: 'one',
      name: 'One',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    base.workspaces = [workspace];
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.workspaces[0] = { ...workspace, name: 'Local' };
    remote.projects.push({
      id: 'project',
      workspaceId: 'one',
      slug: 'remote',
      title: 'Remote',
      state: 'draft',
      revision: 1,
      completionSummary: null,
      artifacts: [],
      completedAt: null,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:01.000Z',
    });
    const merged = mergeSyncStates(base, local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.state.workspaces[0]?.name).toBe('Local');
    expect(merged.state.projects).toHaveLength(1);

    remote.workspaces[0] = { ...workspace, name: 'Remote' };
    const conflict = mergeSyncStates(base, local, remote);
    expect(conflict.conflicts).toMatchObject([{ entityType: 'workspace', entityId: 'one' }]);
    expect(conflict.state.workspaces[0]?.name).toBe('Local');
  });

  it('merges deletions and preserves missing-side conflict candidates', () => {
    const base = empty();
    const original = {
      id: 'one',
      name: 'Original',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const changed = { ...original, name: 'Changed' };
    base.workspaces = [original];
    const unchanged = structuredClone(base);
    expect(mergeSyncStates(base, empty(), unchanged).state.workspaces).toEqual([]);
    expect(mergeSyncStates(base, unchanged, empty()).state.workspaces).toEqual([]);
    const localConflict = mergeSyncStates(base, { ...empty(), workspaces: [changed] }, empty());
    expect(localConflict.conflicts[0]).toMatchObject({ local: changed, remote: null });
    const remoteConflict = mergeSyncStates(base, empty(), { ...empty(), workspaces: [changed] });
    expect(remoteConflict.conflicts[0]).toMatchObject({ local: null, remote: changed });
    expect(
      preserveConflictedEntities(remoteConflict.state, empty(), [
        { entityType: 'workspace', entityId: 'one' },
      ]).workspaces,
    ).toEqual([]);
  });

  it('orders keys and ids by UTF-16 code units, byte for byte', () => {
    expect(CODE_UNIT_ORDER.map((key) => key.codePointAt(0))).toEqual(
      CODE_UNIT_ORDER.map((key) => key.codePointAt(0)!).sort((a, b) => a - b),
    );
    const record = Object.fromEntries(
      LOCALE_SENSITIVE_KEYS.map((key) => [key, CODE_UNIT_ORDER.indexOf(key)]),
    );
    const expected = `{${CODE_UNIT_ORDER.map((key, index) => `"${key}":${index}`).join(',')}}`;
    expect(Buffer.from(canonicalJson(record), 'utf8').equals(Buffer.from(expected, 'utf8'))).toBe(
      true,
    );
    expect(normalizedSyncState(localeSensitiveState()).workspaces.map((w) => w.id)).toEqual(
      CODE_UNIT_ORDER,
    );
    expect([...LOCALE_SENSITIVE_KEYS].sort(compareCodeUnits)).toEqual(CODE_UNIT_ORDER);
    expect(compareCodeUnits('same', 'same')).toBe(0);
  });

  it('does not depend on the process locale', () => {
    const record = Object.fromEntries(LOCALE_SENSITIVE_KEYS.map((key) => [key, key]));
    const state = localeSensitiveState();
    const plainJson = canonicalJson(record);
    const plainHash = syncHash(state);
    const plainMerge = mergeSyncStates(empty(), state, empty()).state.workspaces.map((w) => w.id);
    const nativeLocaleCompare = String.prototype.localeCompare;
    const danish = withDanishLocaleCompare(() => {
      // Sanity check that the stub is active: Danish orders `aa` after `z`.
      expect('z'.localeCompare('aa')).toBeLessThan(0);
      return {
        json: canonicalJson(record),
        hash: syncHash(state),
        merge: mergeSyncStates(empty(), state, empty()).state.workspaces.map((w) => w.id),
      };
    });
    // The stub is gone afterwards; identity, not ordering, because the host locale may be Danish.
    expect(String.prototype.localeCompare).toBe(nativeLocaleCompare);
    expect(danish.json).toBe(plainJson);
    expect(danish.hash).toBe(plainHash);
    expect(danish.merge).toEqual(plainMerge);
    expect(plainMerge).toEqual(CODE_UNIT_ORDER);
  });
});

describe('sync snapshot contract', () => {
  const snapshot = (overrides: Record<string, unknown>) => ({
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: randomUUID(),
    deviceId: 'linux',
    sequence: 1,
    createdAt: '2026-08-26T00:00:00.000Z',
    parentSnapshots: [],
    stateHash: syncHash(empty()),
    state: empty(),
    ...overrides,
  });

  it('accepts schema versions 1 and 2 and asks for an upgrade above 2', () => {
    expect(parseSyncSnapshot(snapshot({ schemaVersion: 1 })).schemaVersion).toBe(1);
    expect(parseSyncSnapshot(snapshot({})).schemaVersion).toBe(2);
    expect(
      parseSyncSnapshot(snapshot({ appliedHeads: { linux: randomUUID() } })).appliedHeads,
    ).toBeDefined();
    expect(() => parseSyncSnapshot(snapshot({ schemaVersion: 3 }))).toThrow(
      /uses format 3; upgrade Pimpampum on this device/,
    );
    expect(() => parseSyncSnapshot(snapshot({ schemaVersion: 'two' }))).toThrow(/invalid/);
    expect(() => parseSyncSnapshot('not an object')).toThrow(/invalid/);
  });

  it('bounds appliedHeads and keeps Context names slugs', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`device-${index}`, randomUUID()]),
    );
    expect(() => parseSyncSnapshot(snapshot({ appliedHeads: tooMany }))).toThrow(/invalid/);
    const state = empty();
    state.workspaces.push({
      id: 'one',
      name: 'One',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    });
    state.contexts.push({
      id: randomUUID(),
      revision: 1,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      ownerType: 'workspace',
      ownerId: 'one',
      name: '../../escape',
      body: '',
    });
    expect(() => parseSyncSnapshot(snapshot({ state, stateHash: syncHash(state) }))).toThrow(
      /invalid/,
    );
  });
});
