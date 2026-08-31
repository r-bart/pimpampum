import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBoundedReleaseManifestFetcher,
  createCliUpdateManager,
  createReleaseSignatureVerifier,
} from '../src/cliMain.js';
import { installReceiptPath, writeInstallReceipt } from '../src/service/receipt.js';
import type { ServiceManager } from '../src/service/types.js';
import type { PackagedReleaseProviderInput } from '../src/update.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-cli-update-'));
  roots.push(root);
  const homeDirectory = join(root, 'home');
  const dataDirectory = join(root, 'data');
  mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const serviceManager: ServiceManager = {
    install: vi.fn(async () => ({ installed: true as const, reconciled: false, receiptPath: '' })),
    status: vi.fn(async () => ({
      installed: true,
      running: true,
      adapter: 'launchd-macos-app',
      version: '1.0.0',
    })),
    uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
  };
  return { root, homeDirectory, dataDirectory, serviceManager };
}

function writeReceipt(
  dataDirectory: string,
  adapter: string,
  updateProvider?: 'legacy-npm' | 'packaged-release',
): void {
  writeInstallReceipt(
    installReceiptPath(dataDirectory),
    {
      schemaVersion: 1,
      adapter,
      platform: 'darwin',
      version: '1.0.0',
      installationKey: 'a'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z',
      nodePath: '/private/runtime/bin/node',
      cliPath: '/private/runtime/dist/cli.js',
      dataDirectory,
      baseUrl: 'http://127.0.0.1:7337',
      logDirectory: join(dataDirectory, 'logs'),
      artifacts: [],
      ...(updateProvider === undefined ? {} : { updateProvider }),
    },
    dataDirectory,
  );
}

function baseInput(value: ReturnType<typeof fixture>) {
  return {
    currentVersion: '1.0.0',
    dataDirectory: value.dataDirectory,
    homeDirectory: value.homeDirectory,
    target: 'darwin-arm64' as const,
    nodePath: '/private/runtime/bin/node',
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '"1.0.0"', stderr: '' })),
    currentServiceManager: value.serviceManager,
    createCandidateServiceManager: vi.fn(() => value.serviceManager),
    npmPath: '/private/runtime/bin/npm',
  };
}

describe('CLI packaged update wiring', () => {
  it('selects the packaged provider from a validated native installation receipt without npm', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory, 'launchd-macos-app');
    const runCommand = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'npm forbidden' }));
    const packagedRelease: PackagedReleaseProviderInput = {
      channelManifestUrl: 'https://updates.example.test/channel/stable.json',
      target: 'darwin-arm64',
      fetchManifest: vi.fn(async () =>
        JSON.stringify({
          schemaVersion: 1,
          channel: 'stable',
          version: '1.0.0',
          targets: {
            'darwin-arm64': {
              url: 'https://updates.example.test/v1.0.0/pimpampum-darwin-arm64.zip',
              sha256: 'b'.repeat(64),
              signature: 'c'.repeat(64),
              size: 10,
            },
          },
        }),
      ),
      verifySignature: vi.fn(() => true),
      stageCandidate: vi.fn(async () => {
        throw new Error('not reached');
      }),
      reconcile: vi.fn(async () => undefined),
    };
    const manager = createCliUpdateManager({
      ...baseInput(value),
      runCommand,
      packagedRelease,
    });

    await expect(manager.check()).resolves.toMatchObject({ updateAvailable: false });
    expect(runCommand).not.toHaveBeenCalled();
    expect(packagedRelease.fetchManifest).toHaveBeenCalledWith(
      expect.objectContaining({ maximumBytes: 65_536, timeoutMilliseconds: 15_000 }),
    );
  });

  it('keeps legacy receipts on the npm provider', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory, 'launchd');
    const input = baseInput(value);
    const manager = createCliUpdateManager(input);

    await expect(manager.check()).resolves.toMatchObject({ latestVersion: '1.0.0' });
    expect(input.runCommand).toHaveBeenCalledWith('/private/runtime/bin/node', [
      '/private/runtime/bin/npm',
      'view',
      'pimpampum',
      'version',
      '--json',
    ]);
  });

  it('honors explicit packaged provenance independently of the adapter name', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory, 'systemd', 'packaged-release');
    const packagedRelease: PackagedReleaseProviderInput = {
      channelManifestUrl: 'https://updates.example.test/channel/stable.json',
      target: 'darwin-arm64',
      fetchManifest: vi.fn(async () =>
        JSON.stringify({
          schemaVersion: 1,
          channel: 'stable',
          version: '1.0.0',
          targets: {
            'darwin-arm64': {
              url: 'https://updates.example.test/v1.0.0/pimpampum-darwin-arm64.zip',
              sha256: 'b'.repeat(64),
              signature: 'c'.repeat(64),
              size: 10,
            },
          },
        }),
      ),
      verifySignature: vi.fn(() => true),
      stageCandidate: vi.fn(async () => {
        throw new Error('not reached');
      }),
      reconcile: vi.fn(async () => undefined),
    };
    const input = baseInput(value);
    const manager = createCliUpdateManager({ ...input, npmPath: null, packagedRelease });

    await expect(manager.check()).resolves.toMatchObject({ updateAvailable: false });
    expect(input.runCommand).not.toHaveBeenCalled();
  });

  it('fails closed when a native receipt has no trusted release key', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory, 'launchd-macos-app');
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            channel: 'stable',
            version: '1.0.1',
            targets: {
              'darwin-arm64': {
                url: 'https://updates.example.test/v1.0.1/pimpampum-darwin-arm64.zip',
                sha256: 'd'.repeat(64),
                signature: Buffer.alloc(64, 2).toString('base64'),
                size: 10,
              },
            },
          }),
          { status: 200 },
        ),
    );
    const input = baseInput(value);
    const manager = createCliUpdateManager({ ...input, fetchImplementation });

    await expect(manager.check()).rejects.toThrow(/signature verification failed/iu);
    expect(input.runCommand).not.toHaveBeenCalled();
  });

  it('bounds global fetch streaming and disables redirects', async () => {
    const fetchImplementation = vi.fn(async () => new Response('12345', { status: 200 }));
    const fetchManifest = createBoundedReleaseManifestFetcher(fetchImplementation);

    await expect(
      fetchManifest({
        url: 'https://updates.example.test/stable.json',
        maximumBytes: 4,
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toThrow(/streaming size limit/iu);
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://updates.example.test/stable.json',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
  });

  it('verifies Ed25519 signatures only from a private owned root', () => {
    const value = fixture();
    const releaseRoot = join(value.dataDirectory, 'release');
    mkdirSync(releaseRoot, { mode: 0o700 });
    const keyPath = join(releaseRoot, 'pimpampum-release-public-key.pem');
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(keyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const payload = 'signed packaged release';
    const signature = sign(null, Buffer.from(payload), pair.privateKey).toString('base64');
    const verifier = createReleaseSignatureVerifier({
      publicKeyPath: keyPath,
      allowedRoots: [value.dataDirectory],
    });

    expect(verifier({ payload, signature, target: 'darwin-arm64' })).toBe(true);
    chmodSync(keyPath, 0o666);
    expect(() => verifier({ payload, signature, target: 'darwin-arm64' })).toThrow(
      /world-writable/iu,
    );
  });
});
