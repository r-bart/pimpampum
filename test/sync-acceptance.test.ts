import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPortable } from '../src/backup.js';
import { openDatabase } from '../src/db.js';
import { PimpampumStore } from '../src/store.js';
import type { SyncSnapshot } from '../src/syncContract.js';
import { SyncController } from '../src/syncController.js';
import { syncHash } from '../src/syncState.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(root: string, deviceId: string) {
  const data = join(root, deviceId);
  mkdirSync(data);
  const database = openDatabase(join(data, 'pimpampum.sqlite'));
  let controller: SyncController;
  const store = new PimpampumStore(
    database,
    () => controller.markDirty(),
    (entityType, entityId) => controller?.hasConflict(entityType, entityId) ?? false,
  );
  controller = new SyncController({
    settingsPath: join(data, 'sync.json'),
    snapshotter: () => store.exportSyncState(),
    importer: (state) => store.applySyncState(state),
    mutationCounter: () => store.mutationCount,
    pollMilliseconds: 60_000,
  });
  return {
    store,
    controller,
    close: async () => {
      await controller.close();
      store.close();
    },
  };
}

function projectSlugs(store: PimpampumStore, workspaceId: string): string[] {
  return store
    .listProjectManifests({ workspaceId, state: null, limit: 50, offset: 0 })
    .map((project) => project.slug)
    .sort();
}

function withDanishLocaleCompare<T>(run: () => T): T {
  const collator = new Intl.Collator('da');
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function danish(this: string, other: string): number {
    return collator.compare(String(this), String(other));
  } as typeof String.prototype.localeCompare;
  try {
    return run();
  } finally {
    String.prototype.localeCompare = original;
  }
}

describe('shared-folder synchronization acceptance', () => {
  it('preserves unexpected database errors while registering imported roots', () => {
    const database = openDatabase(':memory:');
    const store = new PimpampumStore(database, () => {
      throw new Error('mutation callback failed');
    });
    expect(() =>
      store.registerWorkspace({ id: 'callback', name: 'Callback', rootPath: '/tmp', actor: null }),
    ).toThrow(/mutation callback failed/);
    store.close();
  });

  it('converges two local databases and preserves machine-local Workspace roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-sync-e2e-'));
    roots.push(root);
    const shared = join(root, 'Drive');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    mkdirSync(shared);
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const a = fixture(root, 'macbook');
    const b = fixture(root, 'linux');
    const c = fixture(root, 'third');
    await a.controller.configure(shared, 'macbook');
    a.store.registerWorkspace({
      id: 'product',
      name: 'Product',
      rootPath: workspaceA,
      actor: 'test',
    });
    const seededProject = a.store.createProject({
      workspaceId: 'product',
      slug: 'seeded',
      title: 'Seeded',
      actor: 'test',
    });
    const seededSpec = a.store.createSpec({
      projectId: seededProject.id,
      slug: 'sync',
      title: 'Sync',
      body: '# Sync',
      actor: 'test',
    });
    const parentTask = a.store.createTask({
      specId: seededSpec.id,
      parentId: null,
      title: 'Parent',
      body: null,
      actor: 'test',
    });
    a.store.createTask({
      specId: seededSpec.id,
      parentId: parentTask.id,
      title: 'Child',
      body: 'Nested',
      actor: 'test',
    });
    a.store.putContext({
      ownerType: 'workspace',
      ownerId: 'product',
      name: 'agents',
      body: 'Workspace',
      expectedRevision: null,
      actor: 'test',
    });
    a.store.putContext({
      ownerType: 'project',
      ownerId: seededProject.id,
      name: 'agents',
      body: 'Project',
      expectedRevision: null,
      actor: 'test',
    });
    await a.controller.drain();
    await b.controller.configure(shared, 'linux');
    expect(b.store.listWorkspaces()).toMatchObject([{ id: 'product', rootPath: '' }]);
    b.store.registerWorkspace({
      id: 'product',
      name: 'Product',
      rootPath: workspaceB,
      actor: 'test',
    });
    await b.controller.drain();
    await a.controller.reconcile();
    expect(a.store.getWorkspace('product').rootPath).toBe(realpathSync(workspaceA));
    expect(b.store.getWorkspace('product').rootPath).toBe(realpathSync(workspaceB));

    a.store.createProject({
      workspaceId: 'product',
      slug: 'from-mac',
      title: 'From Mac',
      actor: 'test',
    });
    b.store.createProject({
      workspaceId: 'product',
      slug: 'from-linux',
      title: 'From Linux',
      actor: 'test',
    });
    await Promise.all([a.controller.drain(), b.controller.drain()]);
    await a.controller.reconcile();
    await b.controller.reconcile();
    expect(
      a.store
        .listProjectManifests({ workspaceId: 'product', state: null, limit: 10, offset: 0 })
        .map((p) => p.slug)
        .sort(),
    ).toEqual(['from-linux', 'from-mac', 'seeded']);
    expect(
      b.store
        .listProjectManifests({ workspaceId: 'product', state: null, limit: 10, offset: 0 })
        .map((p) => p.slug)
        .sort(),
    ).toEqual(['from-linux', 'from-mac', 'seeded']);
    expect(b.store.listTasks(seededSpec.id)).toHaveLength(2);
    expect(b.store.readContext('workspace', 'product', 'agents').body).toBe('Workspace');
    expect(b.store.readContext('project', seededProject.id, 'agents').body).toBe('Project');
    expect(a.controller.getStatus()).toMatchObject({
      enabled: true,
      state: 'healthy',
      conflictCount: 0,
    });
    await c.controller.configure(shared, 'third');
    expect(
      c.store
        .listProjectManifests({ workspaceId: 'product', state: null, limit: 10, offset: 0 })
        .map((project) => project.slug)
        .sort(),
    ).toEqual(['from-linux', 'from-mac', 'seeded']);
    await a.close();
    await b.close();
    await c.close();
  });

  it('preserves both candidates as a conflict while unrelated writes remain available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-sync-conflict-'));
    roots.push(root);
    const shared = join(root, 'Drive');
    const workspace = join(root, 'workspace');
    mkdirSync(shared);
    mkdirSync(workspace);
    const a = fixture(root, 'macbook');
    const b = fixture(root, 'linux');
    const c = fixture(root, 'third');
    await a.controller.configure(shared, 'macbook');
    a.store.registerWorkspace({ id: 'product', name: 'Product', rootPath: workspace, actor: null });
    const project = a.store.createProject({
      workspaceId: 'product',
      slug: 'shared',
      title: 'Shared',
      actor: null,
    });
    await a.controller.drain();
    await b.controller.configure(shared, 'linux');
    b.store.registerWorkspace({ id: 'product', name: 'Product', rootPath: workspace, actor: null });
    const remoteProject = b.store.getProject(project.id);
    await c.controller.configure(shared, 'third');
    await c.controller.pause();
    const thirdProject = c.store.getProject(project.id);
    c.store.updateProject({
      projectId: project.id,
      title: 'Third title',
      state: null,
      expectedRevision: thirdProject.revision,
      actor: null,
    });
    a.store.updateProject({
      projectId: project.id,
      title: 'Mac title',
      state: null,
      expectedRevision: project.revision,
      actor: null,
    });
    b.store.updateProject({
      projectId: project.id,
      title: 'Linux title',
      state: null,
      expectedRevision: remoteProject.revision,
      actor: null,
    });
    await Promise.all([a.controller.drain(), b.controller.drain()]);
    await a.controller.reconcile();
    expect(a.controller.listConflicts()).toMatchObject([
      { entityType: 'project', entityId: project.id },
    ]);
    expect(a.controller.getStatus().state).toBe('conflict');
    const conflicted = a.store.getProject(project.id);
    expect(() =>
      a.store.updateProject({
        projectId: project.id,
        title: 'Blocked',
        state: null,
        expectedRevision: conflicted.revision,
        actor: null,
      }),
    ).toThrow(/Synchronization conflict blocks changes/);
    expect(() =>
      a.store.createProject({
        workspaceId: 'product',
        slug: 'unrelated',
        title: 'Unrelated',
        actor: null,
      }),
    ).not.toThrow();
    b.store.createProject({ workspaceId: 'product', slug: 'later', title: 'Later', actor: null });
    await b.controller.drain();
    await a.controller.reconcile();
    expect(a.store.getProject(project.id).title).toBe('Mac title');
    const conflict = a.controller.listConflicts()[0];
    expect(conflict).toBeDefined();
    await a.controller.resolveConflict(conflict!.id, 'remote');
    expect(a.store.getProject(project.id).title).toBe('Linux title');
    expect(a.controller.getStatus().conflictCount).toBe(0);
    await b.controller.reconcile();
    expect(b.store.getProject(project.id).title).toBe('Linux title');
    expect(b.controller.getStatus().conflictCount).toBe(0);
    await c.controller.resume();
    expect(c.store.getProject(project.id).title).toBe('Linux title');
    expect(c.controller.getStatus().conflictCount).toBe(0);
    await a.close();
    await b.close();
    await c.close();
  });

  it('never resolves a path to a Workspace imported without a local root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-sync-phantom-'));
    roots.push(root);
    const shared = join(root, 'Drive');
    const workspace = join(root, 'workspace');
    mkdirSync(shared);
    mkdirSync(workspace);
    const a = fixture(root, 'macbook');
    const b = fixture(root, 'linux');
    await a.controller.configure(shared, 'macbook');
    a.store.registerWorkspace({ id: 'product', name: 'Product', rootPath: workspace, actor: null });
    a.store.createProject({ workspaceId: 'product', slug: 'seed', title: 'Seed', actor: null });
    await a.controller.drain();
    await b.controller.configure(shared, 'linux');
    expect(b.store.listWorkspaces()).toMatchObject([{ id: 'product', rootPath: '' }]);
    // Before the fix relative('', path) meant relative(cwd, path), so every path
    // under the daemon's working directory matched the imported Workspace.
    for (const candidate of [process.cwd(), realpathSync(workspace), root]) {
      expect(() => b.store.resolveWorkspace(candidate)).toThrow(
        expect.objectContaining({ code: 'not_found' }),
      );
    }
    expect(
      b.store.createProject({ workspaceId: 'product', slug: 'by-id', title: 'By id', actor: null })
        .workspaceId,
    ).toBe('product');
    await a.close();
    await b.close();
  });

  it('reports two computers sharing one device ID and converges after forget and reconfigure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-sync-twin-'));
    roots.push(root);
    const shared = join(root, 'Drive');
    const workspace = join(root, 'workspace');
    mkdirSync(shared);
    mkdirSync(workspace);
    const first = fixture(root, 'first');
    const second = fixture(root, 'second');
    await first.controller.configure(shared, 'shared');
    first.store.registerWorkspace({
      id: 'product',
      name: 'Product',
      rootPath: workspace,
      actor: null,
    });
    first.store.createProject({ workspaceId: 'product', slug: 'one', title: 'One', actor: null });
    await first.controller.drain();

    await second.controller.configure(shared, 'shared');
    expect(projectSlugs(second.store, 'product')).toEqual(['one']);
    second.store.createProject({ workspaceId: 'product', slug: 'two', title: 'Two', actor: null });
    await second.controller.drain();
    expect(second.controller.getStatus().state).toBe('healthy');

    // The first computer finds a file in its own directory that it never wrote.
    const detected = await first.controller.reconcile();
    expect(detected.state).toBe('error');
    expect(detected.error).toMatch(/Another computer publishes snapshots as device "shared"/);
    first.store.createProject({
      workspaceId: 'product',
      slug: 'three',
      title: 'Three',
      actor: null,
    });
    await first.controller.drain();
    expect(first.controller.getStatus().state).toBe('error');
    expect(projectSlugs(first.store, 'product')).toEqual(['one', 'three']);

    // Recovery: forget on both, keep the ID on one, give the other a new one.
    await first.controller.forget();
    expect(await first.controller.configure(shared, 'shared')).toMatchObject({
      state: 'healthy',
      error: null,
    });
    expect(projectSlugs(first.store, 'product')).toEqual(['one', 'three', 'two']);
    const twinDetected = await second.controller.reconcile();
    expect(twinDetected.state).toBe('error');
    await second.controller.forget();
    expect(await second.controller.configure(shared, 'linux-two')).toMatchObject({
      state: 'healthy',
      conflictCount: 0,
    });
    await first.controller.reconcile();
    expect(projectSlugs(second.store, 'product')).toEqual(['one', 'three', 'two']);
    expect(projectSlugs(first.store, 'product')).toEqual(['one', 'three', 'two']);
    expect(first.controller.getStatus()).toMatchObject({ state: 'healthy', conflictCount: 0 });

    const third = fixture(root, 'third');
    await third.controller.configure(shared, 'third');
    expect(projectSlugs(third.store, 'product')).toEqual(['one', 'three', 'two']);
    expect(third.controller.getStatus()).toMatchObject({ state: 'healthy', conflictCount: 0 });
    await first.close();
    await second.close();
    await third.close();
  });

  it('converges when one device publishes under a Danish collation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-sync-locale-'));
    roots.push(root);
    const shared = join(root, 'Drive');
    mkdirSync(shared);
    // Danish orders `aa` after `z`; code units order it first.
    const workspaceIds = ['aa', 'ab', 'z'];
    for (const id of workspaceIds) mkdirSync(join(root, id));
    const danish = fixture(root, 'danish');
    const english = fixture(root, 'english');
    const published = withDanishLocaleCompare(() => {
      expect('aa'.localeCompare('z')).toBeGreaterThan(0);
      return (async () => {
        await danish.controller.configure(shared, 'danish');
        for (const id of workspaceIds) {
          danish.store.registerWorkspace({
            id,
            name: id.toUpperCase(),
            rootPath: join(root, id),
            actor: null,
          });
          danish.store.createProject({ workspaceId: id, slug: `${id}-p`, title: id, actor: null });
        }
        await danish.controller.drain();
      })();
    });
    await published;
    const deviceDirectory = join(shared, 'Pimpampum/devices/danish');
    const snapshots = readdirSync(deviceDirectory)
      .sort()
      .map((name) => JSON.parse(readFileSync(join(deviceDirectory, name), 'utf8')) as SyncSnapshot);
    const latest = snapshots.at(-1)!;
    expect(latest.state.workspaces.map((workspace) => workspace.id)).toEqual(workspaceIds);
    expect(latest.stateHash).toBe(syncHash(danish.store.exportSyncState()));

    await english.controller.configure(shared, 'english');
    expect(english.controller.getStatus()).toMatchObject({
      state: 'healthy',
      blockedSnapshot: null,
      conflictCount: 0,
    });
    expect(
      english.store
        .listWorkspaces()
        .map((workspace) => workspace.id)
        .sort(),
    ).toEqual(workspaceIds);
    for (const id of workspaceIds) {
      expect(projectSlugs(english.store, id)).toEqual([`${id}-p`]);
    }
    await danish.close();
    await english.close();
  });

  it('keeps a hostile synced Context name inside the export directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-sync-hostile-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const database = openDatabase(':memory:');
    const store = new PimpampumStore(database);
    store.registerWorkspace({ id: 'product', name: 'Product', rootPath: workspace, actor: null });
    const hostile = store.exportSyncState();
    hostile.contexts.push({
      id: '00000000-0000-4000-8000-000000000001',
      ownerType: 'workspace',
      ownerId: 'product',
      name: '../../escape',
      body: 'outside',
      revision: 1,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    });
    expect(() => store.applySyncState(hostile)).toThrow(/name that is not a slug/);

    // Even a source that bypasses every schema cannot make the export escape.
    const exports = join(root, 'exports');
    const document = {
      id: '00000000-0000-4000-8000-000000000001',
      ownerType: 'workspace' as const,
      ownerId: 'product',
      name: '../../escape',
      body: 'outside',
      revision: 1,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const source = {
      listWorkspaces: () => store.listWorkspaces(),
      listProjectManifests: store.listProjectManifests.bind(store),
      getProject: store.getProject.bind(store),
      listSpecManifests: store.listSpecManifests.bind(store),
      getSpec: store.getSpec.bind(store),
      listTaskManifests: store.listTaskManifests.bind(store),
      getTask: store.getTask.bind(store),
      listContextManifests: () =>
        [{ ...document, body: undefined, sizeBytes: 7 }].map(
          ({ body: _body, ...manifest }) => manifest,
        ),
      readContext: () => document,
    };
    expect(() => exportPortable(source, exports)).toThrow(
      expect.objectContaining({
        code: 'bad_request',
        message: expect.stringMatching(/safe export file name/),
      }),
    );
    expect(existsSync(join(root, 'escape.md'))).toBe(false);
    expect(existsSync(join(exports, 'escape.md'))).toBe(false);
    expect(readdirSync(exports)).toEqual([]);
    store.close();
  });
});
