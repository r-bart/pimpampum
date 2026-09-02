import { isRecord } from '../objects.js';
import type {
  ArtifactReference,
  Claim,
  CompletionDetails,
  ProjectState,
  SpecState,
  TargetType,
  TaskState,
} from '../types.js';

/**
 * Row shapes as SQLite returns them, plus the decoders shared by every
 * aggregate. Nothing here touches the database.
 */

export interface WorkspaceRow {
  id: string;
  name: string;
  /** NULL when the Workspace arrived through synchronization and has no local root yet. */
  root_path: string | null;
  created_at: string;
  updated_at: string;
}
export interface ProjectRow {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  state: ProjectState;
  revision: number;
  completion_summary: string | null;
  artifacts_json: string;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ProjectManifestRow extends ProjectRow {
  spec_count: number;
  draft_spec_count: number;
  ready_spec_count: number;
  terminal_spec_count: number;
}
export interface SpecRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  state: SpecState;
  revision: number;
  completion_summary: string | null;
  artifacts_json: string;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}
/** Columns of the active Claim joined onto a Spec or Task row; all NULL when unclaimed. */
export interface ClaimColumns {
  claim_agent_id: string | null;
  claim_expires_at: string | null;
  claim_created_at: string | null;
  claim_updated_at: string | null;
}
export interface SpecWithClaimRow extends SpecRow, ClaimColumns {}
export interface SpecManifestRow extends SpecWithClaimRow {
  body_size_bytes: number;
  task_count: number;
  open_task_count: number;
  terminal_task_count: number;
}
export interface ContextRow {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  name: string;
  body: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface ContextManifestRow extends ContextRow {
  size_bytes: number;
}
export interface TaskRow {
  id: string;
  spec_id: string;
  parent_id: string | null;
  title: string;
  body: string | null;
  state: TaskState;
  revision: number;
  completion_summary: string | null;
  artifacts_json: string;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface TaskWithClaimRow extends TaskRow, ClaimColumns {}
export interface TaskManifestRow extends TaskWithClaimRow {
  body_size_bytes: number;
  subtask_count: number;
  open_subtask_count: number;
}
export interface RevokedClaimRow {
  target_type: TargetType;
  target_id: string;
  agent_id: string;
  spec_id: string;
}
export interface ClaimRow {
  target_type: TargetType;
  target_id: string;
  agent_id: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}
export interface ActivityRow {
  id: number;
  workspace_id: string | null;
  project_id: string | null;
  spec_id: string | null;
  target_type: string;
  target_id: string;
  event_type: string;
  actor: string | null;
  data_json: string;
  created_at: string;
}
export interface WorkRow {
  target_type: TargetType;
  target_id: string;
  workspace_id: string;
  project_id: string;
  project_title: string;
  spec_id: string;
  spec_title: string;
  task_id: string | null;
  task_title: string | null;
  parent_task_id: string | null;
  revision: number;
  sort_at: string;
}

/** Every entity that carries completion metadata exposes this projection. */
export interface Completable {
  completionSummary: string | null;
  artifacts: ArtifactReference[];
  completedAt: string | null;
}

export function parseArtifacts(value: string): ArtifactReference[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? (parsed as ArtifactReference[]) : [];
}

export function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  return isRecord(parsed) ? parsed : {};
}

/** The one completion read for Projects, Specs and Tasks. */
export function completionOf(entity: Completable): CompletionDetails {
  return {
    completionSummary: entity.completionSummary,
    artifacts: entity.artifacts,
    completedAt: entity.completedAt,
  };
}

export function mapClaim(r: ClaimRow): Claim {
  return {
    targetType: r.target_type,
    targetId: r.target_id,
    agentId: r.agent_id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The LEFT JOIN leaves every claim column NULL when the row has no active Claim. */
export function mapJoinedClaim(
  targetType: TargetType,
  targetId: string,
  r: ClaimColumns,
): Claim | null {
  if (r.claim_agent_id === null) return null;
  return {
    targetType,
    targetId,
    agentId: r.claim_agent_id,
    expiresAt: r.claim_expires_at as string,
    createdAt: r.claim_created_at as string,
    updatedAt: r.claim_updated_at as string,
  };
}
