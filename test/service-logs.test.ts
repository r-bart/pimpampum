import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  restoreServiceLogs,
  rotateServiceLogs,
  SERVICE_LOG_NAMES,
  snapshotServiceLogs,
} from '../src/service/logs.js';

const roots: string[] = [];

function logDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-logs-${label}-`));
  roots.push(root);
  return join(root, 'Logs With Spaces');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('service log rotation', () => {
  it('rotates both streams deterministically with private permissions and bounded retention', () => {
    const directory = logDirectory('rotate');
    mkdirSync(directory, { recursive: true });
    for (const name of SERVICE_LOG_NAMES) {
      const path = join(directory, name);
      writeFileSync(path, `${name}-current`);
      writeFileSync(`${path}.1`, `${name}-one`);
      writeFileSync(`${path}.2`, `${name}-two`);
      writeFileSync(`${path}.3`, `${name}-oldest`);
    }

    const rotated = rotateServiceLogs(directory, 3);
    expect(rotated).toHaveLength(6);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const name of SERVICE_LOG_NAMES) {
      const path = join(directory, name);
      expect(readFileSync(`${path}.1`, 'utf8')).toBe(`${name}-current`);
      expect(readFileSync(`${path}.2`, 'utf8')).toBe(`${name}-one`);
      expect(readFileSync(`${path}.3`, 'utf8')).toBe(`${name}-two`);
      expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
    }
  });

  it('creates an empty private log directory and validates retention and paths', () => {
    const directory = logDirectory('empty');
    expect(rotateServiceLogs(directory)).toEqual([]);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(() => rotateServiceLogs('relative')).toThrow(/absolute path/);
    expect(() => rotateServiceLogs('/tmp/invalid\0path')).toThrow(/absolute path/);
    expect(() => rotateServiceLogs(directory, 0)).toThrow(/between 1 and 20/);
    expect(() => rotateServiceLogs(directory, 21)).toThrow(/between 1 and 20/);
    expect(() => rotateServiceLogs(directory, 1.5)).toThrow(/between 1 and 20/);
  });

  it('refuses symlink log sources and destinations', () => {
    const directory = logDirectory('symlink');
    mkdirSync(directory, { recursive: true });
    const external = join(directory, 'external');
    writeFileSync(external, 'external');
    symlinkSync(external, join(directory, SERVICE_LOG_NAMES[0]));
    expect(() => rotateServiceLogs(directory)).toThrow(/not a regular file/);

    rmSync(join(directory, SERVICE_LOG_NAMES[0]));
    writeFileSync(join(directory, SERVICE_LOG_NAMES[0]), 'current');
    symlinkSync(external, `${join(directory, SERVICE_LOG_NAMES[0])}.1`);
    expect(() => rotateServiceLogs(directory)).toThrow(/not a regular file/);
  });

  it('restores every rotated generation and its original permissions byte-for-byte', () => {
    const directory = logDirectory('rollback-existing');
    mkdirSync(directory, { recursive: true, mode: 0o750 });
    for (const name of SERVICE_LOG_NAMES) {
      const current = join(directory, name);
      writeFileSync(current, `${name}-current`, { mode: 0o640 });
      writeFileSync(`${current}.1`, `${name}-one`, { mode: 0o600 });
      writeFileSync(`${current}.2`, `${name}-oldest`, { mode: 0o620 });
      chmodSync(`${current}.2`, 0o620);
    }
    const snapshot = snapshotServiceLogs(directory, 2);

    rotateServiceLogs(directory, 2);
    for (const name of SERVICE_LOG_NAMES) writeFileSync(join(directory, name), 'failed-run');
    restoreServiceLogs(snapshot);

    expect(statSync(directory).mode & 0o777).toBe(0o750);
    for (const name of SERVICE_LOG_NAMES) {
      const current = join(directory, name);
      expect(readFileSync(current, 'utf8')).toBe(`${name}-current`);
      expect(readFileSync(`${current}.1`, 'utf8')).toBe(`${name}-one`);
      expect(readFileSync(`${current}.2`, 'utf8')).toBe(`${name}-oldest`);
      expect(statSync(current).mode & 0o777).toBe(0o640);
      expect(statSync(`${current}.2`).mode & 0o777).toBe(0o620);
    }
  });

  it('removes a newly created log directory when rolling back a first install', () => {
    const directory = logDirectory('rollback-new');
    const snapshot = snapshotServiceLogs(directory);
    rotateServiceLogs(directory);
    writeFileSync(join(directory, SERVICE_LOG_NAMES[0]), 'failed-run');

    restoreServiceLogs(snapshot);
    expect(() => statSync(directory)).toThrow();

    const neverCreated = snapshotServiceLogs(join(directory, 'never-created'));
    restoreServiceLogs(neverCreated);
  });

  it('validates snapshots before recording any log state', () => {
    const directory = logDirectory('snapshot-invalid');
    expect(() => snapshotServiceLogs(directory, 0)).toThrow(/between 1 and 20/);
    writeFileSync(directory, 'not-a-directory');
    expect(() => snapshotServiceLogs(directory)).toThrow(/not a directory/);
  });
});
