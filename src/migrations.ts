import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { AppError } from './errors.js';

export const LATEST_SCHEMA_VERSION = 3;

/**
 * Schema v2 stored this prefix plus the Workspace id as the root of a Workspace imported through
 * synchronization without a local root. Schema v3 stores NULL instead; the overview still shows
 * the placeholder because the native surfaces reject an empty root.
 */
export const UNRESOLVED_WORKSPACE_ROOT_PREFIX = '/__pimpampum_unresolved__/';

/** `workspaces` as schema v3 creates it: `root_path` stays NULL until the user attaches a local root. */
function workspacesV3Table(name: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
}

/** Schema v2 verbatim; `migrateV1ToV2` still replays it and v3 rebuilds only `workspaces`. */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'open', 'paused', 'done', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  completion_summary TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS specs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'done', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  completion_summary TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS context_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (workspace_id IS NOT NULL AND project_id IS NULL) OR
    (workspace_id IS NULL AND project_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'done', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  completion_summary TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  target_type TEXT NOT NULL CHECK (target_type IN ('spec', 'task')),
  target_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  project_id TEXT,
  spec_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace_state
  ON projects(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_specs_project_state
  ON specs(project_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_workspace_name
  ON context_documents(workspace_id, name) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_project_name
  ON context_documents(project_id, name) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_spec_state
  ON tasks(spec_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_claims_expiry
  ON claims(expires_at);
CREATE INDEX IF NOT EXISTS idx_activity_workspace
  ON activity_events(workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_project
  ON activity_events(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_spec
  ON activity_events(spec_id, id DESC);
`;

type CountRow = { count: number };
type ProjectIdRow = { id: string };

function scalarCount(database: Database.Database, sql: string): number {
  return database.prepare<[], CountRow>(sql).get()?.count ?? 0;
}

function migratedSpecId(projectId: string): string {
  const digest = createHash('sha256')
    .update(`pimpampum:domain-model-v2:primary-spec:${projectId}`)
    .digest('hex');
  const hexadecimal = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17, 32)}`;
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20, 32),
  ].join('-');
}

function assertV1Ownership(database: Database.Database): void {
  const orphanedProjects = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM projects project
     LEFT JOIN workspaces workspace ON workspace.id = project.workspace_id
     WHERE workspace.id IS NULL`,
  );
  const orphanedTasks = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM tasks task
     LEFT JOIN projects project ON project.id = task.project_id
     WHERE project.id IS NULL`,
  );
  const orphanedContext = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM context_documents context
     LEFT JOIN projects project ON project.id = context.project_id
     WHERE project.id IS NULL`,
  );
  const invalidParents = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM tasks child
     LEFT JOIN tasks parent ON parent.id = child.parent_id
     WHERE child.parent_id IS NOT NULL
       AND (parent.id IS NULL OR parent.project_id <> child.project_id)`,
  );
  const thirdLevelTasks = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM tasks child
     JOIN tasks parent ON parent.id = child.parent_id
     WHERE parent.parent_id IS NOT NULL`,
  );
  const invalidClaims = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM claims claim
     LEFT JOIN projects project
       ON claim.target_type = 'project' AND project.id = claim.target_id
     LEFT JOIN tasks task
       ON claim.target_type = 'task' AND task.id = claim.target_id
     WHERE (claim.target_type = 'project' AND project.id IS NULL)
        OR (claim.target_type = 'task' AND task.id IS NULL)`,
  );

  if (
    orphanedProjects > 0 ||
    orphanedTasks > 0 ||
    orphanedContext > 0 ||
    invalidParents > 0 ||
    thirdLevelTasks > 0 ||
    invalidClaims > 0
  ) {
    throw new Error(
      'Domain Model v2 migration cannot continue because v1 contains invalid ownership or foreign references',
    );
  }
}

function validateMigratedData(
  database: Database.Database,
  expected: {
    projects: number;
    contextDocuments: number;
    tasks: number;
    claims: number;
    activityEvents: number;
  },
): void {
  const actual = {
    projects: scalarCount(database, 'SELECT COUNT(*) AS count FROM projects'),
    specs: scalarCount(database, 'SELECT COUNT(*) AS count FROM specs'),
    contextDocuments: scalarCount(database, 'SELECT COUNT(*) AS count FROM context_documents'),
    tasks: scalarCount(database, 'SELECT COUNT(*) AS count FROM tasks'),
    claims: scalarCount(database, 'SELECT COUNT(*) AS count FROM claims'),
    activityEvents: scalarCount(database, 'SELECT COUNT(*) AS count FROM activity_events'),
  };
  const invalidTaskOwners = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM tasks task
     JOIN tasks parent ON parent.id = task.parent_id
     WHERE parent.spec_id <> task.spec_id`,
  );
  const foreignKeyFailures = database.pragma('foreign_key_check') as unknown[];

  if (
    actual.projects !== expected.projects ||
    actual.specs !== expected.projects ||
    actual.contextDocuments !== expected.contextDocuments ||
    actual.tasks !== expected.tasks ||
    actual.claims !== expected.claims ||
    actual.activityEvents !== expected.activityEvents ||
    invalidTaskOwners > 0 ||
    foreignKeyFailures.length > 0
  ) {
    throw new Error('Domain Model v2 migration validation failed');
  }
}

/** Copies every v1 row into the v2 tables; each Project's PRD becomes its primary Spec. */
const V1_TO_V2_COPY_SQL = `
    INSERT INTO projects (
      id, workspace_id, slug, title, state, revision, completion_summary,
      artifacts_json, completed_at, cancelled_at, created_at, updated_at
    )
    SELECT
      id,
      workspace_id,
      slug,
      title,
      CASE state WHEN 'ready' THEN 'open' ELSE state END,
      revision,
      completion_summary,
      artifacts_json,
      completed_at,
      NULL,
      created_at,
      updated_at
    FROM projects_v1;

    INSERT INTO specs (
      id, project_id, slug, title, body, state, revision, completion_summary,
      artifacts_json, completed_at, cancelled_at, created_at, updated_at
    )
    SELECT
      migration_spec_map.spec_id,
      project.id,
      'primary',
      project.title,
      project.prd,
      project.state,
      project.revision,
      project.completion_summary,
      project.artifacts_json,
      project.completed_at,
      NULL,
      project.created_at,
      project.updated_at
    FROM projects_v1 project
    JOIN migration_spec_map ON migration_spec_map.project_id = project.id;

    INSERT INTO context_documents (
      id, workspace_id, project_id, name, body, revision, created_at, updated_at
    )
    SELECT id, NULL, project_id, name, body, revision, created_at, updated_at
    FROM context_documents_v1;

    INSERT INTO tasks (
      id, spec_id, parent_id, title, body, state, revision, completion_summary,
      artifacts_json, completed_at, cancelled_at, created_at, updated_at
    )
    SELECT
      task.id,
      migration_spec_map.spec_id,
      task.parent_id,
      task.title,
      task.body,
      task.state,
      task.revision,
      task.completion_summary,
      task.artifacts_json,
      task.completed_at,
      NULL,
      task.created_at,
      task.updated_at
    FROM tasks_v1 task
    JOIN migration_spec_map ON migration_spec_map.project_id = task.project_id;

    INSERT INTO claims (
      target_type, target_id, agent_id, expires_at, created_at, updated_at
    )
    SELECT
      CASE claim.target_type WHEN 'project' THEN 'spec' ELSE 'task' END,
      CASE
        WHEN claim.target_type = 'project' THEN migration_spec_map.spec_id
        ELSE claim.target_id
      END,
      claim.agent_id,
      claim.expires_at,
      claim.created_at,
      claim.updated_at
    FROM claims_v1 claim
    LEFT JOIN migration_spec_map
      ON claim.target_type = 'project' AND migration_spec_map.project_id = claim.target_id;

    INSERT INTO activity_events (
      id, workspace_id, project_id, spec_id, target_type, target_id,
      event_type, actor, data_json, created_at
    )
    SELECT
      event.id,
      event.workspace_id,
      event.project_id,
      CASE
        WHEN event.target_type = 'task' THEN task_map.spec_id
        WHEN event.target_type = 'project'
          AND (event.event_type = 'project.prd_updated' OR event.event_type LIKE 'work.%')
          THEN project_map.spec_id
        ELSE NULL
      END,
      CASE
        WHEN event.target_type = 'project'
          AND (event.event_type = 'project.prd_updated' OR event.event_type LIKE 'work.%')
          THEN 'spec'
        ELSE event.target_type
      END,
      CASE
        WHEN event.target_type = 'project'
          AND (event.event_type = 'project.prd_updated' OR event.event_type LIKE 'work.%')
          THEN project_map.spec_id
        ELSE event.target_id
      END,
      CASE
        WHEN event.event_type = 'project.prd_updated' THEN 'spec.body_updated'
        ELSE event.event_type
      END,
      event.actor,
      event.data_json,
      event.created_at
    FROM activity_events_v1 event
    LEFT JOIN migration_spec_map project_map ON project_map.project_id = event.target_id
    LEFT JOIN tasks_v1 old_task
      ON event.target_type = 'task' AND old_task.id = event.target_id
    LEFT JOIN migration_spec_map task_map ON task_map.project_id = old_task.project_id;
  `;

function migrateV1ToV2(database: Database.Database): void {
  assertV1Ownership(database);

  const expected = {
    projects: scalarCount(database, 'SELECT COUNT(*) AS count FROM projects'),
    contextDocuments: scalarCount(database, 'SELECT COUNT(*) AS count FROM context_documents'),
    tasks: scalarCount(database, 'SELECT COUNT(*) AS count FROM tasks'),
    claims: scalarCount(database, 'SELECT COUNT(*) AS count FROM claims'),
    activityEvents: scalarCount(database, 'SELECT COUNT(*) AS count FROM activity_events'),
  };

  database.exec(`
    ALTER TABLE projects RENAME TO projects_v1;
    ALTER TABLE context_documents RENAME TO context_documents_v1;
    ALTER TABLE tasks RENAME TO tasks_v1;
    ALTER TABLE claims RENAME TO claims_v1;
    ALTER TABLE activity_events RENAME TO activity_events_v1;
  `);

  database.exec(SCHEMA_V2);
  database.exec(`
    CREATE TEMP TABLE migration_spec_map (
      project_id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL UNIQUE
    );
  `);
  const insertMapping = database.prepare(
    'INSERT INTO migration_spec_map (project_id, spec_id) VALUES (?, ?)',
  );
  for (const project of database
    .prepare<[], ProjectIdRow>('SELECT id FROM projects_v1 ORDER BY id')
    .all()) {
    insertMapping.run(project.id, migratedSpecId(project.id));
  }

  database.exec(V1_TO_V2_COPY_SQL);

  validateMigratedData(database, expected);

  database.exec(`
    DROP TABLE activity_events_v1;
    DROP TABLE claims_v1;
    DROP TABLE context_documents_v1;
    DROP TABLE tasks_v1;
    DROP TABLE projects_v1;
    DROP TABLE migration_spec_map;
  `);
  // SQLite keeps index names attached to renamed tables. Re-run the idempotent schema after the
  // legacy tables are gone so every v2 index is recreated under its canonical name.
  database.exec(SCHEMA_V2);
  database.pragma('user_version = 2');
}

/**
 * Rebuilds `workspaces` with a nullable `root_path` (SQLite cannot drop NOT NULL in place) and
 * turns every v2 sentinel root into NULL. Runs with foreign keys off: `projects` and
 * `context_documents` reference `workspaces`, and DROP TABLE would otherwise cascade or refuse.
 * The child tables keep their `REFERENCES workspaces(id)` text, so the renamed table satisfies
 * them; `foreign_key_check` proves it before the version moves.
 */
function migrateV2ToV3(database: Database.Database): void {
  database.exec(workspacesV3Table('workspaces_v3'));
  database
    .prepare(
      `INSERT INTO workspaces_v3 (id, name, root_path, created_at, updated_at)
       SELECT id, name, CASE WHEN substr(root_path, 1, ?) = ? THEN NULL ELSE root_path END,
              created_at, updated_at
       FROM workspaces`,
    )
    .run(UNRESOLVED_WORKSPACE_ROOT_PREFIX.length, UNRESOLVED_WORKSPACE_ROOT_PREFIX);
  database.exec('DROP TABLE workspaces; ALTER TABLE workspaces_v3 RENAME TO workspaces;');
  const foreignKeyFailures = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error('Workspace root migration validation failed');
  }
  database.pragma('user_version = 3');
}

export function migrateDatabase(database: Database.Database): void {
  const version = Number(database.pragma('user_version', { simple: true }));
  if (version > LATEST_SCHEMA_VERSION) {
    throw new AppError(
      'internal_error',
      `Database schema version ${version} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
      500,
    );
  }
  if (version === LATEST_SCHEMA_VERSION) return;

  if (version === 0) {
    database.transaction(() => {
      database.exec(workspacesV3Table('workspaces'));
      database.exec(SCHEMA_V2);
      database.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
    })();
    return;
  }

  if (version !== 1 && version !== 2) {
    throw new AppError('internal_error', `Unsupported database schema version ${version}`, 500);
  }

  // Forward only, one transaction: a v1 database passes through v2 and lands on v3 or stays v1.
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      if (version === 1) migrateV1ToV2(database);
      migrateV2ToV3(database);
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new AppError(
      'internal_error',
      `Database migration from schema version ${version} failed: ${message}`,
      500,
    );
  } finally {
    database.pragma('foreign_keys = ON');
  }
}
