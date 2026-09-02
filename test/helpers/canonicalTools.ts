/**
 * The canonical MCP tool catalog the daemon registers. `test/mcp.test.ts` asserts the live
 * `tools/list` equals this list; every other test that names a tool validates the name against it,
 * so a tool removed from the product cannot survive behind a mock that echoes any name.
 */
export const canonicalTools = [
  'workspace_list',
  'workspace_resolve',
  'project_list',
  'project_get',
  'project_create',
  'project_update',
  'project_complete',
  'project_cancel',
  'project_completion_get',
  'spec_list',
  'spec_get',
  'spec_read',
  'spec_create',
  'spec_update',
  'spec_completion_get',
  'spec_cancel',
  'task_list',
  'task_get',
  'task_read',
  'task_create',
  'task_update',
  'task_completion_get',
  'task_cancel',
  'context_list',
  'context_read',
  'context_put',
  'activity_list',
  'work_list',
  'work_start',
  'work_renew',
  'work_release',
  'work_complete',
] as const;

export type CanonicalTool = (typeof canonicalTools)[number];

export function isCanonicalTool(name: string): name is CanonicalTool {
  return (canonicalTools as readonly string[]).includes(name);
}
