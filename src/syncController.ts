import { randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';
import { writePrivateFileAtomic } from './fsAtomic.js';
import { assertNoSymlinkTraversal } from './fsGuards.js';
import {
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  parseSyncSnapshot,
  syncConflictSchema,
  syncDeviceIdSchema,
  syncStateSchema,
  type SyncBlockedSnapshot,
  type SyncConflict,
  type SyncGateway,
  type SyncSnapshot,
  type SyncState,
  type SyncStatus,
  type SyncStatusState,
} from './syncContract.js';
import {
  canonicalJson,
  compareCodeUnits,
  mergeSyncStates,
  normalizedSyncState,
  preserveConflictedEntities,
  syncHash,
} from './syncState.js';

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const SNAPSHOT_FILE_PATTERN =
  /^(\d{12})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
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
  deviceId: syncDeviceIdSchema.nullable(),
  paused: z.boolean(),
  sequence: z.number().int().nonnegative(),
  appliedSnapshotIds: z.array(z.string().uuid()),
  headSnapshotIds: z.array(z.string().uuid()),
  // Written by releases before 1.2.13 and never read; accepted for one release.
  baseState: z.unknown().nullable().optional(),
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
  deviceHeads: z.record(z.string(), z.string().uuid()).optional(),
  inheritedSequence: z.number().int().nonnegative().optional(),
});

interface Settings {
  schemaVersion: 1;
  directory: string | null;
  deviceId: string | null;
  paused: boolean;
  sequence: number;
  appliedSnapshotIds: string[];
  headSnapshotIds: string[];
  conflicts: SyncConflict[];
  pendingResolutions: Array<Pick<SyncConflict, 'entityType' | 'entityId'>>;
  lastPublishedHash: string | null;
  /** Newest applied sequence per device; own publishes are not recorded here. */
  deviceSequences: Record<string, number>;
  /** Newest applied snapshot ID per device, including this device's publishes. */
  deviceHeads: Record<string, string>;
  /**
   * The highest sequence already present in this device's directory when it
   * was configured. Files up to it are history to import; a later file this
   * device did not write means another computer shares the device ID.
   */
  inheritedSequence: number;
}

interface SnapshotEntry {
  path: string;
  deviceId: string;
  sequence: number;
  snapshotId: string;
}

interface SyncControllerOptions {
  settingsPath: string;
  snapshotter: () => SyncState;
  importer: (state: SyncState) => void;
  /**
   * Cheap counter the store bumps on every committed write. When it has not
   * moved since the last publish the poll skips the export and hash entirely.
   */
  mutationCounter?: () => number;
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

/**
 * Rejects a snapshot in this device's own directory that this device did not
 * write and that was not there at configuration time: another computer shares
 * the device ID, and retention would later delete files that are not ours.
 */
function assertNoDeviceIdTwin(
  entries: SnapshotEntry[],
  context: {
    applied: Set<string>;
    deviceId: string;
    directory: string;
    inheritedSequence: number;
  },
): void {
  const twin = entries.find(
    (entry) =>
      entry.deviceId === context.deviceId &&
      !context.applied.has(entry.snapshotId) &&
      entry.sequence > context.inheritedSequence,
  );
  if (!twin) return;
  throw new AppError(
    'conflict',
    `Another computer publishes snapshots as device "${context.deviceId}"; run sync forget on each computer and configure a distinct device ID`,
    409,
    false,
    { path: relative(context.directory, twin.path) },
  );
}

/**
 * Keeps the snapshots this device still has to import. A sequence equal to the
 * newest applied one is a sibling written by a recovered device, not a delayed
 * file, so it is admitted; older ones stay ignored because merging them would
 * look like a rollback.
 */
function selectImportCandidates(
  entries: SnapshotEntry[],
  applied: Set<string>,
  deviceSequences: Record<string, number>,
): SnapshotEntry[] {
  return entries.filter(
    (entry) =>
      !applied.has(entry.snapshotId) && entry.sequence >= (deviceSequences[entry.deviceId] ?? 0),
  );
}

/**
 * Picks the next snapshot whose parents are all applied. The order is total and
 * independent of the filesystem: device ID, then sequence, then snapshot ID.
 */
function nextReadySnapshot(
  pending: Map<string, SyncSnapshot>,
  applied: Set<string>,
): SyncSnapshot | undefined {
  return [...pending.values()]
    .filter((snapshot) => snapshot.parentSnapshots.every((parent) => applied.has(parent)))
    .sort(
      (left, right) =>
        compareCodeUnits(left.deviceId, right.deviceId) ||
        left.sequence - right.sequence ||
        compareCodeUnits(left.snapshotId, right.snapshotId),
    )[0];
}

/**
 * Loads a snapshot's parents, and classifies a gap instead of hiding it: a
 * parent whose file exists but failed validation blocks the child, while an
 * absent file only means the provider has not delivered it yet.
 */
function resolveSnapshotParents(
  snapshot: SyncSnapshot,
  entryBySnapshotId: Map<string, SnapshotEntry>,
  load: (entry: SnapshotEntry) => SyncSnapshot | undefined,
  blockedIds: Set<string>,
): { parents: SyncSnapshot[] } | { missing: 'blocked' | 'waiting' } {
  const parents: SyncSnapshot[] = [];
  for (const parentId of snapshot.parentSnapshots) {
    const entry = entryBySnapshotId.get(parentId);
    const parent = entry ? load(entry) : undefined;
    if (!parent) {
      if (!entry) return { missing: 'waiting' };
      blockedIds.add(snapshot.snapshotId);
      return { missing: 'blocked' };
    }
    parents.push(parent);
  }
  return { parents };
}

/**
 * Marks every transitive descendant of a blocked snapshot as blocked and drops
 * it from the pending set, so the status blames the person who must fix the
 * file instead of the provider that already delivered it.
 */
function spreadBlockedDescendants(
  pending: Map<string, SyncSnapshot>,
  blockedIds: Set<string>,
): void {
  let spread = true;
  while (spread) {
    spread = false;
    for (const snapshot of pending.values()) {
      if (snapshot.parentSnapshots.some((parent) => blockedIds.has(parent))) {
        blockedIds.add(snapshot.snapshotId);
        pending.delete(snapshot.snapshotId);
        spread = true;
      }
    }
  }
}

export class SyncController implements SyncGateway {
  private settings: Settings;
  private state: SyncStatusState;
  private lastAttemptAt: string | null = null;
  private lastImportAt: string | null = null;
  private lastExportAt: string | null = null;
  private pendingSnapshotCount = 0;
  private error: string | null = null;
  private blockedSnapshot: SyncBlockedSnapshot | null = null;
  private publishedMutationCount: number | null = null;
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
      blockedSnapshot: this.blockedSnapshot ? { ...this.blockedSnapshot } : null,
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
    if (!syncDeviceIdSchema.safeParse(deviceId).success) {
      throw new AppError(
        'bad_request',
        'Device ID must use lowercase letters, numbers, and hyphens',
        400,
      );
    }
    try {
      const canonicalParent = realpathSync(parentDirectory);
      if (!lstatSync(canonicalParent).isDirectory()) throw new Error('not a directory');
      accessSync(canonicalParent, constants.W_OK);
      parentDirectory = canonicalParent;
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
    assertNoSymlinkTraversal(directory, 'Shared synchronization directory', parentDirectory);
    mkdirSync(deviceDirectory, { recursive: true, mode: 0o700 });
    this.assertSafeDirectory(directory, directory);
    this.assertSafeDirectory(join(directory, 'devices'), directory);
    this.assertSafeDirectory(deviceDirectory, directory);
    const existingSequence = readdirSync(deviceDirectory, { withFileTypes: true }).reduce(
      (maximum, file) => {
        if (!file.isFile()) return maximum;
        const match = SNAPSHOT_FILE_PATTERN.exec(file.name);
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
      inheritedSequence: existingSequence,
    };
    this.blockedSnapshot = null;
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
    this.blockedSnapshot = null;
    this.pendingSnapshotCount = 0;
    return this.getStatus();
  }

  listConflicts(
    input: { limit: number; offset: number } = { limit: 200, offset: 0 },
  ): SyncConflict[] {
    return structuredClone(this.settings.conflicts.slice(input.offset, input.offset + input.limit));
  }

  getConflict(conflictId: string): SyncConflict | null {
    const conflict = this.settings.conflicts.find((candidate) => candidate.id === conflictId);
    return conflict ? structuredClone(conflict) : null;
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
        if (complete) await this.publish();
        const blocked = this.blockedSnapshot;
        if (blocked) {
          // Local state is published when nothing else waits, but the folder
          // needs a human: the status names the file so they can act on it.
          this.state = 'error';
          this.error = `Blocked snapshot ${blocked.path}: ${blocked.reason}`;
        } else if (!complete) {
          this.state = 'pending';
        } else {
          this.state = 'healthy';
          this.error = null;
        }
      } catch (error) {
        this.state = this.sharedDirectoryAvailable() ? 'error' : 'unavailable';
        this.error = safeError(error);
      }
      this.completedGeneration = generation;
    }
  }

  private listSnapshotFiles(directory: string): SnapshotEntry[] {
    const entries: SnapshotEntry[] = [];
    const devicesDirectory = join(directory, 'devices');
    this.assertSafeDirectory(directory, directory);
    this.assertSafeDirectory(devicesDirectory, directory);
    for (const device of readdirSync(devicesDirectory, { withFileTypes: true })) {
      if (device.isSymbolicLink()) {
        throw new AppError('bad_request', 'Shared device directory must not be a symlink', 400);
      }
      if (!device.isDirectory()) continue;
      if (!syncDeviceIdSchema.safeParse(device.name).success) continue;
      const deviceDirectory = join(devicesDirectory, device.name);
      this.assertSafeDirectory(deviceDirectory, directory);
      for (const file of readdirSync(deviceDirectory, {
        withFileTypes: true,
      })) {
        if (file.isSymbolicLink()) {
          throw new AppError('bad_request', 'Shared snapshot must not be a symlink', 400);
        }
        const match = SNAPSHOT_FILE_PATTERN.exec(file.name);
        if (file.isFile() && match) {
          entries.push({
            path: join(deviceDirectory, file.name),
            deviceId: device.name,
            sequence: Number(match[1]),
            snapshotId: match[2] as string,
          });
        }
      }
    }
    if (new Set(entries.map((entry) => entry.snapshotId)).size !== entries.length) {
      throw new AppError('bad_request', 'Shared snapshot ID is duplicated', 400);
    }
    return entries;
  }

  /**
   * Imports every applicable snapshot and returns whether nothing is left
   * waiting on the provider. Files that fail validation are recorded in
   * `blockedSnapshot` and skipped together with their descendants, so one bad
   * file never stops the other devices from converging.
   */
  private async importPending(): Promise<boolean> {
    const directory = this.requiredDirectory();
    const deviceId = this.settings.deviceId as string;
    this.state = 'importing';
    const applied = new Set(this.settings.appliedSnapshotIds);
    const entries = this.listSnapshotFiles(directory);
    const entryBySnapshotId = new Map(entries.map((entry) => [entry.snapshotId, entry]));
    assertNoDeviceIdTwin(entries, {
      applied,
      deviceId,
      directory,
      inheritedSequence: this.settings.inheritedSequence,
    });
    const candidates = selectImportCandidates(entries, applied, this.settings.deviceSequences);
    this.pendingSnapshotCount = candidates.length;
    const blocked: SyncBlockedSnapshot[] = [];
    const blockedIds = new Set<string>();
    const loaded = new Map<string, SyncSnapshot>();
    const load = (entry: SnapshotEntry): SyncSnapshot | undefined => {
      const known = loaded.get(entry.snapshotId);
      if (known) return known;
      try {
        const snapshot = this.readSnapshot(entry.path, entry);
        loaded.set(entry.snapshotId, snapshot);
        return snapshot;
      } catch (error) {
        blocked.push({ path: relative(directory, entry.path), reason: safeError(error) });
        blockedIds.add(entry.snapshotId);
        return undefined;
      }
    };
    const pending = new Map<string, SyncSnapshot>();
    for (const entry of candidates) {
      const snapshot = load(entry);
      if (snapshot) pending.set(snapshot.snapshotId, snapshot);
    }
    let waiting = 0;
    while (pending.size > 0) {
      const snapshot = nextReadySnapshot(pending, applied);
      if (!snapshot) break;
      const resolved = resolveSnapshotParents(snapshot, entryBySnapshotId, load, blockedIds);
      if ('missing' in resolved) {
        if (resolved.missing === 'waiting') waiting += 1;
        pending.delete(snapshot.snapshotId);
        continue;
      }
      this.applyImportedSnapshot(snapshot, resolved.parents, applied, pending);
    }
    // Descendants of a blocked file wait on a person, not on the provider.
    spreadBlockedDescendants(pending, blockedIds);
    waiting += pending.size;
    this.blockedSnapshot =
      blocked.sort((left, right) => compareCodeUnits(left.path, right.path))[0] ?? null;
    if (waiting === 0 && blocked.length === 0) this.compactAppliedSnapshotIds(entries);
    return waiting === 0;
  }

  /**
   * Merges one snapshot on top of its parents, hands the result to the store
   * and records it as applied. Restores the previous settings object on any
   * failure, so a rejected import never leaves a half-written sequence, head
   * or conflict list behind.
   */
  private applyImportedSnapshot(
    snapshot: SyncSnapshot,
    parents: SyncSnapshot[],
    applied: Set<string>,
    pending: Map<string, SyncSnapshot>,
  ): void {
    const settingsBeforeImport = structuredClone(this.settings);
    try {
      const local = normalizedSyncState(this.options.snapshotter());
      const base = parents
        .map((parent) => parent.state)
        .reduce(
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
      this.settings.appliedSnapshotIds.push(snapshot.snapshotId);
      applied.add(snapshot.snapshotId);
      pending.delete(snapshot.snapshotId);
      this.settings.deviceSequences[snapshot.deviceId] = snapshot.sequence;
      this.settings.deviceHeads[snapshot.deviceId] = snapshot.snapshotId;
      this.settings.headSnapshotIds = this.nextHeads(snapshot);
      this.lastImportAt = at;
      this.pendingSnapshotCount -= 1;
      this.writeSettings();
    } catch (error) {
      this.settings = settingsBeforeImport;
      throw error;
    }
  }

  /**
   * Keeps only the applied IDs that still matter: files present in the folder
   * and the current heads. Runs only after a complete import, when no pending
   * snapshot can still name a vanished parent.
   */
  private compactAppliedSnapshotIds(entries: SnapshotEntry[]): void {
    const keep = new Set([
      ...entries.map((entry) => entry.snapshotId),
      ...this.settings.headSnapshotIds,
    ]);
    const compacted = this.settings.appliedSnapshotIds.filter((id) => keep.has(id));
    if (compacted.length === this.settings.appliedSnapshotIds.length) return;
    this.settings.appliedSnapshotIds = compacted;
    this.writeSettings();
  }

  private async publish(): Promise<void> {
    const directory = this.requiredDirectory();
    const deviceId = this.settings.deviceId as string;
    const mutationCount = this.options.mutationCounter?.() ?? null;
    if (
      mutationCount !== null &&
      mutationCount === this.publishedMutationCount &&
      this.settings.lastPublishedHash !== null
    ) {
      // Nothing was committed since the last publish; the poll only imports.
      return;
    }
    const state = normalizedSyncState(this.options.snapshotter());
    const stateHash = syncHash(state);
    if (stateHash === this.settings.lastPublishedHash) {
      this.publishedMutationCount = mutationCount;
      return;
    }
    const sequence = this.settings.sequence + 1;
    const snapshot: SyncSnapshot = {
      schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
      snapshotId: randomUUID(),
      deviceId,
      sequence,
      createdAt: this.clock().toISOString(),
      parentSnapshots: [...this.settings.headSnapshotIds],
      appliedHeads: { ...this.settings.deviceHeads },
      ...(this.settings.pendingResolutions.length > 0
        ? { resolutions: [...this.settings.pendingResolutions] }
        : {}),
      stateHash,
      state,
    };
    this.state = 'exporting';
    const deviceDirectory = join(directory, 'devices', deviceId);
    mkdirSync(deviceDirectory, { recursive: true, mode: 0o700 });
    this.assertSafeDirectory(directory, directory);
    this.assertSafeDirectory(join(directory, 'devices'), directory);
    this.assertSafeDirectory(deviceDirectory, directory);
    const finalPath = join(
      deviceDirectory,
      `${String(sequence).padStart(12, '0')}-${snapshot.snapshotId}.json`,
    );
    writePrivateFileAtomic(finalPath, `${canonicalJson(snapshot)}\n`, {
      mode: 0o600,
      trustedRoot: directory,
      label: 'Shared snapshot file',
    });
    this.settings.sequence = sequence;
    this.settings.appliedSnapshotIds.push(snapshot.snapshotId);
    this.settings.headSnapshotIds = [snapshot.snapshotId];
    this.settings.deviceHeads[deviceId] = snapshot.snapshotId;
    this.settings.lastPublishedHash = stateHash;
    this.settings.pendingResolutions = [];
    this.lastExportAt = snapshot.createdAt;
    this.writeSettings();
    this.publishedMutationCount = mutationCount;
  }

  private readSnapshot(
    path: string,
    expected: SnapshotEntry | Omit<SnapshotEntry, 'path'>,
  ): SyncSnapshot {
    const directory = this.requiredDirectory();
    try {
      assertNoSymlinkTraversal(path, 'Shared snapshot file', directory);
      let descriptor: number | null = null;
      let content: string;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stats = fstatSync(descriptor);
        if (!stats.isFile() || stats.size > MAX_SNAPSHOT_BYTES) {
          throw new AppError('bad_request', 'Shared snapshot is not a bounded regular file', 400);
        }
        const bytes = Buffer.allocUnsafe(stats.size + 1);
        const bytesRead = readSync(descriptor, bytes, 0, bytes.length, 0);
        /* v8 ignore next -- this branch requires an OS-level concurrent file mutation. */
        if (bytesRead !== stats.size) {
          throw new AppError('bad_request', 'Shared snapshot changed while it was being read', 400);
        }
        content = bytes.subarray(0, bytesRead).toString('utf8');
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
      const snapshot = parseSyncSnapshot(JSON.parse(content) as unknown);
      if (
        snapshot.deviceId !== expected.deviceId ||
        snapshot.sequence !== expected.sequence ||
        snapshot.snapshotId !== expected.snapshotId
      ) {
        throw new AppError('bad_request', 'Shared snapshot does not match its filename tuple', 400);
      }
      if (snapshot.stateHash !== syncHash(snapshot.state)) {
        throw new AppError(
          'bad_request',
          snapshot.schemaVersion === SYNC_SNAPSHOT_SCHEMA_VERSION
            ? 'Shared snapshot hash does not match its state'
            : `Shared snapshot hash was computed with a locale-dependent order by an older Pimpampum; upgrade Pimpampum on device "${snapshot.deviceId}" so it republishes`,
          400,
        );
      }
      return snapshot;
    } catch (error) {
      const cause =
        error instanceof AppError
          ? error
          : new AppError('bad_request', `Shared snapshot is unreadable: ${safeError(error)}`, 400);
      throw new AppError(cause.code, cause.message, cause.status, cause.retryable, {
        ...cause.details,
        path: relative(directory, path),
        deviceId: expected.deviceId,
        sequence: expected.sequence,
        snapshotId: expected.snapshotId,
      });
    }
  }

  private nextHeads(snapshot: SyncSnapshot): string[] {
    const parents = new Set(snapshot.parentSnapshots);
    return [
      ...this.settings.headSnapshotIds.filter((head) => !parents.has(head)),
      snapshot.snapshotId,
    ]
      .filter((head, index, values) => values.indexOf(head) === index)
      .sort(compareCodeUnits);
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
        schemaVersion: parsed.schemaVersion,
        directory: parsed.directory,
        deviceId: parsed.deviceId,
        paused: parsed.paused,
        sequence: parsed.sequence,
        appliedSnapshotIds: parsed.appliedSnapshotIds,
        headSnapshotIds: parsed.headSnapshotIds,
        conflicts: parsed.conflicts.map((conflict) => syncConflictSchema.parse(conflict)),
        pendingResolutions: parsed.pendingResolutions ?? [],
        lastPublishedHash: parsed.lastPublishedHash ?? null,
        deviceSequences: parsed.deviceSequences ?? {},
        deviceHeads: parsed.deviceHeads ?? {},
        inheritedSequence: parsed.inheritedSequence ?? 0,
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
      conflicts: [],
      pendingResolutions: [],
      lastPublishedHash: null,
      deviceSequences: {},
      deviceHeads: {},
      inheritedSequence: 0,
    };
  }

  private writeSettings(): void {
    writePrivateFileAtomic(
      this.options.settingsPath,
      `${JSON.stringify(this.settings, null, 2)}\n`,
      {
        mode: 0o600,
        directoryMode: 0o700,
        label: 'Synchronization settings',
      },
    );
  }

  private sharedDirectoryAvailable(): boolean {
    try {
      const directory = this.requiredDirectory();
      this.assertSafeDirectory(directory, directory);
      return true;
    } catch {
      return false;
    }
  }

  private requiredDirectory(): string {
    if (!this.settings.directory)
      throw new AppError('invalid_state', 'Synchronization is not configured', 409);
    return this.settings.directory;
  }

  private assertSafeDirectory(path: string, trustedRoot: string): void {
    try {
      assertNoSymlinkTraversal(path, 'Shared synchronization directory', trustedRoot);
      if (!lstatSync(path).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new AppError(
        'bad_request',
        'Shared synchronization path must contain only regular directories',
        400,
      );
    }
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
    /* v8 ignore next -- every caller (configure, resume) clears `paused` first; the guard is defensive. */
    if (!this.settings.paused) {
      this.poller = setInterval(() => this.markDirty(), this.options.pollMilliseconds ?? 5_000);
      this.poller.unref();
    }
  }
}
