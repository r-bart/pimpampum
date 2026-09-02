import type { ArtifactReference, TargetType } from '../types.js';

/** SQL text shared by the aggregates. Every string binds the clock first when it joins Claims. */

export const AVAILABLE_WORK_CTE = `WITH available AS (
  SELECT 'spec' target_type,s.id target_id,p.workspace_id,p.id project_id,p.title project_title,s.id spec_id,s.title spec_title,NULL task_id,NULL task_title,NULL parent_task_id,s.revision,s.updated_at sort_at
  FROM specs s JOIN projects p ON p.id=s.project_id
  WHERE p.state='open' AND s.state='ready'
    AND NOT EXISTS(SELECT 1 FROM tasks WHERE spec_id=s.id AND state='open')
    AND NOT EXISTS(SELECT 1 FROM claims WHERE target_type='spec' AND target_id=s.id AND expires_at>?)
  UNION ALL
  SELECT 'task',t.id,p.workspace_id,p.id,p.title,s.id,s.title,t.id,t.title,t.parent_id,t.revision,t.created_at
  FROM tasks t JOIN specs s ON s.id=t.spec_id JOIN projects p ON p.id=s.project_id
  WHERE p.state='open' AND s.state='ready' AND t.state='open'
    AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id=t.id AND c.state='open')
    AND NOT EXISTS(SELECT 1 FROM claims WHERE target_type='task' AND target_id=t.id AND expires_at>?)
)`;

export const CLAIM_COLUMNS =
  'c.agent_id claim_agent_id,c.expires_at claim_expires_at,c.created_at claim_created_at,c.updated_at claim_updated_at';

export function claimJoinSql(targetType: TargetType, alias: string): string {
  return `LEFT JOIN claims c ON c.target_type='${targetType}' AND c.target_id=${alias}.id AND c.expires_at>?`;
}

export const PROJECT_MANIFEST_SQL = `SELECT p.*,(SELECT COUNT(*) FROM specs WHERE project_id=p.id) spec_count,(SELECT COUNT(*) FROM specs WHERE project_id=p.id AND state='draft') draft_spec_count,(SELECT COUNT(*) FROM specs WHERE project_id=p.id AND state='ready') ready_spec_count,(SELECT COUNT(*) FROM specs WHERE project_id=p.id AND state IN ('done','cancelled')) terminal_spec_count FROM projects p`;

/** Every Spec read joins its active Claim once; the first bound parameter is the clock. */
export const SPEC_SQL = `SELECT s.*,${CLAIM_COLUMNS} FROM specs s ${claimJoinSql('spec', 's')}`;

export const SPEC_MANIFEST_SQL = `SELECT s.*,length(CAST(s.body AS BLOB)) body_size_bytes,(SELECT COUNT(*) FROM tasks WHERE spec_id=s.id) task_count,(SELECT COUNT(*) FROM tasks WHERE spec_id=s.id AND state='open') open_task_count,(SELECT COUNT(*) FROM tasks WHERE spec_id=s.id AND state IN ('done','cancelled')) terminal_task_count,${CLAIM_COLUMNS} FROM specs s ${claimJoinSql('spec', 's')}`;

export const TASK_SQL = `SELECT t.*,${CLAIM_COLUMNS} FROM tasks t ${claimJoinSql('task', 't')}`;

export const TASK_MANIFEST_SQL = `SELECT t.*,length(CAST(COALESCE(t.body,'') AS BLOB)) body_size_bytes,(SELECT COUNT(*) FROM tasks child WHERE child.parent_id=t.id) subtask_count,(SELECT COUNT(*) FROM tasks child WHERE child.parent_id=t.id AND child.state='open') open_subtask_count,${CLAIM_COLUMNS} FROM tasks t ${claimJoinSql('task', 't')}`;

/** The four columns a completion writes; Projects, Specs and Tasks share them. */
export function completionSet(
  summary: string,
  artifacts: ArtifactReference[],
  at: string,
): Record<string, string> {
  return {
    state: 'done',
    completion_summary: summary,
    artifacts_json: JSON.stringify(artifacts),
    completed_at: at,
  };
}

/**
 * `INSERT … ON CONFLICT(id) DO UPDATE` that writes the column list once. Every
 * column except `id` and the `kept` ones is refreshed from the incoming row.
 */
export function upsertSql(
  table: string,
  columns: readonly string[],
  kept: readonly string[] = ['created_at'],
): string {
  const refreshed = columns.filter((column) => column !== 'id' && !kept.includes(column));
  return `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${refreshed.map((column) => `${column}=excluded.${column}`).join(',')}`;
}
