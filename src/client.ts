import type { RuntimeConfig } from './config.js';
import { parseAutomaticBackupStatus, type AutomaticBackupStatus } from './backupContract.js';
import { AppError, type ErrorCode } from './errors.js';
import { parseOverview } from './overviewContract.js';
import type {
  ActivityEvent,
  Claim,
  CompleteWorkInput,
  CompletionDetails,
  ContextDocument,
  ContextManifest,
  CreateProjectInput,
  CreateTaskInput,
  MarkdownPage,
  Overview,
  Project,
  ProjectManifest,
  PimpampumGateway,
  ProjectState,
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

  listWork(input: { workspaceId: string | null; limit: number }): Promise<WorkItem[]> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.workspaceId) query.set('workspaceId', input.workspaceId);
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

  completeWork(input: CompleteWorkInput): Promise<Project | Task> {
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

  getProject(projectId: string): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}`);
  }

  getProjectManifest(projectId: string): Promise<ProjectManifest> {
    return this.request(`/api/v1/projects/${projectId}/manifest`);
  }

  readProjectPrd(
    projectId: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): Promise<MarkdownPage> {
    return this.request(
      `/api/v1/projects/${projectId}/prd?offsetCodeUnits=${offsetCodeUnits}&limitCodeUnits=${limitCodeUnits}`,
    );
  }

  getProjectCompletion(projectId: string): Promise<CompletionDetails> {
    return this.request(`/api/v1/projects/${projectId}/completion`);
  }

  listProjectManifests(input: {
    workspaceId: string | null;
    state: ProjectState | null;
    limit: number;
    offset: number;
  }): Promise<ProjectManifest[]> {
    const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
    if (input.workspaceId) query.set('workspaceId', input.workspaceId);
    if (input.state) query.set('state', input.state);
    return this.request(`/api/v1/projects?${query.toString()}`);
  }

  createProject(input: CreateProjectInput): Promise<Project> {
    return this.request('/api/v1/projects', { method: 'POST', body: input });
  }

  updateProject(input: {
    projectId: string;
    title: string | null;
    state: Exclude<ProjectState, 'done'> | null;
    expectedRevision: number;
    actor: string | null;
  }): Promise<Project> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${projectId}`, { method: 'PATCH', body });
  }

  updatePrd(input: {
    projectId: string;
    prd: string;
    expectedRevision: number;
    actor: string | null;
  }): Promise<Project> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${projectId}/prd`, { method: 'PUT', body });
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    const { projectId, ...body } = input;
    return this.request(`/api/v1/projects/${projectId}/tasks`, { method: 'POST', body });
  }

  getTask(taskId: string): Promise<Task> {
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

  listTaskManifests(input: {
    projectId: string;
    limit: number;
    offset: number;
  }): Promise<TaskManifest[]> {
    return this.request(
      `/api/v1/projects/${input.projectId}/tasks?limit=${input.limit}&offset=${input.offset}`,
    );
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

  listContextManifests(input: {
    projectId: string;
    limit: number;
    offset: number;
  }): Promise<ContextManifest[]> {
    return this.request(
      `/api/v1/projects/${input.projectId}/context?limit=${input.limit}&offset=${input.offset}`,
    );
  }

  readContext(projectId: string, name: string): Promise<ContextDocument> {
    return this.request(`/api/v1/projects/${projectId}/context/${encodeURIComponent(name)}`);
  }

  readContextPage(
    projectId: string,
    name: string,
    offsetCodeUnits: number,
    limitCodeUnits: number,
  ): Promise<MarkdownPage> {
    return this.request(
      `/api/v1/projects/${projectId}/context/${encodeURIComponent(name)}/body?offsetCodeUnits=${offsetCodeUnits}&limitCodeUnits=${limitCodeUnits}`,
    );
  }

  putContext(input: {
    projectId: string;
    name: string;
    body: string;
    expectedRevision: number | null;
    actor: string | null;
  }): Promise<ContextDocument> {
    const { projectId, name, ...body } = input;
    return this.request(`/api/v1/projects/${projectId}/context/${encodeURIComponent(name)}`, {
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
