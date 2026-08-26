import { timingSafeEqual } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodType } from 'zod';
import type { RuntimeConfig } from './config.js';
import { AppError, asAppError } from './errors.js';
import { MCP_HTTP_BODY_LIMIT } from './limits.js';
import { createPimpampumMcpHandler } from './mcp.js';
import { openApiDocument } from './openapi.js';
import {
  absolutePathSchema,
  claimSchema,
  completeSchema,
  createProjectSchema,
  createTaskSchema,
  markdownSchema,
  projectStateSchema,
  registerWorkspaceSchema,
  slugSchema,
  targetTypeSchema,
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

function responseData(response: Response, data: unknown, status = 200): void {
  response.status(status).json({ data, meta: { schemaVersion: 1 } });
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
    responseData(response, {
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
    });
  });

  app.get('/api/v1/workspaces', (_request, response) => {
    responseData(response, store.listWorkspaces());
  });

  app.post('/api/v1/workspaces', (request, response) => {
    const input = parse(registerWorkspaceSchema, request.body);
    responseData(response, store.registerWorkspace({ ...input, actor: 'local-admin' }), 201);
  });

  app.post('/api/v1/workspaces/resolve', (request, response) => {
    const input = parse(z.object({ path: absolutePathSchema }), request.body);
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
    responseData(
      response,
      store.listProjectManifests({
        workspaceId: filters.workspaceId ?? null,
        state: filters.state ?? null,
        limit: page.limit,
        offset: page.offset,
      }),
    );
  });

  app.post('/api/v1/projects', (request, response) => {
    responseData(response, store.createProject(parse(createProjectSchema, request.body)), 201);
  });

  app.get('/api/v1/projects/:projectId', (request, response) => {
    responseData(response, store.getProject(routeParam(request, 'projectId')));
  });

  app.get('/api/v1/projects/:projectId/manifest', (request, response) => {
    responseData(response, store.getProjectManifest(routeParam(request, 'projectId')));
  });

  app.get('/api/v1/projects/:projectId/prd', (request, response) => {
    const page = parse(markdownPageSchema, request.query);
    responseData(
      response,
      store.readProjectPrd(
        routeParam(request, 'projectId'),
        page.offsetCodeUnits,
        page.limitCodeUnits,
      ),
    );
  });

  app.get('/api/v1/projects/:projectId/completion', (request, response) => {
    responseData(response, store.getProjectCompletion(routeParam(request, 'projectId')));
  });

  app.patch('/api/v1/projects/:projectId', (request, response) => {
    const input = parse(
      z.object({
        title: z.string().min(1).max(200).nullable().default(null),
        state: z.enum(['draft', 'ready']).nullable().default(null),
        expectedRevision: z.number().int().positive(),
        actor: z.string().min(1).max(200).nullable().default(null),
      }),
      request.body,
    );
    responseData(
      response,
      store.updateProject({ projectId: routeParam(request, 'projectId'), ...input }),
    );
  });

  app.put('/api/v1/projects/:projectId/prd', (request, response) => {
    const input = parse(
      z.object({
        prd: markdownSchema,
        expectedRevision: z.number().int().positive(),
        actor: z.string().min(1).max(200).nullable().default(null),
      }),
      request.body,
    );
    responseData(
      response,
      store.updatePrd({ projectId: routeParam(request, 'projectId'), ...input }),
    );
  });

  app.get('/api/v1/projects/:projectId/context', (request, response) => {
    const page = parse(paginationSchema, request.query);
    responseData(
      response,
      store.listContextManifests({
        projectId: routeParam(request, 'projectId'),
        ...page,
      }),
    );
  });

  app.get('/api/v1/projects/:projectId/context/:name', (request, response) => {
    responseData(
      response,
      store.readContext(routeParam(request, 'projectId'), routeParam(request, 'name')),
    );
  });

  app.get('/api/v1/projects/:projectId/context/:name/body', (request, response) => {
    const page = parse(markdownPageSchema, request.query);
    responseData(
      response,
      store.readContextPage(
        routeParam(request, 'projectId'),
        routeParam(request, 'name'),
        page.offsetCodeUnits,
        page.limitCodeUnits,
      ),
    );
  });

  app.put('/api/v1/projects/:projectId/context/:name', (request, response) => {
    const input = parse(
      z.object({
        body: markdownSchema,
        expectedRevision: z.number().int().positive().nullable().default(null),
        actor: z.string().min(1).max(200).nullable().default(null),
      }),
      request.body,
    );
    const name = parse(slugSchema, routeParam(request, 'name'));
    responseData(
      response,
      store.putContext({ projectId: routeParam(request, 'projectId'), name, ...input }),
    );
  });

  app.get('/api/v1/projects/:projectId/tasks', (request, response) => {
    const page = parse(paginationSchema, request.query);
    responseData(
      response,
      store.listTaskManifests({ projectId: routeParam(request, 'projectId'), ...page }),
    );
  });

  app.post('/api/v1/projects/:projectId/tasks', (request, response) => {
    const input = parse(createTaskSchema, request.body);
    responseData(
      response,
      store.createTask({ projectId: routeParam(request, 'projectId'), ...input }),
      201,
    );
  });

  app.get('/api/v1/tasks/:taskId', (request, response) => {
    responseData(response, store.getTask(routeParam(request, 'taskId')));
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
    const input = parse(
      z.object({
        title: z.string().min(1).max(300).nullable().default(null),
        body: markdownSchema.nullable().optional(),
        expectedRevision: z.number().int().positive(),
        actor: z.string().min(1).max(200).nullable().default(null),
      }),
      request.body,
    );
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

  app.get('/api/v1/work', (request, response) => {
    const input = parse(
      z.object({
        workspaceId: slugSchema.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      request.query,
    );
    responseData(
      response,
      store.listWork({ workspaceId: input.workspaceId ?? null, limit: input.limit }),
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
      z.object({
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
    const input = parse(z.object({ directory: absolutePathSchema }), request.body);
    responseData(response, { path: await store.backup(input.directory) }, 201);
  });

  app.post('/api/v1/admin/export', (request, response) => {
    const input = parse(z.object({ directory: absolutePathSchema }), request.body);
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
