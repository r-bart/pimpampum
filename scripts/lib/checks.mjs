// Shared assertion and shape helpers for the evidence checkers and live runners under scripts/.
//
// Every validator takes an optional `fail(message, cause)` so a checker can keep its own message
// prefix (for example "Quattro live evidence at <path> is invalid: ..."). The default throws a
// plain Error.

import { readFileSync } from 'node:fs';

export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** The default failure: throw the message as an Error, attaching the cause when one is given. */
export function throwError(message, cause) {
  throw cause === undefined ? new Error(message) : new Error(message, { cause });
}

/**
 * One named check with one condition and one message. Replaces `invariant(a && b && c, msg)`, which
 * could only ever report that "something" in the conjunction failed.
 */
export function check(name, condition, message) {
  if (condition) return;
  const error = new Error(message);
  error.check = name;
  throw error;
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function record(value, label, fail = throwError) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

/** True when `value` is a record whose own keys are exactly `keys` (order-insensitive). */
export function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function exactObject(value, keys, label, fail = throwError) {
  record(value, label, fail);
  if (!exactKeys(value, keys)) {
    fail(`${label} must contain exactly: ${[...keys].sort().join(', ')}`);
  }
  return value;
}

export function isSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

export function digest(value, label, fail = throwError) {
  if (!isSha256(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

/** A canonical ISO-8601 instant with millisecond precision, as `Date#toISOString` prints it. */
export function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Returns the parsed epoch milliseconds of a canonical ISO-8601 timestamp. */
export function timestamp(value, label, fail = throwError) {
  if (!isCanonicalTimestamp(value)) fail(`${label} must be a canonical ISO-8601 timestamp`);
  return Date.parse(value);
}

/** Reads and parses a JSON file; a missing or malformed file is reported with its cause. */
export function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Missing or invalid ${label} at ${path}`, { cause: error });
  }
}

/** Parses JSON text; the caller's `fail` receives the label and the parse error as its cause. */
export function parseJson(text, label, fail = throwError) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fail(`${label} is not valid JSON`, error);
  }
}
