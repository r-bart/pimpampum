import { isTerminalSpecState, isTerminalTaskState } from './domainRules.js';
import { AppError } from './errors.js';
import { slugSchema } from './schemas.js';
import type { SyncState } from './syncContract.js';

/**
 * Domain validation of a shared snapshot before any database transaction
 * begins. The contract schema already checked shapes; this re-checks the
 * invariants the store enforces on every write, because a snapshot written by
 * another device bypasses those writes. Pure: no clock, no connection.
 */

type SyncProject = SyncState['projects'][number];
type SyncSpec = SyncState['specs'][number];
type SyncTask = SyncState['tasks'][number];

interface Completable {
  completionSummary: string | null;
  artifacts: unknown[];
  completedAt: string | null;
}

interface SyncIdentity {
  workspaceIds: Set<string>;
  projectIds: Set<string>;
  specIds: Set<string>;
  taskIds: Set<string>;
}

function fail(message: string): never {
  throw new AppError('bad_request', `Shared snapshot is invalid: ${message}`, 400);
}

function unique<T>(items: T[], key: (item: T) => string, label: string): Set<string> {
  const values = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (values.has(value)) fail(`duplicate ${label} ${value}`);
    values.add(value);
  }
  return values;
}

function groupBy<K, V>(keys: K[], items: V[], keyOf: (item: V) => K): Map<K, V[]> {
  const groups = new Map(keys.map((key) => [key, [] as V[]]));
  for (const item of items) groups.get(keyOf(item))!.push(item);
  return groups;
}

function hasCompletion(entity: Completable): boolean {
  return (
    entity.completionSummary !== null || entity.artifacts.length > 0 || entity.completedAt !== null
  );
}

function assertCompletion(entity: Completable, stateValue: string, label: string): void {
  if (stateValue === 'done') {
    if (entity.completionSummary === null || entity.completedAt === null) {
      fail(`${label} is done without completion metadata`);
    }
  } else if (hasCompletion(entity)) {
    fail(`${label} has completion metadata while ${stateValue}`);
  }
}

/** Ids and natural keys are unique, and every Context name is a slug. */
function assertIdentity(state: SyncState): SyncIdentity {
  const workspaceIds = unique(state.workspaces, (item) => item.id, 'Workspace ID');
  const projectIds = unique(state.projects, (item) => item.id, 'Project ID');
  const specIds = unique(state.specs, (item) => item.id, 'Spec ID');
  const taskIds = unique(state.tasks, (item) => item.id, 'Task ID');
  unique(state.contexts, (item) => item.id, 'Context ID');
  for (const context of state.contexts) {
    // The name becomes a file name in portable exports; the store is the last
    // guard when a caller bypasses the contract schema.
    if (!slugSchema.safeParse(context.name).success) {
      fail(`Context ${context.id} has a name that is not a slug`);
    }
  }
  unique(state.projects, (item) => `${item.workspaceId}:${item.slug}`, 'Project slug');
  unique(state.specs, (item) => `${item.projectId}:${item.slug}`, 'Spec slug');
  unique(
    state.contexts,
    (item) => `${item.ownerType}:${item.ownerId}:${item.name}`,
    'Context name',
  );
  return { workspaceIds, projectIds, specIds, taskIds };
}

/** Every entity names an owner in the snapshot; a Subtask hangs off a top-level Task of its Spec. */
function assertOwnership(state: SyncState, ids: SyncIdentity): void {
  for (const project of state.projects) {
    if (!ids.workspaceIds.has(project.workspaceId)) fail(`Project ${project.id} has no Workspace`);
  }
  for (const spec of state.specs) {
    if (!ids.projectIds.has(spec.projectId)) fail(`Spec ${spec.id} has no Project`);
  }
  for (const context of state.contexts) {
    const owners = context.ownerType === 'workspace' ? ids.workspaceIds : ids.projectIds;
    if (!owners.has(context.ownerId)) fail(`Context ${context.id} has no owner`);
  }
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  for (const task of state.tasks) {
    if (!ids.specIds.has(task.specId)) fail(`Task ${task.id} has no Spec`);
    if (task.parentId === null) continue;
    if (!ids.taskIds.has(task.parentId)) fail(`Task ${task.id} has no parent`);
    const parent = tasks.get(task.parentId);
    if (!parent || parent.specId !== task.specId || parent.parentId !== null) {
      fail(`Task ${task.id} has an invalid parent`);
    }
  }
}

function assertProjects(projects: SyncProject[], specsByProject: Map<string, SyncSpec[]>): void {
  for (const project of projects) {
    const specs = specsByProject.get(project.id)!;
    if (project.state === 'open' && specs.length === 0) {
      fail(`Project ${project.id} is open without a Spec`);
    }
    if (
      project.state === 'done' &&
      (specs.length === 0 || specs.some((spec) => !isTerminalSpecState(spec.state)))
    ) {
      fail(`Project ${project.id} is done before every Spec is terminal`);
    }
    if (project.state === 'cancelled' && specs.some((spec) => !isTerminalSpecState(spec.state))) {
      fail(`Project ${project.id} is cancelled with a non-terminal Spec`);
    }
    assertCompletion(project, project.state, `Project ${project.id}`);
  }
}

function assertSpecs(specs: SyncSpec[], tasksBySpec: Map<string, SyncTask[]>): void {
  for (const spec of specs) {
    const specTasks = tasksBySpec.get(spec.id)!;
    if (spec.state === 'ready' && spec.body.trim().length === 0) {
      fail(`Spec ${spec.id} is ready without Markdown`);
    }
    if (
      isTerminalSpecState(spec.state) &&
      specTasks.some((task) => !isTerminalTaskState(task.state))
    ) {
      fail(`Spec ${spec.id} is terminal with a non-terminal Task`);
    }
    assertCompletion(spec, spec.state, `Spec ${spec.id}`);
  }
}

function assertTasks(tasks: SyncTask[]): void {
  const nonTerminalChildren = new Set<string>();
  for (const task of tasks) {
    if (task.parentId !== null && !isTerminalTaskState(task.state)) {
      nonTerminalChildren.add(task.parentId);
    }
  }
  for (const task of tasks) {
    if (isTerminalTaskState(task.state) && nonTerminalChildren.has(task.id)) {
      fail(`Task ${task.id} is terminal with a non-terminal Subtask`);
    }
    assertCompletion(task, task.state, `Task ${task.id}`);
  }
}

/** Lifecycle and completion invariants, checked after ownership so every lookup resolves. */
function assertLifecycle(state: SyncState): void {
  const specsByProject = groupBy(
    state.projects.map((project) => project.id),
    state.specs,
    (spec) => spec.projectId,
  );
  const tasksBySpec = groupBy(
    state.specs.map((spec) => spec.id),
    state.tasks,
    (task) => task.specId,
  );
  assertProjects(state.projects, specsByProject);
  assertSpecs(state.specs, tasksBySpec);
  assertTasks(state.tasks);
}

/** Throws `bad_request` ("Shared snapshot is invalid: …") on the first violated invariant. */
export function validateSyncState(state: SyncState): void {
  const ids = assertIdentity(state);
  assertOwnership(state, ids);
  assertLifecycle(state);
}
