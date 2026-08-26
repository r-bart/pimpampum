import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutomaticBackupController,
  type AutomaticBackupSnapshotter,
} from '../src/automaticBackup.js';
import { openDatabase } from '../src/db.js';
import { PimpampumStore } from '../src/store.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-auto-backup-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('automatic backup acceptance', () => {
  it('persists one canonical directory and writes a valid rolling snapshot', async () => {
    const root = temporaryDirectory('persistence');
    const dataDirectory = join(root, 'data');
    const backupDirectory = join(root, 'iCloud Drive', 'Pimpampum');
    mkdirSync(dataDirectory);
    mkdirSync(backupDirectory, { recursive: true });
    const databasePath = join(dataDirectory, 'pimpampum.sqlite');
    const database = openDatabase(databasePath);
    const store = new PimpampumStore(database);
    const controller = new AutomaticBackupController({
      settingsPath: join(dataDirectory, 'settings.json'),
      snapshotter: (directory) => store.backupLatest(directory),
    });

    const configured = await controller.configure(backupDirectory);
    expect(configured).toMatchObject({
      enabled: true,
      directory: backupDirectory,
      snapshotPath: join(backupDirectory, 'pimpampum-latest.sqlite'),
      state: 'healthy',
      error: null,
    });
    expect(JSON.parse(readFileSync(join(dataDirectory, 'settings.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      backupDirectory,
    });

    const restored = new AutomaticBackupController({
      settingsPath: join(dataDirectory, 'settings.json'),
      snapshotter: (directory) => store.backupLatest(directory),
    });
    expect(restored.getStatus()).toMatchObject({
      enabled: true,
      directory: backupDirectory,
    });
    await restored.retry();
    await restored.close();
    await controller.close();
    store.close();
  });

  it('backs up committed workspace, PRD, task and subtask mutations', async () => {
    const root = temporaryDirectory('real-workflow');
    const dataDirectory = join(root, 'data');
    const workspaceDirectory = join(root, 'workspace');
    const backupDirectory = join(root, 'Dropbox');
    mkdirSync(dataDirectory);
    mkdirSync(workspaceDirectory);
    mkdirSync(backupDirectory);
    const database = openDatabase(join(dataDirectory, 'pimpampum.sqlite'));
    let controller: AutomaticBackupController;
    const store = new PimpampumStore(database, () => controller.markDirty());
    controller = new AutomaticBackupController({
      settingsPath: join(dataDirectory, 'settings.json'),
      snapshotter: (directory) => store.backupLatest(directory),
    });
    await controller.configure(backupDirectory);

    store.registerWorkspace({
      id: 'vcomp',
      name: 'VCOMP',
      rootPath: workspaceDirectory,
      actor: 'acceptance',
    });
    const project = store.createProject({
      workspaceId: 'vcomp',
      slug: 'agent-workflow',
      title: 'Agent workflow',
      prd: '# Agent workflow',
      state: 'draft',
      actor: 'acceptance',
    });
    store.updatePrd({
      projectId: project.id,
      prd: '# Agent workflow\n\nUpdated.',
      expectedRevision: project.revision,
      actor: 'acceptance',
    });
    const task = store.createTask({
      projectId: project.id,
      parentId: null,
      title: 'Parent task',
      body: null,
      actor: 'acceptance',
    });
    store.createTask({
      projectId: project.id,
      parentId: task.id,
      title: 'Subtask',
      body: 'Do the small thing.',
      actor: 'acceptance',
    });

    await controller.drain();
    const snapshotPath = join(backupDirectory, 'pimpampum-latest.sqlite');
    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(snapshot.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
      count: 1,
    });
    expect(snapshot.prepare('SELECT prd FROM projects').get()).toEqual({
      prd: '# Agent workflow\n\nUpdated.',
    });
    expect(snapshot.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 2 });
    snapshot.close();

    await controller.close();
    store.close();
  });

  it('never follows a pre-existing rolling-partial symlink', async () => {
    const root = temporaryDirectory('partial-symlink');
    const dataDirectory = join(root, 'data');
    const backupDirectory = join(root, 'backup');
    mkdirSync(dataDirectory);
    mkdirSync(backupDirectory);
    const victimPath = join(root, 'victim.txt');
    writeFileSync(victimPath, 'must remain unchanged');
    symlinkSync(victimPath, join(backupDirectory, 'pimpampum-latest.sqlite.partial'));
    const database = openDatabase(join(dataDirectory, 'pimpampum.sqlite'));
    const store = new PimpampumStore(database);
    const controller = new AutomaticBackupController({
      settingsPath: join(dataDirectory, 'settings.json'),
      snapshotter: (directory) => store.backupLatest(directory),
    });

    await controller.configure(backupDirectory);

    expect(readFileSync(victimPath, 'utf8')).toBe('must remain unchanged');
    expect(readdirSync(backupDirectory).sort()).toEqual([
      'pimpampum-latest.sqlite',
      'pimpampum-latest.sqlite.partial',
    ]);
    await controller.close();
    store.close();
  });

  it('coalesces concurrent dirtiness and never runs snapshot writers in parallel', async () => {
    const root = temporaryDirectory('coalesce');
    const destination = join(root, 'backup');
    mkdirSync(destination);
    let releaseFirst: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const snapshotter: AutomaticBackupSnapshotter = vi.fn(async (directory) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (!releaseFirst) await new Promise<void>((resolve) => (releaseFirst = resolve));
      active -= 1;
      return join(directory, 'pimpampum-latest.sqlite');
    });
    const controller = new AutomaticBackupController({
      settingsPath: join(root, 'settings.json'),
      snapshotter,
    });

    const configuring = controller.configure(destination);
    await vi.waitFor(() => expect(snapshotter).toHaveBeenCalledTimes(1));
    controller.markDirty();
    controller.markDirty();
    releaseFirst?.();
    await configuring;
    await controller.drain();

    expect(maximumActive).toBe(1);
    expect(snapshotter).toHaveBeenCalledTimes(2);
    await controller.close();
  });

  it('keeps mutations valid across backup failure, exposes error, and recovers on retry', async () => {
    const root = temporaryDirectory('failure');
    const destination = join(root, 'backup');
    const workspaceDirectory = join(root, 'workspace');
    mkdirSync(destination);
    mkdirSync(workspaceDirectory);
    let failing = false;
    const snapshotter: AutomaticBackupSnapshotter = vi.fn(async (directory) => {
      if (failing) throw new Error('cloud volume unavailable');
      return join(directory, 'pimpampum-latest.sqlite');
    });
    const database = openDatabase(':memory:');
    let controller: AutomaticBackupController;
    const store = new PimpampumStore(database, () => controller.markDirty());
    controller = new AutomaticBackupController({
      settingsPath: join(root, 'settings.json'),
      snapshotter,
    });
    await controller.configure(destination);
    failing = true;

    expect(() =>
      store.registerWorkspace({
        id: 'racing',
        name: 'Rdiaz Racing',
        rootPath: workspaceDirectory,
        actor: 'agent',
      }),
    ).not.toThrow();
    await controller.drain();
    expect(store.listWorkspaces()).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({ state: 'error', enabled: true });
    expect(controller.getStatus().error).toContain('cloud volume unavailable');

    failing = false;
    await controller.retry();
    expect(controller.getStatus()).toMatchObject({ state: 'healthy', error: null });
    await controller.disable();
    expect(controller.getStatus()).toEqual({
      enabled: false,
      directory: null,
      snapshotPath: null,
      state: 'disabled',
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: null,
    });

    await controller.close();
    store.close();
  });
});
