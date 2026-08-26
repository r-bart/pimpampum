import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { AppError, type ErrorCode } from '../src/errors.js';
import { PimpampumStore } from '../src/store.js';
import type { Project, Task } from '../src/types.js';

describe('PimpampumStore', () => {
  let database: Database.Database;
  let store: PimpampumStore;
  let temporaryDirectory: string;
  let projectSequence: number;
  let mutationCount: number;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pimpampum-test-'));
    database = openDatabase(':memory:');
    mutationCount = 0;
    store = new PimpampumStore(database, () => {
      mutationCount += 1;
    });
    projectSequence = 0;
    store.registerWorkspace({
      id: 'test-workspace',
      name: 'Test workspace',
      rootPath: temporaryDirectory,
      actor: 'test',
    });
    mutationCount = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function expectAppError(operation: () => unknown, code: ErrorCode, message?: RegExp): AppError {
    try {
      operation();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(code);
      if (message) expect(appError.message).toMatch(message);
      return appError;
    }
    throw new Error(`Expected ${code}`);
  }

  function createProject(input?: {
    workspaceId?: string;
    slug?: string;
    title?: string;
    state?: 'draft' | 'ready';
  }): Project {
    projectSequence += 1;
    return store.createProject({
      workspaceId: input?.workspaceId ?? 'test-workspace',
      slug: input?.slug ?? `project-${projectSequence}`,
      title: input?.title ?? `Project ${projectSequence}`,
      prd: '# Outcome\n\nShip the first version.',
      state: input?.state ?? 'ready',
      actor: 'test',
    });
  }

  function createTask(project: Project, parentId: string | null = null, title = 'Task'): Task {
    return store.createTask({
      projectId: project.id,
      parentId,
      title,
      body: 'Task body',
      actor: 'test',
    });
  }

  function startTask(task: Task, agentId = 'agent-a') {
    return store.startWork({
      targetType: 'task',
      targetId: task.id,
      agentId,
      leaseSeconds: 300,
    });
  }

  function completeTask(task: Task, agentId = 'agent-a'): Task {
    startTask(task, agentId);
    return store.completeWork({
      targetType: 'task',
      targetId: task.id,
      agentId,
      expectedRevision: task.revision,
      summary: 'Task delivered',
      artifacts: [{ label: 'commit', uri: 'git:abc123' }],
    }) as Task;
  }

  function startProject(project: Project, agentId = 'agent-a') {
    return store.startWork({
      targetType: 'project',
      targetId: project.id,
      agentId,
      leaseSeconds: 300,
    });
  }

  function completeProject(project: Project, agentId = 'agent-a'): Project {
    startProject(project, agentId);
    return store.completeWork({
      targetType: 'project',
      targetId: project.id,
      agentId,
      expectedRevision: project.revision,
      summary: 'Project delivered',
      artifacts: [{ label: null, uri: 'file:///artifact' }],
    }) as Project;
  }

  it('notifies exactly once after each commit and never after a rejected mutation', () => {
    const project = createProject({ state: 'draft' });
    expect(mutationCount).toBe(1);

    expectAppError(
      () =>
        store.updatePrd({
          projectId: project.id,
          prd: '# Stale',
          expectedRevision: project.revision + 1,
          actor: 'test',
        }),
      'revision_conflict',
    );
    expect(mutationCount).toBe(1);

    store.updatePrd({
      projectId: project.id,
      prd: '# Current',
      expectedRevision: project.revision,
      actor: 'test',
    });
    expect(mutationCount).toBe(2);
  });

  it('registers, lists and resolves the most specific workspace', () => {
    const nestedRoot = join(temporaryDirectory, 'nested');
    const childDirectory = join(nestedRoot, 'src');
    mkdirSync(childDirectory, { recursive: true });
    store.registerWorkspace({
      id: 'nested-workspace',
      name: 'A nested workspace',
      rootPath: nestedRoot,
      actor: null,
    });

    expect(store.listWorkspaces().map(({ id }) => id)).toEqual([
      'nested-workspace',
      'test-workspace',
    ]);
    expect(store.getWorkspace('nested-workspace').rootPath).toBe(realpathSync(nestedRoot));
    expect(store.resolveWorkspace(childDirectory).id).toBe('nested-workspace');
    expect(store.resolveWorkspace(temporaryDirectory).id).toBe('test-workspace');
  });

  it('validates workspace roots, uniqueness and resolution failures', () => {
    expectAppError(
      () =>
        store.registerWorkspace({ id: 'relative', name: 'Relative', rootPath: '.', actor: null }),
      'bad_request',
      /absolute path/,
    );
    const filePath = join(temporaryDirectory, 'not-a-directory');
    writeFileSync(filePath, 'content');
    expectAppError(
      () => store.registerWorkspace({ id: 'file', name: 'File', rootPath: filePath, actor: null }),
      'bad_request',
      /directory/,
    );
    expectAppError(
      () =>
        store.registerWorkspace({
          id: 'missing-root',
          name: 'Missing',
          rootPath: join(temporaryDirectory, 'missing'),
          actor: null,
        }),
      'bad_request',
      /does not exist/,
    );
    const duplicateIdRoot = join(temporaryDirectory, 'duplicate-id');
    mkdirSync(duplicateIdRoot);
    expectAppError(
      () =>
        store.registerWorkspace({
          id: 'test-workspace',
          name: 'Duplicate id',
          rootPath: duplicateIdRoot,
          actor: null,
        }),
      'conflict',
    );
    expectAppError(
      () =>
        store.registerWorkspace({
          id: 'duplicate-root',
          name: 'Duplicate root',
          rootPath: temporaryDirectory,
          actor: null,
        }),
      'conflict',
    );

    const outside = mkdtempSync(join(tmpdir(), 'pimpampum-outside-'));
    try {
      expectAppError(() => store.resolveWorkspace('relative'), 'bad_request', /absolute/);
      expectAppError(
        () => store.resolveWorkspace(join(temporaryDirectory, 'missing')),
        'not_found',
        /does not exist/,
      );
      expectAppError(() => store.resolveWorkspace(outside), 'not_found');
      expectAppError(() => store.getWorkspace('missing'), 'not_found');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('preserves unexpected storage errors while registering a workspace', () => {
    const otherRoot = join(temporaryDirectory, 'unexpected-error');
    mkdirSync(otherRoot);
    database.exec('DROP TABLE activity_events');

    expect(() =>
      store.registerWorkspace({
        id: 'unexpected',
        name: 'Unexpected',
        rootPath: otherRoot,
        actor: null,
      }),
    ).toThrow(/no such table/);
  });

  it('creates projects, enforces slug uniqueness and validates initial state', () => {
    const first = createProject({ slug: 'shared', state: 'draft' });
    expect(first).toMatchObject({ slug: 'shared', state: 'draft', revision: 1, artifacts: [] });
    expectAppError(
      () =>
        store.createProject({
          workspaceId: 'missing',
          slug: 'orphan',
          title: 'Orphan',
          prd: '',
          state: 'ready',
          actor: null,
        }),
      'not_found',
    );
    expectAppError(() => createProject({ slug: 'shared' }), 'conflict', /slug/);
    expectAppError(
      () =>
        store.createProject({
          workspaceId: 'test-workspace',
          slug: 'already-done',
          title: 'Done',
          prd: '',
          state: 'done' as 'ready',
          actor: null,
        }),
      'bad_request',
      /draft or ready/,
    );
    expectAppError(() => store.getProject('missing'), 'not_found');
  });

  it('filters and paginates projects by workspace and state', () => {
    const otherRoot = join(temporaryDirectory, 'other');
    mkdirSync(otherRoot);
    store.registerWorkspace({
      id: 'other-workspace',
      name: 'Other',
      rootPath: otherRoot,
      actor: 'test',
    });
    createProject({ slug: 'draft', state: 'draft' });
    createProject({ slug: 'ready', state: 'ready' });
    createProject({ workspaceId: 'other-workspace', slug: 'other', state: 'ready' });

    expect(
      store.listProjects({
        workspaceId: 'test-workspace',
        state: null,
        limit: 10,
        offset: 0,
      }),
    ).toHaveLength(2);
    expect(
      store.listProjects({
        workspaceId: null,
        state: 'ready',
        limit: 10,
        offset: 0,
      }),
    ).toHaveLength(2);
    expect(
      store.listProjects({
        workspaceId: null,
        state: null,
        limit: 1,
        offset: 1,
      }),
    ).toHaveLength(1);
  });

  it('updates project metadata and PRDs using optimistic revisions', () => {
    const project = createProject({ state: 'draft' });
    const renamed = store.updateProject({
      projectId: project.id,
      title: 'Renamed',
      state: 'ready',
      expectedRevision: project.revision,
      actor: 'agent-a',
    });
    expect(renamed).toMatchObject({ title: 'Renamed', state: 'ready', revision: 2 });
    const unchanged = store.updateProject({
      projectId: project.id,
      title: null,
      state: null,
      expectedRevision: renamed.revision,
      actor: null,
    });
    expect(unchanged).toMatchObject({ title: 'Renamed', state: 'ready', revision: 3 });
    const updatedPrd = store.updatePrd({
      projectId: project.id,
      prd: '# Updated',
      expectedRevision: unchanged.revision,
      actor: 'agent-b',
    });
    expect(updatedPrd).toMatchObject({ prd: '# Updated', revision: 4 });
    expectAppError(
      () =>
        store.updateProject({
          projectId: project.id,
          title: 'Stale',
          state: null,
          expectedRevision: project.revision,
          actor: null,
        }),
      'revision_conflict',
      /Expected revision/,
    );
    const revisionError = expectAppError(
      () =>
        store.updatePrd({
          projectId: project.id,
          prd: '# Stale',
          expectedRevision: unchanged.revision,
          actor: null,
        }),
      'revision_conflict',
    );
    expect(revisionError).toMatchObject({ retryable: true });
    expect(revisionError.details).toEqual({ expectedRevision: 3, currentRevision: 4 });
  });

  it('creates, updates, lists and reads contextual documents', () => {
    const project = createProject();
    const architecture = store.putContext({
      projectId: project.id,
      name: 'architecture',
      body: '# Architecture',
      expectedRevision: null,
      actor: 'agent-a',
    });
    store.putContext({
      projectId: project.id,
      name: 'decisions',
      body: '# Decisions',
      expectedRevision: null,
      actor: null,
    });
    expect(store.listContext(project.id).map(({ name }) => name)).toEqual([
      'architecture',
      'decisions',
    ]);
    expect(store.readContext(project.id, 'architecture')).toMatchObject({
      body: '# Architecture',
      revision: 1,
    });

    const updated = store.putContext({
      projectId: project.id,
      name: 'architecture',
      body: '# Architecture v2',
      expectedRevision: architecture.revision,
      actor: 'agent-b',
    });
    expect(updated).toMatchObject({ body: '# Architecture v2', revision: 2 });
    expectAppError(
      () =>
        store.putContext({
          projectId: project.id,
          name: 'architecture',
          body: 'duplicate',
          expectedRevision: null,
          actor: null,
        }),
      'conflict',
      /already exists/,
    );
    expectAppError(
      () =>
        store.putContext({
          projectId: project.id,
          name: 'architecture',
          body: 'stale',
          expectedRevision: 1,
          actor: null,
        }),
      'revision_conflict',
    );
    expectAppError(
      () =>
        store.putContext({
          projectId: project.id,
          name: 'missing',
          body: 'missing',
          expectedRevision: 1,
          actor: null,
        }),
      'not_found',
    );
    expectAppError(() => store.readContext(project.id, 'missing'), 'not_found');
    expectAppError(() => store.listContext('missing'), 'not_found');
  });

  it('enforces the one-level task hierarchy and parent ownership', () => {
    const project = createProject();
    const otherProject = createProject();
    const parent = createTask(project, null, 'Parent');
    const otherParent = createTask(otherProject, null, 'Other parent');
    expectAppError(
      () => createTask(project, otherParent.id, 'Wrong project'),
      'bad_request',
      /another project/,
    );
    const child = createTask(project, parent.id, 'Child');
    expectAppError(
      () => createTask(project, child.id, 'Too deep'),
      'bad_request',
      /cannot have children/,
    );
    const completedParent = createTask(project, null, 'Completed parent');
    completeTask(completedParent);
    expectAppError(
      () => createTask(project, completedParent.id, 'Late child'),
      'invalid_state',
      /completed task/,
    );
    const claimedParent = createTask(project, null, 'Claimed parent');
    startTask(claimedParent);
    expectAppError(
      () => createTask(project, claimedParent.id, 'Claimed child'),
      'conflict',
      /Release the parent task claim/,
    );
    expect(store.listTasks(project.id)).toHaveLength(4);
    expectAppError(() => store.getTask('missing'), 'not_found');
    expectAppError(() => store.listTasks('missing'), 'not_found');
  });

  it('blocks new tasks for claimed or completed projects', () => {
    const claimed = createProject();
    startProject(claimed);
    expectAppError(() => createTask(claimed), 'conflict', /Release the project claim/);
    const done = createProject();
    completeProject(done);
    expectAppError(() => createTask(done), 'invalid_state', /completed project/);
  });

  it('updates tasks using revisions and rejects edits after completion', () => {
    const project = createProject();
    const task = createTask(project);
    const updated = store.updateTask({
      taskId: task.id,
      title: 'Renamed task',
      body: null,
      expectedRevision: task.revision,
      actor: 'agent-a',
    });
    expect(updated).toMatchObject({ title: 'Renamed task', body: null, revision: 2 });
    const bodyUpdated = store.updateTask({
      taskId: task.id,
      title: null,
      body: 'New body',
      expectedRevision: updated.revision,
      actor: null,
    });
    expect(bodyUpdated).toMatchObject({ title: 'Renamed task', body: 'New body', revision: 3 });
    expectAppError(
      () =>
        store.updateTask({
          taskId: task.id,
          title: 'Stale',
          body: null,
          expectedRevision: task.revision,
          actor: null,
        }),
      'revision_conflict',
    );
    const completed = completeTask(bodyUpdated);
    expect(completed).toMatchObject({
      state: 'done',
      revision: 4,
      completionSummary: 'Task delivered',
      artifacts: [{ label: 'commit', uri: 'git:abc123' }],
    });
    expect(completed.completedAt).not.toBeNull();
    expect(store.getTaskManifest(task.id).hasCompletion).toBe(true);
    expectAppError(
      () =>
        store.updateTask({
          taskId: task.id,
          title: 'Too late',
          body: null,
          expectedRevision: completed.revision,
          actor: null,
        }),
      'invalid_state',
      /Completed tasks/,
    );
  });

  it('lists only ready leaf work, honors workspace filters and limits', () => {
    const direct = createProject({ slug: 'direct' });
    createProject({ slug: 'draft', state: 'draft' });
    const structured = createProject({ slug: 'structured' });
    const parent = createTask(structured, null, 'Parent');
    const child = createTask(structured, parent.id, 'Child');
    const otherRoot = join(temporaryDirectory, 'other-work');
    mkdirSync(otherRoot);
    store.registerWorkspace({
      id: 'other-workspace',
      name: 'Other',
      rootPath: otherRoot,
      actor: null,
    });
    const other = createProject({ workspaceId: 'other-workspace', slug: 'other' });
    const tiedTimestamp = '2026-08-25T12:00:00.000Z';
    database
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run(tiedTimestamp, direct.id);
    database.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(tiedTimestamp, child.id);

    const testWork = store.listWork({ workspaceId: 'test-workspace', limit: 10 });
    expect(testWork).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetType: 'project', targetId: direct.id }),
        expect.objectContaining({
          targetType: 'task',
          targetId: child.id,
          parentTaskId: parent.id,
        }),
      ]),
    );
    expect(testWork).toHaveLength(2);
    expect(store.listWork({ workspaceId: 'other-workspace', limit: 10 })).toMatchObject([
      { targetType: 'project', targetId: other.id },
    ]);
    expect(store.listWork({ workspaceId: null, limit: 1 })).toHaveLength(1);
    startProject(direct);
    startTask(child);
    expect(store.listWork({ workspaceId: 'test-workspace', limit: 10 })).toEqual([]);
  });

  it('returns a complete work bundle including context metadata', () => {
    const project = createProject();
    const task = createTask(project);
    const emptyTask = store.createTask({
      projectId: project.id,
      parentId: null,
      title: 'Empty body',
      body: null,
      actor: 'test',
    });
    expect(store.readTaskBody(emptyTask.id, 0, 10).body).toBe('');
    store.putContext({
      projectId: project.id,
      name: 'architecture',
      body: 'á',
      expectedRevision: null,
      actor: null,
    });
    const bundle = startTask(task);
    expect(bundle).toMatchObject({
      workspace: { id: 'test-workspace' },
      project: { id: project.id },
      task: { id: task.id },
      claim: { targetType: 'task', targetId: task.id, agentId: 'agent-a' },
      context: [{ name: 'architecture', sizeBytes: 2 }],
    });
    expect(store.getTask(task.id).claim?.agentId).toBe('agent-a');
  });

  it('enforces claimability rules for project state, tasks and leaf order', () => {
    const draft = createProject({ state: 'draft' });
    expectAppError(() => startProject(draft), 'invalid_state', /ready projects/);
    const project = createProject();
    const parent = createTask(project, null, 'Parent');
    const child = createTask(project, parent.id, 'Child');
    expectAppError(() => startProject(project), 'invalid_state', /individual tasks/);
    expectAppError(() => startTask(parent), 'invalid_state', /subtasks/);
    store.updateProject({
      projectId: project.id,
      title: null,
      state: 'draft',
      expectedRevision: project.revision,
      actor: null,
    });
    expectAppError(() => startTask(child), 'invalid_state', /ready projects/);
  });

  it('allows exactly one active claim and allows a new claim after expiry', () => {
    const project = createProject();
    const first = startProject(project, 'agent-a');
    const retried = startProject(project, 'agent-a');
    expect(retried.claim).toEqual(first.claim);
    expect(
      store.listActivity(project.id, 100).filter((event) => event.eventType === 'work.started'),
    ).toHaveLength(1);
    const conflict = expectAppError(() => startProject(project, 'agent-b'), 'conflict');
    expect(conflict.retryable).toBe(true);
    database.prepare("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(store.getProject(project.id).claim).toBeNull();
    expect(startProject(project, 'agent-b').claim.agentId).toBe('agent-b');
    expectAppError(
      () => store.exportPortable(join(temporaryDirectory, 'busy-export')),
      'conflict',
      /maintenance window/,
    );
  });

  it('renews and releases only active claims owned by the requesting agent', () => {
    const project = createProject();
    expectAppError(
      () =>
        store.renewWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-a',
          leaseSeconds: 600,
        }),
      'conflict',
      /not currently claimed/,
    );
    startProject(project, 'agent-a');
    expectAppError(
      () =>
        store.renewWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-b',
          leaseSeconds: 600,
        }),
      'conflict',
      /claimed by agent-a/,
    );
    const renewed = store.renewWork({
      targetType: 'project',
      targetId: project.id,
      agentId: 'agent-a',
      leaseSeconds: 600,
    });
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expectAppError(
      () =>
        store.releaseWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-b',
          note: null,
        }),
      'conflict',
      /claimed by agent-a/,
    );
    store.releaseWork({
      targetType: 'project',
      targetId: project.id,
      agentId: 'agent-a',
      note: 'Pausing',
    });
    expect(store.getProject(project.id).claim).toBeNull();
    expectAppError(
      () =>
        store.releaseWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-a',
          note: null,
        }),
      'conflict',
    );
  });

  it('reports retryable conflicts when a claim changes during renewal or release', () => {
    const renewalProject = createProject();
    startProject(renewalProject);
    database.exec(`
      CREATE TRIGGER remove_claim_before_update
      BEFORE UPDATE ON claims
      BEGIN
        DELETE FROM claims
        WHERE target_type = OLD.target_type AND target_id = OLD.target_id;
      END
    `);
    const renewError = expectAppError(
      () =>
        store.renewWork({
          targetType: 'project',
          targetId: renewalProject.id,
          agentId: 'agent-a',
          leaseSeconds: 300,
        }),
      'conflict',
      /changed before renewal/,
    );
    expect(renewError.retryable).toBe(true);
    database.exec('DROP TRIGGER remove_claim_before_update');

    const releaseProject = createProject();
    startProject(releaseProject);
    database.exec(`
      CREATE TRIGGER remove_claim_before_delete
      BEFORE DELETE ON claims
      BEGIN
        DELETE FROM claims
        WHERE target_type = OLD.target_type AND target_id = OLD.target_id;
      END
    `);
    const releaseError = expectAppError(
      () =>
        store.releaseWork({
          targetType: 'project',
          targetId: releaseProject.id,
          agentId: 'agent-a',
          note: null,
        }),
      'conflict',
      /changed before release/,
    );
    expect(releaseError.retryable).toBe(true);
  });

  it('rejects renewal, release and completion of an expired claim', () => {
    const project = createProject();
    startProject(project);
    database.prepare("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expectAppError(
      () =>
        store.renewWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-a',
          leaseSeconds: 60,
        }),
      'conflict',
    );
    expectAppError(
      () =>
        store.releaseWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-a',
          note: null,
        }),
      'conflict',
    );
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-a',
          expectedRevision: project.revision,
          summary: 'Too late',
          artifacts: [],
        }),
      'conflict',
    );
  });

  it('rejects completion without ownership and stale completion revisions', () => {
    const project = createProject();
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-a',
          expectedRevision: project.revision,
          summary: 'Unclaimed',
          artifacts: [],
        }),
      'conflict',
    );
    startProject(project, 'agent-a');
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-b',
          expectedRevision: project.revision,
          summary: 'Stolen',
          artifacts: [],
        }),
      'conflict',
      /claimed by agent-a/,
    );
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-a',
          expectedRevision: 0,
          summary: 'Stale',
          artifacts: [],
        }),
      'revision_conflict',
    );
    expect(store.getProject(project.id).claim?.agentId).toBe('agent-a');
  });

  it('rejects project and task completion when their state or children make it invalid', () => {
    const project = createProject();
    startProject(project);
    const draft = store.updateProject({
      projectId: project.id,
      title: null,
      state: 'draft',
      expectedRevision: project.revision,
      actor: null,
    });
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'project',
          targetId: project.id,
          agentId: 'agent-a',
          expectedRevision: draft.revision,
          summary: 'Invalid',
          artifacts: [],
        }),
      'invalid_state',
      /Only ready projects/,
    );

    const projectWithForcedTask = createProject();
    startProject(projectWithForcedTask);
    const forcedTimestamp = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO tasks
           (id, project_id, parent_id, title, body, state, created_at, updated_at)
         VALUES ('forced-project-task', ?, NULL, 'Forced task', NULL, 'open', ?, ?)`,
      )
      .run(projectWithForcedTask.id, forcedTimestamp, forcedTimestamp);
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'project',
          targetId: projectWithForcedTask.id,
          agentId: 'agent-a',
          expectedRevision: projectWithForcedTask.revision,
          summary: 'Blocked',
          artifacts: [],
        }),
      'invalid_state',
      /open tasks/,
    );

    const structured = createProject();
    const task = createTask(structured);
    startTask(task);
    const timestamp = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO tasks
         (id, project_id, parent_id, title, body, state, created_at, updated_at)
       VALUES ('forced-child', ?, ?, 'Forced child', NULL, 'open', ?, ?)`,
      )
      .run(structured.id, task.id, timestamp, timestamp);
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'task',
          targetId: task.id,
          agentId: 'agent-a',
          expectedRevision: task.revision,
          summary: 'Invalid',
          artifacts: [],
        }),
      'invalid_state',
      /open subtasks/,
    );
    database.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(task.id);
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'task',
          targetId: task.id,
          agentId: 'agent-a',
          expectedRevision: task.revision,
          summary: 'Already done',
          artifacts: [],
        }),
      'invalid_state',
      /Only open tasks/,
    );

    const draftDuringLease = createProject({ slug: 'draft-during-lease' });
    const leasedTask = createTask(draftDuringLease);
    startTask(leasedTask);
    store.updateProject({
      projectId: draftDuringLease.id,
      title: null,
      state: 'draft',
      expectedRevision: draftDuringLease.revision,
      actor: 'admin',
    });
    expectAppError(
      () =>
        store.completeWork({
          targetType: 'task',
          targetId: leasedTask.id,
          agentId: 'agent-a',
          expectedRevision: leasedTask.revision,
          summary: 'Must not complete',
          artifacts: [],
        }),
      'invalid_state',
      /ready projects/,
    );
  });

  it('completes work, clears claims and prevents edits to completed projects', () => {
    const project = createProject();
    const completed = completeProject(project);
    expect(completed).toMatchObject({
      state: 'done',
      revision: 2,
      completionSummary: 'Project delivered',
      artifacts: [{ label: null, uri: 'file:///artifact' }],
      claim: null,
    });
    expect(completed.completedAt).not.toBeNull();
    expect(store.getProjectManifest(project.id).hasCompletion).toBe(true);
    expect(store.listWork({ workspaceId: 'test-workspace', limit: 10 })).toEqual([]);
    expectAppError(
      () =>
        store.updateProject({
          projectId: project.id,
          title: 'Too late',
          state: null,
          expectedRevision: completed.revision,
          actor: null,
        }),
      'invalid_state',
    );
    expectAppError(
      () =>
        store.updatePrd({
          projectId: project.id,
          prd: 'Too late',
          expectedRevision: completed.revision,
          actor: null,
        }),
      'invalid_state',
    );
    expectAppError(
      () =>
        store.putContext({
          projectId: project.id,
          name: 'late',
          body: 'Too late',
          expectedRevision: null,
          actor: null,
        }),
      'invalid_state',
    );
  });

  it('records actors, data and the real activity target for every domain operation', () => {
    const project = createProject();
    const task = createTask(project);
    const context = store.putContext({
      projectId: project.id,
      name: 'architecture',
      body: '# Architecture',
      expectedRevision: null,
      actor: 'context-agent',
    });
    startTask(task, 'work-agent');
    store.renewWork({
      targetType: 'task',
      targetId: task.id,
      agentId: 'work-agent',
      leaseSeconds: 300,
    });
    store.releaseWork({
      targetType: 'task',
      targetId: task.id,
      agentId: 'work-agent',
      note: 'Pause',
    });
    startTask(task, 'work-agent');
    store.completeWork({
      targetType: 'task',
      targetId: task.id,
      agentId: 'work-agent',
      expectedRevision: task.revision,
      summary: 'x'.repeat(300),
      artifacts: [],
    });
    const events = store.listActivity(project.id, 100);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'task.created',
          targetType: 'task',
          targetId: task.id,
        }),
        expect.objectContaining({
          eventType: 'context.put',
          targetType: 'context',
          targetId: context.id,
          actor: 'context-agent',
          data: { targetId: context.id, name: 'architecture' },
        }),
        expect.objectContaining({
          eventType: 'work.started',
          targetType: 'task',
          targetId: task.id,
          actor: 'work-agent',
        }),
        expect.objectContaining({
          eventType: 'work.released',
          targetType: 'task',
          targetId: task.id,
          data: expect.objectContaining({ note: 'Pause' }),
        }),
        expect.objectContaining({
          eventType: 'work.completed',
          data: {
            targetType: 'task',
            targetId: task.id,
            summaryPreview: 'x'.repeat(240),
            summaryTruncated: true,
            artifactCount: 0,
          },
        }),
      ]),
    );
    expect(store.listActivity(project.id, 1)).toHaveLength(1);
    expectAppError(() => store.listActivity('missing', 10), 'not_found');
  });

  it('falls back safely when persisted activity or artifact JSON is malformed in shape', () => {
    const project = createProject();
    database.prepare("UPDATE projects SET artifacts_json = '{}' WHERE id = ?").run(project.id);
    database
      .prepare("UPDATE activity_events SET data_json = '[]' WHERE project_id = ?")
      .run(project.id);
    expect(store.getProject(project.id).artifacts).toEqual([]);
    expect(store.listActivity(project.id, 10)[0]?.data).toEqual({});
  });

  it('writes a valid backup and a complete portable export', async () => {
    const project = createProject({ slug: 'portable' });
    createTask(project);
    store.putContext({
      projectId: project.id,
      name: 'architecture',
      body: '# Architecture',
      expectedRevision: null,
      actor: 'test',
    });
    const backupDirectory = join(temporaryDirectory, 'backup');
    const exportDirectory = join(temporaryDirectory, 'export');
    const backup = await store.backup(backupDirectory);
    const exported = store.exportPortable(exportDirectory);
    expect(existsSync(backup)).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(exported).mode & 0o777).toBe(0o700);
    expect(existsSync(join(exported, 'manifest.json'))).toBe(true);
    expect(
      existsSync(join(exported, 'projects', 'test-workspace', 'portable', 'project.json')),
    ).toBe(true);
    expect(existsSync(join(exported, 'projects', 'test-workspace', 'portable', 'prd.md'))).toBe(
      true,
    );
    expect(
      existsSync(
        join(exported, 'projects', 'test-workspace', 'portable', 'context', 'architecture.md'),
      ),
    ).toBe(true);

    await expect(store.backup('relative')).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    await expect(store.backupLatest('relative')).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    expectAppError(() => store.exportPortable('relative'), 'bad_request', /absolute path/);
  });

  it('returns a retryable error when an optimistic write loses its final compare-and-swap', () => {
    const error = expectAppError(
      () => store['assertChanged'](0, 7),
      'revision_conflict',
      /changed before this write/,
    );
    expect(error).toMatchObject({ retryable: true, details: { currentRevision: 7 } });
  });

  it('treats a missing aggregate row as zero open work', () => {
    const emptyAggregateDatabase = {
      prepare: () => ({ get: () => undefined }),
    } as unknown as Database.Database;
    const emptyAggregateStore = new PimpampumStore(emptyAggregateDatabase);

    expect(emptyAggregateStore['countOpenTasks']('missing')).toBe(0);
    expect(emptyAggregateStore['countOpenChildren']('missing')).toBe(0);
  });
});
