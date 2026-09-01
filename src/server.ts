import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function acquireInstanceLock(dataDirectory: string): () => void {
  const lockPath = join(dataDirectory, '.instance.lock');
  while (true) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      if (!Number.isInteger(pid) || pid < 1 || processIsAlive(pid)) {
        throw new AppError('conflict', 'Another Pimpampum daemon owns this data directory', 409);
      }
      rmSync(lockPath, { force: true });
    }
  }
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
