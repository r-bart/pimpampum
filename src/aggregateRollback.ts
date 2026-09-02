import { asError } from './objects.js';

/**
 * The one rollback ladder. Thirteen sites used to run their compensation steps by hand, each
 * collecting failures into an array and deciding alone when to rethrow the original error and
 * when to wrap everything in an `AggregateError`. Both shapes live here.
 *
 * Every step runs even when an earlier one fails: a compensation that stops at the first failure
 * leaves the later resources in their broken state. Failures are normalised with `asError` so the
 * `errors` array of the aggregate is always typed; the original error is never normalised, so its
 * class and stable code survive for the HTTP, MCP and CLI adapters.
 */

export type CompensationStep = () => Promise<void> | void;

/**
 * Runs every step and returns the failures in step order, normalised to `Error`. For the sites
 * whose final shape is neither of the two below: a rollback that must always surface as one
 * `AggregateError`, or one that records diagnostics before deciding what to throw.
 */
export async function collectFailures(steps: readonly CompensationStep[]): Promise<Error[]> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(asError(error));
    }
  }
  return failures;
}

/**
 * Runs every step. No failure returns; one failure is rethrown as itself; several become one
 * `AggregateError` whose `errors` keep the step order. Use it when no operation failed before the
 * steps ran: adapter `rollbackActivation`, `afterRollback` and shutdown fan-outs.
 */
export async function allOrAggregate(
  steps: readonly CompensationStep[],
  message: string,
): Promise<void> {
  const failures = await collectFailures(steps);
  if (failures.length === 1) throw failures[0]!;
  if (failures.length > 1) throw new AggregateError(failures, message);
}

/**
 * Runs the compensation for an operation that already failed with `original`. When every step
 * succeeds the original error is rethrown unchanged. When any step fails the caller gets one
 * `AggregateError` whose first entry is the original and whose remaining entries are the failed
 * steps in order. The result is `never`, so `await runCompensation(...)` ends a `catch` block.
 */
export async function runCompensation(
  original: unknown,
  steps: readonly CompensationStep[],
  message: string,
): Promise<never> {
  const failures = await collectFailures(steps);
  if (failures.length === 0) throw original;
  throw new AggregateError([original, ...failures], message);
}

export type SyncCompensationStep = () => void;

function collectFailuresSync(steps: readonly SyncCompensationStep[]): Error[] {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      failures.push(asError(error));
    }
  }
  return failures;
}

/**
 * `runCompensation` for operations that are synchronous by contract: the runtime installer renames
 * and restores under the lifecycle lock without a single `await`, and `prepareOwnedRuntimeRemoval`
 * returns its handle synchronously to the CLI. Same shape as the asynchronous form: the original is
 * rethrown unchanged when every step succeeds, otherwise one `AggregateError` leads with it.
 */
export function runCompensationSync(
  original: unknown,
  steps: readonly SyncCompensationStep[],
  message: string,
): never {
  const failures = collectFailuresSync(steps);
  if (failures.length === 0) throw original;
  throw new AggregateError([original, ...failures], message);
}
