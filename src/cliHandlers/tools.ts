import { extractAgentEnvelope } from '../agentProtocol.js';
import { AppError } from '../errors.js';
import { MAX_AGENT_INPUT_BYTES } from '../limits.js';
import {
  badArgument,
  isRecord,
  print,
  printEnvelope,
  required,
  withAgentClient,
  type CliHandlerContext,
  type CliHandlerTable,
} from './support.js';

async function parseToolInput({
  command,
  input: parsed,
  runtime,
}: CliHandlerContext): Promise<{ name: string; input: Record<string, unknown> }> {
  const name = required(parsed.positional[0], 'tool name');
  const inline = parsed.option('--input');
  const inputFile = parsed.option('--input-file');
  const selected = [inline, inputFile, parsed.boolean('--stdin') ? 'stdin' : undefined].filter(
    (source) => source !== undefined,
  );
  if (selected.length > 1) throw badArgument(command, 'Choose only one tool input source');
  let serialized: string;
  if (inline !== undefined) {
    serialized = inline;
  } else if (parsed.boolean('--stdin')) {
    serialized = await runtime.readStdin(MAX_AGENT_INPUT_BYTES);
  } else if (inputFile !== undefined) {
    const path = runtime.resolvePath(inputFile);
    try {
      serialized = runtime.readFile(path, MAX_AGENT_INPUT_BYTES);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('bad_request', `Could not read tool input file: ${path}`, 400);
    }
  } else {
    serialized = '{}';
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

/** The MCP tool surface over the agent client: the catalog, and one call with bounded input. */
export const toolsHandlers: CliHandlerTable = {
  tools: async ({ runtime }) => {
    const catalog = await withAgentClient(runtime, (client) => client.listTools());
    print(runtime, catalog);
  },
  call: async (context) => {
    const { name, input } = await parseToolInput(context);
    const envelope = await withAgentClient(context.runtime, async (client) =>
      extractAgentEnvelope(await client.callTool({ name, arguments: input })),
    );
    if ('error' in envelope) return envelope;
    printEnvelope(context.runtime, envelope);
  },
};
