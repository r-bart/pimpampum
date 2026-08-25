#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from './client.js';
import { runCli } from './cliProgram.js';
import { loadConfig } from './config.js';
import { createPlatformServiceManager } from './service/manager.js';
import { runServiceCommand } from './service/platform.js';
import { startServer } from './server.js';

const config = loadConfig();
const modulePath = fileURLToPath(import.meta.url);
const compiledCliPath = modulePath.endsWith('.ts')
  ? resolve(dirname(modulePath), '..', 'dist', 'cli.js')
  : modulePath;

runCli(process.argv.slice(2), {
  createClient: () => createHttpClient(config),
  serviceManager: createPlatformServiceManager({
    platform: platform(),
    homeDirectory: homedir(),
    dataDirectory: config.dataDirectory,
    nodePath: process.execPath,
    cliPath: compiledCliPath,
    version: '0.1.0',
    host: config.host,
    port: config.port,
    runCommand: runServiceCommand,
  }),
  startServer: () => startServer(config),
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
