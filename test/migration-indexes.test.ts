import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('v1 migration indexes', () => {
  it('recreates every canonical v2 index after indexed legacy tables are dropped', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pimpampum-indexed-v1-'));
    directories.push(directory);
    const path = join(directory, 'pimpampum.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,slug TEXT NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL,prd TEXT NOT NULL,revision INTEGER NOT NULL,completion_summary TEXT,artifacts_json TEXT NOT NULL,completed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE context_documents (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,parent_id TEXT,title TEXT NOT NULL,body TEXT,state TEXT NOT NULL,revision INTEGER NOT NULL,completion_summary TEXT,artifacts_json TEXT NOT NULL,completed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE claims (target_type TEXT NOT NULL,target_id TEXT NOT NULL,agent_id TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(target_type,target_id));
      CREATE TABLE activity_events (id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT,project_id TEXT,target_type TEXT NOT NULL,target_id TEXT NOT NULL,event_type TEXT NOT NULL,actor TEXT,data_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX idx_projects_workspace_state ON projects(workspace_id,state);
      CREATE INDEX idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX idx_claims_expiry ON claims(expires_at);
      CREATE INDEX idx_activity_project ON activity_events(project_id,id DESC);
      INSERT INTO workspaces VALUES ('workspace','Workspace','/tmp','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO projects VALUES ('11111111-1111-4111-8111-111111111111','workspace','project','Project','draft','# Spec',1,NULL,'[]',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      PRAGMA user_version=1;
    `);
    legacy.close();

    const migrated = openDatabase(path);
    const indexes = (
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_projects_workspace_state',
        'idx_specs_project_state',
        'idx_context_workspace_name',
        'idx_context_project_name',
        'idx_tasks_spec_state',
        'idx_tasks_parent',
        'idx_claims_expiry',
        'idx_activity_workspace',
        'idx_activity_project',
        'idx_activity_spec',
      ]),
    );
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    migrated.close();
  });
});
