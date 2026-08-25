import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assertNoSymlinkTraversal, writePrivateFileAtomic } from './receipt.js';

export const SERVICE_LOG_NAMES = ['daemon.stdout.log', 'daemon.stderr.log'] as const;

interface LogFileSnapshot {
  path: string;
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

export interface ServiceLogsSnapshot {
  logDirectory: string;
  trustedRoot: string;
  directoryExisted: boolean;
  directoryMode: number | null;
  files: LogFileSnapshot[];
}

function managedLogPaths(logDirectory: string, retainedRotations: number): string[] {
  return SERVICE_LOG_NAMES.flatMap((name) => {
    const current = join(logDirectory, name);
    return [
      current,
      ...Array.from({ length: retainedRotations }, (_, index) => `${current}.${index + 1}`),
    ];
  });
}

function validateRetention(retainedRotations: number): void {
  if (!Number.isInteger(retainedRotations) || retainedRotations < 1 || retainedRotations > 20) {
    throw new Error('Service log retention must be an integer between 1 and 20');
  }
}

function regularFileOrMissing(path: string): void {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Service log target is not a regular file: ${path}`);
  }
}

export function snapshotServiceLogs(
  logDirectory: string,
  retainedRotations = 5,
  trustedRoot = logDirectory,
): ServiceLogsSnapshot {
  validateRetention(retainedRotations);
  assertNoSymlinkTraversal(logDirectory, 'Service log directory', trustedRoot);
  const directoryExisted = existsSync(logDirectory);
  if (directoryExisted && !lstatSync(logDirectory).isDirectory()) {
    throw new Error(`Service log directory is not a directory: ${logDirectory}`);
  }
  const files = managedLogPaths(logDirectory, retainedRotations).map((path): LogFileSnapshot => {
    regularFileOrMissing(path);
    if (!existsSync(path)) return { path, existed: false };
    const metadata = lstatSync(path);
    return {
      path,
      existed: true,
      content: readFileSync(path),
      mode: metadata.mode & 0o777,
    };
  });
  return {
    logDirectory,
    trustedRoot,
    directoryExisted,
    directoryMode: directoryExisted ? lstatSync(logDirectory).mode & 0o777 : null,
    files,
  };
}

export function restoreServiceLogs(snapshot: ServiceLogsSnapshot): void {
  assertNoSymlinkTraversal(snapshot.logDirectory, 'Service log directory', snapshot.trustedRoot);
  for (const file of snapshot.files) {
    if (file.existed) {
      writePrivateFileAtomic(file.path, file.content!, file.mode!, snapshot.trustedRoot);
    } else {
      rmSync(file.path, { force: true });
    }
  }
  if (snapshot.directoryExisted) {
    chmodSync(snapshot.logDirectory, snapshot.directoryMode!);
  } else if (existsSync(snapshot.logDirectory)) {
    rmdirSync(snapshot.logDirectory);
  }
}

export function rotateServiceLogs(
  logDirectory: string,
  retainedRotations = 5,
  trustedRoot = logDirectory,
): string[] {
  if (!isAbsolute(logDirectory) || logDirectory.includes('\0')) {
    throw new Error('Service log directory must be an absolute path');
  }
  validateRetention(retainedRotations);
  assertNoSymlinkTraversal(logDirectory, 'Service log directory', trustedRoot);
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  assertNoSymlinkTraversal(logDirectory, 'Service log directory', trustedRoot);
  chmodSync(logDirectory, 0o700);

  const rotated: string[] = [];
  for (const name of SERVICE_LOG_NAMES) {
    const current = join(logDirectory, name);
    for (let index = retainedRotations; index >= 1; index -= 1) {
      const source = index === 1 ? current : `${current}.${index - 1}`;
      const destination = `${current}.${index}`;
      regularFileOrMissing(source);
      regularFileOrMissing(destination);
      if (!existsSync(source)) continue;
      if (index === retainedRotations) rmSync(destination, { force: true });
      renameSync(source, destination);
      chmodSync(destination, 0o600);
      rotated.push(destination);
    }
  }
  return rotated;
}
