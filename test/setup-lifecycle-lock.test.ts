import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIFECYCLE_LOCK_FILE_NAME, createSetupLifecycleLock } from '../src/lifecycleLock.js';
import { createSetupLifecycleLock as reexported } from '../src/setup/state.js';

const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-lifecycle-lock-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared lifecycle lock', () => {
  it('is one module for the setup and service layers', () => {
    expect(reexported).toBe(createSetupLifecycleLock);
    expect(LIFECYCLE_LOCK_FILE_NAME).toBe('.setup-lifecycle.lock');
  });

  it('re-enters a nested run and a nested acquire within the same call chain', async () => {
    const data = join(temporaryDirectory(), 'data');
    const lockPath = join(data, LIFECYCLE_LOCK_FILE_NAME);
    const outer = createSetupLifecycleLock(data, {
      timeoutMilliseconds: 200,
      retryMilliseconds: 5,
    });
    const inner = createSetupLifecycleLock(data, {
      timeoutMilliseconds: 200,
      retryMilliseconds: 5,
    });
    const result = await outer.run(async () => {
      expect(existsSync(lockPath)).toBe(true);
      const nested = await inner.run(async () => 'nested');
      const release = await inner.acquire();
      release();
      release();
      expect(existsSync(lockPath)).toBe(true);
      return nested;
    });
    expect(result).toBe('nested');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('holds an acquired lock across calls until its idempotent release', async () => {
    const data = join(temporaryDirectory(), 'data');
    const lockPath = join(data, LIFECYCLE_LOCK_FILE_NAME);
    const lock = createSetupLifecycleLock(data, { timeoutMilliseconds: 50, retryMilliseconds: 5 });
    const release = await lock.acquire();
    expect(existsSync(lockPath)).toBe(true);
    // An independent call chain in the same process contends for the file and times out.
    await expect(
      createSetupLifecycleLock(data, { timeoutMilliseconds: 30, retryMilliseconds: 5 }).run(
        async () => 'must not run',
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409, retryable: true });
    release();
    release();
    expect(existsSync(lockPath)).toBe(false);
    await expect(lock.run(async () => 'after release')).resolves.toBe('after release');
  });

  it('keeps independent concurrent runs in one process serialized', async () => {
    const data = join(temporaryDirectory(), 'data');
    const lock = createSetupLifecycleLock(data, {
      timeoutMilliseconds: 1_000,
      retryMilliseconds: 5,
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = lock.run(async () => {
      events.push('first:start');
      await held;
      events.push('first:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = lock.run(async () => {
      events.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });
});
