import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { backupDatabase, backupLatestDatabase, exportPortable } from './backup.js';
import {
  evaluateClaimEligibility,
  evaluateProjectTransition,
  evaluateSpecTransition,
  evaluateTaskTransition,
  isTerminalProjectState,
  isTerminalSpecState,
  isTerminalTaskState,
} from './domainRules.js';
import { AppError } from './errors.js';
import type { SyncEntityKind, SyncState } from './syncContract.js';
import { activityFingerprint, normalizedSyncState } from './syncState.js';
import {
  boundOverview,
  sortOverviewProjects,
  statusForOverview,
  statusForProject,
} from './overview.js';
import type {
  ActivityEvent,
  ArtifactReference,
  Claim,
  CompleteWorkInput,
  CompletionDetails,
  ContextDocument,
  ContextManifest,
  ContextManifestPage,
  ContextOwnerType,
  CreateProjectInput,
  CreateSpecInput,
  CreateTaskInput,
  MarkdownPage,
  OverviewActiveWork,
  OverviewCounts,
  OverviewProject,
  OverviewSnapshot,
  OverviewSpec,
  Project,
  ProjectManifest,
  ProjectState,
  Spec,
  SpecManifest,
  SpecState,
  TargetType,
  Task,
  TaskManifest,
  TaskState,
  WorkBundle,
  WorkItem,
  Workspace,
} from './types.js';

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
}
interface ProjectRow {
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
interface ProjectManifestRow extends ProjectRow {
  spec_count: number;
  draft_spec_count: number;
  ready_spec_count: number;
  terminal_spec_count: number;
}
interface SpecRow {
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
interface SpecManifestRow extends SpecRow {
  body_size_bytes: number;
  task_count: number;
  open_task_count: number;
  terminal_task_count: number;
}
interface ContextRow {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  name: string;
  body: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
interface ContextManifestRow extends ContextRow {
  size_bytes: number;
}
interface TaskRow {
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
interface TaskManifestRow extends TaskRow {
  body_size_bytes: number;
  subtask_count: number;
  open_subtask_count: number;
}
interface ClaimRow {
  target_type: TargetType;
  target_id: string;
  agent_id: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}
interface ActivityRow {
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
interface CountRow {
  count: number;
}
interface WorkRow {
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

const AVAILABLE_WORK_CTE = `WITH available AS (
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

const now = (): string => new Date().toISOString();
function requireRow<T>(row: T | null | undefined, message: string): T {
  if (row == null) throw new AppError('not_found', message, 404);
  return row;
}
function parseArtifacts(value: string): ArtifactReference[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? (parsed as ArtifactReference[]) : [];
}
function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
function page(body: string, offsetCodeUnits: number, limitCodeUnits: number): MarkdownPage {
  return {
    body: body.slice(offsetCodeUnits, offsetCodeUnits + limitCodeUnits),
    offsetCodeUnits,
    totalCodeUnits: body.length,
    sizeBytes: Buffer.byteLength(body, 'utf8'),
    hasMore: offsetCodeUnits + limitCodeUnits < body.length,
  };
}
function ownerColumn(type: ContextOwnerType): 'workspace_id' | 'project_id' {
  return type === 'workspace' ? 'workspace_id' : 'project_id';
}

export class PimpampumStore {
  constructor(
    private readonly database: Database.Database,
    private readonly onMutation: () => void = () => undefined,
    private syncConflictGuard: (entityType: SyncEntityKind, entityId: string) => boolean = () =>
      false,
  ) {}
  setSyncConflictGuard(guard: (entityType: SyncEntityKind, entityId: string) => boolean): void {
    this.syncConflictGuard = guard;
  }
  close(): void {
    this.database.close();
  }

  registerWorkspace(input: {
    id: string;
    name: string;
    rootPath: string;
    actor: string | null;
  }): Workspace {
    this.syncWritable('workspace', input.id);
    if (!isAbsolute(input.rootPath))
      throw new AppError('bad_request', 'Workspace root must be an absolute path', 400);
    let rootPath: string;
    try {
      rootPath = realpathSync(input.rootPath);
    } catch {
      throw new AppError('bad_request', 'Workspace root does not exist', 400);
    }
    if (!statSync(rootPath).isDirectory())
      throw new AppError('bad_request', 'Workspace root must be a directory', 400);
    const existing = this.database.prepare('SELECT * FROM workspaces WHERE id=?').get(input.id) as
      WorkspaceRow | undefined;
    if (existing?.root_path.startsWith('/__pimpampum_unresolved__/')) {
      return this.runImmediate(() => {
        this.database
          .prepare('UPDATE workspaces SET name=?,root_path=?,updated_at=? WHERE id=?')
          .run(input.name, rootPath, now(), input.id);
        return this.getWorkspace(input.id);
      });
    }
    try {
      return this.runImmediate(() => {
        const at = now();
        this.database
          .prepare(
            'INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)',
          )
          .run(input.id, input.name, rootPath, at, at);
        this.event(input.id, null, null, 'workspace', input.id, 'workspace.created', input.actor, {
          name: input.name,
          rootPath,
        });
        return this.getWorkspace(input.id);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed'))
        throw new AppError('conflict', 'Workspace id or root path already exists', 409);
      throw error;
    }
  }
  listWorkspaces(): Workspace[] {
    return (
      this.database.prepare('SELECT * FROM workspaces ORDER BY name,id').all() as WorkspaceRow[]
    ).map((r) => this.mapWorkspace(r));
  }
  getWorkspace(id: string): Workspace {
    return this.mapWorkspace(
      requireRow(
        this.database.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as
          WorkspaceRow | undefined,
        `Workspace ${id} was not found`,
      ),
    );
  }
  resolveWorkspace(inputPath: string): Workspace {
    if (!isAbsolute(inputPath))
      throw new AppError('bad_request', 'Workspace path must be absolute', 400);
    let resolved: string;
    try {
      resolved = realpathSync(inputPath);
    } catch {
      throw new AppError('not_found', 'Workspace path does not exist', 404);
    }
    const match = this.listWorkspaces()
      .filter((w) => {
        const child = relative(w.rootPath, resolved);
        return child === '' || (!child.startsWith('..') && !isAbsolute(child));
      })
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    if (!match)
      throw new AppError('not_found', `No registered workspace contains ${resolved}`, 404);
    return match;
  }

  createProject(input: CreateProjectInput): Project {
    this.syncWritable('workspace', input.workspaceId);
    try {
      return this.runImmediate(() => {
        this.getWorkspace(input.workspaceId);
        const id = randomUUID(),
          at = now();
        this.database
          .prepare(
            "INSERT INTO projects (id,workspace_id,slug,title,state,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)",
          )
          .run(id, input.workspaceId, input.slug, input.title, at, at);
        this.event(input.workspaceId, id, null, 'project', id, 'project.created', input.actor, {
          slug: input.slug,
          title: input.title,
          state: 'draft',
        });
        return this.getProject(id);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed'))
        throw new AppError('conflict', 'Project slug already exists in this Workspace', 409);
      throw error;
    }
  }
  listProjects(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): Project[] {
    const f = this.projectFilter(input.workspaceId, input.state);
    return (
      this.database
        .prepare(`SELECT * FROM projects ${f.sql} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
        .all(...f.args, input.limit, input.offset) as ProjectRow[]
    ).map((r) => this.mapProject(r));
  }
  listProjectManifests(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): ProjectManifest[] {
    const f = this.projectFilter(input.workspaceId, input.state, 'p.');
    return (
      this.database
        .prepare(
          `${this.projectManifestSql()} ${f.sql} ORDER BY p.updated_at DESC,p.id LIMIT ? OFFSET ?`,
        )
        .all(...f.args, input.limit, input.offset) as ProjectManifestRow[]
    ).map((r) => this.mapProjectManifest(r));
  }
  getProject(id: string): Project {
    return this.mapProject(
      requireRow(
        this.database.prepare('SELECT * FROM projects WHERE id=?').get(id) as
          ProjectRow | undefined,
        `Project ${id} was not found`,
      ),
    );
  }
  getProjectManifest(id: string): ProjectManifest {
    return this.mapProjectManifest(
      requireRow(
        this.database.prepare(`${this.projectManifestSql()} WHERE p.id=?`).get(id) as
          ProjectManifestRow | undefined,
        `Project ${id} was not found`,
      ),
    );
  }
  getProjectCompletion(id: string): CompletionDetails {
    const p = this.getProject(id);
    return {
      completionSummary: p.completionSummary,
      artifacts: p.artifacts,
      completedAt: p.completedAt,
    };
  }
  updateProject(input: {
    projectId: string;
    title: string | null;
    state: Exclude<ProjectState, 'done' | 'cancelled'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Project {
    this.syncWritable('project', input.projectId);
    return this.runImmediate(() => {
      const current = this.getProject(input.projectId);
      this.revision(current.revision, input.expectedRevision);
      if (isTerminalProjectState(current.state))
        throw new AppError('invalid_state', 'Terminal Projects cannot be edited', 409);
      const state = input.state ?? current.state;
      this.allowed(
        evaluateProjectTransition(current.state, state, this.projectFacts(current.id)).reason,
      );
      const title = input.title ?? current.title;
      const result = this.database
        .prepare(
          'UPDATE projects SET title=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
        )
        .run(title, state, now(), current.id, input.expectedRevision);
      this.changed(result.changes, current.revision);
      this.projectEvent(current.id, 'project.updated', input.actor, { title, state });
      return this.getProject(current.id);
    });
  }
  completeProject(input: {
    projectId: string;
    expectedRevision: number;
    summary: string;
    artifacts: ArtifactReference[];
    actor: string | null;
  }): Project {
    this.syncWritable('project', input.projectId);
    return this.runImmediate(() => {
      const current = this.getProject(input.projectId);
      this.revision(current.revision, input.expectedRevision);
      this.allowed(
        evaluateProjectTransition(current.state, 'done', this.projectFacts(current.id)).reason,
      );
      const at = now();
      const result = this.database
        .prepare(
          "UPDATE projects SET state='done',completion_summary=?,artifacts_json=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(
          input.summary,
          JSON.stringify(input.artifacts),
          at,
          at,
          current.id,
          input.expectedRevision,
        );
      this.changed(result.changes, current.revision);
      this.projectEvent(current.id, 'project.completed', input.actor, {
        summaryPreview: input.summary.slice(0, 240),
        artifactCount: input.artifacts.length,
      });
      return this.getProject(current.id);
    });
  }
  cancelProject(input: {
    projectId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Project {
    this.syncWritable('project', input.projectId);
    return this.runImmediate(() => {
      const p = this.getProject(input.projectId);
      this.revision(p.revision, input.expectedRevision);
      this.allowed(evaluateProjectTransition(p.state, 'cancelled', this.projectFacts(p.id)).reason);
      const at = now();
      const tasks = this.database
        .prepare(
          "SELECT t.id,t.spec_id FROM tasks t JOIN specs s ON s.id=t.spec_id WHERE s.project_id=? AND t.state='open'",
        )
        .all(p.id) as Array<{ id: string; spec_id: string }>;
      const specs = this.database
        .prepare("SELECT id FROM specs WHERE project_id=? AND state IN ('draft','ready')")
        .all(p.id) as Array<{ id: string }>;
      this.database
        .prepare(
          "DELETE FROM claims WHERE (target_type='spec' AND target_id IN (SELECT id FROM specs WHERE project_id=?)) OR (target_type='task' AND target_id IN (SELECT t.id FROM tasks t JOIN specs s ON s.id=t.spec_id WHERE s.project_id=?))",
        )
        .run(p.id, p.id);
      this.database
        .prepare(
          "UPDATE tasks SET state='cancelled',cancelled_at=?,revision=revision+1,updated_at=? WHERE state='open' AND spec_id IN (SELECT id FROM specs WHERE project_id=?)",
        )
        .run(at, at, p.id);
      this.database
        .prepare(
          "UPDATE specs SET state='cancelled',cancelled_at=?,revision=revision+1,updated_at=? WHERE project_id=? AND state IN ('draft','ready')",
        )
        .run(at, at, p.id);
      this.database
        .prepare(
          "UPDATE projects SET state='cancelled',cancelled_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(at, at, p.id, input.expectedRevision);
      for (const t of tasks)
        this.taskEvent(t.id, t.spec_id, p.id, 'task.cancelled', input.actor, {
          reason: input.reason,
          cascaded: true,
        });
      for (const s of specs)
        this.specEvent(s.id, p.id, 'spec.cancelled', input.actor, {
          reason: input.reason,
          cascaded: true,
        });
      this.projectEvent(p.id, 'project.cancelled', input.actor, {
        reason: input.reason,
        cancelledSpecCount: specs.length,
        cancelledTaskCount: tasks.length,
      });
      return this.getProject(p.id);
    });
  }

  createSpec(input: CreateSpecInput): Spec {
    this.syncWritable('project', input.projectId);
    try {
      return this.runImmediate(() => {
        const p = this.getProject(input.projectId);
        if (isTerminalProjectState(p.state))
          throw new AppError('invalid_state', 'Specs cannot be added to a terminal Project', 409);
        const id = randomUUID(),
          at = now();
        this.database
          .prepare(
            "INSERT INTO specs (id,project_id,slug,title,body,state,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?)",
          )
          .run(id, p.id, input.slug, input.title, input.body, at, at);
        this.specEvent(id, p.id, 'spec.created', input.actor, {
          slug: input.slug,
          title: input.title,
          state: 'draft',
        });
        return this.getSpec(id);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed'))
        throw new AppError('conflict', 'Spec slug already exists in this Project', 409);
      throw error;
    }
  }
  listSpecs(projectId: string): Spec[] {
    this.getProject(projectId);
    return (
      this.database
        .prepare('SELECT * FROM specs WHERE project_id=? ORDER BY updated_at DESC,rowid DESC')
        .all(projectId) as SpecRow[]
    ).map((r) => this.mapSpec(r));
  }
  listSpecManifests(input: {
    projectId: string;
    state: SpecState | null;
    limit: number;
    offset: number;
  }): SpecManifest[] {
    this.getProject(input.projectId);
    const args: unknown[] = [input.projectId];
    const state = input.state === null ? '' : (args.push(input.state), 'AND s.state=?');
    return (
      this.database
        .prepare(
          `${this.specManifestSql()} WHERE s.project_id=? ${state} ORDER BY s.updated_at DESC,s.rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, input.limit, input.offset) as SpecManifestRow[]
    ).map((r) => this.mapSpecManifest(r));
  }
  getSpec(id: string): Spec {
    return this.mapSpec(
      requireRow(
        this.database.prepare('SELECT * FROM specs WHERE id=?').get(id) as SpecRow | undefined,
        `Spec ${id} was not found`,
      ),
    );
  }
  getSpecManifest(id: string): SpecManifest {
    return this.mapSpecManifest(
      requireRow(
        this.database.prepare(`${this.specManifestSql()} WHERE s.id=?`).get(id) as
          SpecManifestRow | undefined,
        `Spec ${id} was not found`,
      ),
    );
  }
  readSpecBody(id: string, offset: number, limit: number): MarkdownPage {
    return page(this.getSpec(id).body, offset, limit);
  }
  getSpecCompletion(id: string): CompletionDetails {
    const s = this.getSpec(id);
    return {
      completionSummary: s.completionSummary,
      artifacts: s.artifacts,
      completedAt: s.completedAt,
    };
  }
  updateSpec(input: {
    specId: string;
    title: string | null;
    body: string | null;
    state: Exclude<SpecState, 'done' | 'cancelled'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Spec {
    this.syncWritable('spec', input.specId);
    return this.runImmediate(() => {
      const s = this.getSpec(input.specId);
      this.revision(s.revision, input.expectedRevision);
      if (
        isTerminalSpecState(s.state) ||
        isTerminalProjectState(this.getProject(s.projectId).state)
      )
        throw new AppError('invalid_state', 'Terminal Specs cannot be edited', 409);
      const body = input.body ?? s.body,
        state = input.state ?? s.state;
      this.allowed(evaluateSpecTransition(s.state, state, this.specFacts(s.id, body)).reason);
      const title = input.title ?? s.title;
      const result = this.database
        .prepare(
          'UPDATE specs SET title=?,body=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
        )
        .run(title, body, state, now(), s.id, input.expectedRevision);
      this.changed(result.changes, s.revision);
      this.specEvent(s.id, s.projectId, 'spec.updated', input.actor, {
        title,
        state,
        bodyChanged: input.body !== null,
      });
      return this.getSpec(s.id);
    });
  }
  cancelSpec(input: {
    specId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Spec {
    this.syncWritable('spec', input.specId);
    return this.runImmediate(() => {
      const s = this.getSpec(input.specId);
      this.revision(s.revision, input.expectedRevision);
      this.allowed(
        evaluateSpecTransition(s.state, 'cancelled', this.specFacts(s.id, s.body)).reason,
      );
      const at = now();
      const tasks = this.database
        .prepare("SELECT id FROM tasks WHERE spec_id=? AND state='open'")
        .all(s.id) as Array<{ id: string }>;
      this.database
        .prepare(
          "DELETE FROM claims WHERE (target_type='spec' AND target_id=?) OR (target_type='task' AND target_id IN (SELECT id FROM tasks WHERE spec_id=?))",
        )
        .run(s.id, s.id);
      this.database
        .prepare(
          "UPDATE tasks SET state='cancelled',cancelled_at=?,revision=revision+1,updated_at=? WHERE spec_id=? AND state='open'",
        )
        .run(at, at, s.id);
      const result = this.database
        .prepare(
          "UPDATE specs SET state='cancelled',cancelled_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(at, at, s.id, input.expectedRevision);
      this.changed(result.changes, s.revision);
      for (const t of tasks)
        this.taskEvent(t.id, s.id, s.projectId, 'task.cancelled', input.actor, {
          reason: input.reason,
          cascaded: true,
        });
      this.specEvent(s.id, s.projectId, 'spec.cancelled', input.actor, {
        reason: input.reason,
        cancelledTaskCount: tasks.length,
      });
      return this.getSpec(s.id);
    });
  }

  listContext(ownerType: ContextOwnerType, ownerId: string): ContextDocument[] {
    this.assertOwner(ownerType, ownerId);
    return (
      this.database
        .prepare(
          `SELECT * FROM context_documents WHERE ${ownerColumn(ownerType)}=? ORDER BY name,id`,
        )
        .all(ownerId) as ContextRow[]
    ).map((r) => this.mapContext(r));
  }
  listContextManifests(input: {
    ownerType: ContextOwnerType;
    ownerId: string;
    limit: number;
    offset: number;
  }): ContextManifest[] {
    this.assertOwner(input.ownerType, input.ownerId);
    return (
      this.database
        .prepare(
          `SELECT *,length(CAST(body AS BLOB)) AS size_bytes FROM context_documents WHERE ${ownerColumn(input.ownerType)}=? ORDER BY name,id LIMIT ? OFFSET ?`,
        )
        .all(input.ownerId, input.limit, input.offset) as ContextManifestRow[]
    ).map((r) => this.mapContextManifest(r));
  }
  getContextManifest(ownerType: ContextOwnerType, ownerId: string, name: string): ContextManifest {
    this.assertOwner(ownerType, ownerId);
    const ownerColumn = ownerType === 'workspace' ? 'workspace_id' : 'project_id';
    return this.mapContextManifest(
      requireRow(
        this.database
          .prepare(
            `SELECT *,length(CAST(body AS BLOB)) size_bytes FROM context_documents WHERE ${ownerColumn}=? AND name=?`,
          )
          .get(ownerId, name) as ContextManifestRow | undefined,
        `Context document ${name} was not found`,
      ),
    );
  }
  readContext(ownerType: ContextOwnerType, ownerId: string, name: string): ContextDocument {
    this.assertOwner(ownerType, ownerId);
    return this.mapContext(
      requireRow(
        this.database
          .prepare(`SELECT * FROM context_documents WHERE ${ownerColumn(ownerType)}=? AND name=?`)
          .get(ownerId, name) as ContextRow | undefined,
        `Context document ${name} was not found`,
      ),
    );
  }
  readContextPage(
    ownerType: ContextOwnerType,
    ownerId: string,
    name: string,
    offset: number,
    limit: number,
  ): MarkdownPage {
    return page(this.readContext(ownerType, ownerId, name).body, offset, limit);
  }
  putContext(input: {
    ownerType: ContextOwnerType;
    ownerId: string;
    name: string;
    body: string;
    expectedRevision: number | null;
    actor: string | null;
  }): ContextDocument {
    this.syncWritable(input.ownerType, input.ownerId);
    return this.runImmediate(() => {
      this.assertOwnerMutable(input.ownerType, input.ownerId);
      const col = ownerColumn(input.ownerType);
      const existing = this.database
        .prepare(`SELECT * FROM context_documents WHERE ${col}=? AND name=?`)
        .get(input.ownerId, input.name) as ContextRow | undefined;
      if (existing) this.syncWritable('context', existing.id);
      const at = now();
      if (existing) {
        if (input.expectedRevision === null)
          throw new AppError('conflict', 'Context document already exists', 409);
        this.revision(existing.revision, input.expectedRevision);
        const result = this.database
          .prepare(
            'UPDATE context_documents SET body=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
          )
          .run(input.body, at, existing.id, input.expectedRevision);
        this.changed(result.changes, existing.revision);
      } else {
        if (input.expectedRevision !== null)
          throw new AppError('not_found', `Context document ${input.name} was not found`, 404);
        this.database
          .prepare(
            'INSERT INTO context_documents (id,workspace_id,project_id,name,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            input.ownerType === 'workspace' ? input.ownerId : null,
            input.ownerType === 'project' ? input.ownerId : null,
            input.name,
            input.body,
            at,
            at,
          );
      }
      const d = this.readContext(input.ownerType, input.ownerId, input.name);
      if (input.ownerType === 'workspace')
        this.event(input.ownerId, null, null, 'context', d.id, 'context.put', input.actor, {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          name: input.name,
        });
      else
        this.projectEvent(input.ownerId, 'context.put', input.actor, {
          targetId: d.id,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          name: input.name,
        });
      return d;
    });
  }

  createTask(input: CreateTaskInput): Task {
    this.syncWritable('spec', input.specId);
    if (input.parentId) this.syncWritable('task', input.parentId);
    return this.runImmediate(() => {
      const s = this.getSpec(input.specId),
        p = this.getProject(s.projectId);
      if (isTerminalSpecState(s.state) || isTerminalProjectState(p.state))
        throw new AppError('invalid_state', 'Tasks cannot be added to terminal work', 409);
      if (this.getClaim('spec', s.id))
        throw new AppError('conflict', 'Release the Spec claim before creating Tasks', 409);
      if (input.parentId) {
        const parent = this.getTask(input.parentId);
        if (parent.specId !== s.id)
          throw new AppError('bad_request', 'Parent Task belongs to another Spec', 400);
        if (parent.parentId !== null)
          throw new AppError('bad_request', 'Subtasks cannot have children', 400);
        if (isTerminalTaskState(parent.state))
          throw new AppError('invalid_state', 'Subtasks cannot be added to a terminal Task', 409);
        if (this.getClaim('task', parent.id))
          throw new AppError(
            'conflict',
            'Release the parent Task claim before adding Subtasks',
            409,
          );
      }
      const id = randomUUID(),
        at = now();
      this.database
        .prepare(
          "INSERT INTO tasks (id,spec_id,parent_id,title,body,state,created_at,updated_at) VALUES (?,?,?,?,?,'open',?,?)",
        )
        .run(id, s.id, input.parentId, input.title, input.body, at, at);
      this.taskEvent(id, s.id, p.id, 'task.created', input.actor, {
        parentId: input.parentId,
        title: input.title,
      });
      return this.getTask(id);
    });
  }
  listTasks(specId: string): Task[] {
    this.getSpec(specId);
    return (
      this.database
        .prepare(
          'SELECT * FROM tasks WHERE spec_id=? ORDER BY CASE WHEN parent_id IS NULL THEN id ELSE parent_id END,parent_id IS NOT NULL,created_at,id',
        )
        .all(specId) as TaskRow[]
    ).map((r) => this.mapTask(r));
  }
  listTaskManifests(input: { specId: string; limit: number; offset: number }): TaskManifest[] {
    this.getSpec(input.specId);
    return (
      this.database
        .prepare(
          `${this.taskManifestSql()} WHERE t.spec_id=? ORDER BY CASE WHEN t.parent_id IS NULL THEN t.id ELSE t.parent_id END,t.parent_id IS NOT NULL,t.created_at,t.id LIMIT ? OFFSET ?`,
        )
        .all(input.specId, input.limit, input.offset) as TaskManifestRow[]
    ).map((r) => this.mapTaskManifest(r));
  }
  getTask(id: string): Task {
    return this.mapTask(
      requireRow(
        this.database.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined,
        `Task ${id} was not found`,
      ),
    );
  }
  getTaskManifest(id: string): TaskManifest {
    return this.mapTaskManifest(
      requireRow(
        this.database.prepare(`${this.taskManifestSql()} WHERE t.id=?`).get(id) as
          TaskManifestRow | undefined,
        `Task ${id} was not found`,
      ),
    );
  }
  readTaskBody(id: string, offset: number, limit: number): MarkdownPage {
    return page(this.getTask(id).body ?? '', offset, limit);
  }
  getTaskCompletion(id: string): CompletionDetails {
    const t = this.getTask(id);
    return {
      completionSummary: t.completionSummary,
      artifacts: t.artifacts,
      completedAt: t.completedAt,
    };
  }
  updateTask(input: {
    taskId: string;
    title: string | null;
    body: string | null | undefined;
    expectedRevision: number;
    actor: string | null;
  }): Task {
    this.syncWritable('task', input.taskId);
    return this.runImmediate(() => {
      const t = this.getTask(input.taskId);
      this.revision(t.revision, input.expectedRevision);
      const s = this.getSpec(t.specId),
        p = this.getProject(s.projectId);
      if (
        isTerminalTaskState(t.state) ||
        isTerminalSpecState(s.state) ||
        isTerminalProjectState(p.state)
      )
        throw new AppError('invalid_state', 'Terminal Tasks cannot be edited', 409);
      const title = input.title ?? t.title,
        body = input.body === undefined ? t.body : input.body;
      const result = this.database
        .prepare(
          'UPDATE tasks SET title=?,body=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
        )
        .run(title, body, now(), t.id, input.expectedRevision);
      this.changed(result.changes, t.revision);
      this.taskEvent(t.id, s.id, p.id, 'task.updated', input.actor, { title });
      return this.getTask(t.id);
    });
  }
  cancelTask(input: {
    taskId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Task {
    this.syncWritable('task', input.taskId);
    return this.runImmediate(() => {
      const t = this.getTask(input.taskId);
      this.revision(t.revision, input.expectedRevision);
      this.allowed(
        evaluateTaskTransition(t.state, 'cancelled', {
          nonTerminalSubtaskCount: this.countOpenChildren(t.id),
        }).reason,
      );
      const s = this.getSpec(t.specId),
        p = this.getProject(s.projectId),
        at = now();
      const children = this.database
        .prepare("SELECT id FROM tasks WHERE parent_id=? AND state='open'")
        .all(t.id) as Array<{ id: string }>;
      this.database
        .prepare(
          "DELETE FROM claims WHERE target_type='task' AND (target_id=? OR target_id IN (SELECT id FROM tasks WHERE parent_id=?))",
        )
        .run(t.id, t.id);
      this.database
        .prepare(
          "UPDATE tasks SET state='cancelled',cancelled_at=?,revision=revision+1,updated_at=? WHERE parent_id=? AND state='open'",
        )
        .run(at, at, t.id);
      const result = this.database
        .prepare(
          "UPDATE tasks SET state='cancelled',cancelled_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(at, at, t.id, input.expectedRevision);
      this.changed(result.changes, t.revision);
      for (const child of children)
        this.taskEvent(child.id, s.id, p.id, 'task.cancelled', input.actor, {
          reason: input.reason,
          cascaded: true,
        });
      this.taskEvent(t.id, s.id, p.id, 'task.cancelled', input.actor, {
        reason: input.reason,
        cancelledSubtaskCount: children.length,
      });
      return this.getTask(t.id);
    });
  }

  listWork(input: {
    workspaceId: string | null;
    projectId: string | null;
    specId: string | null;
    limit: number;
  }): WorkItem[] {
    this.assertWorkScope(input.workspaceId, input.projectId, input.specId);
    const at = now(),
      filters: string[] = [],
      args: unknown[] = [at, at];
    if (input.workspaceId) {
      filters.push('workspace_id=?');
      args.push(input.workspaceId);
    }
    if (input.projectId) {
      filters.push('project_id=?');
      args.push(input.projectId);
    }
    if (input.specId) {
      filters.push('spec_id=?');
      args.push(input.specId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.database
      .prepare(
        `${AVAILABLE_WORK_CTE} SELECT target_type,target_id,workspace_id,project_id,project_title,spec_id,spec_title,
             task_id,task_title,parent_task_id,revision,sort_at
      FROM available ${where} ORDER BY sort_at,target_id LIMIT ?`,
      )
      .all(...args, input.limit) as WorkRow[];
    return rows.map((r) => ({
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
    }));
  }
  startWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): WorkBundle {
    this.syncWritable(input.targetType, input.targetId);
    const changed = this.database
      .transaction(() => {
        const at = now();
        this.database
          .prepare('DELETE FROM claims WHERE target_type=? AND target_id=? AND expires_at<=?')
          .run(input.targetType, input.targetId, at);
        const existing = this.getClaim(input.targetType, input.targetId, at);
        if (existing?.agentId === input.agentId) return false;
        if (existing) throw new AppError('conflict', 'Work is already claimed', 409, true);
        this.assertTargetAvailable(input.targetType, input.targetId);
        const expiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
        this.database
          .prepare(
            'INSERT INTO claims (target_type,target_id,agent_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)',
          )
          .run(input.targetType, input.targetId, input.agentId, expiresAt, at, at);
        const specId = this.specIdForTarget(input.targetType, input.targetId),
          s = this.getSpec(specId);
        this.specEvent(specId, s.projectId, 'work.started', input.agentId, {
          targetType: input.targetType,
          targetId: input.targetId,
          expiresAt,
        });
        return true;
      })
      .immediate();
    if (changed) this.onMutation();
    return this.workBundle(input.targetType, input.targetId);
  }
  renewWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): Claim {
    this.syncWritable(input.targetType, input.targetId);
    return this.runImmediate(() => {
      const at = now(),
        claim = this.ownedClaim(input.targetType, input.targetId, input.agentId, at),
        expiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
      this.assertTargetAvailable(input.targetType, input.targetId);
      const result = this.database
        .prepare(
          'UPDATE claims SET expires_at=?,updated_at=? WHERE target_type=? AND target_id=? AND agent_id=? AND expires_at>?',
        )
        .run(expiresAt, at, input.targetType, input.targetId, input.agentId, at);
      if (result.changes !== 1)
        throw new AppError('conflict', 'Claim expired or changed before renewal', 409, true);
      const specId = this.specIdForTarget(input.targetType, input.targetId),
        s = this.getSpec(specId);
      this.specEvent(specId, s.projectId, 'work.renewed', input.agentId, {
        targetType: input.targetType,
        targetId: input.targetId,
        previousExpiry: claim.expiresAt,
        expiresAt,
      });
      return requireRow(
        this.getClaim(input.targetType, input.targetId, at),
        'Claim could not be renewed',
      );
    });
  }
  releaseWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    note: string | null;
  }): void {
    this.runImmediate(() => {
      const at = now();
      this.ownedClaim(input.targetType, input.targetId, input.agentId, at);
      const result = this.database
        .prepare(
          'DELETE FROM claims WHERE target_type=? AND target_id=? AND agent_id=? AND expires_at>?',
        )
        .run(input.targetType, input.targetId, input.agentId, at);
      if (result.changes !== 1)
        throw new AppError('conflict', 'Claim expired or changed before release', 409, true);
      const specId = this.specIdForTarget(input.targetType, input.targetId),
        s = this.getSpec(specId);
      this.specEvent(specId, s.projectId, 'work.released', input.agentId, {
        targetType: input.targetType,
        targetId: input.targetId,
        note: input.note,
      });
    });
  }
  completeWork(input: CompleteWorkInput): Spec | Task {
    this.syncWritable(input.targetType, input.targetId);
    this.runImmediate(() => {
      this.ownedClaim(input.targetType, input.targetId, input.agentId, now());
      const at = now();
      if (input.targetType === 'spec') {
        const s = this.getSpec(input.targetId);
        this.revision(s.revision, input.expectedRevision);
        this.allowed(evaluateSpecTransition(s.state, 'done', this.specFacts(s.id, s.body)).reason);
        const result = this.database
          .prepare(
            "UPDATE specs SET state='done',completion_summary=?,artifacts_json=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
          )
          .run(
            input.summary,
            JSON.stringify(input.artifacts),
            at,
            at,
            s.id,
            input.expectedRevision,
          );
        this.changed(result.changes, s.revision);
      } else {
        const t = this.getTask(input.targetId);
        this.revision(t.revision, input.expectedRevision);
        this.allowed(
          evaluateTaskTransition(t.state, 'done', {
            nonTerminalSubtaskCount: this.countOpenChildren(t.id),
          }).reason,
        );
        const result = this.database
          .prepare(
            "UPDATE tasks SET state='done',completion_summary=?,artifacts_json=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
          )
          .run(
            input.summary,
            JSON.stringify(input.artifacts),
            at,
            at,
            t.id,
            input.expectedRevision,
          );
        this.changed(result.changes, t.revision);
      }
      this.database
        .prepare('DELETE FROM claims WHERE target_type=? AND target_id=?')
        .run(input.targetType, input.targetId);
      const specId = this.specIdForTarget(input.targetType, input.targetId),
        s = this.getSpec(specId);
      this.specEvent(specId, s.projectId, 'work.completed', input.agentId, {
        targetType: input.targetType,
        targetId: input.targetId,
        summaryPreview: input.summary.slice(0, 240),
        artifactCount: input.artifacts.length,
      });
    });
    return input.targetType === 'spec'
      ? this.getSpec(input.targetId)
      : this.getTask(input.targetId);
  }

  getOverview(): OverviewSnapshot {
    return this.database.transaction(() => {
      const at = now();
      const rows = this.database
        .prepare(
          `${AVAILABLE_WORK_CTE},
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
                  w.name workspace_name,w.root_path workspace_root_path,
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
           ORDER BY CASE
             WHEN COALESCE(active_counts.active_claim_count,0)>0 THEN 0
             WHEN COALESCE(available_counts.available_work_count,0)>0 THEN 1
             WHEN p.state IN ('draft','open') THEN 2
             WHEN p.state='paused' THEN 3
             ELSE 4
           END,p.updated_at DESC,p.id
           LIMIT 501`,
        )
        .all(at, at, at, at) as Array<
        Pick<ProjectRow, 'id' | 'workspace_id' | 'slug' | 'title' | 'state' | 'updated_at'> & {
          workspace_name: string;
          workspace_root_path: string;
          spec_count: number;
          open_task_count: number;
          completed_task_count: number;
          active_claim_count: number;
          available_work_count: number;
          total_available_work: number;
        }
      >;
      const counts: OverviewCounts = {
        workspaces: this.count('SELECT COUNT(*) count FROM workspaces'),
        projects: this.count('SELECT COUNT(*) count FROM projects'),
        specs: this.count('SELECT COUNT(*) count FROM specs'),
        draftProjects: this.count("SELECT COUNT(*) count FROM projects WHERE state='draft'"),
        openProjects: this.count("SELECT COUNT(*) count FROM projects WHERE state='open'"),
        pausedProjects: this.count("SELECT COUNT(*) count FROM projects WHERE state='paused'"),
        completedProjects: this.count("SELECT COUNT(*) count FROM projects WHERE state='done'"),
        cancelledProjects: this.count(
          "SELECT COUNT(*) count FROM projects WHERE state='cancelled'",
        ),
        openTasks: this.count("SELECT COUNT(*) count FROM tasks WHERE state='open'"),
        completedTasks: this.count("SELECT COUNT(*) count FROM tasks WHERE state='done'"),
        cancelledTasks: this.count("SELECT COUNT(*) count FROM tasks WHERE state='cancelled'"),
        activeClaims: this.count('SELECT COUNT(*) count FROM claims WHERE expires_at>?', at),
        availableWork: rows[0]?.total_available_work ?? 0,
      };
      const projects = rows
        .map<OverviewProject>((r) => {
          const availableWorkCount = r.available_work_count,
            status = statusForProject({
              lifecycleState: r.state,
              activeClaimCount: r.active_claim_count,
              availableWorkCount,
            });
          return {
            id: r.id,
            workspace: {
              id: r.workspace_id,
              name: r.workspace_name,
              rootPath: r.workspace_root_path,
            },
            slug: r.slug,
            title: r.title,
            lifecycleState: r.state,
            status,
            specCount: r.spec_count,
            openTaskCount: r.open_task_count,
            completedTaskCount: r.completed_task_count,
            activeClaimCount: r.active_claim_count,
            availableWorkCount,
            updatedAt: r.updated_at,
          };
        })
        .sort(sortOverviewProjects);
      const activeRows = this.database
        .prepare(
          `SELECT c.target_type,c.target_id,p.workspace_id,p.id project_id,p.title project_title,s.id spec_id,s.title spec_title,t.id task_id,t.title task_title,c.agent_id,c.expires_at FROM claims c LEFT JOIN tasks t ON c.target_type='task' AND t.id=c.target_id JOIN specs s ON (c.target_type='spec' AND s.id=c.target_id) OR (c.target_type='task' AND s.id=t.spec_id) JOIN projects p ON p.id=s.project_id WHERE c.expires_at>? ORDER BY c.updated_at DESC,c.target_id LIMIT 501`,
        )
        .all(at) as Array<{
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
      }>;
      const activeWork = activeRows.map<OverviewActiveWork>((r) => ({
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
      }));
      const specRows = this.database
        .prepare(
          `SELECT s.id,s.project_id,p.title project_title,p.state project_state,p.workspace_id,w.name workspace_name,
                  w.root_path workspace_root_path,s.slug,s.title,s.state,s.updated_at,
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
           LIMIT 501`,
        )
        .all(at) as Array<
        Pick<SpecRow, 'id' | 'project_id' | 'slug' | 'title' | 'state' | 'updated_at'> & {
          project_title: string;
          project_state: ProjectState;
          workspace_id: string;
          workspace_name: string;
          workspace_root_path: string;
          task_count: number;
          open_task_count: number;
          completed_task_count: number;
          active_claim_count: number;
        }
      >;
      const specs = specRows.map<OverviewSpec>((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectTitle: r.project_title,
        projectLifecycleState: r.project_state,
        workspace: {
          id: r.workspace_id,
          name: r.workspace_name,
          rootPath: r.workspace_root_path,
        },
        slug: r.slug,
        title: r.title,
        lifecycleState: r.state,
        taskCount: r.task_count,
        openTaskCount: r.open_task_count,
        completedTaskCount: r.completed_task_count,
        activeClaimCount: r.active_claim_count,
        updatedAt: r.updated_at,
      }));
      const boundedProjects = boundOverview(projects, 500);
      const boundedSpecs = boundOverview(specs, 500);
      const boundedActiveWork = boundOverview(activeWork, 500);
      return {
        status: statusForOverview(counts),
        counts,
        projects: boundedProjects.items,
        projectsTruncated: boundedProjects.truncated,
        specs: boundedSpecs.items,
        specsTruncated: boundedSpecs.truncated,
        activeWork: boundedActiveWork.items,
        activeWorkTruncated: boundedActiveWork.truncated,
      };
    })();
  }
  listActivity(projectId: string, limit: number): ActivityEvent[] {
    this.getProject(projectId);
    return (
      this.database
        .prepare('SELECT * FROM activity_events WHERE project_id=? ORDER BY id DESC LIMIT ?')
        .all(projectId, limit) as ActivityRow[]
    ).map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      projectId: r.project_id,
      specId: r.spec_id,
      targetType: r.target_type,
      targetId: r.target_id,
      eventType: r.event_type,
      actor: r.actor,
      data: parseObject(r.data_json),
      createdAt: r.created_at,
    }));
  }
  async backup(directory: string): Promise<string> {
    if (!isAbsolute(directory))
      throw new AppError('bad_request', 'Backup destination must be an absolute path', 400);
    return backupDatabase(this.database, directory);
  }
  async backupLatest(directory: string): Promise<string> {
    if (!isAbsolute(directory))
      throw new AppError('bad_request', 'Backup destination must be an absolute path', 400);
    return backupLatestDatabase(this.database, directory);
  }
  exportPortable(directory: string): string {
    if (!isAbsolute(directory))
      throw new AppError('bad_request', 'Export destination must be an absolute path', 400);
    if (this.count('SELECT COUNT(*) count FROM claims WHERE expires_at>?', now()) > 0)
      throw new AppError(
        'conflict',
        'Portable export requires a maintenance window with no active Claims',
        409,
        true,
      );
    return exportPortable(this, directory);
  }

  exportSyncState(): SyncState {
    const workspaces = (
      this.database.prepare('SELECT * FROM workspaces ORDER BY id').all() as WorkspaceRow[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const projects = (
      this.database.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[]
    ).map((row) => this.mapProject(row));
    const specs = (this.database.prepare('SELECT * FROM specs ORDER BY id').all() as SpecRow[]).map(
      (row) => {
        const { claim: _claim, ...spec } = this.mapSpec(row);
        return spec;
      },
    );
    const contexts = (
      this.database.prepare('SELECT * FROM context_documents ORDER BY id').all() as ContextRow[]
    ).map((row) => this.mapContext(row));
    const tasks = (this.database.prepare('SELECT * FROM tasks ORDER BY id').all() as TaskRow[]).map(
      (row) => {
        const { claim: _claim, ...task } = this.mapTask(row);
        return task;
      },
    );
    const activity = (
      this.database.prepare('SELECT * FROM activity_events ORDER BY id').all() as ActivityRow[]
    ).map((row) => {
      const eventWithoutFingerprint = {
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        specId: row.spec_id,
        targetType: row.target_type,
        targetId: row.target_id,
        eventType: row.event_type,
        actor: row.actor,
        data: parseObject(row.data_json),
        createdAt: row.created_at,
      };
      return {
        fingerprint: activityFingerprint(eventWithoutFingerprint),
        ...eventWithoutFingerprint,
      };
    });
    return normalizedSyncState({ workspaces, projects, specs, contexts, tasks, activity });
  }

  applySyncState(state: SyncState): void {
    this.validateSyncState(state);
    this.runImmediate(() => {
      this.deleteMissingSyncRows(
        'tasks',
        state.tasks.map((item) => item.id),
      );
      this.deleteMissingSyncRows(
        'context_documents',
        state.contexts.map((item) => item.id),
      );
      this.deleteMissingSyncRows(
        'specs',
        state.specs.map((item) => item.id),
      );
      this.deleteMissingSyncRows(
        'projects',
        state.projects.map((item) => item.id),
      );
      this.deleteMissingSyncRows(
        'workspaces',
        state.workspaces.map((item) => item.id),
      );
      for (const workspace of state.workspaces) {
        const existing = this.database
          .prepare('SELECT root_path FROM workspaces WHERE id=?')
          .get(workspace.id) as { root_path: string } | undefined;
        const rootPath = existing?.root_path ?? `/__pimpampum_unresolved__/${workspace.id}`;
        this.database
          .prepare(
            `INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`,
          )
          .run(workspace.id, workspace.name, rootPath, workspace.createdAt, workspace.updatedAt);
      }
      for (const project of state.projects) {
        this.database
          .prepare(
            `INSERT INTO projects (id,workspace_id,slug,title,state,revision,completion_summary,artifacts_json,completed_at,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,slug=excluded.slug,title=excluded.title,state=excluded.state,revision=excluded.revision,completion_summary=excluded.completion_summary,artifacts_json=excluded.artifacts_json,completed_at=excluded.completed_at,updated_at=excluded.updated_at`,
          )
          .run(
            project.id,
            project.workspaceId,
            project.slug,
            project.title,
            project.state,
            project.revision,
            project.completionSummary,
            JSON.stringify(project.artifacts),
            project.completedAt,
            project.createdAt,
            project.updatedAt,
          );
      }
      for (const spec of state.specs) {
        this.database
          .prepare(
            `INSERT INTO specs (id,project_id,slug,title,body,state,revision,completion_summary,artifacts_json,completed_at,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,slug=excluded.slug,title=excluded.title,body=excluded.body,state=excluded.state,revision=excluded.revision,completion_summary=excluded.completion_summary,artifacts_json=excluded.artifacts_json,completed_at=excluded.completed_at,updated_at=excluded.updated_at`,
          )
          .run(
            spec.id,
            spec.projectId,
            spec.slug,
            spec.title,
            spec.body,
            spec.state,
            spec.revision,
            spec.completionSummary,
            JSON.stringify(spec.artifacts),
            spec.completedAt,
            spec.createdAt,
            spec.updatedAt,
          );
      }
      for (const context of state.contexts) {
        this.database
          .prepare(
            `INSERT INTO context_documents (id,workspace_id,project_id,name,body,revision,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,project_id=excluded.project_id,name=excluded.name,body=excluded.body,revision=excluded.revision,updated_at=excluded.updated_at`,
          )
          .run(
            context.id,
            context.ownerType === 'workspace' ? context.ownerId : null,
            context.ownerType === 'project' ? context.ownerId : null,
            context.name,
            context.body,
            context.revision,
            context.createdAt,
            context.updatedAt,
          );
      }
      for (const task of state.tasks.filter((candidate) => candidate.parentId === null)) {
        this.upsertSyncTask(task);
      }
      for (const task of state.tasks.filter((candidate) => candidate.parentId !== null)) {
        this.upsertSyncTask(task);
      }
      const existingFingerprints = new Set(
        this.exportSyncState().activity.map((event) => event.fingerprint),
      );
      for (const event of state.activity) {
        if (existingFingerprints.has(event.fingerprint)) continue;
        this.database
          .prepare(
            'INSERT INTO activity_events (workspace_id,project_id,spec_id,target_type,target_id,event_type,actor,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          )
          .run(
            event.workspaceId,
            event.projectId,
            event.specId,
            event.targetType,
            event.targetId,
            event.eventType,
            event.actor,
            JSON.stringify(event.data),
            event.createdAt,
          );
      }
    });
  }

  private deleteMissingSyncRows(
    table: 'tasks' | 'context_documents' | 'specs' | 'projects' | 'workspaces',
    ids: string[],
  ): void {
    if (ids.length === 0) {
      this.database.prepare(`DELETE FROM ${table}`).run();
      return;
    }
    this.database
      .prepare(`DELETE FROM ${table} WHERE id NOT IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
  }

  private validateSyncState(state: SyncState): void {
    const fail = (message: string): never => {
      throw new AppError('bad_request', `Shared snapshot is invalid: ${message}`, 400);
    };
    const unique = <T>(items: T[], key: (item: T) => string, label: string): Set<string> => {
      const values = new Set<string>();
      for (const item of items) {
        const value = key(item);
        if (values.has(value)) fail(`duplicate ${label} ${value}`);
        values.add(value);
      }
      return values;
    };
    const workspaceIds = unique(state.workspaces, (item) => item.id, 'Workspace ID');
    const projectIds = unique(state.projects, (item) => item.id, 'Project ID');
    const specIds = unique(state.specs, (item) => item.id, 'Spec ID');
    const taskIds = unique(state.tasks, (item) => item.id, 'Task ID');
    unique(state.contexts, (item) => item.id, 'Context ID');
    unique(state.projects, (item) => `${item.workspaceId}:${item.slug}`, 'Project slug');
    unique(state.specs, (item) => `${item.projectId}:${item.slug}`, 'Spec slug');
    unique(
      state.contexts,
      (item) => `${item.ownerType}:${item.ownerId}:${item.name}`,
      'Context name',
    );
    for (const project of state.projects) {
      if (!workspaceIds.has(project.workspaceId)) fail(`Project ${project.id} has no Workspace`);
    }
    for (const spec of state.specs) {
      if (!projectIds.has(spec.projectId)) fail(`Spec ${spec.id} has no Project`);
    }
    for (const context of state.contexts) {
      const owners = context.ownerType === 'workspace' ? workspaceIds : projectIds;
      if (!owners.has(context.ownerId)) fail(`Context ${context.id} has no owner`);
    }
    const tasks = new Map(state.tasks.map((task) => [task.id, task]));
    for (const task of state.tasks) {
      if (!specIds.has(task.specId)) fail(`Task ${task.id} has no Spec`);
      if (task.parentId === null) continue;
      if (!taskIds.has(task.parentId)) fail(`Task ${task.id} has no parent`);
      const parent = tasks.get(task.parentId);
      if (!parent || parent.specId !== task.specId || parent.parentId !== null) {
        fail(`Task ${task.id} has an invalid parent`);
      }
    }
    const specsByProject = new Map(
      state.projects.map((project) => [project.id, [] as SyncState['specs']]),
    );
    for (const spec of state.specs) specsByProject.get(spec.projectId)!.push(spec);
    const tasksBySpec = new Map(state.specs.map((spec) => [spec.id, [] as SyncState['tasks']]));
    const nonTerminalChildren = new Set<string>();
    for (const task of state.tasks) {
      tasksBySpec.get(task.specId)!.push(task);
      if (task.parentId !== null && !isTerminalTaskState(task.state)) {
        nonTerminalChildren.add(task.parentId);
      }
    }

    const hasCompletion = (entity: {
      completionSummary: string | null;
      artifacts: unknown[];
      completedAt: string | null;
    }): boolean =>
      entity.completionSummary !== null ||
      entity.artifacts.length > 0 ||
      entity.completedAt !== null;
    const assertCompletion = (
      entity: {
        completionSummary: string | null;
        artifacts: unknown[];
        completedAt: string | null;
      },
      stateValue: string,
      label: string,
    ): void => {
      if (stateValue === 'done') {
        if (entity.completionSummary === null || entity.completedAt === null) {
          fail(`${label} is done without completion metadata`);
        }
      } else if (hasCompletion(entity)) {
        fail(`${label} has completion metadata while ${stateValue}`);
      }
    };

    for (const project of state.projects) {
      const specs = specsByProject.get(project.id)!;
      if (project.state === 'open' && specs.length === 0) {
        fail(`Project ${project.id} is open without a Spec`);
      }
      if (
        project.state === 'done' &&
        (specs.length === 0 || specs.some((spec) => !isTerminalSpecState(spec.state)))
      ) {
        fail(`Project ${project.id} is done before every Spec is terminal`);
      }
      if (project.state === 'cancelled' && specs.some((spec) => !isTerminalSpecState(spec.state))) {
        fail(`Project ${project.id} is cancelled with a non-terminal Spec`);
      }
      assertCompletion(project, project.state, `Project ${project.id}`);
    }

    for (const spec of state.specs) {
      const specTasks = tasksBySpec.get(spec.id)!;
      if (spec.state === 'ready' && spec.body.trim().length === 0) {
        fail(`Spec ${spec.id} is ready without Markdown`);
      }
      if (
        isTerminalSpecState(spec.state) &&
        specTasks.some((task) => !isTerminalTaskState(task.state))
      ) {
        fail(`Spec ${spec.id} is terminal with a non-terminal Task`);
      }
      assertCompletion(spec, spec.state, `Spec ${spec.id}`);
    }

    for (const task of state.tasks) {
      if (isTerminalTaskState(task.state) && nonTerminalChildren.has(task.id)) {
        fail(`Task ${task.id} is terminal with a non-terminal Subtask`);
      }
      assertCompletion(task, task.state, `Task ${task.id}`);
    }
  }

  private upsertSyncTask(task: SyncState['tasks'][number]): void {
    this.database
      .prepare(
        `INSERT INTO tasks (id,spec_id,parent_id,title,body,state,revision,completion_summary,artifacts_json,completed_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET spec_id=excluded.spec_id,parent_id=excluded.parent_id,title=excluded.title,body=excluded.body,state=excluded.state,revision=excluded.revision,completion_summary=excluded.completion_summary,artifacts_json=excluded.artifacts_json,completed_at=excluded.completed_at,updated_at=excluded.updated_at`,
      )
      .run(
        task.id,
        task.specId,
        task.parentId,
        task.title,
        task.body,
        task.state,
        task.revision,
        task.completionSummary,
        JSON.stringify(task.artifacts),
        task.completedAt,
        task.createdAt,
        task.updatedAt,
      );
  }

  private projectFilter(
    workspaceId: string | null,
    state: ProjectState | null,
    prefix = '',
  ): { sql: string; args: string[] } {
    const conditions: string[] = [],
      args: string[] = [];
    if (workspaceId) {
      conditions.push(`${prefix}workspace_id=?`);
      args.push(workspaceId);
    }
    if (state) {
      conditions.push(`${prefix}state=?`);
      args.push(state);
    }
    return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', args };
  }
  private projectManifestSql(): string {
    return `SELECT p.*,(SELECT COUNT(*) FROM specs WHERE project_id=p.id) spec_count,(SELECT COUNT(*) FROM specs WHERE project_id=p.id AND state='draft') draft_spec_count,(SELECT COUNT(*) FROM specs WHERE project_id=p.id AND state='ready') ready_spec_count,(SELECT COUNT(*) FROM specs WHERE project_id=p.id AND state IN ('done','cancelled')) terminal_spec_count FROM projects p`;
  }
  private specManifestSql(): string {
    return `SELECT s.*,length(CAST(s.body AS BLOB)) body_size_bytes,(SELECT COUNT(*) FROM tasks WHERE spec_id=s.id) task_count,(SELECT COUNT(*) FROM tasks WHERE spec_id=s.id AND state='open') open_task_count,(SELECT COUNT(*) FROM tasks WHERE spec_id=s.id AND state IN ('done','cancelled')) terminal_task_count FROM specs s`;
  }
  private taskManifestSql(): string {
    return `SELECT t.*,length(CAST(COALESCE(t.body,'') AS BLOB)) body_size_bytes,(SELECT COUNT(*) FROM tasks c WHERE c.parent_id=t.id) subtask_count,(SELECT COUNT(*) FROM tasks c WHERE c.parent_id=t.id AND c.state='open') open_subtask_count FROM tasks t`;
  }
  private count(sql: string, ...args: unknown[]): number {
    return (this.database.prepare(sql).get(...args) as CountRow | undefined)?.count ?? 0;
  }
  private projectFacts(projectId: string): {
    specCount: number;
    nonTerminalSpecCount: number;
    activeDescendantClaimCount: number;
  } {
    const at = now();
    return {
      specCount: this.count('SELECT COUNT(*) count FROM specs WHERE project_id=?', projectId),
      nonTerminalSpecCount: this.count(
        "SELECT COUNT(*) count FROM specs WHERE project_id=? AND state IN ('draft','ready')",
        projectId,
      ),
      activeDescendantClaimCount: this.count(
        `SELECT COUNT(*) count FROM claims c LEFT JOIN specs cs ON c.target_type='spec' AND cs.id=c.target_id LEFT JOIN tasks ct ON c.target_type='task' AND ct.id=c.target_id LEFT JOIN specs ts ON ts.id=ct.spec_id WHERE c.expires_at>? AND (cs.project_id=? OR ts.project_id=?)`,
        at,
        projectId,
        projectId,
      ),
    };
  }
  private specFacts(
    specId: string,
    body: string,
  ): {
    body: string;
    nonTerminalTaskCount: number;
    activeClaimCount: number;
    activeDescendantClaimCount: number;
  } {
    const at = now();
    return {
      body,
      nonTerminalTaskCount: this.count(
        "SELECT COUNT(*) count FROM tasks WHERE spec_id=? AND state='open'",
        specId,
      ),
      activeClaimCount: this.count(
        "SELECT COUNT(*) count FROM claims WHERE target_type='spec' AND target_id=? AND expires_at>?",
        specId,
        at,
      ),
      activeDescendantClaimCount: this.count(
        "SELECT COUNT(*) count FROM claims c JOIN tasks t ON t.id=c.target_id WHERE c.target_type='task' AND t.spec_id=? AND c.expires_at>?",
        specId,
        at,
      ),
    };
  }
  private assertOwner(type: ContextOwnerType, id: string): void {
    if (type === 'workspace') this.getWorkspace(id);
    else this.getProject(id);
  }
  private assertOwnerMutable(type: ContextOwnerType, id: string): void {
    this.assertOwner(type, id);
    if (type === 'project' && isTerminalProjectState(this.getProject(id).state))
      throw new AppError('invalid_state', 'Context in terminal Projects is immutable', 409);
  }
  private countOpenChildren(id: string): number {
    return this.count("SELECT COUNT(*) count FROM tasks WHERE parent_id=? AND state='open'", id);
  }
  private assertTargetAvailable(type: TargetType, id: string): void {
    if (type === 'spec') {
      const s = this.getSpec(id),
        p = this.getProject(s.projectId);
      this.allowed(
        evaluateClaimEligibility({
          targetType: 'spec',
          projectState: p.state,
          specState: s.state,
          openTaskCount: this.count(
            "SELECT COUNT(*) count FROM tasks WHERE spec_id=? AND state='open'",
            s.id,
          ),
        }).reason,
      );
      return;
    }
    const t = this.getTask(id),
      s = this.getSpec(t.specId),
      p = this.getProject(s.projectId);
    this.allowed(
      evaluateClaimEligibility({
        targetType: 'task',
        projectState: p.state,
        specState: s.state,
        taskState: t.state,
        openSubtaskCount: this.countOpenChildren(t.id),
      }).reason,
    );
  }
  private assertWorkScope(
    workspaceId: string | null,
    projectId: string | null,
    specId: string | null,
  ): void {
    const project = projectId ? this.getProject(projectId) : null;
    if (workspaceId && project && project.workspaceId !== workspaceId)
      throw new AppError('bad_request', 'Project does not belong to the requested Workspace', 400);
    if (!specId) return;
    const spec = this.getSpec(specId),
      specProject = this.getProject(spec.projectId);
    if (projectId && spec.projectId !== projectId)
      throw new AppError('bad_request', 'Spec does not belong to the requested Project', 400);
    if (workspaceId && specProject.workspaceId !== workspaceId)
      throw new AppError('bad_request', 'Spec does not belong to the requested Workspace', 400);
  }
  private specIdForTarget(type: TargetType, id: string): string {
    return type === 'spec' ? this.getSpec(id).id : this.getTask(id).specId;
  }
  private getClaim(type: TargetType, id: string, at = now()): Claim | null {
    const row = this.database
      .prepare('SELECT * FROM claims WHERE target_type=? AND target_id=? AND expires_at>?')
      .get(type, id, at) as ClaimRow | undefined;
    return row ? this.mapClaim(row) : null;
  }
  private ownedClaim(type: TargetType, id: string, agentId: string, at: string): Claim {
    const claim = this.getClaim(type, id, at);
    if (!claim) throw new AppError('conflict', 'Work is not currently claimed', 409, true);
    if (claim.agentId !== agentId)
      throw new AppError('conflict', `Work is claimed by ${claim.agentId}`, 409, true);
    return claim;
  }
  private workBundle(type: TargetType, id: string): WorkBundle {
    const claim = requireRow(this.getClaim(type, id), 'Claim could not be created'),
      specId = this.specIdForTarget(type, id),
      spec = this.getSpecManifest(specId),
      project = this.getProjectManifest(spec.projectId),
      workspace = this.getWorkspace(project.workspaceId);
    return {
      claim,
      workspace,
      project,
      spec,
      task: type === 'task' ? this.getTaskManifest(id) : null,
      workspaceContext: this.contextPage('workspace', workspace.id),
      projectContext: this.contextPage('project', project.id),
    };
  }
  private contextPage(type: ContextOwnerType, id: string): ContextManifestPage {
    const items = this.listContextManifests({
      ownerType: type,
      ownerId: id,
      limit: 201,
      offset: 0,
    });
    return { items: items.slice(0, 200), hasMore: items.length > 200 };
  }
  private runImmediate<T>(operation: () => T): T {
    const result = this.database.transaction(operation).immediate();
    this.onMutation();
    return result;
  }
  private syncWritable(entityType: SyncEntityKind, entityId: string): void {
    if (this.syncConflictGuard(entityType, entityId)) {
      throw new AppError(
        'conflict',
        `Synchronization conflict blocks changes to ${entityType} ${entityId}`,
        409,
      );
    }
  }
  private allowed(reason: string | null): void {
    if (reason !== null) throw new AppError('invalid_state', reason, 409);
  }
  private revision(actual: number, expected: number): void {
    if (actual !== expected)
      throw new AppError(
        'revision_conflict',
        `Expected revision ${expected}, current revision is ${actual}`,
        409,
        true,
        { expectedRevision: expected, currentRevision: actual },
      );
  }
  private changed(changes: number, currentRevision: number): void {
    if (changes === 0)
      throw new AppError('revision_conflict', 'The resource changed before this write', 409, true, {
        currentRevision,
      });
  }

  private event(
    workspaceId: string | null,
    projectId: string | null,
    specId: string | null,
    targetType: string,
    targetId: string,
    eventType: string,
    actor: string | null,
    data: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        'INSERT INTO activity_events (workspace_id,project_id,spec_id,target_type,target_id,event_type,actor,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        workspaceId,
        projectId,
        specId,
        targetType,
        targetId,
        eventType,
        actor,
        JSON.stringify(data),
        now(),
      );
  }
  private projectEvent(
    projectId: string,
    eventType: string,
    actor: string | null,
    data: Record<string, unknown>,
  ): void {
    const p = this.getProject(projectId);
    this.event(
      p.workspaceId,
      p.id,
      null,
      typeof data.targetId === 'string' ? 'context' : 'project',
      typeof data.targetId === 'string' ? data.targetId : p.id,
      eventType,
      actor,
      data,
    );
  }
  private specEvent(
    specId: string,
    projectId: string,
    eventType: string,
    actor: string | null,
    data: Record<string, unknown>,
  ): void {
    const p = this.getProject(projectId),
      isTask = data.targetType === 'task' || eventType.startsWith('task.');
    this.event(
      p.workspaceId,
      p.id,
      specId,
      isTask ? 'task' : 'spec',
      typeof data.targetId === 'string' ? data.targetId : specId,
      eventType,
      actor,
      data,
    );
  }
  private taskEvent(
    taskId: string,
    specId: string,
    projectId: string,
    eventType: string,
    actor: string | null,
    data: Record<string, unknown>,
  ): void {
    const p = this.getProject(projectId);
    this.event(p.workspaceId, p.id, specId, 'task', taskId, eventType, actor, data);
  }
  private mapWorkspace(r: WorkspaceRow): Workspace {
    return {
      id: r.id,
      name: r.name,
      rootPath: r.root_path.startsWith('/__pimpampum_unresolved__/') ? '' : r.root_path,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  private mapProject(r: ProjectRow): Project {
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
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  private mapProjectManifest(r: ProjectManifestRow): ProjectManifest {
    const { artifacts: _a, completionSummary: _c, ...base } = this.mapProject(r);
    return {
      ...base,
      artifactCount: parseArtifacts(r.artifacts_json).length,
      hasCompletion: r.completion_summary !== null,
      specCount: r.spec_count,
      draftSpecCount: r.draft_spec_count,
      readySpecCount: r.ready_spec_count,
      terminalSpecCount: r.terminal_spec_count,
    };
  }
  private mapSpec(r: SpecRow): Spec {
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
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      claim: this.getClaim('spec', r.id),
    };
  }
  private mapSpecManifest(r: SpecManifestRow): SpecManifest {
    const { body: _b, artifacts: _a, completionSummary: _c, ...base } = this.mapSpec(r);
    return {
      ...base,
      bodySizeBytes: r.body_size_bytes,
      artifactCount: parseArtifacts(r.artifacts_json).length,
      hasCompletion: r.completion_summary !== null,
      taskCount: r.task_count,
      openTaskCount: r.open_task_count,
      terminalTaskCount: r.terminal_task_count,
    };
  }
  private mapContext(r: ContextRow): ContextDocument {
    const ownerType: ContextOwnerType = r.workspace_id === null ? 'project' : 'workspace',
      ownerId = r.workspace_id ?? requireRow(r.project_id, 'Context owner was not found');
    return {
      id: r.id,
      ownerType,
      ownerId,
      name: r.name,
      body: r.body,
      revision: r.revision,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  private mapContextManifest(r: ContextManifestRow): ContextManifest {
    const { body: _b, ...base } = this.mapContext(r);
    return { ...base, sizeBytes: r.size_bytes };
  }
  private mapTask(r: TaskRow): Task {
    return {
      id: r.id,
      specId: r.spec_id,
      parentId: r.parent_id,
      title: r.title,
      body: r.body,
      state: r.state,
      revision: r.revision,
      completionSummary: r.completion_summary,
      artifacts: parseArtifacts(r.artifacts_json),
      completedAt: r.completed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      claim: this.getClaim('task', r.id),
    };
  }
  private mapTaskManifest(r: TaskManifestRow): TaskManifest {
    const { body: _b, artifacts: _a, completionSummary: _c, ...base } = this.mapTask(r);
    return {
      ...base,
      bodySizeBytes: r.body_size_bytes,
      artifactCount: parseArtifacts(r.artifacts_json).length,
      hasCompletion: r.completion_summary !== null,
      subtaskCount: r.subtask_count,
      openSubtaskCount: r.open_subtask_count,
    };
  }
  private mapClaim(r: ClaimRow): Claim {
    return {
      targetType: r.target_type,
      targetId: r.target_id,
      agentId: r.agent_id,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
