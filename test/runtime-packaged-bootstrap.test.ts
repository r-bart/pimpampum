import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolvePackagedRuntimeBootstrap } from '../src/runtime/bootstrap.js';
import { inspectInstalledRuntime } from '../src/runtime/installer.js';
import { createPlatformServiceManager } from '../src/service/manager.js';
import { installReceiptPath, readInstallReceipt } from '../src/service/receipt.js';
import type { RuntimeManifest } from '../src/runtime/types.js';
import type { PlatformServiceAdapter } from '../src/service/types.js';

const roots: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-packaged-bootstrap-'));
  roots.push(root);
  const homeDirectory = join(root, 'home');
  const dataDirectory = join(root, 'data');
  const application = join(root, 'Downloads', 'PimpampumMenuBar.app');
  const runtimeRoot = join(application, 'Contents', 'Resources', 'PimpampumRuntime');
  const sourceDirectory = join(runtimeRoot, 'payload');
  const contents = {
    'bin/node': '#!/bin/sh\nprintf \'{"data":{"name":"pimpampum","version":"1.1.3"}}\\n\'\n',
    'dist/cli.js': 'export const version = "1.1.3";\n',
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'darwin-addon',
  };
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(sourceDirectory, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, content, { mode: path === 'bin/node' ? 0o755 : 0o644 });
  }
  mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    pimpampumVersion: '1.1.3',
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
  writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest)}\n`, {
    mode: 0o644,
  });
  return {
    root,
    homeDirectory,
    dataDirectory,
    application,
    runtimeRoot,
    sourceDirectory,
    nodePath: join(sourceDirectory, manifest.entrypoints.node),
    cliPath: join(sourceDirectory, manifest.entrypoints.cli),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('packaged runtime production bootstrap', () => {
  it('activates stable launchers before a service receipt selects packaged updates', async () => {
    const value = fixture();
    const bootstrap = resolvePackagedRuntimeBootstrap({
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      version: '1.1.3',
      nodePath: value.nodePath,
      cliPath: value.cliPath,
    });
    expect(bootstrap).not.toBeNull();
    expect(bootstrap!.sourceApplicationPath).toBe(value.application);

    const smoke = vi.fn(async ({ nodePath }: { nodePath: string }) => {
      expect(nodePath).toContain('.pimpampum-stage-');
      expect(existsSync(nodePath)).toBe(true);
    });
    const transaction = await bootstrap!.prepareInstallation(smoke);
    const installed = transaction.installation;
    expect(smoke).toHaveBeenCalledOnce();
    expect(readFileSync(installed.mcpLauncherPath, 'utf8')).toContain(installed.nodePath);

    const adapter: PlatformServiceAdapter = {
      id: 'packaged-test',
      platform: 'darwin',
      artifacts: (context) => [
        {
          path: join(context.homeDirectory, 'Library', 'LaunchAgents', 'packaged-test.plist'),
          content: 'service',
          mode: 0o600,
        },
      ],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    };
    const manager = createPlatformServiceManager({
      platform: 'darwin',
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      nodePath: bootstrap!.nodePath,
      cliPath: bootstrap!.cliPath,
      version: '1.1.3',
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      adapters: { darwin: adapter },
      packagedRuntime: bootstrap!.packagedRuntime,
    });
    await manager.install();
    expect(
      readInstallReceipt(installReceiptPath(value.dataDirectory), value.dataDirectory),
    ).toMatchObject({
      nodePath: bootstrap!.nodePath,
      cliPath: bootstrap!.cliPath,
      updateProvider: 'packaged-release',
      packagedRuntime: bootstrap!.packagedRuntime,
    });
    transaction.commit();
  });

  it('recognizes a stable invocation and restores an older activation on rollback', async () => {
    const value = fixture();
    const first = resolvePackagedRuntimeBootstrap({
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      version: '1.1.3',
      nodePath: value.nodePath,
      cliPath: value.cliPath,
    })!;
    const firstTransaction = await first.prepareInstallation(async () => undefined);
    firstTransaction.commit();
    const stableWithoutApp = resolvePackagedRuntimeBootstrap({
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      version: '1.1.3',
      nodePath: first.nodePath,
      cliPath: first.cliPath,
    });
    expect(stableWithoutApp?.sourceApplicationPath).toBeNull();
    expect(
      resolvePackagedRuntimeBootstrap({
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.3',
        nodePath: value.nodePath,
        cliPath: first.cliPath,
      }),
    ).toBeNull();
    expect(() =>
      resolvePackagedRuntimeBootstrap({
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.4',
        nodePath: first.nodePath,
        cliPath: first.cliPath,
      }),
    ).toThrow(/active packaged runtime version/iu);
    const installedApplication = join(value.homeDirectory, 'Applications', 'PimpampumMenuBar.app');
    mkdirSync(installedApplication, { recursive: true, mode: 0o700 });

    const stable = resolvePackagedRuntimeBootstrap({
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      version: '1.1.3',
      nodePath: first.nodePath,
      cliPath: first.cliPath,
    });
    expect(stable).toMatchObject({
      manifest: null,
      sourceDirectory: null,
      sourceApplicationPath: installedApplication,
      nodePath: first.nodePath,
      cliPath: first.cliPath,
      packagedRuntime: { version: '1.1.3', target: 'darwin-arm64' },
    });
    const stableTransaction = await stable!.prepareInstallation(async (installation) => {
      expect(installation.nodePath).toBe(first.nodePath);
    });
    stableTransaction.commit();
    stableTransaction.rollback();
    const stableAdapter: PlatformServiceAdapter = {
      id: 'stable-packaged-test',
      platform: 'darwin',
      artifacts: () => [
        {
          path: join(value.homeDirectory, 'stable-service.fixture'),
          content: 'stable',
          mode: 0o600,
        },
      ],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => true,
    };
    await createPlatformServiceManager({
      platform: 'darwin',
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      nodePath: stable!.nodePath,
      cliPath: stable!.cliPath,
      version: '1.1.3',
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      adapters: { darwin: stableAdapter },
      packagedRuntime: stable!.packagedRuntime,
    }).install();
    expect(
      readInstallReceipt(installReceiptPath(value.dataDirectory), value.dataDirectory),
    ).toMatchObject({
      updateProvider: 'packaged-release',
      packagedRuntime: stable!.packagedRuntime,
    });

    const manifestPath = join(value.runtimeRoot, 'runtime-manifest.json');
    const nextManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeManifest;
    nextManifest.pimpampumVersion = '1.1.4';
    writeFileSync(manifestPath, `${JSON.stringify(nextManifest)}\n`, { mode: 0o644 });
    const next = resolvePackagedRuntimeBootstrap({
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      version: '1.1.4',
      nodePath: value.nodePath,
      cliPath: value.cliPath,
    })!;
    const nextTransaction = await next.prepareInstallation(async () => undefined);
    expect(readFileSync(nextTransaction.installation.mcpLauncherPath, 'utf8')).toContain('1.1.4');

    nextTransaction.rollback();
    expect(readFileSync(firstTransaction.installation.mcpLauncherPath, 'utf8')).toContain('1.1.3');
    expect(
      JSON.parse(readFileSync(join(value.dataDirectory, 'runtime-install-receipt.json'), 'utf8')),
    ).toMatchObject({ currentVersion: '1.1.3', nodePath: first.nodePath });
    expect(
      existsSync(
        join(
          value.homeDirectory,
          'Library/Application Support/Pimpampum/Runtime/1.1.4/darwin-arm64',
        ),
      ),
    ).toBe(false);

    const prepareSourceVersion = async (version: string) => {
      const sourceManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeManifest;
      sourceManifest.pimpampumVersion = version;
      writeFileSync(manifestPath, `${JSON.stringify(sourceManifest)}\n`, { mode: 0o644 });
      return resolvePackagedRuntimeBootstrap({
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        platform: 'darwin' as const,
        architecture: 'arm64' as const,
        version,
        nodePath: value.nodePath,
        cliPath: value.cliPath,
      })!.prepareInstallation(async () => undefined);
    };
    const committedNext = await prepareSourceVersion('1.1.4');
    committedNext.commit();
    const returningToExisting = await prepareSourceVersion('1.1.3');
    expect(returningToExisting.installation.activated).toBe(true);
    returningToExisting.rollback();
    expect(readFileSync(returningToExisting.installation.mcpLauncherPath, 'utf8')).toContain(
      '1.1.4',
    );

    const staleTransaction = await prepareSourceVersion('1.1.3');
    const concurrent = await prepareSourceVersion('1.1.5');
    concurrent.commit();
    expect(() => staleTransaction.rollback()).toThrow(/changed before activation rollback/iu);
    const missingReceiptTransaction = await prepareSourceVersion('1.1.6');
    rmSync(join(value.dataDirectory, 'runtime-install-receipt.json'));
    expect(() => missingReceiptTransaction.rollback()).toThrow(
      /changed before activation rollback/iu,
    );
  });

  it('is neutral outside a payload and rejects manifest/entrypoint substitution', () => {
    const value = fixture();
    expect(
      resolvePackagedRuntimeBootstrap({
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.3',
        nodePath: '/usr/bin/node',
        cliPath: join(value.root, 'dist', 'cli.js'),
      }),
    ).toBeNull();
    expect(() =>
      resolvePackagedRuntimeBootstrap({
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.3',
        nodePath: '/usr/bin/false',
        cliPath: value.cliPath,
      }),
    ).toThrow(/entrypoints do not match/iu);
  });

  it('rejects hostile payload metadata and keeps non-app payload sources neutral', () => {
    const wrongVersion = fixture();
    expect(() =>
      resolvePackagedRuntimeBootstrap({
        homeDirectory: wrongVersion.homeDirectory,
        dataDirectory: wrongVersion.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.4',
        nodePath: wrongVersion.nodePath,
        cliPath: wrongVersion.cliPath,
      }),
    ).toThrow(/version does not match/iu);

    const missingNode = fixture();
    rmSync(missingNode.nodePath);
    expect(() =>
      resolvePackagedRuntimeBootstrap({
        homeDirectory: missingNode.homeDirectory,
        dataDirectory: missingNode.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.3',
        nodePath: missingNode.nodePath,
        cliPath: missingNode.cliPath,
      }),
    ).toThrow(/entrypoints must be regular files/iu);

    const invalidManifest = fixture();
    const manifestPath = join(invalidManifest.runtimeRoot, 'runtime-manifest.json');
    rmSync(manifestPath);
    mkdirSync(manifestPath);
    expect(() =>
      resolvePackagedRuntimeBootstrap({
        homeDirectory: invalidManifest.homeDirectory,
        dataDirectory: invalidManifest.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.3',
        nodePath: invalidManifest.nodePath,
        cliPath: invalidManifest.cliPath,
      }),
    ).toThrow(/bounded regular file/iu);

    for (const [label, destination] of [
      ['name', (value: ReturnType<typeof fixture>) => join(value.root, 'OtherRuntime')],
      ['structure', (value: ReturnType<typeof fixture>) => join(value.root, 'PimpampumRuntime')],
      [
        'suffix',
        (value: ReturnType<typeof fixture>) =>
          join(value.root, 'Contents', 'Resources', 'PimpampumRuntime'),
      ],
    ] as const) {
      const value = fixture();
      const movedRoot = destination(value);
      mkdirSync(dirname(movedRoot), { recursive: true });
      renameSync(value.runtimeRoot, movedRoot);
      const movedSource = join(movedRoot, 'payload');
      const bootstrap = resolvePackagedRuntimeBootstrap({
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.3',
        nodePath: join(movedSource, 'bin/node'),
        cliPath: join(movedSource, 'dist/cli.js'),
      });
      expect(bootstrap?.sourceApplicationPath, label).toBeNull();
    }
  });

  it('fails closed when active receipt-owned runtime entrypoints drift', async () => {
    const activate = async () => {
      const value = fixture();
      const bootstrap = resolvePackagedRuntimeBootstrap({
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        version: '1.1.3',
        nodePath: value.nodePath,
        cliPath: value.cliPath,
      })!;
      const transaction = await bootstrap.prepareInstallation(async () => undefined);
      transaction.commit();
      return { value, bootstrap };
    };
    const input = (value: ReturnType<typeof fixture>) => ({
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      platform: 'darwin' as const,
      architecture: 'arm64' as const,
    });

    const unowned = await activate();
    const unownedReceiptPath = join(unowned.value.dataDirectory, 'runtime-install-receipt.json');
    const unownedReceipt = JSON.parse(readFileSync(unownedReceiptPath, 'utf8')) as Record<
      string,
      unknown
    >;
    unownedReceipt.ownedVersions = [];
    writeFileSync(unownedReceiptPath, `${JSON.stringify(unownedReceipt)}\n`, { mode: 0o600 });
    expect(() => inspectInstalledRuntime(input(unowned.value))).toThrow(/does not own/iu);

    const missing = await activate();
    rmSync(missing.bootstrap.cliPath);
    expect(() => inspectInstalledRuntime(input(missing.value))).toThrow(/entrypoint is missing/iu);

    const linked = await activate();
    rmSync(linked.bootstrap.cliPath);
    symlinkSync(linked.bootstrap.nodePath, linked.bootstrap.cliPath);
    expect(() => inspectInstalledRuntime(input(linked.value))).toThrow(/regular file/iu);

    const nonExecutable = await activate();
    chmodSync(nonExecutable.bootstrap.nodePath, 0o644);
    expect(() => inspectInstalledRuntime(input(nonExecutable.value))).toThrow(/not executable/iu);
  });

  it('keeps activation transactions idempotent after commit or rollback', async () => {
    const value = fixture();
    const bootstrap = resolvePackagedRuntimeBootstrap({
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      version: '1.1.3',
      nodePath: value.nodePath,
      cliPath: value.cliPath,
    })!;
    const first = await bootstrap.prepareInstallation(async () => undefined);
    first.commit();
    first.rollback();
    const repeated = await bootstrap.prepareInstallation(async () => undefined);
    expect(repeated.installation.activated).toBe(false);
    repeated.rollback();
    repeated.rollback();
    expect(
      inspectInstalledRuntime({
        homeDirectory: value.homeDirectory,
        dataDirectory: value.dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
      }),
    ).not.toBeNull();
  });
});
