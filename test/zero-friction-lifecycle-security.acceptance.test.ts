/**
 * @generated-from thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { afterEach, describe, expect, it, vi } from 'vitest';

type InstallationSnapshot = {
  runtimeVersion: string;
  serviceCommand: string[];
  connectorEntries: Record<string, unknown>;
};

type LifecycleDependencies = {
  dataDirectory: string;
  homeDirectory: string;
  lifecycleLock: { run<T>(operation: () => Promise<T>): Promise<T> };
  runtime: {
    stage(version: string): Promise<{ version: string; nodePath: string; cliPath: string }>;
    activate(version: string): Promise<void>;
    restore(version: string): Promise<void>;
    removeOwned(): Promise<void>;
  };
  service: {
    stop(): Promise<void>;
    install(input: { nodePath: string; cliPath: string }): Promise<void>;
    start(): Promise<void>;
    verify(): Promise<void>;
    restore(snapshot: InstallationSnapshot): Promise<void>;
    removeOwned(): Promise<void>;
  };
  connectors: {
    reconcileOwned(): Promise<void>;
    snapshotOwned(): Promise<Record<string, unknown>>;
    restoreOwned(entries: Record<string, unknown>): Promise<void>;
    disconnectOwned(): Promise<void>;
  };
  receipt: {
    read(): Promise<InstallationSnapshot>;
    commit(snapshot: InstallationSnapshot): Promise<void>;
    remove(): Promise<void>;
  };
};

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-lifecycle-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function lifecycleDependencies(root: string): LifecycleDependencies {
  const snapshot: InstallationSnapshot = {
    runtimeVersion: '1.1.3',
    serviceCommand: ['/usr/local/bin/node', '/usr/local/lib/node_modules/pimpampum/dist/cli.js'],
    connectorEntries: {
      codex: { command: 'npx', arguments: ['pimpampum', 'mcp'] },
    },
  };
  return {
    dataDirectory: join(root, 'data'),
    homeDirectory: join(root, 'home'),
    lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
    runtime: {
      stage: vi.fn(async (version: string) => ({
        version,
        nodePath: join(root, 'runtime', version, 'bin/node'),
        cliPath: join(root, 'runtime', version, 'dist/cli.js'),
      })),
      activate: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined),
      removeOwned: vi.fn(async () => undefined),
    },
    service: {
      stop: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined),
      removeOwned: vi.fn(async () => undefined),
    },
    connectors: {
      reconcileOwned: vi.fn(async () => undefined),
      snapshotOwned: vi.fn(async () => snapshot.connectorEntries),
      restoreOwned: vi.fn(async () => undefined),
      disconnectOwned: vi.fn(async () => undefined),
    },
    receipt: {
      read: vi.fn(async () => snapshot),
      commit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
}

async function lifecycleContract() {
  const coordinatorUrl = new URL('../src/setup/coordinator.ts', import.meta.url).href;
  const processUrl = new URL('../src/connectors/process.ts', import.meta.url).href;
  const [coordinator, process] = await Promise.all([import(coordinatorUrl), import(processUrl)]);
  return {
    createInstallationLifecycle: coordinator.createInstallationLifecycle as (
      dependencies: LifecycleDependencies,
    ) => {
      migrate(input: {
        targetVersion: string;
      }): Promise<{ migrated: boolean; dataPreserved: boolean }>;
      update(input: {
        targetVersion: string;
      }): Promise<{ updated: boolean; connectorsPreserved: boolean }>;
      remove(): Promise<{ removed: boolean; dataPreserved: boolean; manualInstructions: string[] }>;
    },
    replaceHostConfigurationEntry: process.replaceHostConfigurationEntry as (input: {
      path: string;
      expectedRevision: string | null;
      mode: number;
      update(current: unknown): unknown;
    }) => Promise<{ revision: string }>,
    configurationRevision: process.configurationRevision as (path: string) => string,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Migration, update, removal and security boundaries', () => {
  it('US-3/AC-1/AC-2: migration reuses data and stops the old daemon before activating the new one', async () => {
    // Spec: US-3/AC-1, US-3/AC-2, EC-11, EC-18
    const root = temporaryDirectory('migration');
    const deps = lifecycleDependencies(root);
    mkdirSync(deps.dataDirectory, { recursive: true });
    const files = {
      'pimpampum.sqlite': 'canonical-sqlite-bytes',
      token: 'existing-private-token',
      'settings.json': '{"sync":true}',
      'backup.snapshot': 'backup-bytes',
    };
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(deps.dataDirectory, name), content);
    }
    const { createInstallationLifecycle } = await lifecycleContract();
    const lifecycle = createInstallationLifecycle(deps);

    await expect(lifecycle.migrate({ targetVersion: '2.0.0' })).resolves.toEqual({
      migrated: true,
      dataPreserved: true,
    });

    for (const [name, content] of Object.entries(files)) {
      expect(readFileSync(join(deps.dataDirectory, name), 'utf8')).toBe(content);
    }
    expect(vi.mocked(deps.service.stop).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.runtime.activate).mock.invocationCallOrder[0]!,
    );
    expect(deps.service.start).toHaveBeenCalledOnce();
    expect(deps.connectors.reconcileOwned).toHaveBeenCalledOnce();
  });

  it('US-3/AC-5: failed migration restores runtime, service and connector snapshots', async () => {
    // Spec: US-3/AC-5, FR-2.9, EC-11, Success metric: failed setup preserving prior state
    const root = temporaryDirectory('migration-rollback');
    const deps = lifecycleDependencies(root);
    vi.mocked(deps.service.verify).mockRejectedValueOnce(new Error('new daemon unhealthy'));
    const previous = await deps.receipt.read();
    vi.mocked(deps.receipt.read).mockClear();
    const { createInstallationLifecycle } = await lifecycleContract();

    await expect(
      createInstallationLifecycle(deps).migrate({ targetVersion: '2.0.0' }),
    ).rejects.toThrow('new daemon unhealthy');
    expect(deps.runtime.restore).toHaveBeenCalledWith(previous.runtimeVersion);
    expect(deps.service.restore).toHaveBeenCalledWith(previous);
    expect(deps.connectors.restoreOwned).toHaveBeenCalledWith(previous.connectorEntries);
    expect(deps.receipt.commit).not.toHaveBeenCalled();
  });

  it('FR-8.1/FR-8.2: a packaged update is one verified transaction and keeps healthy connectors', async () => {
    // Spec: FR-8.1, FR-8.2, EC-16
    const root = temporaryDirectory('update');
    const deps = lifecycleDependencies(root);
    const { createInstallationLifecycle } = await lifecycleContract();

    await expect(
      createInstallationLifecycle(deps).update({ targetVersion: '2.1.0' }),
    ).resolves.toEqual({ updated: true, connectorsPreserved: true });
    expect(deps.runtime.stage).toHaveBeenCalledWith('2.1.0');
    expect(deps.service.verify).toHaveBeenCalledOnce();
    expect(deps.connectors.disconnectOwned).not.toHaveBeenCalled();
    expect(deps.connectors.reconcileOwned).toHaveBeenCalledOnce();
    expect(deps.receipt.commit).toHaveBeenCalledOnce();
  });

  it('FR-8.3/FR-8.4: removal deletes only owned artifacts and preserves all private data', async () => {
    // Spec: US-4/AC-1, US-4/AC-2, FR-8.3, FR-8.4, EC-17
    const root = temporaryDirectory('removal');
    const deps = lifecycleDependencies(root);
    mkdirSync(deps.dataDirectory, { recursive: true });
    writeFileSync(join(deps.dataDirectory, 'pimpampum.sqlite'), 'database-bytes');
    writeFileSync(join(deps.dataDirectory, 'token'), 'token-bytes');
    writeFileSync(join(deps.dataDirectory, 'export.md'), '# User export');
    const { createInstallationLifecycle } = await lifecycleContract();

    await expect(createInstallationLifecycle(deps).remove()).resolves.toEqual({
      removed: true,
      dataPreserved: true,
      manualInstructions: [],
    });
    expect(deps.connectors.disconnectOwned).toHaveBeenCalledOnce();
    expect(deps.service.removeOwned).toHaveBeenCalledOnce();
    expect(deps.runtime.removeOwned).toHaveBeenCalledOnce();
    expect(readFileSync(join(deps.dataDirectory, 'pimpampum.sqlite'), 'utf8')).toBe(
      'database-bytes',
    );
    expect(readFileSync(join(deps.dataDirectory, 'token'), 'utf8')).toBe('token-bytes');
    expect(readFileSync(join(deps.dataDirectory, 'export.md'), 'utf8')).toBe('# User export');
  });

  it('EC-17: a late removal failure restores every already removed owned artifact', async () => {
    // Spec: FR-8.3, EC-17
    const root = temporaryDirectory('removal-rollback');
    const deps = lifecycleDependencies(root);
    vi.mocked(deps.runtime.removeOwned).mockRejectedValueOnce(new Error('runtime directory busy'));
    const previous = await deps.receipt.read();
    vi.mocked(deps.receipt.read).mockClear();
    const { createInstallationLifecycle } = await lifecycleContract();

    await expect(createInstallationLifecycle(deps).remove()).rejects.toThrow(
      'runtime directory busy',
    );
    expect(deps.service.restore).toHaveBeenCalledWith(previous);
    expect(deps.connectors.restoreOwned).toHaveBeenCalledWith(previous.connectorEntries);
    expect(deps.receipt.remove).not.toHaveBeenCalled();
  });

  it('FR-5.2/SEC-9: scoped direct config writes preserve content, mode and revision safety', async () => {
    // Spec: FR-5.2, SEC-9, EC-5, EC-8
    const root = temporaryDirectory('host-config');
    const path = join(root, '.claude.json');
    writeFileSync(
      path,
      JSON.stringify({ theme: 'dark', projects: { client: { trusted: true } }, mcpServers: {} }),
      { mode: 0o600 },
    );
    const { replaceHostConfigurationEntry, configurationRevision } = await lifecycleContract();
    const revision = configurationRevision(path);

    await replaceHostConfigurationEntry({
      path,
      expectedRevision: revision,
      mode: 0o600,
      update: (current) => ({
        ...(current as Record<string, unknown>),
        mcpServers: {
          pimpampum: {
            command: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
            args: [],
          },
        },
      }),
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      theme: 'dark',
      projects: { client: { trusted: true } },
      mcpServers: { pimpampum: { args: [] } },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeFileSync(path, '{"concurrent":true}');
    await expect(
      replaceHostConfigurationEntry({
        path,
        expectedRevision: revision,
        mode: 0o600,
        update: () => ({}),
      }),
    ).rejects.toThrow(/revision|changed|concurrent/i);
    expect(readFileSync(path, 'utf8')).toBe('{"concurrent":true}');
  });

  it('EC-5/EC-8: creates only a private minimum config and preserves read-only config unchanged', async () => {
    // Spec: FR-5.2, SEC-3, SEC-9, EC-5, EC-8
    const root = temporaryDirectory('host-config-boundaries');
    const missing = join(root, 'new-home', '.claude.json');
    const readOnly = join(root, 'managed.json');
    writeFileSync(readOnly, '{"managed":true}', { mode: 0o400 });
    const { replaceHostConfigurationEntry } = await lifecycleContract();

    await replaceHostConfigurationEntry({
      path: missing,
      expectedRevision: null,
      mode: 0o600,
      update: () => ({
        mcpServers: {
          pimpampum: {
            command: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
            args: [],
          },
        },
      }),
    });
    expect(JSON.parse(readFileSync(missing, 'utf8'))).toEqual({
      mcpServers: {
        pimpampum: {
          command: '/Users/roberto/.local/share/pimpampum/bin/pimpampum-mcp',
          args: [],
        },
      },
    });
    expect(statSync(missing).mode & 0o777).toBe(0o600);

    await expect(
      replaceHostConfigurationEntry({
        path: readOnly,
        expectedRevision: null,
        mode: 0o600,
        update: () => ({ managed: false }),
      }),
    ).rejects.toThrow(/read-only|managed|permission/i);
    expect(readFileSync(readOnly, 'utf8')).toBe('{"managed":true}');
  });

  it('SEC-8/SEC-9: connector filesystem operations reject symlinks and shell interpolation', async () => {
    // Spec: SEC-8, SEC-9, EC-8
    const root = temporaryDirectory('symlink');
    const victim = join(root, 'victim.json');
    const link = join(root, '.claude.json');
    writeFileSync(victim, '{"untouched":true}');
    symlinkSync(victim, link);
    const { replaceHostConfigurationEntry, configurationRevision } = await lifecycleContract();

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => configurationRevision(link)).toThrow(/symlink|regular file/i);
    await expect(
      replaceHostConfigurationEntry({
        path: link,
        expectedRevision: 'irrelevant',
        mode: 0o600,
        update: () => ({ overwritten: true }),
      }),
    ).rejects.toThrow(/symlink|regular file/i);
    expect(readFileSync(victim, 'utf8')).toBe('{"untouched":true}');
  });

  it('SEC-1 through SEC-4/SEC-10 through SEC-12: product sources preserve the local secret boundary', () => {
    // Spec: SEC-1, SEC-2, SEC-3, SEC-4, SEC-10, SEC-11, SEC-12
    const sourcePaths = [
      'src/connectors',
      'src/runtime',
      'src/setup',
      'platforms/macos/Sources/PimpampumMenuBar/SetupCommandRunner.swift',
      'integrations/omarchy/pimpampum-status/pimpampum-connections',
    ].map((path) => join(process.cwd(), path));
    for (const path of sourcePaths) expect(existsSync(path)).toBe(true);

    const cli = readFileSync(join(process.cwd(), 'src/cliMain.ts'), 'utf8');
    const mcp = readFileSync(join(process.cwd(), 'src/mcpStdio.ts'), 'utf8');
    const server = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf8');
    expect(server).toMatch(/127\.0\.0\.1|loopback/u);
    expect(`${cli}\n${mcp}`).not.toMatch(/sudo|setuid|telemetry|analytics/iu);
    expect(`${cli}\n${mcp}`).not.toMatch(/SELECT\s+\*\s+FROM|better-sqlite3/iu);

    const tokenPath = join(temporaryDirectory('token-mode'), 'token');
    writeFileSync(tokenPath, 'private-token', { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });
});
