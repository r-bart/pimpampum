import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const sourceApp = join(process.cwd(), 'platforms/macos/dist/Pimpampum.app');
const checker = join(process.cwd(), 'scripts/check-macos-artifact.mjs');
const packageVersion = (
  JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

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
  const lockfileHash = sha256(readFileSync(join(process.cwd(), 'package-lock.json')));
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

function candidate(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-macos-artifact-${label}-`));
  roots.push(root);
  const app = join(root, 'Pimpampum.app');
  cpSync(sourceApp, app, { recursive: true });
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

describe.skipIf(process.platform !== 'darwin')('packaged macOS artifact gate', () => {
  it('canonically approves the named app, Icon Composer output, plist and executable', () => {
    const app = candidate('valid');
    expect(check(app, true).status).toBe(0);
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
