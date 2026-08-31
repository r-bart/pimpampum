import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { createPackagedReleaseUpdateManager, createUpdateManager } from '../src/update.js';
import type { PackagedReleaseProviderInput } from '../src/update.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'pimpampum-update-security-'));
  roots.push(value);
  return value;
}

function releaseManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    channel: 'stable',
    version: '2.0.0',
    targets: {
      'darwin-arm64': {
        url: 'https://updates.example.test/v2.0.0/pimpampum-darwin-arm64.zip',
        sha256: 'a'.repeat(64),
        signature: 'b'.repeat(64),
        size: 1024,
      },
    },
    ...overrides,
  });
}

function provider(
  overrides: Partial<PackagedReleaseProviderInput> = {},
): PackagedReleaseProviderInput {
  return {
    channelManifestUrl: 'https://updates.example.test/channel/stable.json',
    target: 'darwin-arm64',
    fetchManifest: async () => releaseManifest(),
    verifySignature: async () => true,
    stageCandidate: async () => ({
      path: '/private/tmp/pimpampum/candidate',
      sha256: 'a'.repeat(64),
      size: 1024,
      contains: { app: true, runtime: true, plugin: true },
    }),
    reconcile: async () => undefined,
    ...overrides,
  };
}

describe('packaged update schema and URL security', () => {
  it.each([
    'not a url',
    'http://updates.example.test/stable.json',
    'https://user@updates.example.test/stable.json',
    'https://updates.example.test/stable.json#fragment',
    'https://updates.example.test/latest/manifest.json',
  ])('rejects unsafe channel URL %s', (channelManifestUrl) => {
    expect(() =>
      createPackagedReleaseUpdateManager({
        currentVersion: '1.0.0',
        provider: provider({ channelManifestUrl }),
      }),
    ).toThrow(/channel URL/iu);
  });

  it('rejects an unsupported provider target before fetching', () => {
    expect(() =>
      createPackagedReleaseUpdateManager({
        currentVersion: '1.0.0',
        provider: provider({ target: 'darwin-x64' as 'darwin-arm64' }),
      }),
    ).toThrow(/target is unsupported/iu);
  });

  it.each([
    ['', /size limit/iu],
    ['not-json', /valid JSON/iu],
    [JSON.stringify([]), /schema is incompatible/iu],
    [releaseManifest({ extra: true }), /schema is incompatible/iu],
    [releaseManifest({ channel: 'nightly' }), /schema is incompatible/iu],
    [releaseManifest({ version: 'latest' }), /schema is incompatible/iu],
    [releaseManifest({ targets: {} }), /schema is incompatible/iu],
    [releaseManifest({ targets: { unsupported: {} } }), /schema is incompatible/iu],
  ])('rejects malformed release envelope %#', async (manifest, message) => {
    const manager = createPackagedReleaseUpdateManager({
      currentVersion: '1.0.0',
      provider: provider({ fetchManifest: async () => manifest as string }),
    });
    await expect(manager.check()).rejects.toThrow(message as RegExp);
  });

  it.each([
    [
      { url: 'not a url', sha256: 'a'.repeat(64), signature: 'b'.repeat(64), size: 1 },
      /asset URL/iu,
    ],
    [
      {
        url: 'https://updates.example.test/latest/pimpampum-darwin-arm64.zip',
        sha256: 'a'.repeat(64),
        signature: 'b'.repeat(64),
        size: 1,
      },
      /exact signed version/iu,
    ],
    [
      {
        url: 'https://updates.example.test/v2.0.0/pimpampum-linux-x64.zip',
        sha256: 'a'.repeat(64),
        signature: 'b'.repeat(64),
        size: 1,
      },
      /exact signed version/iu,
    ],
    [
      {
        url: 'https://updates.example.test/v2.0.0/pimpampum-darwin-arm64.zip',
        sha256: 'invalid',
        signature: 'b'.repeat(64),
        size: 1,
      },
      /hash, signature, or size/iu,
    ],
    [
      {
        url: 'https://updates.example.test/v2.0.0/pimpampum-darwin-arm64.zip',
        sha256: 'a'.repeat(64),
        signature: 'short',
        size: 1,
      },
      /hash, signature, or size/iu,
    ],
    [
      {
        url: 'https://updates.example.test/v2.0.0/pimpampum-darwin-arm64.zip',
        sha256: 'a'.repeat(64),
        signature: 'b'.repeat(64),
        size: 0,
      },
      /hash, signature, or size/iu,
    ],
  ])('rejects unsafe target asset %#', async (asset, message) => {
    const manager = createPackagedReleaseUpdateManager({
      currentVersion: '1.0.0',
      provider: provider({
        fetchManifest: async () => releaseManifest({ targets: { 'darwin-arm64': asset } }),
      }),
    });
    await expect(manager.check()).rejects.toThrow(message as RegExp);
  });

  it('wraps fetch and signature verifier exceptions without staging', async () => {
    const stageCandidate = vi.fn();
    const fetchFailure = createPackagedReleaseUpdateManager({
      currentVersion: '1.0.0',
      provider: provider({
        fetchManifest: async () => {
          throw new Error('private transport detail');
        },
        stageCandidate,
      }),
    });
    await expect(fetchFailure.check()).rejects.toThrow(/manifest fetch failed/iu);

    const signatureFailure = createPackagedReleaseUpdateManager({
      currentVersion: '1.0.0',
      provider: provider({
        verifySignature: async () => {
          throw new Error('key detail');
        },
        stageCandidate,
      }),
    });
    await expect(signatureFailure.check()).rejects.toThrow(/signature verification failed/iu);
    expect(stageCandidate).not.toHaveBeenCalled();
  });

  it.each([
    {
      path: 'relative',
      sha256: 'a'.repeat(64),
      size: 1024,
      contains: { app: true, runtime: true, plugin: true },
    },
    {
      path: '/private/tmp/../candidate',
      sha256: 'a'.repeat(64),
      size: 1024,
      contains: { app: true, runtime: true, plugin: true },
    },
    {
      path: '/private/tmp/candidate',
      sha256: 'c'.repeat(64),
      size: 1024,
      contains: { app: true, runtime: true, plugin: true },
    },
    {
      path: '/private/tmp/candidate',
      sha256: 'a'.repeat(64),
      size: 1023,
      contains: { app: true, runtime: true, plugin: true },
    },
    {
      path: '/private/tmp/candidate',
      sha256: 'a'.repeat(64),
      size: 1024,
      contains: { app: true, runtime: true, plugin: false },
    },
  ])('rejects invalid staged candidate %#', async (candidate) => {
    const reconcile = vi.fn();
    const manager = createPackagedReleaseUpdateManager({
      currentVersion: '1.0.0',
      provider: provider({ stageCandidate: async () => candidate, reconcile }),
    });
    await expect(manager.update()).rejects.toThrow(/inventory verification/iu);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('bounded release transport and key trust', () => {
  it('rejects HTTP failures, missing bodies and dishonest content lengths', async () => {
    const http = createBoundedReleaseManifestFetcher(
      async () => new Response('no', { status: 503 }),
    );
    await expect(
      http({ url: 'https://x.test', maximumBytes: 10, timeoutMilliseconds: 100 }),
    ).rejects.toThrow(/HTTP 503/u);

    const empty = createBoundedReleaseManifestFetcher(
      async () => new Response(null, { status: 204 }),
    );
    await expect(
      empty({ url: 'https://x.test', maximumBytes: 10, timeoutMilliseconds: 100 }),
    ).rejects.toThrow(/HTTP 204/u);

    const declared = createBoundedReleaseManifestFetcher(
      async () => new Response('ok', { headers: { 'content-length': 'invalid' } }),
    );
    await expect(
      declared({ url: 'https://x.test', maximumBytes: 10, timeoutMilliseconds: 100 }),
    ).rejects.toThrow(/declared size/iu);
  });

  it('aborts a fetch that honors the bounded deadline', async () => {
    vi.useFakeTimers();
    const fetcher = createBoundedReleaseManifestFetcher(
      vi.fn(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = fetcher({
      url: 'https://updates.example.test/stable.json',
      maximumBytes: 10,
      timeoutMilliseconds: 25,
    });
    const rejection = expect(pending).rejects.toThrow(/aborted/iu);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it('rejects keys outside owned roots, symlink traversal, RSA and invalid signatures', () => {
    const value = root();
    const owned = join(value, 'owned');
    const outside = join(value, 'outside');
    mkdirSync(owned, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    const ed25519 = generateKeyPairSync('ed25519');
    const outsideKey = join(outside, 'key.pem');
    writeFileSync(outsideKey, ed25519.publicKey.export({ type: 'spki', format: 'pem' }), {
      mode: 0o600,
    });
    expect(() =>
      createReleaseSignatureVerifier({ publicKeyPath: outsideKey, allowedRoots: [owned] })({
        payload: 'payload',
        signature: Buffer.alloc(64).toString('base64'),
        target: 'darwin-arm64',
      }),
    ).toThrow(/outside a Pimpampum-owned root/iu);

    const link = join(owned, 'linked');
    symlinkSync(outside, link);
    expect(() =>
      createReleaseSignatureVerifier({
        publicKeyPath: join(link, 'key.pem'),
        allowedRoots: [owned],
      })({
        payload: 'payload',
        signature: Buffer.alloc(64).toString('base64'),
        target: 'darwin-arm64',
      }),
    ).toThrow(/unsafe directory/iu);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPath = join(owned, 'rsa.pem');
    writeFileSync(rsaPath, rsa.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const rsaVerifier = createReleaseSignatureVerifier({
      publicKeyPath: rsaPath,
      allowedRoots: [owned],
    });
    expect(() =>
      rsaVerifier({
        payload: 'payload',
        signature: Buffer.alloc(64).toString('base64'),
        target: 'darwin-arm64',
      }),
    ).toThrow(/Ed25519/u);

    const keyPath = join(owned, 'ed25519.pem');
    writeFileSync(keyPath, ed25519.publicKey.export({ type: 'spki', format: 'pem' }), {
      mode: 0o600,
    });
    const verifier = createReleaseSignatureVerifier({
      publicKeyPath: keyPath,
      allowedRoots: [owned],
    });
    expect(() =>
      verifier({ payload: 'payload', signature: 'short', target: 'darwin-arm64' }),
    ).toThrow(/signature has an invalid size/iu);
    expect(
      verifier({
        payload: 'payload',
        signature: Buffer.alloc(64).toString('base64'),
        target: 'darwin-arm64',
      }),
    ).toBe(false);
  });
});

describe('concrete packaged staging rollback', () => {
  it('removes private same-filesystem staging after archive listing failure', async () => {
    const value = root();
    const homeDirectory = join(value, 'home');
    const dataDirectory = join(value, 'data');
    mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    writeInstallReceipt(installReceiptPath(dataDirectory), {
      schemaVersion: 1,
      adapter: 'launchd-macos-app',
      platform: 'darwin',
      version: '1.0.0',
      installationKey: 'a'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z',
      nodePath: '/private/runtime/node',
      cliPath: '/private/runtime/cli.js',
      dataDirectory,
      baseUrl: 'http://127.0.0.1:7337',
      logDirectory: join(dataDirectory, 'logs'),
      artifacts: [],
    });
    const pair = generateKeyPairSync('ed25519');
    const keyPath = join(dataDirectory, 'release-key.pem');
    writeFileSync(keyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const archive = Buffer.from('not-a-real-archive');
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const assetUrl = 'https://updates.example.test/v2.0.0/pimpampum-darwin-arm64.zip';
    const payload = [
      'pimpampum-packaged-release-v1',
      'stable',
      '2.0.0',
      'darwin-arm64',
      assetUrl,
      sha256,
      String(archive.byteLength),
    ].join('\n');
    const signature = sign(null, Buffer.from(payload), pair.privateKey).toString('base64');
    const channelUrl = 'https://updates.example.test/channel/stable.json';
    const fetchImplementation = vi.fn(async (url: string | URL | Request) =>
      String(url) === channelUrl
        ? new Response(
            JSON.stringify({
              schemaVersion: 1,
              channel: 'stable',
              version: '2.0.0',
              targets: {
                'darwin-arm64': {
                  url: assetUrl,
                  sha256,
                  signature,
                  size: archive.byteLength,
                },
              },
            }),
          )
        : new Response(archive),
    );
    const serviceManager: ServiceManager = {
      install: vi.fn(),
      status: vi.fn(),
      uninstall: vi.fn(),
    };
    const runCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'invalid archive',
    }));
    const manager = createCliUpdateManager({
      currentVersion: '1.0.0',
      dataDirectory,
      homeDirectory,
      target: 'darwin-arm64',
      nodePath: '/private/runtime/node',
      npmPath: null,
      runCommand,
      currentServiceManager: serviceManager,
      createCandidateServiceManager: () => serviceManager,
      channelManifestUrl: channelUrl,
      publicKeyPath: keyPath,
      fetchImplementation,
    });

    await expect(manager.update()).rejects.toThrow(/invalid runtime archive/iu);
    const applications = join(homeDirectory, 'Applications');
    expect(
      readdirSync(applications).filter((name) => name.startsWith('.pimpampum-update-')),
    ).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('legacy npm fail-closed edges', () => {
  it('rejects a relative global root even when the CLI probe claims it exists', async () => {
    const manager = createUpdateManager({
      currentVersion: '1.0.0',
      npmPath: '/npm',
      nodePath: '/node',
      pathExists: () => true,
      runCommand: vi.fn(async (_executable, arguments_) =>
        arguments_[1] === 'view'
          ? { exitCode: 0, stdout: '"1.0.0"', stderr: '' }
          : { exitCode: 0, stdout: 'relative/root', stderr: '' },
      ),
    });
    await expect(manager.update()).rejects.toThrow(/CLI was not found/iu);
  });

  it('keeps packaged receipts fail-closed when no provider is wired', async () => {
    const manager = createUpdateManager({
      currentVersion: '1.0.0',
      npmPath: '/npm',
      nodePath: '/node',
      runCommand: vi.fn(),
      installReceipt: {
        schemaVersion: 1,
        adapter: 'systemd',
        updateProvider: 'packaged-release',
      },
    });
    await expect(manager.check()).rejects.toThrow(/provider is unavailable/iu);
    await expect(manager.update()).rejects.toThrow(/provider is unavailable/iu);
  });
});
