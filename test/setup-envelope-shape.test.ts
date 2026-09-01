import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `setup plan` and `setup status` have no `--events` mode, so they always leave the CLI through the
 * indented success envelope. The macOS app decodes that output, and it once assumed one JSON value
 * per line, which made every clean first run fail. These fixtures are captured from a real
 * `pimpampum setup …` invocation and are read by `SetupClientStoreTests` on the Swift side, so both
 * ends are pinned to the same bytes. Changing the CLI's output shape must fail here first.
 */
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'setup');

function fixture(name: string): string {
  return readFileSync(join(fixtureRoot, `${name}.json`), 'utf8');
}

describe('setup envelope shape shared with the macOS decoder', () => {
  for (const name of ['plan-envelope', 'empty-journal-envelope']) {
    it(`${name} is one indented JSON object, exactly as the CLI prints it`, () => {
      const raw = fixture(name);

      // The whole buffer parses. This is what the Swift decoder now tries before splitting lines.
      const parsed = JSON.parse(raw) as { data: unknown };
      expect(parsed).toHaveProperty('data');

      // It is the CLI's own formatting: two-space indent plus a trailing newline.
      expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);

      // And it spans several lines, so a line-by-line decoder cannot read it.
      const lines = raw.split('\n').filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThan(1);
      expect(() => JSON.parse(lines[0]!)).toThrow();
    });
  }

  it('keeps the discriminators the decoder infers an event type from', () => {
    const plan = JSON.parse(fixture('plan-envelope')) as {
      data: { requiresConfirmation: boolean; operationId: string; revision: string };
    };
    // The Swift decoder has no `event` field to read here, so it infers "plan" from this key.
    expect(plan.data.requiresConfirmation).toBe(true);
    expect(plan.data.operationId).toBeTruthy();
    expect(plan.data.revision).toBeTruthy();

    // An absent journal is a null payload, which the decoder maps to "no setup in progress".
    expect((JSON.parse(fixture('empty-journal-envelope')) as { data: unknown }).data).toBeNull();
  });
});
