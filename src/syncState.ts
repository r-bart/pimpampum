import { createHash } from 'node:crypto';
import type { SyncEntityKind, SyncState } from './syncContract.js';

/**
 * Orders two strings by their UTF-16 code units, one unit at a time.
 *
 * Every device must derive the same canonical JSON for the same state, so the
 * order cannot depend on the process locale the way `localeCompare` does. The
 * `<` operator on strings is specified as a code-unit comparison, which makes
 * the result identical under any `LANG` or `LC_ALL`.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function syncHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function activityFingerprint(
  value: Omit<SyncState['activity'][number], 'fingerprint'>,
): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function normalizedSyncState(state: SyncState): SyncState {
  const byId = <T extends { id: string }>(items: T[]) =>
    [...items].sort((a, b) => compareCodeUnits(a.id, b.id));
  return {
    workspaces: byId(state.workspaces),
    projects: byId(state.projects),
    specs: byId(state.specs),
    contexts: byId(state.contexts),
    tasks: byId(state.tasks),
    activity: [...state.activity].sort(
      (a, b) =>
        compareCodeUnits(a.createdAt, b.createdAt) ||
        compareCodeUnits(a.fingerprint, b.fingerprint),
    ),
  };
}

export interface MergeConflictCandidate {
  entityType: SyncEntityKind;
  entityId: string;
  local: unknown;
  remote: unknown;
}

export interface MergeResult {
  state: SyncState;
  conflicts: MergeConflictCandidate[];
}

function mergeEntities<T extends { id: string }>(
  entityType: SyncEntityKind,
  baseItems: T[],
  localItems: T[],
  remoteItems: T[],
): { items: T[]; conflicts: MergeConflictCandidate[] } {
  const base = new Map(baseItems.map((item) => [item.id, item]));
  const local = new Map(localItems.map((item) => [item.id, item]));
  const remote = new Map(remoteItems.map((item) => [item.id, item]));
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const items: T[] = [];
  const conflicts: MergeConflictCandidate[] = [];
  for (const id of [...ids].sort(compareCodeUnits)) {
    const before = base.get(id);
    const left = local.get(id);
    const right = remote.get(id);
    const beforeJson = canonicalJson(before);
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    if (leftJson === rightJson) {
      /* v8 ignore next -- a union key cannot be absent from both maps */
      if (left) items.push(left);
    } else if (leftJson === beforeJson) {
      if (right) items.push(right);
    } else if (rightJson === beforeJson) {
      if (left) items.push(left);
    } else {
      conflicts.push({ entityType, entityId: id, local: left ?? null, remote: right ?? null });
      if (left) items.push(left);
    }
  }
  return { items, conflicts };
}

export function mergeSyncStates(base: SyncState, local: SyncState, remote: SyncState): MergeResult {
  const workspaces = mergeEntities(
    'workspace',
    base.workspaces,
    local.workspaces,
    remote.workspaces,
  );
  const projects = mergeEntities('project', base.projects, local.projects, remote.projects);
  const specs = mergeEntities('spec', base.specs, local.specs, remote.specs);
  const contexts = mergeEntities('context', base.contexts, local.contexts, remote.contexts);
  const tasks = mergeEntities('task', base.tasks, local.tasks, remote.tasks);
  const activity = new Map(
    [...base.activity, ...local.activity, ...remote.activity].map((event) => [
      event.fingerprint,
      event,
    ]),
  );
  return {
    state: normalizedSyncState({
      workspaces: workspaces.items,
      projects: projects.items,
      specs: specs.items,
      contexts: contexts.items,
      tasks: tasks.items,
      activity: [...activity.values()],
    }),
    conflicts: [
      ...workspaces.conflicts,
      ...projects.conflicts,
      ...specs.conflicts,
      ...contexts.conflicts,
      ...tasks.conflicts,
    ],
  };
}

export function preserveConflictedEntities(
  state: SyncState,
  local: SyncState,
  conflicts: Array<Pick<MergeConflictCandidate, 'entityType' | 'entityId'>>,
): SyncState {
  const result = structuredClone(state);
  const collections = {
    workspace: 'workspaces',
    project: 'projects',
    spec: 'specs',
    context: 'contexts',
    task: 'tasks',
  } as const;
  for (const conflict of conflicts) {
    const collection = collections[conflict.entityType];
    const localEntity = local[collection].find((entity) => entity.id === conflict.entityId);
    result[collection] = result[collection].filter(
      (entity) => entity.id !== conflict.entityId,
    ) as never;
    if (localEntity) (result[collection] as Array<typeof localEntity>).push(localEntity);
  }
  return normalizedSyncState(result);
}
