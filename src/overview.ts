import type { OverviewProjectStatus, OverviewStatus, ProjectState } from './types.js';

/**
 * The one ordering rule for overview Projects. `statusForProject` derives the
 * status of a row and `overviewProjectOrderSql` renders the same precedence as
 * SQL, so the store can bound the result set inside the query instead of
 * sorting twice.
 */
export const statusPrecedence: Record<OverviewProjectStatus, number> = {
  active: 0,
  available: 1,
  draft: 2,
  paused: 3,
  complete: 4,
};

export function statusForProject(input: {
  lifecycleState: ProjectState;
  activeClaimCount: number;
  availableWorkCount: number;
}): OverviewProjectStatus {
  if (input.activeClaimCount > 0) return 'active';
  if (input.availableWorkCount > 0) return 'available';
  if (input.lifecycleState === 'paused') return 'paused';
  return input.lifecycleState === 'done' || input.lifecycleState === 'cancelled'
    ? 'complete'
    : 'draft';
}

/**
 * SQL `ORDER BY` terms that rank rows exactly like `statusForProject` followed
 * by recency and the stable id. Every column expression is caller-supplied so
 * the store can point it at its own aliases.
 */
export function overviewProjectOrderSql(columns: {
  activeClaimCount: string;
  availableWorkCount: string;
  state: string;
  updatedAt: string;
  id: string;
}): string {
  return [
    `CASE WHEN ${columns.activeClaimCount}>0 THEN ${statusPrecedence.active}`,
    `WHEN ${columns.availableWorkCount}>0 THEN ${statusPrecedence.available}`,
    `WHEN ${columns.state}='paused' THEN ${statusPrecedence.paused}`,
    `WHEN ${columns.state} IN ('done','cancelled') THEN ${statusPrecedence.complete}`,
    `ELSE ${statusPrecedence.draft} END`,
    `,${columns.updatedAt} DESC,${columns.id}`,
  ].join(' ');
}

export function statusForOverview(input: {
  projects: number;
  draftProjects: number;
  openProjects: number;
  pausedProjects: number;
  completedProjects: number;
  cancelledProjects: number;
  activeClaims: number;
  availableWork: number;
}): OverviewStatus {
  if (input.projects === 0) return 'empty';
  if (input.activeClaims > 0) return 'active';
  if (input.availableWork > 0) return 'available';
  if (input.draftProjects > 0 || input.openProjects > 0) return 'draft';
  if (input.pausedProjects > 0) return 'paused';
  return input.completedProjects + input.cancelledProjects === input.projects
    ? 'complete'
    : 'draft';
}

export function boundOverview<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, limit), truncated: items.length > limit };
}
