import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSetupCoordinator } from '../src/setup/coordinator.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('setup progress observer cleanup', () => {
  it('detaches a per-operation observer before a later retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-progress-cleanup-'));
    roots.push(root);
    const connector = {
      inspect: vi.fn(async () => ({ state: 'notConfigured' })),
      connect: vi.fn(async () => undefined),
      verify: vi
        .fn()
        .mockResolvedValueOnce({ available: false, newSessionRequired: false })
        .mockResolvedValue({ available: true, newSessionRequired: false }),
      restore: vi.fn(async () => undefined),
    };
    const coordinator = createSetupCoordinator({
      lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
      changeTargets: {
        runtimeDirectory: '/runtime',
        servicePath: '/service.plist',
        dataDirectory: '/data',
        connectorConfigPaths: { codex: '/codex.toml', 'claude-code': '/claude.json' },
      },
      runtime: { install: async () => ({ version: '1.0.0' }), rollback: async () => undefined },
      service: {
        install: async () => undefined,
        verify: async () => undefined,
        rollback: async () => undefined,
      },
      connectors: { codex: connector, 'claude-code': { ...connector } },
      loginItem: { register: async () => 'enabled' as const },
      dataDirectory: join(root, 'data'),
      now: () => '2026-08-31T10:00:00.000Z',
    });
    const plan = await coordinator.plan({ selectedConnectors: ['codex'] });
    const firstObserver = vi.fn();
    await coordinator.apply({
      operationId: plan.operationId,
      expectedRevision: plan.revision,
      confirmed: true,
      onProgress: firstObserver,
    });
    const countAfterApply = firstObserver.mock.calls.length;

    await coordinator.retryConnector('codex');

    expect(firstObserver).toHaveBeenCalledTimes(countAfterApply);
    expect(connector.verify).toHaveBeenCalledTimes(2);
  });
});
