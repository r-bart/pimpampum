import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import {
  acquireInstanceLock,
  startServer,
  type InstanceLockIo,
  type RunningServer,
} from '../src/server.js';
import { PIMPAMPUM_VERSION } from '../src/version.js';
import { canonicalJson, syncHash } from '../src/syncState.js';

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
    expect(await response.json()).toEqual({
      status: 'ok',
      version: PIMPAMPUM_VERSION,
      ready: true,
    });
    const shared = join(directory, 'shared');
    mkdirSync(shared);
    const syncResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/settings/sync`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${running.config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ directory: shared, deviceId: 'server' }),
    });
    expect(syncResponse.status).toBe(200);
    const workspaceResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workspaces`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${running.config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'server-test', name: 'Server test', rootPath: directory }),
    });
    expect(workspaceResponse.status).toBe(201);
    const state = {
      workspaces: [],
      projects: [],
      specs: [],
      contexts: [],
      tasks: [],
      activity: [],
    };
    const remoteDirectory = join(shared, 'Pimpampum/devices/remote');
    mkdirSync(remoteDirectory, { recursive: true });
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotId: randomUUID(),
      deviceId: 'remote',
      sequence: 1,
      createdAt: new Date().toISOString(),
      parentSnapshots: [],
      stateHash: syncHash(state),
      state,
    };
    writeFileSync(
      join(remoteDirectory, `000000000001-${snapshot.snapshotId}.json`),
      canonicalJson(snapshot),
    );
    const reconcile = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/settings/sync/reconcile`,
      { method: 'POST', headers: { authorization: `Bearer ${running.config.token}` } },
    );
    expect(reconcile.status).toBe(200);
    await running.close();
    await running.close();
    running = null;
  });

  it('refreshes a persisted automatic backup destination during startup', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-backup-'));
    const backupDirectory = join(directory, 'backup');
    mkdirSync(backupDirectory);
    writeFileSync(
      join(directory, 'settings.json'),
      `${JSON.stringify({ schemaVersion: 1, backupDirectory })}\n`,
    );

    running = await startServer(config());
    await vi.waitFor(() => {
      expect(existsSync(join(backupDirectory, 'pimpampum-latest.sqlite'))).toBe(true);
    });
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

  it('starts with backup in state error when persisted backup settings are corrupt', async () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-server-settings-'));
    const settingsPath = join(directory, 'settings.json');
    writeFileSync(settingsPath, 'not json');

    running = await startServer(config());
    const address = running.server.address() as AddressInfo;
    const headers = { authorization: `Bearer ${running.config.token}` };
    const status = await fetch(`http://127.0.0.1:${address.port}/api/v1/settings/backup`, {
      headers,
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { data: unknown }).data).toMatchObject({
      enabled: false,
      state: 'error',
      error: expect.stringContaining('backup settings are invalid'),
    });
    const backupDirectory = join(directory, 'repaired');
    mkdirSync(backupDirectory);
    const repaired = await fetch(`http://127.0.0.1:${address.port}/api/v1/settings/backup`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ directory: backupDirectory }),
    });
    expect(((await repaired.json()) as { data: { state: string } }).data.state).toBe('healthy');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      backupDirectory,
    });
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

describe('instance lock takeover', () => {
  const directory = '/locks';
  const lockPath = join(directory, '.instance.lock');

  function fakeIo(overrides: Partial<InstanceLockIo> = {}, files = new Map<string, string>()) {
    const errno = (code: string) => Object.assign(new Error(code), { code });
    const io: InstanceLockIo = {
      writeFileSync: vi.fn((path: string, data: string) => {
        if (files.has(path)) throw errno('EEXIST');
        files.set(path, data);
      }),
      readFileSync: vi.fn((path: string) => {
        const content = files.get(path);
        if (content === undefined) throw errno('ENOENT');
        return content;
      }),
      renameSync: vi.fn((from: string, to: string) => {
        const content = files.get(from);
        if (content === undefined) throw errno('ENOENT');
        files.delete(from);
        files.set(to, content);
      }),
      rmSync: vi.fn((path: string) => {
        files.delete(path);
      }),
      processIsAlive: vi.fn(() => false),
      ...overrides,
    };
    return { io, files };
  }

  it('renames a stale lock aside and takes over without deleting a fresh one', () => {
    const { io, files } = fakeIo();
    files.set(lockPath, '4242\n');
    const release = acquireInstanceLock(directory, io);
    expect(files.get(lockPath)).toBe(`${process.pid}\n`);
    expect([...files.keys()]).toEqual([lockPath]);
    release();
    expect(files.size).toBe(0);
  });

  it('retries when the lock vanishes between the create and the read or the rename', () => {
    const vanishing = fakeIo();
    vanishing.files.set(lockPath, '4242\n');
    let reads = 0;
    vanishing.io.readFileSync = vi.fn(() => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return vanishing.files.get(lockPath) ?? `${process.pid}\n`;
    });
    vanishing.io.writeFileSync = vi.fn((path: string, data: string) => {
      if (reads === 0) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      vanishing.files.set(path, data);
    });
    acquireInstanceLock(directory, vanishing.io);
    expect(vanishing.files.get(lockPath)).toBe(`${process.pid}\n`);

    const renamed = fakeIo();
    renamed.files.set(lockPath, '4242\n');
    let renames = 0;
    const originalRename = renamed.io.renameSync;
    renamed.io.renameSync = vi.fn((from: string, to: string) => {
      renames += 1;
      if (renames === 1) {
        renamed.files.delete(from);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      originalRename(from, to);
    });
    acquireInstanceLock(directory, renamed.io);
    expect(renamed.files.get(lockPath)).toBe(`${process.pid}\n`);
  });

  it('gives a live lock back when it replaced the stale one during the takeover', () => {
    const { io, files } = fakeIo({ processIsAlive: (pid) => pid === 777 });
    files.set(lockPath, '4242\n');
    const originalRename = io.renameSync;
    io.renameSync = vi.fn((from: string, to: string) => {
      files.set(from, '777\n');
      originalRename(from, to);
    });
    expect(() => acquireInstanceLock(directory, io)).toThrow(/Another Pimpampum daemon/u);
    expect(files.get(lockPath)).toBe('777\n');
    expect(files.size).toBe(1);

    const contended = fakeIo({ processIsAlive: (pid) => pid === 777 });
    contended.files.set(lockPath, '4242\n');
    const rename = contended.io.renameSync;
    contended.io.renameSync = vi.fn((from: string, to: string) => {
      contended.files.set(from, '777\n');
      rename(from, to);
      contended.files.set(lockPath, '999\n');
    });
    expect(() => acquireInstanceLock(directory, contended.io)).toThrow(/Another Pimpampum daemon/u);
    expect(contended.files.get(lockPath)).toBe('999\n');
  });

  it('treats a vanished or unchanged moved file as a completed takeover', () => {
    const { io, files } = fakeIo();
    files.set(lockPath, '4242\n');
    const originalRename = io.renameSync;
    io.renameSync = vi.fn((from: string, to: string) => {
      originalRename(from, to);
      files.delete(to);
    });
    acquireInstanceLock(directory, io);
    expect(files.get(lockPath)).toBe(`${process.pid}\n`);
  });

  it('gives up after bounded attempts and propagates unexpected filesystem failures', () => {
    const { io } = fakeIo({
      writeFileSync: () => {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      },
      readFileSync: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(() => acquireInstanceLock(directory, io)).toThrow(/Another Pimpampum daemon/u);

    const unreadable = fakeIo({
      readFileSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    });
    unreadable.files.set(lockPath, '4242\n');
    expect(() => acquireInstanceLock(directory, unreadable.io)).toThrow(/EACCES/u);

    const unmovable = fakeIo({
      renameSync: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
    });
    unmovable.files.set(lockPath, '4242\n');
    expect(() => acquireInstanceLock(directory, unmovable.io)).toThrow(/EPERM/u);

    const restoreFails = fakeIo({ processIsAlive: (pid) => pid === 777 });
    restoreFails.files.set(lockPath, '4242\n');
    const rename = restoreFails.io.renameSync;
    restoreFails.io.renameSync = vi.fn((from: string, to: string) => {
      restoreFails.files.set(from, '777\n');
      rename(from, to);
    });
    const write = restoreFails.io.writeFileSync;
    let writes = 0;
    restoreFails.io.writeFileSync = vi.fn((path: string, data: string, options) => {
      writes += 1;
      if (writes === 2) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      write(path, data, options);
    });
    expect(() => acquireInstanceLock(directory, restoreFails.io)).toThrow(/EROFS/u);
  });
});
