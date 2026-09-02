import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { AutomaticBackupState, AutomaticBackupStatus } from './backupContract.js';
import { AppError } from './errors.js';

export type AutomaticBackupSnapshotter = (destinationDirectory: string) => Promise<string>;
export type { AutomaticBackupState, AutomaticBackupStatus } from './backupContract.js';

const settingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    backupDirectory: z.string().nullable(),
  })
  .strict();

interface AutomaticBackupOptions {
  settingsPath: string;
  snapshotter: AutomaticBackupSnapshotter;
  clock?: () => Date;
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Automatic backup failed';
  return (
    message
      .replaceAll(/\p{Cc}+/gu, ' ')
      .replaceAll(/\s+/gu, ' ')
      .trim()
      .slice(0, 500) || 'Automatic backup failed'
  );
}

export class AutomaticBackupController {
  private directory: string | null;
  private state: AutomaticBackupState;
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private error: string | null = null;
  private dirtyGeneration = 0;
  private completedGeneration = 0;
  private running: Promise<void> | null = null;
  private closing = false;
  private closed = false;
  private readonly settingsPath: string;
  private readonly snapshotter: AutomaticBackupSnapshotter;
  private readonly clock: () => Date;

  constructor(options: AutomaticBackupOptions) {
    this.settingsPath = options.settingsPath;
    this.snapshotter = options.snapshotter;
    this.clock = options.clock ?? (() => new Date());
    const settings = this.readDirectory();
    if (settings.ok) {
      this.directory = settings.directory;
      this.state = this.directory ? 'pending' : 'disabled';
    } else {
      // A corrupt settings file must not keep the daemon down: start without a
      // destination, report the failure, and let configure() or disable() rewrite it.
      this.directory = null;
      this.state = 'error';
      this.error = settings.error;
    }
  }

  getStatus(): AutomaticBackupStatus {
    return {
      enabled: this.directory !== null,
      directory: this.directory,
      snapshotPath: this.directory ? join(this.directory, 'pimpampum-latest.sqlite') : null,
      state: this.state,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      error: this.error,
    };
  }

  start(): void {
    if (this.directory) this.markDirty();
  }

  async configure(destinationDirectory: string): Promise<AutomaticBackupStatus> {
    this.assertOpen();
    const directory = this.validateDirectory(destinationDirectory);
    this.writeDirectory(directory);
    this.directory = directory;
    this.state = 'pending';
    this.error = null;
    this.markDirty();
    await this.drain();
    return this.getStatus();
  }

  async disable(): Promise<AutomaticBackupStatus> {
    this.assertOpen();
    this.writeDirectory(null);
    this.directory = null;
    this.state = 'disabled';
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.error = null;
    this.completedGeneration = this.dirtyGeneration;
    await this.drain();
    return this.getStatus();
  }

  async retry(): Promise<AutomaticBackupStatus> {
    this.assertOpen();
    if (!this.directory) {
      throw new AppError('invalid_state', 'Automatic backup is not configured', 409);
    }
    this.markDirty();
    await this.drain();
    return this.getStatus();
  }

  markDirty(): void {
    if (this.closed || this.closing || !this.directory) return;
    this.dirtyGeneration += 1;
    this.ensureRun();
  }

  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) {
      await this.drain();
      return;
    }
    this.closing = true;
    await this.drain();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed || this.closing) {
      throw new AppError('invalid_state', 'Automatic backup controller is closed', 409);
    }
  }

  private validateDirectory(candidate: string): string {
    if (!isAbsolute(candidate)) {
      throw new AppError('bad_request', 'Backup destination must be an absolute path', 400);
    }
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
      if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
      accessSync(resolved, constants.W_OK);
    } catch {
      throw new AppError(
        'bad_request',
        'Backup destination must be an existing writable directory',
        400,
      );
    }
    return candidate;
  }

  private readDirectory(): { ok: true; directory: string | null } | { ok: false; error: string } {
    if (!existsSync(this.settingsPath)) return { ok: true, directory: null };
    try {
      const parsed = settingsSchema.parse(JSON.parse(readFileSync(this.settingsPath, 'utf8')));
      if (parsed.backupDirectory !== null && !isAbsolute(parsed.backupDirectory)) throw new Error();
      return { ok: true, directory: parsed.backupDirectory };
    } catch {
      return { ok: false, error: `Pimpampum backup settings are invalid: ${this.settingsPath}` };
    }
  }

  private writeDirectory(directory: string | null): void {
    const temporaryPath = join(dirname(this.settingsPath), `.settings-${randomUUID()}.partial`);
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({ schemaVersion: 1, backupDirectory: directory }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.settingsPath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private ensureRun(): void {
    if (this.running || this.closed || !this.directory) return;
    this.running = this.runLoop().finally(() => {
      this.running = null;
    });
  }

  private async runLoop(): Promise<void> {
    while (!this.closed && this.directory && this.completedGeneration < this.dirtyGeneration) {
      const generation = this.dirtyGeneration;
      const directory = this.directory;
      this.state = 'pending';
      this.lastAttemptAt = this.clock().toISOString();
      try {
        await this.snapshotter(directory);
        if (this.directory === directory) {
          this.state = 'healthy';
          this.lastSuccessAt = this.clock().toISOString();
          this.error = null;
        }
      } catch (error) {
        if (this.directory === directory) {
          this.state = 'error';
          this.error = sanitizedError(error);
        }
      }
      this.completedGeneration = generation;
    }
  }
}
