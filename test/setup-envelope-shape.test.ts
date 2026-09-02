import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cliProgram.js';
import type { SetupPlan } from '../src/setup/types.js';
import {
  FIXTURE_HOME,
  FIXTURE_OPERATION_ID,
  createSetupCli,
  macosChangeTargets,
  planRevision,
  produceEmptyJournalEnvelope,
  producePlanEnvelope,
} from './fixtures/setup/produce.js';
import { temporaryDirectory } from './helpers/tmp.js';

/**
 * `setup plan` and `setup status` have no `--events` mode, so they always leave the CLI through the
 * indented success envelope. The macOS app decodes that output, and it once assumed one JSON value
 * per line, which made every clean first run fail. The fixtures in `test/fixtures/setup` are
 * produced here from the real coordinator behind the real `runCli` boundary and read by
 * `SetupEnvelopeFixtureTests` on the Swift side, so both ends are pinned to the same bytes.
 * Regenerate them with `npx tsx scripts/regenerate-fixtures.mjs`.
 */
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'setup');

function fixture(name: string): string {
  return readFileSync(join(fixtureRoot, `${name}.json`), 'utf8');
}

describe('setup envelope fixtures come from the CLI producer', () => {
  it('plan-envelope.json is what `setup plan` prints, with the random id normalised', async () => {
    const produced = await producePlanEnvelope(temporaryDirectory('pimpampum-setup-plan-'));
    // The fresh envelope is the exact CLI format: two-space indent plus one trailing newline.
    expect(produced.raw).toBe(`${JSON.stringify(JSON.parse(produced.raw), null, 2)}\n`);
    // The normaliser recomputes the revision with the coordinator's own formula; prove the formula
    // against the fresh plan before trusting it on the substituted one.
    const { revision, ...withoutRevision } = produced.plan;
    expect(revision).toBe(planRevision(withoutRevision));
    expect(produced.normalized).toBe(fixture('plan-envelope'));
  });

  it('empty-journal-envelope.json is what `setup status` prints before any setup ran', async () => {
    const produced = await produceEmptyJournalEnvelope(
      temporaryDirectory('pimpampum-setup-status-'),
    );
    expect(produced.raw).toBe(fixture('empty-journal-envelope'));
  });

  for (const name of ['plan-envelope', 'empty-journal-envelope']) {
    it(`${name} is one indented JSON object that a line-by-line decoder cannot read`, () => {
      const raw = fixture(name);
      const parsed = JSON.parse(raw) as { data: unknown };
      expect(parsed).toHaveProperty('data');
      expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
      const lines = raw.split('\n').filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThan(1);
      expect(() => JSON.parse(lines[0]!)).toThrow();
    });
  }

  it('carries the discriminators and the four disclosed changes the decoder renders', () => {
    const plan = (JSON.parse(fixture('plan-envelope')) as { data: SetupPlan }).data;
    // The Swift decoder has no `event` field to read here, so it infers "plan" from this key.
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.operationId).toBe(FIXTURE_OPERATION_ID);
    expect(plan.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.selectedConnectors).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    // Every change the confirmation screen lists, with the real path of each target.
    const targets = macosChangeTargets(FIXTURE_HOME);
    expect(plan.changes).toEqual([
      { kind: 'runtime', summary: expect.any(String), path: targets.runtimeDirectory },
      { kind: 'service', summary: expect.any(String), path: targets.servicePath },
      { kind: 'data', summary: expect.any(String), path: targets.dataDirectory },
      { kind: 'login-item', summary: expect.any(String) },
    ]);
    expect(plan.changes.map((change) => change.path)).toEqual([
      '/Users/example/Library/Application Support/Pimpampum/Runtime',
      '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      '/Users/example/.pimpampum',
      undefined,
    ]);
    // An absent journal is a null payload, which the decoder maps to "no setup in progress".
    expect((JSON.parse(fixture('empty-journal-envelope')) as { data: unknown }).data).toBeNull();
  });
});

describe('setup verbs reach the real coordinator through the CLI boundary', () => {
  it('plans, applies, reports, resumes and retries against one durable journal', async () => {
    const cli = createSetupCli(temporaryDirectory('pimpampum-setup-cli-'));

    await runCli(['setup', 'plan', '--connector', 'codex'], cli.runtime);
    const plan = (JSON.parse(cli.stdout[0]!) as { data: SetupPlan }).data;
    expect(plan.selectedConnectors).toEqual(['codex']);
    expect(plan.changes.map((change) => change.kind)).toEqual([
      'runtime',
      'service',
      'data',
      'login-item',
      'connector:codex',
    ]);
    expect(cli.planStore.read()).toEqual(plan);

    await runCli(['setup', 'apply', plan.operationId, plan.revision, '--yes'], cli.runtime);
    expect(JSON.parse(cli.stdout[1]!)).toMatchObject({
      data: { status: 'complete', nextAction: 'done' },
    });
    expect(cli.stateStore.read()).toMatchObject({
      operationId: plan.operationId,
      revision: plan.revision,
      status: 'complete',
      completedPhases: [
        'runtime.install',
        'service.install',
        'service.verify',
        'login-item.register',
        'connector:codex.connect',
        'connector:codex.verify',
      ],
      connectors: [{ id: 'codex', configured: true, available: true, state: 'connected' }],
      loginItem: 'enabled',
    });

    await runCli(['setup', 'status'], cli.runtime);
    expect(JSON.parse(cli.stdout[2]!)).toEqual({ data: cli.stateStore.read() });

    await runCli(['setup', 'resume'], cli.runtime);
    expect(JSON.parse(cli.stdout[3]!)).toMatchObject({ data: { status: 'complete' } });

    await runCli(['setup', 'retry', 'codex', '--events'], cli.runtime);
    const events = cli.stdout
      .slice(4)
      .map((line) => JSON.parse(line) as { event: string; data: unknown });
    expect(events.at(-1)).toMatchObject({
      schemaVersion: 1,
      event: 'result',
      data: { status: 'complete' },
    });

    expect(cli.stderr).toEqual([]);
    expect(cli.exits).toEqual([]);
  });
});
