import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import {
  boundOverview,
  sortOverviewProjects,
  statusForOverview,
  statusForProject,
} from '../src/overview.js';
import { overviewEnvelopeSchema, parseOverview } from '../src/overviewContract.js';
import { PimpampumStore } from '../src/store.js';
import type { OverviewProject } from '../src/types.js';

interface Fixture {
  database: Database.Database;
  directory: string;
  store: PimpampumStore;
}

const fixtures: Fixture[] = [];

function fixture(label: string): Fixture {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-overview-${label}-`));
  const database = openDatabase(':memory:');
  const store = new PimpampumStore(database);
  store.registerWorkspace({
    id: label,
    name: `Workspace ${label}`,
    rootPath: directory,
    actor: 'overview-test',
  });
  const created = { database, directory, store };
  fixtures.push(created);
  return created;
}

function insertProject(
  database: Database.Database,
  input: {
    id: string;
    workspaceId: string;
    state: 'draft' | 'ready' | 'done';
    updatedAt: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO projects
         (id, workspace_id, slug, title, state, prd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.workspaceId,
      input.id,
      `Project ${input.id}`,
      input.state,
      '# Payload excluded from overview',
      input.updatedAt,
      input.updatedAt,
    );
}

function insertTask(
  database: Database.Database,
  input: { id: string; projectId: string; title: string; timestamp: string },
): void {
  database
    .prepare(
      `INSERT INTO tasks
         (id, project_id, parent_id, title, body, state, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 'open', ?, ?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.title,
      'Task payload excluded from overview',
      input.timestamp,
      input.timestamp,
    );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const current of fixtures.splice(0)) {
    current.store.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

describe('overview semantics', () => {
  it('applies every project and global precedence branch', () => {
    expect(
      statusForProject({
        lifecycleState: 'ready',
        activeClaimCount: 1,
        availableWorkCount: 1,
      }),
    ).toBe('active');
    expect(
      statusForProject({
        lifecycleState: 'ready',
        activeClaimCount: 0,
        availableWorkCount: 1,
      }),
    ).toBe('available');
    expect(
      statusForProject({
        lifecycleState: 'done',
        activeClaimCount: 0,
        availableWorkCount: 0,
      }),
    ).toBe('complete');
    expect(
      statusForProject({
        lifecycleState: 'ready',
        activeClaimCount: 0,
        availableWorkCount: 0,
      }),
    ).toBe('draft');

    expect(
      statusForOverview({
        projects: 0,
        draftProjects: 0,
        completedProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('empty');
    expect(
      statusForOverview({
        projects: 1,
        draftProjects: 0,
        completedProjects: 0,
        activeClaims: 1,
        availableWork: 1,
      }),
    ).toBe('active');
    expect(
      statusForOverview({
        projects: 1,
        draftProjects: 0,
        completedProjects: 0,
        activeClaims: 0,
        availableWork: 1,
      }),
    ).toBe('available');
    expect(
      statusForOverview({
        projects: 1,
        draftProjects: 1,
        completedProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('draft');
    expect(
      statusForOverview({
        projects: 1,
        draftProjects: 0,
        completedProjects: 1,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('complete');
    expect(
      statusForOverview({
        projects: 1,
        draftProjects: 0,
        completedProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('draft');
  });

  it('sorts by status, newest update, and stable id and bounds without mutation', () => {
    const project = (
      id: string,
      status: OverviewProject['status'],
      updatedAt: string,
    ): Pick<OverviewProject, 'id' | 'status' | 'updatedAt'> => ({ id, status, updatedAt });
    const projects = [
      project('complete', 'complete', '2026-08-26T00:05:00.000Z'),
      project('available-old', 'available', '2026-08-26T00:01:00.000Z'),
      project('available-b', 'available', '2026-08-26T00:02:00.000Z'),
      project('draft', 'draft', '2026-08-26T00:04:00.000Z'),
      project('active', 'active', '2026-08-26T00:00:00.000Z'),
      project('available-a', 'available', '2026-08-26T00:02:00.000Z'),
    ];

    expect([...projects].sort(sortOverviewProjects).map(({ id }) => id)).toEqual([
      'active',
      'available-a',
      'available-b',
      'available-old',
      'draft',
      'complete',
    ]);
    expect(
      sortOverviewProjects(
        project('same', 'active', '2026-08-26T00:00:00.000Z'),
        project('same', 'active', '2026-08-26T00:00:00.000Z'),
      ),
    ).toBe(0);
    expect(boundOverview(projects, projects.length)).toEqual({
      items: projects,
      truncated: false,
    });
    expect(boundOverview(projects, 2)).toEqual({
      items: projects.slice(0, 2),
      truncated: true,
    });
  });
});

describe('overview transport contract', () => {
  it('accepts every frozen valid fixture and rejects the frozen invalid fixture', () => {
    for (const name of ['empty', 'mixed', 'complete']) {
      const fixtureValue: unknown = JSON.parse(
        readFileSync(join(process.cwd(), 'test/fixtures/overview', `${name}.json`), 'utf8'),
      );
      const envelope = overviewEnvelopeSchema.parse(fixtureValue);
      expect(parseOverview(envelope.data)).toEqual(envelope.data);
    }
    const invalid: unknown = JSON.parse(
      readFileSync(join(process.cwd(), 'test/fixtures/overview/invalid.json'), 'utf8'),
    );
    expect(overviewEnvelopeSchema.safeParse(invalid).success).toBe(false);
    expect(() => parseOverview((invalid as { data: unknown }).data)).toThrow('invalid overview');
  });
});

describe('PimpampumStore.getOverview', () => {
  it('aggregates mixed lifecycle state, project claims, and task claims deterministically', () => {
    const { database, store } = fixture('mixed');
    const activeTaskProject = store.createProject({
      workspaceId: 'mixed',
      slug: 'active-task',
      title: 'Duplicate',
      prd: '# Private active task PRD',
      state: 'ready',
      actor: 'overview-test',
    });
    const activeTask = store.createTask({
      projectId: activeTaskProject.id,
      parentId: null,
      title: 'Claimed leaf',
      body: 'Private active task body',
      actor: 'overview-test',
    });
    store.startWork({
      targetType: 'task',
      targetId: activeTask.id,
      agentId: 'task-agent',
      leaseSeconds: 1_800,
    });
    const activeProject = store.createProject({
      workspaceId: 'mixed',
      slug: 'active-project',
      title: 'Duplicate',
      prd: '',
      state: 'ready',
      actor: 'overview-test',
    });
    store.startWork({
      targetType: 'project',
      targetId: activeProject.id,
      agentId: 'project-agent',
      leaseSeconds: 1_800,
    });
    const available = store.createProject({
      workspaceId: 'mixed',
      slug: 'available',
      title: 'Duplicate',
      prd: '',
      state: 'ready',
      actor: 'overview-test',
    });
    const draft = store.createProject({
      workspaceId: 'mixed',
      slug: 'draft',
      title: 'Duplicate',
      prd: '',
      state: 'draft',
      actor: 'overview-test',
    });
    const complete = store.createProject({
      workspaceId: 'mixed',
      slug: 'complete',
      title: 'Duplicate',
      prd: '',
      state: 'ready',
      actor: 'overview-test',
    });
    store.startWork({
      targetType: 'project',
      targetId: complete.id,
      agentId: 'completion-agent',
      leaseSeconds: 1_800,
    });
    store.completeWork({
      targetType: 'project',
      targetId: complete.id,
      agentId: 'completion-agent',
      expectedRevision: complete.revision,
      summary: 'Complete payload excluded',
      artifacts: [{ label: 'secret', uri: 'file:///secret-artifact' }],
    });

    database
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run('2026-08-26T00:05:00.000Z', activeTaskProject.id);
    database
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run('2026-08-26T00:04:00.000Z', activeProject.id);
    database
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run('2026-08-26T00:03:00.000Z', available.id);
    database
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run('2026-08-26T00:02:00.000Z', draft.id);
    database
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run('2026-08-26T00:01:00.000Z', complete.id);
    database
      .prepare(
        "UPDATE claims SET updated_at = '2026-08-26T00:05:00.000Z' WHERE target_type = 'task'",
      )
      .run();
    database
      .prepare(
        "UPDATE claims SET updated_at = '2026-08-26T00:04:00.000Z' WHERE target_type = 'project'",
      )
      .run();

    const result = store.getOverview();

    expect(result.status).toBe('active');
    expect(result.counts).toEqual({
      workspaces: 1,
      projects: 5,
      draftProjects: 1,
      readyProjects: 3,
      completedProjects: 1,
      openTasks: 1,
      completedTasks: 0,
      activeClaims: 2,
      availableWork: 1,
    });
    expect(result.projects.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: activeTaskProject.id, status: 'active' },
      { id: activeProject.id, status: 'active' },
      { id: available.id, status: 'available' },
      { id: draft.id, status: 'draft' },
      { id: complete.id, status: 'complete' },
    ]);
    expect(result.activeWork).toEqual([
      expect.objectContaining({
        targetType: 'task',
        targetId: activeTask.id,
        taskId: activeTask.id,
        taskTitle: 'Claimed leaf',
        agentId: 'task-agent',
      }),
      expect.objectContaining({
        targetType: 'project',
        targetId: activeProject.id,
        taskId: null,
        taskTitle: null,
        agentId: 'project-agent',
      }),
    ]);
    expect(result.projectsTruncated).toBe(false);
    expect(result.activeWorkTruncated).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/Private|secret-artifact|Complete payload/);
  });

  it('retains global counts while bounding 501 projects', () => {
    const { database, store } = fixture('projects-bound');
    database.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        insertProject(database, {
          id: `project-${String(index).padStart(3, '0')}`,
          workspaceId: 'projects-bound',
          state: 'draft',
          updatedAt: '2026-08-26T00:00:00.000Z',
        });
      }
    })();

    const result = store.getOverview();
    expect(result.counts.projects).toBe(501);
    expect(result.projects).toHaveLength(500);
    expect(result.projects[0]?.id).toBe('project-000');
    expect(result.projects[499]?.id).toBe('project-499');
    expect(result.projectsTruncated).toBe(true);
  });

  it('retains global counts while bounding 501 active claims', () => {
    const { database, store } = fixture('claims-bound');
    insertProject(database, {
      id: 'claimed-project',
      workspaceId: 'claims-bound',
      state: 'ready',
      updatedAt: '2026-08-26T00:00:00.000Z',
    });
    database.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        const id = `claimed-task-${String(index).padStart(3, '0')}`;
        insertTask(database, {
          id,
          projectId: 'claimed-project',
          title: `Claimed task ${index}`,
          timestamp: '2026-08-26T00:00:00.000Z',
        });
        database
          .prepare(
            `INSERT INTO claims
               (target_type, target_id, agent_id, expires_at, created_at, updated_at)
             VALUES ('task', ?, ?, '2999-01-01T00:00:00.000Z', ?, ?)`,
          )
          .run(id, `agent-${index}`, '2026-08-26T00:00:00.000Z', id);
      }
    })();

    const result = store.getOverview();
    expect(result.counts.activeClaims).toBe(501);
    expect(result.projects[0]).toMatchObject({
      id: 'claimed-project',
      activeClaimCount: 501,
      status: 'active',
    });
    expect(result.activeWork).toHaveLength(500);
    expect(result.activeWorkTruncated).toBe(true);
  });

  it('matches listWork before and after a claim expires', () => {
    const { database, store } = fixture('expiry');
    const directProject = store.createProject({
      workspaceId: 'expiry',
      slug: 'direct',
      title: 'Direct',
      prd: '',
      state: 'ready',
      actor: 'overview-test',
    });
    const taskProject = store.createProject({
      workspaceId: 'expiry',
      slug: 'task',
      title: 'Task project',
      prd: '',
      state: 'ready',
      actor: 'overview-test',
    });
    store.createTask({
      projectId: taskProject.id,
      parentId: null,
      title: 'Leaf',
      body: null,
      actor: 'overview-test',
    });

    expect(store.getOverview().counts.availableWork).toBe(
      store.listWork({ workspaceId: null, limit: 10 }).length,
    );
    store.startWork({
      targetType: 'project',
      targetId: directProject.id,
      agentId: 'expiring-agent',
      leaseSeconds: 1_800,
    });
    expect(store.getOverview()).toMatchObject({
      status: 'active',
      counts: { activeClaims: 1, availableWork: 1 },
      activeWork: [expect.objectContaining({ targetId: directProject.id })],
    });

    database.prepare("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const expired = store.getOverview();
    expect(expired.counts.activeClaims).toBe(0);
    expect(expired.activeWork).toEqual([]);
    expect(expired.counts.availableWork).toBe(
      store.listWork({ workspaceId: null, limit: 10 }).length,
    );
    expect(expired.projects.find(({ id }) => id === taskProject.id)).toMatchObject({
      availableWorkCount: 1,
    });
  });

  it('agrees with listWork for 500 projects and 5,000 tasks', () => {
    const { database, store } = fixture('performance');
    database.transaction(() => {
      for (let projectIndex = 0; projectIndex < 500; projectIndex += 1) {
        const projectId = `scale-project-${String(projectIndex).padStart(3, '0')}`;
        insertProject(database, {
          id: projectId,
          workspaceId: 'performance',
          state: 'ready',
          updatedAt: '2026-08-26T00:00:00.000Z',
        });
        for (let taskIndex = 0; taskIndex < 10; taskIndex += 1) {
          insertTask(database, {
            id: `${projectId}-task-${taskIndex}`,
            projectId,
            title: `Task ${taskIndex}`,
            timestamp: '2026-08-26T00:00:00.000Z',
          });
        }
      }
    })();

    const result = store.getOverview();
    const listed = store.listWork({ workspaceId: null, limit: 10_000 });
    expect(result.counts).toMatchObject({
      projects: 500,
      openTasks: 5_000,
      availableWork: 5_000,
    });
    expect(result.counts.availableWork).toBe(listed.length);
    expect(result.projects).toHaveLength(500);
    expect(result.projectsTruncated).toBe(false);
  });

  it('uses one transaction and never selects heavy or wildcard columns', () => {
    const { database, store } = fixture('query');
    store.createProject({
      workspaceId: 'query',
      slug: 'hidden',
      title: 'Visible',
      prd: 'overview-query-secret',
      state: 'draft',
      actor: 'overview-test',
    });
    const queries: string[] = [];
    const prepare = database.prepare.bind(database);
    const transactionSpy = vi.spyOn(database, 'transaction');
    vi.spyOn(database, 'prepare').mockImplementation(((sql: string) => {
      queries.push(sql);
      return prepare(sql);
    }) as typeof database.prepare);

    const result = store.getOverview();
    const sql = queries.join('\n').toLowerCase();
    expect(transactionSpy).toHaveBeenCalledOnce();
    expect(sql).not.toMatch(/select\s+(?:\w+\.)?\*/);
    expect(sql).not.toMatch(/\bprd\b|\bbody\b|completion_summary|artifacts_json/);
    expect(JSON.stringify(result)).not.toContain('overview-query-secret');
  });
});
