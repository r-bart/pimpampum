import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { AppError } from './errors.js';

const MIGRATION_1 = `
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

export function openDatabase(databasePath: string): Database.Database {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath, { timeout: 5_000 });
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    if (databasePath !== ':memory:') database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');

    const version = Number(database.pragma('user_version', { simple: true }));
    if (version > 1) {
      throw new AppError(
        'internal_error',
        `Database schema version ${version} is newer than supported version 1`,
        500,
      );
    }
    if (version < 1) {
      database.transaction(() => {
        database.exec(MIGRATION_1);
        database.pragma('user_version = 1');
      })();
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
