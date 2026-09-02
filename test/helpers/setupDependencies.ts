import { join } from 'node:path';
import { vi } from 'vitest';
import type {
  InstallationLifecycleDependencies,
  SetupCoordinatorDependencies,
} from '../../src/setup/coordinator.js';
import type { InstallationSnapshot } from '../../src/setup/types.js';

type SetupConnector =
  SetupCoordinatorDependencies['connectors'][keyof SetupCoordinatorDependencies['connectors']];

/** One connector fake: not connected, connects without error, verifies available. */
export function setupConnector(overrides: Partial<SetupConnector> = {}): SetupConnector {
  return {
    inspect: vi.fn(async () => ({ state: 'notConnected' })),
    connect: vi.fn(async () => undefined),
    verify: vi.fn(async () => ({ available: true, newSessionRequired: false })),
    restore: vi.fn(async () => undefined),
    ...overrides,
  };
}

export type SetupDependencyOverrides = Partial<Omit<SetupCoordinatorDependencies, 'connectors'>> & {
  connectors?: Partial<SetupCoordinatorDependencies['connectors']>;
};

/**
 * `SetupCoordinatorDependencies` whose every boundary succeeds: the runtime installs `2.0.0`, the
 * service installs and verifies, both connectors connect, and the login item reports `enabled`.
 * The lifecycle lock runs operations inline. `dataDirectory` is `<root>/data`.
 */
export function setupDependencies(
  root: string,
  overrides: SetupDependencyOverrides = {},
): SetupCoordinatorDependencies {
  const { connectors, ...rest } = overrides;
  return {
    lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
    changeTargets: {
      runtimeDirectory: '/runtime',
      servicePath: '/service.plist',
      dataDirectory: '/data',
      connectorConfigPaths: { codex: '/codex.toml', 'claude-code': '/claude.json' },
    },
    runtime: {
      install: vi.fn(async () => ({ version: '2.0.0' })),
      rollback: vi.fn(async () => undefined),
    },
    service: {
      install: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    },
    connectors: {
      codex: connectors?.codex ?? setupConnector(),
      'claude-code': connectors?.['claude-code'] ?? setupConnector(),
    },
    loginItem: { register: vi.fn(async () => 'enabled' as const) },
    dataDirectory: join(root, 'data'),
    now: () => '2026-08-31T09:00:00.000Z',
    ...rest,
  };
}

export interface LifecycleDependencyOverrides {
  /** The installation the receipt describes before the operation. */
  previous?: InstallationSnapshot;
  runtime?: Partial<InstallationLifecycleDependencies['runtime']>;
  service?: Partial<InstallationLifecycleDependencies['service']>;
  connectors?: Partial<InstallationLifecycleDependencies['connectors']>;
  receipt?: Partial<InstallationLifecycleDependencies['receipt']>;
  lifecycleLock?: InstallationLifecycleDependencies['lifecycleLock'];
  migrationStateStore?: InstallationLifecycleDependencies['migrationStateStore'];
  now?: InstallationLifecycleDependencies['now'];
}

export interface LifecycleDependencies extends InstallationLifecycleDependencies {
  /** Boundary calls in invocation order, e.g. `runtime.stage`, `service.stop`, `receipt.commit`. */
  events: string[];
  /** The installation the fakes currently describe; `restore` and `commit` replace it. */
  current: { value: InstallationSnapshot };
  /** The receipt bytes the fakes currently hold; `capture` and `restore` round-trip them. */
  receiptBytes: { value: Buffer };
}

/**
 * `InstallationLifecycleDependencies` backed by recording fakes. The default `previous` snapshot is
 * a legacy npm installation with a Codex `npx` entry, so migration, update and removal tests start
 * from the state the product must leave behind. Every boundary succeeds unless overridden; pass one
 * method inside a group (`{ service: { stop } }`) to replace only that call.
 */
export function lifecycleDependencies(
  root: string,
  overrides: LifecycleDependencyOverrides = {},
): LifecycleDependencies {
  const dataDirectory = join(root, 'data');
  const previous: InstallationSnapshot = overrides.previous ?? {
    runtimeVersion: '1.4.0',
    serviceCommand: ['/usr/local/bin/node', '/usr/local/lib/node_modules/pimpampum/dist/cli.js'],
    connectorEntries: { codex: { command: 'npx', args: ['pimpampum', 'mcp'] } },
    adapter: 'launchd',
    dataDirectory,
    runtimeKind: 'legacy-npm',
  };
  const current = { value: previous };
  const receiptBytes = { value: Buffer.from('{"legacy":"receipt bytes"}\n') };
  const events: string[] = [];
  const record =
    <A extends unknown[], R>(name: string, implementation: (...arguments_: A) => R) =>
    (...arguments_: A): R => {
      events.push(name);
      return implementation(...arguments_);
    };
  return {
    dataDirectory,
    homeDirectory: join(root, 'home'),
    lifecycleLock: overrides.lifecycleLock ?? {
      run: async <T>(operation: () => Promise<T>) => operation(),
    },
    runtime: {
      stage: vi.fn(
        record('runtime.stage', async (version: string) => ({
          version,
          nodePath: join(root, 'runtime', version, 'bin/node'),
          cliPath: join(root, 'runtime', version, 'dist/cli.js'),
        })),
      ),
      activate: vi.fn(record('runtime.activate', async () => undefined)),
      restore: vi.fn(record('runtime.restore', async () => undefined)),
      removeOwned: vi.fn(record('runtime.removeOwned', async () => undefined)),
      finalizeMigration: vi.fn(record('runtime.finalize', async () => undefined)),
      ...overrides.runtime,
    },
    service: {
      stop: vi.fn(record('service.stop', async () => undefined)),
      install: vi.fn(record('service.install', async () => undefined)),
      start: vi.fn(record('service.start', async () => undefined)),
      verify: vi.fn(record('service.verify', async () => undefined)),
      restore: vi.fn(
        record('service.restore', async (snapshot: InstallationSnapshot) => {
          current.value = snapshot;
        }),
      ),
      removeOwned: vi.fn(record('service.removeOwned', async () => undefined)),
      ...overrides.service,
    },
    connectors: {
      reconcileOwned: vi.fn(record('connectors.reconcile', async () => undefined)),
      snapshotOwned: vi.fn(async () => current.value.connectorEntries),
      restoreOwned: vi.fn(
        record('connectors.restore', async (entries: Record<string, unknown>) => {
          current.value = { ...current.value, connectorEntries: entries };
        }),
      ),
      disconnectOwned: vi.fn(record('connectors.disconnectOwned', async () => undefined)),
      ...overrides.connectors,
    },
    receipt: {
      read: vi.fn(async () => current.value),
      capture: vi.fn(async () => ({
        snapshot: current.value,
        contents: Buffer.from(receiptBytes.value),
      })),
      commit: vi.fn(
        record('receipt.commit', async (snapshot: InstallationSnapshot) => {
          current.value = snapshot;
          receiptBytes.value = Buffer.from(JSON.stringify(snapshot));
        }),
      ),
      restore: vi.fn(
        record(
          'receipt.restore',
          async (capture: { snapshot: InstallationSnapshot; contents: Uint8Array }) => {
            current.value = capture.snapshot;
            receiptBytes.value = Buffer.from(capture.contents);
          },
        ),
      ),
      remove: vi.fn(record('receipt.remove', async () => undefined)),
      ...overrides.receipt,
    },
    ...(overrides.migrationStateStore === undefined
      ? {}
      : { migrationStateStore: overrides.migrationStateStore }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    events,
    current,
    receiptBytes,
  };
}
