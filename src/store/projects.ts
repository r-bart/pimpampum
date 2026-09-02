import { randomUUID } from 'node:crypto';
import {
  evaluateProjectTransition,
  isTerminalProjectState,
  type ProjectTransitionFacts,
} from '../domainRules.js';
import { AppError } from '../errors.js';
import type {
  ArtifactReference,
  CreateProjectInput,
  Project,
  ProjectManifest,
  ProjectState,
} from '../types.js';
import { projectEvent } from './activity.js';
import { cancelDescendants, recordCascade } from './cascade.js';
import { parseArtifacts, type ProjectManifestRow, type ProjectRow } from './rows.js';
import { PROJECT_MANIFEST_SQL, completionSet } from './sql.js';
import type { StoreContext } from './storeContext.js';
import { getWorkspace } from './workspaces.js';

export interface ListProjectManifestsInput {
  workspaceId: string | null;
  state: ProjectState | null;
  limit: number;
  offset: number;
}
export interface UpdateProjectInput {
  projectId: string;
  title: string | null;
  state: Exclude<ProjectState, 'done' | 'cancelled'> | null;
  expectedRevision: number;
  actor: string | null;
}
export interface CompleteProjectInput {
  projectId: string;
  expectedRevision: number;
  summary: string;
  artifacts: ArtifactReference[];
  actor: string | null;
}
export interface CancelProjectInput {
  projectId: string;
  expectedRevision: number;
  reason: string;
  actor: string | null;
}

export function mapProject(r: ProjectRow): Project {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    title: r.title,
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

export function mapProjectManifest(r: ProjectManifestRow): ProjectManifest {
  const { artifacts, completionSummary, ...base } = mapProject(r);
  return {
    ...base,
    artifactCount: artifacts.length,
    hasCompletion: completionSummary !== null,
    specCount: r.spec_count,
    draftSpecCount: r.draft_spec_count,
    readySpecCount: r.ready_spec_count,
    terminalSpecCount: r.terminal_spec_count,
  };
}

export function getProject(ctx: StoreContext, id: string): Project {
  return ctx.load<ProjectRow, Project>(
    'SELECT * FROM projects WHERE id=?',
    [id],
    `Project ${id}`,
    mapProject,
  );
}

export function getProjectManifest(ctx: StoreContext, id: string): ProjectManifest {
  return ctx.load<ProjectManifestRow, ProjectManifest>(
    `${PROJECT_MANIFEST_SQL} WHERE p.id=?`,
    [id],
    `Project ${id}`,
    mapProjectManifest,
  );
}

export function createProject(ctx: StoreContext, input: CreateProjectInput): Project {
  ctx.syncWritable('workspace', input.workspaceId);
  return ctx.conflictOnUnique(
    () =>
      ctx.runImmediate(() => {
        getWorkspace(ctx, input.workspaceId);
        const id = randomUUID(),
          at = ctx.now();
        ctx.database
          .prepare(
            "INSERT INTO projects (id,workspace_id,slug,title,state,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)",
          )
          .run(id, input.workspaceId, input.slug, input.title, at, at);
        ctx.writeEvent({
          workspaceId: input.workspaceId,
          projectId: id,
          specId: null,
          targetType: 'project',
          targetId: id,
          eventType: 'project.created',
          actor: input.actor,
          data: { slug: input.slug, title: input.title, state: 'draft' },
        });
        return getProject(ctx, id);
      }),
    'Project slug already exists in this Workspace',
  );
}

export function listProjectManifests(
  ctx: StoreContext,
  input: ListProjectManifestsInput,
): ProjectManifest[] {
  const conditions: string[] = [],
    args: unknown[] = [];
  if (input.workspaceId) {
    conditions.push('p.workspace_id=?');
    args.push(input.workspaceId);
  }
  if (input.state) {
    conditions.push('p.state=?');
    args.push(input.state);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return ctx
    .rows<ProjectManifestRow>(
      `${PROJECT_MANIFEST_SQL} ${where} ORDER BY p.updated_at DESC,p.id LIMIT ? OFFSET ?`,
      [...args, input.limit, input.offset],
    )
    .map(mapProjectManifest);
}

export function projectFacts(ctx: StoreContext, projectId: string): ProjectTransitionFacts {
  const at = ctx.now();
  return {
    specCount: ctx.count('SELECT COUNT(*) count FROM specs WHERE project_id=?', projectId),
    nonTerminalSpecCount: ctx.count(
      "SELECT COUNT(*) count FROM specs WHERE project_id=? AND state IN ('draft','ready')",
      projectId,
    ),
    activeDescendantClaimCount: ctx.count(
      `SELECT COUNT(*) count FROM claims c LEFT JOIN specs cs ON c.target_type='spec' AND cs.id=c.target_id LEFT JOIN tasks ct ON c.target_type='task' AND ct.id=c.target_id LEFT JOIN specs ts ON ts.id=ct.spec_id WHERE c.expires_at>? AND (cs.project_id=? OR ts.project_id=?)`,
      at,
      projectId,
      projectId,
    ),
  };
}

export function updateProject(ctx: StoreContext, input: UpdateProjectInput): Project {
  if (input.title === null && input.state === null)
    throw new AppError('bad_request', 'Provide a title and/or state to update.', 400);
  ctx.syncWritable('project', input.projectId);
  return ctx.runImmediate(() => {
    const current = getProject(ctx, input.projectId);
    ctx.revision(current.revision, input.expectedRevision);
    if (isTerminalProjectState(current.state))
      throw new AppError('invalid_state', 'Terminal Projects cannot be edited', 409);
    const state = input.state ?? current.state;
    ctx.allowed(
      evaluateProjectTransition(current.state, state, projectFacts(ctx, current.id)).reason,
    );
    const title = input.title ?? current.title;
    ctx.bumpRevision({
      table: 'projects',
      id: current.id,
      expectedRevision: input.expectedRevision,
      at: ctx.now(),
      set: { title, state },
    });
    projectEvent(ctx, current.id, 'project.updated', input.actor, { title, state });
    return getProject(ctx, current.id);
  });
}

export function completeProject(ctx: StoreContext, input: CompleteProjectInput): Project {
  ctx.syncWritable('project', input.projectId);
  return ctx.runImmediate(() => {
    const current = getProject(ctx, input.projectId);
    ctx.revision(current.revision, input.expectedRevision);
    ctx.allowed(
      evaluateProjectTransition(current.state, 'done', projectFacts(ctx, current.id)).reason,
    );
    const at = ctx.now();
    ctx.bumpRevision({
      table: 'projects',
      id: current.id,
      expectedRevision: input.expectedRevision,
      at,
      set: completionSet(input.summary, input.artifacts, at),
    });
    projectEvent(ctx, current.id, 'project.completed', input.actor, {
      summaryPreview: input.summary.slice(0, 240),
      artifactCount: input.artifacts.length,
    });
    return getProject(ctx, current.id);
  });
}

export function cancelProject(ctx: StoreContext, input: CancelProjectInput): Project {
  ctx.syncWritable('project', input.projectId);
  return ctx.runImmediate(() => {
    const p = getProject(ctx, input.projectId);
    ctx.revision(p.revision, input.expectedRevision);
    ctx.allowed(evaluateProjectTransition(p.state, 'cancelled', projectFacts(ctx, p.id)).reason);
    const at = ctx.now();
    const cancelled = cancelDescendants(ctx, 'project', p.id, at);
    ctx.bumpRevision({
      table: 'projects',
      id: p.id,
      expectedRevision: input.expectedRevision,
      at,
      set: { state: 'cancelled', cancelled_at: at },
    });
    recordCascade(ctx, cancelled, {
      projectId: p.id,
      actor: input.actor,
      cause: 'project.cancelled',
      reason: input.reason,
    });
    projectEvent(ctx, p.id, 'project.cancelled', input.actor, {
      reason: input.reason,
      cancelledSpecCount: cancelled.specs.length,
      cancelledTaskCount: cancelled.tasks.length,
    });
    return getProject(ctx, p.id);
  });
}
