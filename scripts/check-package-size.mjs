#!/usr/bin/env node

// The npm package is the CLI, the MCP bridge and the Omarchy plugin sources. It must never carry
// the macOS app or its private runtime again (pimpampum@1.2.11 shipped 157 MB unpacked). This gate
// runs `npm pack --dry-run` and fails on the budget or on any forbidden path.
//
//   check-package-size.mjs [--max-bytes <n>]

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MAXIMUM_UNPACKED_BYTES = 10 * 1024 * 1024;
export const FORBIDDEN_PATH_PATTERN = /PimpampumRuntime|Pimpampum\.app/u;

/** Pure evaluation of one `npm pack --json` entry; returns the problems found. */
export function evaluatePackList(entry, options = {}) {
  const maximumUnpackedBytes = options.maximumUnpackedBytes ?? DEFAULT_MAXIMUM_UNPACKED_BYTES;
  const problems = [];
  if (!entry || !Number.isSafeInteger(entry.unpackedSize) || !Array.isArray(entry.files)) {
    return ['npm pack did not describe the package (unpackedSize and files are required)'];
  }
  if (entry.unpackedSize > maximumUnpackedBytes) {
    problems.push(
      `unpacked size ${String(entry.unpackedSize)} bytes exceeds the ${String(maximumUnpackedBytes)} byte budget`,
    );
  }
  for (const file of entry.files) {
    if (typeof file?.path === 'string' && FORBIDDEN_PATH_PATTERN.test(file.path)) {
      problems.push(`forbidden path in package: ${file.path}`);
    }
  }
  return problems;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

export function packDryRun(repositoryRoot = defaultRepositoryRoot) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // The package has `dist` as its main content; measure a real build, never an empty checkout.
  if (!existsSync(join(repositoryRoot, 'dist', 'cli.js'))) {
    run(npm, ['run', 'build'], repositoryRoot);
  }
  // `--ignore-scripts` keeps prepack's stdout out of the JSON; the manifest rewrite prepack performs
  // changes no file list, so the measurement is the one a real publish produces.
  const stdout = run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], repositoryRoot);
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('npm pack --json must describe exactly one package');
  }
  return parsed[0];
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const maxIndex = process.argv.indexOf('--max-bytes');
  const maximumUnpackedBytes =
    maxIndex === -1
      ? DEFAULT_MAXIMUM_UNPACKED_BYTES
      : Number.parseInt(process.argv[maxIndex + 1], 10);
  if (!Number.isSafeInteger(maximumUnpackedBytes) || maximumUnpackedBytes <= 0) {
    throw new Error('--max-bytes must be a positive integer');
  }
  const entry = packDryRun();
  const problems = evaluatePackList(entry, { maximumUnpackedBytes });
  if (problems.length > 0) {
    process.stderr.write(
      `The npm package failed its size gate:\n${problems.map((line) => `  - ${line}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `npm package ${entry.name}@${entry.version}: ${String(entry.entryCount ?? entry.files.length)} files, ${String(entry.unpackedSize)} bytes unpacked, no app or runtime paths.\n`,
  );
}
