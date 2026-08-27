import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { PimpampumStore } from '../src/store.js';
import { SyncController } from '../src/syncController.js';

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
    expect(a.store.getWorkspace('product').rootPath).toBe(workspaceA);
    expect(b.store.getWorkspace('product').rootPath).toBe(workspaceB);

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
});
