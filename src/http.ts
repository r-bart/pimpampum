import { timingSafeEqual } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodType } from 'zod';
import type { RuntimeConfig } from './config.js';
import type { AutomaticBackupGateway } from './backupContract.js';
import { AppError, asAppError } from './errors.js';
import { MCP_HTTP_BODY_LIMIT } from './limits.js';
import { createPimpampumMcpHandler } from './mcp.js';
import { openApiDocument } from './openapi.js';
import {
  cancelInputSchema,
  claimInputSchema,
  completeProjectInputSchema,
  completeWorkInputSchema,
  createProjectSchema,
  createSpecSchema,
  createTaskSchema,
  directoryInputSchema,
  idSchema,
  limitQuerySchema,
  markdownPageQuerySchema,
  paginationQuerySchema,
  projectStateSchema,
  putContextSchema,
  registerWorkspaceSchema,
  releaseInputSchema,
  resolveWorkspaceInputSchema,
  slugSchema,
  specStateSchema,
  targetTypeSchema,
  updateProjectSchema,
  updateSpecSchema,
  updateTaskSchema,
} from './schemas.js';
import {
  resolveSyncConflictInputSchema,
  syncConfigurationInputSchema,
  syncConflictIdSchema,
} from './syncSchemas.js';
import type { PimpampumHttpGateway } from './types.js';
import type { SyncGateway } from './syncContract.js';
import { PIMPAMPUM_VERSION } from './version.js';

const DAEMON_VERSION = PIMPAMPUM_VERSION;

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('bad_request', 'Request validation failed', 400, false, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

function routeParam(request: Request, name: string): string {
  return request.params[name] as string;
}

function responseData(response: Response, data: unknown, status = 200, schemaVersion = 1): void {
  response.status(status).json({ data, meta: { schemaVersion } });
}

/** Loads one item beyond the page so `hasMore` is exact on an exact last page. */
function pageData<T>(load: (fetchLimit: number) => T[], limit: number, offset: number) {
  const items = load(limit + 1);
  return { items: items.slice(0, limit), limit, offset, hasMore: items.length > limit };
}

function errorBody(error: AppError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
  };
}

function normalizeHttpError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 413) {
      return new AppError('payload_too_large', 'Request body exceeds the 2 MB limit', 413);
    }
    if (status === 400) {
      return new AppError('bad_request', 'Request body is not valid JSON', 400);
    }
  }
  return asAppError(error);
}

function bearerAuth(expectedToken: string): RequestHandler {
  if (!/^[\x21-\x7e]{32,}$/.test(expectedToken)) {
    throw new Error(
      'Pimpampum bearer token must contain at least 32 printable ASCII characters without spaces',
    );
  }
  const expected = Buffer.from(expectedToken);
  return (request, response, next) => {
    const header = request.header('authorization');
    const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const candidate = Buffer.from(supplied);
    if (
      !supplied ||
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected)
    ) {
      response
        .status(401)
        .json(errorBody(new AppError('unauthorized', 'A valid bearer token is required', 401)));
      return;
    }
    next();
  };
}

export function createHttpApp(
  store: PimpampumHttpGateway,
  config: RuntimeConfig,
  logger: Pick<Console, 'error'> = console,
  clock: () => number = Date.now,
  automaticBackup?: AutomaticBackupGateway,
  sync?: SyncGateway,
) {
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    throw new AppError('bad_request', 'Pimpampum HTTP must bind to a loopback host', 400);
  }
  const app = createMcpExpressApp({ host: config.host, jsonLimit: MCP_HTTP_BODY_LIMIT });
  app.disable('x-powered-by');
  const requireAuth = bearerAuth(config.token);
  const mcpHandler = createPimpampumMcpHandler(store, sync, logger);
  const nodeMcpHandler = toNodeHandler(mcpHandler);
  const startedAtMilliseconds = clock();
  const startedAt = new Date(startedAtMilliseconds).toISOString();

  // Liveness and readiness in one probe: the process answers, and `ready` says whether
  // SQLite does. A daemon whose database stopped answering reports 503 so installers and
  // status commands that poll this route wait instead of declaring success.
  app.get('/health', (_request, response) => {
    const ready = store.ping();
    response
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ok' : 'degraded', version: DAEMON_VERSION, ready });
  });

  app.get('/openapi.json', (_request, response) => {
    response.json(openApiDocument);
  });

  app.use('/api/v1', requireAuth);

  app.get('/api/v1/overview', (_request, response) => {
    const generatedAtMilliseconds = clock();
    responseData(
      response,
      {
        ...store.getOverview(),
        daemon: {
          version: DAEMON_VERSION,
          startedAt,
          uptimeSeconds: Math.max(
            0,
            Math.floor((generatedAtMilliseconds - startedAtMilliseconds) / 1_000),
          ),
        },
        generatedAt: new Date(generatedAtMilliseconds).toISOString(),
      },
      200,
      2,
    );
  });

  // HTTP capabilities are mounted only when runtime composition supplies their owner. Omitting
  // automatic backup must not masquerade as a valid, daemon-owned disabled configuration.
  if (automaticBackup) {
    app.get('/api/v1/settings/backup', (_request, response) => {
      responseData(response, automaticBackup.getStatus());
    });

    app.put('/api/v1/settings/backup', async (request, response) => {
      const input = parse(directoryInputSchema, request.body);
      responseData(response, await automaticBackup.configure(input.directory));
    });

    app.post('/api/v1/settings/backup/retry', async (_request, response) => {
      responseData(response, await automaticBackup.retry());
    });

    app.delete('/api/v1/settings/backup', async (_request, response) => {
      responseData(response, await automaticBackup.disable());
    });
  }

  if (sync) {
    app.get('/api/v1/settings/sync', (_request, response) => {
      responseData(response, sync.getStatus());
    });
    app.put('/api/v1/settings/sync', async (request, response) => {
      const input = parse(syncConfigurationInputSchema, request.body);
      responseData(response, await sync.configure(input.directory, input.deviceId));
    });
    app.post('/api/v1/settings/sync/reconcile', async (_request, response) => {
      responseData(response, await sync.reconcile());
    });
    app.post('/api/v1/settings/sync/pause', async (_request, response) => {
      responseData(response, await sync.pause());
    });
    app.post('/api/v1/settings/sync/resume', async (_request, response) => {
      responseData(response, await sync.resume());
    });
    app.delete('/api/v1/settings/sync', async (_request, response) => {
      responseData(response, await sync.forget());
    });
    app.get('/api/v1/settings/sync/conflicts', async (request, response) => {
      const page = parse(paginationQuerySchema, request.query);
      const conflicts = await sync.listConflicts({ limit: page.limit + 1, offset: page.offset });
      const hasMore = conflicts.length > page.limit;
      responseData(response, {
        items: conflicts.slice(0, page.limit).map(({ id, entityType, entityId, createdAt }) => ({
          id,
          entityType,
          entityId,
          createdAt,
        })),
        limit: page.limit,
        offset: page.offset,
        hasMore,
      });
    });
    app.post('/api/v1/settings/sync/conflicts/:conflictId/resolve', async (request, response) => {
      const conflictId = parse(syncConflictIdSchema, routeParam(request, 'conflictId'));
      const input = parse(resolveSyncConflictInputSchema, request.body);
      responseData(response, await sync.resolveConflict(conflictId, input.choice));
    });
  }

  app.get('/api/v1/workspaces', (_request, response) => {
    responseData(response, store.listWorkspaces());
  });

  app.post('/api/v1/workspaces', (request, response) => {
    const input = parse(registerWorkspaceSchema, request.body);
    responseData(response, store.registerWorkspace({ ...input, actor: 'local-admin' }), 201);
  });

  app.post('/api/v1/workspaces/resolve', (request, response) => {
    const input = parse(resolveWorkspaceInputSchema, request.body);
    responseData(response, store.resolveWorkspace(input.path));
  });

  app.get('/api/v1/projects', (request, response) => {
    const page = parse(paginationQuerySchema, request.query);
    const filters = parse(
      z.object({
        workspaceId: slugSchema.optional(),
        state: projectStateSchema.optional(),
      }),
      request.query,
    );
    responseData(
      response,
      pageData(
        (limit) =>
          store.listProjectManifests({
            workspaceId: filters.workspaceId ?? null,
            state: filters.state ?? null,
            limit,
            offset: page.offset,
          }),
        page.limit,
        page.offset,
      ),
    );
  });

  app.post('/api/v1/projects', (request, response) => {
    responseData(response, store.createProject(parse(createProjectSchema, request.body)), 201);
  });

  app.get('/api/v1/projects/:projectId/manifest', (request, response) => {
    responseData(response, store.getProjectManifest(routeParam(request, 'projectId')));
  });

  app.get('/api/v1/projects/:projectId/completion', (request, response) => {
    responseData(response, store.getProjectCompletion(routeParam(request, 'projectId')));
  });

  app.patch('/api/v1/projects/:projectId', (request, response) => {
    const input = parse(updateProjectSchema, request.body);
    responseData(
      response,
      store.updateProject({ projectId: routeParam(request, 'projectId'), ...input }),
    );
  });

  app.post('/api/v1/projects/:projectId/complete', (request, response) => {
    const input = parse(completeProjectInputSchema, request.body);
    responseData(
      response,
      store.completeProject({ projectId: routeParam(request, 'projectId'), ...input }),
    );
  });

  app.post('/api/v1/projects/:projectId/cancel', (request, response) => {
    const input = parse(cancelInputSchema, request.body);
    responseData(
      response,
      store.cancelProject({ projectId: routeParam(request, 'projectId'), ...input }),
    );
  });

  app.get('/api/v1/projects/:projectId/specs', (request, response) => {
    const page = parse(paginationQuerySchema, request.query);
    const { state } = parse(z.object({ state: specStateSchema.optional() }), request.query);
    responseData(
      response,
      pageData(
        (limit) =>
          store.listSpecManifests({
            projectId: routeParam(request, 'projectId'),
            state: state ?? null,
            limit,
            offset: page.offset,
          }),
        page.limit,
        page.offset,
      ),
    );
  });

  app.post('/api/v1/projects/:projectId/specs', (request, response) => {
    const input = parse(createSpecSchema, request.body);
    responseData(
      response,
      store.createSpec({ projectId: routeParam(request, 'projectId'), ...input }),
      201,
    );
  });

  app.get('/api/v1/specs/:specId/manifest', (request, response) => {
    responseData(response, store.getSpecManifest(routeParam(request, 'specId')));
  });

  app.get('/api/v1/specs/:specId/body', (request, response) => {
    const page = parse(markdownPageQuerySchema, request.query);
    responseData(
      response,
      store.readSpecBody(routeParam(request, 'specId'), page.offsetCodeUnits, page.limitCodeUnits),
    );
  });

  app.get('/api/v1/specs/:specId/completion', (request, response) => {
    responseData(response, store.getSpecCompletion(routeParam(request, 'specId')));
  });

  app.patch('/api/v1/specs/:specId', (request, response) => {
    const input = parse(updateSpecSchema, request.body);
    responseData(response, store.updateSpec({ specId: routeParam(request, 'specId'), ...input }));
  });

  app.post('/api/v1/specs/:specId/cancel', (request, response) => {
    const input = parse(cancelInputSchema, request.body);
    responseData(response, store.cancelSpec({ specId: routeParam(request, 'specId'), ...input }));
  });

  const contextRoutes = (
    ownerType: 'workspace' | 'project',
    prefix: string,
    ownerParameter: string,
  ) => {
    app.get(`${prefix}/context`, (request, response) => {
      const page = parse(paginationQuerySchema, request.query);
      responseData(
        response,
        pageData(
          (limit) =>
            store.listContextManifests({
              ownerType,
              ownerId: routeParam(request, ownerParameter),
              limit,
              offset: page.offset,
            }),
          page.limit,
          page.offset,
        ),
      );
    });

    app.get(`${prefix}/context/:name`, (request, response) => {
      responseData(
        response,
        store.getContextManifest(
          ownerType,
          routeParam(request, ownerParameter),
          routeParam(request, 'name'),
        ),
      );
    });

    app.get(`${prefix}/context/:name/body`, (request, response) => {
      const page = parse(markdownPageQuerySchema, request.query);
      responseData(
        response,
        store.readContextPage(
          ownerType,
          routeParam(request, ownerParameter),
          routeParam(request, 'name'),
          page.offsetCodeUnits,
          page.limitCodeUnits,
        ),
      );
    });

    app.put(`${prefix}/context/:name`, (request, response) => {
      const input = parse(putContextSchema, request.body);
      const name = parse(slugSchema, routeParam(request, 'name'));
      responseData(
        response,
        store.putContext({
          ownerType,
          ownerId: routeParam(request, ownerParameter),
          name,
          ...input,
        }),
      );
    });
  };
  contextRoutes('project', '/api/v1/projects/:projectId', 'projectId');
  contextRoutes('workspace', '/api/v1/workspaces/:workspaceId', 'workspaceId');

  app.get('/api/v1/specs/:specId/tasks', (request, response) => {
    const page = parse(paginationQuerySchema, request.query);
    responseData(
      response,
      pageData(
        (limit) =>
          store.listTaskManifests({
            specId: routeParam(request, 'specId'),
            limit,
            offset: page.offset,
          }),
        page.limit,
        page.offset,
      ),
    );
  });

  app.post('/api/v1/specs/:specId/tasks', (request, response) => {
    const input = parse(createTaskSchema, request.body);
    responseData(
      response,
      store.createTask({ specId: routeParam(request, 'specId'), ...input }),
      201,
    );
  });

  app.get('/api/v1/tasks/:taskId/manifest', (request, response) => {
    responseData(response, store.getTaskManifest(routeParam(request, 'taskId')));
  });

  app.get('/api/v1/tasks/:taskId/body', (request, response) => {
    const page = parse(markdownPageQuerySchema, request.query);
    responseData(
      response,
      store.readTaskBody(routeParam(request, 'taskId'), page.offsetCodeUnits, page.limitCodeUnits),
    );
  });

  app.get('/api/v1/tasks/:taskId/completion', (request, response) => {
    responseData(response, store.getTaskCompletion(routeParam(request, 'taskId')));
  });

  app.patch('/api/v1/tasks/:taskId', (request, response) => {
    const input = parse(updateTaskSchema, request.body);
    const taskId = routeParam(request, 'taskId');
    responseData(
      response,
      store.updateTask({
        taskId,
        title: input.title,
        body: input.body,
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      }),
    );
  });

  app.post('/api/v1/tasks/:taskId/cancel', (request, response) => {
    const input = parse(cancelInputSchema, request.body);
    responseData(response, store.cancelTask({ taskId: routeParam(request, 'taskId'), ...input }));
  });

  app.get('/api/v1/work', (request, response) => {
    const filters = parse(
      z.object({
        workspaceId: slugSchema.optional(),
        projectId: idSchema.optional(),
        specId: idSchema.optional(),
      }),
      request.query,
    );
    const { limit } = parse(limitQuerySchema, request.query);
    responseData(
      response,
      store.listWork({
        workspaceId: filters.workspaceId ?? null,
        projectId: filters.projectId ?? null,
        specId: filters.specId ?? null,
        limit,
      }),
    );
  });

  app.put('/api/v1/work/:targetType/:targetId/claim', (request, response) => {
    const targetType = parse(targetTypeSchema, routeParam(request, 'targetType'));
    const input = parse(claimInputSchema, request.body);
    responseData(
      response,
      store.startWork({ targetType, targetId: routeParam(request, 'targetId'), ...input }),
    );
  });

  app.patch('/api/v1/work/:targetType/:targetId/claim', (request, response) => {
    const targetType = parse(targetTypeSchema, routeParam(request, 'targetType'));
    const input = parse(claimInputSchema, request.body);
    responseData(
      response,
      store.renewWork({ targetType, targetId: routeParam(request, 'targetId'), ...input }),
    );
  });

  app.delete('/api/v1/work/:targetType/:targetId/claim', (request, response) => {
    const targetType = parse(targetTypeSchema, routeParam(request, 'targetType'));
    const input = parse(releaseInputSchema, request.body);
    store.releaseWork({ targetType, targetId: routeParam(request, 'targetId'), ...input });
    responseData(response, { released: true });
  });

  app.post('/api/v1/work/:targetType/:targetId/complete', (request, response) => {
    const targetType = parse(targetTypeSchema, routeParam(request, 'targetType'));
    const input = parse(completeWorkInputSchema, request.body);
    responseData(
      response,
      store.completeWork({ targetType, targetId: routeParam(request, 'targetId'), ...input }),
    );
  });

  app.get('/api/v1/projects/:projectId/activity', (request, response) => {
    const { limit } = parse(limitQuerySchema, request.query);
    responseData(response, store.listActivity(routeParam(request, 'projectId'), limit));
  });

  app.post('/api/v1/admin/backup', async (request, response) => {
    const input = parse(directoryInputSchema, request.body);
    responseData(response, { path: await store.backup(input.directory) }, 201);
  });

  app.post('/api/v1/admin/export', (request, response) => {
    const input = parse(directoryInputSchema, request.body);
    responseData(response, { path: store.exportPortable(input.directory) }, 201);
  });

  app.post('/mcp', requireAuth, (request, response, next) => {
    void nodeMcpHandler(request, response, request.body).catch(next);
  });

  // The MCP SDK client opens a GET stream after `initialize` and treats only 405 as "no
  // stream"; any other method on the endpoint gets the same answer instead of an HTML 404.
  app.use('/mcp', (_request, response) => {
    response
      .status(405)
      .set('Allow', 'POST')
      .json(
        errorBody(new AppError('bad_request', 'The MCP endpoint accepts POST requests only', 405)),
      );
  });

  app.use((_request, response) => {
    response.status(404).json(errorBody(new AppError('not_found', 'API route was not found', 404)));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = normalizeHttpError(error);
    if (appError.status >= 500) logger.error('Pimpampum request failed', error);
    response.status(appError.status).json(errorBody(appError));
  });

  return { app, close: () => mcpHandler.close() };
}
