import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../src/db.js';
import { PimpampumStore } from '../src/store.js';

const directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-benchmark-'));
const database = openDatabase(':memory:');
const store = new PimpampumStore(database);

try {
  store.registerWorkspace({
    id: 'benchmark',
    name: 'Benchmark',
    rootPath: directory,
    actor: 'benchmark',
  });
  const insertProject = database.prepare(
    `INSERT INTO projects
       (id, workspace_id, slug, title, state, prd, created_at, updated_at)
     VALUES (?, 'benchmark', ?, ?, 'ready', ?, ?, ?)`,
  );
  const insertTask = database.prepare(
    `INSERT INTO tasks
       (id, project_id, parent_id, title, body, state, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'open', ?, ?)`,
  );
  database.transaction(() => {
    for (let projectIndex = 0; projectIndex < 500; projectIndex += 1) {
      const projectId = `project-${String(projectIndex).padStart(3, '0')}`;
      const timestamp = '2026-08-26T00:00:00.000Z';
      insertProject.run(
        projectId,
        projectId,
        `Project ${projectIndex}`,
        '# Benchmark PRD body excluded from overview',
        timestamp,
        timestamp,
      );
      for (let taskIndex = 0; taskIndex < 10; taskIndex += 1) {
        insertTask.run(
          `${projectId}-task-${taskIndex}`,
          projectId,
          `Task ${taskIndex}`,
          'Benchmark task body excluded from overview',
          timestamp,
          timestamp,
        );
      }
    }
  })();

  store.getOverview();
  const samples = Array.from({ length: 5 }, () => {
    const started = performance.now();
    const overview = store.getOverview();
    const durationMilliseconds = performance.now() - started;
    if (overview.counts.projects !== 500 || overview.counts.availableWork !== 5_000) {
      throw new Error('Benchmark fixture produced incorrect overview counts');
    }
    return durationMilliseconds;
  }).sort((left, right) => left - right);
  const listed = store.listWork({ workspaceId: null, limit: 10_000 });

  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: { projects: 500, tasks: 5_000 },
        availableWork: listed.length,
        samplesMilliseconds: samples.map((sample) => Number(sample.toFixed(3))),
        minMilliseconds: Number((samples[0] ?? 0).toFixed(3)),
        medianMilliseconds: Number((samples[2] ?? 0).toFixed(3)),
        maxMilliseconds: Number((samples[4] ?? 0).toFixed(3)),
        thresholdEnforced: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
