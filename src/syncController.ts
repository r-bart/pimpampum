import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  parseSyncSnapshot,
  syncConflictSchema,
  syncStateSchema,
  type SyncConflict,
  type SyncGateway,
  type SyncSnapshot,
  type SyncState,
  type SyncStatus,
  type SyncStatusState,
} from './syncContract.js';
import {
  canonicalJson,
  mergeSyncStates,
  normalizedSyncState,
  preserveConflictedEntities,
  syncHash,
} from './syncState.js';

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const EMPTY_STATE: SyncState = {
  workspaces: [],
  projects: [],
  specs: [],
  contexts: [],
  tasks: [],
  activity: [],
};

const settingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  directory: z.string().nullable(),
  deviceId: z.string().nullable(),
  paused: z.boolean(),
  sequence: z.number().int().nonnegative(),
  appliedSnapshotIds: z.array(z.string().uuid()),
  headSnapshotIds: z.array(z.string().uuid()),
  baseState: z.unknown().nullable(),
  conflicts: z.array(z.unknown()),
  pendingResolutions: z
    .array(
      z.strictObject({
        entityType: z.enum(['workspace', 'project', 'spec', 'context', 'task']),
        entityId: z.string().min(1),
      }),
    )
    .optional(),
  lastPublishedHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .nullable()
    .optional(),
  deviceSequences: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

interface Settings {
  schemaVersion: 1;
  directory: string | null;
  deviceId: string | null;
  paused: boolean;
  sequence: number;
  appliedSnapshotIds: string[];
  headSnapshotIds: string[];
  baseState: SyncState | null;
  conflicts: SyncConflict[];
  pendingResolutions: Array<Pick<SyncConflict, 'entityType' | 'entityId'>>;
  lastPublishedHash: string | null;
  deviceSequences: Record<string, number>;
}

interface SyncControllerOptions {
  settingsPath: string;
  snapshotter: () => SyncState;
  importer: (state: SyncState) => void;
  clock?: () => Date;
  pollMilliseconds?: number;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Synchronization failed')
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

function conflictId(conflict: Omit<SyncConflict, 'id' | 'createdAt'>): string {
  return syncHash(conflict).slice('sha256:'.length);
}

export class SyncController implements SyncGateway {
  private settings: Settings;
  private state: SyncStatusState;
  private lastAttemptAt: string | null = null;
  private lastImportAt: string | null = null;
  private lastExportAt: string | null = null;
  private pendingSnapshotCount = 0;
  private error: string | null = null;
  private dirtyGeneration = 0;
  private completedGeneration = 0;
  private running: Promise<void> | null = null;
  private closed = false;
  private poller: ReturnType<typeof setInterval> | null = null;
  private readonly clock: () => Date;

  constructor(private readonly options: SyncControllerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.settings = this.readSettings();
    this.state = this.settings.directory
      ? this.settings.paused
        ? 'paused'
        : 'pending'
      : 'disabled';
  }

  getStatus(): SyncStatus {
    return {
      enabled: this.settings.directory !== null,
      paused: this.settings.paused,
      state: this.settings.conflicts.length > 0 ? 'conflict' : this.state,
      directory: this.settings.directory,
      deviceId: this.settings.deviceId,
      lastAttemptAt: this.lastAttemptAt,
      lastImportAt: this.lastImportAt,
      lastExportAt: this.lastExportAt,
      pendingSnapshotCount: this.pendingSnapshotCount,
      conflictCount: this.settings.conflicts.length,
      error: this.error,
    };
  }

  async start(): Promise<void> {
    if (!this.settings.directory || this.settings.paused) return;
    this.markDirty();
    this.poller = setInterval(() => this.markDirty(), this.options.pollMilliseconds ?? 5_000);
    this.poller.unref();
    await this.drain();
  }

  async configure(parentDirectory: string, deviceId: string): Promise<SyncStatus> {
    this.assertOpen();
    if (!isAbsolute(parentDirectory)) {
      throw new AppError('bad_request', 'Shared folder must be an absolute path', 400);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(deviceId)) {
      throw new AppError(
        'bad_request',
        'Device ID must use lowercase letters, numbers, and hyphens',
        400,
      );
    }
    try {
      if (!statSync(parentDirectory).isDirectory()) throw new Error('not a directory');
      accessSync(parentDirectory, constants.W_OK);
    } catch {
      throw new AppError(
        'bad_request',
        'Shared folder must be an existing writable directory',
        400,
      );
    }
    const directory =
      basename(parentDirectory).toLowerCase() === 'pimpampum'
        ? parentDirectory
        : join(parentDirectory, 'Pimpampum');
    const deviceDirectory = join(directory, 'devices', deviceId);
    mkdirSync(deviceDirectory, { recursive: true, mode: 0o700 });
    const existingSequence = readdirSync(deviceDirectory, { withFileTypes: true }).reduce(
      (maximum, file) => {
        if (!file.isFile()) return maximum;
        const match = /^(\d{12})-[0-9a-f-]{36}\.json$/u.exec(file.name);
        return match ? Math.max(maximum, Number(match[1])) : maximum;
      },
      0,
    );
    this.settings = {
      ...this.defaultSettings(),
      directory,
      deviceId,
      paused: false,
      sequence: existingSequence,
    };
    this.writeSettings();
    this.restartPolling();
    await this.reconcile();
    return this.getStatus();
  }

  async reconcile(): Promise<SyncStatus> {
    this.assertOpen();
    if (!this.settings.directory) {
      throw new AppError('invalid_state', 'Synchronization is not configured', 409);
    }
    if (this.settings.paused) return this.getStatus();
    this.dirtyGeneration += 1;
    this.ensureRun();
    await this.drain();
    return this.getStatus();
  }

  markDirty(): void {
    if (this.closed || !this.settings.directory || this.settings.paused) return;
    this.dirtyGeneration += 1;
    this.ensureRun();
  }

  async pause(): Promise<SyncStatus> {
    this.assertConfigured();
    this.settings.paused = true;
    this.writeSettings();
    this.stopPolling();
    await this.drain();
    this.state = 'paused';
    return this.getStatus();
  }

  async resume(): Promise<SyncStatus> {
    this.assertConfigured();
    this.settings.paused = false;
    this.writeSettings();
    this.restartPolling();
    return this.reconcile();
  }

  async forget(): Promise<SyncStatus> {
    this.assertOpen();
    this.stopPolling();
    await this.drain();
    this.settings = this.defaultSettings();
    this.writeSettings();
    this.state = 'disabled';
    this.error = null;
    this.pendingSnapshotCount = 0;
    return this.getStatus();
  }

  listConflicts(): SyncConflict[] {
    return structuredClone(this.settings.conflicts);
  }

  hasConflict(entityType: SyncConflict['entityType'], entityId: string): boolean {
    return this.settings.conflicts.some(
      (conflict) => conflict.entityType === entityType && conflict.entityId === entityId,
    );
  }

  async resolveConflict(conflictId: string, choice: 'local' | 'remote'): Promise<SyncStatus> {
    this.assertConfigured();
    const conflict = this.settings.conflicts.find((candidate) => candidate.id === conflictId);
    if (!conflict)
      throw new AppError('not_found', `Sync conflict ${conflictId} was not found`, 404);
    const state = normalizedSyncState(this.options.snapshotter());
    const collections = {
      workspace: 'workspaces',
      project: 'projects',
      spec: 'specs',
      context: 'contexts',
      task: 'tasks',
    } as const;
    const collection = collections[conflict.entityType];
    const selected = choice === 'local' ? conflict.local : conflict.remote;
    state[collection] = state[collection].filter(
      (entity) => entity.id !== conflict.entityId,
    ) as never;
    if (selected !== null) (state[collection] as unknown[]).push(selected);
    const validated = normalizedSyncState(syncStateSchema.parse(state));
    this.options.importer(validated);
    this.settings.conflicts = this.settings.conflicts.filter(
      (candidate) => candidate.id !== conflictId,
    );
    this.settings.pendingResolutions.push({
      entityType: conflict.entityType,
      entityId: conflict.entityId,
    });
    this.settings.baseState = validated;
    this.settings.lastPublishedHash = null;
    this.writeSettings();
    this.markDirty();
    await this.drain();
    return this.getStatus();
  }

  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.stopPolling();
    await this.drain();
    this.closed = true;
  }

  private ensureRun(): void {
    if (this.running || this.closed || this.settings.paused || !this.settings.directory) return;
    this.running = Promise.resolve()
      .then(() => this.runLoop())
      .finally(() => {
        this.running = null;
        if (this.completedGeneration < this.dirtyGeneration) this.ensureRun();
      });
  }

  private async runLoop(): Promise<void> {
    while (this.completedGeneration < this.dirtyGeneration && !this.closed) {
      const generation = this.dirtyGeneration;
      this.lastAttemptAt = this.clock().toISOString();
      try {
        const complete = await this.importPending();
        if (!complete) {
          this.state = 'pending';
          this.completedGeneration = generation;
          continue;
        }
        await this.publish();
        this.state = 'healthy';
        this.error = null;
      } catch (error) {
        this.state = this.sharedDirectoryAvailable() ? 'error' : 'unavailable';
        this.error = safeError(error);
      }
      this.completedGeneration = generation;
    }
  }

  private async importPending(): Promise<boolean> {
    const directory = this.requiredDirectory();
    this.state = 'importing';
    const applied = new Set(this.settings.appliedSnapshotIds);
    const paths: Array<{ path: string; deviceId: string; sequence: number; snapshotId: string }> =
      [];
    for (const device of readdirSync(join(directory, 'devices'), { withFileTypes: true })) {
      if (!device.isDirectory()) continue;
      for (const file of readdirSync(join(directory, 'devices', device.name), {
        withFileTypes: true,
      })) {
        const match = /^(\d{12})-([0-9a-f-]{36})\.json$/u.exec(file.name);
        if (file.isFile() && match) {
          paths.push({
            path: join(directory, 'devices', device.name, file.name),
            deviceId: device.name,
            sequence: Number(match[1]),
            snapshotId: match[2] as string,
          });
        }
      }
    }
    const pathBySnapshotId = new Map(paths.map((entry) => [entry.snapshotId, entry]));
    const snapshots = paths
      .filter(
        ({ deviceId, sequence, snapshotId }) =>
          !applied.has(snapshotId) && sequence > (this.settings.deviceSequences[deviceId] ?? 0),
      )
      .map(({ path, deviceId }) => this.readSnapshot(path, deviceId));
    const sequenceOwners = new Set<string>();
    for (const snapshot of snapshots) {
      const key = `${snapshot.deviceId}:${snapshot.sequence}`;
      if (sequenceOwners.has(key)) {
        throw new AppError('bad_request', 'Shared device sequence is duplicated', 400);
      }
      sequenceOwners.add(key);
    }
    this.pendingSnapshotCount = snapshots.length;
    const pending = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
    const loaded = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
    const loadSnapshot = (snapshotId: string): SyncSnapshot | undefined => {
      const known = loaded.get(snapshotId);
      if (known) return known;
      const entry = pathBySnapshotId.get(snapshotId);
      if (!entry) return undefined;
      const snapshot = this.readSnapshot(entry.path, entry.deviceId);
      loaded.set(snapshotId, snapshot);
      return snapshot;
    };
    while (pending.size > 0) {
      const ready = [...pending.values()]
        .filter((snapshot) => snapshot.parentSnapshots.every((parent) => applied.has(parent)))
        .sort(
          (left, right) =>
            left.deviceId.localeCompare(right.deviceId) || left.sequence - right.sequence,
        )[0];
      if (!ready) return false;
      const snapshot = ready;
      const settingsBeforeImport = structuredClone(this.settings);
      try {
        const local = normalizedSyncState(this.options.snapshotter());
        const parents = snapshot.parentSnapshots.map(loadSnapshot);
        if (parents.some((parent) => parent === undefined)) return false;
        const parentStates = (parents as SyncSnapshot[]).map((parent) => parent.state);
        const base = parentStates.reduce(
          (combined, parent) => mergeSyncStates(EMPTY_STATE, combined, parent).state,
          EMPTY_STATE,
        );
        const merged = mergeSyncStates(base, local, snapshot.state);
        const resolutions = snapshot.resolutions ?? [];
        const resolutionKeys = new Set(
          resolutions.map(({ entityType, entityId }) => `${entityType}:${entityId}`),
        );
        this.settings.conflicts = this.settings.conflicts.filter(
          ({ entityType, entityId }) => !resolutionKeys.has(`${entityType}:${entityId}`),
        );
        const resolvedState = this.applyResolutions(merged.state, snapshot.state, resolutions);
        const at = this.clock().toISOString();
        const knownConflicts = new Set(this.settings.conflicts.map((conflict) => conflict.id));
        for (const conflict of merged.conflicts) {
          if (resolutionKeys.has(`${conflict.entityType}:${conflict.entityId}`)) continue;
          const id = conflictId(conflict);
          if (!knownConflicts.has(id)) {
            this.settings.conflicts.push({ id, ...conflict, createdAt: at });
            knownConflicts.add(id);
          }
        }
        const protectedState = preserveConflictedEntities(resolvedState, local, [
          ...this.settings.conflicts,
          ...merged.conflicts.filter(
            ({ entityType, entityId }) => !resolutionKeys.has(`${entityType}:${entityId}`),
          ),
        ]);
        this.options.importer(protectedState);
        this.settings.baseState = protectedState;
        this.settings.appliedSnapshotIds.push(snapshot.snapshotId);
        applied.add(snapshot.snapshotId);
        pending.delete(snapshot.snapshotId);
        this.settings.deviceSequences[snapshot.deviceId] = snapshot.sequence;
        this.settings.headSnapshotIds = this.nextHeads(snapshot);
        this.lastImportAt = at;
        this.pendingSnapshotCount -= 1;
        this.writeSettings();
      } catch (error) {
        this.settings = settingsBeforeImport;
        throw error;
      }
    }
    return true;
  }

  private async publish(): Promise<void> {
    const directory = this.requiredDirectory();
    const deviceId = this.settings.deviceId as string;
    const state = normalizedSyncState(this.options.snapshotter());
    const stateHash = syncHash(state);
    if (stateHash === this.settings.lastPublishedHash) return;
    const sequence = this.settings.sequence + 1;
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      snapshotId: randomUUID(),
      deviceId,
      sequence,
      createdAt: this.clock().toISOString(),
      parentSnapshots: [...this.settings.headSnapshotIds],
      ...(this.settings.pendingResolutions.length > 0
        ? { resolutions: [...this.settings.pendingResolutions] }
        : {}),
      stateHash,
      state,
    };
    this.state = 'exporting';
    const deviceDirectory = join(directory, 'devices', deviceId);
    mkdirSync(deviceDirectory, { recursive: true, mode: 0o700 });
    const finalPath = join(
      deviceDirectory,
      `${String(sequence).padStart(12, '0')}-${snapshot.snapshotId}.json`,
    );
    const partialPath = join(deviceDirectory, `.${snapshot.snapshotId}.partial`);
    try {
      writeFileSync(partialPath, `${canonicalJson(snapshot)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      chmodSync(partialPath, 0o600);
      renameSync(partialPath, finalPath);
    } finally {
      rmSync(partialPath, { force: true });
    }
    this.settings.sequence = sequence;
    this.settings.appliedSnapshotIds.push(snapshot.snapshotId);
    this.settings.headSnapshotIds = [snapshot.snapshotId];
    this.settings.baseState ??= state;
    this.settings.lastPublishedHash = stateHash;
    this.settings.pendingResolutions = [];
    this.lastExportAt = snapshot.createdAt;
    this.writeSettings();
  }

  private readSnapshot(path: string, expectedDeviceId?: string): SyncSnapshot {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SNAPSHOT_BYTES) {
      throw new AppError('bad_request', 'Shared snapshot is not a bounded regular file', 400);
    }
    const snapshot = parseSyncSnapshot(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    if (expectedDeviceId !== undefined && snapshot.deviceId !== expectedDeviceId) {
      throw new AppError('bad_request', 'Shared snapshot is outside its device namespace', 400);
    }
    if (snapshot.stateHash !== syncHash(snapshot.state)) {
      throw new AppError('bad_request', 'Shared snapshot hash does not match its state', 400);
    }
    return snapshot;
  }

  private nextHeads(snapshot: SyncSnapshot): string[] {
    const parents = new Set(snapshot.parentSnapshots);
    return [
      ...this.settings.headSnapshotIds.filter((head) => !parents.has(head)),
      snapshot.snapshotId,
    ]
      .filter((head, index, values) => values.indexOf(head) === index)
      .sort();
  }

  private applyResolutions(
    target: SyncState,
    source: SyncState,
    resolutions: Array<Pick<SyncConflict, 'entityType' | 'entityId'>>,
  ): SyncState {
    const result = structuredClone(target);
    const collections = {
      workspace: 'workspaces',
      project: 'projects',
      spec: 'specs',
      context: 'contexts',
      task: 'tasks',
    } as const;
    for (const resolution of resolutions) {
      const collection = collections[resolution.entityType];
      const selected = source[collection].find((entity) => entity.id === resolution.entityId);
      result[collection] = result[collection].filter(
        (entity) => entity.id !== resolution.entityId,
      ) as never;
      if (selected) (result[collection] as unknown[]).push(selected);
    }
    return normalizedSyncState(result);
  }

  private readSettings(): Settings {
    if (!existsSync(this.options.settingsPath)) return this.defaultSettings();
    try {
      const parsed = settingsSchema.parse(
        JSON.parse(readFileSync(this.options.settingsPath, 'utf8')),
      );
      return {
        ...parsed,
        baseState:
          parsed.baseState === null
            ? null
            : normalizedSyncState(syncStateSchema.parse(parsed.baseState)),
        conflicts: parsed.conflicts.map((conflict) => syncConflictSchema.parse(conflict)),
        pendingResolutions: parsed.pendingResolutions ?? [],
        lastPublishedHash: parsed.lastPublishedHash ?? null,
        deviceSequences: parsed.deviceSequences ?? {},
      };
    } catch {
      throw new AppError('internal_error', 'Pimpampum sync settings are invalid', 500);
    }
  }

  private defaultSettings(): Settings {
    return {
      schemaVersion: 1,
      directory: null,
      deviceId: null,
      paused: false,
      sequence: 0,
      appliedSnapshotIds: [],
      headSnapshotIds: [],
      baseState: null,
      conflicts: [],
      pendingResolutions: [],
      lastPublishedHash: null,
      deviceSequences: {},
    };
  }

  private writeSettings(): void {
    mkdirSync(dirname(this.options.settingsPath), { recursive: true, mode: 0o700 });
    const partial = join(
      dirname(this.options.settingsPath),
      `.sync-settings-${randomUUID()}.partial`,
    );
    try {
      writeFileSync(partial, `${JSON.stringify(this.settings, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(partial, this.options.settingsPath);
    } finally {
      rmSync(partial, { force: true });
    }
  }

  private sharedDirectoryAvailable(): boolean {
    try {
      return statSync(this.requiredDirectory()).isDirectory();
    } catch {
      return false;
    }
  }

  private requiredDirectory(): string {
    if (!this.settings.directory)
      throw new AppError('invalid_state', 'Synchronization is not configured', 409);
    return this.settings.directory;
  }

  private assertConfigured(): void {
    this.assertOpen();
    this.requiredDirectory();
  }

  private assertOpen(): void {
    if (this.closed)
      throw new AppError('invalid_state', 'Synchronization controller is closed', 409);
  }

  private stopPolling(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private restartPolling(): void {
    this.stopPolling();
    if (!this.settings.paused) {
      this.poller = setInterval(() => this.markDirty(), this.options.pollMilliseconds ?? 5_000);
      this.poller.unref();
    }
  }
}
