import type { RuntimeConfig } from './config.js';
import { parseAutomaticBackupStatus, type AutomaticBackupStatus } from './backupContract.js';
import { AppError, type ErrorCode } from './errors.js';
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

const errorCodes = new Set<ErrorCode>([
  'bad_request',
  'not_found',
  'conflict',
  'revision_conflict',
  'invalid_state',
  'unauthorized',
  'payload_too_large',
  'internal_error',
]);

function errorCode(value: string | undefined, status: number): ErrorCode {
  if (value && errorCodes.has(value as ErrorCode)) return value as ErrorCode;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status >= 500) return 'internal_error';
  return 'bad_request';
}

export class PimpampumHttpClient implements PimpampumGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMilliseconds = 10_000,
  ) {}

  health(): Promise<{ status: string; version: string }> {
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

  listSyncConflicts(): Promise<SyncConflictManifest[]> {
    return this.request('/api/v1/settings/sync/conflicts');
  }

  resolveSyncConflict(conflictId: string, choice: 'local' | 'remote'): Promise<SyncStatus> {
    return this.request(
      `/api/v1/settings/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`,
      {
        method: 'POST',
        body: { choice },
        timeoutMilliseconds: 300_000,
      },
    );
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
    return this.request(`/api/v1/work/${input.targetType}/${input.targetId}/claim`, {
      method: 'PUT',
      body: { agentId: input.agentId, leaseSeconds: input.leaseSeconds },
    });
  }

  renewWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    leaseSeconds: number;
  }): Promise<Claim> {
    return this.request(`/api/v1/work/${input.targetType}/${input.targetId}/claim`, {
      method: 'PATCH',
      body: { agentId: input.agentId, leaseSeconds: input.leaseSeconds },
    });
  }

  async releaseWork(input: {
    targetType: TargetType;
    targetId: string;
    agentId: string;
    note: string | null;
  }): Promise<void> {
    await this.request(`/api/v1/work/${input.targetType}/${input.targetId}/claim`, {
      method: 'DELETE',
      body: { agentId: input.agentId, note: input.note },
    });
  }

  completeWork(input: CompleteWorkInput): Promise<Spec | Task> {
    return this.request(`/api/v1/work/${input.targetType}/${input.targetId}/complete`, {
      method: 'POST',
      body: {
        agentId: input.agentId,
        expectedRevision: input.expectedRevision,
        summary: input.summary,
        artifacts: input.artifacts,
      },
    });
  }

  getProject(projectId: string): Promise<ProjectManifest> {
    return this.request(`/api/v1/projects/${projectId}`);
  }

  getProjectManifest(projectId: string): Promise<ProjectManifest> {
    return this.request(`/api/v1/projects/${projectId}/manifest`);
  }

  getProjectCompletion(projectId: string): Promise<CompletionDetails> {
    return this.request(`/api/v1/projects/${projectId}/completion`);
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
    return this.request(`/api/v1/projects/${projectId}`, { method: 'PATCH', body });
  }

  completeProject(input: {
    projectId: string;
    expectedRevision: number;
    summary: string;
    artifacts: CompleteWorkInput['artifacts'];
    actor: string | null;
  }): Promise<Project> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${projectId}/complete`, { method: 'POST', body });
  }

  cancelProject(input: {
    projectId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Promise<Project> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${projectId}/cancel`, { method: 'POST', body });
  }

  createSpec(input: CreateSpecInput): Promise<Spec> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${projectId}/specs`, { method: 'POST', body });
  }

  getSpec(specId: string): Promise<SpecManifest> {
    return this.request(`/api/v1/specs/${specId}`);
  }

  getSpecManifest(specId: string): Promise<SpecManifest> {
    return this.request(`/api/v1/specs/${specId}/manifest`);
  }

  readSpecBody(
    specId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): Promise<MarkdownPage> {
    return this.request(
      `/api/v1/specs/${specId}/body?offsetCodeUnits=${offsetCodeUnits}&limitCodeUnits=${limitCodeUnits}`,
    );
  }

  getSpecCompletion(specId: string): Promise<CompletionDetails> {
    return this.request(`/api/v1/specs/${specId}/completion`);
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
        `/api/v1/projects/${input.projectId}/specs?${query.toString()}`,
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
    return this.request(`/api/v1/specs/${specId}`, { method: 'PATCH', body });
  }

  cancelSpec(input: {
    specId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Promise<Spec> {
    const { specId, ...body } = input;
    return this.request(`/api/v1/specs/${specId}/cancel`, { method: 'POST', body });
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    const { specId, ...body } = input;
    return this.request(`/api/v1/specs/${specId}/tasks`, { method: 'POST', body });
  }

  getTask(taskId: string): Promise<TaskManifest> {
    return this.request(`/api/v1/tasks/${taskId}`);
  }

  getTaskManifest(taskId: string): Promise<TaskManifest> {
    return this.request(`/api/v1/tasks/${taskId}/manifest`);
  }

  readTaskBody(
    taskId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): Promise<MarkdownPage> {
    return this.request(
      `/api/v1/tasks/${taskId}/body?offsetCodeUnits=${offsetCodeUnits}&limitCodeUnits=${limitCodeUnits}`,
    );
  }

  getTaskCompletion(taskId: string): Promise<CompletionDetails> {
    return this.request(`/api/v1/tasks/${taskId}/completion`);
  }

  async listTaskManifests(input: {
    specId: string;
    limit: number;
    offset: number;
  }): Promise<TaskManifest[]> {
    return (
      await this.request<ApiPage<TaskManifest>>(
        `/api/v1/specs/${input.specId}/tasks?limit=${input.limit}&offset=${input.offset}`,
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
    return this.request(`/api/v1/tasks/${taskId}`, { method: 'PATCH', body });
  }

  cancelTask(input: {
    taskId: string;
    expectedRevision: number;
    reason: string;
    actor: string | null;
  }): Promise<Task> {
    const { taskId, ...body } = input;
    return this.request(`/api/v1/tasks/${taskId}/cancel`, { method: 'POST', body });
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
    return this.request(`${this.contextBasePath(ownerType, ownerId)}/${encodeURIComponent(name)}`);
  }

  readContextPage(
    ownerType: ContextOwnerType,
    ownerId: string,
    name: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): Promise<MarkdownPage> {
    return this.request(
      `${this.contextBasePath(ownerType, ownerId)}/${encodeURIComponent(name)}/body?offsetCodeUnits=${offsetCodeUnits}&limitCodeUnits=${limitCodeUnits}`,
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
    return this.request(`${this.contextBasePath(ownerType, ownerId)}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body,
    });
  }

  listActivity(projectId: string, limit: number): Promise<ActivityEvent[]> {
    return this.request(`/api/v1/projects/${projectId}/activity?limit=${limit}`);
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
    return `/api/v1/${ownerType === 'workspace' ? 'workspaces' : 'projects'}/${ownerId}/context`;
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
      throw new AppError('internal_error', 'Pimpampum is unavailable', 503, true);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      payload = undefined;
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

    const invalidResponse = () =>
      new AppError('internal_error', 'Pimpampum returned an invalid response', 502, true);
    if (path === '/health') {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        typeof (payload as { status?: unknown }).status !== 'string' ||
        typeof (payload as { version?: unknown }).version !== 'string'
      ) {
        throw invalidResponse();
      }
      return payload as T;
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
