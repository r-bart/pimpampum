import type Database from 'better-sqlite3';
import { AppError } from '../errors.js';
import type { SyncEntityKind } from '../syncContract.js';

export type SyncConflictGuard = (entityType: SyncEntityKind, entityId: string) => boolean;

/** Tables whose rows carry `revision` and `updated_at`. */
export type RevisionedTable = 'projects' | 'specs' | 'tasks' | 'context_documents';

export interface ActivityEventInput {
  workspaceId: string | null;
  projectId: string | null;
  specId: string | null;
  targetType: string;
  targetId: string;
  eventType: string;
  actor: string | null;
  data: Record<string, unknown>;
}

interface CountRow {
  count: number;
}

export function requireRow<T>(row: T | null | undefined, message: string): T {
  if (row == null) throw new AppError('not_found', message, 404);
  return row;
}

/**
 * What every aggregate module shares: the connection, the clock, the write
 * transaction, the mutation counter, the sync conflict guard, the activity
 * writer and the row helpers. Aggregates are plain functions over this object,
 * so no module needs another one's `this`.
 */
export class StoreContext {
  private mutations = 0;
  constructor(
    readonly database: Database.Database,
    private readonly onMutation: () => void,
    private syncConflictGuard: SyncConflictGuard,
    readonly clock: () => Date,
  ) {}

  now(): string {
    return this.clock().toISOString();
  }
  /** Number of committed writes since this store opened; cheap to poll. */
  get mutationCount(): number {
    return this.mutations;
  }
  setSyncConflictGuard(guard: SyncConflictGuard): void {
    this.syncConflictGuard = guard;
  }
  /** Runs `operation` in an IMMEDIATE transaction and counts one committed write. */
  runImmediate<T>(operation: () => T): T {
    const result = this.immediate(operation);
    this.recordMutation();
    return result;
  }
  /** The same transaction when the operation decides itself whether it wrote. */
  immediate<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }
  /** A deferred transaction so a multi-statement read sees one snapshot. */
  read<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }
  recordMutation(): void {
    this.mutations += 1;
    this.onMutation();
  }
  syncWritable(entityType: SyncEntityKind, entityId: string): void {
    if (this.syncConflictGuard(entityType, entityId)) {
      throw new AppError(
        'conflict',
        `Synchronization conflict blocks changes to ${entityType} ${entityId}`,
        409,
      );
    }
  }
  /** Maps a SQLite UNIQUE violation raised inside `operation` to a typed conflict. */
  conflictOnUnique<T>(operation: () => T, message: string): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed'))
        throw new AppError('conflict', message, 409);
      throw error;
    }
  }

  /** One row mapped through `map`, or `not_found` naming `label`. */
  load<R, T>(sql: string, args: unknown[], label: string, map: (row: R) => T): T {
    const row = this.database.prepare(sql).get(...args) as R | undefined;
    return map(requireRow(row, `${label} was not found`));
  }
  rows<R>(sql: string, args: unknown[]): R[] {
    return this.database.prepare(sql).all(...args) as R[];
  }
  /** `sql` is always `SELECT COUNT(*) count …`, which yields exactly one row. */
  count(sql: string, ...args: unknown[]): number {
    return (this.database.prepare(sql).get(...args) as CountRow).count;
  }

  /**
   * The one optimistic write: sets `set`, increments `revision`, stamps
   * `updated_at` with `at`, and fails with `revision_conflict` when the row
   * moved since `expectedRevision` was read.
   */
  bumpRevision(input: {
    table: RevisionedTable;
    id: string;
    expectedRevision: number;
    at: string;
    set: Record<string, string | null>;
  }): void {
    const columns = Object.keys(input.set);
    const result = this.database
      .prepare(
        `UPDATE ${input.table} SET ${columns.map((column) => `${column}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=? AND revision=?`,
      )
      .run(
        ...columns.map((column) => input.set[column]),
        input.at,
        input.id,
        input.expectedRevision,
      );
    if (result.changes === 0)
      throw new AppError('revision_conflict', 'The resource changed before this write', 409, true, {
        currentRevision: input.expectedRevision,
      });
  }
  allowed(reason: string | null): void {
    if (reason !== null) throw new AppError('invalid_state', reason, 409);
  }
  revision(actual: number, expected: number): void {
    if (actual !== expected)
      throw new AppError(
        'revision_conflict',
        `Expected revision ${expected}, current revision is ${actual}`,
        409,
        true,
        { expectedRevision: expected, currentRevision: actual },
      );
  }

  /** Appends one activity event; `at` defaults to the clock and is explicit only on import. */
  writeEvent(input: ActivityEventInput, at = this.now()): void {
    this.database
      .prepare(
        'INSERT INTO activity_events (workspace_id,project_id,spec_id,target_type,target_id,event_type,actor,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        input.workspaceId,
        input.projectId,
        input.specId,
        input.targetType,
        input.targetId,
        input.eventType,
        input.actor,
        JSON.stringify(input.data),
        at,
      );
  }
}
