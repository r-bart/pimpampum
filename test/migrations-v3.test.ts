import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { LATEST_SCHEMA_VERSION, UNRESOLVED_WORKSPACE_ROOT_PREFIX } from '../src/migrations.js';
import { PimpampumStore } from '../src/store.js';
import { createV1Database } from './helpers/v1Schema.js';

/**
 * Schema v2 exactly as `src/migrations.ts` created it before the v3 migration
 * (`git show 3193d4a:src/migrations.ts`, `SCHEMA_V2`). Every v2 test database starts from these
 * statements so the NOT NULL the migration removes is the real one.
 */
const V2_SCHEMA = `
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

const AT = '2026-01-01T00:00:00.000Z';

interface ColumnInfo {
  name: string;
  notnull: number;
}

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pimpampum-migrations-v3-'));
  directories.push(directory);
  return directory;
}

/** Creates a v2 database, runs `seed` on it and closes it. The file is what `openDatabase` sees. */
function seedV2Database(path: string, seed: (database: Database.Database) => void): void {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(V2_SCHEMA);
  database.pragma('user_version = 2');
  seed(database);
  database.close();
}

function rootPathColumn(database: Database.Database): ColumnInfo {
  const columns = database.pragma('table_info(workspaces)') as ColumnInfo[];
  return columns.find((column) => column.name === 'root_path')!;
}

function schemaVersion(database: Database.Database): number {
  return Number(database.pragma('user_version', { simple: true }));
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('schema v3: nullable Workspace root', () => {
  it('turns the v2 sentinel root into NULL and keeps every reference to the Workspace', () => {
    const localRoot = realpathSync(temporaryDirectory());
    const path = join(temporaryDirectory(), 'pimpampum.sqlite');
    const sentinel = `${UNRESOLVED_WORKSPACE_ROOT_PREFIX}phantom`;
    seedV2Database(path, (database) => {
      database.exec(`
        INSERT INTO workspaces VALUES ('local','Local','${localRoot}','${AT}','${AT}');
        INSERT INTO workspaces VALUES ('phantom','Phantom','${sentinel}','${AT}','${AT}');
        INSERT INTO projects (id,workspace_id,slug,title,state,created_at,updated_at)
          VALUES ('11111111-1111-4111-8111-111111111111','local','local-project','Local project','draft','${AT}','${AT}');
        INSERT INTO projects (id,workspace_id,slug,title,state,created_at,updated_at)
          VALUES ('22222222-2222-4222-8222-222222222222','phantom','phantom-project','Phantom project','draft','${AT}','${AT}');
        INSERT INTO context_documents (id,workspace_id,project_id,name,body,created_at,updated_at)
          VALUES ('33333333-3333-4333-8333-333333333333','phantom',NULL,'brief','# Brief','${AT}','${AT}');
      `);
    });

    const database = openDatabase(path);
    expect(schemaVersion(database)).toBe(LATEST_SCHEMA_VERSION);
    expect(rootPathColumn(database).notnull).toBe(0);
    expect(database.prepare('SELECT id,root_path FROM workspaces ORDER BY id').all()).toEqual([
      { id: 'local', root_path: localRoot },
      { id: 'phantom', root_path: null },
    ]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%\\_v3' ESCAPE '\\'")
        .pluck()
        .get(),
    ).toBe(0);
    // The UNIQUE root survives the rebuild, and SQLite lets several unresolved roots coexist.
    expect(() =>
      database
        .prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)')
        .run('twin', 'Twin', localRoot, AT, AT),
    ).toThrow(/UNIQUE constraint failed/u);
    database.prepare('INSERT INTO workspaces VALUES (?,?,NULL,?,?)').run('other', 'Other', AT, AT);
    database.prepare('DELETE FROM workspaces WHERE id=?').run('other');

    const store = new PimpampumStore(database);
    expect(store.getWorkspace('phantom').rootPath).toBe('');
    expect(store.resolveWorkspace(localRoot).id).toBe('local');
    expect(() => store.resolveWorkspace(process.cwd())).toThrow(AppError);
    expect(
      store.listProjectManifests({ workspaceId: 'phantom', state: null, limit: 10, offset: 0 }),
    ).toHaveLength(1);
    expect(store.readContext('workspace', 'phantom', 'brief').body).toBe('# Brief');
    // The overview keeps a non-empty placeholder: the macOS and Omarchy validators reject an
    // empty or relative Workspace root for every row of the portfolio.
    const overview = store.getOverview();
    expect(
      overview.projects.find((project) => project.workspace.id === 'phantom')?.workspace.rootPath,
    ).toBe(sentinel);
    expect(
      overview.projects.find((project) => project.workspace.id === 'local')?.workspace.rootPath,
    ).toBe(localRoot);

    const attachedRoot = realpathSync(temporaryDirectory());
    const attached = store.registerWorkspace({
      id: 'phantom',
      name: 'Phantom',
      rootPath: attachedRoot,
      actor: 'test',
    });
    expect(attached.rootPath).toBe(attachedRoot);
    expect(store.resolveWorkspace(attachedRoot).id).toBe('phantom');
    expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(['local', 'phantom']);
    store.close();

    const reopened = openDatabase(path);
    expect(schemaVersion(reopened)).toBe(LATEST_SCHEMA_VERSION);
    reopened.close();
  });

  it('carries a v1 database through v2 to v3 in one pass', () => {
    const path = join(temporaryDirectory(), 'pimpampum.sqlite');
    const legacy = createV1Database(path);
    legacy.exec(`
      INSERT INTO workspaces VALUES ('workspace','Workspace','/tmp','${AT}','${AT}');
      INSERT INTO projects VALUES ('11111111-1111-4111-8111-111111111111','workspace','project','Project','draft','# Spec',1,NULL,'[]',NULL,'${AT}','${AT}');
    `);
    legacy.close();

    const migrated = openDatabase(path);
    expect(schemaVersion(migrated)).toBe(LATEST_SCHEMA_VERSION);
    expect(rootPathColumn(migrated).notnull).toBe(0);
    expect(migrated.prepare('SELECT COUNT(*) FROM specs').pluck().get()).toBe(1);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    migrated.close();
  });

  it('creates a fresh database directly at v3', () => {
    const database = openDatabase(':memory:');
    expect(schemaVersion(database)).toBe(LATEST_SCHEMA_VERSION);
    expect(rootPathColumn(database).notnull).toBe(0);
    const store = new PimpampumStore(database);
    expect(store.listWorkspaces()).toEqual([]);
    store.close();
  });

  it('rolls back to v2 when a Project references a Workspace that does not exist', () => {
    const path = join(temporaryDirectory(), 'pimpampum.sqlite');
    seedV2Database(path, (database) => {
      database.pragma('foreign_keys = OFF');
      database.exec(`
        INSERT INTO projects (id,workspace_id,slug,title,state,created_at,updated_at)
          VALUES ('11111111-1111-4111-8111-111111111111','ghost','orphan','Orphan','draft','${AT}','${AT}');
      `);
    });

    let caught: unknown;
    try {
      openDatabase(path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('internal_error');
    expect((caught as AppError).message).toMatch(
      /from schema version 2 failed: Workspace root migration validation failed/u,
    );

    const inspected = new Database(path);
    expect(schemaVersion(inspected)).toBe(2);
    expect(rootPathColumn(inspected).notnull).toBe(1);
    expect(
      inspected
        .prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='workspaces_v3'")
        .pluck()
        .get(),
    ).toBe(0);
    inspected.close();
  });

  it('refuses a database whose version is newer than the daemon supports', () => {
    const path = join(temporaryDirectory(), 'pimpampum.sqlite');
    const future = new Database(path);
    future.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    future.close();
    expect(() => openDatabase(path)).toThrow(
      new RegExp(`newer than supported version ${LATEST_SCHEMA_VERSION}`, 'u'),
    );
  });
});
