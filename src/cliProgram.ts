import { AppError } from './errors.js';
import type { PimpampumHttpClient } from './client.js';
import type { TargetType } from './types.js';

export interface CliRuntime {
  createClient(): PimpampumHttpClient;
  startServer(): Promise<{ config: { baseUrl: string }; close(): Promise<void> }>;
  readFile(path: string): string;
  resolvePath(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
  onSignal(signal: 'SIGINT' | 'SIGTERM', callback: () => void): void;
  exit(code: number): never;
}

export const CLI_USAGE = `Pimpampum 0.1.0

Usage:
  pimpampum serve
  pimpampum health
  pimpampum workspace:list
  pimpampum workspace:add <id> <name> <root-path>
  pimpampum work:list [workspace-id]
  pimpampum work:start <project|task> <id> <agent-id>
  pimpampum work:release <project|task> <id> <agent-id> [note]
  pimpampum work:complete <project|task> <id> <agent-id> <revision> <summary>
  pimpampum project:create <workspace-id> <slug> <title> [prd-file]
  pimpampum project:get <project-id>
  pimpampum project:ready <project-id> <revision>
  pimpampum task:create <project-id> <title> [parent-id]
  pimpampum backup <directory>
  pimpampum export <directory>
`;

function required(value: string | undefined, label: string): string {
  if (!value) throw new AppError('bad_request', `Missing ${label}`, 400);
  return value;
}

function targetType(value: string | undefined): TargetType {
  const resolved = required(value, 'target type');
  if (resolved !== 'project' && resolved !== 'task') {
    throw new AppError('bad_request', 'Target type must be project or task', 400);
  }
  return resolved;
}

function revision(value: string | undefined): number {
  const parsed = Number(required(value, 'revision'));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('bad_request', 'Revision must be a positive integer', 400);
  }
  return parsed;
}

function print(runtime: CliRuntime, value: unknown): void {
  runtime.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCli(arguments_: string[], runtime: CliRuntime): Promise<void> {
  const [command, ...args] = arguments_;
  if (!command) {
    runtime.stderr(CLI_USAGE);
    runtime.exit(1);
  }

  if (command === 'serve') {
    const running = await runtime.startServer();
    runtime.stdout(`Pimpampum listening on ${running.config.baseUrl}\n`);
    const shutdown = async () => {
      await running.close();
      runtime.exit(0);
    };
    runtime.onSignal('SIGINT', () => void shutdown());
    runtime.onSignal('SIGTERM', () => void shutdown());
    return;
  }

  const client = runtime.createClient();
  switch (command) {
    case 'health':
      print(runtime, await client.health());
      return;
    case 'workspace:list':
      print(runtime, await client.listWorkspaces());
      return;
    case 'workspace:add':
      print(
        runtime,
        await client.registerWorkspace({
          id: required(args[0], 'workspace id'),
          name: required(args[1], 'workspace name'),
          rootPath: runtime.resolvePath(required(args[2], 'workspace root path')),
        }),
      );
      return;
    case 'work:list':
      print(runtime, await client.listWork({ workspaceId: args[0] ?? null, limit: 50 }));
      return;
    case 'work:start':
      print(
        runtime,
        await client.startWork({
          targetType: targetType(args[0]),
          targetId: required(args[1], 'target id'),
          agentId: required(args[2], 'agent id'),
          leaseSeconds: 1_800,
        }),
      );
      return;
    case 'work:release':
      await client.releaseWork({
        targetType: targetType(args[0]),
        targetId: required(args[1], 'target id'),
        agentId: required(args[2], 'agent id'),
        note: args[3] ?? null,
      });
      print(runtime, { released: true });
      return;
    case 'work:complete':
      print(
        runtime,
        await client.completeWork({
          targetType: targetType(args[0]),
          targetId: required(args[1], 'target id'),
          agentId: required(args[2], 'agent id'),
          expectedRevision: revision(args[3]),
          summary: required(args[4], 'summary'),
          artifacts: [],
        }),
      );
      return;
    case 'project:create': {
      const prdFile = args[3];
      print(
        runtime,
        await client.createProject({
          workspaceId: required(args[0], 'workspace id'),
          slug: required(args[1], 'project slug'),
          title: required(args[2], 'project title'),
          prd: prdFile ? runtime.readFile(prdFile) : '',
          state: 'draft',
          actor: 'cli',
        }),
      );
      return;
    }
    case 'project:get':
      print(runtime, await client.getProject(required(args[0], 'project id')));
      return;
    case 'project:ready':
      print(
        runtime,
        await client.updateProject({
          projectId: required(args[0], 'project id'),
          title: null,
          state: 'ready',
          expectedRevision: revision(args[1]),
          actor: 'cli',
        }),
      );
      return;
    case 'task:create':
      print(
        runtime,
        await client.createTask({
          projectId: required(args[0], 'project id'),
          title: required(args[1], 'task title'),
          parentId: args[2] ?? null,
          body: null,
          actor: 'cli',
        }),
      );
      return;
    case 'backup':
      print(
        runtime,
        await client.backup(runtime.resolvePath(required(args[0], 'backup directory'))),
      );
      return;
    case 'export':
      print(
        runtime,
        await client.exportPortable(runtime.resolvePath(required(args[0], 'export directory'))),
      );
      return;
    default:
      runtime.stderr(CLI_USAGE);
      runtime.exit(1);
  }
}
