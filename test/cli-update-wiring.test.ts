import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliUpdateManager } from '../src/cliComposition/packagedUpdateProvider.js';
import { stagePackagedMacOSApplication } from '../src/cliComposition/releaseCandidate.js';
import {
  createBoundedReleaseManifestFetcher,
  createReleaseSignatureVerifier,
  resolveReleasePublicKeyPem,
  versionedReleaseManifestUrl,
} from '../src/cliComposition/releaseChannel.js';
import { installReceiptPath, writeInstallReceipt } from '../src/service/receipt.js';
import type { ServiceManager } from '../src/service/types.js';
import {
  releaseSignaturePayload,
  RELEASE_PUBLIC_KEY_PEM,
  type PackagedReleaseProviderInput,
  type PackagedReleaseTarget,
} from '../src/update.js';

const roots: string[] = [];
const ISSUED_AT = '2026-09-01T12:00:00.000Z';

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
  options: {
    updateProvider?: 'legacy-npm' | 'packaged-release';
    platform?: 'darwin' | 'linux';
    packagedRuntime?: { version: string; target: PackagedReleaseTarget; runtimeDirectory: string };
  } = {},
): void {
  writeInstallReceipt(
    installReceiptPath(dataDirectory),
    {
      schemaVersion: 1,
      adapter,
      platform: options.platform ?? 'darwin',
      version: '1.0.0',
      installationKey: 'a'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z',
      nodePath: '/private/runtime/bin/node',
      cliPath: '/private/runtime/dist/cli.js',
      dataDirectory,
      baseUrl: 'http://127.0.0.1:7337',
      logDirectory: join(dataDirectory, 'logs'),
      artifacts: [],
      ...(options.updateProvider === undefined ? {} : { updateProvider: options.updateProvider }),
      ...(options.packagedRuntime === undefined
        ? {}
        : { packagedRuntime: options.packagedRuntime }),
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
    environment: {} as NodeJS.ProcessEnv,
  };
}

function manifestFor(
  target: PackagedReleaseTarget,
  version: string,
  privateKey?: KeyObject,
  overrides: { url?: string; sha256?: string; size?: number } = {},
): string {
  const url =
    overrides.url ??
    `https://github.com/r-bart/pimpampum/releases/download/v${version}/pimpampum-${version}-${target}.zip`;
  const sha256 = overrides.sha256 ?? 'b'.repeat(64);
  const size = overrides.size ?? 10;
  const payload = releaseSignaturePayload({
    version,
    issuedAt: ISSUED_AT,
    target,
    url,
    sha256,
    size,
  });
  const signature = privateKey
    ? sign(null, Buffer.from(payload), privateKey).toString('base64')
    : Buffer.alloc(64, 7).toString('base64');
  return JSON.stringify({
    schemaVersion: 1,
    channel: 'stable',
    version,
    issuedAt: ISSUED_AT,
    targets: { [target]: { url, sha256, signature, size } },
  });
}

function response(body: string | null, status: number, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

function fetchSequence(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { fetchImplementation, calls };
}

describe('CLI packaged update wiring', () => {
  it('selects the packaged provider from a validated native installation receipt without npm', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory, 'launchd-macos-app');
    const runCommand = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'npm forbidden' }));
    const packagedRelease: PackagedReleaseProviderInput = {
      channelManifestUrl: 'https://updates.example.test/channel/stable.json',
      target: 'darwin-arm64',
      fetchManifest: vi.fn(async () => manifestFor('darwin-arm64', '1.0.0')),
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
    writeReceipt(value.dataDirectory, 'systemd', { updateProvider: 'packaged-release' });
    const packagedRelease: PackagedReleaseProviderInput = {
      channelManifestUrl: 'https://updates.example.test/channel/stable.json',
      target: 'darwin-arm64',
      fetchManifest: vi.fn(async () => manifestFor('darwin-arm64', '1.0.0')),
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

  it('rejects a channel manifest signed by any key other than the embedded release key', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory, 'launchd-macos-app');
    const stranger = generateKeyPairSync('ed25519');
    const fetchImplementation = vi.fn(async () =>
      response(manifestFor('darwin-arm64', '1.0.1', stranger.privateKey), 200),
    ) as unknown as typeof globalThis.fetch;
    const input = baseInput(value);
    const manager = createCliUpdateManager({ ...input, fetchImplementation });

    await expect(manager.check()).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/signature is invalid/iu),
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://github.com/r-bart/pimpampum/releases/download/update-channel-stable/release-manifest.json',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(input.runCommand).not.toHaveBeenCalled();
  });

  it('ignores PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH unless the development flag is set', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory, 'launchd-macos-app');
    const pair = generateKeyPairSync('ed25519');
    const keyPath = join(value.dataDirectory, 'dev-key.pem');
    writeFileSync(keyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const fetchImplementation = vi.fn(async () =>
      response(manifestFor('darwin-arm64', '1.0.1', pair.privateKey), 200),
    ) as unknown as typeof globalThis.fetch;
    const input = baseInput(value);

    const withoutFlag = createCliUpdateManager({
      ...input,
      fetchImplementation,
      environment: { PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: keyPath },
    });
    await expect(withoutFlag.check()).rejects.toThrow(/signature is invalid/iu);

    const withFlag = createCliUpdateManager({
      ...input,
      fetchImplementation,
      environment: { PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: keyPath, PIMPAMPUM_DEV_RELEASE_KEY: '1' },
    });
    await expect(withFlag.check()).resolves.toEqual({
      currentVersion: '1.0.0',
      latestVersion: '1.0.1',
      updateAvailable: true,
    });
  });

  it('answers a Linux packaged runtime from the channel and refuses activation with the bootstrap remedy', async () => {
    const value = fixture();
    writeReceipt(value.dataDirectory, 'systemd', {
      platform: 'linux',
      packagedRuntime: {
        version: '1.0.0',
        target: 'linux-x64',
        runtimeDirectory: join(value.homeDirectory, '.local', 'share', 'pimpampum', 'runtime'),
      },
    });
    const pair = generateKeyPairSync('ed25519');
    const keyPath = join(value.dataDirectory, 'dev-key.pem');
    writeFileSync(keyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const fetchImplementation = vi.fn(async () =>
      response(
        manifestFor('linux-x64', '1.0.1', pair.privateKey, {
          url: 'https://github.com/r-bart/pimpampum/releases/download/v1.0.1/pimpampum-runtime-1.0.1-linux-x64.tar.gz',
        }),
        200,
      ),
    ) as unknown as typeof globalThis.fetch;
    const input = baseInput(value);
    const manager = createCliUpdateManager({
      ...input,
      target: 'linux-x64',
      npmPath: null,
      fetchImplementation,
      environment: { PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: keyPath, PIMPAMPUM_DEV_RELEASE_KEY: '1' },
    });

    await expect(manager.check()).resolves.toMatchObject({
      latestVersion: '1.0.1',
      updateAvailable: true,
    });
    await expect(manager.update()).rejects.toMatchObject({
      code: 'unavailable',
      retryable: false,
      message: expect.stringMatching(/pimpampum-bootstrap/u),
      details: { remedy: 'pimpampum-bootstrap', version: '1.0.1' },
    });
    expect(input.runCommand).not.toHaveBeenCalled();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});

describe('bounded release fetch redirect policy', () => {
  const channel =
    'https://github.com/r-bart/pimpampum/releases/download/update-channel-stable/release-manifest.json';
  const request = { url: channel, maximumBytes: 64, timeoutMilliseconds: 1_000 };

  it('follows one redirect from github.com to its asset host and keeps redirect handling manual', async () => {
    const { fetchImplementation, calls } = fetchSequence([
      response(null, 302, {
        location:
          'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x',
      }),
      response('{"ok":true}', 200),
    ]);
    const fetchManifest = createBoundedReleaseManifestFetcher(fetchImplementation);

    const bytes = await fetchManifest(request);
    expect(Buffer.from(bytes).toString('utf8')).toBe('{"ok":true}');
    expect(calls.map((call) => call.url)).toEqual([
      channel,
      'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x',
    ]);
    for (const call of calls) {
      expect(call.init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    }
  });

  it('resolves a relative location against the current hop', async () => {
    const { fetchImplementation, calls } = fetchSequence([
      response(null, 301, { location: '/r-bart/pimpampum/releases/download/v1.0.0/x.json' }),
      response('1', 200),
    ]);
    await createBoundedReleaseManifestFetcher(fetchImplementation)(request);
    expect(calls[1]!.url).toBe(
      'https://github.com/r-bart/pimpampum/releases/download/v1.0.0/x.json',
    );
  });

  it.each([
    [
      'a host outside the allowlist',
      'https://evil.example.test/release-manifest.json',
      /not allowed/iu,
    ],
    ['a downgrade to HTTP', 'http://github.com/r-bart/pimpampum/releases/x', /left HTTPS/iu],
    ['credentials in the target', 'https://user:pw@github.com/x', /credentials/iu],
  ])('rejects a redirect to %s', async (_label, location, message) => {
    const { fetchImplementation, calls } = fetchSequence([
      response(null, 302, { location }),
      response('never', 200),
    ]);
    await expect(
      createBoundedReleaseManifestFetcher(fetchImplementation)(request),
    ).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(message) });
    expect(calls).toHaveLength(1);
  });

  it('stops after three hops', async () => {
    const { fetchImplementation, calls } = fetchSequence(
      Array.from({ length: 5 }, (_value, index) =>
        response(null, 307, { location: `https://github.com/hop/${String(index)}` }),
      ),
    );
    await expect(createBoundedReleaseManifestFetcher(fetchImplementation)(request)).rejects.toThrow(
      /exceeded 3 redirects/u,
    );
    expect(calls).toHaveLength(4);
  });

  it('rejects a redirect without a location and keeps the size cap after a hop', async () => {
    const missing = fetchSequence([response(null, 302)]);
    await expect(
      createBoundedReleaseManifestFetcher(missing.fetchImplementation)(request),
    ).rejects.toThrow(/no location/iu);

    const oversized = fetchSequence([
      response(null, 302, { location: 'https://objects.githubusercontent.com/asset' }),
      response('x'.repeat(65), 200),
    ]);
    await expect(
      createBoundedReleaseManifestFetcher(oversized.fetchImplementation)(request),
    ).rejects.toThrow(/streaming size limit/iu);
  });

  it('rejects a non-OK response and a declared length that is unusable or too large', async () => {
    const notFound = fetchSequence([response(null, 404)]);
    await expect(
      createBoundedReleaseManifestFetcher(notFound.fetchImplementation)(request),
    ).rejects.toThrow(/returned HTTP 404/u);

    const unparsable = fetchSequence([response('{}', 200, { 'content-length': 'many' })]);
    await expect(
      createBoundedReleaseManifestFetcher(unparsable.fetchImplementation)(request),
    ).rejects.toThrow(/declared size limit/u);

    const oversized = fetchSequence([response('{}', 200, { 'content-length': '65' })]);
    await expect(
      createBoundedReleaseManifestFetcher(oversized.fetchImplementation)(request),
    ).rejects.toThrow(/declared size limit/u);
  });

  it('keeps a redirect to an unparsable location typed and carries its cause', async () => {
    const { fetchImplementation } = fetchSequence([response(null, 302, { location: 'http://[' })]);
    await expect(
      createBoundedReleaseManifestFetcher(fetchImplementation)(request),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/location is invalid/u),
      details: { cause: expect.anything() },
    });
  });

  it('aborts a fetch that outlives its timeout', async () => {
    const aborted = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (init?.signal?.aborted !== true) throw new Error('the timeout never fired');
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof globalThis.fetch;
    await expect(
      createBoundedReleaseManifestFetcher(aborted)({ ...request, timeoutMilliseconds: 1 }),
    ).rejects.toThrow(/aborted/u);
  });

  it('accepts plain-HTTP loopback only when the development flag opened it', async () => {
    const loopback = { ...request, url: 'http://127.0.0.1:8080/channel/release-manifest.json' };
    const strict = fetchSequence([response('never', 200)]);
    await expect(
      createBoundedReleaseManifestFetcher(strict.fetchImplementation)(loopback),
    ).rejects.toThrow(/left HTTPS/iu);
    expect(strict.calls).toHaveLength(0);

    const development = fetchSequence([
      response(null, 302, { location: 'http://127.0.0.1:8080/assets/release-manifest.json' }),
      response('{}', 200),
    ]);
    const fetchManifest = createBoundedReleaseManifestFetcher(development.fetchImplementation, {
      allowInsecureLoopback: true,
    });
    await expect(fetchManifest(loopback)).resolves.toHaveLength(2);
    const remote = fetchSequence([response(null, 302, { location: 'http://example.test/x' })]);
    await expect(
      createBoundedReleaseManifestFetcher(remote.fetchImplementation, {
        allowInsecureLoopback: true,
      })(loopback),
    ).rejects.toThrow(/left HTTPS/iu);
  });
});

describe('release key trust', () => {
  it('verifies Ed25519 signatures against an embedded PEM and rejects other key types', () => {
    const pair = generateKeyPairSync('ed25519');
    const payload = 'signed packaged release';
    const signature = sign(null, Buffer.from(payload), pair.privateKey).toString('base64');
    const verifier = createReleaseSignatureVerifier({
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    });

    expect(verifier({ payload, signature, target: 'darwin-arm64' })).toBe(true);
    expect(verifier({ payload: 'other', signature, target: 'darwin-arm64' })).toBe(false);
    expect(() =>
      verifier({ payload, signature: `${signature.slice(0, -2)}!!`, target: 'darwin-arm64' }),
    ).toThrow(/not valid base64/iu);
    expect(() =>
      verifier({ payload, signature: Buffer.alloc(32).toString('base64'), target: 'darwin-arm64' }),
    ).toThrow(/invalid size/iu);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      createReleaseSignatureVerifier({
        publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string,
      })({ payload, signature, target: 'darwin-arm64' }),
    ).toThrow(/Ed25519/u);
  });

  it('ships an Ed25519 public key as the embedded trust root', () => {
    const verifier = createReleaseSignatureVerifier({ publicKeyPem: RELEASE_PUBLIC_KEY_PEM });
    expect(
      verifier({
        payload: 'x',
        signature: Buffer.alloc(64).toString('base64'),
        target: 'darwin-arm64',
      }),
    ).toBe(false);
  });

  it('resolves the development key only behind the flag and only from a private regular file', () => {
    const value = fixture();
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const keyPath = join(value.dataDirectory, 'dev-key.pem');
    writeFileSync(keyPath, pem, { mode: 0o600 });

    expect(resolveReleasePublicKeyPem({ environment: {} })).toBe(RELEASE_PUBLIC_KEY_PEM);
    expect(
      resolveReleasePublicKeyPem({ environment: { PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: keyPath } }),
    ).toBe(RELEASE_PUBLIC_KEY_PEM);
    expect(
      resolveReleasePublicKeyPem({
        environment: { PIMPAMPUM_DEV_RELEASE_KEY: '1', PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: keyPath },
      }),
    ).toBe(pem);
    expect(resolveReleasePublicKeyPem({ publicKeyPath: keyPath, environment: {} })).toBe(pem);

    chmodSync(keyPath, 0o666);
    expect(() => resolveReleasePublicKeyPem({ publicKeyPath: keyPath, environment: {} })).toThrow(
      /world-writable/iu,
    );
    const link = join(value.dataDirectory, 'linked.pem');
    symlinkSync(keyPath, link);
    expect(() => resolveReleasePublicKeyPem({ publicKeyPath: link, environment: {} })).toThrow(
      /regular file/iu,
    );
    expect(() =>
      resolveReleasePublicKeyPem({ publicKeyPath: 'relative.pem', environment: {} }),
    ).toThrow(/absolute/iu);
  });

  it('refuses a development key owned by another user or sized outside its bounds', () => {
    const value = fixture();
    const pem = generateKeyPairSync('ed25519').publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
    const keyPath = join(value.dataDirectory, 'dev-key.pem');
    writeFileSync(keyPath, pem, { mode: 0o600 });
    const owner = process.getuid?.() ?? 0;

    expect(
      resolveReleasePublicKeyPem({ publicKeyPath: keyPath, environment: {}, currentUid: owner }),
    ).toBe(pem);
    expect(() =>
      resolveReleasePublicKeyPem({
        publicKeyPath: keyPath,
        environment: {},
        currentUid: owner + 1,
      }),
    ).toThrow(/not owned by the current user or root/iu);

    const empty = join(value.dataDirectory, 'empty.pem');
    writeFileSync(empty, '', { mode: 0o600 });
    expect(() => resolveReleasePublicKeyPem({ publicKeyPath: empty, environment: {} })).toThrow(
      /invalid size/iu,
    );
  });
});

describe('macOS install source from the release channel', () => {
  it('fetches the manifest of its own version and refuses a channel that offers another', async () => {
    const value = fixture();
    const pair = generateKeyPairSync('ed25519');
    const keyPath = join(value.dataDirectory, 'dev-key.pem');
    writeFileSync(keyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const { fetchImplementation, calls } = fetchSequence([
      response(manifestFor('darwin-arm64', '2.0.0', pair.privateKey), 200),
    ]);
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await expect(
      stagePackagedMacOSApplication({
        homeDirectory: value.homeDirectory,
        version: '1.2.0',
        runCommand,
        fetchImplementation,
        publicKeyPath: keyPath,
        environment: {},
      }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/npm install --global pimpampum@2\.0\.0/u),
      details: { channelVersion: '2.0.0', installedVersion: '1.2.0' },
    });
    expect(calls[0]!.url).toBe(versionedReleaseManifestUrl('1.2.0'));
    expect(versionedReleaseManifestUrl('1.2.0')).toBe(
      'https://github.com/r-bart/pimpampum/releases/download/v1.2.0/release-manifest.json',
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('keeps a fetch failure typed instead of an internal error', async () => {
    const value = fixture();
    const fetchImplementation = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof globalThis.fetch;
    await expect(
      stagePackagedMacOSApplication({
        homeDirectory: value.homeDirectory,
        version: '1.2.0',
        runCommand: vi.fn(),
        fetchImplementation,
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });
});
