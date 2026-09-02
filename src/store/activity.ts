import type { ActivityEvent } from '../types.js';
import type { StoreContext } from './storeContext.js';
import { parseObject, type ActivityRow } from './rows.js';

type EventData = Record<string, unknown>;

/** The Project columns every event needs; reads only the scope so this module owns no aggregate. */
function projectScope(ctx: StoreContext, projectId: string): { id: string; workspaceId: string } {
  return ctx.load<{ id: string; workspace_id: string }, { id: string; workspaceId: string }>(
    'SELECT id,workspace_id FROM projects WHERE id=?',
    [projectId],
    `Project ${projectId}`,
    (row) => ({ id: row.id, workspaceId: row.workspace_id }),
  );
}

export function projectEvent(
  ctx: StoreContext,
  projectId: string,
  eventType: string,
  actor: string | null,
  data: EventData,
): void {
  const p = projectScope(ctx, projectId);
  ctx.writeEvent({
    workspaceId: p.workspaceId,
    projectId: p.id,
    specId: null,
    targetType: typeof data.targetId === 'string' ? 'context' : 'project',
    targetId: typeof data.targetId === 'string' ? data.targetId : p.id,
    eventType,
    actor,
    data,
  });
}

export function specEvent(
  ctx: StoreContext,
  specId: string,
  projectId: string,
  eventType: string,
  actor: string | null,
  data: EventData,
): void {
  const p = projectScope(ctx, projectId),
    isTask = data.targetType === 'task' || eventType.startsWith('task.');
  ctx.writeEvent({
    workspaceId: p.workspaceId,
    projectId: p.id,
    specId,
    targetType: isTask ? 'task' : 'spec',
    targetId: typeof data.targetId === 'string' ? data.targetId : specId,
    eventType,
    actor,
    data,
  });
}

export function taskEvent(
  ctx: StoreContext,
  taskId: string,
  specId: string,
  projectId: string,
  eventType: string,
  actor: string | null,
  data: EventData,
): void {
  const p = projectScope(ctx, projectId);
  ctx.writeEvent({
    workspaceId: p.workspaceId,
    projectId: p.id,
    specId,
    targetType: 'task',
    targetId: taskId,
    eventType,
    actor,
    data,
  });
}

export function activityRowToEvent(r: ActivityRow): ActivityEvent {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    specId: r.spec_id,
    targetType: r.target_type,
    targetId: r.target_id,
    eventType: r.event_type,
    actor: r.actor,
    data: parseObject(r.data_json),
    createdAt: r.created_at,
  };
}

export function listActivity(ctx: StoreContext, projectId: string, limit: number): ActivityEvent[] {
  projectScope(ctx, projectId);
  return ctx
    .rows<ActivityRow>(
      'SELECT * FROM activity_events WHERE project_id=? ORDER BY id DESC LIMIT ?',
      [projectId, limit],
    )
    .map(activityRowToEvent);
}
