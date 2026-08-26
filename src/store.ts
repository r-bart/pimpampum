import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { backupDatabase, backupLatestDatabase, exportPortable } from './backup.js';
import { AppError } from './errors.js';
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
  CreateProjectInput,
  CreateTaskInput,
  MarkdownPage,
  OverviewActiveWork,
  OverviewCounts,
  OverviewProject,
  OverviewSnapshot,
  Project,
  ProjectManifest,
  ProjectState,
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
  prd: string;
  revision: number;
  completion_summary: string | null;
  artifacts_json: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ContextRow {
  id: string;
  project_id: string;
  name: string;
  body: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  body: string | null;
  state: TaskState;
  revision: number;
  completion_summary: string | null;
  artifacts_json: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
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

type ProjectManifestRow = Omit<ProjectRow, 'prd'> & { prd_size_bytes: number };
type ContextManifestRow = Omit<ContextRow, 'body'> & { size_bytes: number };
type TaskManifestRow = Omit<TaskRow, 'body'> & { body_size_bytes: number };

interface WorkProjectRow {
  id: string;
  workspace_id: string;
  title: string;
  revision: number;
  updated_at: string;
}

interface WorkTaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  revision: number;
  created_at: string;
  workspace_id: string;
  project_title: string;
}

interface OverviewCountsRow {
  workspaces: number;
  projects: number;
  draft_projects: number;
  ready_projects: number;
  completed_projects: number;
  open_tasks: number;
  completed_tasks: number;
  active_claims: number;
  available_work: number;
}

interface OverviewProjectRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_root_path: string;
  slug: string;
  title: string;
  lifecycle_state: ProjectState;
  open_task_count: number;
  completed_task_count: number;
  active_claim_count: number;
  available_work_count: number;
  updated_at: string;
}

interface OverviewActiveWorkRow {
  target_type: TargetType;
  target_id: string;
  workspace_id: string;
  project_id: string;
  project_title: string;
  task_id: string | null;
  task_title: string | null;
  agent_id: string;
  expires_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function parseArtifacts(value: string): ArtifactReference[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? (parsed as ArtifactReference[]) : [];
}

function markdownPage(body: string, offsetCodeUnits: number, limitCodeUnits: number): MarkdownPage {
  return {
    body: body.slice(offsetCodeUnits, offsetCodeUnits + limitCodeUnits),
    offsetCodeUnits,
    totalCodeUnits: body.length,
    sizeBytes: Buffer.byteLength(body, 'utf8'),
    hasMore: offsetCodeUnits + limitCodeUnits < body.length,
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function requireRow<T>(row: T | null | undefined, message: string): T {
  if (row === undefined || row === null) throw new AppError('not_found', message, 404);
  return row;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export class PimpampumStore {
  constructor(
    private readonly database: Database.Database,
    private readonly onMutation: () => void = () => undefined,
  ) {}

  close(): void {
    this.database.close();
  }

  registerWorkspace(input: {
    id: string;
    name: string;
    rootPath: string;
    actor: string | null;
  }): Workspace {
    if (!isAbsolute(input.rootPath)) {
      throw new AppError('bad_request', 'Workspace root must be an absolute path', 400);
    }
    let rootPath: string;
    try {
      rootPath = realpathSync(input.rootPath);
    } catch {
      throw new AppError('bad_request', 'Workspace root does not exist', 400);
    }
    if (!statSync(rootPath).isDirectory()) {
      throw new AppError('bad_request', 'Workspace root must be a directory', 400);
    }

    try {
      return this.runImmediate(() => {
        const timestamp = now();
        this.database
          .prepare<[string, string, string, string, string]>(
            `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.id, input.name, rootPath, timestamp, timestamp);

        this.recordEvent({
          workspaceId: input.id,
          projectId: null,
          targetType: 'workspace',
          targetId: input.id,
          eventType: 'workspace.created',
          actor: input.actor,
          data: { name: input.name, rootPath },
        });
        return this.getWorkspace(input.id);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AppError('conflict', 'Workspace id or root path already exists', 409);
      }
      throw error;
    }
  }

  listWorkspaces(): Workspace[] {
    return this.database
      .prepare<[], WorkspaceRow>('SELECT * FROM workspaces ORDER BY name, id')
      .all()
      .map((row) => this.mapWorkspace(row));
  }

  getWorkspace(workspaceId: string): Workspace {
    const row = this.database
      .prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?')
      .get(workspaceId);
    return this.mapWorkspace(requireRow(row, `Workspace ${workspaceId} was not found`));
  }

  resolveWorkspace(inputPath: string): Workspace {
    if (!isAbsolute(inputPath)) {
      throw new AppError('bad_request', 'Workspace path must be absolute', 400);
    }
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(inputPath);
    } catch {
      throw new AppError('not_found', 'Workspace path does not exist', 404);
    }
    const match = this.listWorkspaces()
      .filter((workspace) => isPathInside(workspace.rootPath, resolvedPath))
      .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];

    if (!match) {
      throw new AppError('not_found', `No registered workspace contains ${resolvedPath}`, 404);
    }
    return match;
  }

  createProject(input: CreateProjectInput): Project {
    if (input.state !== 'draft' && input.state !== 'ready') {
      throw new AppError(
        'bad_request',
        'Projects can only be created in draft or ready state; complete them through the work flow',
        400,
      );
    }
    try {
      return this.runImmediate(() => {
        this.getWorkspace(input.workspaceId);
        const id = randomUUID();
        const timestamp = now();
        this.database
          .prepare<[string, string, string, string, string, string, string, string]>(
            `INSERT INTO projects
               (id, workspace_id, slug, title, state, prd, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.workspaceId,
            input.slug,
            input.title,
            input.state,
            input.prd,
            timestamp,
            timestamp,
          );

        this.recordEvent({
          workspaceId: input.workspaceId,
          projectId: id,
          targetType: 'project',
          targetId: id,
          eventType: 'project.created',
          actor: input.actor,
          data: { slug: input.slug, title: input.title, state: input.state },
        });
        return this.getProject(id);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AppError('conflict', 'Project slug already exists in this workspace', 409);
      }
      throw error;
    }
  }

  listProjects(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): Project[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.workspaceId) {
      conditions.push('workspace_id = ?');
      parameters.push(input.workspaceId);
    }
    if (input.state) {
      conditions.push('state = ?');
      parameters.push(input.state);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    parameters.push(input.limit, input.offset);

    return this.database
      .prepare<Array<string | number>, ProjectRow>(
        `SELECT * FROM projects ${where} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...parameters)
      .map((row) => this.mapProject(row));
  }

  listProjectManifests(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): ProjectManifest[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.workspaceId) {
      conditions.push('workspace_id = ?');
      parameters.push(input.workspaceId);
    }
    if (input.state) {
      conditions.push('state = ?');
      parameters.push(input.state);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    parameters.push(input.limit, input.offset);

    return this.database
      .prepare<Array<string | number>, ProjectManifestRow>(
        `SELECT id, workspace_id, slug, title, state, revision, completion_summary,
                artifacts_json, completed_at, created_at, updated_at,
                length(CAST(prd AS BLOB)) AS prd_size_bytes
         FROM projects ${where}
         ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...parameters)
      .map((row) => this.mapProjectManifest(row));
  }

  getProject(projectId: string): Project {
    const row = this.database
      .prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?')
      .get(projectId);
    return this.mapProject(requireRow(row, `Project ${projectId} was not found`));
  }

  getProjectManifest(projectId: string): ProjectManifest {
    const row = this.database
      .prepare<[string], ProjectManifestRow>(
        `SELECT id, workspace_id, slug, title, state, revision, completion_summary,
                artifacts_json, completed_at, created_at, updated_at,
                length(CAST(prd AS BLOB)) AS prd_size_bytes
         FROM projects WHERE id = ?`,
      )
      .get(projectId);
    return this.mapProjectManifest(requireRow(row, `Project ${projectId} was not found`));
  }

  readProjectPrd(projectId: string, offsetCodeUnits: number, limitCodeUnits: number): MarkdownPage {
    return markdownPage(this.getProject(projectId).prd, offsetCodeUnits, limitCodeUnits);
  }

  getProjectCompletion(projectId: string): CompletionDetails {
    const { completionSummary, artifacts, completedAt } = this.getProject(projectId);
    return { completionSummary, artifacts, completedAt };
  }

  updateProject(input: {
    projectId: string;
    title: string | null;
    state: Exclude<ProjectState, 'done'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Project {
    return this.runImmediate(() => {
      const current = this.getProject(input.projectId);
      this.assertRevision(current.revision, input.expectedRevision);
      if (current.state === 'done') {
        throw new AppError('invalid_state', 'Completed projects cannot be edited', 409);
      }

      const title = input.title ?? current.title;
      const state = input.state ?? current.state;
      const result = this.database
        .prepare<[string, string, string, string, number]>(
          `UPDATE projects
           SET title = ?, state = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(title, state, now(), input.projectId, input.expectedRevision);
      this.assertChanged(result.changes, current.revision);

      this.recordProjectEvent(input.projectId, 'project.updated', input.actor, { title, state });
      return this.getProject(input.projectId);
    });
  }

  updatePrd(input: {
    projectId: string;
    prd: string;
    expectedRevision: number;
    actor: string | null;
  }): Project {
    return this.runImmediate(() => {
      const current = this.getProject(input.projectId);
      this.assertRevision(current.revision, input.expectedRevision);
      if (current.state === 'done') {
        throw new AppError('invalid_state', 'Completed projects cannot be edited', 409);
      }

      const result = this.database
        .prepare<[string, string, string, number]>(
          `UPDATE projects SET prd = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(input.prd, now(), input.projectId, input.expectedRevision);
      this.assertChanged(result.changes, current.revision);
      this.recordProjectEvent(input.projectId, 'project.prd_updated', input.actor, {});
      return this.getProject(input.projectId);
    });
  }

  listContext(projectId: string): ContextDocument[] {
    this.getProject(projectId);
    return this.database
      .prepare<[string], ContextRow>(
        'SELECT * FROM context_documents WHERE project_id = ? ORDER BY name',
      )
      .all(projectId)
      .map((row) => this.mapContext(row));
  }

  listContextManifests(input: {
    projectId: string;
    limit: number;
    offset: number;
  }): ContextManifest[] {
    this.getProject(input.projectId);
    return this.database
      .prepare<[string, number, number], ContextManifestRow>(
        `SELECT id, project_id, name, revision, created_at, updated_at,
                length(CAST(body AS BLOB)) AS size_bytes
         FROM context_documents WHERE project_id = ?
         ORDER BY name, id LIMIT ? OFFSET ?`,
      )
      .all(input.projectId, input.limit, input.offset)
      .map((row) => this.mapContextManifest(row));
  }

  readContext(projectId: string, name: string): ContextDocument {
    const row = this.database
      .prepare<[string, string], ContextRow>(
        'SELECT * FROM context_documents WHERE project_id = ? AND name = ?',
      )
      .get(projectId, name);
    return this.mapContext(requireRow(row, `Context document ${name} was not found`));
  }

  readContextPage(
    projectId: string,
    name: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): MarkdownPage {
    return markdownPage(this.readContext(projectId, name).body, offsetCodeUnits, limitCodeUnits);
  }

  putContext(input: {
    projectId: string;
    name: string;
    body: string;
    expectedRevision: number | null;
    actor: string | null;
  }): ContextDocument {
    return this.runImmediate(() => {
      const project = this.getProject(input.projectId);
      if (project.state === 'done') {
        throw new AppError('invalid_state', 'Completed projects cannot be edited', 409);
      }

      const existing = this.database
        .prepare<[string, string], ContextRow>(
          'SELECT * FROM context_documents WHERE project_id = ? AND name = ?',
        )
        .get(input.projectId, input.name);
      const timestamp = now();

      if (existing) {
        if (input.expectedRevision === null) {
          throw new AppError('conflict', 'Context document already exists', 409);
        }
        this.assertRevision(existing.revision, input.expectedRevision);
        const result = this.database
          .prepare<[string, string, string, number]>(
            `UPDATE context_documents
             SET body = ?, revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(input.body, timestamp, existing.id, input.expectedRevision);
        this.assertChanged(result.changes, existing.revision);
      } else {
        if (input.expectedRevision !== null) {
          throw new AppError('not_found', `Context document ${input.name} was not found`, 404);
        }
        this.database
          .prepare<[string, string, string, string, string, string]>(
            `INSERT INTO context_documents (id, project_id, name, body, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), input.projectId, input.name, input.body, timestamp, timestamp);
      }

      const document = this.readContext(input.projectId, input.name);
      this.recordProjectEvent(input.projectId, 'context.put', input.actor, {
        targetId: document.id,
        name: input.name,
      });
      return document;
    });
  }

  createTask(input: CreateTaskInput): Task {
    return this.runImmediate(() => {
      const project = this.getProject(input.projectId);
      if (project.state === 'done') {
        throw new AppError('invalid_state', 'Tasks cannot be added to a completed project', 409);
      }
      if (this.getClaim('project', input.projectId)) {
        throw new AppError('conflict', 'Release the project claim before creating tasks', 409);
      }

      if (input.parentId) {
        const parent = this.getTask(input.parentId);
        if (parent.projectId !== input.projectId) {
          throw new AppError('bad_request', 'Parent task belongs to another project', 400);
        }
        if (parent.parentId !== null) {
          throw new AppError('bad_request', 'Subtasks cannot have children', 400);
        }
        if (parent.state === 'done') {
          throw new AppError('invalid_state', 'Subtasks cannot be added to a completed task', 409);
        }
        if (this.getClaim('task', parent.id)) {
          throw new AppError(
            'conflict',
            'Release the parent task claim before creating subtasks',
            409,
          );
        }
      }

      const id = randomUUID();
      const timestamp = now();
      this.database
        .prepare<[string, string, string | null, string, string | null, string, string]>(
          `INSERT INTO tasks
             (id, project_id, parent_id, title, body, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(id, input.projectId, input.parentId, input.title, input.body, timestamp, timestamp);

      this.recordProjectEvent(input.projectId, 'task.created', input.actor, {
        taskId: id,
        parentId: input.parentId,
        title: input.title,
      });
      return this.getTask(id);
    });
  }

  listTasks(projectId: string): Task[] {
    this.getProject(projectId);
    return this.database
      .prepare<[string], TaskRow>(
        `SELECT * FROM tasks WHERE project_id = ?
         ORDER BY CASE WHEN parent_id IS NULL THEN id ELSE parent_id END,
                  parent_id IS NOT NULL, created_at, id`,
      )
      .all(projectId)
      .map((row) => this.mapTask(row));
  }

  listTaskManifests(input: { projectId: string; limit: number; offset: number }): TaskManifest[] {
    this.getProject(input.projectId);
    return this.database
      .prepare<[string, number, number], TaskManifestRow>(
        `SELECT id, project_id, parent_id, title, state, revision, completion_summary,
                artifacts_json, completed_at, created_at, updated_at,
                length(CAST(COALESCE(body, '') AS BLOB)) AS body_size_bytes
         FROM tasks WHERE project_id = ?
         ORDER BY CASE WHEN parent_id IS NULL THEN id ELSE parent_id END,
                  parent_id IS NOT NULL, created_at, id
         LIMIT ? OFFSET ?`,
      )
      .all(input.projectId, input.limit, input.offset)
      .map((row) => this.mapTaskManifest(row));
  }

  getTask(taskId: string): Task {
    const row = this.database
      .prepare<[string], TaskRow>('SELECT * FROM tasks WHERE id = ?')
      .get(taskId);
    return this.mapTask(requireRow(row, `Task ${taskId} was not found`));
  }

  getTaskManifest(taskId: string): TaskManifest {
    const row = this.database
      .prepare<[string], TaskManifestRow>(
        `SELECT id, project_id, parent_id, title, state, revision, completion_summary,
                artifacts_json, completed_at, created_at, updated_at,
                length(CAST(COALESCE(body, '') AS BLOB)) AS body_size_bytes
         FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    return this.mapTaskManifest(requireRow(row, `Task ${taskId} was not found`));
  }

  readTaskBody(taskId: string, offsetCodeUnits: number, limitCodeUnits: number): MarkdownPage {
    return markdownPage(this.getTask(taskId).body ?? '', offsetCodeUnits, limitCodeUnits);
  }

  getTaskCompletion(taskId: string): CompletionDetails {
    const { completionSummary, artifacts, completedAt } = this.getTask(taskId);
    return { completionSummary, artifacts, completedAt };
  }

  updateTask(input: {
    taskId: string;
    title: string | null;
    body: string | null | undefined;
    expectedRevision: number;
    actor: string | null;
  }): Task {
    return this.runImmediate(() => {
      const current = this.getTask(input.taskId);
      this.assertRevision(current.revision, input.expectedRevision);
      if (current.state === 'done') {
        throw new AppError('invalid_state', 'Completed tasks cannot be edited', 409);
      }

      const title = input.title ?? current.title;
      const body = input.body === undefined ? current.body : input.body;
      const result = this.database
        .prepare<[string, string | null, string, string, number]>(
          `UPDATE tasks
           SET title = ?, body = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(title, body, now(), input.taskId, input.expectedRevision);
      this.assertChanged(result.changes, current.revision);
      this.recordProjectEvent(current.projectId, 'task.updated', input.actor, {
        taskId: input.taskId,
        title,
      });
      return this.getTask(input.taskId);
    });
  }

  listWork(input: { workspaceId: string | null; limit: number }): WorkItem[] {
    const timestamp = now();
    const workspaceFilter = input.workspaceId ? 'AND p.workspace_id = ?' : '';
    const projectParameters: Array<string | number> = [timestamp];
    const taskParameters: Array<string | number> = [timestamp];
    if (input.workspaceId) {
      projectParameters.push(input.workspaceId);
      taskParameters.push(input.workspaceId);
    }
    projectParameters.push(input.limit);
    taskParameters.push(input.limit);

    const projects = this.database
      .prepare<Array<string | number>, WorkProjectRow>(
        `SELECT p.id, p.workspace_id, p.title, p.revision, p.updated_at FROM projects p
         WHERE p.state = 'ready'
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.state = 'open')
           AND NOT EXISTS (
             SELECT 1 FROM claims c
             WHERE c.target_type = 'project' AND c.target_id = p.id AND c.expires_at > ?
           )
           ${workspaceFilter}
         ORDER BY p.updated_at ASC, p.id ASC
         LIMIT ?`,
      )
      .all(...projectParameters)
      .map<WorkItem & { sortAt: string }>((project) => ({
        targetType: 'project',
        targetId: project.id,
        workspaceId: project.workspace_id,
        projectId: project.id,
        projectTitle: project.title,
        taskId: null,
        taskTitle: null,
        parentTaskId: null,
        revision: project.revision,
        sortAt: project.updated_at,
      }));

    const tasks = this.database
      .prepare<Array<string | number>, WorkTaskRow>(
        `SELECT t.id, t.project_id, t.parent_id, t.title, t.revision, t.created_at,
                p.workspace_id, p.title AS project_title
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE t.state = 'open' AND p.state = 'ready'
           AND NOT EXISTS (SELECT 1 FROM tasks child WHERE child.parent_id = t.id AND child.state = 'open')
           AND NOT EXISTS (
             SELECT 1 FROM claims c
             WHERE c.target_type = 'task' AND c.target_id = t.id AND c.expires_at > ?
           )
           ${workspaceFilter}
         ORDER BY t.created_at ASC, t.id ASC
         LIMIT ?`,
      )
      .all(...taskParameters)
      .map<WorkItem & { sortAt: string }>((task) => ({
        targetType: 'task',
        targetId: task.id,
        workspaceId: task.workspace_id,
        projectId: task.project_id,
        projectTitle: task.project_title,
        taskId: task.id,
        taskTitle: task.title,
        parentTaskId: task.parent_id,
        revision: task.revision,
        sortAt: task.created_at,
      }));

    return [...projects, ...tasks]
      .sort(
        (left, right) =>
          left.sortAt.localeCompare(right.sortAt) || left.targetId.localeCompare(right.targetId),
      )
      .slice(0, input.limit)
      .map(({ sortAt: _sortAt, ...item }) => item);
  }

  getOverview(): OverviewSnapshot {
    return this.database.transaction(() => {
      const timestamp = now();
      const countsRow = requireRow(
        this.database
          .prepare<[string], OverviewCountsRow>(
            `WITH active_claims AS (
               SELECT target_type, target_id
               FROM claims
               WHERE expires_at > ?
             ),
             available_projects AS (
               SELECT p.id
               FROM projects p
               WHERE p.state = 'ready'
                 AND NOT EXISTS (
                   SELECT 1 FROM tasks t
                   WHERE t.project_id = p.id AND t.state = 'open'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM active_claims ac
                   WHERE ac.target_type = 'project' AND ac.target_id = p.id
                 )
             ),
             available_tasks AS (
               SELECT t.id
               FROM tasks t
               JOIN projects p ON p.id = t.project_id
               WHERE t.state = 'open' AND p.state = 'ready'
                 AND NOT EXISTS (
                   SELECT 1 FROM tasks child
                   WHERE child.parent_id = t.id AND child.state = 'open'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM active_claims ac
                   WHERE ac.target_type = 'task' AND ac.target_id = t.id
                 )
             )
             SELECT
               (SELECT COUNT(w.id) FROM workspaces w) AS workspaces,
               (SELECT COUNT(p.id) FROM projects p) AS projects,
               (SELECT COUNT(p.id) FROM projects p WHERE p.state = 'draft') AS draft_projects,
               (SELECT COUNT(p.id) FROM projects p WHERE p.state = 'ready') AS ready_projects,
               (SELECT COUNT(p.id) FROM projects p WHERE p.state = 'done') AS completed_projects,
               (SELECT COUNT(t.id) FROM tasks t WHERE t.state = 'open') AS open_tasks,
               (SELECT COUNT(t.id) FROM tasks t WHERE t.state = 'done') AS completed_tasks,
               (SELECT COUNT(ac.target_id) FROM active_claims ac) AS active_claims,
               (SELECT COUNT(ap.id) FROM available_projects ap) +
                 (SELECT COUNT(at.id) FROM available_tasks at) AS available_work`,
          )
          .get(timestamp),
        'Overview counts were not returned',
      );

      const counts: OverviewCounts = {
        workspaces: countsRow.workspaces,
        projects: countsRow.projects,
        draftProjects: countsRow.draft_projects,
        readyProjects: countsRow.ready_projects,
        completedProjects: countsRow.completed_projects,
        openTasks: countsRow.open_tasks,
        completedTasks: countsRow.completed_tasks,
        activeClaims: countsRow.active_claims,
        availableWork: countsRow.available_work,
      };

      const projectRows = this.database
        .prepare<[string, number], OverviewProjectRow>(
          `WITH active_claims AS (
             SELECT target_type, target_id
             FROM claims
             WHERE expires_at > ?
           ),
           task_counts AS (
             SELECT t.project_id,
                    SUM(CASE WHEN t.state = 'open' THEN 1 ELSE 0 END) AS open_task_count,
                    SUM(CASE WHEN t.state = 'done' THEN 1 ELSE 0 END) AS completed_task_count
             FROM tasks t
             GROUP BY t.project_id
           ),
           active_claim_parts AS (
             SELECT ac.target_id AS project_id, COUNT(ac.target_id) AS claim_count
             FROM active_claims ac
             WHERE ac.target_type = 'project'
             GROUP BY ac.target_id
             UNION ALL
             SELECT t.project_id, COUNT(ac.target_id) AS claim_count
             FROM active_claims ac
             JOIN tasks t ON ac.target_type = 'task' AND t.id = ac.target_id
             GROUP BY t.project_id
           ),
           active_claim_counts AS (
             SELECT acp.project_id, SUM(acp.claim_count) AS active_claim_count
             FROM active_claim_parts acp
             GROUP BY acp.project_id
           ),
           available_task_counts AS (
             SELECT t.project_id, COUNT(t.id) AS available_task_count
             FROM tasks t
             JOIN projects p ON p.id = t.project_id
             WHERE t.state = 'open' AND p.state = 'ready'
               AND NOT EXISTS (
                 SELECT 1 FROM tasks child
                 WHERE child.parent_id = t.id AND child.state = 'open'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM active_claims ac
                 WHERE ac.target_type = 'task' AND ac.target_id = t.id
               )
             GROUP BY t.project_id
           ),
           project_overview AS (
             SELECT p.id,
                    w.id AS workspace_id,
                    w.name AS workspace_name,
                    w.root_path AS workspace_root_path,
                    p.slug,
                    p.title,
                    p.state AS lifecycle_state,
                    COALESCE(tc.open_task_count, 0) AS open_task_count,
                    COALESCE(tc.completed_task_count, 0) AS completed_task_count,
                    COALESCE(acc.active_claim_count, 0) AS active_claim_count,
                    COALESCE(atc.available_task_count, 0) +
                      CASE WHEN p.state = 'ready'
                                  AND COALESCE(tc.open_task_count, 0) = 0
                                  AND NOT EXISTS (
                                    SELECT 1 FROM active_claims ac
                                    WHERE ac.target_type = 'project' AND ac.target_id = p.id
                                  )
                           THEN 1 ELSE 0 END AS available_work_count,
                    p.updated_at
             FROM projects p
             JOIN workspaces w ON w.id = p.workspace_id
             LEFT JOIN task_counts tc ON tc.project_id = p.id
             LEFT JOIN active_claim_counts acc ON acc.project_id = p.id
             LEFT JOIN available_task_counts atc ON atc.project_id = p.id
           )
           SELECT id, workspace_id, workspace_name, workspace_root_path, slug, title,
                  lifecycle_state, open_task_count, completed_task_count, active_claim_count,
                  available_work_count, updated_at
           FROM project_overview
           ORDER BY CASE
                      WHEN active_claim_count > 0 THEN 0
                      WHEN available_work_count > 0 THEN 1
                      WHEN lifecycle_state = 'done' THEN 3
                      ELSE 2
                    END,
                    updated_at DESC,
                    id ASC
           LIMIT ?`,
        )
        .all(timestamp, 501);
      const projects = projectRows
        .map<OverviewProject>((row) => ({
          id: row.id,
          workspace: {
            id: row.workspace_id,
            name: row.workspace_name,
            rootPath: row.workspace_root_path,
          },
          slug: row.slug,
          title: row.title,
          lifecycleState: row.lifecycle_state,
          status: statusForProject({
            lifecycleState: row.lifecycle_state,
            activeClaimCount: row.active_claim_count,
            availableWorkCount: row.available_work_count,
          }),
          openTaskCount: row.open_task_count,
          completedTaskCount: row.completed_task_count,
          activeClaimCount: row.active_claim_count,
          availableWorkCount: row.available_work_count,
          updatedAt: row.updated_at,
        }))
        .sort(sortOverviewProjects);
      const boundedProjects = boundOverview(projects, 500);

      const activeWorkRows = this.database
        .prepare<[string, number], OverviewActiveWorkRow>(
          `SELECT c.target_type,
                  c.target_id,
                  p.workspace_id,
                  p.id AS project_id,
                  p.title AS project_title,
                  t.id AS task_id,
                  t.title AS task_title,
                  c.agent_id,
                  c.expires_at
           FROM claims c
           LEFT JOIN tasks t ON c.target_type = 'task' AND t.id = c.target_id
           JOIN projects p ON (c.target_type = 'project' AND p.id = c.target_id)
                           OR (c.target_type = 'task' AND p.id = t.project_id)
           WHERE c.expires_at > ?
           ORDER BY c.updated_at DESC, c.target_id ASC
           LIMIT ?`,
        )
        .all(timestamp, 501);
      const activeWork = activeWorkRows.map<OverviewActiveWork>((row) => ({
        targetType: row.target_type,
        targetId: row.target_id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        projectTitle: row.project_title,
        taskId: row.task_id,
        taskTitle: row.task_title,
        agentId: row.agent_id,
        expiresAt: row.expires_at,
      }));
      const boundedActiveWork = boundOverview(activeWork, 500);

      return {
        status: statusForOverview(counts),
        counts,
        projects: boundedProjects.items,
        projectsTruncated: boundedProjects.truncated,
        activeWork: boundedActiveWork.items,
        activeWorkTruncated: boundedActiveWork.truncated,
      };
    })();
  }

  startWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): WorkBundle {
    this.runImmediate(() => {
      const timestamp = now();
      this.database
        .prepare<[TargetType, string, string]>(
          'DELETE FROM claims WHERE target_type = ? AND target_id = ? AND expires_at <= ?',
        )
        .run(input.targetType, input.targetId, timestamp);

      const existingClaim = this.getClaim(input.targetType, input.targetId, timestamp);
      if (existingClaim?.agentId === input.agentId) return;
      if (existingClaim) {
        throw new AppError('conflict', 'Work is already claimed', 409, true);
      }
      this.assertTargetAvailable(input.targetType, input.targetId);

      const expiresAt = new Date(Date.now() + input.leaseSeconds * 1_000).toISOString();
      this.database
        .prepare<[TargetType, string, string, string, string, string]>(
          `INSERT INTO claims
             (target_type, target_id, agent_id, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.targetType, input.targetId, input.agentId, expiresAt, timestamp, timestamp);

      const projectId = this.projectIdForTarget(input.targetType, input.targetId);
      this.recordProjectEvent(projectId, 'work.started', input.agentId, {
        targetType: input.targetType,
        targetId: input.targetId,
        expiresAt,
      });
    });

    const claim = requireRow(
      this.getClaim(input.targetType, input.targetId),
      'Claim could not be created',
    );
    const projectId = this.projectIdForTarget(input.targetType, input.targetId);
    const project = this.getProjectManifest(projectId);
    const task = input.targetType === 'task' ? this.getTaskManifest(input.targetId) : null;
    const workspace = this.getWorkspace(project.workspaceId);
    const contextPage = this.listContextManifests({ projectId, limit: 201, offset: 0 });
    return {
      claim,
      workspace,
      project,
      task,
      context: contextPage.slice(0, 200),
      contextHasMore: contextPage.length > 200,
    };
  }

  renewWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): Claim {
    return this.runImmediate(() => {
      const timestamp = now();
      const claim = this.requireOwnedClaim(
        input.targetType,
        input.targetId,
        input.agentId,
        timestamp,
      );
      const expiresAt = new Date(Date.now() + input.leaseSeconds * 1_000).toISOString();
      const result = this.database
        .prepare<[string, string, TargetType, string, string, string]>(
          `UPDATE claims SET expires_at = ?, updated_at = ?
           WHERE target_type = ? AND target_id = ? AND agent_id = ? AND expires_at > ?`,
        )
        .run(expiresAt, timestamp, input.targetType, input.targetId, input.agentId, timestamp);
      if (result.changes !== 1) {
        throw new AppError('conflict', 'Claim expired or changed before renewal', 409, true);
      }
      this.recordProjectEvent(
        this.projectIdForTarget(input.targetType, input.targetId),
        'work.renewed',
        input.agentId,
        {
          targetType: input.targetType,
          targetId: input.targetId,
          previousExpiry: claim.expiresAt,
          expiresAt,
        },
      );
      return requireRow(
        this.getClaim(input.targetType, input.targetId, timestamp),
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
      const timestamp = now();
      this.requireOwnedClaim(input.targetType, input.targetId, input.agentId, timestamp);
      const result = this.database
        .prepare<[TargetType, string, string, string]>(
          `DELETE FROM claims
           WHERE target_type = ? AND target_id = ? AND agent_id = ? AND expires_at > ?`,
        )
        .run(input.targetType, input.targetId, input.agentId, timestamp);
      if (result.changes !== 1) {
        throw new AppError('conflict', 'Claim expired or changed before release', 409, true);
      }
      this.recordProjectEvent(
        this.projectIdForTarget(input.targetType, input.targetId),
        'work.released',
        input.agentId,
        { targetType: input.targetType, targetId: input.targetId, note: input.note },
      );
    });
  }

  completeWork(input: CompleteWorkInput): Project | Task {
    this.runImmediate(() => {
      this.requireOwnedClaim(input.targetType, input.targetId, input.agentId, now());
      const timestamp = now();

      if (input.targetType === 'project') {
        const project = this.getProject(input.targetId);
        this.assertRevision(project.revision, input.expectedRevision);
        if (project.state !== 'ready') {
          throw new AppError('invalid_state', 'Only ready projects can be completed', 409);
        }
        if (this.countOpenTasks(project.id) > 0) {
          throw new AppError('invalid_state', 'Project has open tasks', 409);
        }
        const result = this.database
          .prepare<[string, string, string, string, string, number]>(
            `UPDATE projects
             SET state = 'done', completion_summary = ?, artifacts_json = ?, completed_at = ?,
                 updated_at = ?, revision = revision + 1
             WHERE id = ? AND revision = ?`,
          )
          .run(
            input.summary,
            JSON.stringify(input.artifacts),
            timestamp,
            timestamp,
            input.targetId,
            input.expectedRevision,
          );
        this.assertChanged(result.changes, project.revision);
      } else {
        const task = this.getTask(input.targetId);
        const project = this.getProject(task.projectId);
        this.assertRevision(task.revision, input.expectedRevision);
        if (project.state !== 'ready') {
          throw new AppError('invalid_state', 'Tasks can only complete in ready projects', 409);
        }
        if (task.state !== 'open') {
          throw new AppError('invalid_state', 'Only open tasks can be completed', 409);
        }
        if (this.countOpenChildren(task.id) > 0) {
          throw new AppError('invalid_state', 'Task has open subtasks', 409);
        }
        const result = this.database
          .prepare<[string, string, string, string, string, number]>(
            `UPDATE tasks
             SET state = 'done', completion_summary = ?, artifacts_json = ?, completed_at = ?,
                 updated_at = ?, revision = revision + 1
             WHERE id = ? AND revision = ?`,
          )
          .run(
            input.summary,
            JSON.stringify(input.artifacts),
            timestamp,
            timestamp,
            input.targetId,
            input.expectedRevision,
          );
        this.assertChanged(result.changes, task.revision);
      }

      this.database
        .prepare<[TargetType, string]>('DELETE FROM claims WHERE target_type = ? AND target_id = ?')
        .run(input.targetType, input.targetId);
      this.recordProjectEvent(
        this.projectIdForTarget(input.targetType, input.targetId),
        'work.completed',
        input.agentId,
        {
          targetType: input.targetType,
          targetId: input.targetId,
          summaryPreview: input.summary.slice(0, 240),
          summaryTruncated: input.summary.length > 240,
          artifactCount: input.artifacts.length,
        },
      );
    });

    return input.targetType === 'project'
      ? this.getProject(input.targetId)
      : this.getTask(input.targetId);
  }

  listActivity(projectId: string, limit: number): ActivityEvent[] {
    this.getProject(projectId);
    return this.database
      .prepare<[string, number], ActivityRow>(
        'SELECT * FROM activity_events WHERE project_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(projectId, limit)
      .map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        targetType: row.target_type,
        targetId: row.target_id,
        eventType: row.event_type,
        actor: row.actor,
        data: parseObject(row.data_json),
        createdAt: row.created_at,
      }));
  }

  async backup(destinationDirectory: string): Promise<string> {
    if (!isAbsolute(destinationDirectory)) {
      throw new AppError('bad_request', 'Backup destination must be an absolute path', 400);
    }
    return backupDatabase(this.database, destinationDirectory);
  }

  async backupLatest(destinationDirectory: string): Promise<string> {
    if (!isAbsolute(destinationDirectory)) {
      throw new AppError('bad_request', 'Backup destination must be an absolute path', 400);
    }
    return backupLatestDatabase(this.database, destinationDirectory);
  }

  exportPortable(destinationDirectory: string): string {
    if (!isAbsolute(destinationDirectory)) {
      throw new AppError('bad_request', 'Export destination must be an absolute path', 400);
    }
    const activeClaims = requireRow(
      this.database
        .prepare<[string], CountRow>('SELECT COUNT(*) AS count FROM claims WHERE expires_at > ?')
        .get(now()),
      'Active claim count was not returned',
    ).count;
    if (activeClaims > 0) {
      throw new AppError(
        'conflict',
        'Portable export requires a maintenance window with no active claims',
        409,
        true,
      );
    }
    return exportPortable(this, destinationDirectory);
  }

  private assertTargetAvailable(targetType: TargetType, targetId: string): void {
    if (targetType === 'project') {
      const project = this.getProject(targetId);
      if (project.state !== 'ready') {
        throw new AppError('invalid_state', 'Only ready projects can be claimed', 409);
      }
      if (this.countOpenTasks(targetId) > 0) {
        throw new AppError('invalid_state', 'Claim individual tasks while open tasks exist', 409);
      }
      return;
    }

    const task = this.getTask(targetId);
    const project = this.getProject(task.projectId);
    if (task.state !== 'open' || project.state !== 'ready') {
      throw new AppError('invalid_state', 'Only open tasks in ready projects can be claimed', 409);
    }
    if (this.countOpenChildren(task.id) > 0) {
      throw new AppError('invalid_state', 'Claim open subtasks before their parent task', 409);
    }
  }

  private runImmediate<T>(operation: () => T): T {
    const result = this.database.transaction(operation).immediate();
    this.onMutation();
    return result;
  }

  private countOpenTasks(projectId: string): number {
    return (
      this.database
        .prepare<[string], CountRow>(
          "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND state = 'open'",
        )
        .get(projectId)?.count ?? 0
    );
  }

  private countOpenChildren(taskId: string): number {
    return (
      this.database
        .prepare<[string], CountRow>(
          "SELECT COUNT(*) AS count FROM tasks WHERE parent_id = ? AND state = 'open'",
        )
        .get(taskId)?.count ?? 0
    );
  }

  private projectIdForTarget(targetType: TargetType, targetId: string): string {
    return targetType === 'project'
      ? this.getProject(targetId).id
      : this.getTask(targetId).projectId;
  }

  private getClaim(targetType: TargetType, targetId: string, at = now()): Claim | null {
    const row = this.database
      .prepare<[TargetType, string, string], ClaimRow>(
        `SELECT * FROM claims
         WHERE target_type = ? AND target_id = ? AND expires_at > ?`,
      )
      .get(targetType, targetId, at);
    return row ? this.mapClaim(row) : null;
  }

  private requireOwnedClaim(
    targetType: TargetType,
    targetId: string,
    agentId: string,
    at: string,
  ): Claim {
    const claim = this.getClaim(targetType, targetId, at);
    if (!claim) throw new AppError('conflict', 'Work is not currently claimed', 409, true);
    if (claim.agentId !== agentId) {
      throw new AppError('conflict', `Work is claimed by ${claim.agentId}`, 409, true);
    }
    return claim;
  }

  private assertRevision(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new AppError(
        'revision_conflict',
        `Expected revision ${expected}, current revision is ${actual}`,
        409,
        true,
        {
          expectedRevision: expected,
          currentRevision: actual,
        },
      );
    }
  }

  private assertChanged(changes: number, currentRevision: number): void {
    if (changes === 0) {
      throw new AppError('revision_conflict', 'The resource changed before this write', 409, true, {
        currentRevision,
      });
    }
  }

  private recordProjectEvent(
    projectId: string,
    eventType: string,
    actor: string | null,
    data: Record<string, unknown>,
  ): void {
    const project = this.getProject(projectId);
    const eventTargetType =
      typeof data.targetType === 'string'
        ? data.targetType
        : eventType.startsWith('task.')
          ? 'task'
          : eventType.startsWith('context.')
            ? 'context'
            : 'project';
    const eventTargetId =
      typeof data.targetId === 'string'
        ? data.targetId
        : typeof data.taskId === 'string'
          ? data.taskId
          : projectId;
    this.recordEvent({
      workspaceId: project.workspaceId,
      projectId,
      targetType: eventTargetType,
      targetId: eventTargetId,
      eventType,
      actor,
      data,
    });
  }

  private recordEvent(input: {
    workspaceId: string | null;
    projectId: string | null;
    targetType: string;
    targetId: string;
    eventType: string;
    actor: string | null;
    data: Record<string, unknown>;
  }): void {
    this.database
      .prepare<
        [string | null, string | null, string, string, string, string | null, string, string]
      >(
        `INSERT INTO activity_events
           (workspace_id, project_id, target_type, target_id, event_type, actor, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workspaceId,
        input.projectId,
        input.targetType,
        input.targetId,
        input.eventType,
        input.actor,
        JSON.stringify(input.data),
        now(),
      );
  }

  private mapWorkspace(row: WorkspaceRow): Workspace {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapProject(row: ProjectRow): Project {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      slug: row.slug,
      title: row.title,
      state: row.state,
      prd: row.prd,
      revision: row.revision,
      completionSummary: row.completion_summary,
      artifacts: parseArtifacts(row.artifacts_json),
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claim: this.getClaim('project', row.id),
    };
  }

  private mapContext(row: ContextRow): ContextDocument {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      body: row.body,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapProjectManifest(row: ProjectManifestRow): ProjectManifest {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      slug: row.slug,
      title: row.title,
      state: row.state,
      revision: row.revision,
      artifactCount: parseArtifacts(row.artifacts_json).length,
      hasCompletion: row.completion_summary !== null,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claim: this.getClaim('project', row.id),
      prdSizeBytes: row.prd_size_bytes,
    };
  }

  private mapContextManifest(row: ContextManifestRow): ContextManifest {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sizeBytes: row.size_bytes,
    };
  }

  private mapTask(row: TaskRow): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      parentId: row.parent_id,
      title: row.title,
      body: row.body,
      state: row.state,
      revision: row.revision,
      completionSummary: row.completion_summary,
      artifacts: parseArtifacts(row.artifacts_json),
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claim: this.getClaim('task', row.id),
    };
  }

  private mapTaskManifest(row: TaskManifestRow): TaskManifest {
    return {
      id: row.id,
      projectId: row.project_id,
      parentId: row.parent_id,
      title: row.title,
      state: row.state,
      revision: row.revision,
      artifactCount: parseArtifacts(row.artifacts_json).length,
      hasCompletion: row.completion_summary !== null,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claim: this.getClaim('task', row.id),
      bodySizeBytes: row.body_size_bytes,
    };
  }

  private mapClaim(row: ClaimRow): Claim {
    return {
      targetType: row.target_type,
      targetId: row.target_id,
      agentId: row.agent_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
