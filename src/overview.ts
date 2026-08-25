import type {
  OverviewProject,
  OverviewProjectStatus,
  OverviewStatus,
  ProjectState,
} from './types.js';

const statusPrecedence: Record<OverviewProjectStatus, number> = {
  active: 0,
  available: 1,
  draft: 2,
  complete: 3,
};

export function statusForProject(input: {
  lifecycleState: ProjectState;
  activeClaimCount: number;
  availableWorkCount: number;
}): OverviewProjectStatus {
  if (input.activeClaimCount > 0) return 'active';
  if (input.availableWorkCount > 0) return 'available';
  return input.lifecycleState === 'done' ? 'complete' : 'draft';
}

export function statusForOverview(input: {
  projects: number;
  draftProjects: number;
  completedProjects: number;
  activeClaims: number;
  availableWork: number;
}): OverviewStatus {
  if (input.projects === 0) return 'empty';
  if (input.activeClaims > 0) return 'active';
  if (input.availableWork > 0) return 'available';
  if (input.draftProjects > 0) return 'draft';
  return input.completedProjects === input.projects ? 'complete' : 'draft';
}

export function sortOverviewProjects(
  left: Pick<OverviewProject, 'id' | 'status' | 'updatedAt'>,
  right: Pick<OverviewProject, 'id' | 'status' | 'updatedAt'>,
): number {
  return (
    statusPrecedence[left.status] - statusPrecedence[right.status] ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

export function boundOverview<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, limit), truncated: items.length > limit };
}
