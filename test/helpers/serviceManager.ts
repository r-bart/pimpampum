import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PlatformServiceAdapter,
  PlatformServiceManagerInput,
  RunCommand,
} from '../../src/service/types.js';
import { temporaryDirectory } from './tmp.js';

export interface ServiceTestRoot {
  root: string;
  homeDirectory: string;
  dataDirectory: string;
}

/**
 * A home and data directory pair for the platform-neutral service manager suites. Both names carry
 * spaces and non-ASCII characters so quoting defects surface; the data directory already holds a
 * token and a database the manager must never touch. Removed when the running test finishes.
 */
export function serviceTestRoot(label: string): ServiceTestRoot {
  const root = temporaryDirectory(`pimpampum-service-${label}-`);
  const homeDirectory = join(root, 'Home & Spaces ü');
  const dataDirectory = join(root, 'Pimpampum Data ñ');
  mkdirSync(homeDirectory, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(dataDirectory, 'token'), 'private-token-value');
  writeFileSync(join(dataDirectory, 'pimpampum.sqlite'), 'database-bytes');
  return { root, homeDirectory, dataDirectory };
}

/** Manager input for `root` on darwin with paths that need shell and plist escaping. */
export function serviceManagerInput(
  root: ServiceTestRoot,
  runCommand: RunCommand,
  overrides: Partial<PlatformServiceManagerInput> = {},
): PlatformServiceManagerInput {
  return {
    platform: 'darwin',
    homeDirectory: root.homeDirectory,
    dataDirectory: root.dataDirectory,
    nodePath: '/opt/Pimpampum & Runtime/bin/node',
    cliPath: '/opt/Pimpampum Runtime/dist/<cli>.js',
    version: '1.0.0',
    runCommand,
    ...overrides,
  };
}

/** The systemd artifact path `serviceTestAdapter` owns under `root`. */
export function serviceTestArtifactPath(root: ServiceTestRoot): string {
  return join(root.homeDirectory, '.config', 'systemd', 'user', 'pimpampum.service');
}

/** A Linux adapter with one owned unit file whose hooks all succeed unless overridden. */
export function serviceTestAdapter(
  root: ServiceTestRoot,
  overrides: Partial<PlatformServiceAdapter> = {},
): PlatformServiceAdapter {
  return {
    id: 'test-systemd',
    platform: 'linux',
    artifacts: () => [{ path: serviceTestArtifactPath(root), content: 'service-v1', mode: 0o600 }],
    activate: async () => undefined,
    deactivate: async () => undefined,
    isRunning: async () => true,
    ...overrides,
  };
}
