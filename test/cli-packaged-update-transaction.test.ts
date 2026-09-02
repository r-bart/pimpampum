import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCliUpdateManager,
  createConcretePackagedProvider,
  createPackagedUpdatePhases,
  resolveCandidateActivation,
  type CliUpdateManagerInput,
} from '../src/cliComposition/packagedUpdateProvider.js';
import { installRuntime } from '../src/runtime/installer.js';
import {
  installReceiptPath,
  readInstallReceipt,
  writeInstallReceipt,
} from '../src/service/receipt.js';
import type { RuntimeManifest } from '../src/runtime/types.js';
import type { PackagedRuntimeMetadata, ServiceManager } from '../src/service/types.js';
import type { InstallationSnapshot } from '../src/setup/types.js';

const roots: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runtime(root: string, version: string) {
  const runtimeRoot = join(root, 'PimpampumRuntime');
  const sourceDirectory = join(runtimeRoot, 'payload');
  const contents = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': `export const version = ${JSON.stringify(version)};\n`,
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': `addon-${version}`,
  };
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(sourceDirectory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: path === 'bin/node' ? 0o755 : 0o644 });
  }
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    pimpampumVersion: version,
    nodeVersion: '24.19.0',
    target: { platform: 'darwin', architecture: 'arm64' },
    unpackedBytes: Object.values(contents).reduce(
      (total, content) => total + Buffer.byteLength(content),
      0,
    ),
    entrypoints: { node: 'bin/node', cli: 'dist/cli.js', mcp: 'dist/mcpStdio.js' },
    files: Object.entries(contents).map(([path, content]) => ({
      path,
      sha256: sha256(content),
      mode: path === 'bin/node' ? 0o755 : 0o644,
      size: Buffer.byteLength(content),
    })),
  };
  writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { runtimeRoot, sourceDirectory, manifest };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-packaged-update-'));
  roots.push(root);
  const homeDirectory = join(root, 'home');
  const dataDirectory = join(root, 'data');
  const applications = join(homeDirectory, 'Applications');
  const installedApp = join(applications, 'Pimpampum.app');
  mkdirSync(installedApp, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(installedApp, 'old-bytes'), 'old-application-bytes');
  const previous = runtime(join(root, 'previous'), '1.1.3');
  const previousInstallation = await installRuntime({
    homeDirectory,
    dataDirectory,
    platform: 'darwin',
    architecture: 'arm64',
    sourceDirectory: previous.sourceDirectory,
    manifest: previous.manifest,
    smoke: async () => undefined,
  });
  writeInstallReceipt(
    installReceiptPath(dataDirectory),
    {
      schemaVersion: 1,
      adapter: 'launchd-macos-app',
      platform: 'darwin',
      version: '1.1.3',
      installationKey: 'a'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z',
      nodePath: previousInstallation.nodePath,
      cliPath: previousInstallation.cliPath,
      dataDirectory,
      baseUrl: 'http://127.0.0.1:7337',
      logDirectory: join(dataDirectory, 'logs'),
      artifacts: [],
      updateProvider: 'packaged-release',
      packagedRuntime: {
        version: '1.1.3',
        target: 'darwin-arm64',
        runtimeDirectory: dirname(dirname(previousInstallation.nodePath)),
      },
    },
    dataDirectory,
  );
  const stagingRoot = mkdtempSync(join(applications, '.pimpampum-update-'));
  const candidatePath = join(stagingRoot, 'candidate');
  const app = join(candidatePath, 'Pimpampum.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'PimpampumMenuBar'), 'binary', { mode: 0o755 });
  const next = runtime(join(app, 'Contents', 'Resources'), '2.0.0');
  const plugin = join(candidatePath, 'pimpampum-status');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'Widget.qml'), 'Item {}\n');
  writeFileSync(
    join(plugin, 'runtime-manifest.json'),
    JSON.stringify({ version: '2.0.0', targets: { 'linux-arm64': {} } }),
  );
  const currentServiceManager: ServiceManager = {
    install: vi.fn(async () => ({ installed: true as const, reconciled: true, receiptPath: '' })),
    status: vi.fn(async () => ({
      installed: true,
      running: true,
      adapter: 'launchd-macos-app',
      version: '1.1.3',
    })),
    uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
  };
  return {
    root,
    homeDirectory,
    dataDirectory,
    installedApp,
    candidatePath,
    previousInstallation,
    next,
    currentServiceManager,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('packaged update transaction', () => {
  it.each([false, true])(
    'activates the candidate private runtime and preserves the previous app on late failure=%s',
    async (lateFailure) => {
      const value = await fixture();
      const createCandidateServiceManager = vi.fn(
        (candidate: {
          version: string;
          nodePath: string;
          cliPath: string;
          packagedRuntime: PackagedRuntimeMetadata;
        }): ServiceManager => ({
          install: vi.fn(async () => {
            mkdirSync(value.installedApp, { recursive: true });
            writeFileSync(join(value.installedApp, 'new-bytes'), 'new-application-bytes');
            writeInstallReceipt(
              installReceiptPath(value.dataDirectory),
              {
                schemaVersion: 1,
                adapter: 'launchd-macos-app',
                platform: 'darwin',
                version: candidate.version,
                installationKey: 'b'.repeat(64),
                installedAt: '2026-08-31T11:00:00.000Z',
                nodePath: candidate.nodePath,
                cliPath: candidate.cliPath,
                dataDirectory: value.dataDirectory,
                baseUrl: 'http://127.0.0.1:7337',
                logDirectory: join(value.dataDirectory, 'logs'),
                artifacts: [],
                updateProvider: 'packaged-release',
                ...(lateFailure ? {} : { packagedRuntime: candidate.packagedRuntime }),
              },
              value.dataDirectory,
            );
            return { installed: true as const, reconciled: true, receiptPath: '' };
          }),
          status: vi.fn(async () => ({
            installed: true,
            running: true,
            adapter: 'launchd-macos-app',
            version: '2.0.0',
          })),
          uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
        }),
      );
      const provider = createConcretePackagedProvider({
        currentVersion: '1.1.3',
        dataDirectory: value.dataDirectory,
        homeDirectory: value.homeDirectory,
        target: 'darwin-arm64',
        nodePath: value.previousInstallation.nodePath,
        npmPath: null,
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
        currentServiceManager: value.currentServiceManager,
        createCandidateServiceManager,
        environment: {},
      });

      const operation = provider.reconcile({
        version: '2.0.0',
        candidatePath: value.candidatePath,
        target: 'darwin-arm64',
        sha256: 'c'.repeat(64),
        signature: 'signature',
      });
      if (lateFailure) {
        await expect(operation).rejects.toThrow(/receipt did not commit/iu);
        expect(readFileSync(join(value.installedApp, 'old-bytes'), 'utf8')).toBe(
          'old-application-bytes',
        );
        expect(existsSync(join(value.installedApp, 'new-bytes'))).toBe(false);
        expect(
          JSON.parse(
            readFileSync(join(value.dataDirectory, 'runtime-install-receipt.json'), 'utf8'),
          ),
        ).toMatchObject({ currentVersion: '1.1.3' });
        expect(
          readInstallReceipt(installReceiptPath(value.dataDirectory), value.dataDirectory),
        ).toMatchObject({ version: '1.1.3', nodePath: value.previousInstallation.nodePath });
        expect(value.currentServiceManager.install).toHaveBeenCalledOnce();
      } else {
        await expect(operation).resolves.toBeUndefined();
        const candidate = createCandidateServiceManager.mock.calls[0]![0];
        expect(candidate.nodePath).toContain('/Runtime/2.0.0/darwin-arm64/bin/node');
        expect(candidate.packagedRuntime).toMatchObject({
          version: '2.0.0',
          target: 'darwin-arm64',
          runtimeDirectory: expect.stringContaining('/Runtime/2.0.0/darwin-arm64'),
        });
        expect(
          readInstallReceipt(installReceiptPath(value.dataDirectory), value.dataDirectory),
        ).toMatchObject({
          version: '2.0.0',
          nodePath: candidate.nodePath,
          updateProvider: 'packaged-release',
          packagedRuntime: candidate.packagedRuntime,
        });
      }
    },
  );
});

/**
 * The phases the reconcile drives, built directly so each guard can be reached out of order. The
 * lifecycle engine never runs them this way; these are the refusals that keep it honest when it
 * does.
 */
describe('packaged update guards', () => {
  function managerInput(
    value: Awaited<ReturnType<typeof fixture>>,
    overrides: Partial<CliUpdateManagerInput> = {},
  ): CliUpdateManagerInput {
    return {
      currentVersion: '1.1.3',
      dataDirectory: value.dataDirectory,
      homeDirectory: value.homeDirectory,
      target: 'darwin-arm64',
      nodePath: value.previousInstallation.nodePath,
      npmPath: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      currentServiceManager: value.currentServiceManager,
      createCandidateServiceManager: () => candidateManager,
      environment: {},
      ...overrides,
    };
  }

  const candidateManager: ServiceManager = {
    install: async () => ({ installed: true as const, reconciled: true, receiptPath: '' }),
    status: async () => ({
      installed: true,
      running: true,
      adapter: 'launchd-macos-app',
      version: '1.1.3',
    }),
    uninstall: async () => ({ uninstalled: true, dataPreserved: true as const }),
  };

  async function guards(overrides: Partial<CliUpdateManagerInput> = {}) {
    const value = await fixture();
    const input = managerInput(value, overrides);
    const candidate = resolveCandidateActivation(input, '2.0.0', value.candidatePath);
    return { value, input, candidate, ...createPackagedUpdatePhases(input, candidate) };
  }

  it('refuses to install over anything but a regular application directory', async () => {
    const { value, phases } = await guards();
    await expect(phases.service.install({ nodePath: '/n', cliPath: '/c' })).rejects.toThrow(
      /backup was not staged/u,
    );
    rmSync(value.installedApp, { recursive: true });
    writeFileSync(value.installedApp, 'not a bundle');
    await expect(phases.service.install({ nodePath: '/n', cliPath: '/c' })).rejects.toThrow(
      /must be a regular directory/u,
    );
  });

  it('refuses a rollback with no receipt snapshot, with a lost backup, and over an unsafe path', async () => {
    const { value, phases, state } = await guards();
    const previous: InstallationSnapshot = {
      runtimeVersion: '1.1.3',
      serviceCommand: [value.previousInstallation.nodePath, value.previousInstallation.cliPath],
      connectorEntries: {},
    };
    // Nothing was moved yet: the previous bundle is removed and the receipt snapshot is missing.
    await expect(phases.service.restore(previous)).rejects.toThrow(
      /receipt rollback snapshot is missing/u,
    );
    expect(existsSync(value.installedApp)).toBe(false);
    // The same call with the bundle already gone takes the other side of the existence check.
    await expect(phases.service.restore(previous)).rejects.toThrow(
      /receipt rollback snapshot is missing/u,
    );

    state.appBackedUp = true;
    state.backupApp = null;
    await expect(phases.service.restore(previous)).rejects.toThrow(/rollback snapshot is missing/u);

    symlinkSync(value.root, value.installedApp);
    await expect(phases.service.restore(previous)).rejects.toThrow(/unsafe to roll back/u);
  });

  it('refuses a candidate service that does not answer with the updated version', async () => {
    const { phases } = await guards();
    await expect(phases.service.verify()).rejects.toThrow(/failed health verification/u);
  });

  it('refuses to read a missing receipt and to commit one that did not land', async () => {
    const { value, phases, candidate } = await guards();
    const receiptPath = installReceiptPath(value.dataDirectory);
    const previous = readFileSync(receiptPath);
    rmSync(receiptPath);
    await expect(phases.receipt.read()).rejects.toThrow(/requires an installation receipt/u);
    writeFileSync(receiptPath, previous, { mode: 0o600 });

    await expect(
      phases.receipt.commit({
        runtimeVersion: '0.0.1',
        serviceCommand: ['/nowhere/node', '/nowhere/cli.js'],
        connectorEntries: {},
      }),
    ).rejects.toThrow(/was not restored exactly/u);

    // The updated receipt is on disk, but no runtime transaction was ever opened to commit.
    writeInstallReceipt(
      receiptPath,
      {
        schemaVersion: 1,
        adapter: 'launchd-macos-app',
        platform: 'darwin',
        version: '2.0.0',
        installationKey: 'b'.repeat(64),
        installedAt: '2026-08-31T11:00:00.000Z',
        nodePath: candidate.nodePath,
        cliPath: candidate.cliPath,
        dataDirectory: value.dataDirectory,
        baseUrl: 'http://127.0.0.1:7337',
        logDirectory: join(value.dataDirectory, 'logs'),
        artifacts: [],
        updateProvider: 'packaged-release',
        packagedRuntime: {
          version: '2.0.0',
          target: 'darwin-arm64',
          runtimeDirectory: candidate.runtimeDirectory,
        },
      },
      value.dataDirectory,
    );
    await expect(
      phases.receipt.commit({
        runtimeVersion: '2.0.0',
        serviceCommand: [candidate.nodePath, candidate.cliPath],
        connectorEntries: {},
      }),
    ).rejects.toThrow(/committed before its runtime was activated/u);
  });
});

describe('packaged update reconcile', () => {
  function provider(
    value: Awaited<ReturnType<typeof fixture>>,
    createCandidateServiceManager: CliUpdateManagerInput['createCandidateServiceManager'],
  ) {
    return createConcretePackagedProvider({
      currentVersion: '1.1.3',
      dataDirectory: value.dataDirectory,
      homeDirectory: value.homeDirectory,
      target: 'darwin-arm64',
      nodePath: value.previousInstallation.nodePath,
      npmPath: null,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      currentServiceManager: value.currentServiceManager,
      createCandidateServiceManager,
      environment: {},
    });
  }

  it('refuses a Linux activation with the plugin remedy and leaves a foreign path alone', async () => {
    const value = await fixture();
    const outside = join(value.root, 'outside-candidate');
    mkdirSync(outside, { recursive: true });
    await expect(
      provider(value, () => value.currentServiceManager).reconcile({
        version: '2.0.0',
        candidatePath: outside,
        target: 'linux-x64',
        sha256: 'c'.repeat(64),
        signature: 'signature',
      }),
    ).rejects.toMatchObject({ code: 'unavailable', details: { remedy: 'pimpampum-bootstrap' } });
    expect(existsSync(outside)).toBe(true);
  });

  it('clears the staging root when the update fails before the application moves', async () => {
    const value = await fixture();
    rmSync(installReceiptPath(value.dataDirectory));
    await expect(
      provider(value, () => value.currentServiceManager).reconcile({
        version: '2.0.0',
        candidatePath: value.candidatePath,
        target: 'darwin-arm64',
        sha256: 'c'.repeat(64),
        signature: 'signature',
      }),
    ).rejects.toThrow(/requires an installation receipt/u);
    expect(existsSync(value.candidatePath)).toBe(false);
    expect(readFileSync(join(value.installedApp, 'old-bytes'), 'utf8')).toBe(
      'old-application-bytes',
    );
  });

  it('restores the previous application when the lifecycle rollback could not', async () => {
    const value = await fixture();
    const symlinkTarget = join(value.root, 'decoy');
    mkdirSync(symlinkTarget);
    await expect(
      provider(value, () => ({
        // Puts a symlink where the bundle belongs, which no rollback may follow.
        install: async () => {
          symlinkSync(symlinkTarget, value.installedApp);
          return { installed: true as const, reconciled: true, receiptPath: '' };
        },
        status: async () => ({
          installed: true,
          running: true,
          adapter: 'launchd-macos-app',
          version: '2.0.0',
        }),
        uninstall: async () => ({ uninstalled: true, dataPreserved: true as const }),
      })).reconcile({
        version: '2.0.0',
        candidatePath: value.candidatePath,
        target: 'darwin-arm64',
        sha256: 'c'.repeat(64),
        signature: 'signature',
      }),
    ).rejects.toThrow(/unsafe to roll back/u);
  });

  it('refuses to build a provider for an unsupported target', async () => {
    const value = await fixture();
    expect(() =>
      createConcretePackagedProvider({
        currentVersion: '1.1.3',
        dataDirectory: value.dataDirectory,
        homeDirectory: value.homeDirectory,
        target: null,
        nodePath: value.previousInstallation.nodePath,
        npmPath: null,
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        currentServiceManager: value.currentServiceManager,
        createCandidateServiceManager: () => value.currentServiceManager,
        environment: {},
      }),
    ).toThrow(/target is unsupported/u);
  });

  it('derives npm from the running Node when no path is injected', async () => {
    const value = await fixture();
    const manager = createCliUpdateManager({
      currentVersion: '1.1.3',
      dataDirectory: value.dataDirectory,
      homeDirectory: value.homeDirectory,
      target: null,
      nodePath: value.previousInstallation.nodePath,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      currentServiceManager: value.currentServiceManager,
      createCandidateServiceManager: () => value.currentServiceManager,
      environment: {},
    });
    expect(manager.check).toBeTypeOf('function');
  });
});
