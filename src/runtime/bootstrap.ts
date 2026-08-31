import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import {
  inspectInstalledRuntime,
  installRuntimeTransaction,
  type RuntimeInstallationTransaction,
} from './installer.js';
import { resolveRuntimeLayout } from './layout.js';
import { parseRuntimeManifest } from './manifest.js';
import type {
  RuntimeArchitecture,
  RuntimeInstallation,
  RuntimeManifest,
  RuntimePlatform,
  RuntimeTargetId,
} from './types.js';

const MAXIMUM_MANIFEST_BYTES = 1024 * 1024;
const MAXIMUM_RUNTIME_BYTES = 175 * 1024 * 1024;

export interface PackagedRuntimeBootstrap {
  manifest: RuntimeManifest | null;
  sourceDirectory: string | null;
  sourceApplicationPath: string | null;
  nodePath: string;
  cliPath: string;
  packagedRuntime: {
    version: string;
    target: RuntimeTargetId;
    runtimeDirectory: string;
  };
  prepareInstallation(
    smoke: (installation: RuntimeInstallation) => Promise<void>,
  ): Promise<RuntimeInstallationTransaction>;
}

export interface ResolvePackagedRuntimeBootstrapInput {
  homeDirectory: string;
  dataDirectory: string;
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
  version: string;
  nodePath: string;
  cliPath: string;
}

function regularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const metadata = lstatSync(path);
  return metadata.isFile() && !metadata.isSymbolicLink();
}

function regularDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const metadata = lstatSync(path);
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

function sourceApplicationPath(runtimeRoot: string): string | null {
  const resources = dirname(runtimeRoot);
  if (relative(resources, runtimeRoot) !== 'PimpampumRuntime') return null;
  const contents = dirname(resources);
  if (
    relative(contents, resources) !== 'Resources' ||
    relative(dirname(contents), contents) !== 'Contents'
  ) {
    return null;
  }
  const application = dirname(contents);
  return application.endsWith('.app') ? application : null;
}

/**
 * Detects either a CLI launched directly from a signed payload or the exact receipt-owned CLI
 * selected by an already activated private runtime.
 */
export function resolvePackagedRuntimeBootstrap(
  input: ResolvePackagedRuntimeBootstrapInput,
): PackagedRuntimeBootstrap | null {
  const sourceDirectory = resolve(dirname(input.cliPath), '..');
  const runtimeRoot = dirname(sourceDirectory);
  const manifestPath = join(runtimeRoot, 'runtime-manifest.json');
  if (!existsSync(manifestPath)) {
    const active = inspectInstalledRuntime(input);
    if (active === null) return null;
    if (resolve(input.nodePath) !== active.nodePath || resolve(input.cliPath) !== active.cliPath) {
      return null;
    }
    if (active.version !== input.version) {
      throw new Error('Active packaged runtime version does not match the Pimpampum CLI');
    }
    const installedApplication = join(input.homeDirectory, 'Applications', 'PimpampumMenuBar.app');
    return {
      manifest: null,
      sourceDirectory: null,
      sourceApplicationPath:
        input.platform === 'darwin' && regularDirectory(installedApplication)
          ? installedApplication
          : null,
      nodePath: active.nodePath,
      cliPath: active.cliPath,
      packagedRuntime: {
        version: active.version,
        target: active.targetId,
        runtimeDirectory: active.runtimeDirectory,
      },
      prepareInstallation: async (smoke) => {
        await smoke(active);
        return { installation: active, commit() {}, rollback() {} };
      },
    };
  }
  if (!regularFile(manifestPath) || lstatSync(manifestPath).size > MAXIMUM_MANIFEST_BYTES) {
    throw new Error('Packaged runtime manifest must be a bounded regular file');
  }
  const manifest = parseRuntimeManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, {
    platform: input.platform,
    architecture: input.architecture,
    maximumUnpackedBytes: MAXIMUM_RUNTIME_BYTES,
  });
  if (manifest.pimpampumVersion !== input.version) {
    throw new Error('Packaged runtime version does not match the Pimpampum CLI');
  }
  const expectedNodePath = join(sourceDirectory, ...manifest.entrypoints.node.split('/'));
  const expectedCliPath = join(sourceDirectory, ...manifest.entrypoints.cli.split('/'));
  if (resolve(input.nodePath) !== expectedNodePath || resolve(input.cliPath) !== expectedCliPath) {
    throw new Error('Packaged runtime entrypoints do not match the executing CLI');
  }
  if (!regularFile(expectedNodePath) || !regularFile(expectedCliPath)) {
    throw new Error('Packaged runtime entrypoints must be regular files');
  }
  const layout = resolveRuntimeLayout({
    homeDirectory: input.homeDirectory,
    platform: input.platform,
    architecture: input.architecture,
    version: manifest.pimpampumVersion,
  });
  const nodePath = join(layout.versionDirectory, ...manifest.entrypoints.node.split('/'));
  const cliPath = join(layout.versionDirectory, ...manifest.entrypoints.cli.split('/'));
  return {
    manifest,
    sourceDirectory,
    sourceApplicationPath: sourceApplicationPath(runtimeRoot),
    nodePath,
    cliPath,
    packagedRuntime: {
      version: manifest.pimpampumVersion,
      target: layout.targetId,
      runtimeDirectory: layout.versionDirectory,
    },
    prepareInstallation: (smoke) =>
      installRuntimeTransaction({
        homeDirectory: input.homeDirectory,
        dataDirectory: input.dataDirectory,
        platform: input.platform,
        architecture: input.architecture,
        sourceDirectory,
        manifest,
        smoke,
      }),
  };
}
