import { specEvent, taskEvent } from './activity.js';
import type { StoreContext } from './storeContext.js';
import type { RevokedClaimRow } from './rows.js';

/**
 * One cascade cancellation for Projects, Specs and Tasks. Each root differs
 * only in the predicates that select its descendants and their Claims; every
 * predicate binds the root id, the Claim scope binds the clock first.
 */
export type CascadeRoot = 'project' | 'spec' | 'task';

interface CascadeScope {
  /** Predicate over `tasks` selecting the open descendants; binds the root id once. */
  tasks: string;
  /** Predicate over `specs` selecting the non-terminal descendants; null when the root owns no Specs. */
  specs: string | null;
  /** WHERE clause for `activeClaimsWithin`; binds (at, id, id). */
  claims: string;
  /** Deletes every Claim under the root; binds (id, id). */
  deleteClaims: string;
}

const SCOPES: Record<CascadeRoot, CascadeScope> = {
  project: {
    tasks: "state='open' AND spec_id IN (SELECT id FROM specs WHERE project_id=?)",
    specs: "project_id=? AND state IN ('draft','ready')",
    claims: 'WHERE c.expires_at>? AND (cs.project_id=? OR ts.project_id=?)',
    deleteClaims:
      "DELETE FROM claims WHERE (target_type='spec' AND target_id IN (SELECT id FROM specs WHERE project_id=?)) OR (target_type='task' AND target_id IN (SELECT t.id FROM tasks t JOIN specs s ON s.id=t.spec_id WHERE s.project_id=?))",
  },
  spec: {
    tasks: "spec_id=? AND state='open'",
    specs: null,
    claims: 'WHERE c.expires_at>? AND (cs.id=? OR ts.id=?)',
    deleteClaims:
      "DELETE FROM claims WHERE (target_type='spec' AND target_id=?) OR (target_type='task' AND target_id IN (SELECT id FROM tasks WHERE spec_id=?))",
  },
  task: {
    tasks: "parent_id=? AND state='open'",
    specs: null,
    claims: "WHERE c.expires_at>? AND c.target_type='task' AND (ct.id=? OR ct.parent_id=?)",
    deleteClaims:
      "DELETE FROM claims WHERE target_type='task' AND (target_id=? OR target_id IN (SELECT id FROM tasks WHERE parent_id=?))",
  },
};

const CANCEL_SET = "SET state='cancelled',cancelled_at=?,revision=revision+1,updated_at=?";

export interface CancelledDescendants {
  tasks: Array<{ id: string; spec_id: string }>;
  specs: Array<{ id: string }>;
  revoked: RevokedClaimRow[];
}

/**
 * Active Claims under a cancellation scope, resolved to the Spec that owns
 * them. `cs` is the claimed Spec, `ct` the claimed Task and `ts` its Spec.
 */
export function activeClaimsWithin(
  ctx: StoreContext,
  where: string,
  args: unknown[],
): RevokedClaimRow[] {
  return ctx.rows<RevokedClaimRow>(
    `SELECT c.target_type,c.target_id,c.agent_id,COALESCE(cs.id,ts.id) spec_id FROM claims c LEFT JOIN specs cs ON c.target_type='spec' AND cs.id=c.target_id LEFT JOIN tasks ct ON c.target_type='task' AND ct.id=c.target_id LEFT JOIN specs ts ON ts.id=ct.spec_id ${where}`,
    args,
  );
}

/**
 * Deletes the Claims and cancels the open descendants of `root`. The caller
 * cancels the root itself afterwards and then records the cascade, so the
 * activity log keeps revocations before cancellations and the root last.
 */
export function cancelDescendants(
  ctx: StoreContext,
  root: CascadeRoot,
  id: string,
  at: string,
): CancelledDescendants {
  const scope = SCOPES[root];
  const tasks = ctx.rows<{ id: string; spec_id: string }>(
    `SELECT id,spec_id FROM tasks WHERE ${scope.tasks}`,
    [id],
  );
  const specs =
    scope.specs === null
      ? []
      : ctx.rows<{ id: string }>(`SELECT id FROM specs WHERE ${scope.specs}`, [id]);
  const revoked = activeClaimsWithin(ctx, scope.claims, [at, id, id]);
  ctx.database.prepare(scope.deleteClaims).run(id, id);
  ctx.database.prepare(`UPDATE tasks ${CANCEL_SET} WHERE ${scope.tasks}`).run(at, at, id);
  if (scope.specs !== null)
    ctx.database.prepare(`UPDATE specs ${CANCEL_SET} WHERE ${scope.specs}`).run(at, at, id);
  return { tasks, specs, revoked };
}

/** Records `work.revoked` for every deleted Claim, then one cascaded cancellation per descendant. */
export function recordCascade(
  ctx: StoreContext,
  cancelled: CancelledDescendants,
  input: { projectId: string; actor: string | null; cause: string; reason: string },
): void {
  for (const claim of cancelled.revoked)
    specEvent(ctx, claim.spec_id, input.projectId, 'work.revoked', input.actor, {
      targetType: claim.target_type,
      targetId: claim.target_id,
      agentId: claim.agent_id,
      cause: input.cause,
      reason: input.reason,
    });
  const cascaded = { reason: input.reason, cascaded: true };
  for (const t of cancelled.tasks)
    taskEvent(ctx, t.id, t.spec_id, input.projectId, 'task.cancelled', input.actor, cascaded);
  for (const s of cancelled.specs)
    specEvent(ctx, s.id, input.projectId, 'spec.cancelled', input.actor, cascaded);
}
