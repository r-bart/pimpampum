export type ProjectState = 'draft' | 'open' | 'paused' | 'done' | 'cancelled';
export type SpecState = 'draft' | 'ready' | 'done' | 'cancelled';
export type TaskState = 'open' | 'done' | 'cancelled';
export type TargetType = 'spec' | 'task';
export type ContextOwnerType = 'workspace' | 'project';

/** `/health` body. `ready` is false and the HTTP status 503 when the SQLite probe fails. */
export interface HealthStatus {
  status: 'ok' | 'degraded';
  version: string;
  ready: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Claim {
  targetType: TargetType;
  targetId: string;
  agentId: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactReference {
  label: string | null;
  uri: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  state: ProjectState;
  revision: number;
  completionSummary: string | null;
  artifacts: ArtifactReference[];
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectManifest = Omit<Project, 'artifacts' | 'completionSummary'> & {
  artifactCount: number;
  hasCompletion: boolean;
  specCount: number;
  draftSpecCount: number;
  readySpecCount: number;
  terminalSpecCount: number;
};

export interface Spec {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  state: SpecState;
  revision: number;
  completionSummary: string | null;
  artifacts: ArtifactReference[];
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  claim: Claim | null;
}

export type SpecManifest = Omit<Spec, 'body' | 'artifacts' | 'completionSummary'> & {
  bodySizeBytes: number;
  artifactCount: number;
  hasCompletion: boolean;
  taskCount: number;
  openTaskCount: number;
  terminalTaskCount: number;
};

export interface ContextDocument {
  id: string;
  ownerType: ContextOwnerType;
  ownerId: string;
  name: string;
  body: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ContextManifest = Omit<ContextDocument, 'body'> & { sizeBytes: number };

export interface ContextManifestPage {
  items: ContextManifest[];
  hasMore: boolean;
}

export interface Task {
  id: string;
  specId: string;
  parentId: string | null;
  title: string;
  body: string | null;
  state: TaskState;
  revision: number;
  completionSummary: string | null;
  artifacts: ArtifactReference[];
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  claim: Claim | null;
}

export type TaskManifest = Omit<Task, 'body' | 'artifacts' | 'completionSummary'> & {
  bodySizeBytes: number;
  artifactCount: number;
  hasCompletion: boolean;
  subtaskCount: number;
  openSubtaskCount: number;
};

export interface MarkdownPage {
  body: string;
  offsetCodeUnits: number;
  totalCodeUnits: number;
  sizeBytes: number;
  hasMore: boolean;
}

export interface CompletionDetails {
  completionSummary: string | null;
  artifacts: ArtifactReference[];
  completedAt: string | null;
}

export interface ActivityEvent {
  id: number;
  workspaceId: string | null;
  projectId: string | null;
  specId: string | null;
  targetType: string;
  targetId: string;
  eventType: string;
  actor: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface WorkItem {
  targetType: TargetType;
  targetId: string;
  workspaceId: string;
  projectId: string;
  projectTitle: string;
  specId: string;
  specTitle: string;
  taskId: string | null;
  taskTitle: string | null;
  parentTaskId: string | null;
  revision: number;
}

export interface WorkBundle {
  claim: Claim;
  workspace: Workspace;
  project: ProjectManifest;
  spec: SpecManifest;
  task: TaskManifest | null;
  workspaceContext: ContextManifestPage;
  projectContext: ContextManifestPage;
}

export type OverviewStatus = 'active' | 'available' | 'complete' | 'draft' | 'paused' | 'empty';
export type OverviewProjectStatus = Exclude<OverviewStatus, 'empty'>;

export interface OverviewCounts {
  workspaces: number;
  projects: number;
  specs: number;
  draftProjects: number;
  openProjects: number;
  pausedProjects: number;
  completedProjects: number;
  cancelledProjects: number;
  openTasks: number;
  completedTasks: number;
  cancelledTasks: number;
  activeClaims: number;
  availableWork: number;
}

export interface OverviewProject {
  id: string;
  workspace: Pick<Workspace, 'id' | 'name' | 'rootPath'>;
  slug: string;
  title: string;
  lifecycleState: ProjectState;
  status: OverviewProjectStatus;
  specCount: number;
  openTaskCount: number;
  completedTaskCount: number;
  activeClaimCount: number;
  availableWorkCount: number;
  updatedAt: string;
}

export interface OverviewActiveWork {
  targetType: TargetType;
  targetId: string;
  workspaceId: string;
  projectId: string;
  projectTitle: string;
  specId: string;
  specTitle: string;
  taskId: string | null;
  taskTitle: string | null;
  agentId: string;
  expiresAt: string;
}

export interface OverviewSpec {
  id: string;
  projectId: string;
  projectTitle: string;
  projectLifecycleState: ProjectState;
  workspace: Pick<Workspace, 'id' | 'name' | 'rootPath'>;
  slug: string;
  title: string;
  lifecycleState: SpecState;
  taskCount: number;
  openTaskCount: number;
  completedTaskCount: number;
  activeClaimCount: number;
  updatedAt: string;
}

export interface OverviewSnapshot {
  status: OverviewStatus;
  counts: OverviewCounts;
  projects: OverviewProject[];
  projectsTruncated: boolean;
  specs: OverviewSpec[];
  specsTruncated: boolean;
  activeWork: OverviewActiveWork[];
  activeWorkTruncated: boolean;
}

export interface Overview extends OverviewSnapshot {
  daemon: {
    version: string;
    startedAt: string;
    uptimeSeconds: number;
  };
  generatedAt: string;
}

export interface CreateProjectInput {
  workspaceId: string;
  slug: string;
  title: string;
  actor: string | null;
}

export interface CreateSpecInput {
  projectId: string;
  slug: string;
  title: string;
  body: string;
  actor: string | null;
}

export interface CreateTaskInput {
  specId: string;
  parentId: string | null;
  title: string;
  body: string | null;
  actor: string | null;
}

export interface CompleteWorkInput {
  targetType: TargetType;
  targetId: string;
  agentId: string;
  expectedRevision: number;
  summary: string;
  artifacts: ArtifactReference[];
}

export interface PimpampumGateway {
  listWorkspaces(): Workspace[] | Promise<Workspace[]>;
  resolveWorkspace(rootPath: string): Workspace | Promise<Workspace>;
  listWork(input: {
    workspaceId: string | null;
    projectId: string | null;
    specId: string | null;
    limit: number;
  }): WorkItem[] | Promise<WorkItem[]>;
  startWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): WorkBundle | Promise<WorkBundle>;
  renewWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): Claim | Promise<Claim>;
  releaseWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    note: string | null;
  }): void | Promise<void>;
  completeWork(input: CompleteWorkInput): Spec | Task | Promise<Spec | Task>;
  getProjectManifest(projectId: string): ProjectManifest | Promise<ProjectManifest>;
  getProjectCompletion(projectId: string): CompletionDetails | Promise<CompletionDetails>;
  listProjectManifests(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): ProjectManifest[] | Promise<ProjectManifest[]>;
  createProject(input: CreateProjectInput): Project | Promise<Project>;
  updateProject(input: {
    projectId: string;
    title: string | null;
    state: Exclude<ProjectState, 'done' | 'cancelled'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Project | Promise<Project>;
  completeProject(input: {
    projectId: string;
    expectedRevision: number;
    summary: string;
    artifacts: ArtifactReference[];
    actor: string | null;
  }): Project | Promise<Project>;
  cancelProject(input: {
    projectId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Project | Promise<Project>;
  createSpec(input: CreateSpecInput): Spec | Promise<Spec>;
  getSpecManifest(specId: string): SpecManifest | Promise<SpecManifest>;
  readSpecBody(
    specId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): MarkdownPage | Promise<MarkdownPage>;
  getSpecCompletion(specId: string): CompletionDetails | Promise<CompletionDetails>;
  listSpecManifests(input: {
    projectId: string;
    state: SpecState | null;
    limit: number;
    offset: number;
  }): SpecManifest[] | Promise<SpecManifest[]>;
  updateSpec(input: {
    specId: string;
    title: string | null;
    body: string | null;
    state: Exclude<SpecState, 'done' | 'cancelled'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Spec | Promise<Spec>;
  cancelSpec(input: {
    specId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Spec | Promise<Spec>;
  createTask(input: CreateTaskInput): Task | Promise<Task>;
  getTaskManifest(taskId: string): TaskManifest | Promise<TaskManifest>;
  readTaskBody(
    taskId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): MarkdownPage | Promise<MarkdownPage>;
  getTaskCompletion(taskId: string): CompletionDetails | Promise<CompletionDetails>;
  listTaskManifests(input: {
    specId: string;
    limit: number;
    offset: number;
  }): TaskManifest[] | Promise<TaskManifest[]>;
  updateTask(input: {
    taskId: string;
    title: string | null;
    body: string | null | undefined;
    expectedRevision: number;
    actor: string | null;
  }): Task | Promise<Task>;
  cancelTask(input: {
    taskId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Task | Promise<Task>;
  listContextManifests(input: {
    ownerType: ContextOwnerType;
    ownerId: string;
    limit: number;
    offset: number;
  }): ContextManifest[] | Promise<ContextManifest[]>;
  getContextManifest(
    ownerType: ContextOwnerType,
    ownerId: string,
    name: string,
  ): ContextManifest | Promise<ContextManifest>;
  readContextPage(
    ownerType: ContextOwnerType,
    ownerId: string,
    name: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): MarkdownPage | Promise<MarkdownPage>;
  putContext(input: {
    ownerType: ContextOwnerType;
    ownerId: string;
    name: string;
    body: string;
    expectedRevision: number | null;
    actor: string | null;
  }): ContextDocument | Promise<ContextDocument>;
  listActivity(projectId: string, limit: number): ActivityEvent[] | Promise<ActivityEvent[]>;
}

type SynchronousGateway<T> = {
  [Key in keyof T]: T[Key] extends (...args: infer Arguments) => infer Result
    ? (...args: Arguments) => Awaited<Result>
    : never;
};

export type PimpampumHttpGateway = SynchronousGateway<PimpampumGateway> & {
  /** Readiness probe: true when `SELECT 1` succeeds against the live database. */
  ping(): boolean;
  getOverview(): OverviewSnapshot;
  registerWorkspace(input: {
    id: string;
    name: string;
    rootPath: string;
    actor: string | null;
  }): Workspace;
  backup(destinationDirectory: string): Promise<string>;
  exportPortable(destinationDirectory: string): string;
};
