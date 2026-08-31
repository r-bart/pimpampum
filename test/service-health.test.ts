import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHealthVerifiedServiceManager } from '../src/cliMain.js';
import { verifyServiceHealth } from '../src/service/health.js';
import type { PlatformServiceAdapter } from '../src/service/types.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded service health verification', () => {
  it('verifies a fresh install without re-entering the service lifecycle lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-health-manager-'));
    roots.push(root);
    const homeDirectory = join(root, 'home');
    const dataDirectory = join(root, 'data');
    mkdirSync(homeDirectory);
    mkdirSync(dataDirectory);
    const healthVerifier = vi.fn(async () => undefined);
    const adapter: PlatformServiceAdapter = {
      id: 'health-test',
      platform: 'linux',
      artifacts: () => [
        { path: join(homeDirectory, 'service.unit'), content: 'service', mode: 0o600 },
      ],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => {
        throw new Error('status re-entered during installation');
      },
    };
    const manager = createHealthVerifiedServiceManager(
      {
        platform: 'linux',
        homeDirectory,
        dataDirectory,
        nodePath: process.execPath,
        cliPath: join(process.cwd(), 'dist/cli.js'),
        version: '1.2.5',
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        adapters: { linux: adapter },
      },
      healthVerifier,
    );

    await expect(manager.install()).resolves.toMatchObject({ installed: true });
    expect(healthVerifier).toHaveBeenCalledOnce();
    expect(healthVerifier).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:7337',
      version: '1.2.5',
    });
  });

  it('retries loopback health until the exact installed version is ready', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('starting'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', version: '1.1.3' })));
    const sleep = vi.fn(async () => undefined);

    await verifyServiceHealth({
      baseUrl: 'http://127.0.0.1:7337',
      version: '1.1.3',
      attempts: 2,
      fetchImplementation,
      sleep,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      new URL('http://127.0.0.1:7337/health'),
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('fails closed on timeout, wrong versions, oversized data, and non-loopback endpoints', async () => {
    const cancel = vi.fn();
    await expect(
      verifyServiceHealth({
        baseUrl: 'http://localhost:7337',
        version: '1.1.3',
        attempts: 1,
        fetchImplementation: vi.fn(async () => {
          throw new Error('timeout');
        }),
      }),
    ).rejects.toThrow(/did not become healthy/iu);
    await expect(
      verifyServiceHealth({
        baseUrl: 'http://[::1]:7337',
        version: '1.1.3',
        attempts: 1,
        fetchImplementation: vi.fn(
          async () => new Response(JSON.stringify({ status: 'ok', version: '1.1.4' })),
        ),
      }),
    ).rejects.toThrow(/did not become healthy/iu);
    await expect(
      verifyServiceHealth({
        baseUrl: 'http://127.0.0.1:7337',
        version: '1.1.3',
        attempts: 1,
        fetchImplementation: vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(4097));
                },
                cancel,
              }),
            ),
        ),
      }),
    ).rejects.toThrow(/did not become healthy/iu);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(
      verifyServiceHealth({ baseUrl: 'https://example.test', version: '1.1.3' }),
    ).rejects.toThrow(/loopback/iu);
    await expect(
      verifyServiceHealth({ baseUrl: 'http://user@localhost:7337', version: '1.1.3' }),
    ).rejects.toThrow(/loopback/iu);
  });

  it('rejects unsafe retry bounds before making a request', async () => {
    await expect(
      verifyServiceHealth({ baseUrl: 'http://127.0.0.1', version: '1.1.3', attempts: 0 }),
    ).rejects.toThrow(/attempts/iu);
    await expect(
      verifyServiceHealth({ baseUrl: 'http://127.0.0.1', version: '1.1.3', attempts: 301 }),
    ).rejects.toThrow(/attempts/iu);
    await expect(
      verifyServiceHealth({
        baseUrl: 'http://127.0.0.1',
        version: '1.1.3',
        requestTimeoutMilliseconds: 0,
      }),
    ).rejects.toThrow(/timing/iu);
    await expect(
      verifyServiceHealth({
        baseUrl: 'http://127.0.0.1',
        version: '1.1.3',
        retryIntervalMilliseconds: 1001,
      }),
    ).rejects.toThrow(/timing/iu);
  });

  it('uses bounded default retries and rejects malformed HTTP bodies before parsing', async () => {
    const eventuallyHealthy = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('not listening'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', version: '1.1.3' })));
    await verifyServiceHealth({
      baseUrl: 'http://127.0.0.1:7337',
      version: '1.1.3',
      attempts: 2,
      retryIntervalMilliseconds: 0,
      fetchImplementation: eventuallyHealthy,
    });
    const globalFetch = vi.fn(
      async () => new Response(JSON.stringify({ status: 'ok', version: '1.1.3' })),
    );
    vi.stubGlobal('fetch', globalFetch);
    await verifyServiceHealth({
      baseUrl: 'http://127.0.0.1:7337',
      version: '1.1.3',
      attempts: 1,
    });
    expect(globalFetch).toHaveBeenCalledOnce();
    await expect(
      verifyServiceHealth({
        baseUrl: 'http://127.0.0.1:7337',
        version: '1.1.3',
        attempts: 1,
        fetchImplementation: vi.fn(
          async () => new Response(null, { headers: { 'content-length': '4097' } }),
        ),
      }),
    ).rejects.toThrow(/did not become healthy/iu);
    await expect(
      verifyServiceHealth({
        baseUrl: 'http://127.0.0.1:7337',
        version: '1.1.3',
        attempts: 1,
        fetchImplementation: vi.fn(async () => new Response(null)),
      }),
    ).rejects.toThrow(/did not become healthy/iu);
    await expect(
      verifyServiceHealth({
        baseUrl: 'http://127.0.0.1:7337',
        version: '1.1.3',
        attempts: 1,
        fetchImplementation: vi.fn(async () => new Response(null, { status: 503 })),
      }),
    ).rejects.toThrow(/did not become healthy/iu);
  });
});
