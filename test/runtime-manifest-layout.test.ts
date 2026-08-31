import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveRuntimeLayout } from '../src/runtime/layout.js';
import { parseRuntimeManifest, parseRuntimeTargetId } from '../src/runtime/manifest.js';
import type { RuntimeManifest } from '../src/runtime/types.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifest(): RuntimeManifest {
  const contents = {
    'bin/node': 'node',
    'dist/cli.js': 'cli',
    'dist/mcpStdio.js': 'mcp',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'addon',
  };
  return {
    schemaVersion: 1,
    pimpampumVersion: '2.0.0-beta.1+build.7',
    nodeVersion: '24.7.0',
    target: { platform: 'linux', architecture: 'x64' },
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
}

const options = {
  platform: 'linux' as const,
  architecture: 'x64' as const,
  maximumUnpackedBytes: 1_024,
};

describe('runtime manifest', () => {
  it('returns a strict cloned manifest for a complete supported target', () => {
    const candidate = manifest();
    const parsed = parseRuntimeManifest(candidate, options);

    expect(parsed).toEqual(candidate);
    expect(parsed).not.toBe(candidate);
    expect(parseRuntimeTargetId('darwin-arm64')).toEqual({
      platform: 'darwin',
      architecture: 'arm64',
    });
  });

  it.each([
    ['absolute path', (candidate: RuntimeManifest) => (candidate.files[0]!.path = '/bin/node')],
    ['traversal', (candidate: RuntimeManifest) => (candidate.files[0]!.path = 'bin/../node')],
    ['backslash', (candidate: RuntimeManifest) => (candidate.files[0]!.path = 'bin\\node')],
    [
      'duplicate path',
      (candidate: RuntimeManifest) => (candidate.files[1]!.path = candidate.files[0]!.path),
    ],
    [
      'placeholder hash',
      (candidate: RuntimeManifest) => (candidate.files[0]!.sha256 = '0'.repeat(64)),
    ],
    ['special mode', (candidate: RuntimeManifest) => (candidate.files[0]!.mode = 0o4755)],
    ['size drift', (candidate: RuntimeManifest) => (candidate.files[0]!.size += 1)],
  ])('rejects %s', (_label, mutate) => {
    const candidate = manifest();
    mutate(candidate);
    expect(() => parseRuntimeManifest(candidate, options)).toThrow(/runtime manifest/iu);
  });

  it('rejects link/device representation and unsupported targets', () => {
    const withKind = manifest() as unknown as {
      files: Array<Record<string, unknown>>;
    };
    withKind.files[0]!.kind = 'symlink';
    expect(() => parseRuntimeManifest(withKind, options)).toThrow(/unexpected field/iu);
    expect(() => parseRuntimeTargetId('darwin-x64')).toThrow(/unsupported/iu);
  });
});

describe('runtime layout', () => {
  it('separates private Darwin runtime, launcher, data, app and integration roots', () => {
    const homeDirectory = '/Users/example/Home With Spaces ü';
    const layout = resolveRuntimeLayout({
      homeDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      version: '2.0.0',
    });

    expect(layout.versionDirectory).toBe(
      join(homeDirectory, 'Library/Application Support/Pimpampum/Runtime/2.0.0/darwin-arm64'),
    );
    expect(layout.controlLauncherPath).toBe(
      join(homeDirectory, 'Library/Application Support/Pimpampum/bin/pimpampum-control'),
    );
    expect(
      new Set([
        layout.dataDirectory,
        layout.runtimeDirectory,
        layout.applicationDirectory,
        layout.pluginDirectory,
      ]).size,
    ).toBe(4);
  });

  it('uses private XDG-compatible Linux product and Omarchy plugin paths', () => {
    const layout = resolveRuntimeLayout({
      homeDirectory: '/home/example',
      platform: 'linux',
      architecture: 'arm64',
      version: '2.0.0',
    });

    expect(layout.versionDirectory).toBe(
      '/home/example/.local/share/pimpampum/runtime/2.0.0/linux-arm64',
    );
    expect(layout.mcpLauncherPath).toBe('/home/example/.local/share/pimpampum/bin/pimpampum-mcp');
    expect(layout.pluginDirectory).toBe(
      '/home/example/.config/omarchy/plugins/dev.pimpampum.status',
    );
  });
});
