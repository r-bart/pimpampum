// Pimpampum CLI success is always exactly one {"data": ...} object (`print` in src/cliProgram.ts).
// The live runners and the evidence checkers unwrap that envelope here instead of silently reading
// undefined fields off it.

import { isRecord, throwError } from './checks.mjs';

/** True for a record whose only key is `data`. */
export function isCliEnvelope(value) {
  return isRecord(value) && Object.keys(value).length === 1 && 'data' in value;
}

/** Parses `text` as one JSON object; anything else is `${label} returned invalid JSON`. */
export function parseJsonObject(text, label) {
  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new Error('not object');
    return value;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

/**
 * Unwraps the CLI envelope from raw stdout and returns its object payload. Every failure names the
 * command through `label` so the live transcript stays diagnosable.
 */
export function parseCliEnvelope(stdout, label) {
  const envelope = parseJsonObject(stdout, label);
  if (!isCliEnvelope(envelope)) throw new Error(`${label} did not return one data envelope`);
  const data = envelope.data;
  if (!isRecord(data)) throw new Error(`${label} returned a non-object data payload`);
  return data;
}

/**
 * Unwraps an already-parsed envelope for a validator that supplies its own `fail`. Unlike
 * `parseCliEnvelope`, the payload may be any JSON value: the caller decides its shape.
 */
export function unwrapCliEnvelope(value, label, fail = throwError) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  if (!isCliEnvelope(value)) fail(`${label} must be one data envelope`);
  return value.data;
}

/** Parses probe output that may legitimately be empty; blank stdout yields `null`. */
export function parseOptionalJson(stdout, label = 'baseline probe') {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}
