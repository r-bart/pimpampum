import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryRoot } from './helpers/compiledDaemon.js';

const roots: string[] = [];
const stagedApp = join(repositoryRoot, 'platforms/macos/dist/Pimpampum.app');
const checker = join(repositoryRoot, 'scripts/check-macos-artifact.mjs');
const compactMark = join(repositoryRoot, 'platforms/macos/Resources/PimpampumCompact.pdf');
const packageVersion = (
  JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
// L-38 / M-T9: the staged app stops being tracked in Git, so a clean checkout has none before
// `npm run build:macos`. The gate is then exercised against a synthetic bundle built here from the
// checker's own contract; when a staged app exists it is used as the candidate source instead.
const darwin = process.platform === 'darwin';
const stagedAppPresent = existsSync(join(stagedApp, 'Contents/MacOS/PimpampumMenuBar'));

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function write(path: string, content: Buffer | string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

function arm64MachO(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  return bytes;
}

/**
 * The smallest Mach-O the checker accepts as the app executable: a 64-bit arm64 header with one
 * LC_BUILD_VERSION load command whose platform is macOS and whose minimum version is 13.0.0.
 */
function arm64MenuBarExecutable(): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(1, 16); // ncmds
  header.writeUInt32LE(24, 20); // sizeofcmds
  const buildVersion = Buffer.alloc(24);
  buildVersion.writeUInt32LE(0x32, 0); // LC_BUILD_VERSION
  buildVersion.writeUInt32LE(24, 4);
  buildVersion.writeUInt32LE(1, 8); // PLATFORM_MACOS
  buildVersion.writeUInt32LE((13 << 16) | (0 << 8) | 0, 12); // minos 13.0.0
  buildVersion.writeUInt32LE((13 << 16) | (0 << 8) | 0, 16); // sdk
  buildVersion.writeUInt32LE(0, 20); // ntools
  return Buffer.concat([header, buildVersion]);
}

function syntheticInfoPlist(): string {
  const entries: Array<[string, string]> = [
    ['CFBundleDevelopmentRegion', '<string>en</string>'],
    ['CFBundleExecutable', '<string>PimpampumMenuBar</string>'],
    ['CFBundleIdentifier', '<string>dev.pimpampum.menubar</string>'],
    ['CFBundleInfoDictionaryVersion', '<string>6.0</string>'],
    ['CFBundleDisplayName', '<string>Pimpampum</string>'],
    ['CFBundleIconFile', '<string>Pimpampum</string>'],
    ['CFBundleIconName', '<string>Pimpampum</string>'],
    ['CFBundleName', '<string>Pimpampum</string>'],
    ['CFBundlePackageType', '<string>APPL</string>'],
    ['CFBundleShortVersionString', `<string>${packageVersion}</string>`],
    ['CFBundleVersion', '<string>1</string>'],
    ['LSMinimumSystemVersion', '<string>13.0</string>'],
    ['LSUIElement', '<true/>'],
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries.map(([key, value]) => `  <key>${key}</key>\n  ${value}`),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** An ICNS container whose length header matches its size, and a BOM asset catalog header. */
function syntheticIconBytes(): { icns: Buffer; assetCatalog: Buffer } {
  const icns = Buffer.alloc(2_048);
  icns.write('icns', 0, 'ascii');
  icns.writeUInt32BE(icns.length, 4);
  const assetCatalog = Buffer.alloc(2_048);
  assetCatalog.write('BOMStore', 0, 'ascii');
  return { icns, assetCatalog };
}

/** A bundle that satisfies every structural check of `check-macos-artifact.mjs` without Xcode. */
function writeSyntheticBundle(app: string): void {
  const { icns, assetCatalog } = syntheticIconBytes();
  write(join(app, 'Contents/MacOS/PimpampumMenuBar'), arm64MenuBarExecutable(), 0o755);
  write(join(app, 'Contents/Info.plist'), syntheticInfoPlist());
  write(join(app, 'Contents/Resources/Pimpampum.icns'), icns);
  write(join(app, 'Contents/Resources/Assets.car'), assetCatalog);
  write(join(app, 'Contents/Resources/PimpampumCompact.pdf'), readFileSync(compactMark));
}

function addRuntimeFixture(app: string): void {
  const runtimeRoot = join(app, 'Contents/Resources/PimpampumRuntime');
  rmSync(runtimeRoot, { recursive: true, force: true });
  const payload = join(runtimeRoot, 'payload');
  const files = [
    { path: 'bin/node', content: arm64MachO(), mode: 0o755 },
    { path: 'dist/cli.js', content: 'export const cli = true;\n', mode: 0o644 },
    { path: 'dist/mcpStdio.js', content: 'export const mcp = true;\n', mode: 0o644 },
    {
      path: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      content: arm64MachO(),
      mode: 0o644,
    },
  ];
  for (const file of files) write(join(payload, file.path), file.content, file.mode);
  const manifestFiles = files.map((file) => ({
    path: file.path,
    sha256: sha256(file.content),
    mode: file.mode,
    size: file.content.length,
  }));
  const manifest = {
    schemaVersion: 1,
    pimpampumVersion: packageVersion,
    nodeVersion: '24.19.0',
    target: { platform: 'darwin', architecture: 'arm64' },
    unpackedBytes: manifestFiles.reduce((total, file) => total + file.size, 0),
    entrypoints: { node: 'bin/node', cli: 'dist/cli.js', mcp: 'dist/mcpStdio.js' },
    files: manifestFiles,
  };
  write(join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  write(
    join(runtimeRoot, 'runtime-inventory.json'),
    `${JSON.stringify({ schemaVersion: 1, target: 'darwin-arm64', files: manifestFiles }, null, 2)}\n`,
  );
  const lockfileHash = sha256(readFileSync(join(repositoryRoot, 'package-lock.json')));
  write(
    join(runtimeRoot, 'runtime-sbom.spdx.json'),
    `${JSON.stringify(
      {
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        documentComment: `package-lock.json sha256:${lockfileHash}`,
        packages: [],
      },
      null,
      2,
    )}\n`,
  );
}

function candidate(label: string, source: 'staged' | 'synthetic' = 'synthetic'): string {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-macos-artifact-${label}-`));
  roots.push(root);
  const app = join(root, 'Pimpampum.app');
  if (source === 'staged') cpSync(stagedApp, app, { recursive: true });
  else writeSyntheticBundle(app);
  addRuntimeFixture(app);
  return app;
}

function check(app: string, approve = false) {
  return spawnSync(process.execPath, [checker, app, ...(approve ? ['--approve'] : [])], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The checker parses the plist with `/usr/bin/plutil` and refuses `--approve` off macOS, so the
// gate can only be exercised on darwin. Off darwin this is a visible todo, not a silent pass.
if (!darwin) {
  it.todo(
    'packaged macOS artifact gate requires macOS: check-macos-artifact.mjs parses Info.plist with /usr/bin/plutil and only approves on darwin',
  );
}

describe.runIf(darwin)('packaged macOS artifact gate', () => {
  it.runIf(stagedAppPresent)(
    'canonically approves the staged Xcode build in platforms/macos/dist',
    () => {
      const app = candidate('staged', 'staged');
      const approval = check(app, true);
      expect(approval.stderr).toBe('');
      expect(approval.status).toBe(0);
      expect(check(app).status).toBe(0);
    },
  );

  it('canonically approves the named app, Icon Composer output, plist and executable', () => {
    const app = candidate('valid');
    const approval = check(app, true);
    expect(approval.stderr).toBe('');
    expect(approval.status).toBe(0);
    const metadata = JSON.parse(
      readFileSync(join(app, '..', 'PimpampumMenuBar.artifact.json'), 'utf8'),
    ) as {
      sourceInputSha256?: unknown;
      binarySha256?: unknown;
      plistSha256?: unknown;
      appIconSha256?: unknown;
      assetCatalogSha256?: unknown;
      runtimeManifestSha256?: unknown;
      runtimeFileCount?: unknown;
      architecture?: unknown;
    };
    expect(metadata).toMatchObject({
      architecture: 'arm64',
      appBundle: 'Pimpampum.app',
      appName: 'Pimpampum',
    });
    expect(metadata.binarySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.plistSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.sourceInputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.appIconSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.assetCatalogSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.runtimeManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.runtimeFileCount).toBe(4);
    expect(metadata).toMatchObject({ minimumMacOS: '13.0.0', lsMinimumSystemVersion: '13.0' });
    expect(check(app).status).toBe(0);
  });

  it('rejects missing or malformed Icon Composer artifacts', () => {
    const app = candidate('bad-icon');
    writeFileSync(join(app, 'Contents/Resources/Pimpampum.icns'), 'not-an-icon');
    const result = check(app, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('app icon');
  });

  it('rejects a duplicate critical key even when the first value is valid', () => {
    const app = candidate('duplicate-key');
    const plist = join(app, 'Contents/Info.plist');
    writeFileSync(
      plist,
      readFileSync(plist, 'utf8').replace('</dict>', '<key>LSUIElement</key>\n<false/>\n</dict>'),
    );
    const result = check(app, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly one LSUIElement');
  });

  it('rejects plist hash drift and a non-arm64 Mach-O header', () => {
    const plistApp = candidate('plist-drift');
    expect(check(plistApp, true).status).toBe(0);
    const plist = join(plistApp, 'Contents/Info.plist');
    writeFileSync(plist, `${readFileSync(plist, 'utf8')}\n`);
    expect(check(plistApp).status).not.toBe(0);

    const binaryApp = candidate('wrong-arch');
    const binaryPath = join(binaryApp, 'Contents/MacOS/PimpampumMenuBar');
    const binary = readFileSync(binaryPath);
    binary.writeUInt32LE(0x01000007, 4);
    writeFileSync(binaryPath, binary, { mode: 0o755 });
    const result = check(binaryApp, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not arm64-only');
  });

  it('rejects runtime hash, mode and inventory drift before approval', () => {
    const hashApp = candidate('runtime-hash');
    writeFileSync(
      join(hashApp, 'Contents/Resources/PimpampumRuntime/payload/dist/cli.js'),
      'drift',
    );
    expect(check(hashApp, true).stderr).toContain('Runtime size drift');

    const modeApp = candidate('runtime-mode');
    chmodSync(join(modeApp, 'Contents/Resources/PimpampumRuntime/payload/dist/cli.js'), 0o755);
    expect(check(modeApp, true).stderr).toContain('Runtime mode drift');

    const inventoryApp = candidate('runtime-inventory');
    writeFileSync(
      join(inventoryApp, 'Contents/Resources/PimpampumRuntime/runtime-inventory.json'),
      '{}\n',
    );
    expect(check(inventoryApp, true).stderr).toContain('inventory differs');
  });
});
