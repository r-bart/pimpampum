import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AppError } from './errors.js';

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  /** Empty only when `createToken` is `false` and no token is stored or configured. */
  token: string;
  baseUrl: string;
}

export interface LoadConfigOptions {
  /**
   * `true`, the default, is the daemon's mode: the data directory is created and a token is minted
   * when none is stored. `false` is every client's mode — the CLI verbs that talk to the daemon,
   * the stdio bridge and `config` — which reads without touching the filesystem. A client that
   * finds no token receives `token: ''` and decides how to report it; it never mints a credential
   * the daemon would then trust.
   */
  createToken?: boolean;
}

const TOKEN_FILE = 'token';

export function tokenPathOf(dataDirectory: string): string {
  return join(dataDirectory, TOKEN_FILE);
}

/** The typed failure a client reports while the daemon has not minted its token yet. */
export function missingDaemonTokenError(dataDirectory: string): AppError {
  const tokenPath = tokenPathOf(dataDirectory);
  return new AppError(
    'unavailable',
    `No daemon token at ${tokenPath}; the daemon writes it on its first start`,
    503,
    true,
    { tokenPath },
  );
}

/**
 * A client's view of the configuration when the daemon may not have run yet. While the stored
 * token is missing, every call re-reads it, so the daemon's first start is picked up without a
 * host restart; once a token is found the configuration is cached like any other read.
 */
export function createClientConfigResolver(
  load: () => RuntimeConfig = () => loadConfig({}, { createToken: false }),
): () => RuntimeConfig {
  let cached: RuntimeConfig | null = null;
  return () => {
    if (cached === null || cached.token === '') cached = load();
    return cached;
  };
}

/** Creates the private data directory. Only the daemon and the lifecycle verbs need it to exist. */
export function ensureDataDirectory(dataDirectory: string): void {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
}

function validateToken(token: string, source: string): string {
  if (!/^[\x21-\x7e]{32,}$/.test(token)) {
    throw new AppError(
      'bad_request',
      `${source} must contain at least 32 printable ASCII characters without spaces`,
      400,
    );
  }
  return token;
}

function readStoredToken(tokenPath: string): string {
  chmodSync(tokenPath, 0o600);
  return validateToken(readFileSync(tokenPath, 'utf8').trim(), 'Stored Pimpampum token');
}

function loadOrCreateToken(dataDirectory: string): string {
  const tokenPath = tokenPathOf(dataDirectory);
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(tokenPath, `${token}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readStoredToken(tokenPath);
    throw error;
  }
}

/** The pure read: a stored token when there is one, `''` when the daemon has not minted it yet. */
function readStoredTokenIfPresent(dataDirectory: string): string {
  let stored: string;
  try {
    stored = readFileSync(tokenPathOf(dataDirectory), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  return validateToken(stored.trim(), 'Stored Pimpampum token');
}

export function loadConfig(
  overrides: Partial<RuntimeConfig> = {},
  options: LoadConfigOptions = {},
): RuntimeConfig {
  const dataDirectory =
    overrides.dataDirectory ?? process.env.PIMPAMPUM_DATA_DIR ?? join(homedir(), '.pimpampum');
  if (!isAbsolute(dataDirectory)) {
    throw new AppError('bad_request', 'PIMPAMPUM_DATA_DIR must be an absolute path', 400);
  }

  const host = overrides.host ?? process.env.PIMPAMPUM_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new AppError(
      'bad_request',
      'PIMPAMPUM_HOST must be a loopback host (127.0.0.1, localhost, or ::1)',
      400,
    );
  }
  const port = overrides.port ?? Number(process.env.PIMPAMPUM_PORT ?? 7337);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError('bad_request', 'PIMPAMPUM_PORT must be an integer between 1 and 65535', 400);
  }
  const urlHost = host === '::1' ? '[::1]' : host;
  const createToken = options.createToken !== false;
  // The daemon owns the directory: SQLite, the token and every receipt live there. Clients only
  // read it, so a read-only home or a machine without an installation never gains a stray one.
  if (createToken) ensureDataDirectory(dataDirectory);

  return {
    host,
    port,
    dataDirectory,
    databasePath: overrides.databasePath ?? join(dataDirectory, 'pimpampum.sqlite'),
    token: resolveToken(dataDirectory, overrides.token, createToken),
    baseUrl: overrides.baseUrl ?? `http://${urlHost}:${port}`,
  };
}

function resolveToken(
  dataDirectory: string,
  override: string | undefined,
  createToken: boolean,
): string {
  if (override) return validateToken(override.trim(), 'Pimpampum token override');
  const configured = process.env.PIMPAMPUM_TOKEN?.trim();
  if (configured) return validateToken(configured, 'PIMPAMPUM_TOKEN');
  return createToken ? loadOrCreateToken(dataDirectory) : readStoredTokenIfPresent(dataDirectory);
}
