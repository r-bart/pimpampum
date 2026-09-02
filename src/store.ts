import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import { backupDatabase, backupLatestDatabase, exportPortable } from './backup.js';
import { AppError } from './errors.js';
import { listActivity } from './store/activity.js';
import * as contexts from './store/contextDocuments.js';
import { getOverview } from './store/overview.js';
import * as projects from './store/projects.js';
import { completionOf } from './store/rows.js';
import * as specs from './store/specs.js';
import { StoreContext, type SyncConflictGuard } from './store/storeContext.js';
import { applySyncState, exportSyncState } from './store/sync.js';
import * as tasks from './store/tasks.js';
import * as work from './store/work.js';
import * as workspaces from './store/workspaces.js';
import type { SyncState } from './syncContract.js';
import type {
  ActivityEvent,
  Claim,
  CompleteWorkInput,
  CompletionDetails,
  ContextDocument,
  ContextManifest,
  ContextOwnerType,
  CreateProjectInput,
  CreateSpecInput,
  CreateTaskInput,
  MarkdownPage,
  OverviewSnapshot,
  Project,
  ProjectManifest,
  Spec,
  SpecManifest,
  Task,
  TaskManifest,
  WorkBundle,
  WorkItem,
  Workspace,
} from './types.js';

/**
 * The one owner of SQLite. HTTP, MCP and CLI reach the domain through this
 * façade; every method delegates to an aggregate module over one shared
 * `StoreContext`, so the public surface, error codes and messages live here
 * while each behaviour lives next to its table under `src/store/`.
 */
export class PimpampumStore {
  private readonly ctx: StoreContext;

  constructor(
    database: Database.Database,
    onMutation: () => void = () => undefined,
    syncConflictGuard: SyncConflictGuard = () => false,
    clock: () => Date = () => new Date(),
  ) {
    this.ctx = new StoreContext(database, onMutation, syncConflictGuard, clock);
  }

  /** Readiness probe for `/health`: false once the connection no longer answers. */
  ping(): boolean {
    try {
      this.ctx.database.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
  setSyncConflictGuard(guard: SyncConflictGuard): void {
    this.ctx.setSyncConflictGuard(guard);
  }
  /** Number of committed writes since this store opened; cheap to poll. */
  get mutationCount(): number {
    return this.ctx.mutationCount;
  }
  close(): void {
    this.ctx.database.close();
  }

  // Workspaces

  registerWorkspace(input: workspaces.RegisterWorkspaceInput): Workspace {
    return workspaces.registerWorkspace(this.ctx, input);
  }
  listWorkspaces(): Workspace[] {
    return workspaces.listWorkspaces(this.ctx);
  }
  getWorkspace(id: string): Workspace {
    return workspaces.getWorkspace(this.ctx, id);
  }
  resolveWorkspace(inputPath: string): Workspace {
    return workspaces.resolveWorkspace(this.ctx, inputPath);
  }

  // Projects

  createProject(input: CreateProjectInput): Project {
    return projects.createProject(this.ctx, input);
  }
  listProjectManifests(input: projects.ListProjectManifestsInput): ProjectManifest[] {
    return projects.listProjectManifests(this.ctx, input);
  }
  getProject(id: string): Project {
    return projects.getProject(this.ctx, id);
  }
  getProjectManifest(id: string): ProjectManifest {
    return projects.getProjectManifest(this.ctx, id);
  }
  getProjectCompletion(id: string): CompletionDetails {
    return completionOf(projects.getProject(this.ctx, id));
  }
  updateProject(input: projects.UpdateProjectInput): Project {
    return projects.updateProject(this.ctx, input);
  }
  completeProject(input: projects.CompleteProjectInput): Project {
    return projects.completeProject(this.ctx, input);
  }
  cancelProject(input: projects.CancelProjectInput): Project {
    return projects.cancelProject(this.ctx, input);
  }

  // Specs

  createSpec(input: CreateSpecInput): Spec {
    return specs.createSpec(this.ctx, input);
  }
  listSpecManifests(input: specs.ListSpecManifestsInput): SpecManifest[] {
    return specs.listSpecManifests(this.ctx, input);
  }
  getSpec(id: string): Spec {
    return specs.getSpec(this.ctx, id);
  }
  getSpecManifest(id: string): SpecManifest {
    return specs.getSpecManifest(this.ctx, id);
  }
  readSpecBody(id: string, offset: number, limit: number): MarkdownPage {
    return specs.readSpecBody(this.ctx, id, offset, limit);
  }
  getSpecCompletion(id: string): CompletionDetails {
    return completionOf(specs.getSpec(this.ctx, id));
  }
  updateSpec(input: specs.UpdateSpecInput): Spec {
    return specs.updateSpec(this.ctx, input);
  }
  cancelSpec(input: specs.CancelSpecInput): Spec {
    return specs.cancelSpec(this.ctx, input);
  }

  // Context documents

  listContextManifests(input: contexts.ListContextManifestsInput): ContextManifest[] {
    return contexts.listContextManifests(this.ctx, input);
  }
  getContextManifest(ownerType: ContextOwnerType, ownerId: string, name: string): ContextManifest {
    return contexts.getContextManifest(this.ctx, ownerType, ownerId, name);
  }
  readContext(ownerType: ContextOwnerType, ownerId: string, name: string): ContextDocument {
    return contexts.readContext(this.ctx, ownerType, ownerId, name);
  }
  readContextPage(
    ownerType: ContextOwnerType,
    ownerId: string,
    name: string,
    offset: number,
    limit: number,
  ): MarkdownPage {
    return contexts.readContextPage(this.ctx, ownerType, ownerId, name, offset, limit);
  }
  putContext(input: contexts.PutContextInput): ContextDocument {
    return contexts.putContext(this.ctx, input);
  }

  // Tasks

  createTask(input: CreateTaskInput): Task {
    return tasks.createTask(this.ctx, input);
  }
  listTaskManifests(input: tasks.ListTaskManifestsInput): TaskManifest[] {
    return tasks.listTaskManifests(this.ctx, input);
  }
  getTask(id: string): Task {
    return tasks.getTask(this.ctx, id);
  }
  getTaskManifest(id: string): TaskManifest {
    return tasks.getTaskManifest(this.ctx, id);
  }
  readTaskBody(id: string, offset: number, limit: number): MarkdownPage {
    return tasks.readTaskBody(this.ctx, id, offset, limit);
  }
  getTaskCompletion(id: string): CompletionDetails {
    return completionOf(tasks.getTask(this.ctx, id));
  }
  updateTask(input: tasks.UpdateTaskInput): Task {
    return tasks.updateTask(this.ctx, input);
  }
  cancelTask(input: tasks.CancelTaskInput): Task {
    return tasks.cancelTask(this.ctx, input);
  }

  // Work

  listWork(input: work.ListWorkInput): WorkItem[] {
    return work.listWork(this.ctx, input);
  }
  startWork(input: work.LeaseInput): WorkBundle {
    return work.startWork(this.ctx, input);
  }
  renewWork(input: work.LeaseInput): Claim {
    return work.renewWork(this.ctx, input);
  }
  releaseWork(input: work.ReleaseWorkInput): void {
    work.releaseWork(this.ctx, input);
  }
  completeWork(input: CompleteWorkInput): Spec | Task {
    return work.completeWork(this.ctx, input);
  }

  // Portfolio and activity

  getOverview(): OverviewSnapshot {
    return getOverview(this.ctx);
  }
  listActivity(projectId: string, limit: number): ActivityEvent[] {
    return listActivity(this.ctx, projectId, limit);
  }

  // Maintenance

  async backup(directory: string): Promise<string> {
    if (!isAbsolute(directory))
      throw new AppError('bad_request', 'Backup destination must be an absolute path', 400);
    return backupDatabase(this.ctx.database, directory);
  }
  async backupLatest(directory: string): Promise<string> {
    if (!isAbsolute(directory))
      throw new AppError('bad_request', 'Backup destination must be an absolute path', 400);
    return backupLatestDatabase(this.ctx.database, directory);
  }
  /** A synchronous maintenance operation: it never starts while a Claim is active. */
  exportPortable(directory: string): string {
    if (!isAbsolute(directory))
      throw new AppError('bad_request', 'Export destination must be an absolute path', 400);
    if (this.ctx.count('SELECT COUNT(*) count FROM claims WHERE expires_at>?', this.ctx.now()) > 0)
      throw new AppError(
        'conflict',
        'Portable export requires a maintenance window with no active Claims',
        409,
        true,
      );
    return exportPortable(this, directory);
  }

  // Shared-folder synchronization

  exportSyncState(): SyncState {
    return exportSyncState(this.ctx);
  }
  applySyncState(state: SyncState): void {
    applySyncState(this.ctx, state);
  }
}
