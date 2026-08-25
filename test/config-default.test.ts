import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

let isolatedHome = '';
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: () => isolatedHome };
});

import { loadConfig } from '../src/config.js';

afterAll(() => {
  if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
});

it('uses the private home data directory by default', () => {
  isolatedHome = mkdtempSync(join(tmpdir(), 'pimpampum-home-'));
  delete process.env.PIMPAMPUM_DATA_DIR;
  delete process.env.PIMPAMPUM_TOKEN;
  const config = loadConfig();
  expect(config.dataDirectory).toBe(join(isolatedHome, '.pimpampum'));
  expect(config.databasePath).toBe(join(isolatedHome, '.pimpampum', 'pimpampum.sqlite'));
});
