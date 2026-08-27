import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { AppError, type ErrorCode } from '../src/errors.js';
import { PimpampumStore } from '../src/store.js';
import type { Project, Spec, Task } from '../src/types.js';

describe('PimpampumStore v2', () => {
  let database: Database.Database;
  let store: PimpampumStore;
  let root: string;
  let mutations: number;
  let sequence: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pimpampum-store-v2-'));
    database = openDatabase(':memory:');
    mutations = 0;
    sequence = 0;
    store = new PimpampumStore(database, () => mutations++);
    store.registerWorkspace({ id: 'workspace', name: 'Workspace', rootPath: root, actor: 'test' });
    mutations = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function error(operation: () => unknown, code: ErrorCode, message?: RegExp): AppError {
    try {
      operation();
    } catch (caught) {
      expect(caught).toBeInstanceOf(AppError);
      const appError = caught as AppError;
      expect(appError.code).toBe(code);
      if (message) expect(appError.message).toMatch(message);
      return appError;
    }
    throw new Error(`Expected ${code}`);
  }

  it('rejects structurally valid sync state whose domain relationships are invalid', () => {
    const state = store.exportSyncState();
    state.contexts.push({
      id: 'orphan-context',
      ownerType: 'project',
      ownerId: 'missing-project',
      name: 'brief',
      body: '',
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    error(() => store.applySyncState(state), 'bad_request', /has no owner/);
    expect(store.exportSyncState().contexts).toEqual([]);

    const duplicate = store.exportSyncState();
    duplicate.workspaces.push({ ...duplicate.workspaces[0]! });
    error(() => store.applySyncState(duplicate), 'bad_request', /duplicate Workspace ID/);

    const createdProject = project();
    const createdSpec = spec(createdProject.id);
    const invalidProject = store.exportSyncState();
    invalidProject.projects[0]!.workspaceId = 'missing-workspace';
    error(() => store.applySyncState(invalidProject), 'bad_request', /has no Workspace/);
    const invalidSpec = store.exportSyncState();
    invalidSpec.specs[0]!.projectId = 'missing-project';
    error(() => store.applySyncState(invalidSpec), 'bad_request', /has no Project/);

    const ready = store.updateSpec({
      specId: createdSpec.id,
      title: null,
      body: null,
      state: 'ready',
      expectedRevision: createdSpec.revision,
      actor: 'test',
    });
    const createdTask = task(ready.id);
    const invalidTaskSpec = store.exportSyncState();
    invalidTaskSpec.tasks[0]!.specId = 'missing-spec';
    error(() => store.applySyncState(invalidTaskSpec), 'bad_request', /has no Spec/);
    const missingParent = store.exportSyncState();
    missingParent.tasks[0]!.parentId = 'missing-task';
    error(() => store.applySyncState(missingParent), 'bad_request', /has no parent/);
    const invalidParent = store.exportSyncState();
    invalidParent.tasks[0]!.parentId = createdTask.id;
    error(() => store.applySyncState(invalidParent), 'bad_request', /invalid parent/);
  });

  it('rejects sync states that bypass lifecycle and completion invariants', () => {
    const { project: createdProject, spec: createdSpec } = readyProject();
    const parent = task(createdSpec.id);
    const child = task(createdSpec.id, parent.id);
    const baseline = store.exportSyncState();
    const invalid = (mutate: (state: typeof baseline) => void, message: RegExp): void => {
      const state = structuredClone(baseline);
      mutate(state);
      error(() => store.applySyncState(state), 'bad_request', message);
      expect(store.exportSyncState()).toEqual(baseline);
    };

    invalid((state) => {
      state.projects[0]!.state = 'open';
      state.specs = [];
      state.tasks = [];
    }, /open without a Spec/);
    invalid((state) => {
      state.projects[0]!.state = 'done';
      state.projects[0]!.completionSummary = 'Done';
      state.projects[0]!.completedAt = new Date().toISOString();
    }, /done before every Spec is terminal/);
    invalid((state) => {
      state.projects[0]!.state = 'cancelled';
    }, /cancelled with a non-terminal Spec/);
    invalid((state) => {
      state.specs[0]!.body = '   ';
    }, /ready without Markdown/);
    invalid((state) => {
      state.specs[0]!.state = 'done';
      state.specs[0]!.completionSummary = 'Done';
      state.specs[0]!.completedAt = new Date().toISOString();
    }, /terminal with a non-terminal Task/);
    invalid((state) => {
      const importedParent = state.tasks.find((item) => item.id === parent.id)!;
      importedParent.state = 'done';
      importedParent.completionSummary = 'Done';
      importedParent.completedAt = new Date().toISOString();
    }, /terminal with a non-terminal Subtask/);
    invalid((state) => {
      state.projects[0]!.completionSummary = 'Impossible';
    }, /completion metadata while open/);
    invalid((state) => {
      state.tasks.find((item) => item.id === child.id)!.state = 'done';
    }, /done without completion metadata/);
    invalid((state) => {
      const importedChild = state.tasks.find((item) => item.id === child.id)!;
      importedChild.state = 'done';
      importedChild.completionSummary = 'Done';
    }, /done without completion metadata/);

    const valid = structuredClone(baseline);
    const importedChild = valid.tasks.find((item) => item.id === child.id)!;
    importedChild.state = 'done';
    importedChild.completionSummary = 'Done';
    importedChild.completedAt = new Date().toISOString();
    store.applySyncState(valid);
    expect(store.getTask(child.id).state).toBe('done');

    expect(createdProject.state).toBe('open');
  });

  it('applies synchronized deletions in dependency order', () => {
    const createdProject = project();
    spec(createdProject.id);
    const state = store.exportSyncState();
    state.projects = [];
    state.specs = [];
    store.applySyncState(state);
    expect(
      store.listProjects({ workspaceId: 'workspace', state: null, limit: 50, offset: 0 }),
    ).toEqual([]);
    error(() => store.getProject(createdProject.id), 'not_found');
    expect(
      (database.prepare('SELECT COUNT(*) count FROM specs').get() as { count: number }).count,
    ).toBe(0);
  });

  function project(): Project {
    sequence++;
    return store.createProject({
      workspaceId: 'workspace',
      slug: `project-${sequence}`,
      title: `Project ${sequence}`,
      actor: 'test',
    });
  }

  function spec(projectId: string, body = '# Executable spec'): Spec {
    sequence++;
    return store.createSpec({
      projectId,
      slug: `spec-${sequence}`,
      title: `Spec ${sequence}`,
      body,
      actor: 'test',
    });
  }

  function readyProject(): { project: Project; spec: Spec } {
    let p = project();
    let s = spec(p.id);
    s = store.updateSpec({
      specId: s.id,
      title: null,
      body: null,
      state: 'ready',
      expectedRevision: s.revision,
      actor: 'test',
    });
    p = store.updateProject({
      projectId: p.id,
      title: null,
      state: 'open',
      expectedRevision: p.revision,
      actor: 'test',
    });
    return { project: p, spec: s };
  }

  function task(specId: string, parentId: string | null = null): Task {
    return store.createTask({ specId, parentId, title: 'Task', body: 'Body', actor: 'test' });
  }

  it('resolves nested Workspaces and validates roots and uniqueness', () => {
    const nested = join(root, 'nested');
    mkdirSync(join(nested, 'src'), { recursive: true });
    store.registerWorkspace({ id: 'nested', name: 'Nested', rootPath: nested, actor: null });
    expect(store.resolveWorkspace(join(nested, 'src')).id).toBe('nested');
    expect(store.listWorkspaces().map((item) => item.id)).toEqual(['nested', 'workspace']);
    error(
      () => store.registerWorkspace({ id: 'relative', name: 'Bad', rootPath: '.', actor: null }),
      'bad_request',
      /absolute/,
    );
    const file = join(root, 'file');
    writeFileSync(file, 'x');
    error(
      () => store.registerWorkspace({ id: 'file', name: 'Bad', rootPath: file, actor: null }),
      'bad_request',
      /directory/,
    );
    error(
      () =>
        store.registerWorkspace({
          id: 'missing',
          name: 'Bad',
          rootPath: join(root, 'missing'),
          actor: null,
        }),
      'bad_request',
    );
    error(
      () =>
        store.registerWorkspace({
          id: 'workspace',
          name: 'Duplicate',
          rootPath: nested,
          actor: null,
        }),
      'conflict',
    );
    error(() => store.resolveWorkspace(join(root, 'missing')), 'not_found');
    error(() => store.resolveWorkspace('relative'), 'bad_request');
  });

  it('models lightweight Projects and many bounded Specs', () => {
    const p = project();
    const first = spec(p.id);
    const second = spec(p.id, '');
    expect(store.getProject(p.id)).not.toHaveProperty('prd');
    expect(
      store
        .listSpecManifests({ projectId: p.id, state: null, limit: 10, offset: 0 })
        .map((s) => s.id),
    ).toEqual([second.id, first.id]);
    expect(store.getProjectManifest(p.id)).toMatchObject({ specCount: 2, draftSpecCount: 2 });
    expect(store.readSpecBody(first.id, 0, 4)).toMatchObject({ body: '# Ex', hasMore: true });
    error(
      () =>
        store.createProject({
          workspaceId: 'workspace',
          slug: p.slug,
          title: 'Duplicate',
          actor: null,
        }),
      'conflict',
    );
    error(
      () =>
        store.createSpec({
          projectId: p.id,
          slug: first.slug,
          title: 'Duplicate',
          body: '# x',
          actor: null,
        }),
      'conflict',
    );
  });

  it('enforces Project and Spec lifecycle invariants and optimistic revisions', () => {
    let p = project();
    error(
      () =>
        store.updateProject({
          projectId: p.id,
          title: null,
          state: 'open',
          expectedRevision: p.revision,
          actor: null,
        }),
      'invalid_state',
      /at least one Spec/,
    );
    let empty = spec(p.id, '  ');
    error(
      () =>
        store.updateSpec({
          specId: empty.id,
          title: null,
          body: null,
          state: 'ready',
          expectedRevision: empty.revision,
          actor: null,
        }),
      'invalid_state',
      /non-empty/,
    );
    empty = store.updateSpec({
      specId: empty.id,
      title: 'Ready',
      body: '# Ready',
      state: 'ready',
      expectedRevision: empty.revision,
      actor: null,
    });
    p = store.updateProject({
      projectId: p.id,
      title: 'Open',
      state: 'open',
      expectedRevision: p.revision,
      actor: null,
    });
    error(
      () =>
        store.updateProject({
          projectId: p.id,
          title: null,
          state: 'paused',
          expectedRevision: 1,
          actor: null,
        }),
      'revision_conflict',
    );
    p = store.updateProject({
      projectId: p.id,
      title: null,
      state: 'paused',
      expectedRevision: p.revision,
      actor: null,
    });
    expect(store.listWork({ workspaceId: null, projectId: p.id, specId: null, limit: 10 })).toEqual(
      [],
    );
    p = store.updateProject({
      projectId: p.id,
      title: null,
      state: 'open',
      expectedRevision: p.revision,
      actor: null,
    });
    expect(
      store.listWork({ workspaceId: null, projectId: p.id, specId: empty.id, limit: 10 }),
    ).toHaveLength(1);
  });

  it('keeps Workspace and Project Context separate and terminal Project Context immutable', () => {
    const p = project();
    const workspaceContext = store.putContext({
      ownerType: 'workspace',
      ownerId: 'workspace',
      name: 'architecture',
      body: 'workspace',
      expectedRevision: null,
      actor: 'test',
    });
    const projectContext = store.putContext({
      ownerType: 'project',
      ownerId: p.id,
      name: 'architecture',
      body: 'project',
      expectedRevision: null,
      actor: 'test',
    });
    expect(store.readContext('workspace', 'workspace', 'architecture').body).toBe('workspace');
    expect(store.readContext('project', p.id, 'architecture').body).toBe('project');
    expect(store.getContextManifest('project', p.id, 'architecture')).toMatchObject({
      name: 'architecture',
      sizeBytes: 7,
    });
    expect(store.readContextPage('project', p.id, 'architecture', 0, 3).body).toBe('pro');
    error(
      () =>
        store.putContext({
          ownerType: 'project',
          ownerId: p.id,
          name: 'architecture',
          body: 'duplicate',
          expectedRevision: null,
          actor: null,
        }),
      'conflict',
    );
    const updated = store.putContext({
      ownerType: 'project',
      ownerId: p.id,
      name: 'architecture',
      body: 'updated',
      expectedRevision: projectContext.revision,
      actor: null,
    });
    expect(updated.revision).toBe(2);
    error(
      () =>
        store.putContext({
          ownerType: 'workspace',
          ownerId: 'workspace',
          name: 'missing',
          body: 'x',
          expectedRevision: workspaceContext.revision,
          actor: null,
        }),
      'not_found',
    );
    const cancelled = store.cancelProject({
      projectId: p.id,
      expectedRevision: p.revision,
      reason: 'stop',
      actor: null,
    });
    error(
      () =>
        store.putContext({
          ownerType: 'project',
          ownerId: cancelled.id,
          name: 'new',
          body: 'x',
          expectedRevision: null,
          actor: null,
        }),
      'invalid_state',
    );
    expect(
      store.putContext({
        ownerType: 'workspace',
        ownerId: 'workspace',
        name: 'new',
        body: 'x',
        expectedRevision: null,
        actor: null,
      }),
    ).toBeTruthy();
  });

  it('enforces one Task nesting level and same-Spec ownership', () => {
    const { project: p, spec: s } = readyProject();
    const parent = task(s.id);
    const child = task(s.id, parent.id);
    error(() => task(s.id, child.id), 'bad_request', /cannot have children/);
    const other = spec(p.id);
    error(() => task(other.id, parent.id), 'bad_request', /another Spec/);
    expect(store.listTaskManifests({ specId: s.id, limit: 10, offset: 0 })).toHaveLength(2);
    expect(store.getTaskManifest(parent.id)).toMatchObject({
      subtaskCount: 1,
      openSubtaskCount: 1,
    });
    expect(store.readTaskBody(parent.id, 0, 2).body).toBe('Bo');
  });

  it('discovers and exclusively Claims only ready Specs or leaf Tasks', () => {
    const { project: p, spec: s } = readyProject();
    expect(
      store.listWork({ workspaceId: 'workspace', projectId: p.id, specId: s.id, limit: 10 }),
    ).toMatchObject([{ targetType: 'spec', targetId: s.id }]);
    const parent = task(s.id);
    const child = task(s.id, parent.id);
    error(
      () =>
        store.startWork({
          targetType: 'task',
          targetId: parent.id,
          agentId: 'a',
          leaseSeconds: 60,
        }),
      'invalid_state',
    );
    const bundle = store.startWork({
      targetType: 'task',
      targetId: child.id,
      agentId: 'a',
      leaseSeconds: 60,
    });
    expect(bundle).toMatchObject({
      project: { id: p.id },
      spec: { id: s.id },
      task: { id: child.id },
    });
    const mutationsAfterClaim = mutations;
    expect(
      store.startWork({ targetType: 'task', targetId: child.id, agentId: 'a', leaseSeconds: 60 })
        .claim.agentId,
    ).toBe('a');
    expect(mutations).toBe(mutationsAfterClaim);
    expect(store.listActivity(p.id, 20)).toContainEqual(
      expect.objectContaining({ eventType: 'work.started', specId: s.id }),
    );
    error(
      () =>
        store.startWork({ targetType: 'task', targetId: child.id, agentId: 'b', leaseSeconds: 60 }),
      'conflict',
    );
    const renewed = store.renewWork({
      targetType: 'task',
      targetId: child.id,
      agentId: 'a',
      leaseSeconds: 120,
    });
    expect(renewed.agentId).toBe('a');
    error(
      () =>
        store.renewWork({
          targetType: 'task',
          targetId: child.id,
          agentId: 'b',
          leaseSeconds: 120,
        }),
      'conflict',
    );
    database.prepare("UPDATE projects SET state='paused' WHERE id=?").run(p.id);
    error(
      () =>
        store.renewWork({
          targetType: 'task',
          targetId: child.id,
          agentId: 'a',
          leaseSeconds: 120,
        }),
      'invalid_state',
    );
    database.prepare("UPDATE projects SET state='open' WHERE id=?").run(p.id);
    store.releaseWork({ targetType: 'task', targetId: child.id, agentId: 'a', note: 'later' });
    error(
      () => store.releaseWork({ targetType: 'task', targetId: child.id, agentId: 'a', note: null }),
      'conflict',
    );
  });

  it('rejects inconsistent Workspace, Project and Spec work filters', () => {
    const first = readyProject();
    const otherRoot = join(root, 'other-workspace');
    mkdirSync(otherRoot);
    store.registerWorkspace({ id: 'other', name: 'Other', rootPath: otherRoot, actor: null });
    const otherProject = store.createProject({
      workspaceId: 'other',
      slug: 'other-project',
      title: 'Other Project',
      actor: null,
    });
    error(
      () =>
        store.listWork({
          workspaceId: 'workspace',
          projectId: otherProject.id,
          specId: null,
          limit: 10,
        }),
      'bad_request',
      /Workspace/,
    );
    error(
      () =>
        store.listWork({
          workspaceId: null,
          projectId: otherProject.id,
          specId: first.spec.id,
          limit: 10,
        }),
      'bad_request',
      /Project/,
    );
    error(
      () =>
        store.listWork({
          workspaceId: 'other',
          projectId: null,
          specId: first.spec.id,
          limit: 10,
        }),
      'bad_request',
      /Workspace/,
    );
  });

  it('completes leaf Tasks, then Specs, then Projects with entity-local evidence', () => {
    let { project: p, spec: s } = readyProject();
    let t = task(s.id);
    const claim = store.startWork({
      targetType: 'task',
      targetId: t.id,
      agentId: 'agent',
      leaseSeconds: 60,
    });
    expect(claim.task?.id).toBe(t.id);
    t = store.completeWork({
      targetType: 'task',
      targetId: t.id,
      agentId: 'agent',
      expectedRevision: t.revision,
      summary: 'task done',
      artifacts: [],
    }) as Task;
    expect(store.getTaskCompletion(t.id).completionSummary).toBe('task done');
    store.startWork({ targetType: 'spec', targetId: s.id, agentId: 'agent', leaseSeconds: 60 });
    s = store.completeWork({
      targetType: 'spec',
      targetId: s.id,
      agentId: 'agent',
      expectedRevision: s.revision,
      summary: 'spec done',
      artifacts: [{ label: null, uri: 'git:1' }],
    }) as Spec;
    p = store.completeProject({
      projectId: p.id,
      expectedRevision: p.revision,
      summary: 'project done',
      artifacts: [],
      actor: 'owner',
    });
    expect([t.state, s.state, p.state]).toEqual(['done', 'done', 'done']);
    expect(store.getProjectCompletion(p.id).completionSummary).toBe('project done');
    error(
      () =>
        store.updateTask({
          taskId: t.id,
          title: 'x',
          body: undefined,
          expectedRevision: t.revision,
          actor: null,
        }),
      'invalid_state',
    );
    error(
      () =>
        store.updateSpec({
          specId: s.id,
          title: 'x',
          body: null,
          state: null,
          expectedRevision: s.revision,
          actor: null,
        }),
      'invalid_state',
    );
  });

  it('cancels Task, Spec and Project descendants atomically and releases Claims', () => {
    const first = readyProject();
    const parent = task(first.spec.id);
    const child = task(first.spec.id, parent.id);
    store.startWork({ targetType: 'task', targetId: child.id, agentId: 'agent', leaseSeconds: 60 });
    const cancelledParent = store.cancelTask({
      taskId: parent.id,
      expectedRevision: parent.revision,
      reason: 'obsolete',
      actor: 'owner',
    });
    expect([cancelledParent.state, store.getTask(child.id).state]).toEqual([
      'cancelled',
      'cancelled',
    ]);
    const second = spec(first.project.id);
    const secondTask = task(second.id);
    const cancelledSpec = store.cancelSpec({
      specId: second.id,
      expectedRevision: second.revision,
      reason: 'no API',
      actor: 'owner',
    });
    expect([cancelledSpec.state, store.getTask(secondTask.id).state]).toEqual([
      'cancelled',
      'cancelled',
    ]);
    const cancelledProject = store.cancelProject({
      projectId: first.project.id,
      expectedRevision: first.project.revision,
      reason: 'portfolio choice',
      actor: 'owner',
    });
    expect(cancelledProject.state).toBe('cancelled');
    expect(store.getOverview().counts.activeClaims).toBe(0);
    expect(
      store.listActivity(first.project.id, 100).some((event) => event.targetType === 'spec'),
    ).toBe(true);
  });

  it('calls the mutation callback exactly once after commits and never after rollback', () => {
    const p = project();
    expect(mutations).toBe(1);
    error(
      () =>
        store.updateProject({
          projectId: p.id,
          title: 'stale',
          state: null,
          expectedRevision: 99,
          actor: null,
        }),
      'revision_conflict',
    );
    expect(mutations).toBe(1);
    store.putContext({
      ownerType: 'project',
      ownerId: p.id,
      name: 'notes',
      body: '# Notes',
      expectedRevision: null,
      actor: null,
    });
    expect(mutations).toBe(2);
    expect(store.listActivity(p.id, 10).map((event) => event.eventType)).toContain('context.put');
  });
});
