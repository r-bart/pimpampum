import { randomUUID } from 'node:crypto';
import {
  evaluateTaskTransition,
  isTerminalProjectState,
  isTerminalSpecState,
  isTerminalTaskState,
} from '../domainRules.js';
import { AppError } from '../errors.js';
import type { CreateTaskInput, MarkdownPage, Task, TaskManifest } from '../types.js';
import { taskEvent } from './activity.js';
import { cancelDescendants, recordCascade } from './cascade.js';
import { getClaim } from './claims.js';
import { page } from './markdown.js';
import { getProject } from './projects.js';
import {
  mapJoinedClaim,
  parseArtifacts,
  type TaskManifestRow,
  type TaskRow,
  type TaskWithClaimRow,
} from './rows.js';
import { getSpec } from './specs.js';
import { TASK_MANIFEST_SQL, TASK_SQL } from './sql.js';
import type { StoreContext } from './storeContext.js';

export interface ListTaskManifestsInput {
  specId: string;
  limit: number;
  offset: number;
}
export interface UpdateTaskInput {
  taskId: string;
  title: string | null;
  /** `undefined` leaves the body alone; `null` clears it. */
  body: string | null | undefined;
  expectedRevision: number;
  actor: string | null;
}
export interface CancelTaskInput {
  taskId: string;
  expectedRevision: number;
  reason: string;
  actor: string | null;
}

export function mapTaskRecord(r: TaskRow): Omit<Task, 'claim'> {
  return {
    id: r.id,
    specId: r.spec_id,
    parentId: r.parent_id,
    title: r.title,
    body: r.body,
    state: r.state,
    revision: r.revision,
    completionSummary: r.completion_summary,
    artifacts: parseArtifacts(r.artifacts_json),
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapTask(r: TaskWithClaimRow): Task {
  return { ...mapTaskRecord(r), claim: mapJoinedClaim('task', r.id, r) };
}

export function mapTaskManifest(r: TaskManifestRow): TaskManifest {
  const { body: _body, artifacts, completionSummary, ...base } = mapTask(r);
  return {
    ...base,
    bodySizeBytes: r.body_size_bytes,
    artifactCount: artifacts.length,
    hasCompletion: completionSummary !== null,
    subtaskCount: r.subtask_count,
    openSubtaskCount: r.open_subtask_count,
  };
}

export function getTask(ctx: StoreContext, id: string): Task {
  return ctx.load<TaskWithClaimRow, Task>(
    `${TASK_SQL} WHERE t.id=?`,
    [ctx.now(), id],
    `Task ${id}`,
    mapTask,
  );
}

export function getTaskManifest(ctx: StoreContext, id: string): TaskManifest {
  return ctx.load<TaskManifestRow, TaskManifest>(
    `${TASK_MANIFEST_SQL} WHERE t.id=?`,
    [ctx.now(), id],
    `Task ${id}`,
    mapTaskManifest,
  );
}

export function readTaskBody(
  ctx: StoreContext,
  id: string,
  offset: number,
  limit: number,
): MarkdownPage {
  return page(getTask(ctx, id).body ?? '', offset, limit);
}

export function countOpenChildren(ctx: StoreContext, id: string): number {
  return ctx.count("SELECT COUNT(*) count FROM tasks WHERE parent_id=? AND state='open'", id);
}

/** A Subtask needs an open, unclaimed, top-level parent in the same Spec. */
function assertParentAcceptsSubtask(ctx: StoreContext, parentId: string, specId: string): void {
  const parent = getTask(ctx, parentId);
  if (parent.specId !== specId)
    throw new AppError('bad_request', 'Parent Task belongs to another Spec', 400);
  if (parent.parentId !== null)
    throw new AppError('bad_request', 'Subtasks cannot have children', 400);
  if (isTerminalTaskState(parent.state))
    throw new AppError('invalid_state', 'Subtasks cannot be added to a terminal Task', 409);
  if (getClaim(ctx, 'task', parent.id))
    throw new AppError('conflict', 'Release the parent Task claim before adding Subtasks', 409);
}

export function createTask(ctx: StoreContext, input: CreateTaskInput): Task {
  ctx.syncWritable('spec', input.specId);
  if (input.parentId) ctx.syncWritable('task', input.parentId);
  return ctx.runImmediate(() => {
    const s = getSpec(ctx, input.specId),
      p = getProject(ctx, s.projectId);
    if (isTerminalSpecState(s.state) || isTerminalProjectState(p.state))
      throw new AppError('invalid_state', 'Tasks cannot be added to terminal work', 409);
    if (getClaim(ctx, 'spec', s.id))
      throw new AppError('conflict', 'Release the Spec claim before creating Tasks', 409);
    if (input.parentId) assertParentAcceptsSubtask(ctx, input.parentId, s.id);
    const id = randomUUID(),
      at = ctx.now();
    ctx.database
      .prepare(
        "INSERT INTO tasks (id,spec_id,parent_id,title,body,state,created_at,updated_at) VALUES (?,?,?,?,?,'open',?,?)",
      )
      .run(id, s.id, input.parentId, input.title, input.body, at, at);
    taskEvent(ctx, id, s.id, p.id, 'task.created', input.actor, {
      parentId: input.parentId,
      title: input.title,
    });
    return getTask(ctx, id);
  });
}

export function listTaskManifests(
  ctx: StoreContext,
  input: ListTaskManifestsInput,
): TaskManifest[] {
  getSpec(ctx, input.specId);
  return ctx
    .rows<TaskManifestRow>(
      `${TASK_MANIFEST_SQL} WHERE t.spec_id=? ORDER BY CASE WHEN t.parent_id IS NULL THEN t.id ELSE t.parent_id END,t.parent_id IS NOT NULL,t.created_at,t.id LIMIT ? OFFSET ?`,
      [ctx.now(), input.specId, input.limit, input.offset],
    )
    .map(mapTaskManifest);
}

export function updateTask(ctx: StoreContext, input: UpdateTaskInput): Task {
  if (input.title === null && input.body === undefined)
    throw new AppError('bad_request', 'Provide a title and/or body to update.', 400);
  ctx.syncWritable('task', input.taskId);
  return ctx.runImmediate(() => {
    const t = getTask(ctx, input.taskId);
    ctx.revision(t.revision, input.expectedRevision);
    const s = getSpec(ctx, t.specId),
      p = getProject(ctx, s.projectId);
    if (
      isTerminalTaskState(t.state) ||
      isTerminalSpecState(s.state) ||
      isTerminalProjectState(p.state)
    )
      throw new AppError('invalid_state', 'Terminal Tasks cannot be edited', 409);
    const title = input.title ?? t.title,
      body = input.body === undefined ? t.body : input.body;
    ctx.bumpRevision({
      table: 'tasks',
      id: t.id,
      expectedRevision: input.expectedRevision,
      at: ctx.now(),
      set: { title, body },
    });
    taskEvent(ctx, t.id, s.id, p.id, 'task.updated', input.actor, { title });
    return getTask(ctx, t.id);
  });
}

export function cancelTask(ctx: StoreContext, input: CancelTaskInput): Task {
  ctx.syncWritable('task', input.taskId);
  return ctx.runImmediate(() => {
    const t = getTask(ctx, input.taskId);
    ctx.revision(t.revision, input.expectedRevision);
    ctx.allowed(
      evaluateTaskTransition(t.state, 'cancelled', {
        nonTerminalSubtaskCount: countOpenChildren(ctx, t.id),
      }).reason,
    );
    const s = getSpec(ctx, t.specId),
      p = getProject(ctx, s.projectId),
      at = ctx.now();
    const cancelled = cancelDescendants(ctx, 'task', t.id, at);
    ctx.bumpRevision({
      table: 'tasks',
      id: t.id,
      expectedRevision: input.expectedRevision,
      at,
      set: { state: 'cancelled', cancelled_at: at },
    });
    recordCascade(ctx, cancelled, {
      projectId: p.id,
      actor: input.actor,
      cause: 'task.cancelled',
      reason: input.reason,
    });
    taskEvent(ctx, t.id, s.id, p.id, 'task.cancelled', input.actor, {
      reason: input.reason,
      cancelledSubtaskCount: cancelled.tasks.length,
    });
    return getTask(ctx, t.id);
  });
}
