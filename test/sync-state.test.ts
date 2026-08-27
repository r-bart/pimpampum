import { describe, expect, it } from 'vitest';
import type { SyncState } from '../src/syncContract.js';
import {
  canonicalJson,
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
});
