import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { AutomaticBackupController } from './automaticBackup.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { openDatabase } from './db.js';
import { AppError } from './errors.js';
import { createHttpApp } from './http.js';
import { PimpampumStore } from './store.js';
import { SyncController } from './syncController.js';

export interface RunningServer {
  server: Server;
  config: RuntimeConfig;
  close(): Promise<void>;
}

/** The filesystem and process calls the instance lock needs; injectable so races are testable. */
export interface InstanceLockIo {
  writeFileSync(
    path: string,
    data: string,
    options: { encoding: 'utf8'; mode: number; flag: 'wx' },
  ): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
  processIsAlive(pid: number): boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const defaultLockIo: InstanceLockIo = {
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  processIsAlive,
};

const INSTANCE_LOCK_ATTEMPTS = 5;

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function conflict(): AppError {
  return new AppError('conflict', 'Another Pimpampum daemon owns this data directory', 409);
}

/** Returns the recorded PID, NaN for an unparsable file, or null when the file vanished. */
function readLockOwner(path: string, io: InstanceLockIo): number | null {
  try {
    const text = io.readFileSync(path, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : Number.NaN;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function isStale(pid: number, io: InstanceLockIo): boolean {
  return Number.isInteger(pid) && pid >= 1 && !io.processIsAlive(pid);
}

/**
 * Takes the exclusive instance lock. A stale lock is never deleted in place:
 * it is renamed aside, which only one contender can do, so two daemons that
 * both read the same dead PID cannot remove each other's fresh lock. The moved
 * file is re-verified in case a live owner re-created the lock in between.
 */
export function acquireInstanceLock(
  dataDirectory: string,
  io: InstanceLockIo = defaultLockIo,
): () => void {
  const lockPath = join(dataDirectory, '.instance.lock');
  for (let attempt = 0; attempt < INSTANCE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      io.writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return () => io.rmSync(lockPath, { force: true });
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
    }
    const owner = readLockOwner(lockPath, io);
    if (owner === null) continue;
    if (!isStale(owner, io)) throw conflict();
    const stalePath = join(dataDirectory, `.instance.lock.stale-${process.pid}-${attempt}`);
    try {
      io.renameSync(lockPath, stalePath);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
      continue;
    }
    const moved = readLockOwner(stalePath, io);
    if (moved !== null && moved !== owner && !isStale(moved, io)) {
      // A live daemon replaced the stale lock before the rename; give it back
      // unless a third contender has already created a fresh lock.
      try {
        io.writeFileSync(lockPath, `${moved}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') throw error;
      }
      io.rmSync(stalePath, { force: true });
      throw conflict();
    }
    io.rmSync(stalePath, { force: true });
  }
  throw conflict();
}

export async function startServer(config = loadConfig()): Promise<RunningServer> {
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!loopbackHosts.has(config.host)) {
    throw new AppError('bad_request', 'Pimpampum HTTP must bind to a loopback host', 400);
  }
  if (
    config.databasePath !== ':memory:' &&
    resolve(config.databasePath) !== resolve(config.dataDirectory, 'pimpampum.sqlite')
  ) {
    throw new AppError(
      'bad_request',
      'The live database must be pimpampum.sqlite inside the configured data directory',
      400,
    );
  }
  if (config.databasePath !== ':memory:' && existsSync(config.databasePath)) {
    const databaseStat = lstatSync(config.databasePath);
    if (databaseStat.isSymbolicLink() || databaseStat.nlink > 1) {
      throw new AppError('bad_request', 'The live database cannot be a symbolic or hard link', 400);
    }
  }
  const releaseInstanceLock = acquireInstanceLock(config.dataDirectory);
  let store: PimpampumStore | undefined;
  let automaticBackup: AutomaticBackupController | undefined;
  let syncController: SyncController | undefined;
  let composition: ReturnType<typeof createHttpApp>;
  try {
    const database = openDatabase(config.databasePath);
    const composedStore = new PimpampumStore(database, () => {
      automaticBackup?.markDirty();
      syncController?.markDirty();
    });
    store = composedStore;
    automaticBackup = new AutomaticBackupController({
      settingsPath: join(config.dataDirectory, 'settings.json'),
      snapshotter: (destination) => composedStore.backupLatest(destination),
    });
    const composedSyncController = new SyncController({
      settingsPath: join(config.dataDirectory, 'sync.json'),
      snapshotter: () => composedStore.exportSyncState(),
      importer: (state) => composedStore.applySyncState(state),
      mutationCounter: () => composedStore.mutationCount,
    });
    syncController = composedSyncController;
    composedStore.setSyncConflictGuard((entityType, entityId) =>
      composedSyncController.hasConflict(entityType, entityId),
    );
    composition = createHttpApp(store, config, console, Date.now, automaticBackup, syncController);
    automaticBackup.start();
    await syncController.start();
  } catch (error) {
    await syncController?.close();
    await automaticBackup?.close();
    store?.close();
    releaseInstanceLock();
    throw error;
  }
  const { app, close: closeMcp } = composition;

  let server: Server;
  try {
    server = await new Promise<Server>((resolveServer, reject) => {
      const instance = app.listen(config.port, config.host, () => resolveServer(instance));
      instance.once('error', reject);
    });
  } catch (error) {
    try {
      await closeMcp();
    } finally {
      await syncController.close();
      await automaticBackup.close();
      store.close();
      releaseInstanceLock();
    }
    throw error;
  }

  let closed = false;

  return {
    server,
    config,
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([
        closeMcp(),
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
      ]);
      try {
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            'Pimpampum shutdown failed',
          );
        }
      } finally {
        await syncController.close();
        await automaticBackup.close();
        store.close();
        releaseInstanceLock();
      }
    },
  };
}
