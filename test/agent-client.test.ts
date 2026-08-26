import type {
  AuthProvider,
  CallToolResult,
  ListToolsResult,
  StreamableHTTPClientTransportOptions,
  Transport,
} from '@modelcontextprotocol/client';
import {
  ProtocolError,
  ProtocolErrorCode,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { createAgentCliClient } from '../src/agentClient.js';
import { AppError } from '../src/errors.js';

function fixture() {
  const tools: ListToolsResult = {
    tools: [
      {
        name: 'workspace_list',
        inputSchema: { type: 'object' },
      },
    ],
  };
  const result: CallToolResult = {
    content: [{ type: 'text', text: '{"data":[]}' }],
  };
  const client = {
    connect: vi.fn(async (_transport: Transport) => undefined),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async () => result),
    close: vi.fn(async () => undefined),
  };
  const transport = {} as Transport;
  const createTransport = vi.fn(
    (_url: URL, _options: StreamableHTTPClientTransportOptions) => transport,
  );
  const factories = {
    createClient: vi.fn(() => client),
    createTransport,
  };

  return { client, factories, result, tools, transport };
}

describe('agent CLI MCP client', () => {
  it('connects to the MCP endpoint with bearer authentication and forwards operations', async () => {
    const state = fixture();
    const agentClient = await createAgentCliClient(
      { baseUrl: 'http://127.0.0.1:7337/', token: 'secret-token' },
      state.factories,
    );

    expect(state.factories.createClient).toHaveBeenCalledOnce();
    expect(state.factories.createTransport).toHaveBeenCalledOnce();
    const [url, options] = state.factories.createTransport.mock.calls[0]!;
    expect(url.href).toBe('http://127.0.0.1:7337/mcp');
    await expect((options.authProvider as AuthProvider).token()).resolves.toBe('secret-token');
    expect(state.client.connect).toHaveBeenCalledWith(state.transport);

    await expect(agentClient.listTools()).resolves.toBe(state.tools);
    await expect(agentClient.callTool({ name: 'workspace_list', arguments: {} })).resolves.toBe(
      state.result,
    );
    expect(state.client.callTool).toHaveBeenCalledWith({
      name: 'workspace_list',
      arguments: {},
    });
    await agentClient.close();
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it('closes a partially initialized client and reports it as retryable unavailability', async () => {
    const state = fixture();
    const connectionError = new Error('daemon offline');
    state.client.connect.mockRejectedValueOnce(connectionError);

    await expect(
      createAgentCliClient(
        { baseUrl: 'http://127.0.0.1:7337', token: 'secret-token' },
        state.factories,
      ),
    ).rejects.toMatchObject({
      code: 'internal_error',
      message: 'Pimpampum is unavailable',
      retryable: true,
    });
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it('preserves the normalized connection failure when cleanup also fails', async () => {
    const state = fixture();
    const connectionError = new Error('unauthorized');
    state.client.connect.mockRejectedValueOnce(connectionError);
    state.client.close.mockRejectedValueOnce(new Error('close failed'));

    await expect(
      createAgentCliClient(
        { baseUrl: 'http://127.0.0.1:7337', token: 'secret-token' },
        state.factories,
      ),
    ).rejects.toMatchObject({ code: 'internal_error', retryable: true });
    expect(state.client.close).toHaveBeenCalledOnce();
  });

  it('uses the production MCP SDK factories by default', async () => {
    await expect(
      createAgentCliClient({ baseUrl: 'http://127.0.0.1:1', token: 'secret-token' }),
    ).rejects.toBeInstanceOf(Error);
  });

  it.each([
    {
      name: 'an auth challenge',
      error: new UnauthorizedError(),
      expected: { code: 'unauthorized', retryable: false },
    },
    {
      name: 'an HTTP forbidden response',
      error: new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'Forbidden', { status: 403 }),
      expected: { code: 'unauthorized', retryable: false },
    },
    {
      name: 'an HTTP server failure',
      error: new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, 'Failed', { status: 503 }),
      expected: { code: 'internal_error', retryable: true },
    },
    {
      name: 'a missing method',
      error: new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method missing'),
      expected: { code: 'not_found', retryable: false },
    },
    {
      name: 'a missing resource',
      error: new ProtocolError(ProtocolErrorCode.ResourceNotFound, 'Resource missing'),
      expected: { code: 'not_found', retryable: false },
    },
    {
      name: 'the SDK tool-not-found variant',
      error: new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool unknown not found'),
      expected: { code: 'not_found', retryable: false },
    },
    {
      name: 'invalid parameters',
      error: new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid input'),
      expected: { code: 'bad_request', retryable: false },
    },
    {
      name: 'an invalid request',
      error: new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Invalid request'),
      expected: { code: 'bad_request', retryable: false },
    },
    {
      name: 'an internal protocol failure',
      error: new ProtocolError(ProtocolErrorCode.InternalError, 'Internal'),
      expected: { code: 'internal_error', retryable: true },
    },
  ])('normalizes $name from tool calls', async ({ error, expected }) => {
    const state = fixture();
    state.client.callTool.mockRejectedValueOnce(error);
    const client = await createAgentCliClient(
      { baseUrl: 'http://127.0.0.1:7337', token: 'secret-token' },
      state.factories,
    );
    await expect(client.callTool({ name: 'operation', arguments: {} })).rejects.toMatchObject(
      expected,
    );
  });

  it('preserves an existing application error and normalizes list failures', async () => {
    const state = fixture();
    const applicationError = new AppError('conflict', 'Busy', 409, true);
    state.client.callTool.mockRejectedValueOnce(applicationError);
    state.client.listTools.mockRejectedValueOnce(new Error('offline'));
    const client = await createAgentCliClient(
      { baseUrl: 'http://127.0.0.1:7337', token: 'secret-token' },
      state.factories,
    );
    await expect(client.callTool({ name: 'operation', arguments: {} })).rejects.toBe(
      applicationError,
    );
    await expect(client.listTools()).rejects.toMatchObject({
      code: 'internal_error',
      retryable: true,
    });
  });

  it('turns SDK input-validation text into a Pimpampum error envelope', async () => {
    const state = fixture();
    state.client.callTool.mockResolvedValueOnce({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Input validation error: path must be absolute',
        },
      ],
    });
    const client = await createAgentCliClient(
      { baseUrl: 'http://127.0.0.1:7337', token: 'secret-token' },
      state.factories,
    );
    const normalized = await client.callTool({ name: 'workspace_resolve', arguments: {} });
    expect(normalized.isError).toBe(true);
    expect(JSON.parse((normalized.content[0] as { text: string }).text)).toMatchObject({
      error: { code: 'bad_request', suggestion: expect.any(String) },
    });
  });

  it.each([
    { content: [] },
    {
      isError: true,
      content: [
        { type: 'text' as const, text: 'Other failure' },
        { type: 'text' as const, text: 'Second block' },
      ],
    },
    { isError: true, content: [{ type: 'image' as const, data: 'AA==', mimeType: 'image/png' }] },
    { isError: true, content: [{ type: 'text' as const, text: 'Other failure' }] },
    {
      isError: true,
      content: [{ type: 'text' as const, text: 'Input Validation Error: changed SDK wording' }],
    },
  ] as CallToolResult[])('leaves non-validation tool result %# unchanged', async (result) => {
    const state = fixture();
    state.client.callTool.mockResolvedValueOnce(result);
    const client = await createAgentCliClient(
      { baseUrl: 'http://127.0.0.1:7337', token: 'secret-token' },
      state.factories,
    );
    await expect(client.callTool({ name: 'operation', arguments: {} })).resolves.toBe(result);
  });
});
