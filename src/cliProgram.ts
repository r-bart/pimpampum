import type { AgentCliClient } from './agentClient.js';
import {
  createAgentErrorEnvelope,
  createAgentSuccessEnvelope,
  extractAgentEnvelope,
  type AgentErrorEnvelope,
} from './agentProtocol.js';
import type { PimpampumHttpClient } from './client.js';
import { AppError } from './errors.js';
import { MAX_AGENT_INPUT_BYTES } from './limits.js';
import type { ServiceManager } from './service/types.js';
import type { TargetType } from './types.js';

export interface AgentCliConfiguration {
  dataDirectory: string;
  databasePath: string;
  baseUrl: string;
  tokenPath: string | null;
  tokenSource: 'environment' | 'file';
  tokenConfigured: boolean;
  mcp: {
    streamableHttpUrl: string;
    stdio: {
      command: string;
      args: string[];
    };
  };
}

export interface CliRuntime {
  createClient(): PimpampumHttpClient;
  createAgentClient(): Promise<AgentCliClient>;
  describeConfig(): AgentCliConfiguration;
  serviceManager: ServiceManager;
  serviceOnlyManager?: ServiceManager;
  startServer(): Promise<{ config: { baseUrl: string }; close(): Promise<void> }>;
  readFile(path: string, maxBytes?: number): string;
  readStdin(maxBytes?: number): string | Promise<string>;
  resolvePath(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
  onSignal(signal: 'SIGINT' | 'SIGTERM', callback: () => void): void;
  exit(code: number): never;
}

export { MAX_AGENT_INPUT_BYTES } from './limits.js';

export const CLI_USAGE = `Pimpampum 1.0.0

Usage:
  pimpampum help
  pimpampum serve
  pimpampum health
  pimpampum overview
  pimpampum config
  pimpampum tools
  pimpampum call <tool-name> [--input <json> | --stdin | --input-file <path>]
  pimpampum install [--service-only]
  pimpampum status
  pimpampum uninstall
  pimpampum workspace:list
  pimpampum workspace:add <id> <name> <root-path>
  pimpampum work:list [workspace-id] [project-id] [spec-id]
  pimpampum work:start <spec|task> <id> <agent-id>
  pimpampum work:renew <spec|task> <id> <agent-id>
  pimpampum work:release <spec|task> <id> <agent-id> [note]
  pimpampum work:complete <spec|task> <id> <agent-id> <revision> <summary>
  pimpampum project:create <workspace-id> <slug> <title>
  pimpampum project:get <project-id>
  pimpampum project:draft <project-id> <revision>
  pimpampum project:open <project-id> <revision>
  pimpampum project:pause <project-id> <revision>
  pimpampum project:complete <project-id> <revision> <summary>
  pimpampum project:cancel <project-id> <revision> <reason>
  pimpampum spec:create <project-id> <slug> <title> [body-file]
  pimpampum spec:get <spec-id>
  pimpampum spec:draft <spec-id> <revision>
  pimpampum spec:ready <spec-id> <revision>
  pimpampum spec:cancel <spec-id> <revision> <reason>
  pimpampum task:create <spec-id> <title> [parent-id]
  pimpampum task:get <task-id>
  pimpampum task:cancel <task-id> <revision> <reason>
  pimpampum backup <directory>
  pimpampum backup status [--json]
  pimpampum backup configure <absolute-directory> [--json]
  pimpampum backup retry [--json]
  pimpampum backup disable [--json]
  pimpampum sync status [--json]
  pimpampum sync configure <absolute-parent-directory> --device <device-id> [--json]
  pimpampum sync now [--json]
  pimpampum sync pause [--json]
  pimpampum sync resume [--json]
  pimpampum sync conflicts [--json]
  pimpampum sync resolve <conflict-id> <local|remote> [--json]
  pimpampum sync forget [--json]
  pimpampum export <directory>
`;

function required(value: string | undefined, label: string): string {
  if (!value) throw new AppError('bad_request', `Missing ${label}`, 400);
  return value;
}

function targetType(value: string | undefined): TargetType {
  const resolved = required(value, 'target type');
  if (resolved !== 'spec' && resolved !== 'task') {
    throw new AppError('bad_request', 'Target type must be spec or task', 400);
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

function acceptOptionalJsonFlag(arguments_: string[], startIndex: number): void {
  const trailing = arguments_.slice(startIndex);
  if (trailing.length > 1 || trailing.some((argument) => argument !== '--json')) {
    throw new AppError('bad_request', 'Only the optional --json flag is accepted', 400);
  }
}

function print(runtime: CliRuntime, value: unknown): void {
  runtime.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(runtime: CliRuntime, value: AgentErrorEnvelope): void {
  runtime.stderr(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseToolInput(
  arguments_: string[],
  runtime: CliRuntime,
): Promise<{ name: string; input: Record<string, unknown> }> {
  const name = required(arguments_[0], 'tool name');
  const sources: Array<
    { kind: 'inline'; value: string } | { kind: 'stdin' } | { kind: 'file'; path: string }
  > = [];
  let index = 1;
  while (index < arguments_.length) {
    const argument = arguments_[index];
    if (argument === '--input') {
      sources.push({
        kind: 'inline',
        value: required(arguments_[index + 1], 'inline JSON input'),
      });
      index += 2;
      continue;
    }
    if (argument === '--stdin') {
      sources.push({ kind: 'stdin' });
      index += 1;
      continue;
    }
    if (argument === '--input-file') {
      sources.push({
        kind: 'file',
        path: runtime.resolvePath(required(arguments_[index + 1], 'input file path')),
      });
      index += 2;
      continue;
    }
    throw new AppError('bad_request', `Unknown call argument: ${String(argument)}`, 400);
  }
  if (sources.length > 1) {
    throw new AppError('bad_request', 'Choose only one tool input source', 400);
  }
  const source = sources[0];
  let serialized: string;
  if (!source) {
    serialized = '{}';
  } else if (source.kind === 'inline') {
    serialized = source.value;
  } else if (source.kind === 'stdin') {
    serialized = await runtime.readStdin(MAX_AGENT_INPUT_BYTES);
  } else {
    try {
      serialized = runtime.readFile(source.path, MAX_AGENT_INPUT_BYTES);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('bad_request', `Could not read tool input file: ${source.path}`, 400);
    }
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AGENT_INPUT_BYTES) {
    throw new AppError(
      'payload_too_large',
      `Tool input exceeds ${String(MAX_AGENT_INPUT_BYTES)} UTF-8 bytes`,
      413,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    throw new AppError('bad_request', 'Tool input must be valid JSON', 400);
  }
  if (!isRecord(input)) {
    throw new AppError('bad_request', 'Tool input must be a JSON object', 400);
  }
  return { name, input };
}

async function withAgentClient<T>(
  runtime: CliRuntime,
  operation: (client: AgentCliClient) => Promise<T>,
): Promise<T> {
  const client = await runtime.createAgentClient();
  try {
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function executeCli(
  arguments_: string[],
  runtime: CliRuntime,
): Promise<AgentErrorEnvelope | null> {
  const [command, ...args] = arguments_;
  if (!command) {
    throw new AppError('bad_request', 'Missing command', 400, false, { usage: CLI_USAGE });
  }
  if (command === 'help') {
    runtime.stdout(CLI_USAGE);
    return null;
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
    return null;
  }

  if (command === 'config') {
    print(runtime, createAgentSuccessEnvelope(runtime.describeConfig()));
    return null;
  }
  if (command === 'tools') {
    const catalog = await withAgentClient(runtime, (client) => client.listTools());
    print(runtime, createAgentSuccessEnvelope(catalog));
    return null;
  }
  if (command === 'call') {
    const { name, input } = await parseToolInput(args, runtime);
    const envelope = await withAgentClient(runtime, async (client) =>
      extractAgentEnvelope(await client.callTool({ name, arguments: input })),
    );
    if ('error' in envelope) return envelope;
    print(runtime, envelope);
    return null;
  }

  if (command === 'install') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--service-only')) {
      throw new AppError(
        'bad_request',
        'Install accepts only the optional --service-only flag',
        400,
      );
    }
    const manager =
      args[0] === '--service-only'
        ? (runtime.serviceOnlyManager ?? runtime.serviceManager)
        : runtime.serviceManager;
    print(runtime, await manager.install());
    return null;
  }
  if (command === 'status') {
    print(runtime, await runtime.serviceManager.status());
    return null;
  }
  if (command === 'uninstall') {
    print(runtime, await runtime.serviceManager.uninstall());
    return null;
  }

  const client = runtime.createClient();
  switch (command) {
    case 'health':
      print(runtime, await client.health());
      return null;
    case 'overview':
      print(runtime, await client.getOverview());
      return null;
    case 'workspace:list':
      print(runtime, await client.listWorkspaces());
      return null;
    case 'workspace:add':
      print(
        runtime,
        await client.registerWorkspace({
          id: required(args[0], 'workspace id'),
          name: required(args[1], 'workspace name'),
          rootPath: runtime.resolvePath(required(args[2], 'workspace root path')),
        }),
      );
      return null;
    case 'work:list':
      print(
        runtime,
        await client.listWork({
          workspaceId: args[0] ?? null,
          projectId: args[1] ?? null,
          specId: args[2] ?? null,
          limit: 50,
        }),
      );
      return null;
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
      return null;
    case 'work:renew':
      print(
        runtime,
        await client.renewWork({
          targetType: targetType(args[0]),
          targetId: required(args[1], 'target id'),
          agentId: required(args[2], 'agent id'),
          leaseSeconds: 1_800,
        }),
      );
      return null;
    case 'work:release':
      await client.releaseWork({
        targetType: targetType(args[0]),
        targetId: required(args[1], 'target id'),
        agentId: required(args[2], 'agent id'),
        note: args[3] ?? null,
      });
      print(runtime, { released: true });
      return null;
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
      return null;
    case 'project:create':
      print(
        runtime,
        await client.createProject({
          workspaceId: required(args[0], 'workspace id'),
          slug: required(args[1], 'project slug'),
          title: required(args[2], 'project title'),
          actor: 'cli',
        }),
      );
      return null;
    case 'project:get':
      print(runtime, await client.getProject(required(args[0], 'project id')));
      return null;
    case 'project:draft':
    case 'project:open':
    case 'project:pause': {
      const state =
        command === 'project:pause' ? 'paused' : command === 'project:open' ? 'open' : 'draft';
      print(
        runtime,
        await client.updateProject({
          projectId: required(args[0], 'project id'),
          title: null,
          state,
          expectedRevision: revision(args[1]),
          actor: 'cli',
        }),
      );
      return null;
    }
    case 'project:complete':
      print(
        runtime,
        await client.completeProject({
          projectId: required(args[0], 'project id'),
          expectedRevision: revision(args[1]),
          summary: required(args[2], 'summary'),
          artifacts: [],
          actor: 'cli',
        }),
      );
      return null;
    case 'project:cancel':
      print(
        runtime,
        await client.cancelProject({
          projectId: required(args[0], 'project id'),
          expectedRevision: revision(args[1]),
          reason: required(args[2], 'reason'),
          actor: 'cli',
        }),
      );
      return null;
    case 'spec:create': {
      const bodyFile = args[3];
      print(
        runtime,
        await client.createSpec({
          projectId: required(args[0], 'project id'),
          slug: required(args[1], 'spec slug'),
          title: required(args[2], 'spec title'),
          body: bodyFile ? runtime.readFile(bodyFile) : '',
          actor: 'cli',
        }),
      );
      return null;
    }
    case 'spec:get':
      print(runtime, await client.getSpec(required(args[0], 'spec id')));
      return null;
    case 'spec:draft':
    case 'spec:ready':
      print(
        runtime,
        await client.updateSpec({
          specId: required(args[0], 'spec id'),
          title: null,
          body: null,
          state: command === 'spec:ready' ? 'ready' : 'draft',
          expectedRevision: revision(args[1]),
          actor: 'cli',
        }),
      );
      return null;
    case 'spec:cancel':
      print(
        runtime,
        await client.cancelSpec({
          specId: required(args[0], 'spec id'),
          expectedRevision: revision(args[1]),
          reason: required(args[2], 'reason'),
          actor: 'cli',
        }),
      );
      return null;
    case 'task:create':
      print(
        runtime,
        await client.createTask({
          specId: required(args[0], 'spec id'),
          title: required(args[1], 'task title'),
          parentId: args[2] ?? null,
          body: null,
          actor: 'cli',
        }),
      );
      return null;
    case 'task:get':
      print(runtime, await client.getTask(required(args[0], 'task id')));
      return null;
    case 'task:cancel':
      print(
        runtime,
        await client.cancelTask({
          taskId: required(args[0], 'task id'),
          expectedRevision: revision(args[1]),
          reason: required(args[2], 'reason'),
          actor: 'cli',
        }),
      );
      return null;
    case 'backup':
      if (args[0] === 'status') {
        acceptOptionalJsonFlag(args, 1);
        print(runtime, await client.getAutomaticBackupStatus());
        return null;
      }
      if (args[0] === 'configure') {
        acceptOptionalJsonFlag(args, 2);
        print(
          runtime,
          await client.configureAutomaticBackup(
            runtime.resolvePath(required(args[1], 'backup directory')),
          ),
        );
        return null;
      }
      if (args[0] === 'retry') {
        acceptOptionalJsonFlag(args, 1);
        const status = await client.retryAutomaticBackup();
        if (status.state === 'error') {
          throw new AppError(
            'internal_error',
            status.error ?? 'Automatic backup retry failed',
            500,
            true,
          );
        }
        print(runtime, status);
        return null;
      }
      if (args[0] === 'disable') {
        acceptOptionalJsonFlag(args, 1);
        print(runtime, await client.disableAutomaticBackup());
        return null;
      }
      print(
        runtime,
        await client.backup(runtime.resolvePath(required(args[0], 'backup directory'))),
      );
      return null;
    case 'export':
      print(
        runtime,
        await client.exportPortable(runtime.resolvePath(required(args[0], 'export directory'))),
      );
      return null;
    case 'sync': {
      const action = required(args[0], 'sync action');
      if (action === 'status') {
        acceptOptionalJsonFlag(args, 1);
        print(runtime, await client.getSyncStatus());
        return null;
      }
      if (action === 'configure') {
        const directory = runtime.resolvePath(required(args[1], 'shared folder'));
        const deviceIndex = args.indexOf('--device');
        if (deviceIndex !== 2 || !args[3] || args.slice(4).some((value) => value !== '--json')) {
          throw new AppError(
            'bad_request',
            'Use sync configure <directory> --device <device-id> [--json]',
            400,
          );
        }
        print(runtime, await client.configureSync(directory, args[3]));
        return null;
      }
      if (action === 'resolve') {
        const conflictId = required(args[1], 'conflict id');
        const choice = required(args[2], 'conflict choice');
        if (
          (choice !== 'local' && choice !== 'remote') ||
          args.slice(3).some((value) => value !== '--json')
        ) {
          throw new AppError(
            'bad_request',
            'Use sync resolve <conflict-id> <local|remote> [--json]',
            400,
          );
        }
        print(runtime, await client.resolveSyncConflict(conflictId, choice));
        return null;
      }
      acceptOptionalJsonFlag(args, 1);
      if (action === 'now') print(runtime, await client.reconcileSync());
      else if (action === 'pause') print(runtime, await client.pauseSync());
      else if (action === 'resume') print(runtime, await client.resumeSync());
      else if (action === 'conflicts') print(runtime, await client.listSyncConflicts());
      else if (action === 'forget') print(runtime, await client.forgetSync());
      else throw new AppError('bad_request', `Unknown sync action: ${action}`, 400);
      return null;
    }
    default:
      throw new AppError('bad_request', `Unknown command: ${command}`, 400, false, {
        usage: CLI_USAGE,
      });
  }
}

export async function runCli(arguments_: string[], runtime: CliRuntime): Promise<void> {
  let failure: AgentErrorEnvelope | null;
  try {
    failure = await executeCli(arguments_, runtime);
  } catch (error) {
    failure = createAgentErrorEnvelope(error);
  }
  if (failure) {
    writeError(runtime, failure);
    runtime.exit(1);
  }
}
