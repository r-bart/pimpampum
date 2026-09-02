import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createV1Database } from './helpers/v1Schema.js';

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
    // The faithful v1 schema ships its own indexes (`idx_projects_workspace_state`,
    // `idx_tasks_project_state`, `idx_tasks_parent`, `idx_claims_expiry`, `idx_activity_project`),
    // so the renamed legacy tables carry indexes the migration must drop and recreate.
    const legacy = createV1Database(path);
    legacy.exec(`
      INSERT INTO workspaces VALUES ('workspace','Workspace','/tmp','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO projects VALUES ('11111111-1111-4111-8111-111111111111','workspace','project','Project','draft','# Spec',1,NULL,'[]',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
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
    // The v1-only index must not survive on a table that no longer exists.
    expect(indexes).not.toContain('idx_tasks_project_state');
    expect(
      migrated
        .prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE '%_v1'")
        .pluck()
        .get(),
    ).toBe(0);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    migrated.close();
  });
});
