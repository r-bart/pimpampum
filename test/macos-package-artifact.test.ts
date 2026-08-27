import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const sourceApp = join(process.cwd(), 'platforms/macos/dist/PimpampumMenuBar.app');
const checker = join(process.cwd(), 'scripts/check-macos-artifact.mjs');

function candidate(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-macos-artifact-${label}-`));
  roots.push(root);
  const app = join(root, 'PimpampumMenuBar.app');
  cpSync(sourceApp, app, { recursive: true });
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
  it('canonically approves the exact plist and freezes both binary and plist hashes', () => {
    const app = candidate('valid');
    expect(check(app, true).status).toBe(0);
    const metadata = JSON.parse(
      readFileSync(join(app, 'Contents/Resources/artifact-metadata.json'), 'utf8'),
    ) as {
      sourceInputSha256?: unknown;
      binarySha256?: unknown;
      plistSha256?: unknown;
      architecture?: unknown;
    };
    expect(metadata).toMatchObject({ architecture: 'arm64' });
    expect(metadata.binarySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.plistSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.sourceInputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(check(app).status).toBe(0);
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
});
