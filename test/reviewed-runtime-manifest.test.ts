import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];
const version = '9.8.7';
const targets = ['linux-arm64', 'linux-x64'] as const;
const checker = join(process.cwd(), 'scripts/check-reviewed-runtime-manifest.mjs');

function check(bundlesRoot: string, repositoryRoot: string) {
  return spawnSync(process.execPath, [checker, bundlesRoot, repositoryRoot], {
    encoding: 'utf8',
  });
}

function fixture() {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'pimpampum-reviewed-manifest-'));
  temporaryRoots.push(repositoryRoot);
  const bundlesRoot = join(repositoryRoot, 'bundles');
  const reviewedTargets: Record<string, object> = {};
  writeFileSync(join(repositoryRoot, 'package.json'), `${JSON.stringify({ version })}\n`);
  for (const target of targets) {
    const bundle = join(bundlesRoot, `pimpampum-runtime-${version}-${target}`);
    mkdirSync(bundle, { recursive: true });
    const file = `pimpampum-runtime-${version}-${target}.tar.gz`;
    const archive = Buffer.from(`exact-${target}-archive`);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    writeFileSync(join(bundle, file), archive);
    writeFileSync(
      join(bundle, 'archive-sha256.json'),
      `${JSON.stringify({ schemaVersion: 1, file, sha256, size: archive.length })}\n`,
    );
    reviewedTargets[target] = {
      url: `https://github.com/r-bart/pimpampum/releases/download/v${version}/${file}`,
      sha256,
      maximumBytes: 100_663_296,
    };
  }
  const manifestRoot = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');
  mkdirSync(manifestRoot, { recursive: true });
  const manifestPath = join(manifestRoot, 'runtime-manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ version, targets: reviewedTargets }, null, 2)}\n`,
  );
  return { repositoryRoot, bundlesRoot, manifestPath };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('reviewed runtime manifest', () => {
  it('accepts the exact archives described by the Omarchy pins', () => {
    const value = fixture();
    const result = check(value.bundlesRoot, value.repositoryRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('matches 2 exact runtime archives');
  });

  it('rejects a reviewed hash that differs from the release archive', () => {
    const value = fixture();
    const manifest = JSON.parse(readFileSync(value.manifestPath, 'utf8'));
    manifest.targets['linux-x64'].sha256 = '0'.repeat(64);
    writeFileSync(value.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = check(value.bundlesRoot, value.repositoryRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the exact runtime archives');
  });
});

describe('reviewed runtime manifest diagnostics', () => {
  it('prints the generated manifest on a mismatch and writes it to --output first', () => {
    const value = fixture();
    const manifest = JSON.parse(readFileSync(value.manifestPath, 'utf8'));
    const expectedSha = manifest.targets['linux-x64'].sha256;
    manifest.targets['linux-x64'].sha256 = '0'.repeat(64);
    writeFileSync(value.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const outputPath = join(value.repositoryRoot, 'generated-runtime-manifest.json');
    const result = spawnSync(
      process.execPath,
      [checker, value.bundlesRoot, value.repositoryRoot, '--output', outputPath],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Generated Omarchy runtime manifest');
    expect(result.stderr).toContain(expectedSha);
    const generated = JSON.parse(readFileSync(outputPath, 'utf8'));
    expect(generated.version).toBe(version);
    expect(generated.targets['linux-x64'].sha256).toBe(expectedSha);
  });
});
