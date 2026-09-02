import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPackagedReleaseStager,
  findCandidateApp,
  linuxPackagedUpdateUnavailable,
  MAX_RELEASE_ARCHIVE_ENTRIES,
  pathEntryExists,
  refuseStagedSourceActivation,
  stagePackagedMacOSApplication,
  validateCandidateInventory,
} from '../src/cliComposition/releaseCandidate.js';
import type { RuntimeManifest, RuntimeTarget } from '../src/runtime/types.js';
import { releaseSignaturePayload, type PackagedReleaseTarget } from '../src/update.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-release-candidate-'));
  roots.push(root);
  return root;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A runtime payload and its manifest, laid out as `PimpampumRuntime/{runtime-manifest.json,payload}`. */
function writeRuntime(
  root: string,
  version: string,
  target: RuntimeTarget = { platform: 'darwin', architecture: 'arm64' },
) {
  const runtimeRoot = join(root, 'PimpampumRuntime');
  const payload = join(runtimeRoot, 'payload');
  const contents = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': `export const version = ${JSON.stringify(version)};\n`,
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': `addon-${version}`,
  };
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(payload, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: path === 'bin/node' ? 0o755 : 0o644 });
  }
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    pimpampumVersion: version,
    nodeVersion: '24.19.0',
    target,
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
  return { runtimeRoot, payload, manifest };
}

/** The runtime manifest's target for a release id; the union keeps `darwin` to `arm64`. */
function runtimeTargetOf(target: PackagedReleaseTarget): RuntimeTarget {
  if (target === 'darwin-arm64') return { platform: 'darwin', architecture: 'arm64' };
  return { platform: 'linux', architecture: target === 'linux-arm64' ? 'arm64' : 'x64' };
}

/** A complete unpacked release: one app with its runtime, and the Omarchy plugin beside it. */
function writeCandidate(
  candidatePath: string,
  version: string,
  options: { target?: PackagedReleaseTarget; pluginVersion?: string; pluginTargets?: object } = {},
) {
  const target = options.target ?? 'darwin-arm64';
  const app = join(candidatePath, 'Pimpampum.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'PimpampumMenuBar'), 'binary', { mode: 0o755 });
  const runtime = writeRuntime(
    join(app, 'Contents', 'Resources'),
    version,
    runtimeTargetOf(target),
  );
  const plugin = join(candidatePath, 'pimpampum-status');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'Widget.qml'), 'Item {}\n');
  writeFileSync(
    join(plugin, 'runtime-manifest.json'),
    JSON.stringify({
      version: options.pluginVersion ?? version,
      targets: options.pluginTargets ?? { 'linux-arm64': {} },
    }),
  );
  return { app, runtime, plugin };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A well-formed zip with deflated entries: what the archive validator accepts. */
function zipOf(entries: ReadonlyArray<{ path: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const content = Buffer.from(entry.content);
    const compressed = deflateRawSync(content);
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const localBytes = Buffer.concat(localParts);
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

const APP_ENTRY = 'Pimpampum.app/Contents/MacOS/PimpampumMenuBar';
const ASSET_URL =
  'https://github.com/r-bart/pimpampum/releases/download/v2.0.0/pimpampum-2.0.0-darwin-arm64.zip';

function stagingFixture(
  options: { listing?: string; unzipExit?: number; dittoExit?: number } = {},
) {
  const root = temporaryRoot();
  const homeDirectory = join(root, 'home');
  mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
  const zip = zipOf([{ path: APP_ENTRY, content: 'binary' }]);
  const asset = { url: ASSET_URL, sha256: sha256(zip), size: zip.length, signature: 'signed' };
  const runCommand = vi.fn(async (executable: string, args: string[]) => {
    if (executable === '/usr/bin/unzip') {
      return {
        exitCode: options.unzipExit ?? 0,
        stdout: options.listing ?? `${APP_ENTRY}\n`,
        stderr: '',
      };
    }
    if (options.dittoExit === undefined) writeCandidate(args[3]!, '2.0.0');
    return { exitCode: options.dittoExit ?? 0, stdout: '', stderr: '' };
  });
  const fetchImplementation = vi.fn(
    async () => new Response(new Uint8Array(zip), { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
  const stager = createPackagedReleaseStager({
    homeDirectory,
    runCommand,
    fetchImplementation,
    allowInsecureLoopback: false,
  });
  const stage = (overrides: Partial<typeof asset> = {}) =>
    stager({
      version: '2.0.0',
      target: 'darwin-arm64',
      asset: { ...asset, ...overrides },
      maximumBytes: zip.length,
      timeoutMilliseconds: 1_000,
    });
  const stagingRoots = () =>
    readdirSync(join(homeDirectory, 'Applications')).filter((name) =>
      name.startsWith('.pimpampum-update-'),
    );
  return {
    root,
    homeDirectory,
    zip,
    asset,
    runCommand,
    fetchImplementation,
    stager,
    stage,
    stagingRoots,
  };
}

describe('filesystem probes', () => {
  it('reports any entry as present, a dangling symlink included, and rethrows other failures', () => {
    const root = temporaryRoot();
    writeFileSync(join(root, 'file'), 'x');
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    expect(pathEntryExists(join(root, 'file'))).toBe(true);
    expect(pathEntryExists(join(root, 'dangling'))).toBe(true);
    expect(pathEntryExists(join(root, 'missing'))).toBe(false);
    expect(() => pathEntryExists(join(root, 'file', 'below'))).toThrow(/ENOTDIR/u);
  });
});

describe('candidate inventory', () => {
  it('accepts a complete macOS release and returns its app bundle', () => {
    const root = temporaryRoot();
    const { app } = writeCandidate(root, '2.0.0');
    expect(validateCandidateInventory(root, 'darwin-arm64', '2.0.0')).toBe(app);
    expect(findCandidateApp(root)).toBe(app);
  });

  it('accepts a Linux release without an app', () => {
    const root = temporaryRoot();
    writeCandidate(root, '2.0.0', { target: 'linux-x64' });
    rmSync(join(root, 'Pimpampum.app', 'Contents', 'MacOS'), { recursive: true });
    expect(validateCandidateInventory(root, 'linux-x64', '2.0.0')).toBe('');
  });

  it('demands exactly one app bundle', () => {
    const root = temporaryRoot();
    expect(() => findCandidateApp(root)).toThrow(/exactly one Pimpampum macOS app/u);
    writeCandidate(root, '2.0.0');
    mkdirSync(join(root, 'Other.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(root, 'Other.app', 'Contents', 'MacOS', 'PimpampumMenuBar'), 'x');
    expect(() => findCandidateApp(root)).toThrow(/exactly one Pimpampum macOS app/u);
  });

  it('refuses a symlink anywhere in the tree', () => {
    const root = temporaryRoot();
    writeCandidate(root, '2.0.0');
    symlinkSync('/etc/hosts', join(root, 'pimpampum-status', 'link.qml'));
    expect(() => validateCandidateInventory(root, 'darwin-arm64', '2.0.0')).toThrow(
      /symbolic links/u,
    );
  });

  it('refuses an incomplete inventory', () => {
    const root = temporaryRoot();
    writeCandidate(root, '2.0.0');
    rmSync(join(root, 'pimpampum-status', 'Widget.qml'));
    expect(() => validateCandidateInventory(root, 'darwin-arm64', '2.0.0')).toThrow(
      /missing its app, runtime, or plugin inventory/u,
    );
  });

  it('refuses a runtime for another version, with extra files, or with altered bytes', () => {
    const root = temporaryRoot();
    const { runtime } = writeCandidate(root, '2.0.0');
    expect(() => validateCandidateInventory(root, 'darwin-arm64', '2.0.1')).toThrow(
      /runtime version does not match/u,
    );
    writeFileSync(join(runtime.payload, 'dist', 'cli.js'), 'tampered');
    expect(() => validateCandidateInventory(root, 'darwin-arm64', '2.0.0')).toThrow(
      /integrity mismatch: dist\/cli\.js/u,
    );
    writeFileSync(join(runtime.payload, 'extra.txt'), 'x');
    expect(() => validateCandidateInventory(root, 'darwin-arm64', '2.0.0')).toThrow(
      /missing or unexpected files/u,
    );
  });

  it.each([
    [{ pluginVersion: '1.0.0' }],
    [{ pluginTargets: {} }],
    [{ pluginTargets: { 'darwin-arm64': {} } }],
  ])('refuses a plugin manifest that does not match the release %#', (options) => {
    const root = temporaryRoot();
    writeCandidate(root, '2.0.0', options);
    expect(() => validateCandidateInventory(root, 'darwin-arm64', '2.0.0')).toThrow(
      /plugin manifest does not match/u,
    );
  });

  it('bounds the number of files it will inventory', async () => {
    // Twenty thousand real files would cost a minute of disk time for one counter. The walk itself
    // is covered by `test/fs-guards.test.ts`; what this proves is that the inventory stops counting.
    const root = temporaryRoot();
    writeCandidate(root, '2.0.0');
    vi.resetModules();
    vi.doMock('../src/fsGuards.js', async () => ({
      ...(await vi.importActual<typeof import('../src/fsGuards.js')>('../src/fsGuards.js')),
      walkRegularTree: (walked: string, visit: (entry: { kind: string; path: string }) => void) => {
        for (let index = 0; index <= MAX_RELEASE_ARCHIVE_ENTRIES; index += 1) {
          visit({ kind: 'file', path: join(walked, `${String(index)}.qml`) });
        }
      },
    }));
    try {
      const bounded = await import('../src/cliComposition/releaseCandidate.js');
      expect(() => bounded.findCandidateApp(root)).toThrow(/too many files/u);
    } finally {
      vi.doUnmock('../src/fsGuards.js');
      vi.resetModules();
    }
  });
});

describe('packaged release stager', () => {
  it('downloads, verifies, unpacks and validates a macOS release into a private staging root', async () => {
    const value = stagingFixture();
    const staged = await value.stage();
    expect(staged).toMatchObject({
      sha256: value.asset.sha256,
      size: value.zip.length,
      contains: { app: true, runtime: true, plugin: true },
    });
    expect(dirname(staged.path)).toBe(
      join(value.homeDirectory, 'Applications', value.stagingRoots()[0]!),
    );
    expect(existsSync(join(dirname(staged.path), 'candidate.zip'))).toBe(false);
    expect(value.runCommand).toHaveBeenNthCalledWith(1, '/usr/bin/unzip', [
      '-Z1',
      join(dirname(staged.path), 'candidate.zip'),
    ]);
    expect(value.runCommand).toHaveBeenNthCalledWith(2, '/usr/bin/ditto', [
      '-x',
      '-k',
      join(dirname(staged.path), 'candidate.zip'),
      staged.path,
    ]);
  });

  it('refuses a Linux target before touching the network', async () => {
    const value = stagingFixture();
    await expect(
      value.stager({
        version: '2.0.0',
        target: 'linux-x64',
        asset: value.asset,
        maximumBytes: 10,
        timeoutMilliseconds: 10,
      }),
    ).rejects.toMatchObject({ code: 'unavailable', details: { remedy: 'pimpampum-bootstrap' } });
    expect(value.fetchImplementation).not.toHaveBeenCalled();
    expect(linuxPackagedUpdateUnavailable('3.0.0').message).toMatch(/Pimpampum 3\.0\.0/u);
  });

  it.each([
    ['size', { size: 3 }, /size does not match/u],
    ['hash', { sha256: 'f'.repeat(64) }, /hash does not match/u],
  ])(
    'removes the staging root when the asset %s does not match',
    async (_label, overrides, error) => {
      const value = stagingFixture();
      await expect(value.stage(overrides)).rejects.toThrow(error);
      expect(value.stagingRoots()).toEqual([]);
    },
  );

  it.each([
    ['a failed listing', { unzipExit: 1 }, /listing failed/u],
    ['an empty listing', { listing: '' }, /invalid entry count/u],
    ['a traversal entry', { listing: 'a/../../etc\n' }, /unsafe path/u],
    ['an absolute entry', { listing: '/etc/passwd\n' }, /unsafe path/u],
    ['a drive entry', { listing: 'C:/Windows\n' }, /unsafe path/u],
    ['a NUL entry', { listing: 'a\0b\n' }, /unsafe path/u],
    ['a failed extraction', { dittoExit: 1 }, /extraction failed/u],
  ])('refuses %s and removes the staging root', async (_label, options, error) => {
    const value = stagingFixture(options);
    await expect(value.stage()).rejects.toThrow(error);
    expect(value.stagingRoots()).toEqual([]);
  });

  it('refuses a staging parent that is a symlink', async () => {
    const value = stagingFixture();
    const elsewhere = join(value.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(value.homeDirectory, 'Applications'));
    await expect(value.stage()).rejects.toThrow(/staging parent must be a regular directory/u);
  });
});

describe('macOS install source', () => {
  it('stages the app of its own version from a signed manifest and cleans up on request', async () => {
    const value = stagingFixture();
    const dataDirectory = join(value.root, 'data');
    mkdirSync(dataDirectory, { mode: 0o700 });
    const pair = generateKeyPairSync('ed25519');
    const keyPath = join(value.root, 'dev-key.pem');
    writeFileSync(keyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const issuedAt = new Date().toISOString();
    const payload = releaseSignaturePayload({
      version: '2.0.0',
      issuedAt,
      target: 'darwin-arm64',
      url: value.asset.url,
      sha256: value.asset.sha256,
      size: value.asset.size,
    });
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      version: '2.0.0',
      issuedAt,
      targets: {
        'darwin-arm64': {
          ...value.asset,
          signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64'),
        },
      },
    });
    const responses = [
      new Response(manifest, { status: 200 }),
      new Response(new Uint8Array(value.zip), { status: 200 }),
    ];
    const fetchImplementation = vi.fn(async () =>
      responses.shift()!,
    ) as unknown as typeof globalThis.fetch;

    const staged = await stagePackagedMacOSApplication({
      homeDirectory: value.homeDirectory,
      dataDirectory,
      version: '2.0.0',
      runCommand: value.runCommand,
      fetchImplementation,
      environment: {
        PIMPAMPUM_DEV_RELEASE_KEY: '1',
        PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH: keyPath,
        PIMPAMPUM_RELEASE_MANIFEST_URL: 'https://updates.example.test/channel/manifest.json',
      },
    });
    expect(staged.version).toBe('2.0.0');
    expect(staged.appBundlePath.endsWith('/Pimpampum.app')).toBe(true);
    expect(existsSync(join(dataDirectory, 'update-trust.json'))).toBe(true);
    expect(value.stagingRoots()).toHaveLength(1);
    staged.cleanup();
    staged.cleanup();
    expect(value.stagingRoots()).toEqual([]);
  });

  it('never activates the staged source as an update', async () => {
    await expect(
      refuseStagedSourceActivation({
        version: '2.0.0',
        target: 'darwin-arm64',
        candidatePath: '/candidate',
        sha256: 'a'.repeat(64),
        signature: 's',
      }),
    ).rejects.toThrow(/never activated as an update/u);
  });
});
