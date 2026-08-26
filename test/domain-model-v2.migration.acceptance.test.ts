/**
 * @generated-from thoughts/specs/2026-08-26_domain-model-v2.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';

const temporaryDirectories: string[] = [];

function temporaryDatabasePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pimpampum-migration-v2-'));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const schemaV1 = `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE projects (
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
CREATE TABLE context_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE TABLE tasks (
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
CREATE TABLE claims (
  target_type TEXT NOT NULL CHECK (target_type IN ('project', 'task')),
  target_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
);
CREATE TABLE activity_events (
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
PRAGMA user_version = 1;
`;

function createPopulatedV1(path: string): void {
  const database = new Database(path);
  database.exec(schemaV1);
  const createdAt = '2026-08-25T09:00:00.000Z';
  const updatedAt = '2026-08-26T09:00:00.000Z';
  database
    .prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('pimpampum', 'Pimpampum', '/tmp/pimpampum-v1', createdAt, updatedAt);

  const insertProject = database.prepare(
    `INSERT INTO projects
       (id, workspace_id, slug, title, state, prd, revision, completion_summary,
        artifacts_json, completed_at, created_at, updated_at)
     VALUES (?, 'pimpampum', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProject.run(
    '11111111-1111-4111-8111-111111111111',
    'desktop-experience',
    'Desktop experience',
    'ready',
    '# Desktop experience\n\nShip native status surfaces.',
    4,
    null,
    '[]',
    null,
    createdAt,
    updatedAt,
  );
  insertProject.run(
    '22222222-2222-4222-8222-222222222222',
    'agent-cli',
    'Agent-first CLI',
    'done',
    '# Agent-first CLI\n\nExpose the complete MCP contract.',
    6,
    'The compiled CLI can discover and call every tool.',
    '[{"label":"commit","uri":"git:abc123"}]',
    updatedAt,
    createdAt,
    updatedAt,
  );
  insertProject.run(
    '33333333-3333-4333-8333-333333333333',
    'future-work',
    'Future work',
    'draft',
    '',
    1,
    null,
    '[]',
    null,
    createdAt,
    createdAt,
  );

  database
    .prepare(
      `INSERT INTO context_documents
       (id, project_id, name, body, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      '44444444-4444-4444-8444-444444444444',
      '11111111-1111-4111-8111-111111111111',
      'architecture',
      '# Architecture\n\nOne local daemon.',
      3,
      createdAt,
      updatedAt,
    );

  const insertTask = database.prepare(
    `INSERT INTO tasks
       (id, project_id, parent_id, title, body, state, revision, completion_summary,
        artifacts_json, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertTask.run(
    '55555555-5555-4555-8555-555555555555',
    '11111111-1111-4111-8111-111111111111',
    null,
    'Build native overview',
    'Use the bounded overview contract.',
    'open',
    2,
    null,
    '[]',
    null,
    createdAt,
    updatedAt,
  );
  insertTask.run(
    '66666666-6666-4666-8666-666666666666',
    '11111111-1111-4111-8111-111111111111',
    '55555555-5555-4555-8555-555555555555',
    'Decode semantic states',
    null,
    'done',
    3,
    'Strict decoding shipped.',
    '[{"label":null,"uri":"file:///tmp/evidence.json"}]',
    updatedAt,
    createdAt,
    updatedAt,
  );

  database
    .prepare(
      `INSERT INTO claims
       (target_type, target_id, agent_id, expires_at, created_at, updated_at)
       VALUES ('project', ?, ?, ?, ?, ?)`,
    )
    .run(
      '33333333-3333-4333-8333-333333333333',
      'legacy-project-agent',
      '2099-08-26T12:00:00.000Z',
      createdAt,
      updatedAt,
    );
  database
    .prepare(
      `INSERT INTO claims
       (target_type, target_id, agent_id, expires_at, created_at, updated_at)
       VALUES ('task', ?, ?, ?, ?, ?)`,
    )
    .run(
      '55555555-5555-4555-8555-555555555555',
      'legacy-task-agent',
      '2099-08-26T12:00:00.000Z',
      createdAt,
      updatedAt,
    );

  const insertEvent = database.prepare(
    `INSERT INTO activity_events
       (workspace_id, project_id, target_type, target_id, event_type, actor, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    'pimpampum',
    '11111111-1111-4111-8111-111111111111',
    'project',
    '11111111-1111-4111-8111-111111111111',
    'project.created',
    'legacy-agent',
    '{"state":"ready"}',
    createdAt,
  );
  insertEvent.run(
    'pimpampum',
    '11111111-1111-4111-8111-111111111111',
    'project',
    '11111111-1111-4111-8111-111111111111',
    'project.prd_updated',
    'legacy-agent',
    '{}',
    updatedAt,
  );
  insertEvent.run(
    'pimpampum',
    '33333333-3333-4333-8333-333333333333',
    'project',
    '33333333-3333-4333-8333-333333333333',
    'work.started',
    'legacy-project-agent',
    '{"targetType":"project","targetId":"33333333-3333-4333-8333-333333333333"}',
    updatedAt,
  );
  database.close();
}

describe('Domain Model v2 database migration', () => {
  it('FR-11/AC-8: migrates a populated v1 database without semantic data loss', () => {
    // Spec: FR-11, AC-8
    const path = temporaryDatabasePath('populated-v1.sqlite');
    createPopulatedV1(path);

    const database = openDatabase(path);
    expect(database.pragma('user_version', { simple: true })).toBe(2);
    expect(database.pragma('foreign_key_check')).toEqual([]);

    const projects = database
      .prepare('SELECT id, slug, state, revision, completion_summary FROM projects ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    expect(projects).toMatchObject([
      {
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'desktop-experience',
        state: 'open',
        revision: 4,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        slug: 'agent-cli',
        state: 'done',
        completion_summary: 'The compiled CLI can discover and call every tool.',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        slug: 'future-work',
        state: 'draft',
      },
    ]);

    const specs = database
      .prepare(
        `SELECT id, project_id, slug, title, body, state, revision,
                completion_summary, artifacts_json
         FROM specs ORDER BY project_id`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(specs).toHaveLength(3);
    expect(specs[0]).toMatchObject({
      project_id: '11111111-1111-4111-8111-111111111111',
      slug: 'primary',
      title: 'Desktop experience',
      body: '# Desktop experience\n\nShip native status surfaces.',
      state: 'ready',
      revision: 4,
    });
    expect(specs[1]).toMatchObject({
      project_id: '22222222-2222-4222-8222-222222222222',
      state: 'done',
      completion_summary: 'The compiled CLI can discover and call every tool.',
      artifacts_json: '[{"label":"commit","uri":"git:abc123"}]',
    });
    expect(specs[2]).toMatchObject({
      project_id: '33333333-3333-4333-8333-333333333333',
      body: '',
      state: 'draft',
    });

    const desktopSpecId = String(specs[0]?.id);
    const futureSpecId = String(specs[2]?.id);
    expect(
      database.prepare('SELECT COUNT(*) FROM tasks WHERE spec_id = ?').pluck().get(desktopSpecId),
    ).toBe(2);
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('tasks') WHERE name = 'project_id'")
        .get(),
    ).toBeUndefined();

    expect(
      database
        .prepare('SELECT target_type, target_id, agent_id FROM claims ORDER BY agent_id')
        .all(),
    ).toEqual([
      { target_type: 'spec', target_id: futureSpecId, agent_id: 'legacy-project-agent' },
      {
        target_type: 'task',
        target_id: '55555555-5555-4555-8555-555555555555',
        agent_id: 'legacy-task-agent',
      },
    ]);
    expect(
      database.prepare('SELECT project_id, name, body, revision FROM context_documents').get(),
    ).toMatchObject({
      project_id: '11111111-1111-4111-8111-111111111111',
      name: 'architecture',
      body: '# Architecture\n\nOne local daemon.',
      revision: 3,
    });
    expect(database.prepare('SELECT COUNT(*) FROM activity_events').pluck().get()).toBe(3);
    expect(
      database
        .prepare(
          "SELECT target_type, target_id FROM activity_events WHERE event_type = 'spec.body_updated'",
        )
        .get(),
    ).toEqual({ target_type: 'spec', target_id: desktopSpecId });
    database.close();

    const reopened = openDatabase(path);
    expect(reopened.pragma('user_version', { simple: true })).toBe(2);
    expect(reopened.prepare('SELECT COUNT(*) FROM specs').pluck().get()).toBe(3);
    reopened.close();
  });

  it('EC-5: rolls back the entire migration when v1 ownership is corrupt', () => {
    // Spec: EC-5
    const path = temporaryDatabasePath('corrupt-v1.sqlite');
    const database = new Database(path);
    database.exec(schemaV1);
    database.pragma('foreign_keys = OFF');
    database
      .prepare(
        `INSERT INTO tasks
         (id, project_id, parent_id, title, body, state, revision, completion_summary,
          artifacts_json, completed_at, created_at, updated_at)
         VALUES (?, ?, NULL, ?, NULL, 'open', 1, NULL, '[]', NULL, ?, ?)`,
      )
      .run(
        '77777777-7777-4777-8777-777777777777',
        'missing-project',
        'Orphaned task',
        '2026-08-26T09:00:00.000Z',
        '2026-08-26T09:00:00.000Z',
      );
    database.close();

    expect(() => openDatabase(path)).toThrow(/migration|foreign|owner|project/iu);

    const inspected = new Database(path, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(1);
    expect(
      inspected
        .prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'specs'")
        .pluck()
        .get(),
    ).toBe(0);
    expect(inspected.prepare('SELECT COUNT(*) FROM tasks').pluck().get()).toBe(1);
    inspected.close();
  });

  it('EC-6: rejects database versions newer than v2', () => {
    // Spec: EC-6
    const path = temporaryDatabasePath('future.sqlite');
    const database = new Database(path);
    database.pragma('user_version = 3');
    database.close();
    expect(() => openDatabase(path)).toThrow(/newer than supported version 2/iu);
  });
});
