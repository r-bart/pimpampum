#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHttpClient } from './client.js';
import { runCli } from './cliProgram.js';
import { loadConfig } from './config.js';
import { startServer } from './server.js';

runCli(process.argv.slice(2), {
  createClient: () => createHttpClient(loadConfig()),
  startServer,
  readFile: (path) => readFileSync(path, 'utf8'),
  resolvePath: resolve,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  onSignal: (signal, callback) => process.once(signal, callback),
  exit: (code) => process.exit(code),
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
