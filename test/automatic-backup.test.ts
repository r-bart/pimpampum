import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutomaticBackupController,
  type AutomaticBackupSnapshotter,
} from '../src/automaticBackup.js';
import { parseAutomaticBackupStatus } from '../src/backupContract.js';

const temporaryDirectories: string[] = [];

function root(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `pimpampum-backup-unit-${label}-`));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('automatic backup controller', () => {
  it('strictly parses public status', () => {
    const status = {
      enabled: false,
      directory: null,
      snapshotPath: null,
      state: 'disabled' as const,
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: null,
    };
    expect(parseAutomaticBackupStatus(status)).toEqual(status);
    const unreadableSettings = { ...status, state: 'error' as const, error: 'settings unreadable' };
    expect(parseAutomaticBackupStatus(unreadableSettings)).toEqual(unreadableSettings);
    expect(() => parseAutomaticBackupStatus({ ...status, state: 'error' })).toThrow(
      'invalid backup status',
    );
    expect(() => parseAutomaticBackupStatus({ ...status, unexpected: true })).toThrow(
      'invalid backup status',
    );
    expect(() => parseAutomaticBackupStatus({ ...status, enabled: true })).toThrow(
      'invalid backup status',
    );
    expect(() =>
      parseAutomaticBackupStatus({
        ...status,
        enabled: true,
        state: 'healthy',
        directory: 'relative',
        snapshotPath: '/backup/pimpampum-latest.sqlite',
      }),
    ).toThrow('invalid backup status');
    expect(() =>
      parseAutomaticBackupStatus({
        ...status,
        enabled: true,
        state: 'error',
        directory: '/backup',
        snapshotPath: '/backup/pimpampum-latest.sqlite',
        error: 'unsafe\u0000message',
      }),
    ).toThrow('invalid backup status');
  });

  it('validates settings and destination boundaries', async () => {
    const directory = root('validation');
    const missingSettingsParent = new AutomaticBackupController({
      settingsPath: join(directory, 'missing', 'settings.json'),
      snapshotter: vi.fn(async (destination) => join(destination, 'pimpampum-latest.sqlite')),
    });
    await expect(missingSettingsParent.configure(directory)).rejects.toThrow('ENOENT');
    await expect(missingSettingsParent.retry()).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(missingSettingsParent.configure('relative')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(missingSettingsParent.configure(join(directory, 'absent'))).rejects.toMatchObject({
      code: 'bad_request',
    });
    const file = join(directory, 'file');
    writeFileSync(file, 'not a directory');
    await expect(missingSettingsParent.configure(file)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await missingSettingsParent.close();
    await missingSettingsParent.close();
    missingSettingsParent.markDirty();
    await expect(missingSettingsParent.configure(directory)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await expect(missingSettingsParent.retry()).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(missingSettingsParent.disable()).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('loads disabled settings, rejects corrupt settings, and starts configured settings', async () => {
    const directory = root('load');
    const destination = join(directory, 'destination');
    mkdirSync(destination);
    const snapshotter = vi.fn(async (path: string) => join(path, 'pimpampum-latest.sqlite'));
    const disabledPath = join(directory, 'disabled.json');
    writeFileSync(disabledPath, '{"schemaVersion":1,"backupDirectory":null}\n');
    const disabled = new AutomaticBackupController({ settingsPath: disabledPath, snapshotter });
    disabled.start();
    expect(disabled.getStatus().state).toBe('disabled');
    await disabled.close();

    // A corrupt settings file must not keep the daemon down: the controller starts in `error`
    // without a destination, the public contract accepts that shape, and configure() repairs it.
    const corruptPath = join(directory, 'corrupt.json');
    const unreadable = {
      enabled: false,
      directory: null,
      snapshotPath: null,
      state: 'error',
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: `Pimpampum backup settings are invalid: ${corruptPath}`,
    };
    for (const contents of [
      'not json',
      '{"schemaVersion":1,"backupDirectory":"relative"}\n',
      `${JSON.stringify({ schemaVersion: 1, backupDirectory: destination, extra: true })}\n`,
    ]) {
      writeFileSync(corruptPath, contents);
      const corrupt = new AutomaticBackupController({ settingsPath: corruptPath, snapshotter });
      corrupt.start();
      expect(corrupt.getStatus()).toEqual(unreadable);
      expect(parseAutomaticBackupStatus(corrupt.getStatus())).toEqual(unreadable);
      await expect(corrupt.retry()).rejects.toMatchObject({ code: 'invalid_state' });
      await corrupt.close();
    }
    writeFileSync(corruptPath, 'not json');
    const repaired = new AutomaticBackupController({ settingsPath: corruptPath, snapshotter });
    expect((await repaired.configure(destination)).state).toBe('healthy');
    expect(JSON.parse(readFileSync(corruptPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      backupDirectory: destination,
    });
    await repaired.close();
    writeFileSync(corruptPath, 'not json');
    const disabled2 = new AutomaticBackupController({ settingsPath: corruptPath, snapshotter });
    expect((await disabled2.disable()).state).toBe('disabled');
    await disabled2.close();

    const configuredPath = join(directory, 'configured.json');
    writeFileSync(
      configuredPath,
      `${JSON.stringify({ schemaVersion: 1, backupDirectory: destination })}\n`,
    );
    snapshotter.mockClear();
    const configured = new AutomaticBackupController({
      settingsPath: configuredPath,
      snapshotter,
      clock: () => new Date('2026-08-26T10:00:00.000Z'),
    });
    configured.start();
    await configured.drain();
    expect(snapshotter).toHaveBeenCalledOnce();
    expect(configured.getStatus()).toMatchObject({
      state: 'healthy',
      lastAttemptAt: '2026-08-26T10:00:00.000Z',
      lastSuccessAt: '2026-08-26T10:00:00.000Z',
    });
    await configured.close();
  });

  it('flushes an already queued snapshot during idempotent close', async () => {
    const directory = root('close-flush');
    const destination = join(directory, 'destination');
    mkdirSync(destination);
    const settingsPath = join(directory, 'settings.json');
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ schemaVersion: 1, backupDirectory: destination })}\n`,
    );
    let release: (() => void) | undefined;
    const snapshotter: AutomaticBackupSnapshotter = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve(join(destination, 'pimpampum-latest.sqlite'));
        }),
    );
    const controller = new AutomaticBackupController({ settingsPath, snapshotter });

    controller.start();
    await vi.waitFor(() => expect(snapshotter).toHaveBeenCalledOnce());
    const firstClose = controller.close();
    const secondClose = controller.close();
    controller.markDirty();
    await expect(controller.retry()).rejects.toMatchObject({ code: 'invalid_state' });
    release?.();
    await Promise.all([firstClose, secondClose]);

    expect(snapshotter).toHaveBeenCalledOnce();
    await expect(controller.retry()).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('sanitizes unknown and blank failures', async () => {
    const directory = root('sanitize');
    const destination = join(directory, 'destination');
    mkdirSync(destination);
    const failures: unknown[] = [
      'not-an-error',
      new Error('\n\t'),
      new Error('cloud\u0000\u001b[31m\u007f unavailable'),
    ];
    const snapshotter: AutomaticBackupSnapshotter = async () => {
      throw failures.shift();
    };
    const controller = new AutomaticBackupController({
      settingsPath: join(directory, 'settings.json'),
      snapshotter,
    });

    expect(await controller.configure(destination)).toMatchObject({
      state: 'error',
      error: 'Automatic backup failed',
    });
    expect(await controller.retry()).toMatchObject({
      state: 'error',
      error: 'Automatic backup failed',
    });
    expect(await controller.retry()).toMatchObject({
      state: 'error',
      error: 'cloud [31m unavailable',
    });
    await controller.close();
  });

  it('ignores completion from an old destination after change or disable', async () => {
    const directory = root('switch');
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    mkdirSync(first);
    mkdirSync(second);
    const releases: Array<() => void> = [];
    const snapshotter: AutomaticBackupSnapshotter = vi.fn(
      async (destination) =>
        new Promise<string>((resolve, reject) => {
          releases.push(() => {
            if (destination === first) reject(new Error('old failure'));
            else resolve(join(destination, 'pimpampum-latest.sqlite'));
          });
        }),
    );
    const controller = new AutomaticBackupController({
      settingsPath: join(directory, 'settings.json'),
      snapshotter,
    });

    const firstConfiguration = controller.configure(first);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const secondConfiguration = controller.configure(second);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await Promise.all([firstConfiguration, secondConfiguration]);
    expect(controller.getStatus()).toMatchObject({ directory: second, state: 'healthy' });

    controller.markDirty();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const disabling = controller.disable();
    releases.shift()?.();
    await disabling;
    expect(controller.getStatus().state).toBe('disabled');
    await controller.close();
  });
});
