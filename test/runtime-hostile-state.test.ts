import { describe, expect, it } from 'vitest';
import { createRuntimeLaunchers } from '../src/runtime/launchers.js';
import { resolveRuntimeLayout } from '../src/runtime/layout.js';
import {
  parseRuntimeManifest,
  parseRuntimeTarget,
  parseRuntimeVersion,
  runtimeTargetId,
  validateRuntimeRelativePath,
} from '../src/runtime/manifest.js';
import type { RuntimeManifest } from '../src/runtime/types.js';

function manifest(): RuntimeManifest {
  const files = [
    { path: 'bin/node', sha256: '1'.repeat(64), mode: 0o755, size: 1 },
    { path: 'dist/cli.js', sha256: '2'.repeat(64), mode: 0o644, size: 2 },
    { path: 'dist/mcp.js', sha256: '3'.repeat(64), mode: 0o644, size: 3 },
    {
      path: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      sha256: '4'.repeat(64),
      mode: 0o644,
      size: 4,
    },
  ];
  return {
    schemaVersion: 1,
    pimpampumVersion: '2.0.0',
    nodeVersion: '24.0.0',
    target: { platform: 'darwin', architecture: 'arm64' },
    unpackedBytes: 10,
    entrypoints: { node: 'bin/node', cli: 'dist/cli.js', mcp: 'dist/mcp.js' },
    files,
  };
}

function clone(): Record<string, unknown> {
  return structuredClone(manifest()) as unknown as Record<string, unknown>;
}

const options = {
  platform: 'darwin' as const,
  architecture: 'arm64' as const,
  maximumUnpackedBytes: 1_000_000,
};

describe('hostile runtime contract inputs', () => {
  it.each([undefined, null, '', '01.0.0', '1.0', '1.0.0-'])('rejects version %j', (value) => {
    expect(() => parseRuntimeVersion(value)).toThrow(/runtime manifest/iu);
  });

  it.each([
    ['', 'arm64'],
    ['windows', 'arm64'],
    ['linux', 'sparc'],
    ['darwin', 'x64'],
  ])('rejects target %s-%s', (platform, architecture) => {
    expect(() => parseRuntimeTarget(platform, architecture)).toThrow(/runtime manifest/iu);
  });

  it('renders every supported target as its canonical id', () => {
    expect(runtimeTargetId(parseRuntimeTarget('darwin', 'arm64'))).toBe('darwin-arm64');
    expect(runtimeTargetId(parseRuntimeTarget('linux', 'arm64'))).toBe('linux-arm64');
    expect(runtimeTargetId(parseRuntimeTarget('linux', 'x64'))).toBe('linux-x64');
  });

  it.each([
    '',
    'a'.repeat(1_025),
    'a\\b',
    'a\0b',
    '/absolute',
    '.',
    '..',
    './a',
    'a/',
    'a//b',
    'a/../b',
  ])('rejects hostile relative path %j', (value) => {
    expect(() => validateRuntimeRelativePath(value)).toThrow(/runtime manifest/iu);
  });

  it('rejects malformed manifest envelopes and file inventories', () => {
    const cases: unknown[] = [null, [], { ...clone(), extra: true }];
    const missing = clone();
    delete missing.files;
    cases.push(missing);
    cases.push({ ...clone(), schemaVersion: 2 });
    cases.push({ ...clone(), pimpampumVersion: '' });
    cases.push({ ...clone(), target: { platform: 'linux', architecture: 'arm64' } });
    cases.push({ ...clone(), unpackedBytes: 0 });
    cases.push({ ...clone(), unpackedBytes: 2_000_000 });
    cases.push({ ...clone(), entrypoints: null });
    cases.push({ ...clone(), files: null });
    cases.push({ ...clone(), files: [] });
    for (const value of cases) {
      expect(() => parseRuntimeManifest(value, options)).toThrow(/runtime manifest/iu);
    }
  });

  it('rejects malformed individual files and aggregate sizes', () => {
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => ((value.files as unknown[])[0] = null),
      (value) =>
        delete ((value.files as Record<string, unknown>[])[0] as Record<string, unknown>).mode,
      (value) => ((value.files as Record<string, unknown>[])[0]!.sha256 = 'bad'),
      (value) => ((value.files as Record<string, unknown>[])[0]!.sha256 = '0'.repeat(64)),
      (value) => ((value.files as Record<string, unknown>[])[0]!.mode = 0o777),
      (value) => ((value.files as Record<string, unknown>[])[0]!.size = -1),
      (value) =>
        (value.files as Record<string, unknown>[]).push({
          ...(value.files as Record<string, unknown>[])[0]!,
        }),
      (value) => ((value.unpackedBytes as number) += 1),
      (value) => {
        (value.files as Record<string, unknown>[])[0]!.size = Number.MAX_SAFE_INTEGER;
      },
    ];
    for (const mutate of mutations) {
      const value = clone();
      mutate(value);
      expect(() => parseRuntimeManifest(value, options)).toThrow(/runtime manifest/iu);
    }
  });

  it('rejects incomplete, aliased, or non-executable entrypoints and native addons', () => {
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => ((value.entrypoints as Record<string, unknown>).cli = 'bin/node'),
      (value) => ((value.entrypoints as Record<string, unknown>).cli = 'missing.js'),
      (value) => ((value.files as Record<string, unknown>[])[0]!.mode = 0o644),
      (value) => {
        (value.files as Record<string, unknown>[]).pop();
        value.unpackedBytes = 6;
      },
      (value) => {
        (value.files as Record<string, unknown>[]).push({
          path: 'other.node',
          sha256: '5'.repeat(64),
          mode: 0o644,
          size: 1,
        });
        value.unpackedBytes = 11;
      },
    ];
    for (const mutate of mutations) {
      const value = clone();
      mutate(value);
      expect(() => parseRuntimeManifest(value, options)).toThrow(/runtime manifest/iu);
    }
  });

  it('bounds manifest file count before parsing the entries', () => {
    const value = clone();
    value.files = Array.from({ length: 100_001 }, () => null);
    expect(() => parseRuntimeManifest(value, options)).toThrow(/entry limit/iu);
  });
});

describe('hostile runtime launcher and layout inputs', () => {
  it('quotes stable launchers and rejects relative or control-character paths', () => {
    const launchers = createRuntimeLaunchers({
      nodePath: "/opt/Pimpampum's Runtime/bin/node",
      cliPath: '/opt/Pimpampum Runtime/dist/cli.js',
      mcpPath: '/opt/Pimpampum Runtime/dist/mcp.js',
    });
    expect(launchers.control).toContain(`Pimpampum'"'"'s Runtime`);
    for (const input of [
      { nodePath: 'node', cliPath: '/cli', mcpPath: '/mcp' },
      { nodePath: '/node', cliPath: 'cli', mcpPath: '/mcp' },
      { nodePath: '/node', cliPath: '/cli', mcpPath: '/mcp\n' },
    ]) {
      expect(() => createRuntimeLaunchers(input)).toThrow(/absolute path/iu);
    }
  });

  it('resolves Linux variants and rejects unsafe home roots', () => {
    expect(
      resolveRuntimeLayout({
        homeDirectory: '/home/tester',
        platform: 'linux',
        architecture: 'x64',
        version: '2.0.0',
      }).targetId,
    ).toBe('linux-x64');
    for (const homeDirectory of ['', '.', '/', '/tmp/bad\n']) {
      expect(() =>
        resolveRuntimeLayout({
          homeDirectory,
          platform: 'linux',
          architecture: 'arm64',
          version: '2.0.0',
        }),
      ).toThrow(/home directory/iu);
    }
  });
});
