import { UNRESOLVED_WORKSPACE_ROOT_PREFIX } from '../migrations.js';
import {
  boundOverview,
  overviewProjectOrderSql,
  statusForOverview,
  statusForProject,
} from '../overview.js';
import type {
  OverviewActiveWork,
  OverviewCounts,
  OverviewProject,
  OverviewSnapshot,
  OverviewSpec,
  ProjectState,
  SpecState,
  TargetType,
} from '../types.js';
import { AVAILABLE_WORK_CTE } from './sql.js';
import type { StoreContext } from './storeContext.js';

/** Each overview list carries at most this many rows; one more is read to flag truncation. */
const OVERVIEW_PAGE = 500;

interface OverviewProjectRow {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  state: ProjectState;
  updated_at: string;
  workspace_name: string;
  workspace_root_path: string;
  spec_count: number;
  open_task_count: number;
  completed_task_count: number;
  active_claim_count: number;
  available_work_count: number;
  total_available_work: number;
}

interface OverviewActiveWorkRow {
  target_type: TargetType;
  target_id: string;
  workspace_id: string;
  project_id: string;
  project_title: string;
  spec_id: string;
  spec_title: string;
  task_id: string | null;
  task_title: string | null;
  agent_id: string;
  expires_at: string;
}

interface OverviewSpecRow {
  id: string;
  project_id: string;
  project_title: string;
  project_state: ProjectState;
  workspace_id: string;
  workspace_name: string;
  workspace_root_path: string;
  slug: string;
  title: string;
  state: SpecState;
  updated_at: string;
  task_count: number;
  open_task_count: number;
  completed_task_count: number;
  active_claim_count: number;
}

/**
 * A Workspace imported without a local root reads as the v2 placeholder path
 * here rather than `''`: the macOS and Omarchy overview validators reject a
 * portfolio row whose Workspace root is empty or relative.
 */
const WORKSPACE_ROOT_SQL = `COALESCE(w.root_path,?||w.id) workspace_root_path`;

/** Binds (at, at, at, at, root placeholder). Rows arrive in overview order; the LIMIT depends on it. */
const PROJECTS_SQL = `${AVAILABLE_WORK_CTE},
available_counts AS (
  SELECT project_id,COUNT(*) available_work_count FROM available GROUP BY project_id
),
active_counts AS (
  SELECT project_id,COUNT(*) active_claim_count FROM (
    SELECT s.project_id FROM claims c JOIN specs s ON c.target_type='spec' AND s.id=c.target_id WHERE c.expires_at>?
    UNION ALL
    SELECT s.project_id FROM claims c JOIN tasks t ON c.target_type='task' AND t.id=c.target_id JOIN specs s ON s.id=t.spec_id WHERE c.expires_at>?
  ) GROUP BY project_id
)
SELECT p.id,p.workspace_id,p.slug,p.title,p.state,p.updated_at,
       w.name workspace_name,${WORKSPACE_ROOT_SQL},
       (SELECT COUNT(*) FROM specs WHERE project_id=p.id) spec_count,
       (SELECT COUNT(*) FROM tasks t JOIN specs s ON s.id=t.spec_id
        WHERE s.project_id=p.id AND t.state='open') open_task_count,
       (SELECT COUNT(*) FROM tasks t JOIN specs s ON s.id=t.spec_id
        WHERE s.project_id=p.id AND t.state='done') completed_task_count,
       COALESCE(active_counts.active_claim_count,0) active_claim_count,
       COALESCE(available_counts.available_work_count,0) available_work_count,
       COALESCE(SUM(COALESCE(available_counts.available_work_count,0)) OVER (),0) total_available_work
FROM projects p
JOIN workspaces w ON w.id=p.workspace_id
LEFT JOIN available_counts ON available_counts.project_id=p.id
LEFT JOIN active_counts ON active_counts.project_id=p.id
ORDER BY ${overviewProjectOrderSql({
  activeClaimCount: 'COALESCE(active_counts.active_claim_count,0)',
  availableWorkCount: 'COALESCE(available_counts.available_work_count,0)',
  state: 'p.state',
  updatedAt: 'p.updated_at',
  id: 'p.id',
})}
LIMIT ${OVERVIEW_PAGE + 1}`;

/** Binds (at). */
const ACTIVE_WORK_SQL = `SELECT c.target_type,c.target_id,p.workspace_id,p.id project_id,p.title project_title,s.id spec_id,s.title spec_title,t.id task_id,t.title task_title,c.agent_id,c.expires_at FROM claims c LEFT JOIN tasks t ON c.target_type='task' AND t.id=c.target_id JOIN specs s ON (c.target_type='spec' AND s.id=c.target_id) OR (c.target_type='task' AND s.id=t.spec_id) JOIN projects p ON p.id=s.project_id WHERE c.expires_at>? ORDER BY c.updated_at DESC,c.target_id LIMIT ${OVERVIEW_PAGE + 1}`;

/** Binds (root placeholder, at). */
const SPECS_SQL = `SELECT s.id,s.project_id,p.title project_title,p.state project_state,p.workspace_id,w.name workspace_name,
       ${WORKSPACE_ROOT_SQL},s.slug,s.title,s.state,s.updated_at,
       (SELECT COUNT(*) FROM tasks t WHERE t.spec_id=s.id) task_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.spec_id=s.id AND t.state='open') open_task_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.spec_id=s.id AND t.state='done') completed_task_count,
       (SELECT COUNT(*) FROM claims c
        LEFT JOIN tasks t ON c.target_type='task' AND t.id=c.target_id
        WHERE c.expires_at>? AND ((c.target_type='spec' AND c.target_id=s.id)
          OR (c.target_type='task' AND t.spec_id=s.id))) active_claim_count
FROM specs s
JOIN projects p ON p.id=s.project_id
JOIN workspaces w ON w.id=p.workspace_id
ORDER BY CASE s.state WHEN 'ready' THEN 0 WHEN 'done' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
         s.updated_at DESC,s.id
LIMIT ${OVERVIEW_PAGE + 1}`;

function mapOverviewProject(r: OverviewProjectRow): OverviewProject {
  return {
    id: r.id,
    workspace: { id: r.workspace_id, name: r.workspace_name, rootPath: r.workspace_root_path },
    slug: r.slug,
    title: r.title,
    lifecycleState: r.state,
    status: statusForProject({
      lifecycleState: r.state,
      activeClaimCount: r.active_claim_count,
      availableWorkCount: r.available_work_count,
    }),
    specCount: r.spec_count,
    openTaskCount: r.open_task_count,
    completedTaskCount: r.completed_task_count,
    activeClaimCount: r.active_claim_count,
    availableWorkCount: r.available_work_count,
    updatedAt: r.updated_at,
  };
}

function mapOverviewActiveWork(r: OverviewActiveWorkRow): OverviewActiveWork {
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
    agentId: r.agent_id,
    expiresAt: r.expires_at,
  };
}

function mapOverviewSpec(r: OverviewSpecRow): OverviewSpec {
  return {
    id: r.id,
    projectId: r.project_id,
    projectTitle: r.project_title,
    projectLifecycleState: r.project_state,
    workspace: { id: r.workspace_id, name: r.workspace_name, rootPath: r.workspace_root_path },
    slug: r.slug,
    title: r.title,
    lifecycleState: r.state,
    taskCount: r.task_count,
    openTaskCount: r.open_task_count,
    completedTaskCount: r.completed_task_count,
    activeClaimCount: r.active_claim_count,
    updatedAt: r.updated_at,
  };
}

function overviewCounts(ctx: StoreContext, at: string, availableWork: number): OverviewCounts {
  const projectsIn = (state: ProjectState): number =>
    ctx.count('SELECT COUNT(*) count FROM projects WHERE state=?', state);
  const tasksIn = (state: string): number =>
    ctx.count('SELECT COUNT(*) count FROM tasks WHERE state=?', state);
  return {
    workspaces: ctx.count('SELECT COUNT(*) count FROM workspaces'),
    projects: ctx.count('SELECT COUNT(*) count FROM projects'),
    specs: ctx.count('SELECT COUNT(*) count FROM specs'),
    draftProjects: projectsIn('draft'),
    openProjects: projectsIn('open'),
    pausedProjects: projectsIn('paused'),
    completedProjects: projectsIn('done'),
    cancelledProjects: projectsIn('cancelled'),
    openTasks: tasksIn('open'),
    completedTasks: tasksIn('done'),
    cancelledTasks: tasksIn('cancelled'),
    activeClaims: ctx.count('SELECT COUNT(*) count FROM claims WHERE expires_at>?', at),
    availableWork,
  };
}

/** The bounded portfolio snapshot the desktop surfaces poll; one clock read, one read transaction. */
export function getOverview(ctx: StoreContext): OverviewSnapshot {
  return ctx.read(() => {
    const at = ctx.now();
    const projectRows = ctx.rows<OverviewProjectRow>(PROJECTS_SQL, [
      at,
      at,
      at,
      at,
      UNRESOLVED_WORKSPACE_ROOT_PREFIX,
    ]);
    const counts = overviewCounts(ctx, at, projectRows[0]?.total_available_work ?? 0);
    const projects = boundOverview(projectRows.map(mapOverviewProject), OVERVIEW_PAGE);
    const activeWork = boundOverview(
      ctx.rows<OverviewActiveWorkRow>(ACTIVE_WORK_SQL, [at]).map(mapOverviewActiveWork),
      OVERVIEW_PAGE,
    );
    const specs = boundOverview(
      ctx
        .rows<OverviewSpecRow>(SPECS_SQL, [UNRESOLVED_WORKSPACE_ROOT_PREFIX, at])
        .map(mapOverviewSpec),
      OVERVIEW_PAGE,
    );
    return {
      status: statusForOverview(counts),
      counts,
      projects: projects.items,
      projectsTruncated: projects.truncated,
      specs: specs.items,
      specsTruncated: specs.truncated,
      activeWork: activeWork.items,
      activeWorkTruncated: activeWork.truncated,
    };
  });
}
