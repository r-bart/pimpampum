import { describe, expect, it } from 'vitest';
import { allOrAggregate, runCompensation, runCompensationSync } from '../src/aggregateRollback.js';

function failing(message: string, order: string[]): () => Promise<void> {
  return async () => {
    order.push(message);
    throw new Error(message);
  };
}

describe('allOrAggregate', () => {
  it('runs every step in order and resolves when none fails', async () => {
    const order: string[] = [];
    await expect(
      allOrAggregate(
        [
          () => {
            order.push('sync');
          },
          async () => {
            order.push('async');
          },
        ],
        'unused',
      ),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['sync', 'async']);
  });

  it('resolves for an empty step list', async () => {
    await expect(allOrAggregate([], 'unused')).resolves.toBeUndefined();
  });

  it('rethrows a single failure as itself after running the remaining steps', async () => {
    const order: string[] = [];
    const failure = new Error('only');
    await expect(
      allOrAggregate(
        [
          async () => {
            order.push('first');
            throw failure;
          },
          () => {
            order.push('second');
          },
        ],
        'unused',
      ),
    ).rejects.toBe(failure);
    expect(order).toEqual(['first', 'second']);
  });

  it('aggregates several failures in step order and normalises thrown non-errors', async () => {
    const order: string[] = [];
    const rejection = allOrAggregate(
      [
        failing('a', order),
        () => {
          order.push('ok');
        },
        () => {
          order.push('b');
          throw 'b';
        },
        failing('c', order),
      ],
      'compensation failed',
    );
    await expect(rejection).rejects.toBeInstanceOf(AggregateError);
    const error = (await rejection.catch((value: unknown) => value)) as AggregateError;
    expect(error.message).toBe('compensation failed');
    expect(error.errors.map((entry: Error) => entry.message)).toEqual(['a', 'b', 'c']);
    expect(error.errors.every((entry: unknown) => entry instanceof Error)).toBe(true);
    expect(order).toEqual(['a', 'ok', 'b', 'c']);
  });
});

describe('runCompensation', () => {
  it('rethrows the original error unchanged when every step succeeds', async () => {
    class Typed extends Error {
      readonly code = 'typed_code';
    }
    const original = new Typed('operation failed');
    const order: string[] = [];
    await expect(
      runCompensation(
        original,
        [
          () => {
            order.push('one');
          },
          async () => {
            order.push('two');
          },
        ],
        'unused',
      ),
    ).rejects.toBe(original);
    expect(order).toEqual(['one', 'two']);
  });

  it('rethrows a non-error original as itself instead of wrapping it', async () => {
    await expect(runCompensation('literal', [], 'unused')).rejects.toBe('literal');
  });

  it('puts the original first and the failed steps after it, in order', async () => {
    const original = new Error('operation failed');
    const order: string[] = [];
    const rejection = runCompensation(
      original,
      [
        failing('rollback a', order),
        () => {
          order.push('rollback ok');
        },
        () => {
          order.push('rollback b');
          throw 'rollback b';
        },
      ],
      'operation and rollback failed',
    );
    const error = (await rejection.catch((value: unknown) => value)) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('operation and rollback failed');
    expect(error.errors[0]).toBe(original);
    expect(error.errors.slice(1).map((entry: Error) => entry.message)).toEqual([
      'rollback a',
      'rollback b',
    ]);
    expect(error.errors[2]).toBeInstanceOf(Error);
    expect(order).toEqual(['rollback a', 'rollback ok', 'rollback b']);
  });

  it('keeps a non-error original as the first aggregate entry', async () => {
    const error = (await runCompensation(
      { code: 'raw' },
      [failing('rollback', [])],
      'failed',
    ).catch((value: unknown) => value)) as AggregateError;
    expect(error.errors[0]).toEqual({ code: 'raw' });
    expect((error.errors[1] as Error).message).toBe('rollback');
  });
});

describe('runCompensationSync', () => {
  it('rethrows the original error unchanged when every step succeeds', () => {
    const original = new Error('operation failed');
    const order: string[] = [];
    expect(() =>
      runCompensationSync(
        original,
        [
          () => {
            order.push('one');
          },
          () => {
            order.push('two');
          },
        ],
        'unused',
      ),
    ).toThrow(original);
    expect(order).toEqual(['one', 'two']);
  });

  it('runs every step and puts the original first and the failed steps after it, in order', () => {
    const original = new Error('operation failed');
    const order: string[] = [];
    let caught: unknown;
    try {
      runCompensationSync(
        original,
        [
          () => {
            order.push('rollback a');
            throw new Error('rollback a');
          },
          () => {
            order.push('rollback ok');
          },
          () => {
            order.push('rollback b');
            throw 'rollback b';
          },
        ],
        'operation and rollback failed',
      );
    } catch (error) {
      caught = error;
    }
    const error = caught as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('operation and rollback failed');
    expect(error.errors[0]).toBe(original);
    expect(error.errors.slice(1).map((entry: Error) => entry.message)).toEqual([
      'rollback a',
      'rollback b',
    ]);
    expect(error.errors[2]).toBeInstanceOf(Error);
    expect(order).toEqual(['rollback a', 'rollback ok', 'rollback b']);
  });
});
