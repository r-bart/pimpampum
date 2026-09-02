// The declarative seed table: the CLI calls that give the popout one active and one completed
// project. `check-quattro-evidence.mjs` replays the same labels and argument shapes, so a step
// added here needs the matching expectation there.

import { dirname, resolve } from 'node:path';
import { parseCliEnvelope } from '../lib/cliEnvelope.mjs';

/**
 * Each step: `label` is the transcript label; `arguments(values)` builds the CLI arguments from the
 * payloads of earlier steps; `parseLabel` names a step whose stdout must be a valid envelope, and
 * `store` keeps that payload under `values` for later steps.
 */
export const SEED_STEPS = Object.freeze([
  {
    label: 'seed-workspace',
    arguments: (values) => ['workspace:add', 'live', 'Pimpampum', values.workspace],
  },
  {
    label: 'seed-project',
    parseLabel: 'active project creation',
    store: 'activeProject',
    arguments: () => ['project:create', 'live', 'omarchy-plugin', 'Omarchy plugin'],
  },
  {
    label: 'seed-active-spec',
    parseLabel: 'active Spec creation',
    store: 'activeSpec',
    arguments: (values) => [
      'spec:create',
      String(values.activeProject.id),
      'widget-v1',
      'Widget V1',
      values.specBodyPath,
    ],
  },
  {
    label: 'ready-active-spec',
    parseLabel: 'active Spec ready',
    arguments: (values) => [
      'spec:ready',
      String(values.activeSpec.id),
      String(values.activeSpec.revision),
    ],
  },
  {
    label: 'open-active-project',
    parseLabel: 'active project open',
    arguments: (values) => [
      'project:open',
      String(values.activeProject.id),
      String(values.activeProject.revision),
    ],
  },
  {
    label: 'seed-task',
    parseLabel: 'task creation',
    store: 'task',
    arguments: (values) => ['task:create', String(values.activeSpec.id), 'Polish widget design'],
  },
  {
    label: 'seed-claim',
    arguments: (values) => ['work:start', 'task', String(values.task.id), 'live-agent'],
  },
  {
    label: 'seed-completed-project',
    parseLabel: 'completed project creation',
    store: 'completeProject',
    arguments: () => ['project:create', 'live', 'completed', 'Completed'],
  },
  {
    label: 'seed-completed-spec',
    parseLabel: 'completed Spec creation',
    store: 'completeSpec',
    arguments: (values) => [
      'spec:create',
      String(values.completeProject.id),
      'completed-spec',
      'Completed Spec',
      values.specBodyPath,
    ],
  },
  {
    label: 'ready-completed-spec',
    parseLabel: 'completed Spec ready',
    store: 'completeReady',
    arguments: (values) => [
      'spec:ready',
      String(values.completeSpec.id),
      String(values.completeSpec.revision),
    ],
  },
  {
    label: 'open-completed-project',
    parseLabel: 'completed project open',
    store: 'completeOpen',
    arguments: (values) => [
      'project:open',
      String(values.completeProject.id),
      String(values.completeProject.revision),
    ],
  },
  {
    label: 'start-completed-spec',
    parseLabel: 'completed Spec claim',
    store: 'completeClaim',
    arguments: (values) => [
      'work:start',
      'spec',
      String(values.completeSpec.id),
      'completion-agent',
    ],
  },
  {
    label: 'complete-spec',
    arguments: (values) => [
      'work:complete',
      'spec',
      String(values.completeSpec.id),
      'completion-agent',
      String(
        values.completeClaim.spec?.revision ??
          values.completeClaim.revision ??
          values.completeReady.revision,
      ),
      'Complete',
    ],
  },
  {
    label: 'complete-project',
    arguments: (values) => [
      'project:complete',
      String(values.completeProject.id),
      String(values.completeOpen.revision),
      'Complete',
    ],
  },
]);

/** Runs every seed step through the session, then proves the overview shows both statuses. */
export async function seedPortfolio(session) {
  const values = {
    workspace: session.target.workspace,
    specBodyPath: resolve(dirname(session.activeCliPath), '..', 'README.md'),
  };
  for (const step of SEED_STEPS) {
    const entry = await session.cli(step.label, step.arguments(values));
    if (!step.parseLabel) continue;
    const data = parseCliEnvelope(entry.stdout, step.parseLabel);
    if (step.store) values[step.store] = data;
  }
  const overview = await session.cliData('overview-active-and-complete', ['overview'], 'overview');
  if (
    !Array.isArray(overview.projects) ||
    !overview.projects.some((project) => project?.status === 'active') ||
    !overview.projects.some((project) => project?.status === 'complete')
  ) {
    throw new Error('Seeded overview did not contain active and completed projects');
  }
}
