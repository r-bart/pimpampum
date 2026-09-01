import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stagePackagedMacOSApplication } from '../src/cliMain.js';
import { runServiceCommand } from '../src/service/platform.js';
import { installReceiptPath, writeInstallReceipt } from '../src/service/receipt.js';
import type { RuntimeManifest } from '../src/runtime/types.js';
import type { PackagedReleaseTarget } from '../src/update.js';
import { PIMPAMPUM_VERSION } from '../src/version.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiledCli = join(repositoryRoot, 'dist', 'cli.js');
const signer = join(repositoryRoot, 'scripts', 'sign-release-manifest.mjs');
const CHANNEL_VERSION = '9.9.9';
const hostTarget: PackagedReleaseTarget | null =
  platform() === 'darwin' && arch() === 'arm64'
    ? 'darwin-arm64'
    : platform() === 'linux' && arch() === 'arm64'
      ? 'linux-arm64'
      : platform() === 'linux' && arch() === 'x64'
        ? 'linux-x64'
        : null;

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The release zip carries exactly one app whose embedded runtime payload includes the Omarchy
 * plugin sources, because the payload is the packed npm package. This fixture reproduces that
 * layout so the inventory validator sees the shape the real release produces.
 */
function writeCandidateApp(root: string, version: string): string {
  const app = join(root, 'Pimpampum.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'PimpampumMenuBar'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  const runtimeRoot = join(app, 'Contents', 'Resources', 'PimpampumRuntime');
  const payload = join(runtimeRoot, 'payload');
  const contents: Record<string, string> = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': `export const version = ${JSON.stringify(version)};\n`,
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': `addon-${version}`,
    'integrations/omarchy/pimpampum-status/BarWidget.qml': 'Item {}\n',
    'integrations/omarchy/pimpampum-status/runtime-manifest.json': `${JSON.stringify({
      version,
      targets: { 'linux-x64': {}, 'linux-arm64': {} },
    })}\n`,
  };
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(payload, ...path.split('/'));
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
  return app;
}

function executeCli(
  environment: NodeJS.ProcessEnv,
  ...arguments_: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [compiledCli, ...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => resolveResult({ code, stdout, stderr }));
  });
}

describe.skipIf(hostTarget === null).sequential('signed update channel end to end', () => {
  let root: string;
  let homeDirectory: string;
  let dataDirectory: string;
  let publicKeyPath: string;
  let server: Server;
  let baseUrl: string;
  let appZip: Buffer | null = null;
  const requests: string[] = [];
  const assets: Record<string, Buffer> = {};
  let signedManifest = '';

  beforeAll(async () => {
    if (!existsSync(compiledCli)) throw new Error('Run npm run build before E2E');
    root = mkdtempSync(join(tmpdir(), 'pimpampum-update-channel-'));
    homeDirectory = join(root, 'home');
    dataDirectory = join(root, 'data');
    mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

    // A throwaway release key pair; the CLI trusts it only through the development flag.
    const pair = generateKeyPairSync('ed25519');
    const privateKeyPath = join(root, 'private.pem');
    publicKeyPath = join(root, 'public.pem');
    writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), {
      mode: 0o600,
    });

    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/channel/release-manifest.json') {
        response.writeHead(302, { location: '/assets/release-manifest.json' });
        response.end();
        return;
      }
      if (request.url === '/assets/release-manifest.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(signedManifest);
        return;
      }
      const asset = assets[request.url ?? ''];
      if (asset) {
        response.writeHead(302, { location: `/cdn${request.url ?? ''}` });
        response.end();
        return;
      }
      const cdn = assets[(request.url ?? '').replace(/^\/cdn/u, '')];
      if (cdn) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(cdn);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No server port');
    baseUrl = `http://127.0.0.1:${String(address.port)}`;

    // The exact asset shape `scripts/package-release-assets.sh` writes, then signed by the exact
    // script the release job runs.
    if (hostTarget === 'darwin-arm64') {
      const candidateRoot = join(root, 'candidate');
      const app = writeCandidateApp(candidateRoot, CHANNEL_VERSION);
      const zipPath = join(root, `Pimpampum-${CHANNEL_VERSION}-macos-arm64.zip`);
      const zipped = spawnSync(
        '/usr/bin/ditto',
        ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zipPath],
        { encoding: 'utf8' },
      );
      if (zipped.status !== 0) throw new Error(`ditto failed: ${zipped.stderr}`);
      appZip = readFileSync(zipPath);
      assets[`/assets/v${CHANNEL_VERSION}/Pimpampum-${CHANNEL_VERSION}-macos-arm64.zip`] = appZip;
    }
    const linuxArchive = Buffer.from('not-a-real-runtime');
    const unsigned = {
      schemaVersion: 1,
      channel: 'stable',
      version: CHANNEL_VERSION,
      targets: {
        'darwin-arm64': {
          url: `${baseUrl}/assets/v${CHANNEL_VERSION}/Pimpampum-${CHANNEL_VERSION}-macos-arm64.zip`,
          sha256: appZip ? sha256(appZip) : 'a'.repeat(64),
          size: appZip ? appZip.byteLength : 1,
        },
        'linux-arm64': {
          url: `${baseUrl}/assets/v${CHANNEL_VERSION}/pimpampum-runtime-${CHANNEL_VERSION}-linux-arm64.tar.gz`,
          sha256: sha256(linuxArchive),
          size: linuxArchive.byteLength,
        },
        'linux-x64': {
          url: `${baseUrl}/assets/v${CHANNEL_VERSION}/pimpampum-runtime-${CHANNEL_VERSION}-linux-x64.tar.gz`,
          sha256: sha256(linuxArchive),
          size: linuxArchive.byteLength,
        },
      },
    };
    const unsignedPath = join(root, 'release-manifest.unsigned.json');
    writeFileSync(unsignedPath, `${JSON.stringify(unsigned, null, 2)}\n`);
    const signed = spawnSync(
      process.execPath,
      [
        signer,
        '--input',
        unsignedPath,
        '--output',
        join(root, 'channel'),
        '--key',
        privateKeyPath,
        '--public-key',
        publicKeyPath,
      ],
      { encoding: 'utf8' },
    );
    if (signed.status !== 0) throw new Error(`signing failed: ${signed.stderr}`);
    signedManifest = readFileSync(join(root, 'channel', 'release-manifest.json'), 'utf8');
    const checked = spawnSync(
      process.execPath,
      [
        signer,
        '--check',
        join(root, 'channel', 'release-manifest.json'),
        '--public-key',
        publicKeyPath,
      ],
      { encoding: 'utf8' },
    );
    if (checked.status !== 0) throw new Error(`check failed: ${checked.stderr}`);

    // A packaged installation receipt for this host, as the app or the Omarchy bootstrap writes it.
    writeInstallReceipt(
      installReceiptPath(dataDirectory),
      {
        schemaVersion: 1,
        adapter: hostTarget === 'darwin-arm64' ? 'launchd-macos-app' : 'systemd',
        platform: hostTarget === 'darwin-arm64' ? 'darwin' : 'linux',
        version: PIMPAMPUM_VERSION,
        installationKey: 'a'.repeat(64),
        installedAt: '2026-09-01T10:00:00.000Z',
        nodePath: join(root, 'runtime', 'bin', 'node'),
        cliPath: join(root, 'runtime', 'dist', 'cli.js'),
        dataDirectory,
        baseUrl: 'http://127.0.0.1:7337',
        logDirectory: join(dataDirectory, 'logs'),
        artifacts: [],
        updateProvider: 'packaged-release',
        packagedRuntime: {
          version: PIMPAMPUM_VERSION,
          target: hostTarget!,
          runtimeDirectory: join(root, 'runtime'),
        },
      },
      dataDirectory,
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: homeDirectory,
      PIMPAMPUM_DATA_DIR: dataDirectory,
      PIMPAMPUM_TOKEN: 'update-channel-e2e-token'.repeat(2),
      PIMPAMPUM_RELEASE_MANIFEST_URL: `${baseUrl}/channel/release-manifest.json`,
      ...extra,
    };
  }

  it('resolves the redirected signed manifest through the compiled CLI with the development key', async () => {
    requests.length = 0;
    const result = await executeCli(
      environment({
        PIMPAMPUM_DEV_RELEASE_KEY: '1',
        PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: publicKeyPath,
      }),
      'update:check',
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      data: {
        currentVersion: PIMPAMPUM_VERSION,
        latestVersion: CHANNEL_VERSION,
        updateAvailable: true,
      },
    });
    expect(requests).toEqual(['/channel/release-manifest.json', '/assets/release-manifest.json']);
  });

  it('refuses the same manifest without the development flag, typed as unavailable', async () => {
    const result = await executeCli(
      environment({ PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: publicKeyPath }),
      'update:check',
    );
    expect(result.code).not.toBe(0);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('unavailable');
    // Plain-HTTP loopback is closed without the flag, so the transport refuses before any key is read.
    expect(envelope.error.message).toMatch(/channel URL/iu);
  });

  it.skipIf(hostTarget !== 'darwin-arm64')(
    'stages the macOS install source from the signed release zip after a redirect',
    async () => {
      requests.length = 0;
      const staged = await stagePackagedMacOSApplication({
        homeDirectory,
        version: CHANNEL_VERSION,
        runCommand: runServiceCommand,
        environment: {
          PIMPAMPUM_DEV_RELEASE_KEY: '1',
          PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: publicKeyPath,
          PIMPAMPUM_RELEASE_MANIFEST_URL: `${baseUrl}/channel/release-manifest.json`,
        },
      });
      try {
        expect(staged.version).toBe(CHANNEL_VERSION);
        expect(staged.appBundlePath.endsWith('/Pimpampum.app')).toBe(true);
        expect(
          staged.appBundlePath.startsWith(
            join(homeDirectory, 'Applications', '.pimpampum-update-'),
          ),
        ).toBe(true);
        const runtimeManifest = JSON.parse(
          readFileSync(
            join(
              staged.appBundlePath,
              'Contents',
              'Resources',
              'PimpampumRuntime',
              'runtime-manifest.json',
            ),
            'utf8',
          ),
        ) as RuntimeManifest;
        expect(runtimeManifest.pimpampumVersion).toBe(CHANNEL_VERSION);
        expect(requests).toEqual([
          '/channel/release-manifest.json',
          '/assets/release-manifest.json',
          `/assets/v${CHANNEL_VERSION}/Pimpampum-${CHANNEL_VERSION}-macos-arm64.zip`,
          `/cdn/assets/v${CHANNEL_VERSION}/Pimpampum-${CHANNEL_VERSION}-macos-arm64.zip`,
        ]);
      } finally {
        staged.cleanup();
      }
      expect(existsSync(dirname(dirname(staged.appBundlePath)))).toBe(false);
    },
  );
});
