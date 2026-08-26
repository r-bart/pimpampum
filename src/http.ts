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
  absolutePathSchema,
  artifactSchema,
  cancelSchema,
  claimSchema,
  completeSchema,
  createProjectSchema,
  createSpecSchema,
  createTaskSchema,
  projectStateSchema,
  putContextSchema,
  registerWorkspaceSchema,
  slugSchema,
  specStateSchema,
  targetTypeSchema,
  updateProjectSchema,
  updateSpecSchema,
  updateTaskSchema,
} from './schemas.js';
import type { PimpampumHttpGateway } from './types.js';

const DAEMON_VERSION = '0.1.0';

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

function pageData<T>(items: T[], limit: number, offset: number) {
  return { items, limit, offset, hasMore: items.length === limit };
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
      response.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'A valid bearer token is required',
          retryable: false,
        },
      });
      return;
    }
    next();
  };
}

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const markdownPageSchema = z.object({
  offsetCodeUnits: z.coerce.number().int().min(0).default(0),
  limitCodeUnits: z.coerce.number().int().min(1).max(100_000).default(20_000),
});

export function createHttpApp(
  store: PimpampumHttpGateway,
  config: RuntimeConfig,
  logger: Pick<Console, 'error'> = console,
  clock: () => number = Date.now,
  automaticBackup?: AutomaticBackupGateway,
) {
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    throw new AppError('bad_request', 'Pimpampum HTTP must bind to a loopback host', 400);
  }
  const app = createMcpExpressApp({ host: config.host, jsonLimit: MCP_HTTP_BODY_LIMIT });
  const requireAuth = bearerAuth(config.token);
  const mcpHandler = createPimpampumMcpHandler(store);
  const nodeMcpHandler = toNodeHandler(mcpHandler);
  const startedAtMilliseconds = clock();
  const startedAt = new Date(startedAtMilliseconds).toISOString();

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', version: DAEMON_VERSION });
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
      const input = parse(z.object({ directory: absolutePathSchema }).strict(), request.body);
      responseData(response, await automaticBackup.configure(input.directory));
    });

    app.post('/api/v1/settings/backup/retry', async (_request, response) => {
      responseData(response, await automaticBackup.retry());
    });

    app.delete('/api/v1/settings/backup', async (_request, response) => {
      responseData(response, await automaticBackup.disable());
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
    const input = parse(z.strictObject({ path: absolutePathSchema }), request.body);
    responseData(response, store.resolveWorkspace(input.path));
  });

  app.get('/api/v1/projects', (request, response) => {
    const page = parse(paginationSchema, request.query);
    const filters = parse(
      z.object({
        workspaceId: slugSchema.optional(),
        state: projectStateSchema.optional(),
      }),
      request.query,
    );
    const items = store.listProjectManifests({
      workspaceId: filters.workspaceId ?? null,
      state: filters.state ?? null,
      limit: page.limit,
      offset: page.offset,
    });
    responseData(response, pageData(items, page.limit, page.offset));
  });

  app.post('/api/v1/projects', (request, response) => {
    responseData(response, store.createProject(parse(createProjectSchema, request.body)), 201);
  });

  app.get('/api/v1/projects/:projectId', (request, response) => {
    responseData(response, store.getProjectManifest(routeParam(request, 'projectId')));
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
    const input = parse(
      z.strictObject({
        expectedRevision: z.number().int().positive(),
        summary: z.string().trim().min(1).max(4_000),
        artifacts: z.array(artifactSchema).max(20).default([]),
        actor: z.string().min(1).max(200).nullable().default(null),
      }),
      request.body,
    );
    responseData(
      response,
      store.completeProject({ projectId: routeParam(request, 'projectId'), ...input }),
    );
  });

  app.post('/api/v1/projects/:projectId/cancel', (request, response) => {
    const input = parse(cancelSchema, request.body);
    responseData(
      response,
      store.cancelProject({ projectId: routeParam(request, 'projectId'), ...input }),
    );
  });

  app.get('/api/v1/projects/:projectId/specs', (request, response) => {
    const page = parse(paginationSchema, request.query);
    const { state } = parse(z.object({ state: specStateSchema.optional() }), request.query);
    const items = store.listSpecManifests({
      projectId: routeParam(request, 'projectId'),
      state: state ?? null,
      ...page,
    });
    responseData(response, pageData(items, page.limit, page.offset));
  });

  app.post('/api/v1/projects/:projectId/specs', (request, response) => {
    const input = parse(createSpecSchema, request.body);
    responseData(
      response,
      store.createSpec({ projectId: routeParam(request, 'projectId'), ...input }),
      201,
    );
  });

  app.get('/api/v1/specs/:specId', (request, response) => {
    responseData(response, store.getSpecManifest(routeParam(request, 'specId')));
  });

  app.get('/api/v1/specs/:specId/manifest', (request, response) => {
    responseData(response, store.getSpecManifest(routeParam(request, 'specId')));
  });

  app.get('/api/v1/specs/:specId/body', (request, response) => {
    const page = parse(markdownPageSchema, request.query);
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
    const input = parse(cancelSchema, request.body);
    responseData(response, store.cancelSpec({ specId: routeParam(request, 'specId'), ...input }));
  });

  app.get('/api/v1/projects/:projectId/context', (request, response) => {
    const page = parse(paginationSchema, request.query);
    const items = store.listContextManifests({
      ownerType: 'project',
      ownerId: routeParam(request, 'projectId'),
      ...page,
    });
    responseData(response, pageData(items, page.limit, page.offset));
  });

  app.get('/api/v1/projects/:projectId/context/:name', (request, response) => {
    responseData(
      response,
      store.getContextManifest(
        'project',
        routeParam(request, 'projectId'),
        routeParam(request, 'name'),
      ),
    );
  });

  app.get('/api/v1/projects/:projectId/context/:name/body', (request, response) => {
    const page = parse(markdownPageSchema, request.query);
    responseData(
      response,
      store.readContextPage(
        'project',
        routeParam(request, 'projectId'),
        routeParam(request, 'name'),
        page.offsetCodeUnits,
        page.limitCodeUnits,
      ),
    );
  });

  app.put('/api/v1/projects/:projectId/context/:name', (request, response) => {
    const input = parse(putContextSchema, request.body);
    const name = parse(slugSchema, routeParam(request, 'name'));
    responseData(
      response,
      store.putContext({
        ownerType: 'project',
        ownerId: routeParam(request, 'projectId'),
        name,
        ...input,
      }),
    );
  });

  app.get('/api/v1/workspaces/:workspaceId/context', (request, response) => {
    const page = parse(paginationSchema, request.query);
    const items = store.listContextManifests({
      ownerType: 'workspace',
      ownerId: routeParam(request, 'workspaceId'),
      ...page,
    });
    responseData(response, pageData(items, page.limit, page.offset));
  });

  app.get('/api/v1/workspaces/:workspaceId/context/:name', (request, response) => {
    responseData(
      response,
      store.getContextManifest(
        'workspace',
        routeParam(request, 'workspaceId'),
        routeParam(request, 'name'),
      ),
    );
  });

  app.get('/api/v1/workspaces/:workspaceId/context/:name/body', (request, response) => {
    const page = parse(markdownPageSchema, request.query);
    responseData(
      response,
      store.readContextPage(
        'workspace',
        routeParam(request, 'workspaceId'),
        routeParam(request, 'name'),
        page.offsetCodeUnits,
        page.limitCodeUnits,
      ),
    );
  });

  app.put('/api/v1/workspaces/:workspaceId/context/:name', (request, response) => {
    const input = parse(putContextSchema, request.body);
    const name = parse(slugSchema, routeParam(request, 'name'));
    responseData(
      response,
      store.putContext({
        ownerType: 'workspace',
        ownerId: routeParam(request, 'workspaceId'),
        name,
        ...input,
      }),
    );
  });

  app.get('/api/v1/specs/:specId/tasks', (request, response) => {
    const page = parse(paginationSchema, request.query);
    const items = store.listTaskManifests({ specId: routeParam(request, 'specId'), ...page });
    responseData(response, pageData(items, page.limit, page.offset));
  });

  app.post('/api/v1/specs/:specId/tasks', (request, response) => {
    const input = parse(createTaskSchema, request.body);
    responseData(
      response,
      store.createTask({ specId: routeParam(request, 'specId'), ...input }),
      201,
    );
  });

  app.get('/api/v1/tasks/:taskId', (request, response) => {
    responseData(response, store.getTaskManifest(routeParam(request, 'taskId')));
  });

  app.get('/api/v1/tasks/:taskId/manifest', (request, response) => {
    responseData(response, store.getTaskManifest(routeParam(request, 'taskId')));
  });

  app.get('/api/v1/tasks/:taskId/body', (request, response) => {
    const page = parse(markdownPageSchema, request.query);
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
    const input = parse(cancelSchema, request.body);
    responseData(response, store.cancelTask({ taskId: routeParam(request, 'taskId'), ...input }));
  });

  app.get('/api/v1/work', (request, response) => {
    const input = parse(
      z.object({
        workspaceId: slugSchema.optional(),
        projectId: z.string().uuid().optional(),
        specId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      request.query,
    );
    responseData(
      response,
      store.listWork({
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        specId: input.specId ?? null,
        limit: input.limit,
      }),
    );
  });

  app.put('/api/v1/work/:targetType/:targetId/claim', (request, response) => {
    const targetType = parse(targetTypeSchema, routeParam(request, 'targetType'));
    const input = parse(claimSchema, request.body);
    responseData(
      response,
      store.startWork({ targetType, targetId: routeParam(request, 'targetId'), ...input }),
    );
  });

  app.patch('/api/v1/work/:targetType/:targetId/claim', (request, response) => {
    const targetType = parse(targetTypeSchema, routeParam(request, 'targetType'));
    const input = parse(claimSchema, request.body);
    responseData(
      response,
      store.renewWork({ targetType, targetId: routeParam(request, 'targetId'), ...input }),
    );
  });

  app.delete('/api/v1/work/:targetType/:targetId/claim', (request, response) => {
    const targetType = parse(targetTypeSchema, routeParam(request, 'targetType'));
    const input = parse(
      z.strictObject({
        agentId: z.string().min(1).max(200),
        note: z.string().max(500).nullable().default(null),
      }),
      request.body,
    );
    store.releaseWork({ targetType, targetId: routeParam(request, 'targetId'), ...input });
    responseData(response, { released: true });
  });

  app.post('/api/v1/work/:targetType/:targetId/complete', (request, response) => {
    const targetType = parse(targetTypeSchema, routeParam(request, 'targetType'));
    const input = parse(completeSchema, request.body);
    responseData(
      response,
      store.completeWork({ targetType, targetId: routeParam(request, 'targetId'), ...input }),
    );
  });

  app.get('/api/v1/projects/:projectId/activity', (request, response) => {
    const input = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      request.query,
    );
    responseData(response, store.listActivity(routeParam(request, 'projectId'), input.limit));
  });

  app.post('/api/v1/admin/backup', async (request, response) => {
    const input = parse(z.strictObject({ directory: absolutePathSchema }), request.body);
    responseData(response, { path: await store.backup(input.directory) }, 201);
  });

  app.post('/api/v1/admin/export', (request, response) => {
    const input = parse(z.strictObject({ directory: absolutePathSchema }), request.body);
    responseData(response, { path: store.exportPortable(input.directory) }, 201);
  });

  app.post('/mcp', requireAuth, (request, response, next) => {
    void nodeMcpHandler(request, response, request.body).catch(next);
  });

  app.use('/api/v1', (_request, response) => {
    response.status(404).json({
      error: {
        code: 'not_found',
        message: 'API route was not found',
        retryable: false,
        details: {},
      },
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = normalizeHttpError(error);
    if (appError.status >= 500) logger.error('Pimpampum request failed', error);
    response.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        details: appError.details,
      },
    });
  });

  return { app, close: () => mcpHandler.close() };
}
