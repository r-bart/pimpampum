import type { SyncState } from '../syncContract.js';
import { activityFingerprint, normalizedSyncState } from '../syncState.js';
import { validateSyncState } from '../syncValidation.js';
import { mapContext } from './contextDocuments.js';
import { mapProject } from './projects.js';
import {
  parseObject,
  type ActivityRow,
  type ContextRow,
  type ProjectRow,
  type SpecRow,
  type TaskRow,
  type WorkspaceRow,
} from './rows.js';
import { mapSpecRecord } from './specs.js';
import { upsertSql } from './sql.js';
import type { StoreContext } from './storeContext.js';
import { mapTaskRecord } from './tasks.js';

/**
 * The shared-folder synchronization boundary: the whole durable portfolio out
 * as one canonical state, and a validated state in as one transaction.
 */

type SyncTable = 'tasks' | 'context_documents' | 'specs' | 'projects' | 'workspaces';

const WORKSPACE_COLUMNS = ['id', 'name', 'root_path', 'created_at', 'updated_at'] as const;
const PROJECT_COLUMNS = [
  'id',
  'workspace_id',
  'slug',
  'title',
  'state',
  'revision',
  'completion_summary',
  'artifacts_json',
  'completed_at',
  'cancelled_at',
  'created_at',
  'updated_at',
] as const;
const SPEC_COLUMNS = [
  'id',
  'project_id',
  'slug',
  'title',
  'body',
  'state',
  'revision',
  'completion_summary',
  'artifacts_json',
  'completed_at',
  'cancelled_at',
  'created_at',
  'updated_at',
] as const;
const CONTEXT_COLUMNS = [
  'id',
  'workspace_id',
  'project_id',
  'name',
  'body',
  'revision',
  'created_at',
  'updated_at',
] as const;
const TASK_COLUMNS = [
  'id',
  'spec_id',
  'parent_id',
  'title',
  'body',
  'state',
  'revision',
  'completion_summary',
  'artifacts_json',
  'completed_at',
  'cancelled_at',
  'created_at',
  'updated_at',
] as const;

/** `cancelledAt` travels only when set; see `cancelledAtSchema` in the contract. */
function withOptionalCancelledAt<T extends { cancelledAt: string | null }>(
  entity: T,
): Omit<T, 'cancelledAt'> & { cancelledAt?: string } {
  const { cancelledAt, ...rest } = entity;
  return cancelledAt === null ? rest : { ...rest, cancelledAt };
}

function exportSyncActivity(ctx: StoreContext): SyncState['activity'] {
  return ctx.rows<ActivityRow>('SELECT * FROM activity_events ORDER BY id', []).map((row) => {
    const event = {
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      specId: row.spec_id,
      targetType: row.target_type,
      targetId: row.target_id,
      eventType: row.event_type,
      actor: row.actor,
      data: parseObject(row.data_json),
      createdAt: row.created_at,
    };
    return { fingerprint: activityFingerprint(event), ...event };
  });
}

export function exportSyncState(ctx: StoreContext): SyncState {
  return normalizedSyncState({
    workspaces: ctx.rows<WorkspaceRow>('SELECT * FROM workspaces ORDER BY id', []).map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    projects: ctx
      .rows<ProjectRow>('SELECT * FROM projects ORDER BY id', [])
      .map((row) => withOptionalCancelledAt(mapProject(row))),
    specs: ctx
      .rows<SpecRow>('SELECT * FROM specs ORDER BY id', [])
      .map((row) => withOptionalCancelledAt(mapSpecRecord(row))),
    contexts: ctx
      .rows<ContextRow>('SELECT * FROM context_documents ORDER BY id', [])
      .map(mapContext),
    tasks: ctx
      .rows<TaskRow>('SELECT * FROM tasks ORDER BY id', [])
      .map((row) => withOptionalCancelledAt(mapTaskRecord(row))),
    activity: exportSyncActivity(ctx),
  });
}

/**
 * Deletes every row of `table` whose id is not in `ids`. The ids go through a
 * temporary table because SQLite caps bound variables at 32,766 and a synced
 * collection may hold 50,000 entities. Subtasks go before their parents since
 * `tasks.parent_id` is `ON DELETE RESTRICT`, which SQLite checks per row.
 */
function deleteMissingSyncRows(ctx: StoreContext, table: SyncTable, ids: string[]): void {
  const childrenFirst = table === 'tasks' ? ['parent_id IS NOT NULL AND ', ''] : [''];
  if (ids.length === 0) {
    for (const scope of childrenFirst) {
      ctx.database.prepare(`DELETE FROM ${table} WHERE ${scope}1`).run();
    }
    return;
  }
  ctx.database.exec(
    'CREATE TEMP TABLE IF NOT EXISTS sync_keep (id TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM temp.sync_keep',
  );
  const keep = ctx.database.prepare('INSERT OR IGNORE INTO temp.sync_keep (id) VALUES (?)');
  for (const id of ids) keep.run(id);
  for (const scope of childrenFirst) {
    ctx.database
      .prepare(`DELETE FROM ${table} WHERE ${scope}id NOT IN (SELECT id FROM temp.sync_keep)`)
      .run();
  }
  ctx.database.exec('DELETE FROM temp.sync_keep');
}

/** Children before parents: every table is pruned before its owner. */
function pruneMissing(ctx: StoreContext, state: SyncState): void {
  const ids = <T extends { id: string }>(items: T[]): string[] => items.map((item) => item.id);
  deleteMissingSyncRows(ctx, 'tasks', ids(state.tasks));
  deleteMissingSyncRows(ctx, 'context_documents', ids(state.contexts));
  deleteMissingSyncRows(ctx, 'specs', ids(state.specs));
  deleteMissingSyncRows(ctx, 'projects', ids(state.projects));
  deleteMissingSyncRows(ctx, 'workspaces', ids(state.workspaces));
}

/**
 * The local root never synchronizes: a new Workspace lands with a NULL root
 * and an existing one keeps its root because the conflict clause leaves it alone.
 */
function upsertWorkspaces(ctx: StoreContext, workspaces: SyncState['workspaces']): void {
  const upsert = ctx.database.prepare(
    upsertSql('workspaces', WORKSPACE_COLUMNS, ['created_at', 'root_path']),
  );
  for (const w of workspaces) upsert.run(w.id, w.name, null, w.createdAt, w.updatedAt);
}

function upsertProjects(ctx: StoreContext, projects: SyncState['projects']): void {
  const upsert = ctx.database.prepare(upsertSql('projects', PROJECT_COLUMNS));
  for (const p of projects)
    upsert.run(
      p.id,
      p.workspaceId,
      p.slug,
      p.title,
      p.state,
      p.revision,
      p.completionSummary,
      JSON.stringify(p.artifacts),
      p.completedAt,
      p.cancelledAt ?? null,
      p.createdAt,
      p.updatedAt,
    );
}

function upsertSpecs(ctx: StoreContext, specs: SyncState['specs']): void {
  const upsert = ctx.database.prepare(upsertSql('specs', SPEC_COLUMNS));
  for (const s of specs)
    upsert.run(
      s.id,
      s.projectId,
      s.slug,
      s.title,
      s.body,
      s.state,
      s.revision,
      s.completionSummary,
      JSON.stringify(s.artifacts),
      s.completedAt,
      s.cancelledAt ?? null,
      s.createdAt,
      s.updatedAt,
    );
}

function upsertContexts(ctx: StoreContext, contexts: SyncState['contexts']): void {
  const upsert = ctx.database.prepare(upsertSql('context_documents', CONTEXT_COLUMNS));
  for (const c of contexts)
    upsert.run(
      c.id,
      c.ownerType === 'workspace' ? c.ownerId : null,
      c.ownerType === 'project' ? c.ownerId : null,
      c.name,
      c.body,
      c.revision,
      c.createdAt,
      c.updatedAt,
    );
}

/** Top-level Tasks first so every Subtask finds its parent. */
function upsertTasks(ctx: StoreContext, tasks: SyncState['tasks']): void {
  const upsert = ctx.database.prepare(upsertSql('tasks', TASK_COLUMNS));
  const ordered = [
    ...tasks.filter((task) => task.parentId === null),
    ...tasks.filter((task) => task.parentId !== null),
  ];
  for (const t of ordered)
    upsert.run(
      t.id,
      t.specId,
      t.parentId,
      t.title,
      t.body,
      t.state,
      t.revision,
      t.completionSummary,
      JSON.stringify(t.artifacts),
      t.completedAt,
      t.cancelledAt ?? null,
      t.createdAt,
      t.updatedAt,
    );
}

/** Appends every event whose fingerprint the local log does not hold yet, keeping its own clock. */
function importActivity(ctx: StoreContext, events: SyncState['activity']): void {
  const existing = new Set(exportSyncActivity(ctx).map((event) => event.fingerprint));
  for (const event of events) {
    if (existing.has(event.fingerprint)) continue;
    ctx.writeEvent(
      {
        workspaceId: event.workspaceId,
        projectId: event.projectId,
        specId: event.specId,
        targetType: event.targetType,
        targetId: event.targetId,
        eventType: event.eventType,
        actor: event.actor,
        data: event.data,
      },
      event.createdAt,
    );
  }
}

/** Validates, then replaces the local portfolio with `state` in one committed write. */
export function applySyncState(ctx: StoreContext, state: SyncState): void {
  validateSyncState(state);
  ctx.runImmediate(() => {
    pruneMissing(ctx, state);
    upsertWorkspaces(ctx, state.workspaces);
    upsertProjects(ctx, state.projects);
    upsertSpecs(ctx, state.specs);
    upsertContexts(ctx, state.contexts);
    upsertTasks(ctx, state.tasks);
    importActivity(ctx, state.activity);
  });
}
