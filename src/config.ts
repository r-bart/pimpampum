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
  token: string;
  baseUrl: string;
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
  const configured = process.env.PIMPAMPUM_TOKEN?.trim();
  if (configured) return validateToken(configured, 'PIMPAMPUM_TOKEN');

  const tokenPath = join(dataDirectory, 'token');
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

export function loadConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const dataDirectory =
    overrides.dataDirectory ?? process.env.PIMPAMPUM_DATA_DIR ?? join(homedir(), '.pimpampum');
  if (!isAbsolute(dataDirectory)) {
    throw new AppError('bad_request', 'PIMPAMPUM_DATA_DIR must be an absolute path', 400);
  }
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);

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
  const token = overrides.token
    ? validateToken(overrides.token.trim(), 'Pimpampum token override')
    : loadOrCreateToken(dataDirectory);
  const urlHost = host === '::1' ? '[::1]' : host;

  return {
    host,
    port,
    dataDirectory,
    databasePath: overrides.databasePath ?? join(dataDirectory, 'pimpampum.sqlite'),
    token,
    baseUrl: overrides.baseUrl ?? `http://${urlHost}:${port}`,
  };
}
