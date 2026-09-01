import type { RuntimeConfig } from './config.js';
import { parseAutomaticBackupStatus, type AutomaticBackupStatus } from './backupContract.js';
import { AppError, errorCodeForHttpStatus, isErrorCode, type ErrorCode } from './errors.js';
import { parseOverview } from './overviewContract.js';
import type { SyncConflictManifest, SyncStatus } from './syncContract.js';
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
  Overview,
  Project,
  ProjectManifest,
  PimpampumGateway,
  ProjectState,
  Spec,
  SpecManifest,
  SpecState,
  Task,
  TaskManifest,
  TargetType,
  WorkBundle,
  WorkItem,
  Workspace,
} from './types.js';

interface ApiEnvelope<T> {
  data: T;
}

interface ApiPage<T> {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

/** `/health` as the client sees it; `ready` is absent only on a daemon older than this client. */
export interface HealthReport {
  status: string;
  version: string;
  ready?: boolean;
}

function errorCode(value: string | undefined, status: number): ErrorCode {
  return isErrorCode(value) ? value : errorCodeForHttpStatus(status);
}

/** Every caller-supplied path segment is encoded so an id can never rewrite the route. */
const segment = (value: string): string => encodeURIComponent(value);

function isHealthReport(payload: unknown): payload is HealthReport {
  if (typeof payload !== 'object' || payload === null) return false;
  const { status, version, ready } = payload as Record<string, unknown>;
  return (
    typeof status === 'string' &&
    typeof version === 'string' &&
    (ready === undefined || typeof ready === 'boolean')
  );
}

export class PimpampumHttpClient implements PimpampumGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMilliseconds = 10_000,
  ) {}

  health(): Promise<HealthReport> {
    return this.request('/health', { authenticated: false });
  }

  async getOverview(): Promise<Overview> {
    return parseOverview(await this.request<unknown>('/api/v1/overview'));
  }

  async getAutomaticBackupStatus(): Promise<AutomaticBackupStatus> {
    return parseAutomaticBackupStatus(await this.request<unknown>('/api/v1/settings/backup'));
  }

  async configureAutomaticBackup(directory: string): Promise<AutomaticBackupStatus> {
    return parseAutomaticBackupStatus(
      await this.request<unknown>('/api/v1/settings/backup', {
        method: 'PUT',
        body: { directory },
        timeoutMilliseconds: 300_000,
      }),
    );
  }

  async retryAutomaticBackup(): Promise<AutomaticBackupStatus> {
    return parseAutomaticBackupStatus(
      await this.request<unknown>('/api/v1/settings/backup/retry', {
        method: 'POST',
        timeoutMilliseconds: 300_000,
      }),
    );
  }

  async disableAutomaticBackup(): Promise<AutomaticBackupStatus> {
    return parseAutomaticBackupStatus(
      await this.request<unknown>('/api/v1/settings/backup', { method: 'DELETE' }),
    );
  }

  getSyncStatus(): Promise<SyncStatus> {
    return this.request('/api/v1/settings/sync');
  }

  configureSync(directory: string, deviceId: string): Promise<SyncStatus> {
    return this.request('/api/v1/settings/sync', {
      method: 'PUT',
      body: { directory, deviceId },
      timeoutMilliseconds: 300_000,
    });
  }

  reconcileSync(): Promise<SyncStatus> {
    return this.request('/api/v1/settings/sync/reconcile', {
      method: 'POST',
      timeoutMilliseconds: 300_000,
    });
  }

  pauseSync(): Promise<SyncStatus> {
    return this.request('/api/v1/settings/sync/pause', { method: 'POST' });
  }

  resumeSync(): Promise<SyncStatus> {
    return this.request('/api/v1/settings/sync/resume', {
      method: 'POST',
      timeoutMilliseconds: 300_000,
    });
  }

  forgetSync(): Promise<SyncStatus> {
    return this.request('/api/v1/settings/sync', { method: 'DELETE' });
  }

  async listSyncConflicts(limit = 50, offset = 0): Promise<SyncConflictManifest[]> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return (
      await this.request<ApiPage<SyncConflictManifest>>(
        `/api/v1/settings/sync/conflicts?${query.toString()}`,
      )
    ).items;
  }

  resolveSyncConflict(conflictId: string, choice: 'local' | 'remote'): Promise<SyncStatus> {
    return this.request(`/api/v1/settings/sync/conflicts/${segment(conflictId)}/resolve`, {
      method: 'POST',
      body: { choice },
      timeoutMilliseconds: 300_000,
    });
  }

  listWorkspaces(): Promise<Workspace[]> {
    return this.request('/api/v1/workspaces');
  }

  registerWorkspace(input: { id: string; name: string; rootPath: string }): Promise<Workspace> {
    return this.request('/api/v1/workspaces', { method: 'POST', body: input });
  }

  resolveWorkspace(rootPath: string): Promise<Workspace> {
    return this.request('/api/v1/workspaces/resolve', {
      method: 'POST',
      body: { path: rootPath },
    });
  }

  listWork(input: {
    workspaceId: string | null;
    projectId: string | null;
    specId: string | null;
    limit: number;
  }): Promise<WorkItem[]> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.workspaceId) query.set('workspaceId', input.workspaceId);
    if (input.projectId) query.set('projectId', input.projectId);
    if (input.specId) query.set('specId', input.specId);
    return this.request(`/api/v1/work?${query.toString()}`);
  }

  startWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): Promise<WorkBundle> {
    return this.request(
      `/api/v1/work/${segment(input.targetType)}/${segment(input.targetId)}/claim`,
      {
        method: 'PUT',
        body: { agentId: input.agentId, leaseSeconds: input.leaseSeconds },
      },
    );
  }

  renewWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): Promise<Claim> {
    return this.request(
      `/api/v1/work/${segment(input.targetType)}/${segment(input.targetId)}/claim`,
      {
        method: 'PATCH',
        body: { agentId: input.agentId, leaseSeconds: input.leaseSeconds },
      },
    );
  }

  async releaseWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    note: string | null;
  }): Promise<void> {
    await this.request(
      `/api/v1/work/${segment(input.targetType)}/${segment(input.targetId)}/claim`,
      {
        method: 'DELETE',
        body: { agentId: input.agentId, note: input.note },
      },
    );
  }

  completeWork(input: CompleteWorkInput): Promise<Spec | Task> {
    return this.request(
      `/api/v1/work/${segment(input.targetType)}/${segment(input.targetId)}/complete`,
      {
        method: 'POST',
        body: {
          agentId: input.agentId,
          expectedRevision: input.expectedRevision,
          summary: input.summary,
          artifacts: input.artifacts,
        },
      },
    );
  }

  getProject(projectId: string): Promise<ProjectManifest> {
    return this.getProjectManifest(projectId);
  }

  getProjectManifest(projectId: string): Promise<ProjectManifest> {
    return this.request(`/api/v1/projects/${segment(projectId)}/manifest`);
  }

  getProjectCompletion(projectId: string): Promise<CompletionDetails> {
    return this.request(`/api/v1/projects/${segment(projectId)}/completion`);
  }

  async listProjectManifests(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): Promise<ProjectManifest[]> {
    const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
    if (input.workspaceId) query.set('workspaceId', input.workspaceId);
    if (input.state) query.set('state', input.state);
    return (await this.request<ApiPage<ProjectManifest>>(`/api/v1/projects?${query.toString()}`))
      .items;
  }

  createProject(input: CreateProjectInput): Promise<Project> {
    return this.request('/api/v1/projects', { method: 'POST', body: input });
  }

  updateProject(input: {
    projectId: string;
    title: string | null;
    state: Exclude<ProjectState, 'done' | 'cancelled'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Promise<Project> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${segment(projectId)}`, { method: 'PATCH', body });
  }

  completeProject(input: {
    projectId: string;
    expectedRevision: number;
    summary: string;
    artifacts: CompleteWorkInput['artifacts'];
    actor: string | null;
  }): Promise<Project> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${segment(projectId)}/complete`, {
      method: 'POST',
      body,
    });
  }

  cancelProject(input: {
    projectId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Promise<Project> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${segment(projectId)}/cancel`, { method: 'POST', body });
  }

  createSpec(input: CreateSpecInput): Promise<Spec> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${segment(projectId)}/specs`, { method: 'POST', body });
  }

  getSpec(specId: string): Promise<SpecManifest> {
    return this.getSpecManifest(specId);
  }

  getSpecManifest(specId: string): Promise<SpecManifest> {
    return this.request(`/api/v1/specs/${segment(specId)}/manifest`);
  }

  readSpecBody(
    specId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): Promise<MarkdownPage> {
    return this.request(
      `/api/v1/specs/${segment(specId)}/body?offsetCodeUnits=${offsetCodeUnits}&limitCodeUnits=${limitCodeUnits}`,
    );
  }

  getSpecCompletion(specId: string): Promise<CompletionDetails> {
    return this.request(`/api/v1/specs/${segment(specId)}/completion`);
  }

  async listSpecManifests(input: {
    projectId: string;
    state: SpecState | null;
    limit: number;
    offset: number;
  }): Promise<SpecManifest[]> {
    const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
    if (input.state) query.set('state', input.state);
    return (
      await this.request<ApiPage<SpecManifest>>(
        `/api/v1/projects/${segment(input.projectId)}/specs?${query.toString()}`,
      )
    ).items;
  }

  updateSpec(input: {
    specId: string;
    title: string | null;
    body: string | null;
    state: Exclude<SpecState, 'done' | 'cancelled'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Promise<Spec> {
    const { specId, ...body } = input;
    return this.request(`/api/v1/specs/${segment(specId)}`, { method: 'PATCH', body });
  }

  cancelSpec(input: {
    specId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Promise<Spec> {
    const { specId, ...body } = input;
    return this.request(`/api/v1/specs/${segment(specId)}/cancel`, { method: 'POST', body });
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    const { specId, ...body } = input;
    return this.request(`/api/v1/specs/${segment(specId)}/tasks`, { method: 'POST', body });
  }

  getTask(taskId: string): Promise<TaskManifest> {
    return this.getTaskManifest(taskId);
  }

  getTaskManifest(taskId: string): Promise<TaskManifest> {
    return this.request(`/api/v1/tasks/${segment(taskId)}/manifest`);
  }

  readTaskBody(
    taskId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): Promise<MarkdownPage> {
    return this.request(
      `/api/v1/tasks/${segment(taskId)}/body?offsetCodeUnits=${offsetCodeUnits}&limitCodeUnits=${limitCodeUnits}`,
    );
  }

  getTaskCompletion(taskId: string): Promise<CompletionDetails> {
    return this.request(`/api/v1/tasks/${segment(taskId)}/completion`);
  }

  async listTaskManifests(input: {
    specId: string;
    limit: number;
    offset: number;
  }): Promise<TaskManifest[]> {
    return (
      await this.request<ApiPage<TaskManifest>>(
        `/api/v1/specs/${segment(input.specId)}/tasks?limit=${input.limit}&offset=${input.offset}`,
      )
    ).items;
  }

  updateTask(input: {
    taskId: string;
    title: string | null;
    body: string | null | undefined;
    expectedRevision: number;
    actor: string | null;
  }): Promise<Task> {
    const { taskId, ...body } = input;
    return this.request(`/api/v1/tasks/${segment(taskId)}`, { method: 'PATCH', body });
  }

  cancelTask(input: {
    taskId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Promise<Task> {
    const { taskId, ...body } = input;
    return this.request(`/api/v1/tasks/${segment(taskId)}/cancel`, { method: 'POST', body });
  }

  async listContextManifests(input: {
    ownerType: ContextOwnerType;
    ownerId: string;
    limit: number;
    offset: number;
  }): Promise<ContextManifest[]> {
    const base = this.contextBasePath(input.ownerType, input.ownerId);
    return (
      await this.request<ApiPage<ContextManifest>>(
        `${base}?limit=${input.limit}&offset=${input.offset}`,
      )
    ).items;
  }

  getContextManifest(
    ownerType: ContextOwnerType,
    ownerId: string,
    name: string,
  ): Promise<ContextManifest> {
    return this.request(`${this.contextBasePath(ownerType, ownerId)}/${segment(name)}`);
  }

  readContextPage(
    ownerType: ContextOwnerType,
    ownerId: string,
    name: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): Promise<MarkdownPage> {
    return this.request(
      `${this.contextBasePath(ownerType, ownerId)}/${segment(name)}/body?offsetCodeUnits=${offsetCodeUnits}&limitCodeUnits=${limitCodeUnits}`,
    );
  }

  putContext(input: {
    ownerType: ContextOwnerType;
    ownerId: string;
    name: string;
    body: string;
    expectedRevision: number | null;
    actor: string | null;
  }): Promise<ContextDocument> {
    const { ownerType, ownerId, name, ...body } = input;
    return this.request(`${this.contextBasePath(ownerType, ownerId)}/${segment(name)}`, {
      method: 'PUT',
      body,
    });
  }

  listActivity(projectId: string, limit: number): Promise<ActivityEvent[]> {
    return this.request(`/api/v1/projects/${segment(projectId)}/activity?limit=${limit}`);
  }

  backup(directory: string): Promise<{ path: string }> {
    return this.request('/api/v1/admin/backup', {
      method: 'POST',
      body: { directory },
      timeoutMilliseconds: 300_000,
    });
  }

  exportPortable(directory: string): Promise<{ path: string }> {
    return this.request('/api/v1/admin/export', {
      method: 'POST',
      body: { directory },
      timeoutMilliseconds: 300_000,
    });
  }

  private contextBasePath(ownerType: ContextOwnerType, ownerId: string): string {
    return `/api/v1/${ownerType === 'workspace' ? 'workspaces' : 'projects'}/${segment(ownerId)}/context`;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      authenticated?: boolean;
      timeoutMilliseconds?: number;
    } = {},
  ): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    if (options.authenticated !== false) headers.set('authorization', `Bearer ${this.token}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    const requestInit: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMilliseconds ?? this.timeoutMilliseconds),
    };
    if (options.body !== undefined) requestInit.body = JSON.stringify(options.body);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), requestInit);
    } catch {
      throw new AppError(
        'unavailable',
        'The Pimpampum daemon did not answer on its local address',
        503,
        true,
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      payload = undefined;
    }

    const invalidResponse = () =>
      new AppError('internal_error', 'Pimpampum returned an invalid response', 502, true);
    // A degraded daemon answers 503 with the same body; the report is more useful than
    // a bare status code, so it is returned instead of thrown.
    if (path === '/health' && (response.ok || response.status === 503)) {
      if (!isHealthReport(payload)) throw invalidResponse();
      return payload as T;
    }

    if (!response.ok) {
      const errorPayload = (payload ?? {}) as ApiErrorEnvelope;
      throw new AppError(
        errorCode(errorPayload.error?.code, response.status),
        errorPayload.error?.message ?? `HTTP ${response.status}`,
        response.status,
        errorPayload.error?.retryable ?? response.status >= 500,
        errorPayload.error?.details ?? {},
      );
    }

    if (
      typeof payload !== 'object' ||
      payload === null ||
      !Object.prototype.hasOwnProperty.call(payload, 'data')
    ) {
      throw invalidResponse();
    }
    return (payload as ApiEnvelope<T>).data;
  }
}

export function createHttpClient(config: RuntimeConfig): PimpampumHttpClient {
  return new PimpampumHttpClient(config.baseUrl, config.token);
}
