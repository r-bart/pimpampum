import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { AppError } from './errors.js';

/**
 * One lifecycle lock for every mutation of the data directory: the setup coordinator, the
 * installation lifecycle, the runtime bootstrap and the platform service manager all serialize
 * through `.setup-lifecycle.lock`. The service layer imports this module instead of the setup
 * layer, so the lock lives here rather than in `src/setup/state.ts`.
 *
 * Acquisitions nest within one asynchronous call chain: an operation that already holds the lock
 * re-enters it without touching the file, so `setup apply` can drive `manager.install()` while
 * independent concurrent callers in the same process still contend for the file.
 */

export const LIFECYCLE_LOCK_FILE_NAME = '.setup-lifecycle.lock';
export const MAXIMUM_PRIVATE_STATE_BYTES = 1_000_000;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const heldLockPaths = new AsyncLocalStorage<ReadonlySet<string>>();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertPrivateDirectory(dataDirectory: string): void {
  mkdirSync(dataDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = lstatSync(dataDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Setup data directory must be a regular private directory');
  }
  chmodSync(dataDirectory, PRIVATE_DIRECTORY_MODE);
}

export function assertSafeExistingDirectory(directory: string): boolean {
  try {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Setup data directory must be a regular private directory');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function readPrivateJsonFile(path: string, label: string): unknown | null {
  if (!assertSafeExistingDirectory(dirname(path))) return null;
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file and not a symlink`);
  }
  if (metadata.size > MAXIMUM_PRIVATE_STATE_BYTES)
    throw new Error(`${label} exceeds the size limit`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`${label} changed while it was being opened`);
    }
    const contents = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(contents) > MAXIMUM_PRIVATE_STATE_BYTES) {
      throw new Error(`${label} exceeds the size limit`);
    }
    return JSON.parse(contents) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

export function removePrivateFile(path: string, label: string): void {
  if (!assertSafeExistingDirectory(dirname(path))) return;
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file and not a symlink`);
  }
  unlinkSync(path);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function recoverStaleLock(path: string): boolean {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Setup lifecycle lock must be a regular file and not a symlink');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Setup lifecycle lock must be private');
  }
  const value = readPrivateJsonFile(path, 'Setup lifecycle lock');
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.nonce !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(value.nonce)
  ) {
    throw new Error('Setup lifecycle lock has an invalid owner');
  }
  if (processIsAlive(value.pid as number)) return false;
  const current = lstatSync(path);
  if (current.dev !== metadata.dev || current.ino !== metadata.ino) return false;
  unlinkSync(path);
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface LifecycleLock {
  /** Runs `operation` while holding the lock; nested runs in the same call chain re-enter. */
  run<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Holds the lock across several calls — a prepared uninstall keeps it from `prepare` to
   * `finalize`. The returned function releases it and is safe to call more than once.
   */
  acquire(): Promise<() => void>;
}

export interface LifecycleLockOptions {
  timeoutMilliseconds?: number;
  retryMilliseconds?: number;
}

export function createSetupLifecycleLock(
  dataDirectory: string,
  options: LifecycleLockOptions = {},
): LifecycleLock {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Error('Setup data directory must be an absolute, NUL-free path');
  }
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
  const retryMilliseconds = options.retryMilliseconds ?? 25;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    !Number.isSafeInteger(retryMilliseconds) ||
    retryMilliseconds <= 0
  ) {
    throw new Error('Setup lifecycle lock timing must use positive integers');
  }
  const path = join(dataDirectory, LIFECYCLE_LOCK_FILE_NAME);

  async function acquireFile(): Promise<() => void> {
    assertPrivateDirectory(dataDirectory);
    const nonce = randomUUID();
    const startedAt = Date.now();
    while (true) {
      let descriptor: number | null = null;
      let created = false;
      try {
        descriptor = openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          PRIVATE_FILE_MODE,
        );
        created = true;
        writeFileSync(
          descriptor,
          `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce })}\n`,
        );
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        break;
      } catch (error) {
        if (descriptor !== null) closeSync(descriptor);
        if (created) {
          try {
            unlinkSync(path);
          } catch {
            // A failed lock write must not mask its original error.
          }
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (recoverStaleLock(path)) continue;
        if (Date.now() - startedAt >= timeoutMilliseconds) {
          throw new AppError(
            'conflict',
            'Timed out waiting for the setup lifecycle lock; another Pimpampum operation is still running in this data directory',
            409,
            true,
            { lockPath: path },
          );
        }
        await delay(retryMilliseconds);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const owner = readPrivateJsonFile(path, 'Setup lifecycle lock');
      if (isRecord(owner) && owner.nonce === nonce) {
        removePrivateFile(path, 'Setup lifecycle lock');
      }
    };
  }

  return {
    async acquire() {
      if (heldLockPaths.getStore()?.has(path)) return () => undefined;
      return acquireFile();
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const held = heldLockPaths.getStore();
      if (held?.has(path)) return operation();
      const release = await acquireFile();
      try {
        return await heldLockPaths.run(new Set([...(held ?? []), path]), operation);
      } finally {
        release();
      }
    },
  };
}
