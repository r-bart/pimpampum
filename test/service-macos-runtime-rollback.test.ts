import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// `renameSync` cannot be spied on in ESM, so the whole module is wrapped here. Isolating this in its
// own file keeps the rest of the macOS adapter suite running against the real filesystem. The fault
// is injected by destination path (M-T5), not by call ordinal, so the test names what fails.
let failStagingRenameInto: string | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const { basename } = await import('node:path');
  return {
    ...real,
    renameSync(from: string, to: string) {
      // Only the activation rename (staging copy -> destination) fails; the rename that brings the
      // backup back into the same destination must still work for the rollback to be observable.
      if (
        failStagingRenameInto !== null &&
        String(to) === failStagingRenameInto &&
        basename(String(from)).startsWith('.PimpampumRuntime.stage-')
      ) {
        throw new Error('activation interrupted');
      }
      return real.renameSync(from, to);
    },
  };
});

import { createLaunchdAdapter } from '../src/service/launchd.js';
import { createMacOSDesktopAdapter } from '../src/service/macosApp.js';

const roots: string[] = [];

afterEach(() => {
  failStagingRenameInto = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('restores the previous embedded runtime when activation cannot complete', async () => {
  // The destination is moved aside before the staged runtime replaces it. If that final rename
  // fails, the runtime the user already had must come back rather than disappear.
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-macos-rollback-'));
  roots.push(root);
  const home = join(root, 'home');
  const data = join(root, 'data');
  const sourceApp = join(root, 'build', 'Pimpampum.app');
  const sourceRuntime = join(sourceApp, 'Contents', 'Resources', 'PimpampumRuntime');
  mkdirSync(sourceRuntime, { recursive: true });
  writeFileSync(join(sourceRuntime, 'node'), 'new runtime', { mode: 0o755 });

  const destination = join(
    home,
    'Applications',
    'Pimpampum.app',
    'Contents',
    'Resources',
    'PimpampumRuntime',
  );
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'node'), 'previous runtime', { mode: 0o755 });
  mkdirSync(data, { recursive: true });

  const adapter = createMacOSDesktopAdapter({
    appBundlePath: sourceApp,
    daemonAdapter: createLaunchdAdapter({ guiDomain: 'gui/501' }),
    now: () => new Date('2026-08-26T20:00:00.000Z'),
    sleep: async () => undefined,
  });

  // The destination was already moved to its backup; the rename that activates the staged copy
  // into the destination fails.
  failStagingRenameInto = destination;

  await expect(
    adapter.afterInstall!(
      {
        homeDirectory: home,
        dataDirectory: data,
        nodePath: '/usr/bin/node',
        cliPath: '/opt/pimpampum/cli.js',
        version: '1.0.0',
        host: '127.0.0.1',
        port: 7337,
        logDirectory: join(data, 'logs'),
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
      [],
    ),
  ).rejects.toThrow(/activation interrupted/iu);

  expect(readFileSync(join(destination, 'node'), 'utf8')).toBe('previous runtime');
  const siblings = readdirSync(dirname(destination));
  expect(siblings.filter((name) => name.startsWith('.PimpampumRuntime'))).toEqual([]);
});
