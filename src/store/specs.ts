import { randomUUID } from 'node:crypto';
import {
  evaluateSpecTransition,
  isTerminalProjectState,
  isTerminalSpecState,
  type SpecTransitionFacts,
} from '../domainRules.js';
import { AppError } from '../errors.js';
import type { CreateSpecInput, MarkdownPage, Spec, SpecManifest, SpecState } from '../types.js';
import { specEvent } from './activity.js';
import { cancelDescendants, recordCascade } from './cascade.js';
import { page } from './markdown.js';
import { getProject } from './projects.js';
import {
  mapJoinedClaim,
  parseArtifacts,
  type SpecManifestRow,
  type SpecRow,
  type SpecWithClaimRow,
} from './rows.js';
import { SPEC_MANIFEST_SQL, SPEC_SQL } from './sql.js';
import type { StoreContext } from './storeContext.js';

export interface ListSpecManifestsInput {
  projectId: string;
  state: SpecState | null;
  limit: number;
  offset: number;
}
export interface UpdateSpecInput {
  specId: string;
  title: string | null;
  body: string | null;
  state: Exclude<SpecState, 'done' | 'cancelled'> | null;
  expectedRevision: number;
  actor: string | null;
}
export interface CancelSpecInput {
  specId: string;
  expectedRevision: number;
  reason: string;
  actor: string | null;
}

export function mapSpecRecord(r: SpecRow): Omit<Spec, 'claim'> {
  return {
    id: r.id,
    projectId: r.project_id,
    slug: r.slug,
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

export function mapSpec(r: SpecWithClaimRow): Spec {
  return { ...mapSpecRecord(r), claim: mapJoinedClaim('spec', r.id, r) };
}

export function mapSpecManifest(r: SpecManifestRow): SpecManifest {
  const { body: _body, artifacts, completionSummary, ...base } = mapSpec(r);
  return {
    ...base,
    bodySizeBytes: r.body_size_bytes,
    artifactCount: artifacts.length,
    hasCompletion: completionSummary !== null,
    taskCount: r.task_count,
    openTaskCount: r.open_task_count,
    terminalTaskCount: r.terminal_task_count,
  };
}

export function getSpec(ctx: StoreContext, id: string): Spec {
  return ctx.load<SpecWithClaimRow, Spec>(
    `${SPEC_SQL} WHERE s.id=?`,
    [ctx.now(), id],
    `Spec ${id}`,
    mapSpec,
  );
}

export function getSpecManifest(ctx: StoreContext, id: string): SpecManifest {
  return ctx.load<SpecManifestRow, SpecManifest>(
    `${SPEC_MANIFEST_SQL} WHERE s.id=?`,
    [ctx.now(), id],
    `Spec ${id}`,
    mapSpecManifest,
  );
}

export function readSpecBody(
  ctx: StoreContext,
  id: string,
  offset: number,
  limit: number,
): MarkdownPage {
  return page(getSpec(ctx, id).body, offset, limit);
}

export function createSpec(ctx: StoreContext, input: CreateSpecInput): Spec {
  ctx.syncWritable('project', input.projectId);
  return ctx.conflictOnUnique(
    () =>
      ctx.runImmediate(() => {
        const p = getProject(ctx, input.projectId);
        if (isTerminalProjectState(p.state))
          throw new AppError('invalid_state', 'Specs cannot be added to a terminal Project', 409);
        const id = randomUUID(),
          at = ctx.now();
        ctx.database
          .prepare(
            "INSERT INTO specs (id,project_id,slug,title,body,state,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?)",
          )
          .run(id, p.id, input.slug, input.title, input.body, at, at);
        specEvent(ctx, id, p.id, 'spec.created', input.actor, {
          slug: input.slug,
          title: input.title,
          state: 'draft',
        });
        return getSpec(ctx, id);
      }),
    'Spec slug already exists in this Project',
  );
}

export function listSpecManifests(
  ctx: StoreContext,
  input: ListSpecManifestsInput,
): SpecManifest[] {
  getProject(ctx, input.projectId);
  const args: unknown[] = [ctx.now(), input.projectId];
  const state = input.state === null ? '' : (args.push(input.state), 'AND s.state=?');
  return ctx
    .rows<SpecManifestRow>(
      `${SPEC_MANIFEST_SQL} WHERE s.project_id=? ${state} ORDER BY s.updated_at DESC,s.rowid DESC LIMIT ? OFFSET ?`,
      [...args, input.limit, input.offset],
    )
    .map(mapSpecManifest);
}

export function countOpenTasks(ctx: StoreContext, specId: string): number {
  return ctx.count("SELECT COUNT(*) count FROM tasks WHERE spec_id=? AND state='open'", specId);
}

export function specFacts(ctx: StoreContext, specId: string, body: string): SpecTransitionFacts {
  const at = ctx.now();
  return {
    body,
    nonTerminalTaskCount: countOpenTasks(ctx, specId),
    activeClaimCount: ctx.count(
      "SELECT COUNT(*) count FROM claims WHERE target_type='spec' AND target_id=? AND expires_at>?",
      specId,
      at,
    ),
    activeDescendantClaimCount: ctx.count(
      "SELECT COUNT(*) count FROM claims c JOIN tasks t ON t.id=c.target_id WHERE c.target_type='task' AND t.spec_id=? AND c.expires_at>?",
      specId,
      at,
    ),
  };
}

export function updateSpec(ctx: StoreContext, input: UpdateSpecInput): Spec {
  if (input.title === null && input.body === null && input.state === null)
    throw new AppError('bad_request', 'Provide a title, body, and/or state to update.', 400);
  ctx.syncWritable('spec', input.specId);
  return ctx.runImmediate(() => {
    const s = getSpec(ctx, input.specId);
    ctx.revision(s.revision, input.expectedRevision);
    if (isTerminalSpecState(s.state) || isTerminalProjectState(getProject(ctx, s.projectId).state))
      throw new AppError('invalid_state', 'Terminal Specs cannot be edited', 409);
    const body = input.body ?? s.body,
      state = input.state ?? s.state;
    ctx.allowed(evaluateSpecTransition(s.state, state, specFacts(ctx, s.id, body)).reason);
    const title = input.title ?? s.title;
    ctx.bumpRevision({
      table: 'specs',
      id: s.id,
      expectedRevision: input.expectedRevision,
      at: ctx.now(),
      set: { title, body, state },
    });
    specEvent(ctx, s.id, s.projectId, 'spec.updated', input.actor, {
      title,
      state,
      bodyChanged: input.body !== null,
    });
    return getSpec(ctx, s.id);
  });
}

export function cancelSpec(ctx: StoreContext, input: CancelSpecInput): Spec {
  ctx.syncWritable('spec', input.specId);
  return ctx.runImmediate(() => {
    const s = getSpec(ctx, input.specId);
    ctx.revision(s.revision, input.expectedRevision);
    ctx.allowed(evaluateSpecTransition(s.state, 'cancelled', specFacts(ctx, s.id, s.body)).reason);
    const at = ctx.now();
    const cancelled = cancelDescendants(ctx, 'spec', s.id, at);
    ctx.bumpRevision({
      table: 'specs',
      id: s.id,
      expectedRevision: input.expectedRevision,
      at,
      set: { state: 'cancelled', cancelled_at: at },
    });
    recordCascade(ctx, cancelled, {
      projectId: s.projectId,
      actor: input.actor,
      cause: 'spec.cancelled',
      reason: input.reason,
    });
    specEvent(ctx, s.id, s.projectId, 'spec.cancelled', input.actor, {
      reason: input.reason,
      cancelledTaskCount: cancelled.tasks.length,
    });
    return getSpec(ctx, s.id);
  });
}
