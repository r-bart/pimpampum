/**
 * The seam between the CLI composition and the process it runs in. Everything the composition
 * would otherwise read from `process` or `node:os` arrives through `CliHost`, so the whole
 * composition runs under test against a fabricated host and `src/cliMain.ts` stays the only module
 * that touches the real process.
 */
import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { RuntimeConfig } from '../config.js';
import type { RuntimeArchitecture, RuntimePlatform } from '../runtime/types.js';
import type { RunCommand } from '../service/types.js';
import type { PackagedReleaseTarget } from '../update.js';

export interface CliHost {
  platform: NodeJS.Platform;
  arch: string;
  homeDirectory: string;
  /** The Node binary running this CLI; the packaged runtime records it in every receipt. */
  execPath: string;
  /** `dist/cli.js` for a compiled CLI, `src/cli.ts` under the source runner. */
  entryModulePath: string;
  /** The arguments after the entry module, exactly as the CLI receives them. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The effective user id, `undefined` where the platform has none. */
  uid: number | undefined;
  findExecutable(name: string): string | null;
  runCommand: RunCommand;
  createCommandRunner(options: { timeoutMilliseconds: number }): RunCommand;
  config: {
    /** A client's read: never creates the data directory and never mints a token. */
    client(): RuntimeConfig;
    /** The daemon's read: creates the data directory and mints the token when none exists. */
    daemon(): RuntimeConfig;
  };
  stdin: Readable;
  stdout(text: string): void;
  stderr(text: string): void;
  onSignal(signal: 'SIGINT' | 'SIGTERM', callback: () => void): void;
  onExit(callback: () => void): void;
  exit(code: number): never;
  /** Loads the stdio bridge, which binds the process stdin and serves on import. */
  startStdioBridge(): Promise<void>;
}

/** The files the CLI needs beside itself, resolved once from the entry module. */
export interface EntryPaths {
  /** The bin target; also the file the generated LaunchAgent and systemd unit invoke. */
  compiledCliPath: string;
  compiledMcpStdioPath: string;
  /** A checkout's locally built app bundle; an npm install has none and stages one instead. */
  builtMacOSAppPath: string;
  bundledOmarchyPluginPath: string;
}

/**
 * `src/cli.ts` under the source runner resolves to the compiled siblings in `dist/`, so the
 * receipts written from a checkout name the same files an installed copy would.
 */
export function resolveEntryPaths(entryModulePath: string): EntryPaths {
  const directory = dirname(entryModulePath);
  const sourceMode = entryModulePath.endsWith('.ts');
  return {
    compiledCliPath: sourceMode ? resolve(directory, '..', 'dist', 'cli.js') : entryModulePath,
    compiledMcpStdioPath: sourceMode
      ? resolve(directory, '..', 'dist', 'mcpStdio.js')
      : resolve(directory, 'mcpStdio.js'),
    builtMacOSAppPath: resolve(directory, '..', 'platforms', 'macos', 'dist', 'Pimpampum.app'),
    bundledOmarchyPluginPath: resolve(
      directory,
      '..',
      'integrations',
      'omarchy',
      'pimpampum-status',
    ),
  };
}

/** A host the runtime bundle and the release channel both ship for. */
export interface SupportedRuntimeTarget {
  supported: true;
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
  packagedRelease: PackagedReleaseTarget;
}

export type RuntimeTarget = SupportedRuntimeTarget | { supported: false };

/**
 * The packaged runtime exists for `darwin-arm64`, `linux-arm64` and `linux-x64`. Every other host
 * runs the npm install only: no private runtime, no connectors, no guided setup.
 */
const SUPPORTED_RUNTIME_TARGETS: Readonly<Record<string, SupportedRuntimeTarget>> = {
  'darwin-arm64': {
    supported: true,
    platform: 'darwin',
    architecture: 'arm64',
    packagedRelease: 'darwin-arm64',
  },
  'linux-arm64': {
    supported: true,
    platform: 'linux',
    architecture: 'arm64',
    packagedRelease: 'linux-arm64',
  },
  'linux-x64': {
    supported: true,
    platform: 'linux',
    architecture: 'x64',
    packagedRelease: 'linux-x64',
  },
};

export function describeRuntimeTarget(platform: string, arch: string): RuntimeTarget {
  return SUPPORTED_RUNTIME_TARGETS[`${platform}-${arch}`] ?? { supported: false };
}
