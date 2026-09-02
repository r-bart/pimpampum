import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { RuntimeConfig } from '../../../src/config.js';
import { openDatabase } from '../../../src/db.js';
import { createHttpApp } from '../../../src/http.js';
import { PimpampumStore } from '../../../src/store.js';

/**
 * The producer behind `test/fixtures/overview/{empty,mixed,complete}.json`. Each scenario is built
 * in a real `PimpampumStore` and served through the real `createHttpApp`, so the fixture is what
 * `GET /api/v1/overview` returns for that data. `scripts/regenerate-fixtures.mjs` writes the files
 * from here; `test/overview-fixtures.test.ts` regenerates them and compares. `invalid.json` is
 * hand-written on purpose: it is the payload the consumers must reject.
 *
 * Normalisation keeps the fixture deterministic without hiding the producer: generated ids become
 * the stable names the consumers assert on, the workspace root becomes an `/Users/example` path,
 * and `daemon.version` becomes `1.0.0` so a release bump does not rewrite the contract. Every
 * timestamp is real — the store and the HTTP app run on an injected clock.
 */

export const OVERVIEW_SCENARIOS = ['empty', 'mixed', 'complete'] as const;
export type OverviewScenario = (typeof OVERVIEW_SCENARIOS)[number];

const token = 'overview-fixture-token-0000000000000000000000';
const daemonStartedAt = Date.parse('2026-08-26T20:00:00.000Z');
const generatedAt: Record<OverviewScenario, string> = {
  empty: '2026-08-26T20:00:30.000Z',
  mixed: '2026-08-26T20:01:30.000Z',
  complete: '2026-08-26T20:02:00.000Z',
};

interface Scene {
  store: PimpampumStore;
  /** Moves the injected clock to `iso`; every mutation after it is stamped with that instant. */
  at(iso: string): void;
  /** Registers a workspace whose real temporary root is reported as `/Users/example/<name>`. */
  workspace(id: string, name: string): void;
  /** Records a generated id under the stable name the fixture uses. */
  name(id: string, stable: string): void;
}

function config(dataDirectory: string): RuntimeConfig {
  return {
    host: '127.0.0.1',
    port: 7337,
    dataDirectory,
    databasePath: ':memory:',
    token,
    baseUrl: 'http://127.0.0.1:7337',
  };
}

function slugId(prefix: string, title: string): string {
  return `${prefix}-${title.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`;
}

function buildMixed(scene: Scene): void {
  const { store } = scene;
  scene.at('2026-08-26T20:00:00.000Z');
  scene.workspace('projects', '100 Projects');

  const projects = new Map<string, { id: string; revision: number }>();
  let second = 1;
  const tick = () => {
    scene.at(`2026-08-26T20:00:${String(second).padStart(2, '0')}.000Z`);
    second += 1;
  };
  const project = (slug: string, title: string) => {
    tick();
    const created = store.createProject({ workspaceId: 'projects', slug, title, actor: 'fixture' });
    scene.name(created.id, `project-${slug}`);
    projects.set(slug, created);
  };
  const readySpec = (projectSlug: string, slug: string, title: string) => {
    tick();
    const projectId = projects.get(projectSlug)!.id;
    const created = store.createSpec({
      projectId,
      slug,
      title,
      body: `# ${title}`,
      actor: 'fixture',
    });
    scene.name(created.id, `spec-${slug}`);
    tick();
    return store.updateSpec({
      specId: created.id,
      title: null,
      body: null,
      state: 'ready',
      expectedRevision: created.revision,
      actor: 'fixture',
    });
  };
  const openProject = (slug: string) => {
    tick();
    const current = projects.get(slug)!;
    projects.set(
      slug,
      store.updateProject({
        projectId: current.id,
        title: null,
        state: 'open',
        expectedRevision: current.revision,
        actor: 'fixture',
      }),
    );
  };
  const task = (specId: string, title: string, stable = slugId('task', title)) => {
    tick();
    const created = store.createTask({
      specId,
      parentId: null,
      title,
      body: null,
      actor: 'fixture',
    });
    scene.name(created.id, stable);
    return created;
  };
  const finishTask = (taskId: string, revision: number, agentId: string) => {
    tick();
    store.startWork({ targetType: 'task', targetId: taskId, agentId, leaseSeconds: 600 });
    tick();
    store.completeWork({
      targetType: 'task',
      targetId: taskId,
      agentId,
      expectedRevision: revision,
      summary: 'Done.',
      artifacts: [],
    });
  };

  // Six projects, one per overview status; the draft and cancelled ones never receive a Spec.
  project('active', 'Active project');
  project('available', 'Available project');
  project('draft', 'Draft project');
  project('paused', 'Paused project');
  project('complete', 'Completed project');
  project('cancelled', 'Cancelled project');

  // Cancelled project: cancelled from draft, before the completed one so that the overview lists
  // the two `complete` rows most recent first: done, then cancelled.
  tick();
  const cancelled = projects.get('cancelled')!;
  store.cancelProject({
    projectId: cancelled.id,
    expectedRevision: cancelled.revision,
    reason: 'Superseded.',
    actor: 'fixture',
  });

  // Completed project: one done Spec with two done Tasks, then the Project is completed.
  const onboarding = readySpec('complete', 'onboarding', 'First-run onboarding');
  openProject('complete');
  for (const title of ['Welcome screen', 'Consent list']) {
    const created = task(onboarding.id, title);
    finishTask(created.id, created.revision, 'codex-onboarding');
  }
  tick();
  store.startWork({
    targetType: 'spec',
    targetId: onboarding.id,
    agentId: 'codex-onboarding',
    leaseSeconds: 600,
  });
  tick();
  store.completeWork({
    targetType: 'spec',
    targetId: onboarding.id,
    agentId: 'codex-onboarding',
    expectedRevision: onboarding.revision,
    summary: 'Shipped.',
    artifacts: [],
  });
  tick();
  const complete = projects.get('complete')!;
  store.completeProject({
    projectId: complete.id,
    expectedRevision: complete.revision,
    summary: 'Onboarding shipped.',
    artifacts: [],
    actor: 'fixture',
  });

  // Paused project: a ready Spec, opened and then paused.
  readySpec('paused', 'rollout', 'Paused rollout');
  openProject('paused');
  tick();
  const paused = projects.get('paused')!;
  store.updateProject({
    projectId: paused.id,
    title: null,
    state: 'paused',
    expectedRevision: paused.revision,
    actor: 'fixture',
  });

  // Active project, first half: a Spec with no Tasks that an agent claims directly.
  const release = readySpec('active', 'release-integration', 'Release integration');
  openProject('active');

  // Available project: a ready Spec whose four Tasks are all unclaimed.
  const sync = readySpec('available', 'sync', 'Cross-device synchronization');
  openProject('available');
  for (const title of ['Snapshot format', 'Conflict ledger', 'Device identity', 'Folder picker']) {
    task(sync.id, title);
  }

  // Active project, second half: the most recently readied Spec, with two done and three open
  // Tasks, two of them claimed below.
  const widget = readySpec('active', 'widget-v1', 'Widget V1');
  for (const title of ['Design tokens', 'Write tests']) {
    const created = task(widget.id, title);
    finishTask(created.id, created.revision, 'codex-build');
  }
  task(widget.id, 'Ship docs');
  const review = task(widget.id, 'Review copy');
  const current = task(widget.id, 'Current work', 'task-active');

  // Three live Claims, oldest first; the overview lists them newest first.
  scene.at('2026-08-26T20:00:50.000Z');
  store.startWork({
    targetType: 'spec',
    targetId: release.id,
    agentId: 'codex-spec',
    leaseSeconds: 1_200,
  });
  scene.at('2026-08-26T20:00:55.000Z');
  store.startWork({
    targetType: 'task',
    targetId: review.id,
    agentId: 'codex-review',
    leaseSeconds: 1_800,
  });
  scene.at('2026-08-26T20:01:00.000Z');
  store.startWork({
    targetType: 'task',
    targetId: current.id,
    agentId: 'codex-task',
    leaseSeconds: 1_800,
  });
}

function buildComplete(scene: Scene): void {
  const { store } = scene;
  scene.at('2026-08-26T20:00:00.000Z');
  scene.workspace('finished', 'Finished');
  scene.at('2026-08-26T20:00:10.000Z');
  const project = store.createProject({
    workspaceId: 'finished',
    slug: 'complete',
    title: 'Completed project',
    actor: 'fixture',
  });
  scene.name(project.id, 'complete-project');
  scene.at('2026-08-26T20:00:20.000Z');
  const spec = store.createSpec({
    projectId: project.id,
    slug: 'shipped-v1',
    title: 'Ship V1',
    body: '# Ship V1',
    actor: 'fixture',
  });
  scene.name(spec.id, 'complete-spec');
  scene.at('2026-08-26T20:00:25.000Z');
  const ready = store.updateSpec({
    specId: spec.id,
    title: null,
    body: null,
    state: 'ready',
    expectedRevision: spec.revision,
    actor: 'fixture',
  });
  scene.at('2026-08-26T20:00:30.000Z');
  const open = store.updateProject({
    projectId: project.id,
    title: null,
    state: 'open',
    expectedRevision: project.revision,
    actor: 'fixture',
  });
  scene.at('2026-08-26T20:00:35.000Z');
  const task = store.createTask({
    specId: spec.id,
    parentId: null,
    title: 'Ship',
    body: null,
    actor: 'fixture',
  });
  scene.name(task.id, 'complete-task');
  scene.at('2026-08-26T20:00:40.000Z');
  store.startWork({
    targetType: 'task',
    targetId: task.id,
    agentId: 'codex-ship',
    leaseSeconds: 600,
  });
  scene.at('2026-08-26T20:00:45.000Z');
  store.completeWork({
    targetType: 'task',
    targetId: task.id,
    agentId: 'codex-ship',
    expectedRevision: task.revision,
    summary: 'Shipped.',
    artifacts: [],
  });
  scene.at('2026-08-26T20:00:50.000Z');
  store.startWork({
    targetType: 'spec',
    targetId: spec.id,
    agentId: 'codex-ship',
    leaseSeconds: 600,
  });
  scene.at('2026-08-26T20:00:55.000Z');
  store.completeWork({
    targetType: 'spec',
    targetId: spec.id,
    agentId: 'codex-ship',
    expectedRevision: ready.revision,
    summary: 'V1 shipped.',
    artifacts: [],
  });
  scene.at('2026-08-26T20:01:00.000Z');
  store.completeProject({
    projectId: project.id,
    expectedRevision: open.revision,
    summary: 'Everything shipped.',
    artifacts: [],
    actor: 'fixture',
  });
}

const builders: Record<OverviewScenario, (scene: Scene) => void> = {
  empty: () => undefined,
  mixed: buildMixed,
  complete: buildComplete,
};

/**
 * Builds `scenario` under `root` (a writable temporary directory), serves it through the HTTP app
 * and returns the normalised, formatted fixture text.
 */
export async function produceOverviewFixture(
  scenario: OverviewScenario,
  root: string,
): Promise<string> {
  const clock = { ms: daemonStartedAt };
  const store = new PimpampumStore(
    openDatabase(':memory:'),
    () => undefined,
    () => false,
    () => new Date(clock.ms),
  );
  const names = new Map<string, string>();
  const scene: Scene = {
    store,
    at: (iso) => {
      clock.ms = Date.parse(iso);
    },
    workspace: (id, name) => {
      const rootPath = join(root, name);
      mkdirSync(rootPath, { recursive: true });
      const registered = store.registerWorkspace({ id, name, rootPath, actor: 'fixture' });
      names.set(registered.rootPath, `/Users/example/${name}`);
    },
    name: (id, stable) => {
      names.set(id, stable);
    },
  };
  const composition = createHttpApp(
    store,
    config(root),
    { error: () => undefined },
    () => clock.ms,
  );
  try {
    builders[scenario](scene);
    clock.ms = Date.parse(generatedAt[scenario]);
    const response = await request(composition.app)
      .get('/api/v1/overview')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    const body = response.body as { meta: unknown; data: { daemon: { version: string } } };
    body.data.daemon.version = '1.0.0';
    let text = JSON.stringify(body, null, 2);
    for (const [real, stable] of names) text = text.split(real).join(stable);
    return `${text}\n`;
  } finally {
    await composition.close();
    store.close();
  }
}
