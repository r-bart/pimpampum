import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('runtime release integration', () => {
  it('embeds only a checked Darwin payload and verifies its complete inventory', () => {
    const build = source('scripts/build-macos-app.sh');
    const check = source('scripts/check-macos-artifact.mjs');

    expect(build).toContain('build-runtime-bundle.mjs');
    expect(build).toContain('--target darwin-arm64');
    expect(build).toContain('check-runtime-bundle.mjs');
    expect(build).toContain('Contents/Resources/PimpampumRuntime');
    expect(check).toContain('runtime-manifest.json');
    expect(check).toContain('better_sqlite3.node');
    expect(check).toContain('missing or unexpected files');
    expect(check).toContain('Runtime mode drift');
    expect(check).toContain('Runtime hash drift');
  });

  it('signs nested runtime code before the outer app and enforces distribution policy', () => {
    const build = source('scripts/build-macos-app.sh');
    const workflow = source('.github/workflows/release.yml');
    const check = source('scripts/check-macos-artifact.mjs');
    const nodeEntitlements = source('platforms/macos/Resources/Node.entitlements');
    const nodeSign = workflow.indexOf('$runtime/bin/node');
    const addonSign = workflow.indexOf('better-sqlite3/build/Release/better_sqlite3.node');
    const outerSign = workflow.indexOf('platforms/macos/dist/PimpampumMenuBar.app', addonSign);

    expect(nodeSign).toBeGreaterThan(0);
    expect(addonSign).toBeGreaterThan(nodeSign);
    expect(outerSign).toBeGreaterThan(addonSign);
    expect(check).toContain("['--verify', '--deep', '--strict'");
    expect(check).toContain("['stapler', 'validate'");
    expect(check).toContain('Developer ID Application');
    expect(check).toContain('com\\.apple\\.security\\.cs\\.allow-jit');
    expect(workflow).toContain('--require-signature --require-notarization');
    expect(build).toContain('Node.entitlements');
    expect(nodeEntitlements).toContain('com.apple.security.cs.allow-jit');
    expect(nodeEntitlements).not.toContain('disable-library-validation');
    expect(nodeEntitlements).not.toContain('allow-unsigned-executable-memory');
  });

  it('builds and publishes the complete tagged target matrix', () => {
    const quality = source('.github/workflows/quality.yml');
    const release = source('.github/workflows/release.yml');
    const packager = source('scripts/package-release-assets.sh');

    for (const target of ['darwin-arm64', 'linux-arm64', 'linux-x64']) {
      expect(quality).toContain(`target: ${target}`);
      expect(release).toContain(`target: ${target}`);
    }
    expect(release).toContain('node-version: 24.19.0');
    expect(release).toContain('package-lock.json');
    expect(packager).toContain('runtime-sbom.spdx.json');
    expect(packager).toContain('runtime-inventory.json');
    expect(packager).toContain('archive-sha256.json');
    expect(packager).toContain('pimpampum-omarchy-runtime-manifest');
    expect(packager).toContain('cmp -s "$reviewed_plugin_manifest" "$generated_plugin_manifest"');
  });

  it('pins Omarchy to versioned bounded Linux assets', () => {
    const manifest = JSON.parse(
      source('integrations/omarchy/pimpampum-status/runtime-manifest.json'),
    ) as {
      version: string;
      targets: Record<string, { url: string; sha256: string; maximumBytes: number }>;
    };

    expect(Object.keys(manifest.targets).sort()).toEqual(['linux-arm64', 'linux-x64']);
    for (const [target, descriptor] of Object.entries(manifest.targets)) {
      expect(descriptor.url).toContain(`/v${manifest.version}/`);
      expect(descriptor.url).toContain(`-${manifest.version}-${target}.tar.gz`);
      expect(descriptor.url).not.toMatch(/latest/iu);
      expect(descriptor.sha256).toMatch(/^(?!0{64})[a-f0-9]{64}$/u);
      expect(descriptor.maximumBytes).toBe(100_663_296);
    }
  });
});
