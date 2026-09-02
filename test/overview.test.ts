import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { statusForOverview } from '../src/overview.js';
import { parseOverview } from '../src/overviewContract.js';
import { PimpampumStore } from '../src/store.js';
import type { Project, Spec } from '../src/types.js';

describe('overview v2', () => {
  let database: Database.Database;
  let store: PimpampumStore;
  let directory: string;
  let sequence: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-v2-'));
    database = openDatabase(':memory:');
    store = new PimpampumStore(database);
    store.registerWorkspace({
      id: 'workspace',
      name: 'Workspace',
      rootPath: directory,
      actor: null,
    });
    sequence = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function project(): Project {
    sequence++;
    return store.createProject({
      workspaceId: 'workspace',
      slug: `project-${sequence}`,
      title: `Project ${sequence}`,
      actor: null,
    });
  }

  function ready(project: Project): { project: Project; spec: Spec } {
    let spec = store.createSpec({
      projectId: project.id,
      slug: 'primary',
      title: 'Primary',
      body: '# Primary',
      actor: null,
    });
    spec = store.updateSpec({
      specId: spec.id,
      title: null,
      body: null,
      state: 'ready',
      expectedRevision: spec.revision,
      actor: null,
    });
    project = store.updateProject({
      projectId: project.id,
      title: null,
      state: 'open',
      expectedRevision: project.revision,
      actor: null,
    });
    return { project, spec };
  }

  it('reports an empty portfolio with schema-v2 counters', () => {
    expect(store.getOverview()).toMatchObject({
      status: 'empty',
      counts: {
        workspaces: 1,
        projects: 0,
        specs: 0,
        activeClaims: 0,
        availableWork: 0,
      },
      projects: [],
      specs: [],
      activeWork: [],
    });
  });

  it('rejects malformed overview values and falls back for inconsistent aggregate counts', () => {
    expect(() => parseOverview({ status: 'empty' })).toThrow(
      'Pimpampum returned an invalid overview',
    );
    expect(
      statusForOverview({
        projects: 2,
        draftProjects: 0,
        openProjects: 0,
        pausedProjects: 0,
        completedProjects: 1,
        cancelledProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('draft');
  });

  it('derives draft, available, paused and active status from lifecycle plus Claims', () => {
    const draft = project();
    const executable = ready(project());
    let overview = store.getOverview();
    expect(overview.status).toBe('available');
    expect(overview.counts).toMatchObject({
      projects: 2,
      specs: 1,
      draftProjects: 1,
      openProjects: 1,
      availableWork: 1,
    });
    expect(overview.projects.map((item) => item.status)).toEqual(['available', 'draft']);
    expect(overview.specs).toContainEqual(
      expect.objectContaining({
        id: executable.spec.id,
        projectTitle: executable.project.title,
        lifecycleState: 'ready',
        taskCount: 0,
        activeClaimCount: 0,
      }),
    );

    const bundle = store.startWork({
      targetType: 'spec',
      targetId: executable.spec.id,
      agentId: 'overview-agent',
      leaseSeconds: 600,
    });
    expect(bundle.project.id).toBe(executable.project.id);
    overview = store.getOverview();
    expect(overview.status).toBe('active');
    expect(overview.activeWork).toContainEqual(
      expect.objectContaining({
        targetType: 'spec',
        specId: executable.spec.id,
        projectId: executable.project.id,
        agentId: 'overview-agent',
      }),
    );

    store.releaseWork({
      targetType: 'spec',
      targetId: executable.spec.id,
      agentId: 'overview-agent',
      note: null,
    });
    const paused = store.updateProject({
      projectId: executable.project.id,
      title: null,
      state: 'paused',
      expectedRevision: executable.project.revision,
      actor: null,
    });
    overview = store.getOverview();
    expect(overview.projects.find((item) => item.id === paused.id)?.status).toBe('paused');
    expect(overview.projects.find((item) => item.id === draft.id)?.status).toBe('draft');
  });

  it('aggregates Specs, Tasks and Claims into their visible Project row', () => {
    const executable = ready(project());
    const parent = store.createTask({
      specId: executable.spec.id,
      parentId: null,
      title: 'Parent',
      body: null,
      actor: null,
    });
    const child = store.createTask({
      specId: executable.spec.id,
      parentId: parent.id,
      title: 'Child',
      body: null,
      actor: null,
    });
    let overview = store.getOverview();
    expect(overview.projects[0]).toMatchObject({
      id: executable.project.id,
      specCount: 1,
      openTaskCount: 2,
      activeClaimCount: 0,
      availableWorkCount: 1,
    });
    store.startWork({
      targetType: 'task',
      targetId: child.id,
      agentId: 'task-agent',
      leaseSeconds: 600,
    });
    overview = store.getOverview();
    expect(overview.counts).toMatchObject({ openTasks: 2, activeClaims: 1, availableWork: 0 });
    expect(overview.projects[0]).toMatchObject({ status: 'active', activeClaimCount: 1 });
    expect(overview.activeWork[0]).toMatchObject({
      targetType: 'task',
      taskId: child.id,
      specId: executable.spec.id,
      projectId: executable.project.id,
    });
    expect(overview.specs[0]).toMatchObject({
      id: executable.spec.id,
      taskCount: 2,
      openTaskCount: 2,
      completedTaskCount: 0,
      activeClaimCount: 1,
    });
  });

  it('treats done and cancelled Projects as terminal completion', () => {
    let done = ready(project());
    store.startWork({
      targetType: 'spec',
      targetId: done.spec.id,
      agentId: 'agent',
      leaseSeconds: 60,
    });
    done.spec = store.completeWork({
      targetType: 'spec',
      targetId: done.spec.id,
      agentId: 'agent',
      expectedRevision: done.spec.revision,
      summary: 'done',
      artifacts: [],
    }) as Spec;
    done.project = store.completeProject({
      projectId: done.project.id,
      expectedRevision: done.project.revision,
      summary: 'done',
      artifacts: [],
      actor: null,
    });
    const cancelled = project();
    store.cancelProject({
      projectId: cancelled.id,
      expectedRevision: cancelled.revision,
      reason: 'stop',
      actor: null,
    });
    const overview = store.getOverview();
    expect(overview.status).toBe('complete');
    expect(overview.counts).toMatchObject({ completedProjects: 1, cancelledProjects: 1 });
    expect(overview.projects.every((item) => item.status === 'complete')).toBe(true);
  });

  it('ranks more than 500 Projects in SQL and truncates after the precedence order', () => {
    const oldest = project();
    for (let index = 0; index < 500; index += 1) project();
    // The oldest row would fall off a recency-only cut; precedence keeps it first.
    ready(oldest);
    const result = store.getOverview();
    expect(result.counts.projects).toBe(501);
    expect(result.projects).toHaveLength(500);
    expect(result.projectsTruncated).toBe(true);
    expect(result.projects[0]).toMatchObject({ id: oldest.id, status: 'available' });
    expect(result.projects.slice(1).every((item) => item.status === 'draft')).toBe(true);
    const updatedAts = result.projects.slice(1).map((item) => item.updatedAt);
    expect([...updatedAts].sort().reverse()).toEqual(updatedAts);
  });
});
