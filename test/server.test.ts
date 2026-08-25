import { existsSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { startServer, type RunningServer } from '../src/server.js';

describe('server composition', () => {
  let running: RunningServer | null = null;
  let directory = '';

  function config(port = 0): RuntimeConfig {
    return {
      host: '127.0.0.1',
      port,
      dataDirectory: directory,
      databasePath: join(directory, 'pimpampum.sqlite'),
      token: 'server-test-token'.repeat(2),
      baseUrl: `http://127.0.0.1:${port}`,
    };
  }

  afterEach(async () => {
    if (running) await running.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('starts on loopback with an ephemeral port and closes cleanly', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-'));
    running = await startServer({ ...config(), databasePath: ':memory:' });
    const address = running.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(await response.json()).toEqual({ status: 'ok', version: '0.1.0' });
    await running.close();
    await running.close();
    running = null;
  });

  it('cleans up composition resources when the server cannot bind', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-failure-'));

    await expect(startServer(config(-1))).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });
  });

  it('closes the store even if the HTTP server was already stopped', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-stopped-'));
    running = await startServer(config());
    await new Promise<void>((resolveClose, reject) => {
      running?.server.close((error) => (error ? reject(error) : resolveClose()));
    });
    await expect(running.close()).rejects.toThrow();
    await expect(running.close()).resolves.toBeUndefined();
    running = null;
  });

  it('enforces one live owner and recovers locks left by dead processes', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-lock-'));
    running = await startServer(config());
    await expect(startServer(config())).rejects.toMatchObject({ code: 'conflict' });
    await running.close();
    running = null;

    const lockPath = join(directory, '.instance.lock');
    writeFileSync(lockPath, '2147483647\n');
    running = await startServer(config());
    expect(existsSync(lockPath)).toBe(true);
    await running.close();
    running = null;
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, 'not-a-pid\n');
    await expect(startServer(config())).rejects.toMatchObject({ code: 'conflict' });
    rmSync(lockPath, { force: true });
  });

  it('treats inaccessible owner processes as live and cleans startup failures', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-startup-'));
    const lockPath = join(directory, '.instance.lock');
    writeFileSync(lockPath, '12345\n');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    await expect(startServer(config())).rejects.toMatchObject({ code: 'conflict' });
    kill.mockRestore();
    rmSync(lockPath, { force: true });

    await expect(startServer({ ...config(), token: 'short' })).rejects.toThrow(/printable ASCII/);
    expect(existsSync(lockPath)).toBe(false);
    running = await startServer(config());
  });

  it('rejects programmatic non-loopback binding and releases its lock', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-host-'));
    await expect(startServer({ ...config(), host: '0.0.0.0' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(existsSync(join(directory, '.instance.lock'))).toBe(false);
  });

  it('propagates instance-lock filesystem failures', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-filesystem-'));
    const missingDataDirectory = join(directory, 'missing', 'nested');
    await expect(
      startServer({
        ...config(),
        dataDirectory: missingDataDirectory,
        databasePath: join(missingDataDirectory, 'pimpampum.sqlite'),
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a live database outside its owning data directory', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-database-'));
    await expect(
      startServer({
        ...config(),
        databasePath: join(directory, 'shared.sqlite'),
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects linked database files that could bypass instance ownership', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-linked-'));
    const target = join(directory, 'target.sqlite');
    const databasePath = join(directory, 'pimpampum.sqlite');
    writeFileSync(target, 'not opened');

    symlinkSync(target, databasePath);
    await expect(startServer(config())).rejects.toMatchObject({ code: 'bad_request' });
    rmSync(databasePath);

    linkSync(target, databasePath);
    await expect(startServer(config())).rejects.toMatchObject({ code: 'bad_request' });
  });
});
