import Database from 'better-sqlite3';

/**
 * The Domain Model v1 schema exactly as `src/db.ts` created it before the v2 migration
 * (`git show 804f667:src/db.ts`, `MIGRATION_1`). Every v1 test database starts from these
 * statements, so a CHECK, UNIQUE or REFERENCES clause the migration relies on cannot silently
 * differ between suites.
 */
export const V1_SCHEMA = `
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
  state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'done')),
  prd TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  completion_summary TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS context_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'done')),
  revision INTEGER NOT NULL DEFAULT 1,
  completion_summary TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  target_type TEXT NOT NULL CHECK (target_type IN ('project', 'task')),
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
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace_state
  ON projects(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_project_state
  ON tasks(project_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_claims_expiry
  ON claims(expires_at);
CREATE INDEX IF NOT EXISTS idx_activity_project
  ON activity_events(project_id, id DESC);
`;

/**
 * Opens `path` with better-sqlite3 the way the v1 daemon did (`foreign_keys = ON`), creates the
 * v1 schema and stamps `user_version = 1`. The caller owns the connection.
 */
export function createV1Database(path: string): Database.Database {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(V1_SCHEMA);
  database.pragma('user_version = 1');
  return database;
}
