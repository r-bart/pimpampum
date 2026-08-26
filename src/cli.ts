#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from './client.js';
import { runCli } from './cliProgram.js';
import { loadConfig } from './config.js';
import { createPlatformServiceManager } from './service/manager.js';
import { createLaunchdAdapter } from './service/launchd.js';
import { createMacOSDesktopAdapter } from './service/macosApp.js';
import { createOmarchyAdapter, isCompatibleOmarchyVersion } from './service/omarchy.js';
import { findExecutable, runServiceCommand } from './service/platform.js';
import { createSystemdAdapter } from './service/systemd.js';
import { startServer } from './server.js';

const config = loadConfig();
const modulePath = fileURLToPath(import.meta.url);
const compiledCliPath = modulePath.endsWith('.ts')
  ? resolve(dirname(modulePath), '..', 'dist', 'cli.js')
  : modulePath;
const hostPlatform = platform();
const bundledMacOSApp = resolve(
  dirname(modulePath),
  '..',
  'platforms',
  'macos',
  'dist',
  'PimpampumMenuBar.app',
);
const bundledOmarchyPlugin = resolve(
  dirname(modulePath),
  '..',
  'integrations',
  'omarchy',
  'pimpampum-status',
);
const omarchyPath = hostPlatform === 'linux' ? findExecutable('omarchy') : null;
const omarchyShellPath = hostPlatform === 'linux' ? findExecutable('omarchy-shell') : null;
const serviceLifecycleRequested = new Set(['install', 'status', 'uninstall']).has(
  process.argv[2] ?? '',
);
const omarchyVersion =
  serviceLifecycleRequested && omarchyPath && omarchyShellPath
    ? await runServiceCommand(omarchyPath, ['--version']).catch(() => null)
    : null;
const useOmarchy =
  omarchyVersion?.exitCode === 0 && isCompatibleOmarchyVersion(omarchyVersion.stdout);
const linuxSystemdAdapter = hostPlatform === 'linux' ? createSystemdAdapter() : null;
const linuxOmarchyAdapter =
  hostPlatform === 'linux' && omarchyPath && omarchyShellPath && linuxSystemdAdapter
    ? createOmarchyAdapter({
        pluginSourcePath: bundledOmarchyPlugin,
        daemonAdapter: linuxSystemdAdapter,
        omarchyPath,
        omarchyShellPath,
      })
    : null;

runCli(process.argv.slice(2), {
  createClient: () => createHttpClient(config),
  serviceManager: createPlatformServiceManager({
    platform: hostPlatform,
    homeDirectory: homedir(),
    dataDirectory: config.dataDirectory,
    nodePath: process.execPath,
    cliPath: compiledCliPath,
    version: '0.1.0',
    host: config.host,
    port: config.port,
    runCommand: runServiceCommand,
    ...(hostPlatform === 'darwin'
      ? {
          adapters: {
            darwin: createMacOSDesktopAdapter({
              appBundlePath: bundledMacOSApp,
              daemonAdapter: createLaunchdAdapter(),
            }),
          },
        }
      : hostPlatform === 'linux' && linuxSystemdAdapter
        ? {
            adapters: {
              linux: useOmarchy && linuxOmarchyAdapter ? linuxOmarchyAdapter : linuxSystemdAdapter,
            },
            receiptAdapters: {
              [linuxSystemdAdapter.id]: linuxSystemdAdapter,
              ...(linuxOmarchyAdapter ? { [linuxOmarchyAdapter.id]: linuxOmarchyAdapter } : {}),
            },
          }
        : {}),
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
