import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findExecutable, runServiceCommand } from '../src/service/platform.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('service command runner', () => {
  it('executes argument arrays without a shell and captures success', async () => {
    await expect(
      runServiceCommand(process.execPath, [
        '--eval',
        "process.stdout.write(process.argv[1]); process.stderr.write('warning')",
        'value with spaces; $(not-a-shell)',
      ]),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: 'value with spaces; $(not-a-shell)',
      stderr: 'warning',
    });
  });

  it('returns nonzero process exits and rejects missing executables', async () => {
    await expect(
      runServiceCommand(process.execPath, [
        '--eval',
        "process.stderr.write('failed'); process.exit(7)",
      ]),
    ).resolves.toEqual({ exitCode: 7, stdout: '', stderr: 'failed' });
    await expect(runServiceCommand('/definitely/missing/pimpampum-command', [])).rejects.toThrow();
  });
});

describe('service executable discovery', () => {
  it('returns the canonical executable from the first usable absolute PATH entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-path-'));
    roots.push(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, 'omarchy'), 'not executable');
    writeFileSync(join(second, 'omarchy-real'), '#!/bin/sh\n');
    chmodSync(join(second, 'omarchy-real'), 0o755);
    symlinkSync(join(second, 'omarchy-real'), join(second, 'omarchy'));

    expect(findExecutable('omarchy', `relative${delimiter}${first}${delimiter}${second}`)).toBe(
      realpathSync(join(second, 'omarchy-real')),
    );
  });

  it('returns null for absent executables and an empty PATH', () => {
    expect(findExecutable('missing-pimpampum-command', undefined)).toBeNull();
    expect(findExecutable('missing-pimpampum-command', '')).toBeNull();
    const previousPath = process.env.PATH;
    try {
      delete process.env.PATH;
      expect(findExecutable('missing-pimpampum-command')).toBeNull();
    } finally {
      if (previousPath !== undefined) process.env.PATH = previousPath;
    }
  });

  it('rejects path-like and empty executable names', () => {
    for (const name of ['', '../omarchy', 'bin\\omarchy', `omarchy\0bad`]) {
      expect(() => findExecutable(name, '')).toThrow(/simple file name/u);
    }
  });
});
