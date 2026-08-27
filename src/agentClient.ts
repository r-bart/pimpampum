import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
  type StreamableHTTPClientTransportOptions,
  type Transport,
} from '@modelcontextprotocol/client';
import { createAgentErrorEnvelope } from './agentProtocol.js';
import { AppError } from './errors.js';

export interface AgentCliClient {
  listTools(): Promise<ListToolsResult>;
  callTool(params: CallToolRequest['params']): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface AgentCliClientConfig {
  baseUrl: string;
  token: string;
}

interface McpClient {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<ListToolsResult>;
  callTool(params: CallToolRequest['params']): Promise<CallToolResult>;
  close(): Promise<void>;
}

interface AgentCliClientFactories {
  createClient(): McpClient;
  createTransport(url: URL, options: StreamableHTTPClientTransportOptions): Transport;
}

const defaultFactories: AgentCliClientFactories = {
  createClient: () =>
    new Client(
      { name: 'pimpampum-agent-cli', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    ),
  createTransport: (url, options) => new StreamableHTTPClientTransport(url, options),
};

function normalizeClientError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (
    UnauthorizedError.isInstance(error) ||
    (SdkHttpError.isInstance(error) && (error.status === 401 || error.status === 403))
  ) {
    return new AppError('unauthorized', 'Pimpampum rejected the configured token', 401);
  }
  if (ProtocolError.isInstance(error)) {
    if (
      error.code === ProtocolErrorCode.MethodNotFound ||
      error.code === ProtocolErrorCode.ResourceNotFound ||
      /\bnot found\b/iu.test(error.message)
    ) {
      return new AppError('not_found', error.message, 404);
    }
    if (
      error.code === ProtocolErrorCode.InvalidParams ||
      error.code === ProtocolErrorCode.InvalidRequest
    ) {
      return new AppError('bad_request', error.message, 400);
    }
  }
  return new AppError('internal_error', 'Pimpampum is unavailable', 503, true);
}

function normalizeToolResult(result: CallToolResult): CallToolResult {
  const block = result.content.length === 1 ? result.content[0] : undefined;
  if (
    result.isError === true &&
    block?.type === 'text' &&
    block.text.startsWith('Input validation error:')
  ) {
    return {
      ...result,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            createAgentErrorEnvelope(new AppError('bad_request', block.text, 400)),
          ),
        },
      ],
    };
  }
  return result;
}

export async function createAgentCliClient(
  config: AgentCliClientConfig,
  factories: AgentCliClientFactories = defaultFactories,
): Promise<AgentCliClient> {
  const client = factories.createClient();
  const transport = factories.createTransport(
    new URL(`${config.baseUrl.replace(/\/+$/, '')}/mcp`),
    { authProvider: { token: async () => config.token } },
  );

  try {
    await client.connect(transport);
  } catch (connectionError) {
    await client.close().catch(() => undefined);
    throw normalizeClientError(connectionError);
  }

  return {
    listTools: async () => {
      try {
        return await client.listTools();
      } catch (error) {
        throw normalizeClientError(error);
      }
    },
    callTool: async (params) => {
      try {
        return normalizeToolResult(await client.callTool(params));
      } catch (error) {
        throw normalizeClientError(error);
      }
    },
    close: () => client.close(),
  };
}
