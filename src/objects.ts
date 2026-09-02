/**
 * Shared value guards. Nine modules carried their own `isRecord` and two their own `asError`; every
 * copy wanted the same strict reading, so the guards live here once and the parsers import them.
 */

/** A plain object: not `null`, not an array. Class instances qualify, primitives never do. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalises a thrown value to an `Error` so aggregates and cause chains stay typed. */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
