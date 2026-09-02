import {
  evaluateClaimEligibility,
  evaluateSpecTransition,
  evaluateTaskTransition,
  isTerminalSpecState,
  isTerminalTaskState,
} from '../domainRules.js';
import { AppError } from '../errors.js';
import type {
  Claim,
  CompleteWorkInput,
  Spec,
  SpecState,
  TargetType,
  Task,
  TaskState,
  WorkBundle,
  WorkItem,
} from '../types.js';
import { specEvent } from './activity.js';
import { getClaim } from './claims.js';
import { contextManifestPage } from './contextDocuments.js';
import { getProject, getProjectManifest } from './projects.js';
import type { WorkRow } from './rows.js';
import { countOpenTasks, getSpec, getSpecManifest, specFacts } from './specs.js';
import { AVAILABLE_WORK_CTE, completionSet } from './sql.js';
import { requireRow, type StoreContext } from './storeContext.js';
import { countOpenChildren, getTask, getTaskManifest } from './tasks.js';
import { getWorkspace } from './workspaces.js';

/**
 * The agent protocol: discover available work, hold an exclusive lease on a
 * ready Spec or a leaf Task, keep it alive, hand it back or complete it.
 */

export interface WorkScope {
  workspaceId: string | null;
  projectId: string | null;
  specId: string | null;
}
export interface ListWorkInput extends WorkScope {
  limit: number;
}
export interface LeaseInput {
  targetType: TargetType;
  targetId: string;
  agentId: string;
  leaseSeconds: number;
}
export interface ReleaseWorkInput {
  targetType: TargetType;
  targetId: string;
  agentId: string;
  note: string | null;
}
interface WorkTarget {
  targetType: TargetType;
  targetId: string;
  agentId: string;
}

const WORK_ITEM_SQL = `${AVAILABLE_WORK_CTE} SELECT target_type,target_id,workspace_id,project_id,project_title,spec_id,spec_title,task_id,task_title,parent_task_id,revision,sort_at FROM available`;

function mapWorkItem(r: WorkRow): WorkItem {
  return {
    targetType: r.target_type,
    targetId: r.target_id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    projectTitle: r.project_title,
    specId: r.spec_id,
    specTitle: r.spec_title,
    taskId: r.task_id,
    taskTitle: r.task_title,
    parentTaskId: r.parent_task_id,
    revision: r.revision,
  };
}

/** Rejects a scope whose Project and Spec do not belong to the named Workspace and Project. */
function assertWorkScope(ctx: StoreContext, scope: WorkScope): void {
  const { workspaceId, projectId, specId } = scope;
  const project = projectId ? getProject(ctx, projectId) : null;
  if (workspaceId && project && project.workspaceId !== workspaceId)
    throw new AppError('bad_request', 'Project does not belong to the requested Workspace', 400);
  if (!specId) return;
  const spec = getSpec(ctx, specId),
    specProject = getProject(ctx, spec.projectId);
  if (projectId && spec.projectId !== projectId)
    throw new AppError('bad_request', 'Spec does not belong to the requested Project', 400);
  if (workspaceId && specProject.workspaceId !== workspaceId)
    throw new AppError('bad_request', 'Spec does not belong to the requested Workspace', 400);
}

export function listWork(ctx: StoreContext, input: ListWorkInput): WorkItem[] {
  assertWorkScope(ctx, input);
  const at = ctx.now();
  const filters: Array<[column: string, value: string | null]> = [
    ['workspace_id', input.workspaceId],
    ['project_id', input.projectId],
    ['spec_id', input.specId],
  ];
  const active = filters.filter((filter): filter is [string, string] => Boolean(filter[1]));
  const where =
    active.length > 0 ? `WHERE ${active.map(([column]) => `${column}=?`).join(' AND ')}` : '';
  return ctx
    .rows<WorkRow>(`${WORK_ITEM_SQL} ${where} ORDER BY sort_at,target_id LIMIT ?`, [
      at,
      at,
      ...active.map(([, value]) => value),
      input.limit,
    ])
    .map(mapWorkItem);
}

function specIdForTarget(ctx: StoreContext, type: TargetType, id: string): string {
  return type === 'spec' ? getSpec(ctx, id).id : getTask(ctx, id).specId;
}

/** Why no Claim is held: a revoked Claim on terminal work explains itself, anything else is a conflict. */
function unclaimedError(ctx: StoreContext, type: TargetType, id: string): AppError {
  const state: SpecState | TaskState =
    type === 'spec' ? getSpec(ctx, id).state : getTask(ctx, id).state;
  const terminal =
    type === 'spec'
      ? isTerminalSpecState(state as SpecState)
      : isTerminalTaskState(state as TaskState);
  if (terminal)
    return new AppError(
      'invalid_state',
      `The ${type} is ${state}; its Claim was revoked and cannot be renewed, released, or completed`,
      409,
      false,
      { targetType: type, targetId: id, state },
    );
  return new AppError('conflict', 'Work is not currently claimed', 409, true);
}

/** The active Claim `agentId` holds on the target at `at`. */
function ownedClaim(ctx: StoreContext, target: WorkTarget, at: string): Claim {
  const claim = getClaim(ctx, target.targetType, target.targetId, at);
  if (!claim) throw unclaimedError(ctx, target.targetType, target.targetId);
  if (claim.agentId !== target.agentId)
    throw new AppError('conflict', `Work is claimed by ${claim.agentId}`, 409, true);
  return claim;
}

/** Fails with `invalid_state` unless the domain rules allow a Claim on the target right now. */
function assertTargetAvailable(ctx: StoreContext, type: TargetType, id: string): void {
  if (type === 'spec') {
    const s = getSpec(ctx, id),
      p = getProject(ctx, s.projectId);
    ctx.allowed(
      evaluateClaimEligibility({
        targetType: 'spec',
        projectState: p.state,
        specState: s.state,
        openTaskCount: countOpenTasks(ctx, s.id),
      }).reason,
    );
    return;
  }
  const t = getTask(ctx, id),
    s = getSpec(ctx, t.specId),
    p = getProject(ctx, s.projectId);
  ctx.allowed(
    evaluateClaimEligibility({
      targetType: 'task',
      projectState: p.state,
      specState: s.state,
      taskState: t.state,
      openSubtaskCount: countOpenChildren(ctx, t.id),
    }).reason,
  );
}

function leaseExpiry(ctx: StoreContext, leaseSeconds: number): string {
  return new Date(ctx.clock().getTime() + leaseSeconds * 1000).toISOString();
}

/** Every work event hangs off the Spec that owns the target, with the agent as actor. */
function recordWorkEvent(
  ctx: StoreContext,
  target: WorkTarget,
  eventType: string,
  data: Record<string, unknown>,
): void {
  const specId = specIdForTarget(ctx, target.targetType, target.targetId),
    s = getSpec(ctx, specId);
  specEvent(ctx, specId, s.projectId, eventType, target.agentId, {
    targetType: target.targetType,
    targetId: target.targetId,
    ...data,
  });
}

/** Everything an agent needs to start: the Claim, the manifests above it and bounded Context. */
function workBundle(ctx: StoreContext, type: TargetType, id: string): WorkBundle {
  const claim = requireRow(getClaim(ctx, type, id), 'Claim could not be created'),
    specId = specIdForTarget(ctx, type, id),
    spec = getSpecManifest(ctx, specId),
    project = getProjectManifest(ctx, spec.projectId),
    workspace = getWorkspace(ctx, project.workspaceId);
  return {
    claim,
    workspace,
    project,
    spec,
    task: type === 'task' ? getTaskManifest(ctx, id) : null,
    workspaceContext: contextManifestPage(ctx, 'workspace', workspace.id),
    projectContext: contextManifestPage(ctx, 'project', project.id),
  };
}

/** Claims the target for `agentId`; a repeated call by the same agent returns the bundle unchanged. */
export function startWork(ctx: StoreContext, input: LeaseInput): WorkBundle {
  ctx.syncWritable(input.targetType, input.targetId);
  const changed = ctx.immediate(() => {
    const at = ctx.now();
    ctx.database
      .prepare('DELETE FROM claims WHERE target_type=? AND target_id=? AND expires_at<=?')
      .run(input.targetType, input.targetId, at);
    const existing = getClaim(ctx, input.targetType, input.targetId, at);
    if (existing?.agentId === input.agentId) return false;
    if (existing) throw new AppError('conflict', 'Work is already claimed', 409, true);
    assertTargetAvailable(ctx, input.targetType, input.targetId);
    const expiresAt = leaseExpiry(ctx, input.leaseSeconds);
    ctx.database
      .prepare(
        'INSERT INTO claims (target_type,target_id,agent_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(input.targetType, input.targetId, input.agentId, expiresAt, at, at);
    recordWorkEvent(ctx, input, 'work.started', { expiresAt });
    return true;
  });
  if (changed) ctx.recordMutation();
  return workBundle(ctx, input.targetType, input.targetId);
}

export function renewWork(ctx: StoreContext, input: LeaseInput): Claim {
  ctx.syncWritable(input.targetType, input.targetId);
  return ctx.runImmediate(() => {
    const at = ctx.now(),
      claim = ownedClaim(ctx, input, at),
      expiresAt = leaseExpiry(ctx, input.leaseSeconds);
    assertTargetAvailable(ctx, input.targetType, input.targetId);
    const result = ctx.database
      .prepare(
        'UPDATE claims SET expires_at=?,updated_at=? WHERE target_type=? AND target_id=? AND agent_id=? AND expires_at>?',
      )
      .run(expiresAt, at, input.targetType, input.targetId, input.agentId, at);
    if (result.changes !== 1)
      throw new AppError('conflict', 'Claim expired or changed before renewal', 409, true);
    recordWorkEvent(ctx, input, 'work.renewed', { previousExpiry: claim.expiresAt, expiresAt });
    return requireRow(
      getClaim(ctx, input.targetType, input.targetId, at),
      'Claim could not be renewed',
    );
  });
}

export function releaseWork(ctx: StoreContext, input: ReleaseWorkInput): void {
  ctx.runImmediate(() => {
    const at = ctx.now();
    ownedClaim(ctx, input, at);
    const result = ctx.database
      .prepare(
        'DELETE FROM claims WHERE target_type=? AND target_id=? AND agent_id=? AND expires_at>?',
      )
      .run(input.targetType, input.targetId, input.agentId, at);
    if (result.changes !== 1)
      throw new AppError('conflict', 'Claim expired or changed before release', 409, true);
    recordWorkEvent(ctx, input, 'work.released', { note: input.note });
  });
}

function completeSpec(ctx: StoreContext, input: CompleteWorkInput, at: string): void {
  const s = getSpec(ctx, input.targetId);
  ctx.revision(s.revision, input.expectedRevision);
  ctx.allowed(evaluateSpecTransition(s.state, 'done', specFacts(ctx, s.id, s.body)).reason);
  ctx.bumpRevision({
    table: 'specs',
    id: s.id,
    expectedRevision: input.expectedRevision,
    at,
    set: completionSet(input.summary, input.artifacts, at),
  });
}

function completeTask(ctx: StoreContext, input: CompleteWorkInput, at: string): void {
  const t = getTask(ctx, input.targetId);
  ctx.revision(t.revision, input.expectedRevision);
  ctx.allowed(
    evaluateTaskTransition(t.state, 'done', {
      nonTerminalSubtaskCount: countOpenChildren(ctx, t.id),
    }).reason,
  );
  ctx.bumpRevision({
    table: 'tasks',
    id: t.id,
    expectedRevision: input.expectedRevision,
    at,
    set: completionSet(input.summary, input.artifacts, at),
  });
}

/** Completion is a domain operation: it needs the Claim, the revision and the rules, then releases. */
export function completeWork(ctx: StoreContext, input: CompleteWorkInput): Spec | Task {
  ctx.syncWritable(input.targetType, input.targetId);
  ctx.runImmediate(() => {
    ownedClaim(ctx, input, ctx.now());
    const at = ctx.now();
    if (input.targetType === 'spec') completeSpec(ctx, input, at);
    else completeTask(ctx, input, at);
    ctx.database
      .prepare('DELETE FROM claims WHERE target_type=? AND target_id=?')
      .run(input.targetType, input.targetId);
    recordWorkEvent(ctx, input, 'work.completed', {
      summaryPreview: input.summary.slice(0, 240),
      artifactCount: input.artifacts.length,
    });
  });
  return input.targetType === 'spec' ? getSpec(ctx, input.targetId) : getTask(ctx, input.targetId);
}
