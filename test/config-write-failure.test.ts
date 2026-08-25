import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }),
  };
});

import { loadConfig } from '../src/config.js';

describe('configuration write failures', () => {
  let directory = '';

  afterEach(() => {
    delete process.env.PIMPAMPUM_DATA_DIR;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('propagates token persistence failures other than an existing token', () => {
    directory = mkdtempSync(join(tmpdir(), 'pimpampum-config-failure-'));
    process.env.PIMPAMPUM_DATA_DIR = directory;
    expect(() => loadConfig()).toThrow('disk full');
  });
});
