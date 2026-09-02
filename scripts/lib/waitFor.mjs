// Bounded polling shared by the live runners. Every loop has a fixed attempt count and interval so
// a stuck host fails instead of hanging.

export function sleep(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * Calls `probe(attempt)` until `options.until(value)` holds (truthiness by default). Resolves
 * `{ satisfied, value }` with the last probed value; never throws on exhaustion.
 */
export async function pollUntil(probe, options = {}) {
  const { attempts = 50, intervalMs = 100, until = Boolean } = options;
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await probe(attempt);
    if (until(value)) return { satisfied: true, value };
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  return { satisfied: false, value };
}

/**
 * Like `pollUntil`, but resolves the satisfying value and throws when the attempts run out. The
 * message comes from `options.timeoutMessage`, a string or a function of the last probed value.
 */
export async function waitFor(probe, options = {}) {
  const { timeoutMessage, ...polling } = options;
  const outcome = await pollUntil(probe, polling);
  if (outcome.satisfied) return outcome.value;
  const message =
    typeof timeoutMessage === 'function'
      ? timeoutMessage(outcome.value)
      : (timeoutMessage ?? `Condition was not met after ${polling.attempts ?? 50} attempts`);
  throw new Error(message);
}

/**
 * Calls `operation(attempt)` until it resolves, sleeping between failures. The last error is
 * rethrown once the attempts run out.
 */
export async function retry(operation, options = {}) {
  const { attempts = 100, intervalMs = 100 } = options;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw lastError;
}
