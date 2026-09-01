import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClientConfigResolver,
  ensureDataDirectory,
  loadConfig,
  missingDaemonTokenError,
  tokenPathOf,
} from '../src/config.js';

describe('client configuration reads', () => {
  let root = '';
  const environment = { ...process.env };

  afterEach(() => {
    process.env.PIMPAMPUM_DATA_DIR = environment.PIMPAMPUM_DATA_DIR;
    process.env.PIMPAMPUM_TOKEN = environment.PIMPAMPUM_TOKEN;
    if (process.env.PIMPAMPUM_DATA_DIR === undefined) delete process.env.PIMPAMPUM_DATA_DIR;
    if (process.env.PIMPAMPUM_TOKEN === undefined) delete process.env.PIMPAMPUM_TOKEN;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function isolate(): string {
    root = mkdtempSync(join(tmpdir(), 'pimpampum-config-read-'));
    const dataDirectory = join(root, 'data');
    process.env.PIMPAMPUM_DATA_DIR = dataDirectory;
    delete process.env.PIMPAMPUM_TOKEN;
    return dataDirectory;
  }

  it('reads without creating the data directory or a token when no daemon has run', () => {
    const dataDirectory = isolate();

    const config = loadConfig({}, { createToken: false });

    expect(config).toMatchObject({ dataDirectory, token: '' });
    expect(existsSync(dataDirectory)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('reads the token the daemon stored and never rewrites it', () => {
    const dataDirectory = isolate();
    const daemon = loadConfig();
    const stored = statSync(tokenPathOf(dataDirectory));

    const client = loadConfig({}, { createToken: false });

    expect(client.token).toBe(daemon.token);
    expect(statSync(tokenPathOf(dataDirectory)).mtimeMs).toBe(stored.mtimeMs);
  });

  it('prefers the environment token and validates a stored one in read mode', () => {
    const dataDirectory = isolate();
    process.env.PIMPAMPUM_TOKEN = 'e'.repeat(40);
    expect(loadConfig({}, { createToken: false }).token).toBe('e'.repeat(40));

    delete process.env.PIMPAMPUM_TOKEN;
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(tokenPathOf(dataDirectory), 'short\n');
    expect(() => loadConfig({}, { createToken: false })).toThrow(/Stored Pimpampum token/u);
  });

  it('propagates a read failure other than a missing token', () => {
    const dataDirectory = isolate();
    mkdirSync(tokenPathOf(dataDirectory), { recursive: true });

    expect(() => loadConfig({}, { createToken: false })).toThrow(/EISDIR/u);
  });

  it('creates the private directory on demand with owner-only permissions', () => {
    const dataDirectory = isolate();
    mkdirSync(dataDirectory, { recursive: true, mode: 0o755 });

    ensureDataDirectory(dataDirectory);

    expect(statSync(dataDirectory).mode & 0o777).toBe(0o700);
    ensureDataDirectory(join(dataDirectory, 'nested'));
    expect(statSync(join(dataDirectory, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('re-reads the token on every call until the daemon mints it, then caches it', () => {
    const dataDirectory = isolate();
    const resolve = createClientConfigResolver();

    expect(resolve().token).toBe('');
    expect(resolve().token).toBe('');
    const daemon = loadConfig();
    expect(resolve().token).toBe(daemon.token);

    rmSync(tokenPathOf(dataDirectory));
    expect(resolve().token).toBe(daemon.token);
  });

  it('accepts an injected loader and re-invokes it only while the token is empty', () => {
    let token = '';
    const load = vi.fn(() => ({
      host: '127.0.0.1',
      port: 7337,
      dataDirectory: '/data',
      databasePath: '/data/pimpampum.sqlite',
      token,
      baseUrl: 'http://127.0.0.1:7337',
    }));
    const resolve = createClientConfigResolver(load);
    resolve();
    resolve();
    expect(load).toHaveBeenCalledTimes(2);
    token = 't'.repeat(32);
    expect(resolve().token).toBe(token);
    resolve();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('describes a missing daemon token as a retryable unavailable failure naming the path', () => {
    const error = missingDaemonTokenError('/data');
    expect(error).toMatchObject({
      code: 'unavailable',
      status: 503,
      retryable: true,
      message: 'No daemon token at /data/token; the daemon writes it on its first start',
      details: { tokenPath: '/data/token' },
    });
  });
});
