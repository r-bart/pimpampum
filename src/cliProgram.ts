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

export const CLI_USAGE = `Pimpampum 0.1.0

Usage:
  pimpampum help
  pimpampum serve
  pimpampum health
  pimpampum overview
  pimpampum config
  pimpampum tools
  pimpampum call <tool-name> [--input <json> | --stdin | --input-file <path>]
  pimpampum install
  pimpampum status
  pimpampum uninstall
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
    print(runtime, await runtime.serviceManager.install());
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
      print(runtime, await client.listWork({ workspaceId: args[0] ?? null, limit: 50 }));
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
      return null;
    }
    case 'project:get':
      print(runtime, await client.getProject(required(args[0], 'project id')));
      return null;
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
      return null;
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
      return null;
    case 'backup':
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
