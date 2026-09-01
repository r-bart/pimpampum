/**
 * @generated-from thoughts/specs/2026-08-26_agent-first-cli.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliRuntime } from '../src/cliProgram.js';

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

function fixture() {
  const output: string[] = [];
  const errors: string[] = [];
  let stdin = '';
  const files = new Map<string, string>();
  const tools = [
    {
      name: 'workspace_list',
      title: 'List workspaces',
      description: 'List every directory root registered in this local Pimpampum instance.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
  const agentClient = {
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(async ({ name, arguments: input }: { name: string; arguments: unknown }) => ({
      isError: false as boolean,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ data: { name, input } }),
        },
      ],
    })),
    close: vi.fn(async () => undefined),
  };
  const runtime = {
    createClient: vi.fn(),
    createAgentClient: vi.fn(async () => agentClient),
    describeConfig: vi.fn(() => ({
      dataDirectory: '/Users/agent/.pimpampum',
      databasePath: '/Users/agent/.pimpampum/pimpampum.sqlite',
      baseUrl: 'http://127.0.0.1:7337',
      tokenPath: '/Users/agent/.pimpampum/token',
      tokenConfigured: true,
      mcp: {
        streamableHttpUrl: 'http://127.0.0.1:7337/mcp',
        stdio: {
          command: '/usr/bin/node',
          args: ['/opt/pimpampum/dist/mcpStdio.js'],
        },
      },
    })),
    serviceManager: {
      install: vi.fn(),
      status: vi.fn(),
      uninstall: vi.fn(),
    },
    startServer: vi.fn(),
    readFile: vi.fn((path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing file: ${path}`);
      return value;
    }),
    readStdin: vi.fn(() => stdin),
    resolvePath: (path: string) => `/resolved/${path}`,
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
    onSignal: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new CliExit(code);
    }),
  } as unknown as CliRuntime;

  return {
    agentClient,
    errors,
    files,
    output,
    runtime,
    setStdin(value: string) {
      stdin = value;
    },
    tools,
  };
}

function payload<T>(chunks: string[]): T {
  expect(chunks).toHaveLength(1);
  return JSON.parse(chunks[0]!) as T;
}

describe('Agent-first CLI', () => {
  it('US-1/AC-2: reports effective configuration without exposing the token', async () => {
    // Spec: US-1/AC-2, US-1/AC-3
    const state = fixture();
    await runCli(['config'], state.runtime);

    const result = payload<{ data: Record<string, unknown> }>(state.output);
    expect(result.data).toMatchObject({
      dataDirectory: '/Users/agent/.pimpampum',
      baseUrl: 'http://127.0.0.1:7337',
      tokenPath: '/Users/agent/.pimpampum/token',
      tokenConfigured: true,
      mcp: { streamableHttpUrl: 'http://127.0.0.1:7337/mcp' },
    });
    expect(JSON.stringify(result)).not.toContain('secret-token-value');
  });

  it('US-2: returns the live MCP tool catalog in one JSON envelope', async () => {
    // Spec: US-2/AC-1, US-2/AC-2, FR-1
    const state = fixture();
    await runCli(['tools'], state.runtime);

    expect(payload(state.output)).toEqual({ data: { tools: state.tools } });
    expect(state.agentClient.listTools).toHaveBeenCalledOnce();
    expect(state.agentClient.close).toHaveBeenCalledOnce();
    expect(state.errors).toEqual([]);
  });

  it('US-3/AC-1: invokes a tool with inline JSON', async () => {
    // Spec: US-3/AC-1, FR-2, FR-3
    const state = fixture();
    await runCli(
      ['call', 'work_list', '--input', '{"workspaceId":"vcomp","limit":20}'],
      state.runtime,
    );

    expect(state.agentClient.callTool).toHaveBeenCalledWith({
      name: 'work_list',
      arguments: { workspaceId: 'vcomp', limit: 20 },
    });
    expect(payload(state.output)).toEqual({
      data: { name: 'work_list', input: { workspaceId: 'vcomp', limit: 20 } },
    });
    expect(state.agentClient.close).toHaveBeenCalledOnce();
  });

  it('US-3/AC-2: accepts Unicode and multiline Markdown through stdin', async () => {
    // Spec: US-3/AC-2, EC-6
    const state = fixture();
    state.setStdin(JSON.stringify({ projectId: 'project-id', prd: '# Diseño\n\n“Pimpampum” 🚀' }));

    await runCli(['call', 'project_update_prd', '--stdin'], state.runtime);

    expect(state.agentClient.callTool).toHaveBeenCalledWith({
      name: 'project_update_prd',
      arguments: { projectId: 'project-id', prd: '# Diseño\n\n“Pimpampum” 🚀' },
    });
  });

  it('US-3/AC-3: reads structured input from a UTF-8 file', async () => {
    // Spec: US-3/AC-3
    const state = fixture();
    state.files.set('/resolved/request.json', '{"projectId":"project-id","limit":10}');

    await runCli(['call', 'activity_list', '--input-file', 'request.json'], state.runtime);

    expect(state.agentClient.callTool).toHaveBeenCalledWith({
      name: 'activity_list',
      arguments: { projectId: 'project-id', limit: 10 },
    });
  });

  it('US-3/AC-4: defaults zero-argument tools to an empty object', async () => {
    // Spec: US-3/AC-4
    const state = fixture();
    await runCli(['call', 'workspace_list'], state.runtime);

    expect(state.agentClient.callTool).toHaveBeenCalledWith({
      name: 'workspace_list',
      arguments: {},
    });
  });

  it.each([
    {
      name: 'missing tool name',
      command: ['call'],
      message: 'Missing tool name',
    },
    {
      name: 'malformed JSON',
      command: ['call', 'work_list', '--input', '{nope'],
      message: 'Tool input must be valid JSON',
    },
    {
      name: 'non-object JSON',
      command: ['call', 'work_list', '--input', '[]'],
      message: 'Tool input must be a JSON object',
    },
    {
      name: 'multiple sources',
      command: ['call', 'work_list', '--input', '{}', '--stdin'],
      message: 'Choose only one tool input source',
    },
    {
      name: 'unknown option',
      command: ['call', 'work_list', '--wat'],
      message: 'Unknown option for call: --wat',
    },
  ])('US-3/AC-5: rejects $name with structured JSON', async ({ command, message }) => {
    // Spec: US-3/AC-5, US-4/AC-2, US-4/AC-3
    const state = fixture();

    await expect(runCli(command, state.runtime)).rejects.toMatchObject({ code: 1 });
    expect(payload<{ error: { code: string; message: string } }>(state.errors)).toMatchObject({
      error: { code: 'bad_request', message },
    });
    expect(state.output).toEqual([]);
  });

  it('US-4: preserves MCP errors, exits non-zero, and closes the session', async () => {
    // Spec: US-4/AC-1, US-4/AC-3, US-4/AC-4, EC-5
    const state = fixture();
    const expected = {
      error: {
        code: 'revision_conflict',
        message: 'Expected revision 3, current revision is 4',
        retryable: true,
        details: { expectedRevision: 3, currentRevision: 4 },
        suggestion: 'Read the latest manifest, then retry with its current revision.',
      },
    };
    state.agentClient.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(expected) }],
    });

    await expect(
      runCli(['call', 'project_update', '--input', '{}'], state.runtime),
    ).rejects.toMatchObject({ code: 1 });

    expect(payload(state.errors)).toEqual(expected);
    expect(state.output).toEqual([]);
    expect(state.agentClient.close).toHaveBeenCalledOnce();
  });

  it('EC-3: rejects malformed MCP content and still closes the session', async () => {
    // Spec: FR-3, US-4/AC-2, US-4/AC-4, EC-3
    const state = fixture();
    state.agentClient.callTool.mockResolvedValueOnce({
      isError: false,
      content: [{ type: 'text', text: 'not-json' }],
    });

    await expect(runCli(['call', 'workspace_list'], state.runtime)).rejects.toMatchObject({
      code: 1,
    });

    expect(payload<{ error: { code: string } }>(state.errors).error.code).toBe('internal_error');
    expect(state.agentClient.close).toHaveBeenCalledOnce();
  });
});
