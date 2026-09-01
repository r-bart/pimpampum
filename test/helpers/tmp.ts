import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, onTestFinished } from 'vitest';

/**
 * Temporary directories created outside a test body and not yet removed. The list is module-scoped,
 * so with the default isolated vitest workers it belongs to one test file.
 */
const pendingDirectories: string[] = [];
let hooksRegistered = false;
let exitFallbackRegistered = false;

function remove(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** Removes every pending temporary directory. Safe to call more than once. */
export function removeTemporaryDirectories(): void {
  for (const directory of pendingDirectories.splice(0)) remove(directory);
}

/**
 * Registers `afterEach` and `afterAll` hooks that remove every pending temporary directory. vitest
 * only honours hooks declared while it collects a file, so call this at module scope or inside a
 * `describe` body — never from `beforeAll` or a test. Directories created inside a test or a
 * `beforeEach` do not need it: `temporaryDirectory` binds those to the running test itself.
 */
export function registerTemporaryDirectoryCleanup(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  afterEach(removeTemporaryDirectories);
  afterAll(removeTemporaryDirectories);
}

function bindToRunningTest(directory: string): boolean {
  try {
    onTestFinished(() => remove(directory));
    return true;
  } catch {
    // No test is running: collection time, `beforeAll` or `afterAll`.
    return false;
  }
}

/**
 * Creates a fresh `mkdtemp` directory under the OS temporary root and schedules its removal.
 *
 * Inside a test or a `beforeEach`, the removal runs when that test finishes. Anywhere else the
 * directory joins the pending list, which the hooks from `registerTemporaryDirectoryCleanup` drain;
 * the first call at collection time registers them. A worker-exit fallback removes whatever a
 * `beforeAll` created in a file that never registered the hooks.
 */
export function temporaryDirectory(prefix = 'pimpampum-test-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  if (bindToRunningTest(directory)) return directory;
  pendingDirectories.push(directory);
  if (!hooksRegistered) registerTemporaryDirectoryCleanup();
  if (!exitFallbackRegistered) {
    exitFallbackRegistered = true;
    process.once('exit', removeTemporaryDirectories);
  }
  return directory;
}
