import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createUpdateManager,
  isNewerVersion,
  resolveNpmPath,
  resolvePackagedRelease,
} from '../src/update.js';

const globalRoots: string[] = [];

// A real global npm root, so the default `existsSync` probe runs against a layout this test
// owns. Deriving one from `process.cwd()` would depend on the checkout directory name.
function installedGlobalRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-global-root-'));
  globalRoots.push(root);
  mkdirSync(join(root, 'pimpampum', 'dist'), { recursive: true });
  writeFileSync(join(root, 'pimpampum', 'dist', 'cli.js'), '');
  return root;
}

// A Node installation laid out the way `resolveNpmPath` expects: `bin/node` with an executable
// `bin/npm` beside it. L-35: the test used to require an npm next to `process.execPath`, so a
// version-manager Node without a sibling npm failed it.
function nodeInstallation(options: { withNpm: boolean }): { nodePath: string; npmPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-node-installation-'));
  globalRoots.push(root);
  mkdirSync(join(root, 'bin'));
  const nodePath = join(root, 'bin', 'node');
  const npmPath = join(root, 'bin', 'npm');
  writeFileSync(nodePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (options.withNpm) writeFileSync(npmPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { nodePath, npmPath };
}

afterEach(() => {
  for (const root of globalRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('update manager', () => {
  it('finds npm next to Node when a graphical session has a sparse PATH', () => {
    expect(resolveNpmPath('/mise/bin/node', '', () => false)).toBeNull();
    const installation = nodeInstallation({ withNpm: true });
    expect(resolveNpmPath(installation.nodePath, '')).toBe(realpathSync(installation.npmPath));
    expect(resolveNpmPath('/path/that/does/not/exist/node', '')).toBeNull();
  });

  it("prefers Node's sibling npm over a version-manager shim on PATH", () => {
    const shims = nodeInstallation({ withNpm: true });
    const installation = nodeInstallation({ withNpm: true });
    expect(resolveNpmPath(installation.nodePath, join(shims.nodePath, '..'))).toBe(
      realpathSync(installation.npmPath),
    );
  });

  it('falls back to the npm on PATH when Node has no sibling npm', () => {
    const shims = nodeInstallation({ withNpm: true });
    const bare = nodeInstallation({ withNpm: false });
    expect(resolveNpmPath(bare.nodePath, join(shims.nodePath, '..'))).toBe(
      realpathSync(shims.npmPath),
    );
    expect(resolveNpmPath(bare.nodePath, '')).toBeNull();
  });

  it('quotes only a bounded prefix of an oversized npm version', () => {
    // `runServiceCommand` accepts 4 MiB of stdout and this message reaches a desktop panel.
    expect(() => isNewerVersion('x'.repeat(500), '1.1.0')).toThrow(
      `npm returned an invalid Pimpampum version: ${'x'.repeat(40)}\u2026`,
    );
    expect(() => isNewerVersion('1.1', '1.1.0')).toThrow(
      'npm returned an invalid Pimpampum version: 1.1',
    );
  });

  it('names the real npm cause instead of a bare failure', async () => {
    const registryPolicy = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: [
          'npm warn Unknown user config "minimum-release-age".',
          'npm error code ETARGET',
          'npm error notarget No matching version found for pimpampum@1.2.0 with a date before 8/23/2026.',
          'npm error A complete log of this run can be found in: /tmp/log',
        ].join('\n'),
      })),
    });
    await expect(registryPolicy.check()).rejects.toThrow(
      'Update check failed: notarget No matching version found for pimpampum@1.2.0 with a date before 8/23/2026.',
    );

    const silent = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'npm error code E404' })),
    });
    await expect(silent.check()).rejects.toThrow(/Update check failed$/u);

    const verbose = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: `npm error notarget ${'reason '.repeat(60)}`,
      })),
    });
    await expect(verbose.check()).rejects.toThrow('…');
  });

  it('compares stable semantic versions', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.0.9', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.1.0', '1.1.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.1.0-beta.10', '1.1.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.1.0-beta.2', '1.1.0-beta.10')).toBe(false);
    expect(isNewerVersion('1.1.0-beta', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.1.0-beta', '1.1.0-beta')).toBe(false);
    expect(isNewerVersion('1.1.0-beta', '1.1.0-beta.1')).toBe(false);
    expect(isNewerVersion('1.1.0-beta.1', '1.1.0-beta')).toBe(true);
    expect(isNewerVersion('1.1.0-1', '1.1.0-beta')).toBe(false);
    expect(isNewerVersion('1.1.0-beta', '1.1.0-1')).toBe(true);
    expect(isNewerVersion('1.1.0-rc', '1.1.0-beta')).toBe(true);
    expect(isNewerVersion('1.1.0-beta', '1.1.0-rc')).toBe(false);
    expect(() => isNewerVersion('latest', '1.1.0')).toThrow('invalid Pimpampum version');
  });

  it('checks without changing the installation', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: '"1.2.0"\n', stderr: '' }));
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand,
    });
    await expect(manager.check()).resolves.toEqual({
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      updateAvailable: true,
    });
    expect(runCommand).toHaveBeenCalledWith('/node', [
      '/npm',
      'view',
      'pimpampum',
      'version',
      '--json',
    ]);
  });

  it('updates globally and reconciles through the newly installed CLI', async () => {
    const runCommand = vi.fn(async (_executable: string, args: string[]) => {
      if (args[1] === 'view') return { exitCode: 0, stdout: '"1.2.0"', stderr: '' };
      if (args[1] === 'root')
        return { exitCode: 0, stdout: '/global/lib/node_modules\n', stderr: '' };
      return { exitCode: 0, stdout: '{}', stderr: '' };
    });
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: process.execPath,
      runCommand,
      pathExists: () => true,
    });
    await expect(manager.update()).resolves.toMatchObject({
      currentVersion: '1.2.0',
      latestVersion: '1.2.0',
      updateAvailable: false,
      updated: true,
      installedVersion: '1.2.0',
      serviceReconciled: true,
    });
    expect(runCommand).toHaveBeenCalledWith(process.execPath, [
      '/npm',
      'install',
      '--global',
      'pimpampum@1.2.0',
    ]);
    expect(runCommand).toHaveBeenCalledWith(process.execPath, [
      '/global/lib/node_modules/pimpampum/dist/cli.js',
      'install',
    ]);
  });

  it('reports registry failures as retryable unavailable errors', async () => {
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'network down' })),
    });
    await expect(manager.check()).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
  });

  it('rejects missing npm and malformed registry envelopes', async () => {
    const missing = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: null,
      nodePath: '/node',
      runCommand: vi.fn(),
    });
    await expect(missing.check()).rejects.toThrow('npm is required');
    const malformed = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '' })),
    });
    await expect(malformed.check()).rejects.toThrow('invalid update response');
    const invalidJson = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'not-json', stderr: '' })),
    });
    await expect(invalidJson.check()).rejects.toThrow('invalid Pimpampum version');
  });

  it('rejects missing updated CLIs and failed reconciliation', async () => {
    const responses = async (_executable: string, args: string[]) =>
      args[1] === 'view'
        ? { exitCode: 0, stdout: '"1.1.0"', stderr: '' }
        : { exitCode: 0, stdout: '/missing', stderr: '' };
    const missing = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: responses,
      pathExists: () => false,
    });
    await expect(missing.update()).rejects.toThrow('updated Pimpampum CLI was not found');

    const failed = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      pathExists: () => true,
      runCommand: vi.fn(async (_executable, args) =>
        args[1] === 'view'
          ? { exitCode: 0, stdout: '"1.1.0"', stderr: '' }
          : args[1] === 'root'
            ? { exitCode: 0, stdout: '/global', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'install failed' },
      ),
    });
    await expect(failed.update()).rejects.toThrow('service reconciliation failed');
  });

  it('uses the filesystem check by default for an existing installed CLI', async () => {
    const root = installedGlobalRoot();
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(async (_executable, args) =>
        args[1] === 'view'
          ? { exitCode: 0, stdout: '"1.1.0"', stderr: '' }
          : args[1] === 'root'
            ? { exitCode: 0, stdout: root, stderr: '' }
            : { exitCode: 0, stdout: '{}', stderr: '' },
      ),
    });
    await expect(manager.update()).resolves.toMatchObject({
      updated: false,
      serviceReconciled: true,
    });
  });

  it('selects the signed packaged provider from native install receipt metadata without npm', async () => {
    const fetchManifest = vi.fn(async () =>
      JSON.stringify({
        schemaVersion: 1,
        channel: 'stable',
        version: '1.2.0',
        issuedAt: '2026-09-01T12:00:00.000Z',
        targets: {
          'darwin-arm64': {
            url: 'https://github.com/r-bart/pimpampum/releases/download/v1.2.0/Pimpampum-1.2.0-darwin-arm64.zip',
            sha256: 'a'.repeat(64),
            signature: 'signed-release-manifest-value'.repeat(2),
            size: 4096,
          },
        },
      }),
    );
    const verifySignature = vi.fn(async () => true);
    const runCommand = vi.fn();
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand,
      installReceipt: { schemaVersion: 1, adapter: 'launchd-macos-app' },
      packagedRelease: {
        channelManifestUrl: 'https://updates.pimpampum.dev/stable.json',
        target: 'darwin-arm64',
        fetchManifest,
        verifySignature,
        stageCandidate: vi.fn(),
        reconcile: vi.fn(),
      },
    });

    await expect(manager.check()).resolves.toEqual({
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      updateAvailable: true,
    });
    expect(fetchManifest).toHaveBeenCalledWith({
      url: 'https://updates.pimpampum.dev/stable.json',
      maximumBytes: 65_536,
      timeoutMilliseconds: 15_000,
    });
    expect(verifySignature).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'darwin-arm64', signature: expect.any(String) }),
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('stages the full matching packaged candidate before one coordinator reconciliation', async () => {
    const sha256 = 'b'.repeat(64);
    const signature = 'trusted-signature-material'.repeat(2);
    const stageCandidate = vi.fn(async () => ({
      path: '/private/tmp/pimpampum-update/candidate',
      sha256,
      size: 8192,
      contains: { app: true, runtime: true, plugin: true },
    }));
    const reconcile = vi.fn(async () => undefined);
    const manager = createUpdateManager({
      currentVersion: '1.1.0',
      npmPath: null,
      nodePath: '/private/runtime/node',
      runCommand: vi.fn(),
      installReceipt: {
        schemaVersion: 1,
        adapter: 'macos-app',
        updateProvider: 'packaged-release',
      },
      packagedRelease: {
        channelManifestUrl: 'https://updates.pimpampum.dev/stable.json',
        target: 'darwin-arm64',
        fetchManifest: async () =>
          JSON.stringify({
            schemaVersion: 1,
            channel: 'stable',
            version: '1.2.0',
            issuedAt: '2026-09-01T12:00:00.000Z',
            targets: {
              'darwin-arm64': {
                url: 'https://github.com/r-bart/pimpampum/releases/download/v1.2.0/Pimpampum-1.2.0-darwin-arm64.zip',
                sha256,
                signature,
                size: 8192,
              },
            },
          }),
        verifySignature: async () => true,
        stageCandidate,
        reconcile,
      },
    });

    await expect(manager.update()).resolves.toEqual({
      currentVersion: '1.2.0',
      latestVersion: '1.2.0',
      updateAvailable: false,
      updated: true,
      installedVersion: '1.2.0',
      serviceReconciled: true,
    });
    expect(stageCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '1.2.0',
        target: 'darwin-arm64',
        maximumBytes: 8192,
        timeoutMilliseconds: 15_000,
      }),
    );
    expect(reconcile).toHaveBeenCalledWith({
      version: '1.2.0',
      target: 'darwin-arm64',
      candidatePath: '/private/tmp/pimpampum-update/candidate',
      sha256,
      signature,
    });
  });

  it('rejects untrusted manifests and staged hash or inventory drift before reconciliation', async () => {
    const reconcile = vi.fn();
    const input = (verifySignature: () => boolean, stagedSha = 'c'.repeat(64)) =>
      createUpdateManager({
        currentVersion: '1.1.0',
        npmPath: null,
        nodePath: '/private/runtime/node',
        runCommand: vi.fn(),
        installReceipt: { schemaVersion: 1, adapter: 'macos-app' },
        packagedRelease: {
          channelManifestUrl: 'https://updates.pimpampum.dev/stable.json',
          target: 'darwin-arm64',
          fetchManifest: async () =>
            JSON.stringify({
              schemaVersion: 1,
              channel: 'stable',
              version: '1.2.0',
              issuedAt: '2026-09-01T12:00:00.000Z',
              targets: {
                'darwin-arm64': {
                  url: 'https://github.com/r-bart/pimpampum/releases/download/v1.2.0/Pimpampum-1.2.0-darwin-arm64.zip',
                  sha256: 'c'.repeat(64),
                  signature: 'signed-release-manifest-value'.repeat(2),
                  size: 1024,
                },
              },
            }),
          verifySignature,
          stageCandidate: async () => ({
            path: '/private/tmp/pimpampum-update/candidate',
            sha256: stagedSha,
            size: 1024,
            contains: { app: true, runtime: true, plugin: true },
          }),
          reconcile,
        },
      });

    await expect(input(() => false).check()).rejects.toThrow(/signature/u);
    await expect(input(() => true, 'd'.repeat(64)).update()).rejects.toThrow(/hash/u);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('release channel contract', () => {
  it('splits a prerelease at its first hyphen only', () => {
    expect(isNewerVersion('1.0.0-rc-2', '1.0.0-rc-1')).toBe(true);
    expect(isNewerVersion('1.0.0-rc-1', '1.0.0-rc-2')).toBe(false);
    expect(isNewerVersion('1.0.0-rc-1', '1.0.0-rc-1')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.0-rc-2')).toBe(true);
  });

  it('exposes issuedAt and accepts the macos-arm64 asset name for the darwin-arm64 target', async () => {
    const fetchManifest = vi.fn(async () =>
      JSON.stringify({
        schemaVersion: 1,
        channel: 'stable',
        version: '1.2.12',
        issuedAt: '2026-09-01T12:00:00.000Z',
        targets: {
          'darwin-arm64': {
            url: 'https://github.com/r-bart/pimpampum/releases/download/v1.2.12/Pimpampum-1.2.12-macos-arm64.zip',
            sha256: 'a'.repeat(64),
            signature: Buffer.alloc(64, 1).toString('base64'),
            size: 4096,
          },
          'linux-x64': {
            url: 'https://github.com/r-bart/pimpampum/releases/download/v1.2.12/pimpampum-runtime-1.2.12-linux-x64.tar.gz',
            sha256: 'b'.repeat(64),
            signature: Buffer.alloc(64, 2).toString('base64'),
            size: 8192,
          },
        },
      }),
    );
    const verifySignature = vi.fn(async () => true);
    const resolved = await resolvePackagedRelease({
      channelManifestUrl:
        'https://github.com/r-bart/pimpampum/releases/download/update-channel-stable/release-manifest.json',
      target: 'darwin-arm64',
      fetchManifest,
      verifySignature,
      stageCandidate: vi.fn(),
      reconcile: vi.fn(),
    });
    expect(resolved.manifest).toEqual({
      schemaVersion: 1,
      channel: 'stable',
      version: '1.2.12',
      issuedAt: '2026-09-01T12:00:00.000Z',
      targets: { 'darwin-arm64': resolved.asset },
    });
    expect(resolved.asset.url).toContain('macos-arm64.zip');
    expect(verifySignature).toHaveBeenCalledWith({
      payload: [
        'pimpampum-packaged-release-v1',
        'stable',
        '1.2.12',
        '2026-09-01T12:00:00.000Z',
        'darwin-arm64',
        resolved.asset.url,
        'a'.repeat(64),
        '4096',
      ].join('\n'),
      signature: Buffer.alloc(64, 1).toString('base64'),
      target: 'darwin-arm64',
    });
  });
});

describe('release channel residual boundaries', () => {
  const asset = {
    url: 'https://updates.example.test/v2.0.0/pimpampum-darwin-arm64.zip',
    sha256: 'a'.repeat(64),
    signature: 'b'.repeat(64),
    size: 1024,
  };
  const provider = (fetchManifest: () => Promise<string | Uint8Array>) => ({
    channelManifestUrl: 'https://updates.example.test/channel/stable.json',
    target: 'darwin-arm64' as const,
    fetchManifest,
    verifySignature: async () => true,
    stageCandidate: vi.fn(),
    reconcile: vi.fn(),
  });
  const manifest = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      version: '2.0.0',
      issuedAt: '2026-09-01T12:00:00.000Z',
      targets: { 'darwin-arm64': asset },
      ...overrides,
    });

  it('rejects a NUL asset URL, a non-text response and a calendar-invalid issuedAt', async () => {
    await expect(
      resolvePackagedRelease(
        provider(async () =>
          manifest({ targets: { 'darwin-arm64': { ...asset, url: `${asset.url}\0` } } }),
        ),
      ),
    ).rejects.toThrow(/invalid asset URL/iu);
    await expect(
      resolvePackagedRelease(provider(async () => 42 as unknown as string)),
    ).rejects.toThrow(/response is invalid/iu);
    await expect(
      resolvePackagedRelease(
        provider(async () => manifest({ issuedAt: '2026-02-30T12:00:00.000Z' })),
      ),
    ).rejects.toThrow(/schema is incompatible/iu);
    await expect(
      resolvePackagedRelease(provider(async () => new TextEncoder().encode(manifest()))),
    ).resolves.toMatchObject({ manifest: { version: '2.0.0' } });
  });

  it('returns without staging when the channel is not newer and rejects a relative runtime directory', async () => {
    const current = provider(async () => manifest());
    const manager = createUpdateManager({
      currentVersion: '2.0.0',
      npmPath: null,
      nodePath: '/node',
      runCommand: vi.fn(),
      installReceipt: { schemaVersion: 1, adapter: 'macos-app' },
      packagedRelease: current,
    });
    await expect(manager.update()).resolves.toEqual({
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
      updateAvailable: false,
      updated: false,
      installedVersion: '2.0.0',
      serviceReconciled: false,
    });
    expect(current.stageCandidate).not.toHaveBeenCalled();
    expect(() =>
      createUpdateManager({
        currentVersion: '1.0.0',
        npmPath: null,
        nodePath: '/node',
        runCommand: vi.fn(),
        installReceipt: {
          schemaVersion: 1,
          adapter: 'systemd',
          packagedRuntime: { version: '1.0.0', target: 'linux-x64', runtimeDirectory: 'relative' },
        },
      }),
    ).toThrow(/receipt schema is incompatible/iu);
  });
});

describe('explicit legacy provenance', () => {
  it('keeps a macOS app receipt on npm when it declares legacy-npm provenance', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: '"1.0.0"', stderr: '' }));
    const manager = createUpdateManager({
      currentVersion: '1.0.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand,
      installReceipt: { schemaVersion: 1, adapter: 'macos-app', updateProvider: 'legacy-npm' },
    });
    await expect(manager.check()).resolves.toMatchObject({ updateAvailable: false });
    expect(runCommand).toHaveBeenCalledOnce();
  });
});
