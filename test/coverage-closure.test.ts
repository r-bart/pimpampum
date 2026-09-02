import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPortable } from '../src/backup.js';
import { openDatabase } from '../src/db.js';
import { migrateDatabase } from '../src/migrations.js';
import { PimpampumStore } from '../src/store.js';
import type { Project, Spec, Task, Workspace } from '../src/types.js';

const directories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-coverage-${label}-`));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Three `migrateDatabase` branches cannot be reached through a real SQLite file:
 *
 * - `scalarCount`'s `?? 0` fallback: `SELECT COUNT(*)` always yields one row.
 * - the post-copy validation failure: `assertV1Ownership` rejects every row that could make
 *   `foreign_key_check` or the row counts disagree, so the second check is a redundant safety net.
 * - the non-Error fallback message: better-sqlite3 and the migration only throw `Error`s.
 *
 * They stay covered by this minimal double until `src/migrations.ts` marks them
 * `v8 ignore` (Phase 8 handoff). Everything else in this file drives a real database; the
 * three-level Task rejection and the unsupported version live in
 * `domain-model-v2.migration.acceptance.test.ts` and below.
 */
function unreachableBranchDouble(input: {
  foreignKeyFailures?: unknown[];
  transactionFailure?: unknown;
  undefinedCounts?: boolean;
}): Database.Database {
  return {
    pragma: (source: string) => {
      if (source === 'user_version') return 1;
      if (source === 'foreign_key_check') return input.foreignKeyFailures ?? [];
      return undefined;
    },
    prepare: () => ({
      get: () => (input.undefinedCounts ? undefined : { count: 0 }),
      all: () => [],
      run: () => ({ changes: 1 }),
    }),
    exec: () => undefined,
    transaction: (operation: () => unknown) => () => {
      if ('transactionFailure' in input) throw input.transactionFailure;
      return operation();
    },
  } as unknown as Database.Database;
}

describe('migration branches unreachable through SQLite', () => {
  it('treats an absent scalar row as zero', () => {
    expect(() => migrateDatabase(unreachableBranchDouble({ undefinedCounts: true }))).not.toThrow();
  });

  it('rolls back when post-copy validation detects foreign-key failures', () => {
    expect(() =>
      migrateDatabase(unreachableBranchDouble({ foreignKeyFailures: [{ table: 'tasks' }] })),
    ).toThrow(/migration validation failed/iu);
  });

  it('normalizes a non-Error migration failure', () => {
    expect(() =>
      migrateDatabase(unreachableBranchDouble({ transactionFailure: 'disk disappeared' })),
    ).toThrow(/unknown error/iu);
  });
});

describe('migration version markers on a real database', () => {
  it('rejects a negative user_version as an unsupported schema', () => {
    const directory = temporaryDirectory('negative-version');
    const path = join(directory, 'pimpampum.sqlite');
    const stamped = new Database(path);
    stamped.pragma('user_version = -1');
    stamped.close();
    expect(() => openDatabase(path)).toThrow(/unsupported database schema version -1/iu);
  });
});

describe('Store coverage closure', () => {
  function setup(): {
    database: Database.Database;
    store: PimpampumStore;
    workspace: Workspace;
    root: string;
  } {
    const root = temporaryDirectory('store');
    const database = openDatabase(':memory:');
    const store = new PimpampumStore(database);
    const workspace = store.registerWorkspace({
      id: 'workspace',
      name: 'Workspace',
      rootPath: root,
      actor: null,
    });
    return { database, store, workspace, root };
  }

  function project(store: PimpampumStore, workspaceId = 'workspace', slug = 'project'): Project {
    return store.createProject({ workspaceId, slug, title: slug, actor: null });
  }

  function spec(store: PimpampumStore, projectId: string, slug = 'spec'): Spec {
    return store.createSpec({ projectId, slug, title: slug, body: '# Spec', actor: null });
  }

  function ready(store: PimpampumStore, slug = 'project'): { project: Project; spec: Spec } {
    let createdProject = project(store, 'workspace', slug);
    let createdSpec = spec(store, createdProject.id, `${slug}-spec`);
    createdSpec = store.updateSpec({
      specId: createdSpec.id,
      title: null,
      body: null,
      state: 'ready',
      expectedRevision: createdSpec.revision,
      actor: null,
    });
    createdProject = store.updateProject({
      projectId: createdProject.id,
      title: null,
      state: 'open',
      expectedRevision: createdProject.revision,
      actor: null,
    });
    return { project: createdProject, spec: createdSpec };
  }

  it('executes raw collection readers, filters, completions and missing-row paths', () => {
    const { database, store } = setup();
    const created = ready(store);
    const createdTask = store.createTask({
      specId: created.spec.id,
      parentId: null,
      title: 'Task',
      body: null,
      actor: null,
    });
    store.putContext({
      ownerType: 'workspace',
      ownerId: 'workspace',
      name: 'notes',
      body: '# Notes',
      expectedRevision: null,
      actor: null,
    });
    expect(
      store.listProjectManifests({ workspaceId: 'workspace', state: 'open', limit: 10, offset: 0 }),
    ).toHaveLength(1);
    expect(
      store.listProjectManifests({ workspaceId: null, state: null, limit: 10, offset: 0 }),
    ).toHaveLength(1);
    expect(
      store.listSpecManifests({ projectId: created.project.id, state: null, limit: 10, offset: 0 }),
    ).toHaveLength(1);
    expect(store.listTaskManifests({ specId: created.spec.id, limit: 10, offset: 0 })).toHaveLength(
      1,
    );
    expect(
      store.listContextManifests({
        ownerType: 'workspace',
        ownerId: 'workspace',
        limit: 10,
        offset: 0,
      }),
    ).toHaveLength(1);
    expect(store.getSpecCompletion(created.spec.id)).toEqual({
      completionSummary: null,
      artifacts: [],
      completedAt: null,
    });
    expect(store.readTaskBody(createdTask.id, 0, 10).body).toBe('');
    database.prepare("UPDATE projects SET artifacts_json='{}' WHERE id=?").run(created.project.id);
    expect(store.getProject(created.project.id).artifacts).toEqual([]);
    database
      .prepare(
        "INSERT INTO activity_events (workspace_id,project_id,spec_id,target_type,target_id,event_type,actor,data_json,created_at) VALUES ('workspace',?,?, 'project',?,'invalid.data',NULL,'[]','2026-01-01T00:00:00.000Z')",
      )
      .run(created.project.id, created.spec.id, created.project.id);
    expect(store.listActivity(created.project.id, 1)[0]?.data).toEqual({});
    expect(() => store.getWorkspace('missing')).toThrow(/not found/iu);
    expect(() => store.getProject('missing')).toThrow(/not found/iu);
    expect(() => store.getSpec('missing')).toThrow(/not found/iu);
    expect(() => store.getTask('missing')).toThrow(/not found/iu);
    expect(() => store.readContext('workspace', 'workspace', 'missing')).toThrow(/not found/iu);
    expect(() => store.resolveWorkspace(temporaryDirectory('outside-workspace'))).toThrow(
      /No registered workspace/iu,
    );
    store.close();
  });

  it('rejects terminal hierarchy mutation and every Task creation conflict', () => {
    const { store } = setup();
    const first = ready(store);
    let terminalTask = store.createTask({
      specId: first.spec.id,
      parentId: null,
      title: 'Terminal parent',
      body: null,
      actor: null,
    });
    store.startWork({
      targetType: 'task',
      targetId: terminalTask.id,
      agentId: 'agent',
      leaseSeconds: 60,
    });
    terminalTask = store.completeWork({
      targetType: 'task',
      targetId: terminalTask.id,
      agentId: 'agent',
      expectedRevision: terminalTask.revision,
      summary: 'done',
      artifacts: [],
    }) as Task;
    expect(() =>
      store.createTask({
        specId: first.spec.id,
        parentId: terminalTask.id,
        title: 'Child',
        body: null,
        actor: null,
      }),
    ).toThrow(/terminal Task/iu);

    const claimedParent = store.createTask({
      specId: first.spec.id,
      parentId: null,
      title: 'Claimed',
      body: null,
      actor: null,
    });
    store.startWork({
      targetType: 'task',
      targetId: claimedParent.id,
      agentId: 'agent',
      leaseSeconds: 60,
    });
    expect(() =>
      store.createTask({
        specId: first.spec.id,
        parentId: claimedParent.id,
        title: 'Child',
        body: null,
        actor: null,
      }),
    ).toThrow(/release the parent Task claim/iu);
    store.releaseWork({
      targetType: 'task',
      targetId: claimedParent.id,
      agentId: 'agent',
      note: null,
    });

    const direct = ready(store, 'direct-project');
    store.startWork({
      targetType: 'spec',
      targetId: direct.spec.id,
      agentId: 'agent',
      leaseSeconds: 60,
    });
    expect(() =>
      store.createTask({
        specId: direct.spec.id,
        parentId: null,
        title: 'Blocked',
        body: null,
        actor: null,
      }),
    ).toThrow(/release the Spec claim/iu);

    const cancelled = store.cancelProject({
      projectId: first.project.id,
      expectedRevision: first.project.revision,
      reason: 'stop',
      actor: null,
    });
    expect(() =>
      store.updateProject({
        projectId: cancelled.id,
        title: 'No',
        state: null,
        expectedRevision: cancelled.revision,
        actor: null,
      }),
    ).toThrow(/terminal Projects/iu);
    expect(() => spec(store, cancelled.id, 'forbidden')).toThrow(/terminal Project/iu);
    expect(() =>
      store.createTask({
        specId: first.spec.id,
        parentId: null,
        title: 'Forbidden',
        body: null,
        actor: null,
      }),
    ).toThrow(/terminal work/iu);
    store.close();
  });

  it('covers write races using SQLite IGNORE triggers', () => {
    const { database, store } = setup();
    const first = ready(store);
    database.exec(
      'CREATE TRIGGER ignore_project_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(IGNORE); END',
    );
    expect(() =>
      store.updateProject({
        projectId: first.project.id,
        title: 'Race',
        state: null,
        expectedRevision: first.project.revision,
        actor: null,
      }),
    ).toThrow(/changed before this write/iu);
    expect(() =>
      store.cancelProject({
        projectId: first.project.id,
        expectedRevision: first.project.revision,
        reason: 'race',
        actor: null,
      }),
    ).toThrow(/changed before this write/iu);
    database.exec('DROP TRIGGER ignore_project_update');

    store.startWork({
      targetType: 'spec',
      targetId: first.spec.id,
      agentId: 'agent',
      leaseSeconds: 60,
    });
    database.exec(
      'CREATE TRIGGER ignore_claim_update BEFORE UPDATE ON claims BEGIN SELECT RAISE(IGNORE); END',
    );
    expect(() =>
      store.renewWork({
        targetType: 'spec',
        targetId: first.spec.id,
        agentId: 'agent',
        leaseSeconds: 60,
      }),
    ).toThrow(/changed before renewal/iu);
    database.exec('DROP TRIGGER ignore_claim_update');
    database.exec(
      'CREATE TRIGGER ignore_claim_delete BEFORE DELETE ON claims BEGIN SELECT RAISE(IGNORE); END',
    );
    expect(() =>
      store.releaseWork({
        targetType: 'spec',
        targetId: first.spec.id,
        agentId: 'agent',
        note: null,
      }),
    ).toThrow(/changed before release/iu);
    database.exec('DROP TRIGGER ignore_claim_delete');
    store.close();
  });

  it('validates backup/export paths, active-Claim maintenance and all-paused overview', async () => {
    const { store } = setup();
    let first = ready(store);
    first.project = store.updateProject({
      projectId: first.project.id,
      title: null,
      state: 'paused',
      expectedRevision: first.project.revision,
      actor: null,
    });
    expect(store.getOverview().status).toBe('paused');
    await expect(store.backup('relative')).rejects.toThrow(/absolute/iu);
    await expect(store.backupLatest('relative')).rejects.toThrow(/absolute/iu);
    expect(() => store.exportPortable('relative')).toThrow(/absolute/iu);
    first.project = store.updateProject({
      projectId: first.project.id,
      title: null,
      state: 'open',
      expectedRevision: first.project.revision,
      actor: null,
    });
    store.startWork({
      targetType: 'spec',
      targetId: first.spec.id,
      agentId: 'agent',
      leaseSeconds: 60,
    });
    expect(() => store.exportPortable(temporaryDirectory('export-blocked'))).toThrow(
      /active Claims/iu,
    );
    store.close();
  });

  it('rethrows non-uniqueness database failures from create methods', () => {
    const workspaceCase = setup();
    workspaceCase.database.close();
    expect(() =>
      workspaceCase.store.registerWorkspace({
        id: 'other',
        name: 'Other',
        rootPath: workspaceCase.root,
        actor: null,
      }),
    ).toThrow(/database connection is not open/iu);

    const projectCase = setup();
    projectCase.database.close();
    expect(() => project(projectCase.store, 'workspace', 'closed')).toThrow(
      /database connection is not open/iu,
    );

    const specCase = setup();
    const existingProject = project(specCase.store);
    specCase.database.close();
    expect(() => spec(specCase.store, existingProject.id)).toThrow(
      /database connection is not open/iu,
    );
  });
});

describe('portable export pagination coverage', () => {
  it('advances to a second Spec page after an exact full page', () => {
    const destination = temporaryDirectory('portable');
    const workspace: Workspace = {
      id: 'workspace',
      name: 'Workspace',
      rootPath: destination,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const project = {
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: workspace.id,
      slug: 'project',
      title: 'Project',
      state: 'draft' as const,
      revision: 1,
      completionSummary: null,
      artifacts: [],
      completedAt: null,
      cancelledAt: null,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
    const manifests = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      projectId: project.id,
      slug: `spec-${String(index).padStart(3, '0')}`,
    }));
    const source = {
      listWorkspaces: () => [workspace],
      listProjectManifests: ({ offset }: { offset: number }) =>
        offset === 0
          ? [
              {
                ...project,
                artifactCount: 0,
                hasCompletion: false,
                specCount: 101,
                draftSpecCount: 101,
                readySpecCount: 0,
                terminalSpecCount: 0,
              },
            ]
          : [],
      getProject: () => project,
      listSpecManifests: ({ offset }: { offset: number }) =>
        manifests.slice(offset, offset + 100).map((manifest) => ({
          ...manifest,
          title: manifest.slug,
          state: 'draft' as const,
          revision: 1,
          completedAt: null,
          cancelledAt: null,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          claim: null,
          bodySizeBytes: 6,
          artifactCount: 0,
          hasCompletion: false,
          taskCount: 0,
          openTaskCount: 0,
          terminalTaskCount: 0,
        })),
      getSpec: (id: string) => {
        const manifest = manifests.find((item) => item.id === id)!;
        return {
          ...manifest,
          title: manifest.slug,
          body: '# Spec',
          state: 'draft' as const,
          revision: 1,
          completionSummary: null,
          artifacts: [],
          completedAt: null,
          cancelledAt: null,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          claim: null,
        };
      },
      listTaskManifests: () => [],
      getTask: () => {
        throw new Error('No Tasks');
      },
      listContextManifests: () => [],
      readContext: () => {
        throw new Error('No Context');
      },
    };
    const exported = exportPortable(source, destination);
    expect(exported).toContain('pimpampum-export-');
  });
});
