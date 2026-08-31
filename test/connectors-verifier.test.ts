import { describe, expect, it, vi } from 'vitest';
import { verifyMcpRoute } from '../src/connectors/verifier.js';

const route = {
  command: '/Users/example/.local/share/pimpampum/bin/pimpampum-mcp',
  arguments: [] as string[],
  timeoutMilliseconds: 1_000,
  requiredTools: ['project_list', 'work_claim'],
  expectedServerName: 'pimpampum',
};

describe('installed MCP route verifier', () => {
  it('requires identity and the complete bounded catalog and always closes', async () => {
    const probe = {
      initialize: vi.fn(async () => ({
        serverInfo: { name: 'pimpampum', version: '2.0.0' },
      })),
      listTools: vi.fn(async () => ({
        tools: [{ name: 'project_list' }, { name: 'work_claim' }],
      })),
      close: vi.fn(async () => undefined),
    };
    await expect(verifyMcpRoute({ ...route, spawn: () => probe })).resolves.toEqual({
      available: true,
      serverName: 'pimpampum',
      tools: ['project_list', 'work_claim'],
      diagnostics: [],
    });
    expect(probe.close).toHaveBeenCalledOnce();
  });

  it('fails closed and reaps on wrong identity, protocol, or missing tools', async () => {
    const cases = [
      {
        initialize: async () => ({ serverInfo: { name: 'other' } }),
        listTools: async () => ({ tools: [{ name: 'project_list' }, { name: 'work_claim' }] }),
      },
      {
        initialize: async () => ({
          serverInfo: { name: 'pimpampum' },
          protocolVersion: 'synthetic-unsupported',
        }),
        listTools: async () => ({ tools: [{ name: 'project_list' }, { name: 'work_claim' }] }),
      },
      {
        initialize: async () => ({ serverInfo: { name: 'pimpampum' } }),
        listTools: async () => ({ tools: [{ name: 'project_list' }] }),
      },
    ];
    for (const candidate of cases) {
      const close = vi.fn(async () => undefined);
      await expect(
        verifyMcpRoute({ ...route, spawn: () => ({ ...candidate, close }) }),
      ).rejects.toThrow(/identity|protocol|required/i);
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it('does not report leaked secrets and closes the probe', async () => {
    const token = 'pimpampum-private-token-never-report';
    const close = vi.fn(async () => undefined);
    let message = '';
    try {
      await verifyMcpRoute({
        ...route,
        spawn: () => ({
          initialize: async () => ({ serverInfo: { name: 'pimpampum' } }),
          listTools: async () => ({
            tools: [{ name: 'project_list' }, { name: 'work_claim' }],
            stderr: `Authorization: Bearer ${token}`,
          }),
          close,
        }),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/secret/i);
    expect(message).not.toContain(token);
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed when the route emits a secret during shutdown', async () => {
    const token = 'pimpampum-private-token-shutdown-leak';
    const finalDiagnostics: string[] = [];
    const close = vi.fn(async () => {
      finalDiagnostics.push(`Authorization: Bearer ${token}`);
    });
    let message = '';
    try {
      await verifyMcpRoute({
        ...route,
        spawn: () => ({
          initialize: async () => ({ serverInfo: { name: 'pimpampum' } }),
          listTools: async () => ({
            tools: [{ name: 'project_list' }, { name: 'work_claim' }],
          }),
          close,
          diagnostics: () => finalDiagnostics,
        }),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/secret|oversized/i);
    expect(message).not.toContain(token);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes a stalled or cancelled probe', async () => {
    const close = vi.fn(async () => undefined);
    const stalled = new Promise<never>(() => undefined);
    await expect(
      verifyMcpRoute({
        ...route,
        timeoutMilliseconds: 10,
        spawn: () => ({ initialize: () => stalled, listTools: () => stalled, close }),
      }),
    ).rejects.toThrow(/timed out/i);
    expect(close).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const cancelledClose = vi.fn(async () => undefined);
    controller.abort();
    await expect(
      verifyMcpRoute({
        ...route,
        signal: controller.signal,
        spawn: () => ({
          initialize: () => stalled,
          listTools: () => stalled,
          close: cancelledClose,
        }),
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(cancelledClose).toHaveBeenCalledOnce();
  });
});
