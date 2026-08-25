export type ProjectState = 'draft' | 'ready' | 'done';
export type TaskState = 'open' | 'done';
export type TargetType = 'project' | 'task';

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
  prd: string;
  revision: number;
  completionSummary: string | null;
  artifacts: ArtifactReference[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  claim: Claim | null;
}

export type ProjectManifest = Omit<Project, 'prd' | 'artifacts' | 'completionSummary'> & {
  prdSizeBytes: number;
  artifactCount: number;
  hasCompletion: boolean;
};

export interface ContextDocument {
  id: string;
  projectId: string;
  name: string;
  body: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ContextManifest = Omit<ContextDocument, 'body'> & { sizeBytes: number };

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  body: string | null;
  state: TaskState;
  revision: number;
  completionSummary: string | null;
  artifacts: ArtifactReference[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  claim: Claim | null;
}

export type TaskManifest = Omit<Task, 'body' | 'artifacts' | 'completionSummary'> & {
  bodySizeBytes: number;
  artifactCount: number;
  hasCompletion: boolean;
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
  taskId: string | null;
  taskTitle: string | null;
  parentTaskId: string | null;
  revision: number;
}

export interface WorkBundle {
  claim: Claim;
  workspace: Workspace;
  project: ProjectManifest;
  task: TaskManifest | null;
  context: Array<
    Pick<ContextDocument, 'id' | 'name' | 'revision' | 'updatedAt'> & { sizeBytes: number }
  >;
  contextHasMore: boolean;
}

export type OverviewStatus = 'active' | 'available' | 'complete' | 'draft' | 'empty';
export type OverviewProjectStatus = Exclude<OverviewStatus, 'empty'>;

export interface OverviewCounts {
  workspaces: number;
  projects: number;
  draftProjects: number;
  readyProjects: number;
  completedProjects: number;
  openTasks: number;
  completedTasks: number;
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
  taskId: string | null;
  taskTitle: string | null;
  agentId: string;
  expiresAt: string;
}

export interface OverviewSnapshot {
  status: OverviewStatus;
  counts: OverviewCounts;
  projects: OverviewProject[];
  projectsTruncated: boolean;
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
  prd: string;
  state: Exclude<ProjectState, 'done'>;
  actor: string | null;
}

export interface CreateTaskInput {
  projectId: string;
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
  listWork(input: { workspaceId: string | null; limit: number }): WorkItem[] | Promise<WorkItem[]>;
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
  completeWork(input: CompleteWorkInput): Project | Task | Promise<Project | Task>;
  getProject(projectId: string): Project | Promise<Project>;
  getProjectManifest(projectId: string): ProjectManifest | Promise<ProjectManifest>;
  readProjectPrd(
    projectId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): MarkdownPage | Promise<MarkdownPage>;
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
    state: Exclude<ProjectState, 'done'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Project | Promise<Project>;
  updatePrd(input: {
    projectId: string;
    prd: string;
    expectedRevision: number;
    actor: string | null;
  }): Project | Promise<Project>;
  createTask(input: CreateTaskInput): Task | Promise<Task>;
  getTask(taskId: string): Task | Promise<Task>;
  getTaskManifest(taskId: string): TaskManifest | Promise<TaskManifest>;
  readTaskBody(
    taskId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): MarkdownPage | Promise<MarkdownPage>;
  getTaskCompletion(taskId: string): CompletionDetails | Promise<CompletionDetails>;
  listTaskManifests(input: {
    projectId: string;
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
  listContextManifests(input: {
    projectId: string;
    limit: number;
    offset: number;
  }): ContextManifest[] | Promise<ContextManifest[]>;
  readContext(projectId: string, name: string): ContextDocument | Promise<ContextDocument>;
  readContextPage(
    projectId: string,
    name: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): MarkdownPage | Promise<MarkdownPage>;
  putContext(input: {
    projectId: string;
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
