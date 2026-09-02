import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_SCENARIOS,
  produceOverviewFixture,
  type OverviewScenario,
} from './fixtures/overview/produce.js';
import { temporaryDirectory } from './helpers/tmp.js';

/**
 * `test/fixtures/overview/*.json` is a three-consumer contract: the Swift tests, the Omarchy
 * plugin validator and the TypeScript acceptance tests read the same bytes, and
 * `scripts/check-desktop-status-contract.mjs` pins their digests. This suite ties those bytes to
 * the producer: each scenario is rebuilt in a real store, served through `createHttpApp`, and must
 * equal the checked-in file after the same normalisation the regeneration script applies.
 * Regenerate with `npx tsx scripts/regenerate-fixtures.mjs` when the producer changes on purpose.
 */
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'overview');

function fixture(name: string): string {
  return readFileSync(join(fixtureRoot, `${name}.json`), 'utf8');
}

describe('overview fixtures come from the HTTP producer', () => {
  it.each(OVERVIEW_SCENARIOS)(
    '%s.json equals a fresh overview served for its scenario',
    async (scenario: OverviewScenario) => {
      const produced = await produceOverviewFixture(
        scenario,
        temporaryDirectory('pimpampum-overview-fixture-'),
      );
      const checkedIn = fixture(scenario);
      expect(JSON.parse(produced)).toEqual(JSON.parse(checkedIn));
      // The regeneration script writes exactly this text, so the digest gate and the plugin copy
      // stay in step without a manual edit.
      expect(produced).toBe(checkedIn);
    },
  );

  it('keeps the shape the consumers decode: schema 2, normalised daemon, stable names', () => {
    const mixed = JSON.parse(fixture('mixed')) as {
      meta: { schemaVersion: number };
      data: {
        daemon: { version: string; startedAt: string; uptimeSeconds: number };
        generatedAt: string;
        projects: Array<{ id: string; status: string; workspace: { rootPath: string } }>;
        activeWork: Array<{
          targetType: string;
          targetId: string;
          agentId: string;
          taskId: string | null;
        }>;
      };
    };
    expect(mixed.meta.schemaVersion).toBe(2);
    expect(mixed.data.daemon).toEqual({
      version: '1.0.0',
      startedAt: '2026-08-26T20:00:00.000Z',
      uptimeSeconds: 90,
    });
    expect(mixed.data.generatedAt).toBe('2026-08-26T20:01:30.000Z');
    // Every status the desktop surfaces render appears once, in overview order.
    expect(mixed.data.projects.map((project) => project.status)).toEqual([
      'active',
      'available',
      'draft',
      'paused',
      'complete',
      'complete',
    ]);
    expect(mixed.data.projects.every((project) => /^project-[a-z]+$/u.test(project.id))).toBe(true);
    expect(mixed.data.projects[0]?.workspace.rootPath).toBe('/Users/example/100 Projects');
    // A task-level and a spec-level claim, so decoders exercise both shapes of active work.
    expect(mixed.data.activeWork[0]).toMatchObject({
      targetType: 'task',
      targetId: 'task-active',
      agentId: 'codex-task',
    });
    expect(mixed.data.activeWork.at(-1)).toMatchObject({ targetType: 'spec', taskId: null });
  });
});
